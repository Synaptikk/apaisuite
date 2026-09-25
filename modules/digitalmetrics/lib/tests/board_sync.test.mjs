// modules/digitalmetrics/lib/tests/board_sync.test.mjs
// Run with: node --test modules/digitalmetrics/lib/tests/board_sync.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseShareLink, weekdaySheets, fingerprint, planDates, scheduleFit, resolveBoardNames, mergeBoard, addDays,
  learnFromHistory,
} from "../data/board_sync.js";

const HEADER = ["Associate", "5-6", "6-7", "7-8", "8-9", "9-10", "10-11", "11-12", "12-1P", "1-2P"];
const sheet = (weekday, rows) => ({ rows: [[weekday], ["Pickers", 1, 2], HEADER, ...rows] });

// ── share link ───────────────────────────────────────────────────────────
test("a OneDrive share link yields the site and file id", () => {
  const got = parseShareLink("https://my.wal-mart.com/:x:/r/personal/abc_s01_us_wal-mart_com/_layouts/15/Doc.aspx?sourcedoc=%7B1A2B3C4D-0000-4000-8000-00000000ABCD%7D&file=Daily%20Board%202.xlsx&action=default");
  assert.equal(got.site, "https://my.wal-mart.com/personal/abc_s01_us_wal-mart_com");
  assert.equal(got.uniqueId, "1A2B3C4D-0000-4000-8000-00000000ABCD");
  assert.equal(got.fileName, "Daily Board 2.xlsx");
});

test("anything that is not a share link is rejected", () => {
  assert.equal(parseShareLink("not a url"), null);
  assert.equal(parseShareLink("https://my.wal-mart.com/personal/x/Documents/a.xlsx"), null);
});

// ── sheets ───────────────────────────────────────────────────────────────
test("weekday sheets are keyed by weekday, blank rows and the template dropped", () => {
  const got = weekdaySheets([
    sheet("WEDNESDAY", [["marla  f", "", "PICK", "pick"], ["BLANK"], ["kj", "DISP"]]),
    { rows: [["Pickers", 0], HEADER, ["ABBY", "PICK"]] },   // template: no weekday
  ]);
  assert.deepEqual(Object.keys(got), ["3"]);
  assert.deepEqual(got[3], { "MARLA F": { 1: "PICK", 2: "PICK" }, KJ: { 0: "DISP" } });
});

test("the fingerprint ignores row order", () => {
  assert.equal(fingerprint({ A: { 1: "PICK" }, B: { 2: "L" } }), fingerprint({ B: { 2: "L" }, A: { 1: "PICK" } }));
  assert.notEqual(fingerprint({ A: { 1: "PICK" } }), fingerprint({ A: { 1: "DISP" } }));
});

// ── dates ────────────────────────────────────────────────────────────────
// 2026-09-23 is a Wednesday (3). The THURSDAY (4) sheet is either tomorrow
// (the 24th) or six days ago (the 17th); FRI–TUE are the 18th–22nd.
const week = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, { [`P${d}`]: { 1: "PICK" } }]));
const byDate = (plan) => Object.fromEntries(plan.map((p) => [p.date, p]));

