// node --test modules/stockingplan/lib/tests/
//
// The freight numbers here are the real per-department minutes CaseVisibility
// returned for store 1458 on 2026-09-18 — the night the plan that was actually
// sent handed 3/19/67 and D18 to the morning crew and closed with "it's going
// to take another gear". If the suggester can't reproduce that call, it is
// wrong. Associate names are invented; the repo is public.

import { test } from "node:test";
import assert from "node:assert/strict";

import { suggestPlan, suggestionAssignments, lineText, PUSH_UTIL, EASY_UTIL } from "../suggest.js";
import { weigh, lineForDept, BASELINE_HOURS } from "../lines.js";
import { minsToHours } from "../compute.js";

// Real casesByDept minutes for 1458 on 2026-09-18.
const DEPT_MIN_0918 = {
  3: 157, 5: 109, 9: 154, 10: 167, 11: 277, 12: 130, 14: 378, 17: 159, 19: 173,
  20: 162, 22: 160, 49: 1, 67: 57, 71: 7, 72: 21, 74: 106, 87: 131,
  7: 163, 16: 57, 18: 96,
  90: 1010, 91: 700, 97: 318,
  92: 2120, 95: 1490,
  4: 300, 8: 780, 13: 560, 79: 240,
  2: 700, 40: 500, 46: 490,
  82: 30,
  80: 90, 93: 280, 94: 700, 98: 130,
  23: 208, 24: 21, 25: 48, 26: 84, 29: 51, 31: 9, 32: 14, 33: 52, 34: 45,
};

const AREA_OF = (d) => {
  if ([90, 91, 97].includes(d)) return "Frozen/Dairy/Deli";
  if ([80, 93, 94, 98].includes(d)) return "Meat/Produce/Fresh";
  if ([92, 95, 82].includes(d)) return "Food (Non-FDD)";
  if ([2, 4, 8, 13, 40, 46, 79].includes(d)) return "Consumables";
  if ([7, 16, 18, 56].includes(d)) return "Seasonal";
  if (d >= 23 && d <= 34) return "Fashion";
  return "General Merchandise";
};

function deptTasks(mins) {
  return Object.entries(mins).map(([d, m]) => ({
    key: `D${d}`, label: `D${d}`, area: AREA_OF(+d), deptNbr: +d, deptName: "",
    isFC: /Food|Consum|Frozen|Meat/.test(AREA_OF(+d)),
    cases: 0, breakpacks: 0, hours: minsToHours(m), cvMinutes: m,
  }));
}

// A plan model with just the bits suggestPlan reads.
function planWith({ mins = DEPT_MIN_0918, stock2 = 58.5, stock3 = 192, stock1 = 71, mod = 0, trucks = [] } = {}) {
  return {
    deptTasks: deptTasks(mins),
    trucks,
    shifts: {
      stock2:  { count: 8,  workingHours: stock2 },
      stock3:  { count: 24, workingHours: stock3 },
      modteam: { count: mod ? 3 : 0, workingHours: mod },
    },
    nextShifts: { stock1: { count: 9, workingHours: stock1 } },
    capacity: {
      stock2Hours: stock2, stock3Hours: stock3,
      modHours: mod, modCount: mod ? 3 : 0,
      nextStock1Hours: stock1, nextStock1Count: 9,
    },
  };
}

// ── line catalogue ──────────────────────────────────────────────────

test("departments map to the lines the store writes in", () => {
  assert.equal(lineForDept(7), "toys");
  assert.equal(lineForDept(11), "hardware");
  assert.equal(lineForDept(12), "hardware");        // paint travels with hardware
  assert.equal(lineForDept(14), "home");
  assert.equal(lineForDept(74), "home");
  assert.equal(lineForDept(20), null);              // Bath & Shower is not "home"
  assert.equal(lineForDept(92), "grocery");
  assert.equal(lineForDept(19), "craft");
  assert.equal(lineForDept(94), "fresh");
});

