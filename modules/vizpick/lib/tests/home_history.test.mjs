// modules/vizpick/lib/tests/home_history.test.mjs
//
// Run with: node --test modules/vizpick/lib/tests/home_history.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import * as HH from "../home_history.js";
import { entryFromRow, addEntry, diffEntries, timeline, toCsv, fingerprint, indexSchedule, matchPerson,
  isScannedToday, unseenBins, firstSeenEvents, diffDepts } from "../home_history.js";
import { canonical } from "../../../digitalmetrics/lib/names.js";
import { parseLocationDetails } from "../parse_vizpick_stores_csv.js";

const bin = (location, seen, done, win = null, lastSeenAt = null) => ({ location, seen, done, win, lastSeenAt });
const rowWith = (bins, capturedAt) => ({ store: "1458", capturedAt, locations: { bins } });
const SU = { raw: "9/14/2026 1:04:03 PM", iso: "2026-09-14T13:04:03" };

test("parseLocationDetails returns every bin for the home store only", () => {
  const T = "\t";
  const csv = [
    ["Location", "Seen Today", "Max. last_seen_timestamp", "Max. user_id", "Suggested Picks Done", "Suggested Picks Seen"].join(T),
    ["002/003", "Yes", "9/14/2026 6:12:55 AM", "aaa111a", "0", "3"].join(T),
    ["002/004", "No", "", "", "0", "0"].join(T),
    ["005/001", "Yes", "9/14/2026 7:01:00 AM", "bbb222b", "1", "1"].join(T),
  ].join("\r\n");
  assert.equal(parseLocationDetails(csv).bins, null);
  const home = parseLocationDetails(csv, { allScans: true });
  assert.equal(home.bins.length, 3);
  // This header row has no case columns, so the case counts are null; "Seen
  // Today" needs 3 yes/no values to be recognised, so with 3 rows it is found.
  assert.deepEqual(home.bins[0], {
    location: "002/003", seen: 3, done: 0, win: "aaa111a", lastSeenAt: "9/14/2026 6:12:55 AM",
    seenToday: true, casesExpected: null, casesSeen: null,
  });
  assert.equal(home.bins[1].win, null);
});

test("rows without bins (other stores) produce no entry", () => {
  assert.equal(entryFromRow({ store: "5173", locations: { gaps: [] } }, { sourceUpdate: SU }), null);
});

const SU2 = { raw: "9/14/2026 3:04:03 PM", iso: "2026-09-14T15:04:03" };

test("identical data only confirms; changed data at a new stamp appends", () => {
  const a = entryFromRow(rowWith([bin("002/003", 3, 0)], "2026-09-14T13:10:00"), { sourceUpdate: SU });
  const a2 = entryFromRow(rowWith([bin("002/003", 3, 0)], "2026-09-14T13:40:00"), { sourceUpdate: SU });
  const b = entryFromRow(rowWith([bin("002/003", 5, 1)], "2026-09-14T15:10:00"), { sourceUpdate: SU2 });
  let r = addEntry(null, a);
  assert.equal(r.added, true);
  r = addEntry(r.history, a2);
  assert.equal(r.added, false);
  assert.equal(r.history.days["2026-09-14"].length, 1);
  assert.equal(r.history.days["2026-09-14"][0].lastConfirmedAt, "2026-09-14T13:40:00");
  r = addEntry(r.history, b);
  assert.equal(r.added, true);
  assert.equal(r.history.days["2026-09-14"].length, 2);
});

test("a re-crawl at the same Tableau stamp never becomes a second update, even if a row differs", () => {
  // Tableau's Metric Definitions: same stamp, same data. A bin's scan time
  // rendering differently on the re-read must not produce two rows to diff.
  const a = entryFromRow(rowWith([bin("002/003", 3, 0, "aaa111a", "9/14/2026 6:12:55 AM")], "2026-09-14T13:10:00"), { sourceUpdate: SU });
  const a2 = entryFromRow(rowWith([bin("002/003", 3, 1, "aaa111a", "9/14/2026 6:12:55 AM")], "2026-09-14T14:50:00"), { sourceUpdate: SU });
  let r = addEntry(null, a);
  r = addEntry(r.history, a2);
  assert.equal(r.added, false);
  assert.equal(r.history.days["2026-09-14"].length, 1);
  assert.equal(r.history.days["2026-09-14"][0].lastConfirmedAt, "2026-09-14T14:50:00");
  // Identical data at an unreadable stamp still only confirms.
  const c = entryFromRow(rowWith([bin("002/003", 3, 0)], "2026-09-14T16:00:00"), { sourceUpdate: null });
  const c2 = entryFromRow(rowWith([bin("002/003", 3, 0)], "2026-09-14T16:30:00"), { sourceUpdate: null });
  let q = addEntry(null, c);
  q = addEntry(q.history, c2);
  assert.equal(q.added, false);
});

