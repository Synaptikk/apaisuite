// node --test modules/digitaldashboard/lib/tests/break_log.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mergeBreakLog, breakLogDay, episodeMinutes, breakLogDays, clockToMs, withMeals, watchWithMeals, BREAK_LOG_KEEP_DAYS } from "../break_log.js";
import { parseCommand, formatBreakLog, formatBreaks, formatHelp } from "../commands.js";

const at = (h, m = 0, day = 9) => new Date(2026, 9, day, h, m);
const sus = (name, lastSeenMin, idleMin, over = true) => ({ name, lastSeen: lastSeenMin, location: "A1", idleMin, over });
const watch = (now, suspects) => ({ checkedAt: now.toISOString(), limitMin: 18, scheduledCount: 4, suspects });
const DAY = "2026-10-09";

function run(steps) {
  let log = null;
  for (const [now, suspects] of steps) log = mergeBreakLog(log, watch(now, suspects), now);
  return log;
}

test("one episode per stretch: opens, extends, clears when they drop off", () => {
  // Avery last picked 11:42, flagged from 12:01, back by the 12:31 run
  const out = 11 * 60 + 42;
  const log = run([
    [at(12, 1), [sus("Avery Sample", out, 19)]],
    [at(12, 4), [sus("Avery Sample", out, 22)]],
    [at(12, 28), [sus("Avery Sample", out, 46)]],
    [at(12, 31), []],
  ]);
  const eps = breakLogDay(log, DAY, at(12, 31));
  assert.equal(eps.length, 1);
  const e = eps[0];
  assert.equal(e.status, "cleared");
  assert.equal(e.lastSeenActiveAt, at(11, 42).getTime());
  assert.equal(e.firstFlaggedAt, at(12, 1).getTime());
  assert.equal(e.lastFlaggedAt, at(12, 28).getTime());
  assert.equal(e.cleared, at(12, 31).getTime());
  assert.equal(e.longestMin, 46);
  assert.equal(episodeMinutes(e), 49);
});

test("a new last pick is a new stretch; under-limit suspects never log", () => {
  const log = run([
    [at(10, 0), [sus("Blake Sample", 9 * 60 + 40, 20), sus("Casey Sample", 9 * 60 + 55, 5, false)]],
    [at(10, 3), [sus("Blake Sample", 9 * 60 + 40, 23)]],
    // Blake picked between runs and went out again
    [at(10, 6), [sus("Blake Sample", 9 * 60 + 45, 21)]],
  ]);
  const eps = breakLogDay(log, DAY, at(10, 6));
  assert.deepEqual(eps.map((e) => [e.name, e.status]), [["Blake Sample", "cleared"], ["Blake Sample", "open"]]);
  assert.equal(eps[0].cleared, at(10, 3).getTime(), "closed at its last flag, not guessed later");
  assert.equal(eps[1].lastSeenActiveAt, at(9, 45).getTime());
});

test("a long silence closes at the last flag; same last pick after a gap continues", () => {
  const log = run([
    [at(14, 0), [sus("Drew Sample", 13 * 60 + 30, 30), sus("Emery Sample", 13 * 60 + 20, 40)]],
    // 45 min with no runs (daemon restart); Drew still out on the same last pick, Emery gone
    [at(14, 45), [sus("Drew Sample", 13 * 60 + 30, 75)]],
  ]);
  const eps = breakLogDay(log, DAY, at(14, 45));
  const drew = eps.find((e) => e.name.startsWith("Drew"));
  const emery = eps.find((e) => e.name.startsWith("Emery"));
  assert.equal(eps.length, 2);
  assert.equal(drew.status, "open");
  assert.equal(drew.longestMin, 75);
  assert.equal(emery.status, "cleared");
  assert.equal(emery.cleared, at(14, 0).getTime());
});

