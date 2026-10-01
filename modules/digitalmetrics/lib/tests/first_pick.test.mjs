import { test } from "node:test";
import assert from "node:assert/strict";
import { firstHourPickers, scheduledPickers, clockInCandidates, firstHourStarts, clockText, rangesText } from "../data/first_pick.js";
import { parseLookupRows, matchLookup, parseTimesheetRows } from "../data/gta_parse.js";

// slot 0 = 5am, so slot 8 = 1pm
const row = (name, start, end, tasks, extra = {}) => ({
  name, shiftStart: start, shiftEnd: end,
  slots: Object.fromEntries(tasks.map((t, i) => [start + i, t])), ...extra,
});

test("only rows whose first in-shift hour is Pick count, absent excluded", () => {
  const roster = [
    row("SHANE SMITH", 8, 12, ["PICK", "PICK", "DISP", "PICK"]),
    row("KIRA JUNE", 0, 4, ["DISP", "PICK", "PICK", "PICK"]),
    row("ANA LEE", 0, 4, ["Pick", "PICK"], { status: "absent" }),
  ];
  assert.deepEqual(firstHourPickers(roster).map((p) => [p.name, p.schedStart]), [["SHANE SMITH", 13 * 60]]);
  // Punches are wanted for everyone scheduled to pick at all, not just first-hour pickers.
  assert.deepEqual(clockInCandidates({ "2026-09-22": { associates: roster } }), ["KIRA JUNE", "SHANE SMITH"]);
});

test("scheduledPickers: anyone with a Pick slot, with which ends of the shift are Pick", () => {
  const roster = [
    row("KIRA JUNE", 0, 4, ["DISP", "PICK", "PICK", "PICK"]),
    row("NO PICK", 0, 4, ["DISP", "DISP"]),
  ];
  const [k] = scheduledPickers(roster);
  assert.equal(scheduledPickers(roster).length, 1);
  assert.deepEqual([k.name, k.schedStart, k.schedEnd, k.pickStart, k.pickEnd, k.firstHourPick, k.lastHourPick],
                   ["KIRA JUNE", 300, 540, 360, 540, false, true]);
  assert.deepEqual(k.pickRanges, [[360, 540]]);
});

test("the user's early-stop example: pick 4-5pm, last pick 4:15, out 4:51", () => {
  // slot 11 = 4pm; shift 1pm-5pm, last hour Pick
  const byDate = { "2026-09-22": { associates: [row("SHANE SMITH", 8, 12, ["DISP", "DISP", "DISP", "PICK"])] } };
  const raw = [{ "Pick Date": "9/22/2026", Associate: "Shane Smith", "Min. First Scan": "4:02 PM", "Max. Last Scan": "4:15 PM" }];
  const clock = { "2026-09-22": { "SHANE SMITH": { clockIn: 13 * 60 + 5, clockOut: 16 * 60 + 51 } } };
  const { days, people, totals } = firstHourStarts(byDate, raw, clock);
  const d = days[0];
  // The block is 4–5pm: the first pick at 4:02 is 2 minutes into it, inside the cutoff.
  assert.deepEqual([d.firstPick, d.lost, d.clockToPick], [16 * 60 + 2, 0, null]);
  assert.equal(d.clockLate, 5);                 // still 5 minutes late to the clock
  // The end gap runs to the clock-OUT (4:51), not the scheduled end.
  assert.deepEqual([d.schedEnd, d.lastPick, d.clockOut, d.endGap, d.earlyOut], [17 * 60, 16 * 60 + 15, 16 * 60 + 51, 36, 9]);
  // 5 late and 9 early are both inside the grace: nothing counted against the clock.
  assert.deepEqual([people[0].totalLate, people[0].totalEarlyOut, people[0].totalEndGap], [0, 0, 36]);
  assert.deepEqual([totals.lateMinutes, totals.earlyOutMinutes, totals.endGapMinutes], [0, 0, 36]);
});