test("fingerprint ignores bin order", () => {
  assert.equal(fingerprint([bin("1/1", 1, 0), bin("1/2", 2, 0)]), fingerprint([bin("1/2", 2, 0), bin("1/1", 1, 0)]));
});

test("keeps only the newest maxDays days", () => {
  let h = null;
  for (const d of ["2026-09-10", "2026-09-11", "2026-09-12"]) {
    h = addEntry(h, entryFromRow(rowWith([bin("1/1", 1, 0)], `${d}T12:00:00`), {}), { maxDays: 2 }).history;
  }
  assert.deepEqual(Object.keys(h.days).sort(), ["2026-09-11", "2026-09-12"]);
});

test("diff separates picks added, completed and removed, per bin", () => {
  const prev = { bins: [bin("002/003", 3, 0, "stk1", "9/14/2026 1:00:00 PM"), bin("005/001", 2, 0, "stk1", "9/14/2026 1:05:00 PM"), bin("007/001", 1, 0)] };
  const next = { bins: [
    bin("002/003", 5, 0, "dig1", "9/14/2026 5:30:00 PM"),   // +2 seen, rescanned by someone else
    bin("005/001", 2, 2, "stk1", "9/14/2026 1:05:00 PM"),   // 2 completed
    bin("009/009", 4, 0),                                   // new bin, 4 picks
  ] };                                                      // 007/001 gone
  const d = diffEntries(prev, next);
  assert.equal(d.added, 6);
  assert.equal(d.completed, 2);
  assert.equal(d.removed, 1);
  const b = d.bins.find((x) => x.location === "002/003");
  assert.equal(b.dSeen, 2);
  assert.equal(b.rescanned, true);
  assert.equal(b.prevWin, "stk1");
  assert.equal(b.win, "dig1");
  assert.equal(d.bins.find((x) => x.location === "009/009").isNew, true);
  assert.equal(d.bins.find((x) => x.location === "007/001").gone, true);
});

test("timeline has no diff on the first update", () => {
  const t = timeline([{ bins: [bin("1/1", 1, 0)] }, { bins: [bin("1/1", 2, 0)] }]);
  assert.equal(t[0].diff, null);
  assert.equal(t[1].diff.added, 1);
});

test("CSV is one line per bin per update, quoted safely", () => {
  const e1 = { capturedAt: "t1", sourceKey: "9/14/2026 1:04:03 PM", store: "1458", bins: [bin("002/003", 3, 0, "a1", "x")] };
  const e2 = { capturedAt: "t2", sourceKey: "s2", store: "1458", bins: [bin("002/003", 4, 1, "a1", "y")] };
  const lines = toCsv([e1, e2], { names: () => "Doe, Jane" }).split("\r\n");
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^t1,9\/14\/2026 1:04:03 PM,1458,002\/003,3,0,3,,,a1,"Doe, Jane",,,,x,no,,,$/);
  assert.match(lines[2], /,4,1,3,1,1,a1,/);
});

test("CSV carries name, job and shift from the person resolver", () => {
  const e = { capturedAt: "t1", sourceKey: "s", store: "1458", bins: [bin("002/003", 3, 0, "a1", "x"), bin("002/004", 1, 0)] };
  const lines = toCsv([e], { person: () => ({ name: "Jane Doe", job: "Digital Personal Shopper", shiftStart: "2026-09-14T14:00", shiftEnd: "2026-09-14T23:00" }) }).split("\r\n");
  assert.match(lines[0], /last_scanner_name,last_scanner_job,last_scanner_shift_start,last_scanner_shift_end,last_scan_time,scanned_today,cases_expected,cases_seen,first_scan_today$/);
  assert.match(lines[1], /,a1,Jane Doe,Digital Personal Shopper,2026-09-14T14:00,2026-09-14T23:00,x,no,,,$/);
  assert.match(lines[2], /,,,,,,no,,,$/);   // unscanned bin: no associate at all
});