test("heavy/light reproduces the adjectives the plans used", () => {
  // "Stock 90/91/97-very light-only 15 hours"  (2026-09-15, D90+D91+D97 = 17.6h)
  assert.equal(weigh("fdd", 17.6).word, "very light");
  // "Stock 90/91/97-very heavy tonight"        (2026-09-16, 41.9h at ratio 1.16 —
  // the plan said "very heavy"; the module is deliberately a notch calmer)
  assert.equal(weigh("fdd", 41.9).word, "heavy");
  // "Stock grocery-very light-only 21 hours"   (2026-09-13, 30.9h)
  assert.equal(weigh("grocery", 30.9).word, "very light");
  // "Stock grocery-very heavy"                 (2026-09-15, 62.5h)
  assert.equal(weigh("grocery", 62.5).word, "heavy");
  // "Stock 4/8/13/79-extremely light"          (2026-09-13, 13.8h)
  assert.equal(weigh("chem", 13.8).word, "very light");
  // "also very heavy"                          (2026-09-15, 40.8h)
  assert.equal(weigh("chem", 40.8).word, "very heavy");
  // An ordinary night says nothing at all.
  assert.equal(weigh("grocery", BASELINE_HOURS.grocery).word, null);
  assert.equal(weigh("nosuchline", 10).word, null);
});

// ── allocation ──────────────────────────────────────────────────────

test("9-18: a loaded night hands 3/19/67 and D18 to the morning, like the real plan", () => {
  const s = suggestPlan(planWith());

  assert.ok(s.startingOvernightUtil > PUSH_UTIL,
    `overnight should start over ${PUSH_UTIL}, was ${s.startingOvernightUtil}`);

  const moved = s.moves.filter((m) => m.to === "stock1").map((m) => m.line);
  assert.ok(moved.includes("3/19/67"), `3/19/67 should be pushed, moved: ${moved}`);

  // D18 defaults to the morning and stays there on a night this loaded.
  const d18 = s.lines.find((l) => l.key === "d18");
  assert.equal(d18.block, "stock1");

  // The food core never moves, whatever the utilisation.
  for (const key of ["fdd", "grocery", "chem", "hba", "d82"]) {
    assert.equal(s.lines.find((l) => l.key === key).block, "stock3", `${key} must stay overnight`);
  }
  // Every move says why.
  for (const m of s.moves) assert.match(m.why, /overnight/);
});

test("a quiet night keeps everything, and takes D18 back off the morning", () => {
  // Same freight, a full crew and a light truck: overnight drops well under.
  const s = suggestPlan(planWith({ stock3: 320 }));
  assert.ok(s.startingOvernightUtil < EASY_UTIL,
    `should be an easy night, was ${s.startingOvernightUtil}`);
  assert.equal(s.lines.find((l) => l.key === "craft").block, "stock3");
  assert.equal(s.lines.find((l) => l.key === "d18").block, "stock3");
  assert.equal(s.moves.filter((m) => m.to === "stock1").length, 0);
  assert.match(s.moves.find((m) => m.to === "stock3").why, /room to take D18/);
});