test("the user's total: in 7:00, first pick 7:20 (+20), last pick 3:15, out 3:50 (+35) = 55", () => {
  // slot 2 = 7am; 7am-4pm, Pick both ends
  const byDate = { "2026-09-22": { associates: [row("SHANE SMITH", 2, 11, ["PICK", "PICK", "PICK", "PICK", "PICK", "PICK", "PICK", "PICK", "PICK"])] } };
  const raw = [{ "Pick Date": "9/22/2026", Associate: "Shane Smith", "Min. First Scan": "7:20 AM", "Max. Last Scan": "3:15 PM" }];
  const clock = { "2026-09-22": { "SHANE SMITH": { clockIn: 7 * 60, clockOut: 15 * 60 + 50 } } };
  const { days, people, totals } = firstHourStarts(byDate, raw, clock);
  assert.deepEqual([days[0].lost, days[0].endGap, days[0].total], [20, 35, 55]);
  assert.equal(people[0].total, 55);
  assert.equal(totals.idleMinutes, 55);
});

test("a gap of 3 minutes or less at either end is a walk to the clock, not idle time", () => {
  const byDate = { "2026-09-22": { associates: [row("A B", 2, 11, ["PICK", "PICK", "PICK", "PICK", "PICK", "PICK", "PICK", "PICK", "PICK"])] } };
  const raw = [{ "Pick Date": "9/22/2026", Associate: "A B", "Min. First Scan": "7:03 AM", "Max. Last Scan": "3:47 PM" }];
  const clock = { "2026-09-22": { "A B": { clockIn: 7 * 60, clockOut: 15 * 60 + 50 } } };
  const { days } = firstHourStarts(byDate, raw, clock);
  assert.deepEqual([days[0].lost, days[0].endGap, days[0].total], [0, 0, 0]);
});

test("the 9-minute grace: 10 late and 10 early count in full, 9 and 9 do not", () => {
  const byDate = { "2026-09-22": { associates: [row("A B", 0, 8, ["PICK"]), row("C D", 0, 8, ["PICK"])] } };
  const clock = { "2026-09-22": {
    "A B": { clockIn: 5 * 60 + 10, clockOut: 13 * 60 - 10 },
    "C D": { clockIn: 5 * 60 + 9,  clockOut: 13 * 60 - 9 },
  } };
  const { people } = firstHourStarts(byDate, [], clock);
  const by = Object.fromEntries(people.map((p) => [p.name, p]));
  assert.deepEqual([by["A B"].totalLate, by["A B"].lateClockDays, by["A B"].totalEarlyOut, by["A B"].earlyOutDays], [10, 1, 10, 1]);
  assert.deepEqual([by["C D"].totalLate, by["C D"].lateClockDays, by["C D"].totalEarlyOut, by["C D"].earlyOutDays], [0, 0, 0, 0]);
});

test("total late sums only late days; staying late and a last pick hours early do not count", () => {
  const byDate = {
    "2026-09-22": { associates: [row("A B", 0, 8, ["PICK", "PICK"])] },
    "2026-09-23": { associates: [row("A B", 0, 8, ["PICK", "PICK"])] },
  };
  const raw = [{ "Pick Date": "9/23/2026", Associate: "A B", "Max. Last Scan": "8:00 AM" }];   // 5 h before a 1pm end
  const clock = {
    "2026-09-22": { "A B": { clockIn: 5 * 60 + 12, clockOut: 13 * 60 + 10 } },
    "2026-09-23": { "A B": { clockIn: 4 * 60 + 50, clockOut: 12 * 60 + 40 } },
  };
  const { people } = firstHourStarts(byDate, raw, clock);
  const p = people[0];
  assert.deepEqual([p.totalLate, p.lateClockDays, p.totalEarlyOut, p.earlyOutDays, p.totalEndGap], [12, 1, 20, 1, 0]);
  assert.deepEqual([p.days[1].lastPick, p.days[1].endGap], [8 * 60, 0]);   // the block ended at 7am; a later scan is no gap
});

test("the shift label wins over the slot for the scheduled start", () => {
  const r = row("KIRA JUNE", 0, 4, ["PICK"], { shiftLabel: "5:30am-10:30am" });
  assert.equal(firstHourPickers([r])[0].schedStart, 5 * 60 + 30);
});

