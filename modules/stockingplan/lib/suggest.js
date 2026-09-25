// modules/stockingplan/lib/suggest.js
// Pure functions — no DOM, no chrome.*.
//
// Drafts a stocking plan in the shape store 1458 actually writes them, from
// tonight's freight and tonight's schedule. It is a first draft for a human to
// edit, never a decision — every line it moves says why it moved.
//
// ── Where the thresholds came from ────────────────────────────────────────
// 10 plans (2026-08-27 → 09-18) were joined to that date's per-department
// freight and schedule. Overnight utilisation — the overnight line hours
// divided by `Stocking ON TA` net hours — predicts what each plan did with
// the low-priority work almost perfectly:
//
//   util   date     what the plan did with 3/19/67 and D18
//   0.49   09-13    nothing pushed; Stock 1 just helps with D18
//   0.62   09-06    nothing pushed; Stock 1 does topstock only
//   0.74   09-12    nothing pushed
//   0.76   09-08    3/19/67 (2.5h) handed to Stock 1
//   0.79   09-16    3/19/67 (5h) + D18 (2h) handed to Stock 1
//   0.81   08-27    "stock 3/19/67 if needed" on Stock 1
//   0.82   09-17    D18 (~8.5h) handed to Stock 1
//   0.88   09-14    D18 pallets handed to Stock 1
//   0.91   09-18    3/19/67 (6h) + D18 (5h) handed to Stock 1, with associate
//                   counts, and "it's going to take another gear"
//
// So: above ~0.78 the night starts shedding work, below ~0.65 it absorbs
// everything and Stock 1 gets topstock.
//
// Stock 2 is a different shape — its freight lines run at 0.11–0.27 of its
// hours because unload/downstack is the bulk of that shift. The only decision
// it drives is the one the plans make on the lightest GM nights (09-13 at
// 0.13, 09-06 at 0.14): send Stock 2 to help zone and pick grocery, and pull
// the GM freight to the floor for overnight.

import { LINES, CATCH_ALL, BASELINE_HOURS, weigh, lineForDept } from "./lines.js";

// Overnight sheds work above this, and absorbs everything below EASY_UTIL.
export const PUSH_UTIL = 0.78;
export const EASY_UTIL = 0.65;
// Below this share of its own hours, Stock 2's GM list isn't a shift's work.
export const LIGHT_GM_UTIL = 0.15;
// Lines at or above this priority are the night's core — never pushed.
const CORE_PRIORITY = 80;

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * @param {object} plan     buildPlan() output
 * @param {object} opts     { medians } — observed line medians override the seeded ones
 * @returns suggestion object; `blocks` is what the draft renders from
 */
