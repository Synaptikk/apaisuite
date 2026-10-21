// node --test modules/digitalschedule/lib/fitclean.test.mjs
//
// 2026-10-21: the fitter queued changes the scheduler refuses (minor daily max 10004, minor
// start time 10007, school times 12024). Minors now get Polaris's limits up front, and
// fitClean checks the proposal with the validator and leaves refused people as saved.
import test from "node:test";
import assert from "node:assert/strict";
import { minorShiftOK, toMin, applyChanges } from "./coverage.js";
import { suggest } from "./suggest.js";
import { addHours } from "./addhours.js";
import { fitClean } from "./fitclean.js";

const DPS = "1-936-1451", ROLE = 1000271;
const DATES = ["2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"];
const shift = (di, start, end, lunch) => ({ day: DATES[di], start, end, job: DPS, breaks: lunch ? [{ start: lunch, end: `${String(+lunch.slice(0, 2) + 1).padStart(2, "0")}:${lunch.slice(3)}`, paid: false }] : [] });
const worker = (id, name, shifts, extra = {}) => ({ workerId: id, name, job: DPS, payType: "H", employmentType: "PARTTIME", minor: "NOT_MINOR",
  availability: { sat: "any", sun: "any", mon: "any", tue: "any", wed: "any", thu: "any", fri: "any" }, exceptions: [], shifts, otherEvents: [], ...extra });
// heavy guidance all day every day, so the fitter wants to stretch and start early
const demand = DATES.flatMap((d) => Array.from({ length: 24 }, (_, h) => ({ roleId: ROLE, start: `${d} ${String(h).padStart(2, "0")}:00:00`, fte: h >= 5 && h < 22 ? 4 : 0 })).filter((x) => x.fte));
const week = () => ({ dates: DATES, demand, workers: [
  worker(1, "Minor One", [shift(0, "09:00", "17:00", "13:00"), shift(2, "15:30", "21:00", null)], { minor: "MINOR" }),
  worker(2, "Minor Two", [shift(1, "14:00", "22:00", "18:00")], { minor: "MINOR" }),
  worker(3, "Adult Three", [shift(0, "10:00", "15:00", null)], { employmentType: "FULLTIME" }),
] });
const paidMin = (s) => toMin(s.end) - toMin(s.start) - (s.breaks || []).filter((b) => !b.paid).reduce((a, b) => a + toMin(b.end) - toMin(b.start), 0);

test("minorShiftOK matches what the validator accepted on 2026-10-21", () => {
  assert.ok(!minorShiftOK(toMin("08:00"), 540));    // 8:00-17:00 with lunch = 8 paid h → 10004
  assert.ok(minorShiftOK(toMin("08:30"), 510));     // 7.5 paid
  assert.ok(minorShiftOK(toMin("08:15"), 525));     // 7.75 paid
  assert.ok(!minorShiftOK(toMin("06:00"), 480));    // 6:00 start → 10007
  assert.ok(minorShiftOK(toMin("07:00"), 480));
});

test("fit + extra hours never give a minor more than 7.75 paid h or a start before 6:15", () => {
  const data = week();
  const out = suggest(data, { roleId: ROLE, jobs: [DPS], floorPct: 0 });
  const add = addHours(applyChanges(data, out.changes).data, { roleId: ROLE, jobs: [DPS], extra: 200 });
  const final = applyChanges(data, [...out.changes, ...add.changes]).data;
  for (const w of final.workers.filter((x) => x.minor === "MINOR")) for (const s of w.shifts) {
    assert.ok(toMin(s.start) >= 375, `${w.name} ${s.day} starts ${s.start}`);
    assert.ok(paidMin(s) <= 465, `${w.name} ${s.day} ${s.start}-${s.end} is ${paidMin(s) / 60} paid h`);
  }
  assert.ok([...out.changes, ...add.changes].some((c) => /Minor/.test(c.name)), "minors were still given legal changes");
});

test("fitClean leaves anyone the validator refuses as saved and fits again", async () => {
  const data = week();
  const calls = [];
  // pretend the scheduler knows a school-time rule for Minor One that the page can't see
  const validate = async (list) => {
    calls.push(list.length);
    return { applied: list, skipped: [], hard: list.some((c) => c.workerId === 1) ? [{ workerId: 1, name: "Minor One", code: 12024, message: "Shift(s) conflict with school times", type: "HARD" }] : [],
      newWarnings: [], preexistingHard: [] };
  };
  const r = await fitClean(data, { roleId: ROLE, jobs: [DPS], floorPct: 0 }, { roleId: ROLE, jobs: [DPS], extra: 40 }, validate);
  assert.ok(!r.error);
  assert.ok(r.changes.length > 0);
  assert.ok(!r.changes.some((c) => c.workerId === 1), "no change for the refused associate");
  assert.deepEqual(r.held.map((h) => h.name), ["Minor One"]);
  assert.ok(calls.length >= 2, "validated again after re-fitting");
  assert.equal(r.check.hard.length, 0);
});

test("fitClean locks people whose saved schedule already breaks a HARD rule", async () => {
  const data = week();
  const validate = async (list) => ({ applied: list, skipped: [], hard: [], newWarnings: [],
    preexistingHard: list.some((c) => c.workerId === 3) ? [{ workerId: 3, name: "Adult Three", code: 12024, message: "school", type: "HARD" }] : [] });
  const r = await fitClean(data, { roleId: ROLE, jobs: [DPS], floorPct: 0 }, null, validate);
  assert.ok(!r.changes.some((c) => c.workerId === 3));
  assert.match(r.held[0].why, /already on the saved schedule/);
});

test("fitClean queues nothing when the validator can't be reached", async () => {
  const r = await fitClean(week(), { roleId: ROLE, jobs: [DPS], floorPct: 0 }, null, async () => ({ error: "tab closed" }));
  assert.equal(r.error, "tab closed");
});
