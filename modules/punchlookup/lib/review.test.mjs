// node --test modules/punchlookup/lib/review.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { parseTime, fmtTime, clockIntervals, analyzeDay, punchLine } from "./review.js";
import { reviewsWorkbook, reviewPrintHtml } from "./review_export.js";

const P = (kind, time, extra = {}) => ({ kind, time, date: "2026-10-07", ...extra });
// 7:00 in, meal 11:00–12:00, out 15:30
const DAY = [P("in", "07:00"), P("switch", "11:00", { code: "MEAL" }), P("switch", "12:00", { code: "WRK" }), P("out", "15:30")];
const W = [7 * 60, 15 * 60 + 30];

test("parseTime: formats and the nearest-to-shift guess", () => {
  assert.equal(parseTime("7", W), 420);
  assert.equal(parseTime("742", W), 462);
  assert.equal(parseTime("7:42", W), 462);
  assert.equal(parseTime("2:15", W), 14 * 60 + 15);       // afternoon of a day shift
  assert.equal(parseTime("2:15a", W), 2 * 60 + 15);       // explicit wins
  assert.equal(parseTime("19:42", W), 19 * 60 + 42);
  assert.equal(parseTime("12:30p", W), 12 * 60 + 30);
  assert.equal(parseTime("1:30", [21 * 60 + 54, 24 * 60]), 1440 + 90);   // night shift → past midnight
  assert.equal(parseTime("nope", W), null);
  assert.equal(parseTime("25:00", W), null);
  assert.equal(fmtTime(462), "7:42 AM");
  assert.equal(fmtTime(1440 + 90), "1:30 AM +1");
});

test("clock intervals from punches", () => {
  const { window, intervals } = clockIntervals(DAY, "2026-10-07");
  assert.deepEqual(window, [420, 930]);
  assert.deepEqual(intervals.map((i) => [i.from, i.to, i.status]),
    [[0, 420, "off"], [420, 660, "on"], [660, 720, "meal"], [720, 930, "on"], [930, 2880, "off"]]);
});

test("analyzeDay: totals by type and clock, gaps, flags, overlaps", () => {
  const entries = [
    { id: "a", start: 420, end: 462, text: "backroom on phone", type: "Non-work" },
    { id: "b", start: 462, end: 496, text: "stocked water", type: "Work" },
    { id: "c", start: 496, end: 535, text: "breakroom", type: "Non-work" },
    { id: "d", start: 690, end: 720, text: "stocked during meal", type: "Work" },
    { id: "e", start: 920, end: 945, text: "kept working after out", type: "Work" },
    { id: "f", start: 530, end: 540, text: "overlap", type: "Unclear" },
  ];
  const a = analyzeDay(entries, DAY, "2026-10-07");
  assert.deepEqual(a.rows.map((r) => r.id), ["a", "b", "c", "f", "d", "e"]);
  assert.equal(a.totals.onClock, 240 + 210);
  assert.equal(a.totals.byType["Non-work"].on, 42 + 39);
  assert.equal(a.totals.byType.Work.on, 34 + 10);
  assert.equal(a.totals.byType.Work.meal, 30);
  assert.equal(a.totals.byType.Work.off, 15);
  assert.match(a.rows.find((r) => r.id === "f").problems[0], /overlaps the row before by 5 min/);
  assert.deepEqual(a.issues.map((i) => i.kind), ["meal-work", "off-clock-work"]);
  // documented on-clock: 7:00–9:00 (120) + 15:20–15:30 (10) → undocumented 450 - 130
  assert.equal(a.totals.undocumentedOn, 450 - 130);
  assert.deepEqual(a.gaps[0], { from: 540, to: 660 });
});

test("overnight: carry-over punches keep both days' on-clock time", () => {
  const night = [
    { kind: "in", time: "00:00", date: "2026-09-10", system: true },
    { kind: "switch", time: "02:11", date: "2026-09-10", code: "MEAL" },
    { kind: "switch", time: "03:08", date: "2026-09-10", code: "WRK" },
    { kind: "out", time: "07:55", date: "2026-09-10" },
  ];
  const a = analyzeDay([], night, "2026-09-10");
  assert.equal(a.totals.onClock, 131 + (475 - 188));
  assert.equal(punchLine(night, "2026-09-10"), "Meal 2:11 AM–3:08 AM · Out 7:55 AM");
});


test("print: escapes notes, shows no-notes stretches as counted work", () => {
  const review = { empId: "1", person: { gtaName: "DOE, JANE", win: "123" }, date: "2026-10-07", punches: DAY, caseNo: "WH-1", reviewer: "AP",
    summary: "test", entries: [{ id: "a", start: 420, end: 462, text: "phone <b>&", type: "Non-work", source: "CAM 12" }] };
  const html = reviewPrintHtml(review);
  assert.match(html, /phone &lt;b&gt;&amp;/);
  assert.match(html, /No notes — counted as work/);
  assert.doesNotMatch(html, /Not documented/);
});

