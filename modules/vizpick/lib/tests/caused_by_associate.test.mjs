// modules/vizpick/lib/tests/caused_by_associate.test.mjs
// node --test modules/vizpick/lib/tests/caused_by_associate.test.mjs
//
// The Associates card ranks people by picks left, which is last-scanner
// attribution: a digital associate scanning at 21:40 inherits what the
// stocking crew left at 14:00. causedByAssociate() is the counter-number --
// each scan owns only the growth that appeared under it. These tests hold the
// rule the analyst stated: "if Shane scans and leaves 12 he owns that 12, and
// then Matt scans and it's 14, Matt only owns 2".
import test from "node:test";
import assert from "node:assert/strict";

globalThis.chrome = globalThis.chrome || {};
const { causedByAssociate } = await import("../home_history.js");

const E = (iso, bins) => ({ store: "1458", sourceIso: iso, capturedAt: iso, bins });
const B = (location, seen, done, win, at) => ({
  location, seen, done, win, lastSeenAt: at, seenToday: !!at,
});

test("a scan owns only the growth under it, not the running total", () => {
  const day = [
    E("2026-09-28T09:00:00Z", [B("001/001", 0, 0, null, null)]),
    E("2026-09-28T13:00:00Z", [B("001/001", 12, 0, "SHANE", "t1")]),
    E("2026-09-28T21:40:00Z", [B("001/001", 14, 0, "MATT", "t2")]),
  ];
  const { byWin } = causedByAssociate(day);
  assert.equal(byWin.get("SHANE").caused, 12);
  assert.equal(byWin.get("MATT").caused, 2);
});

test("the last scanner is still the one blamed by picks-left, which is the point", () => {
  const day = [
    E("2026-09-28T09:00:00Z", [B("001/001", 0, 0, null, null)]),
    E("2026-09-28T13:00:00Z", [B("001/001", 12, 0, "SHANE", "t1")]),
    E("2026-09-28T21:40:00Z", [B("001/001", 14, 0, "MATT", "t2")]),
  ];
  const { byWin } = causedByAssociate(day);
  // Matt carries the whole outstanding pile at close but caused almost none
  // of it; Shane caused most of it and looks clean. That gap is the finding.
  assert.equal(byWin.get("MATT").openAtClose, 14);
  assert.equal(byWin.get("SHANE").openAtClose, 0);
  assert.ok(byWin.get("MATT").openAtClose > byWin.get("MATT").caused * 5);
});

test("picks pulled do not hand the puller a negative or inflate the next scanner", () => {
  const day = [
    E("2026-09-28T09:00:00Z", [B("002/002", 10, 0, "SHANE", "t1")]),
    // Matt pulls 6 of them; suggested-seen does not move.
    E("2026-09-28T15:00:00Z", [B("002/002", 10, 6, "MATT", "t2")]),
  ];
  const { byWin } = causedByAssociate(day);
  assert.equal(byWin.get("MATT").caused, 0);
  assert.equal(byWin.get("MATT").openAtClose, 4);
});

test("growth on a bin nobody rescanned belongs to nobody", () => {
  const day = [
    E("2026-09-28T09:00:00Z", [B("003/003", 5, 0, "SHANE", "t1")]),
    // Same lastSeenAt: no new scan happened, the list simply grew.
    E("2026-09-28T17:00:00Z", [B("003/003", 11, 0, "SHANE", "t1")]),
  ];
  const { byWin, unscanned } = causedByAssociate(day);
  assert.equal(unscanned.picks, 6);
  // Shane is still the bin's last scanner, so picks-left charges him all 11 at
  // close -- but he caused none of the growth, because no scan happened while
  // it grew. This is the sharpest version of the whole problem.
  assert.equal(byWin.get("SHANE").caused, 0);
  assert.equal(byWin.get("SHANE").scans, 0);
  assert.equal(byWin.get("SHANE").openAtClose, 11);
});

test("a scan with no WIN is not turned into a person", () => {
  const day = [
    E("2026-09-28T09:00:00Z", [B("004/004", 0, 0, null, null)]),
    E("2026-09-28T12:00:00Z", [B("004/004", 7, 0, null, "t1")]),
  ];
  const { byWin, causedTotal } = causedByAssociate(day);
  assert.equal(byWin.size, 0);
  assert.equal(causedTotal, 0);
});

test("growth is summed across bins per associate", () => {
  const day = [
    E("2026-09-28T09:00:00Z", [B("a", 0, 0, null, null), B("b", 0, 0, null, null)]),
    E("2026-09-28T12:00:00Z", [B("a", 4, 0, "SHANE", "t1"), B("b", 3, 0, "SHANE", "t1")]),
    E("2026-09-28T18:00:00Z", [B("a", 9, 0, "MATT", "t2"), B("b", 3, 0, "SHANE", "t1")]),
  ];
  const { byWin, causedTotal } = causedByAssociate(day);
  assert.equal(byWin.get("SHANE").caused, 7);
  assert.equal(byWin.get("MATT").caused, 5);
  assert.equal(causedTotal, 12);
});

test("an empty or single-update day yields nothing rather than throwing", () => {
  assert.equal(causedByAssociate([]).byWin.size, 0);
  assert.equal(causedByAssociate([E("2026-09-28T09:00:00Z", [B("a", 5, 0, "SHANE", "t1")])]).causedTotal, 0);
});