test("the user's example: sched 1pm, clock 1:05, first pick 1:28", () => {
  const byDate = { "2026-09-22": { associates: [row("SHANE SMITH", 8, 12, ["PICK"])] } };
  const raw = [{ "Pick Date": "9/22/2026", Associate: "Shane Smith", "Min. First Scan": "1:28 PM" }];
  const clock = { "2026-09-22": { "SHANE SMITH": { clockIn: 13 * 60 + 5 } } };
  const { days, people, totals } = firstHourStarts(byDate, raw, clock);
  assert.deepEqual(days[0], {
    date: "2026-09-22", name: "SHANE SMITH", schedStart: 780, schedEnd: 1020, pickStart: 780, pickEnd: 840, pickRanges: [[780, 840]],
    clockIn: 785, clockOut: null, mealOut: null, mealIn: null, firstPick: 808, lastPick: null,
    clockLate: 5, clockToPick: 23, lost: 23, endGap: null, startMoved: false, endMoved: false,
    earlyOut: null, total: 23, moved: 0,
  });
  assert.equal(people[0].totalLost, 23);          // the whole clock-in → first pick gap, once over 3 min
  assert.equal(people[0].total, 23);
  assert.equal(people[0].totalLate, 0);           // 5 min is inside the 9-min grace
  assert.equal(totals.lateClockDays, 0);
});

test("early clock-in, a missing scan, and a scan hours into a Pick block are handled", () => {
  const byDate = { "2026-09-22": { associates: [
    row("A B", 0, 8, ["PICK"]), row("C D", 0, 8, ["PICK"]), row("E F", 0, 8, ["PICK"]),
  ] } };
  const raw = [
    { "Pick Date": "9/22/2026", Associate: "A B", "Min. First Scan": "5:04 AM" },
    { Associate: "E F", "Min. First Scan": "9:30 AM" },       // forward-filled date
  ];
  const clock = { "2026-09-22": { "A B": { clockIn: 4 * 60 + 55 }, "C D": { clockIn: 5 * 60 + 2 } } };
  const { days } = firstHourStarts(byDate, raw, clock);
  const by = Object.fromEntries(days.map((d) => [d.name, d]));
  assert.equal(by["A B"].clockLate, -5);
  assert.equal(by["A B"].clockToPick, 9);
  assert.equal(by["A B"].lost, 9);                        // 4:55 → 5:04, over the 3-min cutoff
  assert.equal(by["C D"].firstPick, null);
  assert.equal(by["C D"].lost, null);
  // Scheduled to pick 5–6am only, first pick 9:30: the whole Pick hour was
  // missed — 60, not the 270 minutes to the scan, most of which were not
  // Pick hours. Over 50, so it is flagged as "moved" and kept out of the total.
  assert.deepEqual([by["E F"].lost, by["E F"].startMoved, by["E F"].total, by["E F"].moved], [60, true, 0, 60]);
});

test("a mid-shift Pick block is measured against the block, not the shift (Owen, 9/22)", () => {
  // slot 8 = 1pm. DISP 1–6pm with lunch, PICK 6–8pm, DISP 8–10pm.
  const roster = [row("OWEN PARK", 8, 17, ["DISP", "DISP", "DISP", "L", "DISP", "PICK", "PICK", "DISP", "DISP"], { shiftLabel: "1:00pm-10:00pm" })];
  const [p] = scheduledPickers(roster);
  assert.deepEqual([p.pickStart, p.pickEnd, p.firstHourPick, p.lastHourPick], [18 * 60, 20 * 60, false, false]);
  const byDate = { "2026-09-22": { associates: roster } };
  const raw = [{ "Pick Date": "9/22/2026", Associate: "Owen Park", "Min. First Scan": "6:05 PM", "Max. Last Scan": "6:30 PM" }];
  const clock = { "2026-09-22": { "OWEN PARK": { clockIn: 12 * 60 + 52, clockOut: 21 * 60 + 54 } } };
  const { days } = firstHourStarts(byDate, raw, clock);
  // 6:00 → 6:05 is 5 idle (over the 3-min cutoff); 6:30 → 8:00 is 90 — over 50, so most
  // likely another role: shown, but only the 5 is in the total. Punches play no part.
  assert.deepEqual([days[0].lost, days[0].endGap, days[0].endMoved, days[0].total, days[0].moved, days[0].clockToPick], [5, 90, true, 5, 90, null]);
});

