// modules/vizpick/lib/tests/location_details.test.mjs
//
// Run with: node --test modules/vizpick/lib/tests/location_details.test.mjs
//
// The "Download Location Details" export drives two things: per-bin-group
// counts, and the Associates view (who left suggested picks behind).
//
// NOTE ON "bin group": the leading segment of a location code (the 002 in
// 002/003) is NOT a department. This was mislabelled `dept` until 2026-08-22.
// The export carries no department column at all, so a location cannot be
// attributed to a department from this sheet.
// The header shape below mirrors the real export, which repeats "Status" and
// "Location" several times with differing trailing whitespace — Tableau emits
// one column per shelf that references a field. Matching a column by name
// therefore picks an arbitrary duplicate; these tests pin the content-based
// selection that avoids it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLocationDetails, rollUpSkippedByAssociate } from "../parse_vizpick_stores_csv.js";

const T = "\t";
const row = (...c) => c.join(T);

// Duplicate Status/Location columns, exactly as the live export emits them.
const HEAD = row(
  "Status  , Location    , Seen Today   (Combined)",
  "Status  ", "Location     ", "Pallets ", "Seen Today  ",
  "Status  ", "Location    ",
  "Max. last_seen_timestamp", "Max. user_id",
  "Suggested Picks Done", "Suggested Picks Seen",
);
const line = (loc, seenToday, ts, win, done, sug) =>
  row("In Use, , Yes", "In Use", loc, "1/1", seenToday, "In Use", loc, ts, win, done, sug);

const CSV = [
  HEAD,
  line("002/003", "Yes", "8/22/2026 6:12:55 AM", "aaa111a", "0", "3"),
  line("002/004", "No",  "",                     "",        "0", "2"),
  line("005/001", "Yes", "8/22/2026 7:01:00 AM", "aaa111a", "1", "1"),
  line("005/002", "Yes", "8/22/2026 9:45:00 PM", "bbb222b", "0", "4"),
].join("\r\n");

test("finds the real Location column among the duplicates", () => {
  const r = parseLocationDetails(CSV);
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(Object.keys(r.byLocGroup).sort(), ["2", "5"]);
});

test("per-bin-group counts come out as real counts", () => {
  const { byLocGroup } = parseLocationDetails(CSV);
  assert.deepEqual(byLocGroup["2"], { locsTotal: 2, locsSeen: 1, picksSeen: 5, picksDone: 0 });
  assert.deepEqual(byLocGroup["5"], { locsTotal: 2, locsSeen: 2, picksSeen: 5, picksDone: 1 });
});

test("only bins with outstanding picks are retained", () => {
  // 005/001 completed its single pick, so it is not a gap. Keeping every
  // location would put thousands of rows per market into the snapshot to say
  // nothing — the per-bin-group rollup already covers Location %.
  const { gaps } = parseLocationDetails(CSV);
  assert.deepEqual(gaps.map((g) => g.location), ["002/003", "002/004", "005/002"]);
  assert.deepEqual(gaps.map((g) => g.skipped), [3, 2, 4]);
});

test("the scan time is carried through unchanged", () => {
  // It is the check on the attribution: a 9:45 PM scan is exactly the case
  // where "who last scanned it" stops meaning "who skipped it".
  const late = parseLocationDetails(CSV).gaps.find((g) => g.location === "005/002");
  assert.equal(late.lastSeenAt, "8/22/2026 9:45:00 PM");
});

test("bins nobody scanned are separated, not blamed on anyone", () => {
  const { gaps } = parseLocationDetails(CSV);
  const { associates, unattributed, unattributedSkipped } = rollUpSkippedByAssociate(gaps);
  assert.equal(unattributed.length, 1);
  assert.equal(unattributed[0].location, "002/004");
  assert.equal(unattributedSkipped, 2);
  // Work not started is a different problem from work left behind; folding the
  // two together would put someone top of the list for a bin they never touched.
  assert.ok(associates.every((a) => a.win));
});

test("associates rank by picks left behind, worst first", () => {
  const { gaps } = parseLocationDetails(CSV);
  const { associates } = rollUpSkippedByAssociate(gaps);
  assert.deepEqual(associates.map((a) => a.skipped), [4, 3]);
  assert.equal(associates[0].bins.length, 1);
});

test("one associate's bins are grouped and sorted worst-first", () => {
  const many = [
    HEAD,
    line("001/001", "Yes", "8/22/2026 6:00:00 AM", "aaa111a", "0", "1"),
    line("001/002", "Yes", "8/22/2026 6:05:00 AM", "aaa111a", "0", "9"),
    line("001/003", "Yes", "8/22/2026 6:10:00 AM", "aaa111a", "0", "4"),
  ].join("\r\n");
  const { associates } = rollUpSkippedByAssociate(parseLocationDetails(many).gaps);
  assert.equal(associates.length, 1);
  assert.equal(associates[0].skipped, 14);
  assert.deepEqual(associates[0].bins.map((b) => b.location), ["001/002", "001/003", "001/001"]);
});

test("a sheet with no location codes is rejected rather than silently empty", () => {
  const wrong = [row("Dept", "Suggested Picks Seen"), row("1", "5")].join("\r\n");
  const r = parseLocationDetails(wrong);
  assert.equal(r.ok, false);
  assert.match(r.reason, /location codes/);
});

