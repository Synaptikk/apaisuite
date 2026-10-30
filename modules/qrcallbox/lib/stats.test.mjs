import { test } from "node:test";
import assert from "node:assert/strict";
import { scanRow, summarize, radioLabel } from "./stats.js";

const T0 = Date.UTC(2026, 9, 30, 12, 0, 0);
const utc = (ts) => { const d = new Date(ts); return { day: d.getUTCDay(), hour: d.getUTCHours() }; };

test("scanRow prefers the Workvivo responder and its measured time", () => {
  const r = scanRow({
    id: "a", timestamp: T0, area: "cosmetics", areaDescription: "Cosmetics A-3",
    workvivoPostedAt: T0 + 5000, workvivoResponderName: "Pat", workvivoResponseTimeMs: 42000,
    claimedByName: "Old", claimedAt: T0 + 99000, radio: { status: "announced" },
  });
  assert.equal(r.area, "Cosmetics A-3");
  assert.equal(r.baseArea, "cosmetics");
  assert.equal(r.responder, "Pat");
  assert.equal(r.responseMs, 42000);
  assert.equal(r.wvPosted, true);
  assert.equal(r.radio, "announced");
});

test("scanRow on an unanswered pending scan", () => {
  const r = scanRow({ id: "b", timestamp: T0, area: "", status: "pending", claimedByName: "", claimedAt: null });
  assert.equal(r.area, "(no area)");
  assert.equal(r.responder, "");
  assert.equal(r.responseMs, null);
  assert.equal(r.wvPosted, false);
});

test("summarize counts, heat, areas and responders", () => {
  const rows = [
    scanRow({ id: "1", timestamp: T0, area: "cosmetics", workvivoPostedAt: 1, radio: { status: "announced" }, workvivoResponderName: "Pat", workvivoResponseTimeMs: 60000 }),
    scanRow({ id: "2", timestamp: T0 + 3600e3, area: "cosmetics", radio: { status: "no_clip" } }),
    scanRow({ id: "3", timestamp: T0, area: "electronics", workvivoPostedAt: 1, workvivoResponderName: "Pat", workvivoResponseTimeMs: 20000 }),
  ];
  const s = summarize(rows, utc);
  assert.equal(s.total, 3);
  assert.equal(s.posted, 2);
  assert.equal(s.announced, 1);
  assert.equal(s.answered, 2);
  assert.equal(s.medianResponseMs, 40000);
  assert.equal(s.heat[5][12], 2);   // Friday 12:00 UTC
  assert.equal(s.heat[5][13], 1);
  assert.equal(s.heatMax, 2);
  assert.deepEqual(s.areas.map((a) => [a.area, a.count, a.answered]), [["cosmetics", 2, 1], ["electronics", 1, 1]]);
  assert.deepEqual(s.responders, [{ name: "Pat", count: 2, medianMs: 40000 }]);
});

test("summarize on no scans", () => {
  const s = summarize([], utc);
  assert.equal(s.total, 0);
  assert.equal(s.medianResponseMs, null);
  assert.equal(s.heatMax, 0);
});

test("radioLabel", () => {
  assert.equal(radioLabel("blocked_hours"), "Blocked (store closed)");
  assert.equal(radioLabel(""), "—");
  assert.equal(radioLabel("weird"), "weird");
});
