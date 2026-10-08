// node --test modules/punchlookup/lib/parse.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { decodePunch, parseTimesheetPage, parseDetails, planSearch, filterMatches } from "./parse.js";
import { reportCsv, reportText, summarize } from "./report.js";

// Shaped like the one-associate timesheet page (probed 2026-10-08), names made up.
const row = (n, date, sched, worked, codes, types, clocks) => `<tr id='tsRow${n}' class='tsOddRow'><td onclick='toggleIDB(1,${n});'></td>`
  + `<td class='wrksComments'><table class='nostyle'><tr><td></td></tr></table></td>`
  + `<td nowrap><span class='textMedium'><span class=''>${date.slice(5, 7)}/${date.slice(8)}/${date.slice(0, 4)}</span> Tue</span></td>`
  + `<td>${sched}</td><td>${worked}</td><td></td><td>${codes}</td><td>${types}</td>`
  + `<td><script>wb_tsclocks({name:'c_${n}',baseDate:'${date.replace(/-/g, "")}',editable:false,clocks:[${clocks}]});</script></td><td></td>`
  + `<td><span class='StringUIView nonEditable'>123456789</span></td><td>Confirmed</td></tr>`
  + `<input type='hidden' name='OVR_EMP_ID_${n}' value='555'><input type='hidden' name='OVR_WORK_DATE_${n}' value='${date.replace(/-/g, "")} 000000'>`;

const PAGE = `<div>Page 1 of 1</div><table>`
  + row(0, "2026-10-06", "", "", "", "", "")
  + row(1, "2026-10-07", "08:00", "07:54", "WRK 7:54 , MEAL 1:03", "REG 7:54", [
    "{type:'1',time:'20261007050400',data:'Actiontime=20261007050454&PN=Allspark&g=34.9300001,-85.2100001&DKT=01458&W=N&TZ=0'}",
    "{type:'6',time:'20261007101600',data:'Actiontime=20261007102704&PN=Allspark&AP=APUS-1458-016&DKT=01458&TCODE=MEAL~__20261007'}",
    "{type:'6',time:'20261007111900',data:'Actiontime=20261007111935&PN=Allspark&AP=APUS-1458-016&TCODE=WRK'}",
    "{type:'2',time:'20261007220300',data:'TZ=0'}",
    "{type:'2',time:'20261008000001',data:'ClockTag=P&ActionTime=20261007225741'}",
  ].join(","))
  + `</table>`;

test("timesheet page → days with punches and pay codes", () => {
  const pg = parseTimesheetPage(PAGE);
  assert.equal(pg.page, 1); assert.equal(pg.of, 1);
  assert.equal(pg.rows.length, 2);
  const [off, d] = pg.rows;
  assert.equal(off.date, "2026-10-06"); assert.equal(off.punches.length, 0); assert.equal(off.scheduled, null);
  assert.equal(d.index, 1); assert.equal(d.empId, "555"); assert.equal(d.win, "123456789");
  assert.equal(d.scheduled, "08:00"); assert.equal(d.worked, "07:54"); assert.equal(d.status, "Confirmed");
  assert.deepEqual(d.timeCodes, [{ code: "WRK", hours: "7:54" }, { code: "MEAL", hours: "1:03" }]);
  assert.deepEqual(d.punches.map((p) => p.label), ["In", "Meal start", "Meal end", "Out", "Carry-over out (midnight)"]);
  const [inn, meal, , out, split] = d.punches;
  assert.deepEqual(inn.gps, { lat: 34.9300001, lon: -85.2100001 });
  assert.equal(inn.exact, "05:04:54"); assert.equal(inn.app, "Allspark"); assert.equal(inn.other, "W=N TZ=0");
  assert.equal(meal.time, "10:16"); assert.equal(meal.exact, "10:27:04"); assert.equal(meal.accessPoint, "APUS-1458-016");
  assert.equal(out.keyed, true);
  assert.equal(split.system, true); assert.equal(split.exact, null); assert.equal(split.date, "2026-10-08");
});