test("schedule match: exact, first+last fallback, ambiguous fallback dropped", () => {
  const doc = { associates: [
    { name: "Jane Q Doe", jobName: "Stocking 1 TA", shiftStart: "06:00", shiftEnd: "14:30" },
    { name: "Sam Lee", jobName: "Digital Personal Shopper", shiftStart: "13:00", shiftEnd: "22:00" },
    { name: "Chris A Park", jobName: "Front End Checkout TA" },
    { name: "Chris B Park", jobName: "Deli/Bakery TA" },
  ] };
  const idx = indexSchedule(doc, canonical);
  assert.equal(matchPerson(idx, "SAM LEE", canonical)?.job, "Digital Personal Shopper");
  assert.equal(matchPerson(idx, "Jane Doe", canonical)?.job, "Stocking 1 TA");      // middle initial missing
  assert.equal(matchPerson(idx, "Chris Park", canonical), null);                     // two Chris Parks: no guess
  assert.equal(matchPerson(idx, "Nobody Here", canonical), null);
});

test("parser keeps Seen Today and per-bin case counts for the home store", () => {
  const T = "\t";
  const csv = [
    ["Location", "Seen Today", "Max. last_seen_timestamp", "Max. user_id", "Suggested Picks Done", "Suggested Picks Seen", "ZN(SUM(cases_expected))", "ZN(SUM(cases_seen))", "Cases Seen %"].join(T),
    ["002/003", "Yes", "9/14/2026 6:12:55 AM", "a1", "0", "3", "5", "4", "80%"].join(T),
    ["002/004", "No", "9/13/2026 9:00:00 PM", "b2", "0", "0", "2", "0", "0%"].join(T),
    ["005/001", "Yes", "9/14/2026 7:01:00 AM", "c3", "1", "1", "1", "1", "100%"].join(T),
  ].join("\r\n");
  const { bins } = parseLocationDetails(csv, { allScans: true });
  assert.deepEqual(
    { seenToday: bins[0].seenToday, casesExpected: bins[0].casesExpected, casesSeen: bins[0].casesSeen },
    { seenToday: true, casesExpected: 5, casesSeen: 4 });
  assert.equal(bins[1].seenToday, false);
});

test("scanned-today: the export flag wins, else the last scan's day", () => {
  const e = { sourceIso: "2026-09-14T14:03:59" };
  assert.equal(isScannedToday({ seenToday: false, lastSeenAt: "9/14/2026 6:00:00 AM" }, e), false);
  assert.equal(isScannedToday({ lastSeenAt: "9/14/2026 6:00:00 AM" }, e), true);
  assert.equal(isScannedToday({ lastSeenAt: "9/13/2026 9:00:00 PM" }, e), false);
  assert.equal(isScannedToday({ lastSeenAt: null }, e), false);
  const u = unseenBins({ ...e, bins: [bin("004/001", 0, 0, "x", "9/13/2026 9:00:00 PM"), bin("002/003", 3, 0, "y", "9/14/2026 6:00:00 AM")] });
  assert.deepEqual(u.map((b) => [b.location, b.group]), [["004/001", "004"]]);
});