test("split Pick hours (Tessa, 9/22): the DISP hours in between are not idle picking time", () => {
  // slot 3 = 8am. Pick 8–10, DISP 10–12, lunch, DISP 1–3, Pick 3–4; scans 11:02 and 11:26.
  const roster = [row("TESSA REED", 3, 11, ["PICK", "PICK", "DISP", "DISP", "L", "DISP", "DISP", "PICK"], { shiftLabel: "8:00am-4:00pm" })];
  const [p] = scheduledPickers(roster);
  assert.deepEqual(p.pickRanges, [[8 * 60, 10 * 60], [15 * 60, 16 * 60]]);
  assert.equal(rangesText(p.pickRanges), "8a–10a, 3p–4p");
  const byDate = { "2026-09-22": { associates: roster } };
  const raw = [{ "Pick Date": "9/22/2026", Associate: "Tessa Reed", "Min. First Scan": "11:02 AM", "Max. Last Scan": "11:26 AM" }];
  const clock = { "2026-09-22": { "TESSA REED": { clockIn: 7 * 60 + 53, clockOut: 15 * 60 + 53 } } };
  const { days } = firstHourStarts(byDate, raw, clock);
  // Start: the whole 8–10 Pick block passed before her first scan → 120 (the clock-in at 7:53
  // opens the shift, so the 7 minutes before 8:00 count too: 127). End: last scan 11:26, Pick
  // 3–4 closes the shift and she clocked out 3:53 → 53. Both over 50: most likely she was
  // moved and the board not updated, so both are "off board" and the total is 0.
  assert.deepEqual([days[0].lost, days[0].endGap, days[0].total, days[0].moved], [127, 53, 0, 180]);
});

test("a punched meal inside a gap is not counted, wherever the board had lunch", () => {
  // Pick 5am–1pm straight through; lunch punched 9:30–10:00; first pick 10:10.
  const roster = [row("A B", 0, 8, ["PICK", "PICK", "PICK", "PICK", "PICK", "PICK", "PICK", "PICK"])];
  const byDate = { "2026-09-22": { associates: roster } };
  const raw = [{ "Pick Date": "9/22/2026", Associate: "A B", "Min. First Scan": "10:10 AM", "Max. Last Scan": "12:58 PM" }];
  const clock = { "2026-09-22": { "A B": { clockIn: 9 * 60, clockOut: 13 * 60, mealOut: 9 * 60 + 30, mealIn: 10 * 60 } } };
  const { days } = firstHourStarts(byDate, raw, clock);
  // 9:00 → 10:10 is 70, less the 30-minute meal = 40: counted, and under the 50-minute "moved" line.
  assert.deepEqual([days[0].lost, days[0].startMoved, days[0].total], [40, false, 40]);
});

test("exactly 50 minutes counts; 51 is off board", () => {
  const roster = [row("A B", 0, 8, ["PICK", "PICK", "PICK", "PICK", "PICK", "PICK", "PICK", "PICK"]), row("C D", 0, 8, ["PICK", "PICK", "PICK", "PICK", "PICK", "PICK", "PICK", "PICK"])];
  const byDate = { "2026-09-22": { associates: roster } };
  const raw = [
    { "Pick Date": "9/22/2026", Associate: "A B", "Min. First Scan": "5:50 AM" },
    { "Pick Date": "9/22/2026", Associate: "C D", "Min. First Scan": "5:51 AM" },
  ];
  const clock = { "2026-09-22": { "A B": { clockIn: 5 * 60 }, "C D": { clockIn: 5 * 60 } } };
  const { people } = firstHourStarts(byDate, raw, clock);
  const by = Object.fromEntries(people.map((p) => [p.name, p]));
  assert.deepEqual([by["A B"].total, by["A B"].moved], [50, 0]);
  assert.deepEqual([by["C D"].total, by["C D"].moved], [0, 51]);
});

test("a trailing '30' cell or lunch does not stop a Pick block from ending the shift", () => {
  const roster = [row("A B", 0, 4, ["PICK", "PICK", "PICK", "PICK", "30"])];
  const [p] = scheduledPickers(roster);
  assert.equal(p.lastHourPick, true);
});