test("when even the food list doesn't fit, it says so instead of inventing room", () => {
  const s = suggestPlan(planWith({ stock3: 90 }));
  assert.ok(s.utilisation.stock3 > PUSH_UTIL);
  assert.ok(s.notes.some((n) => n.block === "stock3" && /food list alone doesn't fit/.test(n.text)));
  // 3/19/67 has gone to the morning — it is the only thing the night sheds.
  assert.equal(s.lines.find((l) => l.key === "craft").block, "stock1");
  // Home stays overnight however bad it gets. 09-18 ran at 91% and still kept
  // home on the night crew; quietly handing 13h of home to a 9-person morning
  // crew would be a worse plan than one that admits it doesn't fit.
  assert.equal(s.lines.find((l) => l.key === "home").block, "stock3");
});

test("a light GM night sends Stock 2 to help grocery, like 9-06 and 9-13", () => {
  const light = { ...DEPT_MIN_0918, 7: 20, 9: 20, 10: 20, 11: 20, 12: 10, 16: 5, 56: 0 };
  const s = suggestPlan(planWith({ mins: light }));
  assert.ok(s.utilisation.stock2 <= 0.15);
  assert.ok(s.blocks.stock2.standing.some((x) => /zone\/pick grocery/.test(x)));
  assert.ok(s.blocks.stock2.standing.some((x) => /Pull all GM freight to the floor/.test(x)));
  assert.ok(s.notes.some((n) => n.block === "stock2"));
});

test("Stock 2 always unloads, and McLanes only shows when a McLane truck is on", () => {
  const plain = suggestPlan(planWith());
  assert.equal(plain.blocks.stock2.standing[0], "Unload/downstack trucks");
  assert.deepEqual(plain.blocks.stock3.standing, []);
  // Freight only — no topstock. Nothing in CaseVisibility sizes a topstock
  // round, so suggesting one would be the module inventing work.
  assert.ok(!plain.blocks.stock1.standing.some((x) => /topstock/i.test(x)));

  const mcl = suggestPlan(planWith({ trucks: [{ type: "MCL", totalCases: 300 }] }));
  assert.deepEqual(mcl.blocks.stock3.standing, ["Stock McLanes"]);
});

test("the Mod Team block follows the schedule, exactly as every plan in the sample did", () => {
  assert.equal(suggestPlan(planWith({ mod: 0 })).blocks.modteam.scheduled, false);
  assert.equal(suggestPlan(planWith({ mod: 24 })).blocks.modteam.scheduled, true);
});

test("fresh and fashion are left out — they have their own teams", () => {
  const s = suggestPlan(planWith());
  const owned = s.owned.map((l) => l.key).sort();
  assert.deepEqual(owned, ["fashion", "fresh"]);
  for (const l of s.lines) assert.equal(l.owner, null, l.key + " should not be an owned line");
  assert.ok(!s.blocks.stock3.lines.some((l) => l.key === "fresh"));
});

test("no department's freight is silently dropped", () => {
  const s = suggestPlan(planWith());
  const totalIn = Object.values(DEPT_MIN_0918).reduce((a, b) => a + b, 0) / 60;
  const totalOut = [...s.lines, ...s.owned].reduce((a, l) => a + l.hours, 0);
  assert.ok(Math.abs(totalIn - totalOut) < 1.5, `${totalIn} in vs ${totalOut} out`);
  // D5/D20/D71/D72/D87 have no line of their own — they land in the catch-all.
  const rest = s.lines.find((l) => l.key === "restgm");
  assert.ok(rest && rest.hours > 0);
  assert.equal(rest.block, "stock1");
});

test("the draft can be applied to the plan table as department assignments", () => {
  const s = suggestPlan(planWith());
  const a = suggestionAssignments(s);
  assert.equal(a.get("dept:D7").shift, "stock2");     // toys
  assert.equal(a.get("dept:D92").shift, "stock3");    // grocery
  assert.equal(a.get("dept:D19").shift, "stock1");    // 3/19/67, pushed
  assert.equal(a.get("dept:D94"), undefined);         // produce has its own team
});

test("a line reads the way the store writes it", () => {
  assert.equal(lineText({ label: "home", hours: 13, weight: null }), "Stock home-13 hours");
  assert.equal(lineText({ label: "grocery", hours: 62.5, weight: "heavy" }), "Stock grocery-62.5 hours-heavy");
});

test("each block reports available, planned and what is left", () => {
  const s = suggestPlan(planWith({ stock2: 58.5, stock3: 192, stock1: 71, mod: 24 }));

  const s2 = s.blocks.stock2;
  assert.equal(s2.capacity, 58.5);
  assert.equal(Math.round((s2.capacity - s2.hours) * 10) / 10, s2.remaining);
  assert.ok(s2.remaining > 0, "Stock 2 has room left over — unload is the bulk of that shift");

  // Overnight on 9-18 numbers is committed almost to the hour.
  const on = s.blocks.stock3;
  assert.equal(on.remaining, Math.round((192 - on.hours) * 10) / 10);
  assert.ok(on.remaining < s2.remaining);

  // The morning crew is reported against tomorrow's schedule.
  assert.equal(s.blocks.stock1.capacity, 71);
  assert.equal(s.blocks.stock1.remaining, Math.round((71 - s.blocks.stock1.hours) * 10) / 10);

  // Mod team has hours but no freight lines — remaining is just its hours.
  assert.equal(s.blocks.modteam.capacity, 24);
  assert.equal(s.blocks.modteam.remaining, 24);
});

test("remaining goes negative rather than pretending the hours exist", () => {
  const s = suggestPlan(planWith({ stock3: 90 }));
  assert.ok(s.blocks.stock3.remaining < 0, "overnight is oversubscribed at 90h");
});

test("with no next-day schedule, Stock 1 reports nothing rather than zero", () => {
  const p = planWith();
  p.nextShifts = null;
  p.capacity.nextStock1Hours = null;
  const s = suggestPlan(p);
  assert.equal(s.blocks.stock1.capacity, null);
  assert.equal(s.blocks.stock1.remaining, null);
});
