// modules/digitalmetrics/lib/firestore.js
//
// The ONLY code in this module that talks to Firestore.
//
// Two rules make the privacy layer enforceable rather than aspirational:
//   1. Nothing outside this file constructs a Firestore request.
//   2. Every write goes through codec.js and then past assertNoPlaintextNames.
//
// REST-only, per suite policy — no Firebase JS SDK. That also means no
// onSnapshot: callers poll or listen for a SW broadcast instead.
//
// Value encoders below are deliberately a local copy of aurorbuddy's rather
// than a shared import; the module contract keeps modules self-contained.

import { BACKEND, WRITER_ENABLED_KEY } from "./config.js";
import {
  encodeWeek, decodeWeek,
  encodeClassifications, decodeClassifications,
  encodeSchedule, decodeSchedule,
  encodeAssignments, decodeAssignments,
  encodeSuggestions, decodeSuggestions,
  assertNoPlaintextNames,
} from "./codec.js";

const IDENTITY_BASE = "https://identitytoolkit.googleapis.com/v1";
const SESSION_KEYS  = { idToken: "digitalmetrics.fb_idToken", idTokenAt: "digitalmetrics.fb_idTokenAt" };
const TOKEN_TTL_MS  = 50 * 60 * 1000;   // Firebase ID tokens last 60 min

// ─── Auth ──────────────────────────────────────────────────────────────────
// The legacy project currently has no auth at all and rules of
// `allow read, write: if true`. Signing in anonymously here is what makes it
// possible to tighten those rules to `request.auth != null` later without
// rewriting this module. See DIGITAL_METRICS_PRIVACY.md.