export function suggestPlan(plan, opts = {}) {
  const medians = opts.medians || BASELINE_HOURS;

  // ── 1. Freight, rolled into plan lines ─────────────────────────────────
  const byKey = new Map();
  const addTo = (key, task) => {
    const cur = byKey.get(key) || { key, hours: 0, cases: 0, bps: 0, depts: [] };
    cur.hours += task.hours;
    cur.cases += task.cases;
    cur.bps   += task.breakpacks;
    cur.depts.push(task.deptNbr);
    byKey.set(key, cur);
  };

  for (const t of plan.deptTasks || []) {
    addTo(lineForDept(t.deptNbr) || CATCH_ALL.key, t);
  }

  const defs = new Map([...LINES.map((l) => [l.key, l]), [CATCH_ALL.key, CATCH_ALL]]);
  const lines = [];
  for (const [key, agg] of byKey) {
    const def = defs.get(key);
    if (!def) continue;
    const hours = round1(agg.hours);
    const w = def.unweighed ? { word: null, ratio: null, median: null } : weigh(key, hours, medians);
    lines.push({
      key,
      label:     def.label,
      block:     def.block,
      order:     def.order ?? 50,
      priority:  def.priority,
      owner:     def.owner || null,
      depts:     agg.depts.sort((a, b) => a - b),
      hours,
      cases:     agg.cases,
      bps:       agg.bps,
      weight:    w.word,
      ratio:     w.ratio,
      median:    w.median,
      moved:     null,
    });
  }
  lines.sort((a, b) => b.priority - a.priority || b.hours - a.hours);

  // Lines with their own team (fresh, fashion) never enter the blocks.
  const owned   = lines.filter((l) => l.owner);
  const planned = lines.filter((l) => !l.owner);

  // ── 2. Capacity ────────────────────────────────────────────────────────
  const cap = plan.capacity || {};
  const capacity = {
    stock2: cap.stock2Hours || 0,
    stock3: cap.stock3Hours || 0,
    stock1: cap.nextStock1Hours ?? null,
  };

  const hoursIn = (block) =>
    round1(planned.filter((l) => l.block === block).reduce((s, l) => s + l.hours, 0));

  const notes = [];
  const moves = [];

  // ── 3. Stock 2: is the GM list even a shift's work? ────────────────────
  const s2Util = capacity.stock2 > 0 ? hoursIn("stock2") / capacity.stock2 : null;
  const lightGm = s2Util !== null && s2Util <= LIGHT_GM_UTIL;
  if (lightGm) {
    notes.push({
      block: "stock2",
      text: `GM is light tonight — ${hoursIn("stock2")}h against ${capacity.stock2}h on Stock 2. ` +
            `Worth sending them to help zone/pick grocery, and pulling the GM freight to the floor for overnight.`,
    });
  }

  // ── 4. Overnight: shed the low-priority lines until it fits ────────────
  const onUtil = () => (capacity.stock3 > 0 ? hoursIn("stock3") / capacity.stock3 : null);
  const startUtil = onUtil();

  if (capacity.stock3 > 0) {
    // Easy night — pull the seasonal float back in rather than leave it for
    // the morning ("stock D18 if call outs aren't an issue" — 09-15).
    if (startUtil !== null && startUtil < EASY_UTIL) {
      const d18 = planned.find((l) => l.key === "d18" && l.block === "stock1" && l.hours > 0);
      if (d18 && (hoursIn("stock3") + d18.hours) / capacity.stock3 < PUSH_UTIL) {
        d18.block = "stock3";
        d18.moved = "pulled-in";
        moves.push({
          line: d18.label, from: "stock1", to: "stock3",
          why: `overnight is only at ${Math.round(startUtil * 100)}% — room to take D18 tonight if call-outs don't bite`,
        });
      }
    }

    // Loaded night — hand the bottom of the list to the morning crew.
    let guard = 0;
    while (onUtil() > PUSH_UTIL && guard++ < LINES.length) {
      const pushable = planned
        .filter((l) => l.block === "stock3" && l.priority < CORE_PRIORITY && l.hours > 0)
        .sort((a, b) => a.priority - b.priority || a.hours - b.hours);
      const victim = pushable[0];
      if (!victim) break;
      const before = onUtil();
      victim.block = "stock1";
      victim.moved = "pushed";
      moves.push({
        line: victim.label, from: "stock3", to: "stock1",
        why: `overnight was at ${Math.round(before * 100)}% of its hours — ` +
             `${victim.hours}h of ${victim.label} is what the night sheds first`,
      });
    }
  }

  const finalUtil = onUtil();
  if (finalUtil !== null && finalUtil > PUSH_UTIL) {
    notes.push({
      block: "stock3",
      text: `Still at ${Math.round(finalUtil * 100)}% after handing everything movable to the morning — ` +
            `the food list alone doesn't fit. Expect leftovers and say so in the plan.`,
    });
  }

  // ── 5. Stock 1: can the morning actually take what it was handed? ──────
  const s1Hours = hoursIn("stock1");
  if (capacity.stock1 != null && capacity.stock1 > 0 && s1Hours > capacity.stock1 * PUSH_UTIL) {
    notes.push({
      block: "stock1",
      text: `The morning crew is being handed ${s1Hours}h against ${capacity.stock1}h. ` +
            `This is where tomorrow's salesfloor teams come in — see the backup list.`,
    });
  }

  // ── 6. Blocks ──────────────────────────────────────────────────────────
  const mod = plan.shifts?.modteam;
  const hasMcLane = !!(plan.trucks || []).some((t) => /mcl/i.test(t.type));

  const blocks = {
    stock2: {
      key: "stock2",
      title: "Stock 2",
      crew: plan.shifts?.stock2 || null,
      capacity: capacity.stock2,
      standing: ["Unload/downstack trucks"].concat(
        lightGm
          ? ["Help zone/pick grocery",
             "Pull all GM freight to the floor for overnight to stock"]
          : [],
      ),
      lines: planned.filter((l) => l.block === "stock2" && l.hours > 0),
    },
    stock3: {
      key: "stock3",
      title: "Overnight",
      crew: plan.shifts?.stock3 || null,
      capacity: capacity.stock3,
      standing: hasMcLane ? ["Stock McLanes"] : [],
      lines: planned.filter((l) => l.block === "stock3" && l.hours > 0),
    },
    modteam: {
      key: "modteam",
      title: "Mod Team",
      crew: mod || null,
      capacity: mod ? mod.workingHours : 0,
      scheduled: !!(mod && mod.count),
      standing: [],
      lines: [],
    },
    stock1: {
      key: "stock1",
      title: "Stock 1",
      crew: plan.nextShifts?.stock1 || null,
      capacity: capacity.stock1,
      // Freight only. The plans also give the morning crew a topstock round,
      // but topstock is not freight and nothing in CaseVisibility sizes it —
      // suggesting "A/E/J topstock" would be the module inventing work. The
      // sweep-up stays, because it IS freight, unless the catch-all line
      // already names it with hours.
      standing: planned.some((l) => l.key === CATCH_ALL.key && l.block === "stock1" && l.hours > 0)
        ? []
        : ["Clean up any remaining GM freight"],
      lines: planned.filter((l) => l.block === "stock1" && l.hours > 0),
    },
  };

  for (const b of Object.values(blocks)) {
    // Blocks read in the order the plans write them, not by size.
    b.lines.sort((a, c) => a.order - c.order);
    b.hours = round1(b.lines.reduce((s, l) => s + l.hours, 0));
    b.util  = b.capacity ? Math.round((b.hours / b.capacity) * 100) / 100 : null;
    // What the coach actually wants to see: hours on the clock, hours of
    // freight planned against them, and what is left for everything a plan
    // doesn't list — zoning, backroom, topstock, breaks in the flow.
    b.remaining = b.capacity == null ? null : round1(b.capacity - b.hours);
  }

  return {
    lines: planned,
    owned,
    blocks,
    moves,
    notes,
    utilisation: { stock2: s2Util, stock3: finalUtil, stock1: blocks.stock1.util },
    startingOvernightUtil: startUtil,
  };
}

/**
 * The suggestion as table assignments, so accepting it fills the plan table
 * and the existing Copy/Print/Outlook path. Department rows only — the areas
 * a line spans don't line up with area rows.
 */
export function suggestionAssignments(suggestion) {
  const out = new Map();
  for (const l of suggestion.lines) {
    if (!l.block || !l.hours) continue;
    for (const d of l.depts) out.set(`dept:D${d}`, { shift: l.block, names: [] });
  }
  return out;
}

/** One line of a draft: "Stock home-13 hours-heavy". */
export function lineText(line) {
  const parts = [`Stock ${line.label}`];
  if (line.hours) parts.push(`${line.hours} hours`);
  if (line.weight) parts.push(line.weight);
  return parts.join("-");
}
