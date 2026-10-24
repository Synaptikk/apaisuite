// node --test modules/safetyobs/lib/tests/coach_check.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { checkCoaches, buildMessage, isCheckedTitle, mergeTodayCounts } from "../coach_check.js";

// Made-up names; titles and shift shapes copied from a real store day.
const schedule = [
  { name: "ALEX BAKER", jobName: "GM Coach", shiftStart: "7:00am", shiftEnd: "5:00pm" },
  { name: "JORDAN LEE", jobName: "Digital Coach", shiftStart: "12:00pm", shiftEnd: "10:00pm" },
  { name: "CASEY MORGAN", jobName: "ACC Coach", shiftStart: "9:00pm", shiftEnd: "7:00am" },
  { name: "RILEY BROOKS", jobName: "Vision Center Mgr Hrly", shiftStart: "8:30am", shiftEnd: "5:00pm" },
  { name: "DANA FOX", jobName: "Frontend Coach", shiftStart: "12:00pm", shiftEnd: "10:00pm" },
  { name: "MORGAN HALE", jobName: "Food and Consumables Coach", shiftStart: "7:00am", shiftEnd: "5:00pm" },
  { name: "SAM CARTER", jobName: "AP Operations Coach", shiftStart: "8:00am", shiftEnd: "6:00pm" },
  { name: "TAYLOR REED", jobName: "Store Manager - Supercenter", shiftStart: "7:00am", shiftEnd: "5:00pm" },
  { name: "JAMIE PRICE", jobName: "Stocking ON TA", shiftStart: "10:00pm", shiftEnd: "7:00am" },
];
const members = [
  { userId: "1000000001", nickname: "ALEX BAKER" },
  { userId: "1000000002", nickname: "Jordan Lee" },
  { userId: "1000000003", nickname: "Dana Fox" },
  { userId: "1000000004", nickname: "Morgan Hale" },
  { userId: "1000000005", nickname: "Sam Carter" },
  { userId: "1000000006", nickname: "Taylor Reed" },
];

test("titles", () => {
  for (const t of ["GM Coach", "AP Operations Coach", "Store Manager - Supercenter", "Ops Manager"]) assert.ok(isCheckedTitle(t), t);
  for (const t of ["Vision Center Mgr Hrly", "People Lead", "Digital TL", "AP Operations TA"]) assert.ok(!isCheckedTitle(t), t);
});

test("who is behind at 4:45", () => {
  const r = checkCoaches({
    schedule, members,
    observations: [{ name: "Dana Fox", count: 2 }, { name: "Taylor Reed", count: 1 }, { name: "Sam Carter", count: 1 }, { name: "Sam Carter", count: 1 }],
  });
  assert.deepEqual(r.checked.map((c) => c.name).sort(),
    ["Alex Baker", "Dana Fox", "Jordan Lee", "Morgan Hale", "Sam Carter", "Taylor Reed"]);
  assert.deepEqual(r.behind.map((c) => [c.name, c.count]),
    [["Alex Baker", 0], ["Jordan Lee", 0], ["Morgan Hale", 0], ["Taylor Reed", 1]]);
  assert.deepEqual(r.done.map((c) => c.name), ["Dana Fox", "Sam Carter"]);
});

test("message @mentions in Workvivo's format", () => {
  const { behind } = checkCoaches({ schedule, members, observations: [{ name: "Taylor Reed", count: 1 }] });
  const m = buildMessage(behind.filter((c) => c.name === "Taylor Reed" || c.name === "Alex Baker"));
  assert.match(m.text, /@\[ALEX BAKER\]\(person:1000000001\): 0 of 2/);
  assert.match(m.text, /@\[Taylor Reed\]\(person:1000000006\): 1 of 2/);
  assert.deepEqual(m.mentionedUserIds, ["1000000001", "1000000006"]);
});

test("not in the chat → plain name, no mention", () => {
  const { behind } = checkCoaches({ schedule: [schedule[0]], members: [], observations: [] });
  const m = buildMessage(behind);
  assert.match(m.text, /• Alex Baker: 0 of 2/);
  assert.deepEqual(m.mentionedUserIds, []);
});

test("nobody behind → no message", () => {
  assert.equal(buildMessage([]), null);
});

import { buildLedger } from "../coach_check.js";

