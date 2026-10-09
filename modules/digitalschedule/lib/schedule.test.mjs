// node --test modules/digitalschedule/lib/schedule.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { coverage, summarize, applyChanges, buildUndo, readbackMisses, toMin, IN_HOME_JOB } from "./coverage.js";
import { parseRules, unknownNames } from "./rules.js";
import { suggest } from "./suggest.js";

const DPS = "1-936-1451", ROLE = 1000271;
const DATES = ["2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"];
const shift = (di, start, end, lunch, job = DPS) => ({ day: DATES[di], start, end, job, breaks: lunch ? [{ start: lunch, end: `${String(+lunch.slice(0, 2) + 1).padStart(2, "0")}:${lunch.slice(3)}`, paid: false }] : [] });
const worker = (id, name, shifts, extra = {}) => ({ workerId: id, name, job: DPS, payType: "H", employmentType: "FULL_TIME", minor: null,
  availability: { sat: "any", sun: "any", mon: "any", tue: "any", wed: "any", thu: "any", fri: "any" }, exceptions: [], shifts, otherEvents: [], ...extra });
const demandFlat = (perHour) => DATES.flatMap((d) => Array.from({ length: 24 }, (_, h) => perHour(d, h)).map((fte, h) => ({ roleId: ROLE, start: `${d} ${String(h).padStart(2, "0")}:00:00`, fte })).filter((x) => x.fte));

test("coverage counts 15-minute slots outside unpaid lunch", () => {
  const data = { dates: DATES, demand: demandFlat((d, h) => (d === DATES[0] && h >= 8 && h < 17 ? 1 : 0)),
    workers: [worker(1, "A", [shift(0, "08:00", "17:00", "12:00")]), worker(2, "B", [shift(0, "08:30", "09:30", null)])] };
  const [sat] = coverage(data, ROLE, [DPS]);
  assert.equal(sat.have[8], 1.5);  // A full hour + B 08:30-09:00
  assert.equal(sat.have[9], 1.5);   // A + B 09:00-09:30
  assert.equal(sat.have[12], 0);   // lunch
  assert.equal(sat.have[16], 1);
  const s = summarize(coverage(data, ROLE, [DPS]))[0];
  assert.equal(s.blue, 6);         // 10, 11, 13..16
  assert.equal(s.under, 1);        // 12
  assert.equal(s.over, 2);         // 8, 9
});

test("applyChanges edit / move / delete / create, and buildUndo inverts", () => {
  const data = { dates: DATES, demand: [], workers: [worker(1, "A", [shift(2, "08:00", "17:00", "12:00"), shift(3, "08:00", "17:00", "12:00")])] };
  const changes = [
    { name: "A", action: "edit", day: DATES[2], from: "08:00", start: "10:00", end: "19:00", lunch: "14:00" },
    { name: "A", action: "move", day: DATES[3], from: "08:00", toDay: DATES[4], start: "07:00", end: "16:00" },
    { name: "A", action: "create", day: DATES[5], start: "09:00", end: "13:00" },
  ];
  const { data: out, problems } = applyChanges(data, changes);
  assert.deepEqual(problems, []);
  const by = Object.fromEntries(out.workers[0].shifts.map((s) => [s.day, s]));
  assert.equal(by[DATES[2]].start, "10:00"); assert.equal(by[DATES[2]].breaks[0].start, "14:00");
  assert.ok(!by[DATES[3]]); assert.equal(by[DATES[4]].start, "07:00");
  assert.equal(by[DATES[4]].breaks[0].start, "11:00");  // old lunch slides with the shift
  assert.equal(by[DATES[5]].end, "13:00");
  assert.equal(data.workers[0].shifts.length, 2, "input untouched");

  const applied = [
    { name: "A", workerId: 1, action: "edit", orig: { day: DATES[2], start: "08:00", end: "17:00", breaks: [] }, next: { day: DATES[2], start: "10:00", end: "19:00" } },
    { name: "A", workerId: 1, action: "delete", orig: { day: DATES[6], start: "08:00", end: "12:00", job: DPS, breaks: [] }, next: null },
  ];
  const undo = buildUndo(applied);
  assert.equal(undo[0].action, "edit"); assert.equal(undo[0].from, "10:00"); assert.equal(undo[0].start, "08:00");
  assert.equal(undo[1].action, "create"); assert.equal(undo[1].day, DATES[6]);
  assert.deepEqual(readbackMisses(applied, { 1: [{ day: DATES[2], start: "10:00", end: "19:00" }] }), []);
  assert.equal(readbackMisses(applied, { 1: [] }).length, 1);
});

test("rules parse, report bad lines and unknown names", () => {
  const r = parseRules(`# comment
pair: A One + B Two
fixed: C Three 11:00-20:00
days: D Four sat,sun
window: E Five weekday 00:00-15:00
window: E Five mon-wed 06:00-24:00
nodaymove: F Six
keep: G Seven
nonsense here`);
  assert.equal(r.pairs.length, 1); assert.deepEqual(r.fixed.get("c three"), [660, 1200]);
  assert.deepEqual(r.daysOnly.get("d four"), [0, 1]); assert.deepEqual(r.windows.get("e five")[1].days, [2, 3, 4]);
  assert.deepEqual(r.windows.get("e five")[1].hi, 1440);
  assert.equal(r.errors.length, 1);
  assert.deepEqual(unknownNames(r, [{ name: "A One" }]).sort(), ["b two", "c three", "d four", "e five", "f six", "g seven"]);
});

