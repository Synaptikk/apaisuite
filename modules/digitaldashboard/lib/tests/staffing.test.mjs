// node --test modules/digitaldashboard/lib/tests/staffing.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  pickersByHour, dueItems, staffingPlan, staffingLine, staffingText, hourLabel, hourRange,
  slotPace, paceLine, clockLabel, expressStillExpected, activePickers, outputPickers,
} from "../staffing.js";

const at = (h, m = 0) => new Date(2026, 9, 9, h, m, 0);
// grid slot k = hour 5+k; 17 cells
const row = (name, hours, status = "present") => {
  const slots = Array(17).fill("");
  for (const h of hours) slots[h - 5] = "PICK";
  return { name, status, slots };
};
const crew = (n, hours, tag = "P") => Array.from({ length: n }, (_, i) => row(`${tag}${i}`, hours));

test("pickers per hour come from PICK cells; absent rows are skipped; object-shaped slots work", () => {
  const roster = [row("A", [10, 11]), row("B", [11]), row("C", [10, 11], "absent"), { name: "D", slots: ["LUNCH"] },
    { name: "E", slots: { 5: "PICK" } }];
  assert.deepEqual(pickersByHour(roster), { 10: 2, 11: 2 });
});

test("due items: due 30 min before the slot, workable from 2 h before; started = items picked", () => {
  const items = dueItems({
    open: [{ slot: "12pm - 1pm", total: 1600, picked: 600 }, { slot: "11am - 12pm", left: 20 }],
    upcoming: [{ slot: "1pm - 2pm", qty: 1400 }, { slot: "2pm - 3pm", qty: 0 }],
  });
  assert.deepEqual(items.map((i) => [i.slot, i.qty, i.by, i.from, !!i.started]),
    [["11am - 12pm", 20, 630, 540, false], ["12pm - 1pm", 1000, 690, 600, true], ["1pm - 2pm", 1400, 750, 660, false]]);
});

// 1:56pm, 27 picking at 88/hr — the shape of the 2026-10-09 afternoon
const afternoon = (extra = {}) => staffingPlan({
  open: [{ slot: "2pm - 3pm", picked: 2029, total: 2079 }, { slot: "3pm - 4pm", picked: 1235, total: 1765 },
    { slot: "4pm - 5pm", picked: 24, total: 2000 }],
  upcoming: [{ slot: "5pm - 6pm", qty: 2014 }, { slot: "6pm - 7pm", qty: 1476 }],
  roster: [...crew(18, [13, 14]), ...crew(21, [15], "Q"), ...crew(16, [16], "R")],
  rate: 88, pickingNow: 27, now: at(13, 56), ...extra,
});

test("live pickers count only for the orders being picked now", () => {
  const plan = afternoon();
  const [past, cur] = plan.rows;
  assert.equal(past.kind, "past");
  assert.equal(past.add, 0);
  assert.equal(cur.kind, "now");
  assert.equal(cur.slots[0], "3pm - 4pm");
  assert.equal(cur.have, 27);               // GIF "Picking"
  assert.equal(cur.minutes, 34);            // to 2:30
  assert.equal(cur.needed, 11);             // 530 / (88 × 34/60)
  assert.equal(cur.add, 0);
});

test("next hour borrows only the live pickers the current hour doesn't need — and only once it's started", () => {
  const next = afternoon().rows[2];
  assert.equal(next.kind, "next");
  assert.equal(next.started, true);
  assert.equal(next.have, 16);              // 27 picking − 11 needed on 3pm orders
  assert.equal(next.minutes, 90);           // 2:00 – 3:30
  assert.equal(next.needed, 15);
  // not started (nothing picked, window not open yet) → it's just a scheduled hour
  const cold = staffingPlan({ open: [{ slot: "3pm - 4pm", left: 530 }, { slot: "4pm - 5pm", picked: 0, total: 2000 }],
    roster: crew(18, [13, 14]), rate: 88, pickingNow: 27, now: at(13, 56) });
  assert.equal(cold.rows[1].kind, "later");
  assert.equal(cold.rows[1].basis, "scheduled");
});

test("2+ hours out: scheduled pickers for the hour they're picked in vs one hour of picking", () => {
  const plan = afternoon();
  const five = plan.rows.find((r) => r.slots[0] === "5pm - 6pm");
  assert.equal(five.kind, "later");
  assert.equal(five.pickHour, 15);          // 5pm orders are picked 3–4pm
  assert.equal(five.scheduled, 21);
  assert.equal(five.needed, 23);            // 2,014 / 88
  assert.equal(five.add, 2);
  assert.equal(plan.verdict, "short");
  assert.match(staffingLine(plan), /5pm orders: add 2 \(21 scheduled 3pm-4pm, need 23\)/);
});