test("ledger: 2 per scheduled day, foreign-roster days dropped", () => {
  const coach = (name, start = "7:00am") => ({ name, jobName: "GM Coach", shiftStart: start, shiftEnd: "5:00pm" });
  const days = [
    { dateIso: "2026-10-01", schedule: [coach("TAYLOR REED"), coach("DANA FOX")] },
    { dateIso: "2026-10-02", schedule: [coach("TAYLOR REED")] },
    { dateIso: "2026-10-03", schedule: [coach("SOMEONE ELSE"), { name: "X Y", jobName: "Cart Assoc", shiftStart: "7:00am" }] }, // other store
    { dateIso: "2026-10-04", schedule: [coach("TAYLOR REED"), coach("DANA FOX", "6:00pm")] },
  ];
  const observations = [
    { dateIso: "2026-10-01", name: "Taylor Reed", count: 3 },
    { dateIso: "2026-10-03", name: "Taylor Reed", count: 5 },   // excluded day: not counted
    { dateIso: "2026-10-04", name: "Dana Fox", count: 1 },
  ];
  const r = buildLedger({ days, observations, todayIso: "2026-10-04", nowMin: 10 * 60 });
  assert.deepEqual(r.excludedDays, ["2026-10-03"]);
  const by = Object.fromEntries(r.rows.map((x) => [x.name, x]));
  assert.equal(by["Taylor Reed"].scheduledDays, 3);
  assert.equal(by["Taylor Reed"].expected, 6);
  assert.equal(by["Taylor Reed"].done, 3);
  assert.equal(by["Taylor Reed"].behind, 3);
  // Dana's 6 PM shift today has not started at 10 AM: one scheduled day so far.
  assert.equal(by["Dana Fox"].scheduledDays, 1);
  assert.equal(by["Dana Fox"].done, 1);
  assert.equal(by["Dana Fox"].behind, 1);
  assert.equal(by["Someone Else"], undefined);
  // Day by day: Dana's unstarted shift today is not a scheduled day, but the
  // observation on it still shows (and counts toward Done).
  assert.deepEqual(by["Taylor Reed"].byDay.map((d) => [d.dateIso, d.scheduled, d.expected, d.done]), [
    ["2026-10-01", true, 2, 3], ["2026-10-02", true, 2, 0], ["2026-10-04", true, 2, 0],
  ]);
  assert.deepEqual(by["Dana Fox"].byDay.map((d) => [d.dateIso, d.scheduled, d.expected, d.done, d.shift]), [
    ["2026-10-01", true, 2, 0, "7:00am–5:00pm"], ["2026-10-04", false, 0, 1, ""],
  ]);
});

import { buildCatchUp, buildCatchUpMessage } from "../coach_check.js";

