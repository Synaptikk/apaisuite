// modules/digitalmetrics/lib/codec.js
//
// THE CHOKE POINT. Every document that goes to or comes from Firestore passes
// through here, and nothing else in the module is allowed to build a payload.
//
// The donor app has 33 scattered Firestore call sites, each doing
// `.set(wholeObjectWithNamesInIt)`. Encrypting at 33 call sites means leaking
// at whichever one gets forgotten. So instead every encoder REBUILDS its
// document from a field allowlist. Unknown fields are dropped, not copied —
// which makes leaking a name require deliberately adding it to an allowlist,
// rather than merely forgetting to strip it.
//
// Wire shape for an associate everywhere:  { t: <token>, n: <sealed name> }
//   t — deterministic join key, safe to use as a map key or to query on
//   n — randomised ciphertext, display only, never a key

import { identify, open } from "./crypto.js";
import { WRITER_SOURCE, SCHEMA_VERSION } from "./config.js";

// The only metric columns that survive a write. Everything the donor's Excel
// import produces but the app never reads is dropped here — including
// "Associate ID", which is a durable personal identifier the app has no use
// for (verified: zero references in the donor's 9,305 lines).
const METRIC_COLUMNS = [
  "Pick Date", "Store #",
  "Min. First Scan",
  "FTP Expected", "FTP Actual", "Pick Rate", "Pick Hours",
  "Picked As Req Qty", "Substitution Qty", "Nil Pick Qty",
  "Exception Qty Req to Pick", "Exception Picked As Req Qty",
  "Exception Substitution Qty", "Exception Nil Pick Qty",
];

const SCHEDULE_FIELDS   = ["shiftStart", "shiftEnd", "startSlot", "endSlot"];
const ASSIGNMENT_FIELDS = ["slots", "status", "shiftStart", "shiftEnd"];

function pick(src, fields) {
  const out = {};
  for (const f of fields) if (src?.[f] !== undefined) out[f] = src[f];
  return out;
}

function stamp(doc) {
  return { ...doc, schemaVersion: SCHEMA_VERSION, writerSource: WRITER_SOURCE };
}

// ── weeks/{weekKey} ──────────────────────────────────────────────────────
export async function encodeWeek(doc) {
  const rows = await Promise.all((doc.rawData || []).map(async (row) => {
    const { t, n } = await identify(row.Associate);
    return { ...pick(row, METRIC_COLUMNS), t, n };
  }));
  return stamp({
    rawData:    rows,
    fileName:   doc.fileName ?? null,
    uploadDate: doc.uploadDate ?? null,
    store:      doc.store ?? null,
    weekStart:  doc.weekStart ?? null,
  });
}

export async function decodeWeek(doc) {
  if (!doc) return null;
  const legacy = (doc.schemaVersion ?? 1) < 2;
  const rows = await Promise.all((doc.rawData || []).map(async (row) => ({
    ...row,
    // Legacy rows written by the standalone app still carry a plaintext
    // Associate column; read them rather than losing the history.
    Associate: legacy ? row.Associate : (await open(row.n)) ?? "(unreadable)",
  })));
  return { ...doc, rawData: rows };
}

// ── metrics/classifications ──────────────────────────────────────────────
export async function encodeClassifications(map) {
  const data = {};
  for (const [name, classification] of Object.entries(map || {})) {
    const { t, n } = await identify(name);
    if (t) data[t] = { c: classification, n };
  }
  return stamp({ data });
}

export async function decodeClassifications(doc) {
  if (!doc?.data) return {};
  const out = {};
  for (const [key, val] of Object.entries(doc.data)) {
    // Legacy shape: { "JOHN SMITH": "Digital" }. New shape: { token: {c, n} }.
    if (typeof val === "string") { out[key] = val; continue; }
    const name = await open(val.n);
    if (name) out[name] = val.c;
  }
  return out;
}

// ── schedules/{date} and dailyAssignments/{date} ─────────────────────────
async function encodeRoster(list, fields) {
  return Promise.all((list || []).map(async (a) => {
    const { t, n } = await identify(a.name);
    return { ...pick(a, fields), t, n };
  }));
}

async function decodeRoster(list, legacy) {
  return Promise.all((list || []).map(async (a) => ({
    ...a,
    name: legacy ? a.name : (await open(a.n)) ?? "(unreadable)",
  })));
}

export async function encodeSchedule(doc) {
  return stamp({
    associates: await encodeRoster(doc.associates, SCHEDULE_FIELDS),
    store:      doc.store ?? null,
    importedAt: doc.importedAt ?? null,
  });
}

export async function decodeSchedule(doc) {
  if (!doc) return null;
  return { ...doc, associates: await decodeRoster(doc.associates, (doc.schemaVersion ?? 1) < 2) };
}

export async function encodeAssignments(doc) {
  return stamp({
    associates:  await encodeRoster(doc.associates, ASSIGNMENT_FIELDS),
    date:        doc.date ?? null,
    day:         doc.day ?? null,
    updatedAt:   doc.updatedAt ?? null,
    store:       doc.store ?? null,
    finalized:   doc.finalized ?? false,
    finalizedAt: doc.finalizedAt ?? null,
  });
}

export async function decodeAssignments(doc) {
  if (!doc) return null;
  return { ...doc, associates: await decodeRoster(doc.associates, (doc.schemaVersion ?? 1) < 2) };
}

// ── suggestions/{date} ───────────────────────────────────────────────────
export async function encodeSuggestions(doc) {
  const out = {};
  for (const [name, slots] of Object.entries(doc.suggestions || {})) {
    const { t } = await identify(name);
    if (t) out[t] = slots;   // no `n`: suggestions are keyed by token and
  }                          // rendered against a roster that already decoded
  return stamp({
    suggestions:     out,
    generatedAt:     doc.generatedAt ?? null,
    dayOfWeek:       doc.dayOfWeek ?? null,
    associateCount:  doc.associateCount ?? null,
  });
}

export function decodeSuggestions(doc) {
  return doc ? doc.suggestions || {} : {};
}

// ── Guard ────────────────────────────────────────────────────────────────
// Belt and braces. The allowlists above are the real defence; this catches a
// future edit that adds a name-bearing field to one of them.
const NAME_KEYS = /^(associate|name|firstname|lastname|fullname|employee|associatename)$/i;

export function assertNoPlaintextNames(doc, path = "root") {
  if (doc == null || typeof doc !== "object") return;
  if (Array.isArray(doc)) {
    doc.forEach((v, i) => assertNoPlaintextNames(v, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(doc)) {
    if (NAME_KEYS.test(k) && typeof v === "string" && v.trim() !== "") {
      throw new Error(
        `digitalmetrics: refusing to write plaintext name at ${path}.${k}. ` +
        `Encode through codec.js — see lib/codec.js header.`
      );
    }
    assertNoPlaintextNames(v, `${path}.${k}`);
  }
}
