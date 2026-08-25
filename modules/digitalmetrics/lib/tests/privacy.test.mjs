// modules/digitalmetrics/lib/tests/privacy.test.mjs
//
// The privacy layer's regression suite. If any of these fail, associate names
// are either leaking to Firestore or no longer joining across data sources.
//
// Run with: node --test modules/digitalmetrics/lib/tests/privacy.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { canonical, loadAliases } from "../names.js";
import { configureKey, token, seal, open } from "../crypto.js";
import {
  encodeWeek, decodeWeek,
  encodeClassifications, decodeClassifications,
  encodeSchedule, encodeAssignments, decodeAssignments,
  assertNoPlaintextNames,
} from "../codec.js";

configureKey(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"));

// ── canonicalisation ─────────────────────────────────────────────────────
test("canonical folds the spellings the two data sources actually produce", () => {
  assert.equal(canonical("SMITH, JOHN A"), "JOHN A SMITH");
  assert.equal(canonical("john  a  smith"), "JOHN A SMITH");
  assert.equal(canonical("John Smith - Cap 2 Assoc"), "JOHN SMITH");
  assert.equal(canonical("José Núñez"), "JOSE NUNEZ");
  assert.equal(canonical("JOHN SMITH JR"), "JOHN SMITH");
});

test("hyphenated surnames survive the job-title stripper", () => {
  // Regression: an earlier rule stripped everything after any dash, turning
  // "Smith-Jones, Amy" into "SMITH".
  assert.equal(canonical("Smith-Jones, Amy"), "AMY SMITH JONES");
  assert.equal(canonical("AMY SMITH-JONES"), "AMY SMITH JONES");
});

test("middle initials are preserved to keep distinct people distinct", () => {
  assert.notEqual(canonical("ZORINA K"), canonical("ZORINA M"));
});

test("empty and null inputs are safe", () => {
  assert.equal(canonical(null), "");
  assert.equal(canonical("   "), "");
});

// ── crypto primitives ────────────────────────────────────────────────────
test("tokens are deterministic across spellings, distinct across people", async () => {
  assert.equal(await token("SMITH, JOHN A"), await token("john a smith"));
  assert.notEqual(await token("Jane Doe"), await token("John Smith"));
});

test("sealed names are randomised and round-trip", async () => {
  const a = await seal("John A Smith");
  const b = await seal("John A Smith");
  assert.notEqual(a, b, "identical ciphertext would make `n` usable as a key");
  assert.equal(await open(a), "John A Smith");
});

test("tampered ciphertext is rejected rather than returned", async () => {
  const sealed = await seal("John A Smith");
  assert.equal(await open(sealed.slice(0, -2) + "AA"), null);
});

// ── the actual requirement ───────────────────────────────────────────────
test("no plaintext name survives into a week document", async () => {
  const enc = await encodeWeek({
    rawData: [{ "Associate": "SMITH, JOHN A", "Associate ID": "1234567",
                "Pick Hours": 6.5, "Ovrd Qty": 3 }],
    store: "1458",
  });
  const wire = JSON.stringify(enc);
  assert.ok(!/SMITH|JOHN/i.test(wire));
  assert.ok(!wire.includes("1234567"), "associate ID is a durable identifier");
  assert.ok(!wire.includes("Ovrd Qty"), "columns the app never reads are dropped");
  assert.equal(enc.rawData[0]["Pick Hours"], 6.5);
  assert.equal((await decodeWeek(enc)).rawData[0].Associate, "SMITH, JOHN A");
});

test("the same associate joins across metrics and schedule sources", async () => {
  // The single most important property here. Metrics arrive as "SMITH, JOHN A"
  // from the Tableau export; schedules arrive as "John A Smith" from the
  // scheduler scrape. If these tokens ever diverge, every cross-source feature
  // in the module (adherence, opportunities, suggestions) silently breaks.
  const week  = await encodeWeek({ rawData: [{ Associate: "SMITH, JOHN A" }] });
  const sched = await encodeSchedule({ associates: [{ name: "John A Smith" }] });
  assert.equal(week.rawData[0].t, sched.associates[0].t);
});

test("classifications encode without plaintext keys and round-trip", async () => {
  const enc = await encodeClassifications({ "SMITH, JOHN A": "Digital" });
  assert.ok(!/SMITH/i.test(JSON.stringify(enc)));
  assert.equal((await decodeClassifications(enc))["SMITH, JOHN A"], "Digital");
});

test("assignments round-trip and keep their finalize state", async () => {
  const enc = await encodeAssignments({
    associates: [{ name: "Jane Doe", slots: { 3: "P" }, status: "tardy" }],
    date: "2026-01-05", finalized: true,
  });
  assert.ok(!/Jane|Doe/i.test(JSON.stringify(enc)));
  const dec = await decodeAssignments(enc);
  assert.equal(dec.associates[0].name, "Jane Doe");
  assert.deepEqual(dec.associates[0].slots, { 3: "P" });
  assert.equal(dec.finalized, true);
});

// ── back-compat with the standalone app's existing data ──────────────────
test("v1 documents written by the standalone app are still readable", async () => {
  const legacy = { rawData: [{ Associate: "OLD PLAINTEXT", "Pick Hours": 4 }] };
  assert.equal((await decodeWeek(legacy)).rawData[0].Associate, "OLD PLAINTEXT");
  assert.equal((await decodeClassifications({ data: { "OLD NAME": "Digital" } }))["OLD NAME"], "Digital");
});

// ── guard ────────────────────────────────────────────────────────────────
test("the guard rejects a plaintext name and passes an encoded document", async () => {
  assert.throws(() => assertNoPlaintextNames({ associates: [{ name: "John Smith" }] }),
                /refusing to write plaintext name/);
  assertNoPlaintextNames(await encodeWeek({ rawData: [{ Associate: "John Smith" }] }));
});

// ── aliases ──────────────────────────────────────────────────────────────
test("aliases collapse nicknames onto one token", async () => {
  // Synthetic names only — never a real roster entry, even in a test.
  loadAliases({ "ZZTOP": "Zelda Zzyzx" });
  assert.equal(await token("ZZTOP"), await token("Zelda Zzyzx"));
  loadAliases({});
});