test("suggest: whole-hour starts, lunch 3-4 h in, weekends untouched, past days and In Home kept, pairs move together", () => {
  // guidance wants 2 people 06-15 every day; everyone is scheduled 13-22
  const need = (d, h) => (h >= 6 && h < 15 ? 2 : 0);
  const late = (di) => shift(di, "13:00", "22:00", "17:00");
  const data = { dates: DATES, demand: demandFlat(need), workers: [
    worker(1, "Sat Person", [late(0)]),
    worker(2, "Past Person", [late(2)]),
    worker(3, "Pair One", [late(4)]), worker(4, "Pair Two", [late(4)]),
    worker(5, "Driver", [shift(5, "13:00", "22:00", "17:00", IN_HOME_JOB)], { job: IN_HOME_JOB }),
    worker(6, "Solo", [late(6)]),
  ] };
  const out = suggest(data, { roleId: ROLE, jobs: [DPS], rules: parseRules("pair: Pair One + Pair Two"), editableFrom: DATES[3] });
  const by = (n) => out.changes.filter((c) => c.name === n);
  for (const c of out.changes) {
    assert.equal(toMin(c.start) % 60, 0, "whole-hour start");
    if (c.lunch && c.lunch !== "none") { const off = toMin(c.lunch) - toMin(c.start); assert.ok(off >= 180 && off <= 240, `lunch ${off} min in`); }
    assert.ok(c.day >= DATES[3] && (c.toDay || c.day) >= DATES[3], "past days untouched");
  }
  assert.equal(by("Sat Person").every((c) => c.action === "edit"), true, "weekend shift never leaves its day");
  assert.equal(by("Past Person").length, 0);
  assert.equal(by("Driver").length, 0);
  const p1 = by("Pair One"), p2 = by("Pair Two");
  assert.equal(p1.length, 1); assert.equal(p2.length, 1);
  assert.equal(p1[0].start, p2[0].start); assert.equal(p1[0].toDay, p2[0].toDay);
  assert.ok(toMin(by("Solo")[0].start) < 13 * 60, "moved toward the morning guidance");
  assert.ok(out.stats.blueAfter >= out.stats.blueBefore);
});

// ── schedule assistant tools ────────────────────────────────────────────────
import { buildSystem, runTool, TOOLS } from "./assistant.js";

function fakeCtl(data) {
  let q = [];
  return { data: () => data, queue: () => q, setQueue: (n) => { q = n; }, roleId: () => ROLE, jobs: () => [DPS], rulesText: () => "pair: A + B",
    fitOpts: () => ({ roleId: ROLE, jobs: [DPS], editableFrom: DATES[0] }), validate: async () => ({ applied: q.map(() => ({})), skipped: [], hard: [], newWarnings: [], preexistingWarnings: 2 }) };
}

test("assistant: system prompt carries roster, rules, no-save rule; tools queue by exact roster name", async () => {
  const data = { ctx: { store: "9999", wk: 40, site: "X" }, dates: DATES, demand: demandFlat((d, h) => (h >= 8 && h < 17 ? 1 : 0)),
    workers: [worker(1, "Pat Doe", [shift(2, "08:00", "17:00", "12:00")]), worker(2, "Lee Roe", [shift(5, "13:00", "22:00", "17:00", "9-999")])] };
  const ctl = fakeCtl(data);
  const sys = buildSystem(ctl);
  assert.match(sys, /Pat Doe \(id 1/); assert.doesNotMatch(sys, /Lee Roe/, "only the role's people are inlined");
  assert.match(sys, /pair: A \+ B/); assert.match(sys, /cannot save/);
  assert.ok(TOOLS.every((t) => !/save/i.test(t.name)), "no save tool");

  const found = await runTool("find_associates", { query: "lee" }, ctl);
  assert.match(found.text, /Lee Roe/);

  const r = await runTool("queue_changes", { changes: [
    { name: "pat doe", action: "edit", day: "mon", from: "08:00", start: "09:00", end: "18:00", lunch: "13:00" },
    { name: "Nobody Here", action: "delete", day: "mon", from: "08:00" },
    { name: "Pat Doe", action: "delete", day: "tue", from: "08:00" },
  ] }, ctl);
  assert.equal(ctl.queue().length, 1);
  assert.deepEqual({ ...ctl.queue()[0] }, { name: "Pat Doe", workerId: 1, action: "edit", day: DATES[2], from: "08:00", start: "09:00", end: "18:00", lunch: "13:00", expectEnd: "17:00", job: DPS });
  assert.match(r.text, /NOT queued/); assert.match(r.text, /Nobody Here/); assert.match(r.text, /shift not found/);
  assert.match((await runTool("check_with_scheduler", {}, ctl)).text, /^CLEAN/);
  await runTool("remove_queued", { all: true }, ctl);
  assert.equal(ctl.queue().length, 0);
});
