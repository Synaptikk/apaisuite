// node --test modules/digitalschedule/lib/schedule.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { coverage, summarize, applyChanges, buildUndo, readbackMisses, toMin, IN_HOME_JOB } from "./coverage.js";
import { parseRules, unknownNames } from "./rules.js";
import { suggest } from "./suggest.js";
import { areaGaps, areaDelta, staggerLunches } from "./areas.js";

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
  const out = suggest(data, { roleId: ROLE, jobs: [DPS], rules: parseRules("pair: Pair One + Pair Two"), editableFrom: DATES[3], fill: false });
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

test("coverage: several roles sum their guidance; shifts count by job code", () => {
  const OTHER = 1000999, TA = "1-625-8210";
  const demand = [{ roleId: ROLE, start: `${DATES[0]} 10:00:00`, fte: 1 }, { roleId: OTHER, start: `${DATES[0]} 10:00:00`, fte: 2 }];
  const data = { dates: DATES, demand, workers: [worker("1", "A", [shift(0, "09:00", "12:00")]), worker("2", "B", [shift(0, "10:00", "11:00", null, TA)])] };
  assert.equal(coverage(data, ROLE, [DPS])[0].need[10], 1);
  const both = coverage(data, [ROLE, OTHER], [DPS, TA])[0];
  assert.equal(both.need[10], 3);
  assert.equal(both.have[10], 2);
  assert.equal(coverage(data, [OTHER], [TA])[0].have[9], 0);
});

test("areas: gaps between open and close, lunch with nobody else on, people counted by name", () => {
  const EL = "1-640-7410", area = { name: "Electronics", open: "06:00", close: "23:00", jobs: [EL], people: ["Jo Named"] };
  const data = { dates: DATES, demand: [], workers: [
    worker("1", "A", [shift(0, "06:00", "15:00", "10:00", EL)]),
    worker("2", "Jo Named", [shift(0, "14:00", "23:00", "18:00", DPS)]),
  ] };
  const d = areaGaps(data, area)[0];
  assert.deepEqual(d.gaps, [{ from: "10:00", to: "11:00", kind: "solo" }, { from: "18:00", to: "19:00", kind: "solo" }]);
  assert.equal(d.gapMin, 120);
  assert.equal(areaGaps(data, area)[1].gaps[0].kind, "nobody");
  // moving A's shift later opens 6a gap
  const after = applyChanges(data, [{ name: "A", workerId: "1", action: "edit", day: DATES[0], from: "06:00", start: "08:00", end: "17:00", lunch: "12:00" }]).data;
  const delta = areaDelta(data, after, [area])[0].days[0];
  assert.ok(delta.added.some((g) => g.from === "06:00" && g.to === "08:00" && g.kind === "nobody"));
});

test("suggest: never leaves an open-to-close area with nobody on the floor", () => {
  const EL = "1-640-7410", area = { name: "Electronics", open: "06:00", close: "15:00", jobs: [EL], people: [] };
  // guidance wants the 1 person 12p–9p; area needs someone 6a–3p
  const demand = demandFlat((d, h) => (d === DATES[4] && h >= 12 && h < 21 ? 1 : 0)).map((x) => ({ ...x, roleId: ROLE }));
  const data = { dates: DATES, demand, workers: [worker("1", "Solo", [shift(4, "06:00", "15:00", "10:00", EL)])] };
  const free = suggest(data, { roleId: ROLE, jobs: [EL], editableFrom: DATES[0], allowDayMoves: false });
  assert.ok(free.changes.length, "without the area rule the shift chases guidance");
  const held = suggest(data, { roleId: ROLE, jobs: [EL], editableFrom: DATES[0], allowDayMoves: false, areas: [area] });
  assert.equal(held.changes.filter((c) => c.start !== "06:00").length, 0);
  assert.ok(held.stats.areaGapHrsAfter <= held.stats.areaGapHrsBefore);
});

test("suggest: several roles are fitted each to its own guidance, not the pooled total", () => {
  const A = 1000001, B = 1000002, JA = "1-1-1", JB = "1-2-2";
  // A wants 1 person 6a–3p and has them 6a–3p; B wants 1 person 2p–11p and has nobody.
  const demand = demandFlat((d, h) => (d === DATES[4] && h >= 6 && h < 15 ? 1 : 0)).map((x) => ({ ...x, roleId: A }))
    .concat(demandFlat((d, h) => (d === DATES[4] && h >= 14 && h < 23 ? 1 : 0)).map((x) => ({ ...x, roleId: B })));
  const data = { dates: DATES, demand, workers: [worker("1", "Ann", [shift(4, "06:00", "15:00", "10:00", JA)])] };
  const opts = { roleId: [A, B], jobs: [JA, JB], editableFrom: DATES[0], allowDayMoves: false, protectWeekend: false, peak: [] };
  const pooled = suggest(data, opts);
  const split = suggest(data, { ...opts, roleJobs: { [A]: [JA], [B]: [JB] } });
  assert.equal(split.changes.length, 0, "A's associate must not be moved to cover B's hours");
  assert.equal(split.roles.find((r) => r.roleId === A).blueAfter, split.roles.find((r) => r.roleId === A).blueBefore);
  assert.ok(pooled.changes.length >= 0);
});

