// shared/tests/usage_labels.test.mjs
//
// Pins the store-scoped pseudonym derivation.
//
// The requirement was per-user reporting; the constraint is that
// suite_usage_events is pseudonymous by construction and
// backend/firestore.suite.rules REJECTS rows containing name/email/win at the
// rules layer, with the promise restated to users in docs/privacy/index.html.
// "Store 756 User 2" satisfies both because it is DERIVED at read time from
// (storeNumber, installationId) — data already on every row — and never
// written back.
//
// What each test defends:
//   · numbering is per store, so User 1 exists in every store
//   · ordering is by first-seen and deterministic, so a report run twice over
//     the same data does not rename people
//   · an install that changes store keeps its original label rather than
//     appearing to be two different people
//   · rows without an install id never silently become somebody

import test from "node:test";
import assert from "node:assert/strict";

import { labelInstalls, labelFor } from "../usage_labels.js";

const row = (installationId, storeNumber, timestamp) =>
  ({ installationId, storeNumber, _timestamp: timestamp });

test("numbering restarts per store", () => {
  const labels = labelInstalls([
    row("a", "1458", "2026-08-01T10:00:00Z"),
    row("b", "1458", "2026-08-02T10:00:00Z"),
    row("c", "756",  "2026-08-01T10:00:00Z"),
  ]);
  assert.equal(labels.get("a").label, "Store 1458 User 1");
  assert.equal(labels.get("b").label, "Store 1458 User 2");
  assert.equal(labels.get("c").label, "Store 756 User 1");
});

test("order is first-seen, not first-encountered in the array", () => {
  // The later row appears first — sorting must not follow input order.
  const labels = labelInstalls([
    row("late",  "1458", "2026-08-09T10:00:00Z"),
    row("early", "1458", "2026-08-01T10:00:00Z"),
  ]);
  assert.equal(labels.get("early").label, "Store 1458 User 1");
  assert.equal(labels.get("late").label,  "Store 1458 User 2");
});

test("the same data twice produces the same labels", () => {
  const rows = [
    row("a", "1458", "2026-08-01T10:00:00Z"),
    row("b", "1458", "2026-08-01T10:00:00Z"),   // identical timestamps
    row("c", "1458", "2026-08-01T10:00:00Z"),
  ];
  const first  = labelInstalls(rows);
  const second = labelInstalls([...rows].reverse());
  // Ties break on installation id, so even a fully tied set is stable — a
  // report that renamed people between runs would be worse than no labels.
  for (const id of ["a", "b", "c"]) {
    assert.equal(first.get(id).label, second.get(id).label, `${id} moved`);
  }
});

test("many rows for one install collapse to one label", () => {
  const labels = labelInstalls([
    row("a", "1458", "2026-08-01T10:00:00Z"),
    row("a", "1458", "2026-08-02T10:00:00Z"),
    row("a", "1458", "2026-08-03T10:00:00Z"),
  ]);
  assert.equal(labels.size, 1);
  assert.equal(labels.get("a").label, "Store 1458 User 1");
});

test("an install that moves store keeps its original label", () => {
  const labels = labelInstalls([
    row("a", "1458", "2026-08-01T10:00:00Z"),
    row("a", "756",  "2026-08-20T10:00:00Z"),   // analyst moved stores
  ]);
  // Filing it under both would read as two people where there is one.
  assert.equal(labels.get("a").store, "1458");
  assert.equal(labels.get("a").label, "Store 1458 User 1");
});

test("a missing store gets its own bucket, not store \"\"", () => {
  const labels = labelInstalls([row("a", "", "2026-08-01T10:00:00Z")]);
  assert.equal(labels.get("a").label, "Unknown store User 1");
});

test("rows with no installation id are ignored, not labelled", () => {
  const labels = labelInstalls([
    row(undefined, "1458", "2026-08-01T10:00:00Z"),
    row("a",       "1458", "2026-08-02T10:00:00Z"),
  ]);
  assert.equal(labels.size, 1);
  // An unattributable row must never be folded into a real person's count.
  assert.equal(labelFor(labels, { installationId: undefined }), "(unattributed)");
});

test("labelFor falls back rather than throwing on an unknown install", () => {
  assert.equal(labelFor(labelInstalls([]), { installationId: "ghost" }), "(unattributed)");
});

test("empty and junk input do not throw", () => {
  assert.equal(labelInstalls([]).size, 0);
  assert.equal(labelInstalls(null).size, 0);
  assert.equal(labelInstalls([null, undefined, {}]).size, 0);
});