test("clockText", () => {
  assert.equal(clockText(13 * 60 + 5), "1:05 PM");
  assert.equal(clockText(5 * 60), "5:00 AM");
  assert.equal(clockText(null), "—");
});

// ── GTA parsing ──────────────────────────────────────────────────────────
const LOOKUP = JSON.stringify([
  { data: ['{"columnHeaders":",WIN,Full Name"}'] },
  { data: ["1124457~|~1124457", "211005480~|~<span>211005480</span>", "SMITH, ELIZABETH N~|~<span>x</span>"] },
  { data: ["3949220~|~3949220", "218750672~|~<span>218750672</span>", "SMITH, SHANE E~|~<span>x</span>"] },
  { data: ["12351518~|~12351518", "228758098~|~<span>228758098</span>", "SMITH, ANTHONY L~|~<span>x</span>"] },
]);

test("lookup rows parse and match on surname + first name", () => {
  const rows = parseLookupRows(LOOKUP);
  assert.equal(rows.length, 3);
  assert.deepEqual(matchLookup("Shane Smith", rows), { empId: "3949220", win: "218750672", gtaName: "SMITH, SHANE E" });
  assert.equal(matchLookup("SHAWN SMITH", rows), null);     // same initial, different name
  assert.equal(matchLookup("BOB JONES", rows), null);
  assert.equal(parseLookupRows("<html>500</html>").length, 0);
});

test("a first-name prefix match is used only when it is the only one", () => {
  const rows = parseLookupRows(LOOKUP);
  assert.equal(matchLookup("TONY SMITH", rows)?.empId, undefined);   // T: nobody
  assert.equal(matchLookup("ANT SMITH", rows)?.empId, "12351518");   // only Anthony
  assert.equal(matchLookup("ELIZABETHANN SMITH", rows)?.empId, "1124457");
});

const HTML = `
<tr id='tsRow0' class='tsOddRow'><td><span class="textMedium">ABRAHAM, STEYSHAWN - 229107070</span>
<div class="wb_tsschedhrsui" empid="12637072" workdate="${new Date(2026, 8, 22).getTime()}"></div>
<script>$(function() {$('#x').wb_tsclocks({name:'c_0',baseDate:'20260922',clocks:[{type:'1',time:'20260922130500',data:'g=34.9,-85.2&DKT=01458'},{type:'6',time:'20260922170300',data:'TCODE=MEAL'},{type:'6',time:'20260922180300',data:'TCODE=WRK'},{type:'2',time:'20260923003000',data:''}]});});</script>
<tr id="tsRow1" class="tsOddRow"><script>$('#y').wb_tsclocks({name:'c_1',baseDate:'20260923',clocks:[]});</script>`;

test("timesheet rows: first in, last out (past midnight), no location kept", () => {
  const [a, b] = parseTimesheetRows(HTML);
  assert.equal(a.date, "2026-09-22");
  assert.equal(a.empId, "12637072");
  assert.equal(a.win, "229107070");
  assert.equal(a.clockIn, 13 * 60 + 5);
  assert.equal(a.clockOut, 24 * 60 + 30);
  assert.deepEqual(a.punches.map((p) => `${p.kind}${p.code ? "/" + p.code : ""}`), ["in", "switch/MEAL", "switch/WRK", "out"]);
  assert.ok(!JSON.stringify(a).includes("34.9"));
  assert.equal(b.clockIn, null);
  assert.equal(b.date, "2026-09-23");
});

test("a middle name settles two people with the same first and last name", () => {
  const rows = [
    { empId: "1", win: "11", gtaName: "NGO, QUANG HIEN" },
    { empId: "2", win: "22", gtaName: "NGO, QUANG HIEP" },
  ];
  assert.equal(matchLookup("QUANG HIEN NGO", rows)?.empId, "1");
  assert.equal(matchLookup("QUANG NGO", rows), null);          // no middle name: still ambiguous
  const davis = [
    { empId: "3", win: "33", gtaName: "DAVIS, ELIZABETH A" },
    { empId: "4", win: "44", gtaName: "DAVIS, ELIZABETH K" },
  ];
  assert.equal(matchLookup("ELIZABETH DAVIS", davis), null);
  assert.equal(matchLookup("ELIZABETH K DAVIS", davis)?.empId, "4");
});
