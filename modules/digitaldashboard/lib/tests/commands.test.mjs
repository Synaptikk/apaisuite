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

test("same question from two people in one poll → one group naming both", async () => {
  const { groupCommands } = await import("../commands.js");
  const { groups, duplicates } = groupCommands([
    { text: "!pph", senderName: "Shane Smith" },
    { text: "!PPH ", senderName: "Jane Doe" },
    { text: "!store", senderName: "Jane Doe" },
    { text: "!pph", senderName: "Shane Smith" },
    { text: "hello", senderName: "Bob" },
  ], {}, 1000);
  assert.deepEqual(groups.map((g) => [g.cmd, g.askers]), [["pph", ["Shane Smith", "Jane Doe"]], ["store", ["Jane Doe"]]]);
  assert.equal(duplicates.length, 0);
});

test("a question answered in this chat under a minute ago gets no second reply", async () => {
  const { groupCommands, DEDUPE_MS } = await import("../commands.js");
  const recent = { "!pph": 100_000 };
  let r = groupCommands([{ text: "!pph", senderName: "Jane Doe" }], recent, 100_000 + DEDUPE_MS - 1);
  assert.equal(r.groups.length, 0);
  assert.deepEqual(r.duplicates, [{ key: "!pph", askers: ["Jane Doe"] }]);
  r = groupCommands([{ text: "!pph", senderName: "Jane Doe" }], recent, 100_000 + DEDUPE_MS);
  assert.equal(r.groups.length, 1);
});

test("!store lists everyone with 50+ picks in full, the rest up to the cap", async () => {
  const { formatStore } = await import("../commands.js");
  const rows = [...Array.from({ length: 8 }, (_, i) => ({ name: `Big${i}`, picks: 50 + i, status: "notactive" })),
    ...Array.from({ length: 8 }, (_, i) => ({ name: `Small${i}`, picks: 10 + i, status: "notactive" }))];
  const text = formatStore({ rows, totals: { associates: 16 } }, new Date(2026, 9, 9, 14), { max: 5 });
  for (let i = 0; i < 8; i++) assert.match(text, new RegExp(`• Big${i}: ${50 + i}`));
  assert.doesNotMatch(text, /Small/);
  assert.match(text, /…and 8 more under 50 picks/);
});

test("!performance: every board picker under 75% of their elapsed PICK time spent picking", async () => {
  const { formatPerformance, parseCommand } = await import("../commands.js");
  assert.equal(parseCommand("!performance"), "performance");
  const t = (h, m) => new Date(2026, 9, 9, h, m).getTime();
  const pick8 = { 2: "PICK", 3: "PICK", 4: "PICK", 5: "L", 6: "PICK", 7: "PICK", 8: "PICK", 9: "PICK", 10: "PICK" };   // 7am-4pm, lunch 10
  const board = [
    { name: "JAYLA HUDGINS", slots: pick8, shiftLabel: "7:00am-4:00pm" },
    { name: "GOOD PICKER", slots: pick8 },
    { name: "MID SHIFT", slots: pick8 },
    { name: "UNREAD PERSON", slots: pick8 },
    { name: "SHORT DAY", slots: { 2: "PICK", 3: "PICK", 4: "PICK", 5: "PICK" } },   // 4-hour block, 7-11am
    { name: "NOT PICKING", slots: { 2: "STOCK", 3: "STOCK" } },                      // no PICK hours: ignored
    { name: "ABSENT ONE", slots: pick8, status: "absent" },
    { name: "NO SHOW", slots: pick8, shiftLabel: "7:00am-4:00pm" },          // never in GIF, not on leaderboard
    { name: "CALLED OFF", slots: pick8, shiftLabel: "7:00am-4:00pm" },       // IVR absence
    { name: "EARLY BIRD", slots: pick8 },                                     // gone before tracking, but on the leaderboard
  ];
  const rows = [
    { name: "Jayla Hudgins", picks: 175, rate: 33.63, walks: 21, checkedAt: t(16, 51), status: "offclock" },  // 5h12m of 8h
    { name: "Good Picker", picks: 700, rate: 100, walks: 20, checkedAt: t(16, 30), status: "offclock" },      // 7h of 8h
    { name: "Mid Shift", picks: 150, rate: 100, walks: 5, checkedAt: t(10, 0), status: "notactive" },        // 1h30 of 3h = 50%
    { name: "Unread Person", picks: null },
    { name: "Short Day", picks: 200, rate: 100, checkedAt: t(16, 0), status: "offclock" },   // 2h of 4h = 50%
  ];
  const leaderboard = { at: t(16, 0), rows: [{ rank: 1, name: "Early Bird", rate: 80 }] };
  const absences = { rows: [{ name: "Called Off", type: "Absence" }] };
  const walkMix = { "Jayla Hudgins": { walks: 3, items: 20, sections: { Oversized: 2, Ambient: 1 } } };
  const lines = formatPerformance({ rows, leaderboard, absences, walkMix }, board, new Date(2026, 9, 9, 17, 0)).split("\n\n");   // blank line between entries
  assert.ok(lines.every((l) => !l.includes("\n")));
  assert.equal(lines[0], "Performance @ 5:00 PM - pickers under 75% of their scheduled pick time picking");
  assert.equal(lines[1], "- Mid Shift: 50% - 1h 30m picking of 3h 00m scheduled - 150 picks @ 100/hr - 5 walks (avg 18m) - as of 10:00 AM");
  assert.equal(lines[2], "- Short Day: 50% - 2h 00m picking of 4h 00m scheduled - 200 picks @ 100/hr - gone for the day");
  assert.equal(lines[3], "- Jayla Hudgins: 65% - 5h 12m picking of 8h 00m scheduled - 175 picks @ 34/hr - 21 walks (avg 15m) - gone for the day - walks seen: Oversized 2, Ambient 1");
  assert.equal(lines[4], "- Called out (IVR): Called Off (7:00am-4:00pm)");
  assert.equal(lines[5], "- Not in GIF today, no call-in: No Show (7:00am-4:00pm)");
  assert.match(lines[6], /^\(8 scheduled to pick: 1 at 75%\+, 2 not read yet, 1 called out, 1 not in GIF, 1 marked absent\./);
  assert.equal(lines.length, 7);
});

test("!pph with no reading from today says so instead of showing yesterday", () => {
  assert.equal(formatPph({ asOf: null, dayPicked: null, pph: null, completed: null }), "Store 1458 picks: no GIF reading yet today.");
});