test("decodePunch: unknown switch code", () => {
  assert.equal(decodePunch("6", "20261007120000", "TCODE=TRN").label, "Switch to TRN");
});

test("details → segments + de-duplicated flags", () => {
  const html = `<tr id='WRKS_INDEX_BLOCK_1' class='inlineDetailRow'><td><table>
    <tr><th>Start Time</th><th>End Time</th><th>Time Code</th><th>Hour Type</th><th>Job</th><th>Department</th><th>Division</th><th>Facility</th><th>Team</th></tr>
    <tr class='detail'><td>21:54</td><td>00:00</td><td>WRK</td><td>REG</td><td>01-7440</td><td>635</td><td>01</td><td>01458</td><td>01458-01-635</td></tr>
    <tr class='premium'><td>AT_EXTENDED_LATE_OUT</td><td>AT_UNPAID</td><td>01-7440</td><td>635</td><td>01</td><td>01458</td><td>01458-01-635</td></tr>
    <tr class='premium'><td>AT_EXTENDED_LATE_OUT</td><td>AT_UNPAID</td><td>01-7440</td><td>635</td><td>01</td><td>01458</td><td>01458-01-635</td></tr>
    <tr class='detail'><td>02:10</td><td>03:13</td><td>MEAL</td><td>UNPAID</td><td>01-7440</td><td>635</td><td>01</td><td><script>DS_0='x';</script></td><td>01458-01-635</td></tr>
    <tr class='premium'><td></td><td></td><td>AT_WORKED_NOT_SCHED</td><td>AT_UNPAID</td><td>01-7440</td><td>635</td><td>01</td><td>01458</td><td>01458-01-635</td></tr>
  </table></td></tr>`;
  const d = parseDetails(html);
  assert.deepEqual(d.segments, [
    { start: "21:54", end: "00:00", timeCode: "WRK", hourType: "REG", job: "01-7440", dept: "635", division: "01", facility: "01458", team: "01458-01-635" },
    { start: "02:10", end: "03:13", timeCode: "MEAL", hourType: "UNPAID", job: "01-7440", dept: "635", division: "01", facility: "", team: "01458-01-635" },
  ]);
  assert.deepEqual(d.flags, [{ code: "AT_EXTENDED_LATE_OUT", hourType: "AT_UNPAID" }, { code: "AT_WORKED_NOT_SCHED", hourType: "AT_UNPAID" }]);
});

test("search plan: WIN, longest word, every word must match", () => {
  assert.deepEqual(planSearch("123456789"), { by: "win", term: "123456789", words: [] });
  const p = planSearch("brook aber");
  assert.equal(p.term, "BROOK");
  const rows = [{ gtaName: "BROOKS, ALISSA" }, { gtaName: "ABERNATHY, BROOKLYN M" }];
  assert.deepEqual(filterMatches(rows, p).map((r) => r.gtaName), ["ABERNATHY, BROOKLYN M"]);
  assert.equal(planSearch(" a "), null);
});

test("report: summary, text and CSV cover every punch", () => {
  const days = parseTimesheetPage(PAGE).rows.map((r) => ({ ...r, segments: [], flags: [] }));
  const data = { from: "2026-10-06", to: "2026-10-07", days, person: { gtaName: "DOE, JANE", win: "123456789" } };
  const s = summarize(data);
  assert.equal(s.punches, 4); assert.equal(s.meals, 1); assert.equal(s.keyed, 1); assert.equal(s.withGps, 1); assert.equal(s.worked, "7:54");
  assert.equal(reportCsv(data).split("\r\n").length, 1 + 5);               // header + 5 punches; day off hidden
  assert.equal(reportCsv(data, { hideEmpty: false, hideCarry: true }).split("\r\n").length, 1 + 1 + 4);
  assert.match(reportText(data), /Meal start\s+pressed 10:27:04/);
});