test("empty and malformed input fails cleanly", () => {
  for (const bad of ["", null, undefined, HEAD]) {
    assert.equal(parseLocationDetails(bad).ok, false);
  }
});

test("rollUp tolerates missing or malformed gaps", () => {
  for (const bad of [null, undefined, [], [null]]) {
    const r = rollUpSkippedByAssociate(bad);
    assert.deepEqual(r.associates, []);
  }
});

test("the worst associates sort first, so a top-10 slice takes the right ten", () => {
  // view.js caps the card at TOP_ASSOCIATES and resolves job titles only for
  // that slice — a store has ~50 distinct scanners and Workday lookups are
  // serial, so resolving everyone meant one paint kicking off twenty minutes
  // of background scraping. The cap is only correct if the ORDER is, which is
  // what this pins.
  const gaps = [];
  for (let i = 1; i <= 15; i++) {
    gaps.push({ locGroup: "1", location: `001/${String(i).padStart(3, "0")}`,
                picksSeen: i, picksDone: 0, skipped: i,
                win: `w${String(i).padStart(2, "0")}`, lastSeenAt: null });
  }
  const { associates } = rollUpSkippedByAssociate(gaps);
  assert.equal(associates.length, 15);
  // Worst first.
  assert.deepEqual(associates.slice(0, 3).map((a) => a.skipped), [15, 14, 13]);
  // The ten kept are strictly worse than every one dropped.
  const kept = associates.slice(0, 10).map((a) => a.skipped);
  const dropped = associates.slice(10).map((a) => a.skipped);
  assert.ok(Math.min(...kept) > Math.max(...dropped),
    "no dropped associate may have more picks left than a kept one");
});

test("ties break deterministically, so the cap does not shuffle between paints", () => {
  // Two associates on the same count must not swap places on re-render, or the
  // tenth row would flicker in and out and its title lookup would restart.
  const mk = (win) => ({ locGroup: "1", location: "001/001", picksSeen: 5, picksDone: 0, skipped: 5, win, lastSeenAt: null });
  const a = rollUpSkippedByAssociate([mk("bbb"), mk("aaa")]).associates.map((x) => x.win);
  const b = rollUpSkippedByAssociate([mk("aaa"), mk("bbb")]).associates.map((x) => x.win);
  assert.deepEqual(a, b);
});

// ── The full scan list (home store only) ──────────────────────────────────
//
// metricshot's "Un-scanned locations" section ranks EVERY scanned bin by
// staleness, which is wider than `gaps` (bins with picks still outstanding).
// Rather than have metricshot re-export the same sheet, the wider list is
// available here on request — and asked for only for the user's own store,
// because market-wide it would be thousands of rows a day for a section that
// only ever covers one store.

test("scans are not collected unless asked for", () => {
  // null, not [] — "we did not collect this" and "we collected it and there
  // was nothing" have to stay distinguishable, or the metricshot adapter
  // cannot tell a non-home store from a store nobody scanned.
  assert.equal(parseLocationDetails(CSV).scans, null);
});

test("allScans returns every SCANNED location, not just the ones with picks left", () => {
  const { scans, gaps } = parseLocationDetails(CSV, { allScans: true });
  assert.deepEqual(scans.map((s) => s.location), ["002/003", "005/001", "005/002"]);

  // Neither list contains the other — they answer different questions, which
  // is the whole reason both exist. scans is "who touched what, when"; gaps is
  // "what still needs pulling". Counts can tie by coincidence (they do here),
  // so assert the asymmetry directly.
  //   005/001 — scanned, pick completed  → in scans, NOT in gaps
  //   002/004 — never scanned, 2 outstanding → in gaps, NOT in scans
  assert.ok(scans.some((s) => s.location === "005/001"));
  assert.ok(!gaps.some((g) => g.location === "005/001"));
  assert.ok(gaps.some((g) => g.location === "002/004"));
  assert.ok(!scans.some((s) => s.location === "002/004"));
});

test("a location nobody scanned is not in the scan list", () => {
  // 002/004 has no timestamp. It belongs in "work not started", which gaps
  // already reports separately — putting it in a list ranked by staleness
  // would be ranking a bin that has no staleness.
  const { scans } = parseLocationDetails(CSV, { allScans: true });
  assert.ok(!scans.some((s) => s.location === "002/004"));
});

test("scan entries carry the raw timestamp, never a computed age", () => {
  // Hours are derived at READ time by the metricshot adapter. Computing them
  // here would freeze staleness at capture, so a snapshot read two hours later
  // would under-report every bin by two hours.
  const { scans } = parseLocationDetails(CSV, { allScans: true });
  assert.deepEqual(Object.keys(scans[0]).sort(), ["lastSeenAt", "location"]);
  assert.equal(scans[0].lastSeenAt, "8/22/2026 6:12:55 AM");
});

test("asking for scans does not change gaps or the department rollup", () => {
  const plain = parseLocationDetails(CSV);
  const wide  = parseLocationDetails(CSV, { allScans: true });
  assert.deepEqual(wide.gaps, plain.gaps);
  assert.deepEqual(wide.byLocGroup, plain.byLocGroup);
});
