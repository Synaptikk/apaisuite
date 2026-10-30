import { test } from "node:test";
import assert from "node:assert/strict";
import { boardWindows, orderHours, simulate, forecast, forecastText, boardByHour } from "../capacity_sim.js";

const at = (h, m = 0) => new Date(2026, 9, 25, h, m);
// board rows use hour index keys: 0 = 5am
const row = (name, cells) => ({ name, status: null, slots: Object.fromEntries(Object.entries(cells).map(([h, c]) => [String(h - 5), c])) });
const pickers = (n, cells) => Array.from({ length: n }, (_, i) => row(`Picker ${i}`, cells));
const allDay = (from, to, lunchAt = null) => Object.fromEntries(Array.from({ length: to - from }, (_, i) => [from + i, from + i === lunchAt ? "L" : "PICK"]));

test("boardWindows: PICK hours merged, lunch hour off, breaks 2h in and 2h after lunch", () => {
  const w = boardWindows(row("A", allDay(8, 17, 12)));   // 8am-5pm, lunch 12-1
  assert.deepEqual(w.pick, [[480, 720], [780, 1020]]);
  assert.deepEqual(w.lunch, [720, 780]);
  assert.deepEqual(w.breaks, [600, 900]);                // 10:00 and 3:00
});

test("boardWindows: a 4-5 h shift gets one mid-shift break; '30' adds the first half hour", () => {
  const w = boardWindows(row("B", { 14: "PICK", 15: "PICK", 16: "PICK", 17: "PICK", 18: "30" }));
  assert.deepEqual(w.pick, [[840, 1110]]);
  assert.equal(w.breaks.length, 1);
});

test("orderHours: due 30 min before the slot, pickable from 2 h before", () => {
  const [h] = orderHours({ upcoming: [{ slot: "7pm - 8pm", qty: 1444 }], nowMin: 900 });
  assert.equal(h.due, 18 * 60 + 30);
  assert.equal(h.from, 17 * 60);   // 7pm orders are picked from 5pm: the 5-6pm board picks them
});

test("future orders can't be started before their window opens", () => {
  const r = simulate({ upcoming: [{ slot: "7pm - 8pm", qty: 300 }], roster: pickers(10, allDay(14, 20)), storeRate: 100, now: at(14) });
  const h = r.hours[0];
  assert.ok(h.doneAt >= 17 * 60, `done ${h.doneAt} before the 5pm window`);
  assert.equal(h.late, false);
});

test("enough pickers: covered and done before due", () => {
  const r = simulate({ open: [{ slot: "4pm - 5pm", left: 600 }], roster: pickers(10, allDay(13, 17)), storeRate: 100, now: at(14) });
  assert.equal(r.hours[0].late, false);
  assert.ok(r.hours[0].doneAt < 15 * 60 + 30);
});

test("lunch hour takes pickers out: late, and forecast finds how many to add", () => {
  const roster = pickers(6, allDay(13, 18, 14));        // everyone at lunch 2-3pm
  const input = { open: [{ slot: "4pm - 5pm", left: 900 }], roster, storeRate: 90, now: at(14) };
  const fc = forecast(input);
  const h = fc.base.hours[0];
  assert.equal(h.late, true);
  const add = fc.adds.find((a) => a.slot === "4pm - 5pm");
  assert.ok(add.n > 0, "should ask for pickers");
  assert.equal(fc.final.hours[0].late, false, "the adds fix it");
  assert.equal(add.to, 15 * 60 + 30);
});

test("walks in progress: their items finish first, at that picker's own rate", () => {
  const r = simulate({ open: [{ slot: "3pm - 4pm", left: 40, walks: [{ name: "Fast Picker", qty: 40 }] }],
    roster: [], leaderboard: [{ name: "Fast Picker", rate: 160 }], storeRate: 90, now: at(14) });
  assert.equal(Math.round(r.hours[0].doneAt), 14 * 60 + 15);   // 40 items at 160/hr = 15 min
});

test("someone idle 20 min is treated as on lunch and isn't counted for the next 40 min", () => {
  const roster = [row("On Lunch", allDay(13, 18))];
  const r = simulate({ open: [{ slot: "4pm - 5pm", left: 30 }], roster, watch: { suspects: [{ name: "On Lunch", idleMin: 20 }] }, storeRate: 120, now: at(14) });
  assert.ok(r.hours[0].doneAt >= 14 * 60 + 40);
});

test("boardByHour and the text map each pick hour to the orders 2 h later (5-6pm -> 7pm orders)", () => {
  const roster = pickers(18, allDay(17, 18)).concat(pickers(8, allDay(19, 20)));
  const by = boardByHour(roster, 17, 19);
  assert.equal(by.find((b) => b.hour === 17).board, 18);
  const fc = forecast({ upcoming: [{ slot: "7pm - 8pm", qty: 1444 }], roster, storeRate: 95, now: at(16, 50) });
  const text = forecastText(fc, { roster });
  assert.match(text, /- 5-6pm: 18 on board, ~\d+ picking after breaks\/lunch -> 7pm orders/);
  assert.match(text, /7pm orders - opens 5:00, due 6:30 - 1,444/);
});

test("stale GIF reading is called out", () => {
  const fc = forecast({ open: [{ slot: "5pm - 6pm", left: 100 }], roster: pickers(3, allDay(15, 18)), storeRate: 90, now: at(16, 40) });
  assert.match(forecastText(fc, { readAt: at(12, 53) }), /GIF reading is 227 min old - the phone has likely stopped reading, so no forecast/);
  assert.match(forecastText(fc, { readAt: at(16, 20) }), /GIF reading is 20 min old/);   // 15-30 min: forecast with a warning
});

test("no board: the people picking now carry the next 2 h; later hours are flagged, not forecast", () => {
  const fc = forecast({ open: [{ slot: "4pm - 5pm", left: 400, walks: [{ name: "A B", qty: 30 }] }], upcoming: [{ slot: "8pm - 9pm", qty: 500 }],
    roster: [], storeRate: 100, activeNow: 6, now: at(14) });
  assert.equal(fc.base.noBoard, true);
  assert.equal(fc.base.people, 6);                       // 1 on a walk card + 5 more GIF shows picking
  assert.equal(fc.base.hours[0].late, false);
  const text = forecastText(fc, { roster: [] });
  assert.match(text, /^No planning board: assuming the 6 people picking now keep going until ~4:00pm/m);
  assert.match(text, /8pm orders - opens 6:00, due 7:30 - 500 - picked after ~4:00: depends on who's scheduled then/);
  assert.doesNotMatch(text, /Who picks which orders/);
});

test("no board and too few pickers: asks for adds within the horizon", () => {
  const fc = forecast({ open: [{ slot: "3pm - 4pm", left: 900 }], roster: [], storeRate: 90, activeNow: 3, now: at(14) });
  assert.ok(fc.adds[0]?.n > 0);
});
