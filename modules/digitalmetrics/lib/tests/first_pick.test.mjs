import { test } from "node:test";
import assert from "node:assert/strict";
import { firstHourPickers, clockInCandidates, firstHourStarts, clockText } from "../data/first_pick.js";
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
  assert.deepEqual(clockInCandidates({ "2026-09-22": { associates: roster } }), ["SHANE SMITH"]);
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
    date: "2026-09-22", name: "SHANE SMITH", schedStart: 780, clockIn: 785, firstPick: 808,
    clockLate: 5, clockToPick: 23, lost: 28,
  });
  assert.equal(people[0].totalLost, 28);
  assert.equal(totals.lateClockDays, 1);
});

test("early clock-in, missing scan, and a scan hours later are handled", () => {
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
  assert.equal(by["A B"].lost, 4);
  assert.equal(by["C D"].firstPick, null);
  assert.equal(by["C D"].lost, null);
  assert.equal(by["E F"], undefined);                       // 4.5h later: not a late start
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