async function idToken() {
  const got = await chrome.storage.session.get([SESSION_KEYS.idToken, SESSION_KEYS.idTokenAt]);
  const age = Date.now() - (got[SESSION_KEYS.idTokenAt] || 0);
  if (got[SESSION_KEYS.idToken] && age < TOKEN_TTL_MS) return got[SESSION_KEYS.idToken];

  const res = await fetch(`${IDENTITY_BASE}/accounts:signUp?key=${BACKEND.apiKey}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ returnSecureToken: true }),
  });
  if (!res.ok) throw new Error(`digitalmetrics: anonymous sign-in failed (${res.status})`);
  const data = await res.json();
  await chrome.storage.session.set({
    [SESSION_KEYS.idToken]:   data.idToken,
    [SESSION_KEYS.idTokenAt]: Date.now(),
  });
  return data.idToken;
}

// ─── Typed-field encoder/decoder (Firestore REST verbosity tax) ────────────

function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean")        return { booleanValue: v };
  if (typeof v === "number") {
    if (!Number.isFinite(v))         return { nullValue: null };
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === "string")         return { stringValue: v };
  if (v instanceof Date)             return { timestampValue: v.toISOString() };
  if (Array.isArray(v))              return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === "object")         return { mapValue: { fields: toFields(v) } };
  return { stringValue: String(v) };
}

function toFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = toValue(v);
  }
  return out;
}

function fromValue(v) {
  if (!v || typeof v !== "object") return v;
  if (v.nullValue      !== undefined) return null;
  if (v.booleanValue   !== undefined) return v.booleanValue;
  if (v.integerValue   !== undefined) return Number(v.integerValue);
  if (v.doubleValue    !== undefined) return Number(v.doubleValue);
  if (v.stringValue    !== undefined) return v.stringValue;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.arrayValue     !== undefined) return (v.arrayValue.values || []).map(fromValue);
  if (v.mapValue       !== undefined) return fromFields(v.mapValue.fields || {});
  return null;
}

function fromFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = fromValue(v);
  return out;
}

// ─── Transport ─────────────────────────────────────────────────────────────

async function request(path, { method = "GET", body } = {}) {
  const res = await fetch(`${BACKEND.root}/${path}`, {
    method,
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${await idToken()}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404 && method === "GET") return null;
  if (!res.ok) throw new Error(`digitalmetrics: ${method} ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function getDoc(path) {
  const doc = await request(path);
  return doc ? fromFields(doc.fields) : null;
}

async function setDoc(path, obj) {
  if (!(await writerEnabled())) return { ok: false, error: "writer disabled" };
  // Last line of defence before anything leaves the device.
  assertNoPlaintextNames(obj);
  // PATCH with no updateMask overwrites the whole document — the REST
  // equivalent of the donor's .set(), which is the semantics every caller wants.
  await request(path, { method: "PATCH", body: { fields: toFields(obj) } });
  return { ok: true };
}

async function listDocs(collectionPath, { pageSize = 300 } = {}) {
  const out = [];
  let pageToken;
  do {
    const qs   = new URLSearchParams({ pageSize: String(pageSize) });
    if (pageToken) qs.set("pageToken", pageToken);
    const page = await request(`${collectionPath}?${qs}`);
    for (const d of page?.documents || []) {
      out.push({ id: d.name.split("/").pop(), ...fromFields(d.fields) });
    }
    pageToken = page?.nextPageToken;
  } while (pageToken);
  return out;
}

async function writerEnabled() {
  const got = await chrome.storage.sync.get(WRITER_ENABLED_KEY);
  return got[WRITER_ENABLED_KEY] !== false;   // default on
}

// ─── Public API — the only surface the rest of the module may use ──────────
// Every method takes and returns PLAINTEXT names. Encoding is not optional and
// not the caller's business.

const wk   = (s, k) => `stores/${s}/weeks/${k}`;
const sch  = (s, d) => `stores/${s}/schedules/${d}`;
const asg  = (s, d) => `stores/${s}/dailyAssignments/${d}`;
const sug  = (s, d) => `stores/${s}/suggestions/${d}`;

export const store = {
  async listStores() {
    return (await getDoc("metrics/stores"))?.list || [];
  },
  async saveStores(list) {
    return setDoc("metrics/stores", { list: [...new Set(list)].sort() });
  },
  async listWeeks(s)  { return (await listDocs(`stores/${s}/weeks`)).map((d) => d.id).sort(); },
  async listDates(s, coll) { return (await listDocs(`stores/${s}/${coll}`)).map((d) => d.id).sort(); },
};

export const weeks = {
  async get(s, k)      { return decodeWeek(await getDoc(wk(s, k))); },
  async put(s, k, doc) { return setDoc(wk(s, k), await encodeWeek(doc)); },
};

export const classifications = {
  async get()    { return decodeClassifications(await getDoc("metrics/classifications")); },
  async put(map) { return setDoc("metrics/classifications", await encodeClassifications(map)); },
};

export const schedules = {
  async get(s, d)      { return decodeSchedule(await getDoc(sch(s, d))); },
  async put(s, d, doc) { return setDoc(sch(s, d), await encodeSchedule(doc)); },
};

export const assignments = {
  async get(s, d)      { return decodeAssignments(await getDoc(asg(s, d))); },
  async put(s, d, doc) { return setDoc(asg(s, d), await encodeAssignments(doc)); },

  /**
   * The most recent N assignment documents, newest first.
   *
   * Document ids are ISO dates, so lexical order is chronological order and no
   * orderBy (and therefore no index) is needed. Listing then slicing is fine at
   * one store's scale; if a store ever accumulates years of days, switch to a
   * runQuery with a startAt cursor.
   */
  async recent(s, limit = 30) {
    const docs = await listDocs(`stores/${s}/dailyAssignments`);
    const newest = docs.sort((a, b) => b.id.localeCompare(a.id)).slice(0, limit);
    return Promise.all(newest.map(decodeAssignments));
  },
};

export const suggestions = {
  async get(s, d)      { return decodeSuggestions(await getDoc(sug(s, d))); },
  async put(s, d, doc) { return setDoc(sug(s, d), await encodeSuggestions(doc)); },
};

export const _internal = { toFields, fromFields, toValue, fromValue };
