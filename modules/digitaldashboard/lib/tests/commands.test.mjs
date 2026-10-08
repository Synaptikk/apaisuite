// node --test modules/digitaldashboard/lib/tests/commands.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { parseCommand, formatPph, formatBreaks, formatExpress, formatHelp } from "../commands.js";

const now = new Date(2026, 9, 3, 19, 32);

test("commands need a leading ! and match their aliases", () => {
  assert.equal(parseCommand("!pph"), "pph");
  assert.equal(parseCommand("  !Picks per hour "), "pph");
  assert.equal(parseCommand("!breaks"), "breaks");
  assert.equal(parseCommand("!express"), "express");
  assert.equal(parseCommand("!HELP"), "help");
  assert.equal(parseCommand("!nope"), "unknown");
  assert.equal(parseCommand("what is our pph"), null);
  assert.equal(parseCommand(""), null);
});

test("pph reply: full hour vs scaled pace", () => {
  const s = { dayPicked: 19984, pph: { perHour: 1640, full: true, spanMin: 60 }, completed: { avgPerHour: 1561, hours: 12, peak: { slot: "2pm - 3pm", qtyPicked: 2313 } } };
  assert.equal(formatPph(s, now), "Store 1458 picks @ 7:32 PM · last hour 1,640/hr · today avg 1,561/hr over 12 closed hours · peak 2pm - 3pm 2,313 · 19,984 picked");
  const partial = { ...s, pph: { perHour: 1500, full: false, spanMin: 20 } };
  assert.match(formatPph(partial, now), /1,500\/hr pace \(last 20 min\)/);
});

test("breaks reply names only people over the limit", () => {
  const w = { limitMin: 18, scheduledCount: 3, suspects: [
    { name: "Avery Sample", lastSeen: 834, location: "A1-2-0013", idleMin: 40, over: true },
    { name: "Blake Sample", lastSeen: 1150, location: "B2", idleMin: 6, over: false },
  ] };
  const txt = formatBreaks(w, now);
  assert.match(txt, /Avery Sample — last pick 1:54 PM at A1-2-0013 \(40 min\)/);
  assert.doesNotMatch(txt, /Blake/);
  assert.match(formatBreaks({ limitMin: 18, scheduledCount: 3, suspects: [] }, now), /All 3 scheduled pickers are within 18 min/);
  assert.match(formatBreaks({ limitMin: 18, scheduledCount: 0, suspects: [] }, now), /No one is on the grid/);
});

test("express reply marks open slots and averages closed ones", () => {
  const s = { express: { closedCount: 1, avgItemsPerHour: 120, avgOrdersPerHour: 4, slots: [
    { slot: "6pm - 7pm", final: true, items: 120, orders: 4, remaining: 0 },
    { slot: "7pm - 8pm", final: false, items: 90, orders: 2, remaining: 30 },
  ] } };
  const t = formatExpress(s, now);
  assert.match(t, /6pm - 7pm: ≥120 items \/ ≥4 orders\n/);
  assert.match(t, /7pm - 8pm: ≥90 items \/ ≥2 orders · 30 left · open/);
  assert.match(t, /Avg per closed hour: 120 items \/ 4 orders \(1 hr\)/);
});

test("help lists the commands", () => {
  assert.match(formatHelp(), /!pph/);
});

import { formatStore } from "../commands.js";
test("store command parses and formats roster with help split", () => {
  assert.equal(parseCommand("!store"), "store");
  assert.equal(parseCommand("!store help"), "store");
  const s = {
    storeTotal: 500,
    totals: { associates: 3, storeHelpAssociates: 1, storeHelpPicks: 40, storeHelpPending: 0, digitalPicks: 460 },
    rows: [
      { name: "Blake Sample", code: "Digital", status: "picking", picks: 300 },
      { name: "Avery Sample", code: "Digital", status: "notactive", picks: 160 },
      { name: "Groccer Helper", code: "Store Help", status: "picking", picks: 40 },
    ],
  };
  const out = formatStore(s, new Date(2026, 9, 3, 19, 32));
  assert.match(out, /3 associates today/);
  assert.match(out, /Store total: 500 picks/);
  assert.match(out, /Store help: 1 assoc · 40 picks/);
  assert.match(out, /Digital: 460 picks/);
  assert.match(out, /Blake Sample: 300 ▸/);
  assert.match(out, /Grocer Helper|Groccer Helper \(Store Help\): 40 ▸/);
});