test("first run: today, plus a backfill of every past day the sheets still hold", () => {
  const plan = byDate(planDates(week, "2026-09-23", () => null));
  assert.equal(plan["2026-09-23"].mode, "today");
  for (const d of ["2026-09-18", "2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22"]) {
    assert.equal(plan[d].mode, "backfill", d);
  }
  assert.equal(plan["2026-09-22"].cells.P2[1], "PICK");   // Tuesday's sheet → the 22nd
  // No chooser verdict: the shared THURSDAY sheet is left alone.
  assert.match(plan["2026-09-24"].skip, /can't tell/);
});

test("first run: the chooser settles the shared sheet either way", () => {
  const past = byDate(planDates(week, "2026-09-23", () => null, (c, p) => p));
  assert.equal(past["2026-09-17"].mode, "backfill");
  const next = byDate(planDates(week, "2026-09-23", () => null, (c, p, f) => f));
  assert.equal(next["2026-09-24"].mode, "tomorrow");
});

test("the shared sheet is tomorrow's once it differs from what we applied six days ago", () => {
  const snaps = { "2026-09-17": { fp: fingerprint({ OLD: { 1: "PICK" } }) } };
  const plan = byDate(planDates(week, "2026-09-23", (d) => snaps[d] || null));
  assert.equal(plan["2026-09-24"].mode, "tomorrow");
});

test("the shared sheet unchanged since six days ago: tomorrow waits", () => {
  const snaps = { "2026-09-17": { fp: fingerprint(week[4]) } };
  const plan = byDate(planDates(week, "2026-09-23", (d) => snaps[d] || null));
  assert.match(plan["2026-09-24"].skip, /not been updated/);
});

test("a past day already filled from the board is never refilled (midnight lock)", () => {
  const snaps = { "2026-09-22": { fp: "whatever" } };
  const plan = byDate(planDates(week, "2026-09-23", (d) => snaps[d] || null));
  assert.match(plan["2026-09-22"].skip, /locked/);
});

test("a sheet identical to what was applied a week earlier is stale", () => {
  const snaps = { "2026-09-16": { fp: fingerprint(week[3]) } };
  const plan = byDate(planDates(week, "2026-09-23", (d) => snaps[d] || null));
  assert.match(plan["2026-09-23"].skip, /not updated/);
});

test("scheduleFit prefers the day whose schedule the names and hours fit", () => {
  const cells = { "MARLA F": { 1: "PICK", 2: "PICK" } };
  const fits = [{ name: "MARLA FINCH", startSlot: 0, endSlot: 9 }];
  const offDay = [{ name: "MARLA FINCH", startSlot: 10, endSlot: 17 }];
  assert.equal(scheduleFit(cells, fits), 1);
  assert.equal(scheduleFit(cells, offDay), 0);
});

test("addDays crosses month ends", () => {
  assert.equal(addDays("2026-09-30", 1), "2026-10-01");
  assert.equal(addDays("2026-10-01", -7), "2026-09-24");
});

// ── names ────────────────────────────────────────────────────────────────
const schedule = [
  { name: "MARLA FINCH", startSlot: 0, endSlot: 9 },
  { name: "MARLA MOSS", startSlot: 0, endSlot: 9 },
  { name: "STELLAN KIRBY", startSlot: 0, endSlot: 9 },
  { name: "STELLAN KENT", startSlot: 0, endSlot: 9 },
  { name: "NICHOLAS WREN", startSlot: 0, endSlot: 9 },
  { name: "QUIN ORLO", startSlot: 0, endSlot: 9 },
  { name: "ALEX CORBIN", startSlot: 9, endSlot: 17 },   // maintenance, evenings
  { name: "KELVIN ALEXANDER", startSlot: 0, endSlot: 9 },
  { name: "SEAN HOLLIS", startSlot: 0, endSlot: 9 },
  { name: "SEAN PELL", startSlot: 0, endSlot: 9 },
];
const digital = new Set(schedule.map((s) => s.name).filter((n) => n !== "ALEX CORBIN" && n !== "SEAN PELL"));
const opts = { isDigital: (n) => digital.has(n) };
const morning = { 1: "PICK", 2: "PICK" };

test("first name plus surname letters separates namesakes", () => {
  const { matched } = resolveBoardNames({ "MARLA F": morning, "STELLAN KE": morning }, schedule, opts);
  assert.equal(matched["MARLA F"].name, "MARLA FINCH");
  assert.equal(matched["STELLAN KE"].name, "STELLAN KENT");
});

test("nicknames and one-letter misspellings resolve", () => {
  const { matched } = resolveBoardNames({ NICK: morning, QUINN: morning }, schedule, opts);
  assert.equal(matched.NICK.name, "NICHOLAS WREN");
  assert.equal(matched.QUINN.name, "QUIN ORLO");
});

test("the digital team wins a shared first name", () => {
  const { matched } = resolveBoardNames({ SEAN: morning }, schedule, opts);
  assert.equal(matched.SEAN.name, "SEAN HOLLIS");
});

test("a lone non-digital namesake whose shift does not fit is flagged, not guessed", () => {
  const { matched, unmatched } = resolveBoardNames({ ALEX: morning }, schedule, opts);
  assert.equal(matched.ALEX, undefined);
  assert.deepEqual(unmatched[0].candidates.sort(), ["ALEX CORBIN", "KELVIN ALEXANDER"]);
});

test("a bare first name shared by two digital associates stays unmatched", () => {
  const { unmatched } = resolveBoardNames({ MARLA: morning }, schedule, opts);
  assert.equal(unmatched[0].boardName, "MARLA");
  assert.equal(unmatched[0].candidates.length, 2);
});

test("elimination: once MARLA F is taken, bare MARLA is the other one", () => {
  const { matched } = resolveBoardNames({ "MARLA F": morning, MARLA: morning }, schedule, opts);
  assert.equal(matched.MARLA.name, "MARLA MOSS");
});

test("an alias always wins, and suggestions reach unscheduled digital associates", () => {
  const { matched, unmatched } = resolveBoardNames({ KJ: morning, ALEX: morning }, schedule,
    { ...opts, aliases: { ALEX: "KELVIN ALEXANDER" }, roster: ["KIRA JUNE"] });
  assert.equal(matched.ALEX.name, "KELVIN ALEXANDER");
  assert.deepEqual(unmatched, [{ boardName: "KJ", candidates: ["KIRA JUNE"] }]);
});

test("last resort: the one unboarded digital associate with exactly those hours", () => {
  const sched = [
    { name: "JORDAN PIKE", startSlot: 0, endSlot: 5, jobName: "Digital Personal Shopper" },     // goes by a middle name
    { name: "RHEA TOLL", startSlot: 8, endSlot: 17, jobName: "Digital Personal Shopper" },
    { name: "OWEN LARK", startSlot: 8, endSlot: 17, jobName: "Digital TL" },                   // leaders are not on the board
    { name: "IDA MOSS", startSlot: 2, endSlot: 11, jobName: "Digital Personal Shopper" },
    { name: "EVE MOSS", startSlot: 2, endSlot: 11, jobName: "Digital Personal Shopper" },       // two exact fits → no guess
  ];
  const five = Object.fromEntries([0, 1, 2, 3, 4].map((k) => [k, "STAGE"]));
  const late = Object.fromEntries([8, 9, 10, 11, 13, 14, 15, 16].map((k) => [k, "DISP"]));
  const mid  = Object.fromEntries([2, 3, 4, 5, 6, 7, 8, 9, 10].map((k) => [k, "PICK"]));
  const { matched, unmatched } = resolveBoardNames({ BRAM: five, ANNA: late, ZED: mid }, sched,
    { isDigital: () => true });
  assert.deepEqual([matched.BRAM.name, matched.BRAM.how], ["JORDAN PIKE", "hours match"]);
  assert.equal(matched.ANNA.name, "RHEA TOLL");
  assert.equal(unmatched[0].boardName, "ZED");
});

test("a literal start of the first name beats the nickname table, and hours must overlap", () => {
  // "ZACK" meant ZACKARY on the evening; the table's ZACHARY works mornings.
  const sched = [
    { name: "ZACHARY WREN", startSlot: 0, endSlot: 9, jobName: "Digital Personal Shopper" },
    { name: "ZACKARY DALE", startSlot: 11, endSlot: 17, jobName: "Digital Personal Shopper" },
  ];
  const evening = { 11: "PICK", 12: "PICK", 13: "PICK" };
  const { matched } = resolveBoardNames({ ZACK: evening }, sched, { isDigital: () => true });
  assert.equal(matched.ZACK.name, "ZACKARY DALE");
  // And a lone namesake on the wrong shift is flagged, not taken.
  const { unmatched } = resolveBoardNames({ ZACK: evening }, [sched[0]], { isDigital: () => true });
  assert.equal(unmatched[0].boardName, "ZACK");
});

test("hours win over a name: a namesake on another shift loses to an exact-hours fit, kept as an option", () => {
  const sched = [
    { name: "JONAH WEBB", startSlot: 3, endSlot: 11, shiftEnd: "4:00pm", jobName: "Digital Personal Shopper" },
    { name: "RAY STONE", startSlot: 3, endSlot: 12, shiftEnd: "5:00pm", jobName: "Digital Personal Shopper" },
  ];
  const eightToFive = Object.fromEntries([3, 4, 5, 6, 7, 8, 9, 10, 11].map((k) => [k, "DISP"]));
  const { matched } = resolveBoardNames({ JONAH: eightToFive }, sched, { isDigital: () => true });
  assert.equal(matched.JONAH.name, "RAY STONE");
  assert.equal(matched.JONAH.how, "hours match");
  assert.deepEqual(matched.JONAH.alt, ["JONAH WEBB"]);
});

test("a shift ending on the half hour covers the board's '30' cell", () => {
  // 4:00–8:30pm is stored as slots 11–15; the board plans 8–9pm as "30".
  const sched = [{ name: "COLE JUNE", startSlot: 11, endSlot: 15, shiftEnd: "8:30pm" }];
  const cells = { COLE: { 11: "DISP", 12: "DISP", 13: "DISP", 14: "DISP", 15: "30" } };
  const { matched } = resolveBoardNames(cells, sched, { isDigital: () => true });
  assert.equal(matched.COLE.name, "COLE JUNE");
});

test("swapped letters count as a misspelling", () => {
  const { matched } = resolveBoardNames({ GUAGE: morning },
    [{ name: "GAUGE ROWE", startSlot: 0, endSlot: 9 }], { isDigital: () => true });
  assert.equal(matched.GUAGE.name, "GAUGE ROWE");
});

test("learning across days: the one person whose hours fit a recurring name every day", () => {
  const dp = "Digital Personal Shopper";
  const day = (a, b, others) => ({
    cells: { TUCK: Object.fromEntries(Array.from({ length: b - a }, (_, i) => [a + i, "PICK"])) },
    schedule: [{ name: "ZANE WOLFE", startSlot: a, endSlot: b, jobName: dp }, ...others],
  });
  const days = [
    day(4, 13, [{ name: "TESS EDGE", startSlot: 4, endSlot: 13, jobName: dp }]),   // a coincidence on one day
    day(5, 14, []),
    day(3, 12, [{ name: "TESS EDGE", startSlot: 9, endSlot: 17, jobName: dp }]),
  ];
  const learned = learnFromHistory(days, { isDigital: () => true });
  assert.deepEqual([learned.TUCK.name, learned.TUCK.fits, learned.TUCK.days], ["ZANE WOLFE", 3, 3]);
  // Applied to a day, it is a reviewable "hours" match.
  const { matched } = resolveBoardNames(days[0].cells, days[0].schedule, { isDigital: () => true, learned });
  assert.equal(matched.TUCK.name, "ZANE WOLFE");
  assert.match(matched.TUCK.how, /^hours, 3 of 3 days/);
});

test("one day of evidence is not learned", () => {
  const learned = learnFromHistory([{ cells: { TUCK: { 1: "PICK" } },
    schedule: [{ name: "ZANE WOLFE", startSlot: 1, endSlot: 2 }] }], { isDigital: () => true });
  assert.deepEqual(learned, {});
});

// ── merge ────────────────────────────────────────────────────────────────
const matched = { "MARLA F": { name: "MARLA FINCH" } };

test("first sight: a board saved after the app was edited overwrites it", () => {
  const doc = { updatedAt: "2026-09-23T10:00:00Z", associates: [{ name: "MARLA FINCH", slots: { 1: "DISP" } }] };
  const r = mergeBoard(doc, { cells: { "MARLA F": { 1: "PICK" } }, matched, previous: null,
    boardModifiedAt: "2026-09-23T12:00:00Z", schedule });
  assert.equal(r.associates[0].slots[1], "PICK");
});

test("first sight: an app edit newer than the board is kept; the board only fills gaps", () => {
  const doc = { updatedAt: "2026-09-23T13:00:00Z", associates: [{ name: "MARLA FINCH", slots: { 1: "DISP" } }] };
  const r = mergeBoard(doc, { cells: { "MARLA F": { 1: "PICK", 2: "PICK" } }, matched, previous: null,
    boardModifiedAt: "2026-09-23T12:00:00Z", schedule });
  assert.deepEqual(r.associates[0].slots, { 1: "DISP", 2: "PICK" });
});

test("later pulls: only cells the board changed replace app edits", () => {
  const doc = { updatedAt: "2026-09-23T13:00:00Z",
    associates: [{ name: "MARLA FINCH", slots: { 1: "DISP", 2: "PICK", 3: "L" } }] };
  const r = mergeBoard(doc, {
    cells:    { "MARLA F": { 1: "PICK", 2: "PICK", 3: "PICK" } },
    previous: { "MARLA F": { 1: "PICK", 2: "PICK", 3: "L" } },   // board changed slot 3 only
    matched, boardModifiedAt: "2026-09-23T14:00:00Z", schedule });
  // Slot 1: app said DISP, board never changed it → app edit stands.
  assert.deepEqual(r.associates[0].slots, { 1: "DISP", 2: "PICK", 3: "PICK" });
  assert.equal(r.changedCells, 1);
});

test("a cell cleared on the board is cleared in the app", () => {
  const doc = { associates: [{ name: "MARLA FINCH", slots: { 1: "PICK", 2: "PICK" } }] };
  const r = mergeBoard(doc, { cells: { "MARLA F": { 1: "PICK" } },
    previous: { "MARLA F": { 1: "PICK", 2: "PICK" } }, matched, schedule });
  assert.deepEqual(r.associates[0].slots, { 1: "PICK" });
});

test("new board rows are added with the scheduled shift", () => {
  const r = mergeBoard(null, { cells: { "MARLA F": morning }, matched, previous: null, schedule });
  assert.equal(r.associates[0].name, "MARLA FINCH");
  assert.equal(r.associates[0].shiftStart, 0);
  assert.equal(r.associates[0].shiftEnd, 9);
  assert.equal(r.addedRows, 1);
});

test("an unresolved row filed under its typed name is renamed once an alias resolves it", () => {
  const doc = { associates: [{ name: "KJ", slots: { 1: "PICK" } }] };
  const r = mergeBoard(doc, { cells: { KJ: { 1: "PICK" } }, matched: { KJ: { name: "KIRA JUNE" } },
    previous: { KJ: { 1: "PICK" } }, schedule });
  assert.deepEqual(r.associates.map((a) => a.name), ["KIRA JUNE"]);
  assert.equal(r.renamedRows, 1);
});

test("a typed-name row moves into the person's existing (empty) schedule row", () => {
  const doc = { associates: [{ name: "KJ", slots: { 1: "PICK" } }, { name: "KIRA JUNE", slots: {} }] };
  const r = mergeBoard(doc, { cells: { KJ: { 1: "PICK" } }, matched: { KJ: { name: "KIRA JUNE" } },
    previous: { KJ: { 1: "PICK" } }, schedule });
  assert.deepEqual(r.associates.map((a) => [a.name, a.slots]), [["KIRA JUNE", { 1: "PICK" }]]);
});

test("changing a fix moves the board's cells to the new person, app edits stay", () => {
  const doc = { associates: [
    { name: "ALEX CORBIN", slots: { 1: "PICK", 2: "DISP" } },    // 2 was edited in the app
    { name: "KELVIN ALEXANDER", slots: {} }] };
  const r = mergeBoard(doc, { cells: { ALEX: { 1: "PICK", 2: "PICK" } },
    matched: { ALEX: { name: "KELVIN ALEXANDER" } }, previous: { ALEX: { 1: "PICK", 2: "PICK" } },
    previousNames: { ALEX: "ALEX CORBIN" }, schedule });
  const by = Object.fromEntries(r.associates.map((a) => [a.name, a.slots]));
  assert.deepEqual(by["ALEX CORBIN"], { 2: "DISP" });
  assert.deepEqual(by["KELVIN ALEXANDER"], { 1: "PICK" });
});

test("a swap: one name moves out of a row as another moves in, overlap kept", () => {
  // Last pull: ZACK filed under ZANE WOLFE, TUCK under its typed name.
  const doc = { associates: [
    { name: "ZANE WOLFE", slots: { 11: "PICK", 12: "PICK" } },
    { name: "TUCK", slots: { 4: "DISP", 11: "DISP", 12: "DISP" } },
    { name: "ZACKARY DALE", slots: {} }] };
  const cells = { ZACK: { 11: "PICK", 12: "PICK" }, TUCK: { 4: "DISP", 11: "DISP", 12: "DISP" } };
  const r = mergeBoard(doc, { cells, previous: cells,
    matched: { ZACK: { name: "ZACKARY DALE" }, TUCK: { name: "ZANE WOLFE" } },
    previousNames: { ZACK: "ZANE WOLFE", TUCK: "TUCK" }, schedule });
  const by = Object.fromEntries(r.associates.map((a) => [a.name, a.slots]));
  assert.deepEqual(by["ZANE WOLFE"], { 4: "DISP", 11: "DISP", 12: "DISP" });
  assert.deepEqual(by["ZACKARY DALE"], { 11: "PICK", 12: "PICK" });
  assert.equal(by.TUCK, undefined);
});

test("unchanged board, unchanged doc", () => {
  const doc = { associates: [{ name: "MARLA FINCH", slots: { 1: "PICK" } }] };
  const r = mergeBoard(doc, { cells: { "MARLA F": { 1: "PICK" } }, previous: { "MARLA F": { 1: "PICK" } }, matched, schedule });
  assert.equal(r.unchanged, true);
});