test("first scan of the day is caught, with the picks that appeared and cases seen", () => {
  const e1 = { capturedAt: "2026-09-14T15:00:00", sourceIso: "2026-09-14T14:00:00", bins: [
    { ...bin("024/002", 0, 0, "stk1", "9/13/2026 8:00:00 PM"), seenToday: false, casesExpected: 6, casesSeen: 0 },
    { ...bin("002/003", 3, 3, "stk1", "9/14/2026 9:00:00 AM"), seenToday: true, casesExpected: 3, casesSeen: 3 },
  ] };
  const e2 = { capturedAt: "2026-09-14T18:00:00", sourceIso: "2026-09-14T17:00:00", bins: [
    { ...bin("024/002", 4, 0, "dig1", "9/14/2026 4:40:00 PM"), seenToday: true, casesExpected: 6, casesSeen: 6 },
    { ...bin("002/003", 3, 3, "stk1", "9/14/2026 9:00:00 AM"), seenToday: true, casesExpected: 3, casesSeen: 3 },
  ] };
  const d = diffEntries(e1, e2);
  assert.equal(d.firstSeenBins, 1);
  assert.equal(d.picksOnFirstSeen, 4);
  const ev = firstSeenEvents([e1, e2]);
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].location, ev[0].dSeen, ev[0].dCasesSeen, ev[0].win], ["024/002", 4, 6, "dig1"]);
  assert.equal(ev[0].dataTime, "2026-09-14T17:00:00");
  assert.match(toCsv([e1, e2]).split("\r\n")[3], /^2026-09-14T18:00:00,.*,024\/002,.*,yes,6,6,yes$/);
});

test("no false first scan when the earlier entry predates the Seen Today flag", () => {
  const old = { sourceIso: "2026-09-14T14:03:59", bins: [bin("999/999", 0, 0, null, null)] };             // no flag: date basis → unscanned
  const now = { sourceIso: "2026-09-14T14:03:59", bins: [{ ...bin("999/999", 0, 0, null, null), seenToday: true }] };
  assert.equal(diffEntries(old, now).firstSeenBins, 0);
  assert.equal(firstSeenEvents([old, now]).length, 0);
  assert.doesNotMatch(toCsv([old, now]).split("\r\n")[2], /,yes$/);
});

test("department diff, and null baselines when the earlier entry had none", () => {
  const a = { depts: [{ dept: "1", suggested: 10, done: 8, casesSeen: 20, casesExpected: 30 }] };
  const b = { depts: [{ dept: "1", suggested: 14, done: 9, casesSeen: 28, casesExpected: 30 }, { dept: "2", suggested: 3, done: 0, casesSeen: 1, casesExpected: 4 }] };
  const d = diffDepts(a, b);
  assert.deepEqual([d[0].dSuggested, d[0].dDone, d[0].dCasesSeen, d[0].suggestedFirst], [4, 1, 8, 10]);
  assert.equal(d[1].suggestedFirst, 0);
  assert.equal(diffDepts({ bins: [] }, b)[0].suggestedFirst, null);
});

test("entryFromRow keeps the department breakout", () => {
  const e = entryFromRow({ store: "1458", locations: { bins: [bin("1/1", 1, 0)] },
    depts: [{ dept: "7", suggestedPicks: 12, suggestedPicksCompleted: 5, casesSeen: 40, casesExpected: 50 }] }, { capturedAt: "2026-09-14T12:00:00" });
  assert.deepEqual(e.depts, [{ dept: "7", suggested: 12, done: 5, casesSeen: 40, casesExpected: 50 }]);
  assert.equal(e.bins[0].seenToday, null);
});

// ── Wrong-store guard ───────────────────────────────────────────────────────
// 2026-09-14: three of the four afternoon entries for 1458 were other stores'
// bin lists (224 and 247 bins against 1458's 149), captured when the Store
// parameter never committed server-side. Their diffs were the "oddities".
const binsOf = (prefix, n, seen = 1) => Array.from({ length: n }, (_, i) => bin(`${prefix}/${String(i + 1).padStart(3, "0")}`, seen, 0));
const SU3 = { raw: "9/14/2026 4:04:23 PM", iso: "2026-09-14T16:04:23" };

test("an entry whose bins are another store's is rejected, not appended", () => {
  const mine = entryFromRow(rowWith(binsOf("100", 149), "2026-09-14T20:41:20Z"), { sourceUpdate: SU });
  const theirs = entryFromRow(rowWith([...binsOf("100", 5), ...binsOf("900", 240)], "2026-09-14T20:41:56Z"), { sourceUpdate: SU2 });
  let r = addEntry(null, mine);
  r = addEntry(r.history, theirs);
  assert.equal(r.added, false);
  assert.equal(r.rejected.store, "1458");
  assert.equal(r.rejected.locations, 245);
  assert.equal(r.history.days["2026-09-14"].length, 1);
  // A genuine next update — same bins, a few new ones — is still appended.
  const later = entryFromRow(rowWith([...binsOf("100", 149, 2), ...binsOf("101", 4)], "2026-09-14T21:41:47Z"), { sourceUpdate: SU3 });
  r = addEntry(r.history, later);
  assert.equal(r.added, true);
  assert.equal(r.history.days["2026-09-14"].length, 2);
});