test("catch-up: complete = behind through yesterday + today's 2", () => {
  const ledgerRows = [
    { name: "Alex Baker", behind: 2 },
    { name: "Jordan Lee", behind: 4 },
    { name: "Dana Fox", behind: 0 },
    { name: "Off Today", behind: 10 },
  ];
  const r = buildCatchUp({ ledgerRows, schedule, members });
  // Every leader on today, whatever the shift time (the post goes out in the
  // morning); the overnight ACC coach has no ledger row yet → 0 behind.
  assert.deepEqual(r.rows.map((c) => [c.name, c.behind, c.owe]), [
    ["Jordan Lee", 4, 6], ["Alex Baker", 2, 4],
    ["Casey Morgan", 0, 2], ["Dana Fox", 0, 2], ["Morgan Hale", 0, 2], ["Sam Carter", 0, 2], ["Taylor Reed", 0, 2],
  ]);
  assert.deepEqual(r.behind.map((c) => c.name), ["Jordan Lee", "Alex Baker"]);

  const m = buildCatchUpMessage(r.behind, { throughLabel: "Wed 10/7", sinceLabel: "8/22" });
  assert.match(m.text, /counted through Wed 10\/7/);
  assert.match(m.text, /@\[ALEX BAKER\]\(person:1000000001\): complete 4 today \(2 behind \+ today's 2\)/);
  assert.match(m.text, /@\[Jordan Lee\]\(person:1000000002\): complete 6 today/);
  assert.deepEqual(m.mentionedUserIds, ["1000000002", "1000000001"]);
});

test("catch-up: nobody on today behind → no message", () => {
  const r = buildCatchUp({ ledgerRows: [{ name: "Alex Baker", behind: 0 }], schedule: [schedule[0]], members });
  assert.equal(buildCatchUpMessage(r.behind, { throughLabel: "x", sinceLabel: "y" }), null);
});

test("catch-up: today's live submissions come off what is owed", () => {
  const ledgerRows = [{ name: "Alex Baker", behind: 3 }, { name: "Jordan Lee", behind: 1 }];
  const today = [{ name: "Alex Baker" }, { name: "Alex Baker" }, { name: "Jordan Lee", count: 3 }];
  const r = buildCatchUp({ ledgerRows, schedule, members, today });
  const alex = r.rows.find((c) => c.name === "Alex Baker");
  assert.deepEqual([alex.doneToday, alex.owe], [2, 3]);
  assert.deepEqual(r.behind.map((c) => c.name), ["Alex Baker"]);   // Jordan: 1 + 2 − 3 = 0, caught up
  const m = buildCatchUpMessage(r.behind, { throughLabel: "Wed 10/7", sinceLabel: "8/22" });
  assert.match(m.text, /complete 3 more today \(3 behind \+ today's 2, 2 done so far\)/);
});

test("mergeTodayCounts takes the larger count per person, never the sum", () => {
  const suite = [{ name: "Alex Baker" }, { name: "Alex Baker" }];
  const pbi = [{ name: "ALEX BAKER", count: 1 }, { name: "Jordan Lee", count: 3 }];
  const got = Object.fromEntries(mergeTodayCounts(suite, pbi).map((r) => [r.name.toUpperCase(), r.count]));
  assert.deepEqual(got, { "ALEX BAKER": 2, "JORDAN LEE": 3 });
});

import { creditShiftDays } from "../coach_check.js";

test("overnight: after-midnight observations count for the shift's start day", () => {
  const night = { name: "SHAIN GRISSOM", jobName: "Overnight Stocking Coach", shiftStart: "8:00pm", shiftEnd: "8:00am" };
  const day = { name: "LONI BRADLEY", jobName: "Stocking 2 Coach", shiftStart: "7:00am", shiftEnd: "5:00pm" };
  const days = [
    { dateIso: "2026-10-22", schedule: [night, day] },
    { dateIso: "2026-10-23", schedule: [night, day] },
    { dateIso: "2026-10-24", schedule: [{ ...night, shiftStart: "7:00am", shiftEnd: "3:00pm" }, day] },   // a day shift on the 24th
  ];
  const observations = [
    { dateIso: "2026-10-23", name: "Shain Grissom", count: 2 },   // 2-6 AM on the 23rd: the 22nd's night
    { dateIso: "2026-10-24", name: "Shain Grissom", count: 1 },   // worked a day shift on the 24th too: left alone
    { dateIso: "2026-10-23", name: "Loni Bradley", count: 2 },    // day coach: never moved
  ];
  const out = creditShiftDays({ days, observations });
  assert.deepEqual(out.map((o) => [o.name, o.dateIso]), [
    ["Shain Grissom", "2026-10-22"], ["Shain Grissom", "2026-10-24"], ["Loni Bradley", "2026-10-23"],
  ]);

  // With a time (suite submission): 3 AM belongs to last night; 2 PM does not.
  const t = (h) => new Date(2026, 9, 24, h).getTime();
  const live = creditShiftDays({ days: days.slice(0, 2), observations: [
    { dateIso: "2026-10-24", name: "Shain Grissom", at: t(3) },
    { dateIso: "2026-10-24", name: "Shain Grissom", at: t(14) },
  ] });
  assert.deepEqual(live.map((o) => o.dateIso), ["2026-10-23", "2026-10-24"]);
});

test("overnight: a caught-up night coach is not called behind in the morning", () => {
  const night = { name: "SHAIN GRISSOM", jobName: "Overnight Stocking Coach", shiftStart: "8:00pm", shiftEnd: "8:00am" };
  const days = ["2026-10-21", "2026-10-22", "2026-10-23"].map((dateIso) => ({ dateIso, schedule: [night] }));
  // 2 every night, all after midnight: dated the next morning.
  const rows = ["2026-10-22", "2026-10-23", "2026-10-24"].map((dateIso) => ({ dateIso, name: "Shain Grissom", count: 2 }));
  const credited = creditShiftDays({ days: [...days, { dateIso: "2026-10-24", schedule: [night] }], observations: rows });
  const led = buildLedger({ days, observations: credited.filter((o) => o.dateIso <= "2026-10-23"), todayIso: "2026-10-23" });
  assert.deepEqual([led.rows[0].expected, led.rows[0].done, led.rows[0].behind], [6, 6, 0]);
  const today = credited.filter((o) => o.dateIso === "2026-10-24");
  const cu = buildCatchUp({ ledgerRows: led.rows, schedule: [night], today });
  assert.deepEqual([cu.rows[0].doneToday, cu.rows[0].owe, cu.behind.length], [0, 2, 0]);

  const behindRow = { ...cu.rows[0], behind: 3, owe: 5 };
  assert.match(buildCatchUpMessage([behindRow], { throughLabel: "Fri 10/23", sinceLabel: "10/1" }).text, /complete 5 tonight \(3 behind \+ tonight's 2\)/);
});