test("chat text: '-' lines, ⚠️ only on at-risk hours, no other emoji", () => {
  const text = staffingText(afternoon(), at(13, 56));
  const lines = text.split("\n");
  assert.equal(lines[0], "Staffing @ 1:56pm - 6,046 left - 88/hr per picker");
  assert.equal(lines[1], "⚠️ 2pm orders - past due - 50 left");
  assert.equal(lines[2], "- 3pm orders - due 2:30 - 530 left - scheduled 18 (active 27), need 11 - covered");
  assert.equal(lines[3], "- 4pm orders - due 3:30 (started) - 1,976 left - scheduled 18 (active 16), need 15 - covered");
  assert.equal(lines[4], "⚠️ 5pm orders - 2,014 left - scheduled 21, need 23 - add 2");
  assert.doesNotMatch(text, /[✅⏳🔴📋]/u);
});

test("live pace falling behind flags the current orders", () => {
  const plan = afternoon();
  const pace = slotPace({ open: [{ slot: "3pm - 4pm", left: 530 }], rate: 600, perPicker: 88, now: at(13, 56) });
  assert.match(staffingText(plan, at(13, 56), pace), /⚠️ 3pm orders - due 2:30 - 530 left - scheduled 18 \(active 27\), need 11 - behind: picking 600\/hr, need 935\/hr - get \d+ more now$/m);
});

test("under 10 minutes to the due time a gap is 'a few min late', not an add", () => {
  const plan = staffingPlan({ open: [{ slot: "3pm - 4pm", left: 400 }], roster: crew(5, [14]), rate: 90, pickingNow: 5, now: at(14, 25) });
  assert.equal(plan.rows[0].add, 0);
  assert.equal(plan.rows[0].late, true);
  assert.match(staffingText(plan, at(14, 25)), /^⚠️ 3pm orders .* - a few min late$/m);
});

test("express still to drop: until :15 past the hour, due by the next hour", () => {
  assert.equal(expressStillExpected(10, 10 * 60 + 5, 120), 20);
  assert.equal(expressStillExpected(10, 10 * 60 + 20, 120), 0);
  assert.equal(expressStillExpected(11, 10 * 60 + 20, 120), 110);
  assert.equal(expressStillExpected(12, 10 * 60 + 20, 120), 120);
  assert.equal(expressStillExpected(12, 600, null), 0);
  // a later hour carries its express on top of its orders
  const plan = staffingPlan({ open: [{ slot: "12pm - 1pm", left: 10 }], upcoming: [{ slot: "3pm - 4pm", qty: 880 }],
    roster: crew(10, [10, 11, 12, 13]), rate: 88, pickingNow: 10, expressPerHour: 88, now: at(10, 20) });
  const three = plan.rows.find((r) => r.slots[0] === "3pm - 4pm");
  assert.equal(three.expressExpected, 88);
  assert.equal(three.needed, 11);           // (880 + 88) / 88
});