test("stagger lunches: two closers on lunch together get split so the area is never empty", () => {
  const EL = "1-640-7410", area = { name: "Electronics", open: "06:00", close: "23:00", jobs: [EL], people: [] };
  const data = { dates: DATES, demand: [], workers: [
    worker("1", "Opener", [shift(4, "06:00", "15:00", "10:00", EL)]),
    worker("2", "Closer A", [shift(4, "14:00", "23:00", "18:00", EL)]),
    worker("3", "Closer B", [shift(4, "14:00", "23:00", "18:00", EL)]),
  ] };
  assert.deepEqual(areaGaps(data, area)[4].gaps.map((g) => g.kind + " " + g.from), ["solo 10:00", "lunch 18:00"]);
  const out = staggerLunches(data, [area], { editableFrom: DATES[0] });
  const after = applyChanges(data, out.changes).data;
  const left = areaGaps(after, area)[4].gaps;
  assert.deepEqual(left.map((g) => g.from), ["10:00"], "the closers' shared lunch is split; the lone opener's lunch can't be");
  assert.ok(out.changes.every((c) => c.action === "edit" && c.start === "14:00" && c.end === "23:00"));
  const l = toMin(out.changes[0].lunch) - toMin("14:00");
  assert.ok(l >= 180 && l <= 240, "lunch stays 3–4 h in");
  // past days untouched
  assert.equal(staggerLunches(data, [area], { editableFrom: DATES[5] }).changes.length, 0);
});

test("suggest fill: a full-timer short of 40 gets added 9 h shifts on open days where guidance is short", () => {
  // guidance wants 1 person 08-17 every day, 0 over the 12:00 lunch; Flex (full-time, open availability) works only Sat + Sun
  const need = (d, h) => (h >= 8 && h < 17 && h !== 12 ? 1 : 0);
  const data = { dates: DATES, demand: demandFlat(need), workers: [
    worker(1, "Flex", [shift(0, "08:00", "17:00", "12:00"), shift(1, "08:00", "17:00", "12:00")]),
    worker(2, "Part", [], { employmentType: "PART_TIME" }),
  ] };
  const out = suggest(data, { roleId: ROLE, jobs: [DPS] });
  const adds = out.changes.filter((c) => c.action === "create");
  assert.equal(adds.filter((c) => c.name === "Flex").length, 3, "5 x 9 h = 40 paid, no 6th day");
  for (const c of adds) { assert.equal(toMin(c.end) - toMin(c.start), 540); assert.equal(c.job, DPS); assert.ok(c.lunch && c.lunch !== "none"); }
  assert.equal(adds.length, 5, "the part-timer covers the two weekdays Flex can't");
  const flex = out.hours.find((h) => h.name === "Flex");
  assert.equal(flex.before, 16); assert.equal(flex.after, 40);
  assert.equal(out.stats.added, 5);
  assert.equal(out.stats.blueAfter, 56);
});

test("suggest fill: no added shift where the graph is already covered (part-timer)", () => {
  const need = (d, h) => (d === DATES[2] && h >= 8 && h < 17 && h !== 12 ? 1 : 0);
  const data = { dates: DATES, demand: demandFlat(need), workers: [
    worker(1, "A", [shift(2, "08:00", "17:00", "12:00")], { employmentType: "PART_TIME" }),
    worker(2, "B", [shift(3, "08:00", "17:00", "12:00")], { employmentType: "PART_TIME" }),
  ] };
  const out = suggest(data, { roleId: ROLE, jobs: [DPS], allowDayMoves: false });
  assert.equal(out.changes.filter((c) => c.action === "create").length, 0);
});

test("suggest relay: never lowers blue hours, and the narrow associate ends on the slot they can work", () => {
  // Monday: guidance 1 person 06-12 and 1 person 16-22 (6 h shifts, no lunch). Narrow can only work 06-12
  // and is already there; Flex (any time) is also on 06-12. Flex has to go late.
  const need = (d, h) => (d === DATES[2] ? (h >= 6 && h < 12 ? 1 : 0) + (h >= 16 && h < 22 ? 1 : 0) : 0);
  const any = { sat: "any", sun: "any", mon: "any", tue: "any", wed: "any", thu: "any", fri: "any" };
  const data = { dates: DATES, demand: demandFlat(need), workers: [
    worker(1, "Flex", [shift(2, "06:00", "12:00", null)], { employmentType: "PART_TIME" }),
    worker(2, "Narrow", [shift(2, "06:00", "12:00", null)], { employmentType: "PART_TIME", availability: { ...any, mon: "06:00-12:00" } }),
  ] };
  for (const relay of [true, false]) {
    const out = suggest(data, { roleId: ROLE, jobs: [DPS], allowDayMoves: false, allowExtend: false, relay });
    assert.equal(out.stats.blueAfter, 12);
    assert.equal(out.changes.length, 1); assert.equal(out.changes[0].name, "Flex"); assert.equal(out.changes[0].start, "16:00");
  }
});

test("suggest rest: a Friday close (last week) pushes Saturday's open to 10 h rest, and is reported", () => {
  const need = (d, h) => (d === DATES[0] && h >= 8 && h < 17 && h !== 12 ? 1 : 0);
  const data = { dates: DATES, demand: demandFlat(need), workers: [worker(1, "Closer", [shift(0, "06:00", "15:00", "10:00")], { employmentType: "PART_TIME" })] };
  const out = suggest(data, { roleId: ROLE, jobs: [DPS], fill: false, neighbors: { 1: { prevEnd: -120 } } });   // Fri 22:00
  assert.equal(out.changes.length, 1); assert.equal(out.changes[0].start, "08:00");
  assert.deepEqual(out.turnarounds.map((t) => t.restH), [10]);
  const none = suggest(data, { roleId: ROLE, jobs: [DPS], fill: false });
  assert.equal(none.turnarounds.length, 0);
});
