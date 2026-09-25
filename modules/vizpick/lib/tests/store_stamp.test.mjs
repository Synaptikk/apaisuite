// modules/vizpick/lib/tests/store_stamp.test.mjs
//
// Run with: node --test modules/vizpick/lib/tests/store_stamp.test.mjs
//
// Stores publish their current-day numbers on their own clocks. These pin the
// per-store decision that replaced the market-wide stamp check (2026-09-15):
// which stores are re-read, which stand, and what the header may claim.

import { test } from "node:test";
import assert from "node:assert/strict";
import { stampsMatch, decideStoreExports, knownStoreStamps, rowSourceUpdate, stampSpread } from "../store_stamp.js";
import { TODAY_DATA_REVISION } from "../today_coverage.js";

const HOUR = 60 * 60_000;
const NOW = Date.parse("2026-09-15T15:30:00");
const at = (iso) => ({ raw: iso.replace("T", " "), iso, hasTime: true });

test("stamps compare on iso when both have one, else on the raw string", () => {
  assert.equal(stampsMatch({ raw: "2026-09-15 14:03:00", iso: "2026-09-15T14:03:00" }, { raw: "9/15/2026 2:03:00 PM", iso: "2026-09-15T14:03:00" }), true);
  assert.equal(stampsMatch({ raw: "a" }, { raw: "a" }), true);
  assert.equal(stampsMatch({ raw: "a" }, { raw: "b" }), false);
  assert.equal(stampsMatch(null, { raw: "a" }), false);
});

test("a store is re-read when its own stamp moved, and stands when it did not", () => {
  const known = { ...at("2026-09-15T14:03:00"), capturedAt: new Date(NOW - HOUR).toISOString() };
  assert.deepEqual(decideStoreExports({ known, read: at("2026-09-15T14:03:00"), maxAgeMs: 90 * 60_000, now: NOW }), { skip: true, reason: "unchanged" });
  assert.deepEqual(decideStoreExports({ known, read: at("2026-09-15T15:03:00"), maxAgeMs: 90 * 60_000, now: NOW }), { skip: false, reason: "stamp moved" });
});

test("no stored row, an unreadable stamp, a forced refresh, or a row past the age ceiling all re-read", () => {
  const known = { ...at("2026-09-15T14:03:00"), capturedAt: new Date(NOW - HOUR).toISOString() };
  const read = at("2026-09-15T14:03:00");
  assert.equal(decideStoreExports({ known: null, read, maxAgeMs: HOUR * 2, now: NOW }).reason, "no stored row");
  assert.equal(decideStoreExports({ known, read: null, maxAgeMs: HOUR * 2, now: NOW }).reason, "stamp unreadable");
  assert.equal(decideStoreExports({ known, read, maxAgeMs: HOUR * 2, now: NOW, force: true }).reason, "forced");
  // The stamp has been seen stale from a reused session: past the ceiling the
  // row is re-read whatever the stamp says.
  assert.equal(decideStoreExports({ known, read, maxAgeMs: 30 * 60_000, now: NOW }).reason, "stored row too old");
  assert.equal(decideStoreExports({ known: { ...known, capturedAt: null }, read, maxAgeMs: HOUR * 2, now: NOW }).reason, "stored row too old");
});

const complete = (store, extra = {}) => ({
  store, dataRevision: TODAY_DATA_REVISION, hasHealth: true,
  casesSeenPct: 1, locationPct: 1, pickPct: 1, overstockPct: 1, vizpick: 1,
  deptGroups: [{ label: "GM", value: 1 }], locations: { gaps: [] }, ...extra,
});

test("known stamps come from complete rows of the same market, each with its own stamp", () => {
  const today = {
    market: "120", capturedAt: "2026-09-15T13:00:00", sourceUpdate: at("2026-09-15T12:00:00"),
    rows: [
      complete("1458", { sourceUpdate: at("2026-09-15T14:03:00"), capturedAt: "2026-09-15T14:10:00" }),
      complete("3660", { sourceUpdate: at("2026-09-15T13:03:00"), capturedAt: "2026-09-15T13:10:00" }),
      // Written before per-store stamps: falls back to the snapshot's.
      complete("669"),
      // Incomplete: left out so the crawl re-reads it.
      { ...complete("5151"), hasHealth: false, sourceUpdate: at("2026-09-15T14:03:00") },
    ],
  };
  const k = knownStoreStamps(today, "120");
  assert.deepEqual(Object.keys(k).sort(), ["1458", "3660", "669"]);
  assert.equal(k["1458"].iso, "2026-09-15T14:03:00");
  assert.equal(k["1458"].capturedAt, "2026-09-15T14:10:00");
  assert.equal(k["3660"].iso, "2026-09-15T13:03:00");
  assert.equal(k["669"].iso, "2026-09-15T12:00:00");
  assert.equal(k["669"].capturedAt, "2026-09-15T13:00:00");
  assert.deepEqual(knownStoreStamps(today, "323"), {}, "another market's rows are not checked against");
  assert.deepEqual(knownStoreStamps(null, "120"), {});
});

test("a row's own stamp wins over the snapshot's; the header shows the newest and knows when they differ", () => {
  const today = { sourceUpdate: at("2026-09-15T12:00:00"), rows: [] };
  assert.equal(rowSourceUpdate({ sourceUpdate: at("2026-09-15T14:03:00") }, today).iso, "2026-09-15T14:03:00");
  assert.equal(rowSourceUpdate({}, today).iso, "2026-09-15T12:00:00");
  assert.equal(rowSourceUpdate(null, null), null);

  const rows = [
    { store: "1", sourceUpdate: at("2026-09-15T14:03:00") },
    { store: "2", sourceUpdate: at("2026-09-15T15:03:00") },
    { store: "3" },
  ];
  const s = stampSpread(rows);
  assert.equal(s.newest.iso, "2026-09-15T15:03:00");
  assert.equal(s.oldest.iso, "2026-09-15T14:03:00");
  assert.equal(s.differ, true);
  assert.equal(s.stamped, 2);
  assert.equal(stampSpread([rows[0], { store: "4", sourceUpdate: at("2026-09-15T14:03:00") }]).differ, false);
  assert.deepEqual(stampSpread([]), { newest: null, oldest: null, differ: false, stamped: 0 });
});