test("quick lines: formats, type markers, source, ranges after the note", async () => {
  const { parseQuickLine } = await import("./review.js");
  const q = (l) => { const r = parseQuickLine(l, W); return r && [r.start, r.end, r.type, r.text, r.source]; };
  assert.deepEqual(q("7:15-7:40 on phone"), [435, 460, "Non-work", "on phone", ""]);
  assert.deepEqual(q("16:40-16:55 shane in breakroom"), [1000, 1015, "Non-work", "shane in breakroom", ""]);
  assert.deepEqual(q("715-740 on phone"), [435, 460, "Non-work", "on phone", ""]);
  assert.deepEqual(q("11:50-12:10 smoking"), [710, 730, "Non-work", "smoking", ""]);
  assert.deepEqual(q("12:50-1:10 walking the lot"), [770, 790, "Non-work", "walking the lot", ""]);
  assert.deepEqual(q("w 7:40-8:10 stocking water"), [460, 490, "Work", "stocking water", ""]);
  assert.deepEqual(q("7:40-8:10 w: stocking water"), [460, 490, "Work", "stocking water", ""]);
  assert.deepEqual(q("? 9:00-9:20 behind a pallet"), [540, 560, "Unclear", "behind a pallet", ""]);
  assert.deepEqual(q("7:15 to 7:40 on phone @backroom cam"), [435, 460, "Non-work", "on phone", "backroom cam"]);
  assert.deepEqual(q("on phone 7:15-7:40"), [435, 460, "Non-work", "on phone", ""]);
  assert.deepEqual(q("1. 8:00-8:15 talking."), [480, 495, "Non-work", "talking", ""]);
  assert.equal(q("phone call"), null);
  assert.equal(parseQuickLine("7:15-7:40 on phone", W, "Work").type, "Work");   // the app's default type
});

test("Excel record: Days, Entries with who, W&H Report", async () => {
  const { readXlsxFile } = await import("../../../shared/xlsx.js");
  const reviews = [{ empId: "77", person: { gtaName: "DOE, JANE", win: "123" }, date: "2026-10-07", punches: DAY, caseNo: "WH-9", reviewer: "Ann B",
    entries: [{ id: "a", start: 420, end: 462, text: "on phone", type: "Non-work", source: "cam 3", byName: "Ann B" }] }];
  const bytes = reviewsWorkbook(reviews);
  const days = await readXlsxFile(bytes);   // first sheet: Days
  assert.ok(days.headers.includes("Day Review"));
});

test("W&H report sentences, totals, and no-notes time counted as work", async () => {
  const { whReport, whText, rangeText } = await import("./review_export.js");
  assert.equal(rangeText(420, 462), "7:00-7:42 AM");
  assert.equal(rangeText(710, 730), "11:50 AM-12:10 PM");
  const review = { empId: "1", person: { gtaName: "DOE, JANE" }, date: "2026-10-07", punches: DAY,
    entries: [{ id: "a", start: 420, end: 462, text: "Standing in the backroom on phone.", type: "Non-work" },
      { id: "b", start: 462, end: 496, text: "stocking water", type: "Work" },
      { id: "c", start: 496, end: 535, text: "", type: "Non-work" }] };
  const rep = whReport([review]);
  assert.deepEqual(rep.days[0].lines, [
    "7:00-7:42 AM was not performing work duties and was standing in the backroom on phone.",
    "8:16-8:55 AM was not performing work duties and was __________.",
  ]);
  assert.equal(rep.days[0].t.nonworkOn, 81);
  assert.equal(rep.days[0].t.workOn, 450 - 81);            // 34 documented + everything without notes
  const text = whText(rep);
  assert.match(text, /Total time not performing work duties: 1 hr 21 min \(81 minutes\)\./);
  assert.match(text, /Total time performing work duties: 6 hrs 9 min\./);
  assert.match(text, /no documented activity is counted as performing work duties/);
});

test("punched lunch and out/in break show as break rows", async () => {
  const { timeline, breakLabel } = await import("./review_export.js");
  const a = analyzeDay([], [P("in", "11:35"), P("out", "15:46"), P("in", "16:49"), P("out", "19:30")], "2026-10-07");
  assert.deepEqual(a.breaks, [{ from: 946, to: 1009, status: "off" }]);
  assert.deepEqual(timeline(a).map((x) => x.kind), ["gap", "break", "gap"]);
  assert.match(breakLabel(a.breaks[0]), /^Lunch — clocked out/);
});