test("stale opens settle on read; old results are ignored; day boundary and pruning", () => {
  let log = run([[at(21, 30), [sus("Finley Sample", 21 * 60 + 5, 25)]]]);
  // read an hour later with no further runs → shown cleared at the last flag
  const late = breakLogDay(log, DAY, at(22, 30));
  assert.equal(late[0].status, "cleared");
  assert.equal(late[0].cleared, at(21, 30).getTime());
  // an older watch result does not rewrite the log
  assert.equal(mergeBreakLog(log, watch(at(21, 0), []), at(21, 0)), log);
  // 4:30 AM still belongs to the 10-09 board day; 6 AM opens 10-10 and settles 10-09
  log = mergeBreakLog(log, watch(at(6, 0, 10), [sus("Gray Sample", 5 * 60 + 30, 30)]), at(6, 0, 10));
  assert.deepEqual(breakLogDays(log), ["2026-10-10", DAY]);
  assert.equal(log.days[DAY][0].status, "cleared");
  assert.equal(log.days["2026-10-10"][0].status, "open");
  // two months on, 10-09 and 10-10 are pruned
  const later = new Date(at(12, 0, 10).getTime() + (BREAK_LOG_KEEP_DAYS + 2) * 24 * 3600_000);
  log = mergeBreakLog(log, watch(later, []), later);
  assert.deepEqual(breakLogDays(log).length, 1);
});

test("clockToMs: a clock time after now belongs to the day before", () => {
  assert.equal(clockToMs(11 * 60 + 42, at(12, 0)), at(11, 42).getTime());
  assert.equal(clockToMs(23 * 60 + 50, at(0, 10)), at(23, 50, 8).getTime());
});

test("!breaklog parses and formats one line per episode", () => {
  assert.equal(parseCommand("!breaklog"), "breaklog");
  assert.equal(parseCommand("!Break log"), "breaklog");
  assert.equal(parseCommand("!long breaks"), "breaklog");
  assert.match(formatHelp(), /!breaklog/);

  const log = run([
    [at(12, 1), [sus("Avery Sample", 11 * 60 + 42, 19)]],
    [at(12, 28), [sus("Avery Sample", 11 * 60 + 42, 46)]],
    [at(12, 31), []],
    [at(13, 34), [sus("Blake Sample", 13 * 60 + 5, 29)]],
    [at(13, 37), [sus("Blake Sample", 13 * 60 + 5, 32)]],
  ]);
  const text = formatBreakLog(breakLogDay(log, DAY, at(13, 37)), DAY, at(13, 37));
  assert.equal(text, [
    "Long breaks Fri, 10/9 — 2 logged over 18 min, 1 still out (as of 1:37 PM):",
    "• Avery Sample · out 11:42am → back 12:31pm (49 min)",
    "• Blake Sample · still out since 1:05pm (32 min)",
  ].join("\n"));
  assert.match(formatBreakLog([], DAY, at(9, 0)), /none logged over 18 min/);
});