test("a correct entry is accepted against an earlier day when today's newest entry was a wrong-store slip", () => {
  const yesterday = entryFromRow(rowWith(binsOf("100", 149), "2026-09-13T22:00:00Z"), { sourceUpdate: { raw: "9/13/2026 5:00:00 PM", iso: "2026-09-13T17:00:00" } });
  let r = addEntry(null, yesterday);
  // A wrong-store entry recorded before the guard existed.
  const slipped = entryFromRow(rowWith(binsOf("900", 224), "2026-09-14T13:00:00Z"), { sourceUpdate: SU });
  r = { history: { ...r.history, days: { ...r.history.days, "2026-09-14": [slipped] } } };
  const mine = entryFromRow(rowWith(binsOf("100", 143), "2026-09-14T14:00:00Z"), { sourceUpdate: SU2 });
  r = addEntry(r.history, mine);
  assert.equal(r.added, true);
  assert.equal(r.rejected, undefined);
});

test("first entry ever for a store has nothing to compare with and is accepted", () => {
  const first = entryFromRow(rowWith(binsOf("100", 149), "2026-09-14T13:00:00Z"), { sourceUpdate: SU });
  assert.equal(addEntry(null, first).added, true);
});

test("the same stamp still folds rather than rejects", () => {
  const a = entryFromRow(rowWith(binsOf("100", 149), "2026-09-14T13:00:00Z"), { sourceUpdate: SU });
  const b = entryFromRow(rowWith(binsOf("900", 224), "2026-09-14T13:30:00Z"), { sourceUpdate: SU });
  let r = addEntry(null, a);
  r = addEntry(r.history, b);
  assert.equal(r.added, false);
  assert.equal(r.rejected, undefined);
  assert.equal(r.history.days["2026-09-14"][0].totals.locations, 149);
});

test("repairAgainst drops the entries that are other stores' bins and keeps the rest", () => {
  const { repairAgainst } = HH;
  const at = (d, t) => `${d}T${t}Z`;
  const right1 = entryFromRow(rowWith(binsOf("100", 149), at("2026-09-14", "20:41:20")), { sourceUpdate: SU });
  const wrong1 = entryFromRow(rowWith([...binsOf("100", 5), ...binsOf("900", 242)], at("2026-09-14", "20:41:56")), { sourceUpdate: SU2 });
  const wrong2 = entryFromRow(rowWith([...binsOf("100", 6), ...binsOf("800", 218)], at("2026-09-14", "21:12:56")), { sourceUpdate: SU });
  const wrong3 = entryFromRow(rowWith([...binsOf("100", 6), ...binsOf("800", 218)], at("2026-09-14", "21:41:47")), { sourceUpdate: SU3 });
  const other = { ...entryFromRow(rowWith(binsOf("800", 224), at("2026-09-14", "21:00:00")), { sourceUpdate: SU }), store: "1089" };
  const today = entryFromRow(rowWith(binsOf("100", 144), at("2026-09-15", "14:37:03")), { sourceUpdate: SU3 });
  const history = { v: 1, days: { "2026-09-14": [right1, wrong1, other, wrong2, wrong3], "2026-09-15": [today] } };
  const { history: fixed, removed } = repairAgainst(history, { store: "1458", bins: binsOf("100", 144) });
  assert.deepEqual(removed.map((r) => r.capturedAt), [wrong1.capturedAt, wrong2.capturedAt, wrong3.capturedAt]);
  assert.deepEqual(fixed.days["2026-09-14"].map((e) => e.capturedAt), [right1.capturedAt, other.capturedAt]);
  assert.equal(fixed.days["2026-09-15"].length, 1);
  // A day left with nothing disappears rather than lingering empty.
  const gone = repairAgainst({ v: 1, days: { "2026-09-13": [wrong1] } }, { store: "1458", bins: binsOf("100", 144) });
  assert.deepEqual(Object.keys(gone.history.days), []);
});
