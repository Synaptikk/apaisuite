// node --test modules/digitaldashboard/lib/tests/gif_metrics.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseClockMin, parseSlot, parseLastSeen, idleMinutes, dayPicked, boardDay,
  recordReading, expressSummary, completedSummary, sameName, pickersNow,
  breakWatch, trackGaps, clockText, gridSlotFor,
} from "../gif_metrics.js";

const at = (h, m = 0) => new Date(2026, 9, 3, h, m, 0);

test("clock and slot parsing", () => {
  assert.equal(parseClockMin("01:54pm"), 13 * 60 + 54);
  assert.equal(parseClockMin("12pm"), 12 * 60);
  assert.equal(parseClockMin("12am"), 0);
  assert.deepEqual(parseSlot("7pm - 8pm"), { start: 1140, end: 1200 });
  assert.deepEqual(parseSlot("11am - 12pm"), { start: 660, end: 720 });
  assert.equal(parseSlot("nonsense"), null);
});

test("last seen parses location and time", () => {
  assert.deepEqual(parseLastSeen("Last seen at A1-2-0013, 01:54pm"), { location: "A1-2-0013", min: 834 });
  assert.equal(parseLastSeen(null), null);
});

test("idle minutes; a future clock is null, not negative", () => {
  assert.equal(idleMinutes(834, at(14, 30)), 36);
  assert.equal(idleMinutes(900, at(14, 0)), null);
});

test("day picked sums open and closed slots", () => {
  const opd = { hours: [{ picked: 789 }, { picked: 7 }, { picked: null }], completed: [{ qtyPicked: 1224 }, { qtyPicked: 1447 }] };
  assert.equal(dayPicked(opd), 789 + 7 + 1224 + 1447);
  assert.equal(dayPicked({ hours: [], completed: [] }), null);
});

test("board day rolls at 5 AM, not midnight", () => {
  assert.equal(boardDay(at(4, 59)), "2026-10-02");
  assert.equal(boardDay(at(5, 0)), "2026-10-03");
});

test("express drop-ins: first reading counts what is left, later rises add", () => {
  let h = recordReading(null, { hours: [{ slot: "7pm - 8pm", expressQty: 163, expressOrders: 3, picked: 700, total: 866 }] }, at(19, 0));
  h = recordReading(h, { hours: [{ slot: "7pm - 8pm", expressQty: 150, expressOrders: 3, picked: 720, total: 866 }] }, at(19, 5));  // picked down
  h = recordReading(h, { hours: [{ slot: "7pm - 8pm", expressQty: 170, expressOrders: 5, picked: 730, total: 886 }] }, at(19, 10)); // +20 dropped in
  const r = h.express["7pm - 8pm"];
  assert.equal(r.droppedIn, 163 + 20);
  assert.equal(r.ordersSeen, 3 + 2);
  assert.equal(r.samples, 3);
});

test("series restarts when the running total drops, and on a new day", () => {
  let h = recordReading(null, { hours: [{ picked: 100 }] }, at(10));
  h = recordReading(h, { hours: [{ picked: 160 }] }, at(10, 30));
  assert.equal(h.series.length, 2);
  h = recordReading(h, { hours: [{ picked: 50 }] }, at(10, 40));
  assert.equal(h.series.length, 1);
  const next = recordReading(h, { hours: [{ picked: 5 }] }, new Date(2026, 9, 4, 6, 0));
  assert.equal(next.day, "2026-10-04");
  assert.equal(next.series.length, 1);
});

test("a read that missed closed-hour rows stays out of the running total", () => {
  const full = { hours: [{ picked: 100 }], completed: [{ qtyPicked: 1000 }, { qtyPicked: 1200 }] };
  let h = recordReading(null, full, at(10));
  h = recordReading(h, { hours: [{ picked: 150 }], completed: [{ qtyPicked: 1000 }] }, at(10, 10)); // scroll missed a row
  assert.equal(h.series.length, 1);
  assert.equal(h.skipped, 1);
  h = recordReading(h, { hours: [{ picked: 160 }], completed: full.completed }, at(10, 20));
  assert.deepEqual(h.series.map((s) => s[1]), [2300, 2360]);
});

test("express average uses only slots whose hour has ended", () => {
  let h = recordReading(null, { hours: [{ slot: "6pm - 7pm", expressQty: 120, expressOrders: 4 }, { slot: "7pm - 8pm", expressQty: 90, expressOrders: 2 }] }, at(18, 30));
  const s = expressSummary(h, at(19, 20));
  assert.equal(s.closedCount, 1);
  assert.equal(s.avgItemsPerHour, 120);
  assert.equal(s.slots.find((x) => x.slot === "7pm - 8pm").final, false);
});

test("completed summary averages GIF's own closed-hour figures", () => {
  const s = completedSummary({ completed: [{ slot: "7am - 8am", qtyPicked: 1000 }, { slot: "8am - 9am", qtyPicked: 2000 }] });
  assert.equal(s.avgPerHour, 1500);
  assert.equal(s.peak.slot, "8am - 9am");
});

test("names match across middle names and case", () => {
  assert.ok(sameName("Pat Q. Example", "pat example"));
  assert.ok(!sameName("Pat Example", "Sam Example"));
});

test("pickers now reads the current grid slot and skips planned breaks", () => {
  const roster = [
    { name: "Avery Sample", slots: { 9: "PICK" } },      // 2–3 PM
    { name: "Blake Sample", slots: { 9: "L" } },
    { name: "Casey Sample", slots: { 9: "PICK" }, status: "absent" },
  ];
  assert.equal(gridSlotFor(at(14, 10)), 9);
  assert.deepEqual(pickersNow(roster, at(14, 10)), ["Avery Sample"]);
  assert.deepEqual(pickersNow(roster, at(3, 0)), []);
});

test("break watch: scheduled ∩ not active, flagged past the limit", () => {
  const w = breakWatch({
    scheduled: ["Avery Sample", "Dana Sample"],
    notActive: ["Avery Sample", "Erin Sample"],
    details: { "Avery Sample": { lastSeen: "Last seen at A1-2-0013, 01:54pm" } },
    now: at(14, 20),
  });
  assert.equal(w.suspects.length, 1);
  assert.equal(w.suspects[0].idleMin, 26);
  assert.equal(w.suspects[0].over, true);
});

test("gaps open when flagged and close when they are picking again", () => {
  const flagged = { suspects: [{ name: "Avery Sample", over: true, lastSeen: 834, location: "A1" }] };
  let g = trackGaps(null, flagged, at(14, 20));
  assert.equal(g["Avery Sample"].closedAt, null);
  g = trackGaps(g, { suspects: [] }, at(14, 35));
  assert.equal(g["Avery Sample"].outMin, 41);
});

test("clock text", () => {
  assert.equal(clockText(834), "1:54 PM");
  assert.equal(clockText(0), "12:00 AM");
});