test("withMeals: lunches, the 4-min walk each way, the 45-min punch check, a twice-logged stretch", () => {
  const ep = (name, out, back, extra = {}) => ({ name, lastSeenActiveAt: at(...out).getTime(), firstFlaggedAt: at(...out).getTime() + 20 * 60_000,
    lastFlaggedAt: at(...back).getTime(), cleared: at(...back).getTime(), status: "cleared", longestMin: 20, ...extra });
  const read = at(23).getTime();
  const punches = {
    "AVERY STONE": { clockIn: 7 * 60, mealOut: 12 * 60 + 4, mealIn: 13 * 60 + 5, clockOut: 16 * 60, _at: read },
    "BLAKE RIVERS": { clockIn: 9 * 60, mealOut: 13 * 60, mealIn: 14 * 60, clockOut: 18 * 60, _at: read },
    "CASEY MOON": { clockIn: 13 * 60, mealOut: null, mealIn: null, clockOut: 18 * 60, _at: read },
    "ELLIS GREY": { clockIn: 7 * 60, mealOut: 12 * 60 + 4, mealIn: 13 * 60 + 4, clockOut: 16 * 60, _at: read },
    "FINN LAKE": { clockIn: 7 * 60, mealOut: null, mealIn: null, clockOut: null, _at: at(9).getTime() },
  };
  const out = withMeals([
    ep("Avery Stone", [11, 57], [13, 13]),          // 7 before punch-out, 8 after punch-in → 3 + 1 past the walk
    ep("Ellis Grey", [12, 2], [13, 9]),             // 2 before, 5 after → a plain lunch
    ep("Blake Rivers", [12, 40], [14, 10]),         // 90 min, 60 meal → 30 net, still a break
    ep("Casey Moon", [17, 30], [18, 5]),            // 35 min, 5 after clock-out → 30 net
    ep("Casey Moon", [17, 30], [18, 5]),            // logged twice → folded
    ep("Drew Park", [15, 0], [15, 30]),             // no punches, under 45 → still reported
    ep("Finn Lake", [14, 0], [15, 0]),              // 60 min, punches read at 9 AM → held
    ep("Gale Hart", [14, 0], [15, 0]),              // 60 min, no punches at all → held
  ], punches, DAY, { limitMin: 18 });
  assert.equal(out.length, 7);
  const by = Object.fromEntries(out.map((e) => [e.name, e]));
  assert.deepEqual([by["Avery Stone"].kind, by["Avery Stone"].beforeMin, by["Avery Stone"].afterMin, by["Avery Stone"].lunchOverMin], ["lunch-over", 7, 8, 4]);
  assert.deepEqual(by["Avery Stone"].meal, [12 * 60 + 4, 13 * 60 + 5]);
  assert.deepEqual([by["Ellis Grey"].kind, by["Ellis Grey"].lunchOverMin], ["lunch", 0]);
  assert.deepEqual([by["Blake Rivers"].kind, by["Blake Rivers"].netMin], ["break", 30]);
  assert.deepEqual([by["Casey Moon"].offClockMin, by["Casey Moon"].netMin], [5, 30]);
  assert.equal(by["Drew Park"].kind, "unchecked");
  assert.equal(by["Finn Lake"].kind, "unverified");
  assert.equal(by["Gale Hart"].kind, "unverified");
  // once a late-enough read shows no lunch, it is a long break
  const again = withMeals([ep("Finn Lake", [14, 0], [15, 0])], { "FINN LAKE": { ...punches["FINN LAKE"], _at: read } }, DAY, { limitMin: 18 });
  assert.equal(again[0].kind, "break");

  const text = formatBreakLog(out, DAY, at(19));
  assert.doesNotMatch(text, /Ellis|Finn|Gale/);
  assert.match(text, /Avery Stone · lunch .*7 min from last pick to punching out, 8 from punching back in to picking — 4 min past/);
  assert.match(text, /Blake Rivers .*30 min, not counting 60 min lunch/);
  assert.match(text, /1 punched lunch left out/);
  assert.match(text, /2 over 45 min held until their lunch punch is checked/);
});

test("watchWithMeals: on lunch is held, over 45 min is held until a late read", () => {
  const now = at(13, 0);
  const w = { limitMin: 18, scheduledCount: 3, suspects: [
    { name: "Avery Stone", lastSeen: 12 * 60 - 3, idleMin: 63, over: true },     // on lunch since 12:04
    { name: "Finn Lake", lastSeen: 12 * 60 - 3, idleMin: 63, over: true },       // no read since 9
    { name: "Blake Rivers", lastSeen: 12 * 60 + 30, idleMin: 30, over: true },   // under 45, reported
  ] };
  const punches = {
    "AVERY STONE": { clockIn: 7 * 60, mealOut: 12 * 60 + 4, mealIn: null, clockOut: null, _at: now.getTime() },
    "FINN LAKE": { clockIn: 7 * 60, mealOut: null, mealIn: null, clockOut: null, _at: at(9).getTime() },
  };
  const r = watchWithMeals(w, punches, DAY, { limitMin: 18, now });
  const by = Object.fromEntries(r.suspects.map((s) => [s.name, s]));
  assert.deepEqual([by["Avery Stone"].over, by["Avery Stone"].held], [false, "lunch"]);
  assert.deepEqual([by["Finn Lake"].over, by["Finn Lake"].held], [false, "unverified"]);
  assert.equal(by["Blake Rivers"].over, true);
  assert.match(formatBreaks(r, now), /Blake Rivers[\s\S]*1 on a punched lunch · 1 over 45 min held/);
});