test("a pull with no scanner nearby comes off the oldest picks first", () => {
  const day = [
    E("2026-09-28T09:00:00Z", [B("010/010", 0, 0, null, null)]),
    E("2026-09-28T13:00:00Z", [B("010/010", 12, 0, "SHANE", "t1")]),
    E("2026-09-28T17:00:00Z", [B("010/010", 14, 0, "MATT", "t2")]),
    E("2026-09-28T19:00:00Z", [B("010/010", 14, 0, "MATT", "t2")]),
    // 10 pulled with no new scan and none in the update before: oldest go first.
    E("2026-09-28T21:00:00Z", [B("010/010", 14, 10, "MATT", "t2")]),
  ];
  const { byWin } = causedByAssociate(day);
  assert.equal(byWin.get("MATT").causedOpen, 2);
  assert.equal(byWin.get("SHANE").causedOpen, 2);
  assert.deepEqual(byWin.get("SHANE").causedOpenBins, [{ location: "010/010", open: 2, caused: 12, due: 14, done: 10 }]);
});

// The analyst's rule (2026-10-19): whoever scans is who pulls, and a pull
// comes off that person's own picks before anyone else's.
test("each scanner's pulls come off their own picks", () => {
  const day = [
    E("2026-09-28T09:00:00Z", [B("013/013", 0, 0, null, null)]),
    // A surfaces 20 and pulls 10.
    E("2026-09-28T12:00:00Z", [B("013/013", 20, 10, "A", "t1")]),
    // B surfaces 10 more and pulls 5.
    E("2026-09-28T15:00:00Z", [B("013/013", 30, 15, "B", "t2")]),
  ];
  const { byWin } = causedByAssociate(day);
  assert.equal(byWin.get("A").causedOpen, 10);
  assert.equal(byWin.get("B").causedOpen, 5);
});

test("B pulling nothing leaves A's 10 with A and B's 10 with B", () => {
  const day = [
    E("2026-09-28T09:00:00Z", [B("014/014", 0, 0, null, null)]),
    E("2026-09-28T12:00:00Z", [B("014/014", 20, 10, "A", "t1")]),
    E("2026-09-28T15:00:00Z", [B("014/014", 30, 10, "B", "t2")]),
  ];
  const { byWin } = causedByAssociate(day);
  assert.equal(byWin.get("A").causedOpen, 10);
  assert.equal(byWin.get("B").causedOpen, 10);
});

test("a pull posted one update after a scan belongs to that scanner", () => {
  const day = [
    E("2026-09-28T09:00:00Z", [B("015/015", 0, 0, null, null)]),
    E("2026-09-28T12:00:00Z", [B("015/015", 8, 0, "A", "t1")]),
    E("2026-09-28T14:00:00Z", [B("015/015", 12, 0, "B", "t2")]),
    // B's pulls post an update late, with no new scan.
    E("2026-09-28T15:00:00Z", [B("015/015", 12, 4, "B", "t2")]),
  ];
  const { byWin } = causedByAssociate(day);
  assert.equal(byWin.get("A").causedOpen, 8);
  assert.equal(byWin.get("B")?.causedOpen ?? 0, 0);
});

test("pulls beyond the puller's own picks come off the oldest", () => {
  const day = [
    E("2026-09-28T09:00:00Z", [B("016/016", 0, 0, null, null)]),
    E("2026-09-28T12:00:00Z", [B("016/016", 10, 0, "A", "t1")]),
    // B surfaces 2 and pulls 7: their own 2, then 5 of A's.
    E("2026-09-28T15:00:00Z", [B("016/016", 12, 7, "B", "t2")]),
  ];
  const { byWin, causedOpenTotal } = causedByAssociate(day);
  assert.equal(byWin.get("A").causedOpen, 5);
  assert.equal(byWin.get("B").causedOpen, 0);
  assert.equal(causedOpenTotal, 5);
});

test("caused picks that were all pulled leave nothing charged", () => {
  const day = [
    E("2026-09-28T09:00:00Z", [B("011/011", 0, 0, null, null)]),
    E("2026-09-28T13:00:00Z", [B("011/011", 8, 0, "SHANE", "t1")]),
    E("2026-09-28T20:00:00Z", [B("011/011", 8, 8, "MATT", "t2")]),
  ];
  const { byWin, causedOpenTotal } = causedByAssociate(day);
  assert.equal(byWin.get("SHANE").caused, 8);
  assert.equal(byWin.get("SHANE").causedOpen, 0);
  assert.equal(byWin.get("MATT").causedOpen, 0);
  assert.equal(causedOpenTotal, 0);
});

test("what the bin held at the first update and idle growth stay with nobody", () => {
  const day = [
    E("2026-09-28T09:00:00Z", [B("012/012", 5, 0, "SHANE", "t0")]),
    E("2026-09-28T13:00:00Z", [B("012/012", 9, 0, "SHANE", "t0")]),
  ];
  const { byWin, openOwnedByNobody } = causedByAssociate(day);
  assert.equal(byWin.get("SHANE")?.causedOpen ?? 0, 0);
  assert.equal(openOwnedByNobody, 9);
});