test("GIF's live rate is used as-is; only the default rate is discounted; no board flagged", () => {
  const live = staffingPlan({ open: [{ slot: "12pm - 1pm", left: 50 }], roster: crew(2, [10, 11]), rate: 95.42, now: at(10, 30) });
  assert.equal(live.util, 1);
  const fallback = staffingPlan({ open: [{ slot: "12pm - 1pm", left: 50 }], roster: crew(2, [10, 11]), now: at(10, 30) });
  assert.equal(fallback.util, 0.85);
  const none = staffingPlan({ open: [{ slot: "12pm - 1pm", left: 50 }], roster: [], now: at(10) });
  assert.equal(none.noGrid, true);
  assert.match(staffingLine(none), /no pickers on today's board/);
  assert.equal(staffingPlan({ open: [], now: at(10) }), null);
  assert.equal(hourLabel(13), "1pm");
});

test("live pace: 12pm orders due 11:30 — on track vs. short with pickers to add", () => {
  const open = [{ slot: "12pm - 1pm", left: 329 }, { slot: "1pm - 2pm", left: 1679 }];
  let rows = slotPace({ open, rate: 1411, perPicker: 80, now: at(11, 9) });
  assert.equal(rows[0].due, "11:30am");
  assert.equal(rows[0].minutesLeft, 21);
  assert.equal(rows[0].needPerHour, 940);
  assert.equal(rows[0].status, "on track");
  assert.match(paceLine(rows[0]), /12pm-1pm \(due 11:30am\): 329 left in 21 min — need 940\/hr, picking 1,411\/hr · on track/);
  assert.equal(rows[1].cumLeft, 2008);
  assert.equal(rows[1].status, "short");
  rows = slotPace({ open: [{ slot: "11am - 12pm", left: 40 }], rate: 1000, now: at(10, 45) });
  assert.equal(rows[0].status, "late");
  assert.equal(clockLabel(690), "11:30am");
});

test("live pace for a slot not open yet is measured over its own window", () => {
  const p = slotPace({ open: [{ slot: "3pm - 4pm", left: 1800 }], rate: 1000, perPicker: 100, now: at(12) });
  assert.equal(p[0].opensAt, "1:00pm");
  assert.equal(p[0].minutesLeft, 90);
  assert.equal(p[0].status, "short");
  assert.match(paceLine(p[0]), /opens 1:00pm, 1,800 to pick in 90 min .* get 2 more picking at 1:00pm/);
});

test("under 10 minutes to go, a pace gap is 'finishing late', not 'add pickers'", () => {
  const rows = slotPace({ open: [{ slot: "12pm - 1pm", left: 97 }], rate: 1158, perPicker: 95, now: at(11, 27) });
  assert.equal(rows[0].status, "tight");
  assert.equal(rows[0].add, 0);
  assert.match(paceLine(rows[0]), /will finish a few minutes late/);
});

test("active = GIF picking + scheduled pickers between walks (not active < 10 min) from a fresh watch", () => {
  const watch = { checkedAt: at(14, 10).toISOString(), suspects: [
    { name: "A", idleMin: 3 }, { name: "B", idleMin: 8 }, { name: "C", idleMin: 25, over: true }, { name: "D", idleMin: null }] };
  // 2 min after the watch ran: A is 5 min idle, B 10 → only A is still between walks
  const a = activePickers({ picking: 20, watch, now: at(14, 12) });
  assert.deepEqual(a, { picking: 20, betweenWalks: 1, active: 21, names: ["A"] });
  assert.equal(activePickers({ picking: 20, watch, now: at(14, 10) }).betweenWalks, 2);
  assert.equal(activePickers({ picking: 20, watch, now: at(14, 30) }).betweenWalks, 0);   // stale watch: picking only
  assert.equal(activePickers({ picking: null, watch }), null);
  assert.equal(outputPickers(2088, 87), 24);
  assert.equal(outputPickers(null, 87), null);
  const plan = afternoon({ pickingNow: 27, active: { picking: 23, betweenWalks: 4, active: 27, names: [] }, output: 24 });
  assert.match(staffingText(plan, at(13, 56)).split("\n")[0], / - active 27 \(23 picking \+ 4 between walks\) - output ~24$/);
});

test("per-hour pickers from GIF's hour detail (walk cards) replace the split estimate", () => {
  const w = (n) => Array.from({ length: n }, (_, i) => `W${i}`);
  const plan = staffingPlan({
    open: [{ slot: "3pm - 4pm", picked: 1693, total: 1759, walkers: w(6) }, { slot: "4pm - 5pm", picked: 382, total: 2031, walkers: w(20) },
      { slot: "5pm - 6pm", picked: 0, total: 2045, walkers: [] }],
    roster: crew(18, [14, 15]), rate: 87, pickingNow: 25,
    active: { picking: 25, betweenWalks: 1, active: 26, names: [] }, now: at(14, 25),
  });
  const [three, four, five] = plan.rows;
  assert.equal(three.have, 7);              // 6 walking 3pm + 1 between walks
  assert.equal(four.kind, "next");
  assert.equal(four.have, 20);              // the 20 with a 4pm walk
  assert.equal(five.kind, "later");         // nobody on 5pm yet → scheduled
  assert.match(staffingText(plan, at(14, 25)), /4pm orders - due 3:30 \(started\) - 1,649 left - scheduled 18 \(active 20\)/);
});

test("!staffing lists the board's pickers for every hour, even with nothing dropped", () => {
  const P = (k) => Object.fromEntries(k.map((i) => [String(i), "PICK"]));
  const roster = [{ name: "A", slots: P([9, 10]) }, { name: "B", slots: P([9]) }, { name: "C", slots: P([12]) }, { name: "D", slots: P([9]), status: "absent" }];
  const out = staffingText(null, new Date(2026, 9, 10, 7, 0), [], roster).split("\n");
  // 9 = 2pm, 10 = 3pm, 11 = 4pm (nobody), 12 = 5pm
  assert.deepEqual(out.slice(-4), ["- 2-3pm: 2 pickers", "- 3-4pm: 1 picker", "- 4-5pm: 0 pickers", "- 5-6pm: 1 picker"]);
  assert.equal(hourRange(11), "11am-12pm");
});
