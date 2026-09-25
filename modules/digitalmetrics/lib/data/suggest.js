// modules/digitalmetrics/lib/data/suggest.js
//
// Suggested tasks for the Assignments grid, learned from saved grids. Pure.
//
// ── Why this exists (2026-09-23) ───────────────────────────────────────────
// The grid has always READ stores/{store}/suggestions/{date}, but nothing in
// the suite writes it: whatever generated those documents in the standalone
// app was not ported. And the stored shape is keyed by name TOKEN while the
// grid looks suggestions up by NAME, so even an old document would be pruned
// to nothing. Every day's grid therefore showed no suggestions. They are now
// computed here, in the view, from the same dailyAssignments history the
// Associates tab already reads.
//
// Rule: for each empty in-shift hour, the task this associate did in that hour
// on past grids — their own rows only, matched by exact name (a first-name
// fallback would borrow someone else's habits). Same-weekday days count
// double, since a Tuesday plan resembles last Tuesday more than last Sunday.
// A suggestion needs the task on MIN_DAYS actual days and at least MIN_SHARE of
// the (weighted) days they worked that hour.

import { isLeadership } from "./grid.js";
import { lunchWindow } from "./lunch.js";

const MIN_DAYS = 2;
const MIN_SHARE = 0.5;
const SAME_WEEKDAY_WEIGHT = 2;
/** Break/lunch codes are placed by rule (lunch.js, adherence.js), not by habit. */
const NOT_SUGGESTED = new Set(["B"]);

const weekday = (iso) => new Date(`${iso}T12:00:00`).getDay();
const norm = (s) => String(s ?? "").trim().replace(/\s+/g, " ").toUpperCase();

/**
 * @param roster   today's grid rows ({ name, shiftStart, shiftEnd, slots, status, role })
 * @param history  saved assignment docs ({ date, associates: [...] }), any order
 * @param date     the grid's ISO date; history on or after it is ignored
 * @returns { NAME: { [slot]: { task, confidence } } }
 */
export function suggestTasks(roster, history, date) {
  const target = weekday(date);
  // name → slot → task → { weight, days, raw }
  const seen = new Map();
  // name → slot → total weight of days they had ANY task there
  const worked = new Map();

  for (const doc of history || []) {
    const d = doc?.date;
    if (!d || d >= date || !Array.isArray(doc.associates)) continue;
    const w = weekday(d) === target ? SAME_WEEKDAY_WEIGHT : 1;
    for (const a of doc.associates) {
      if (!a?.name || a.status === "absent" || !a.slots) continue;
      const name = norm(a.name);
      const bySlot = seen.get(name) || seen.set(name, new Map()).get(name);
      const tot = worked.get(name) || worked.set(name, new Map()).get(name);
      for (const [slot, task] of Object.entries(a.slots)) {
        const key = norm(task);
        if (!key) continue;
        tot.set(slot, (tot.get(slot) || 0) + w);
        const byTask = bySlot.get(slot) || bySlot.set(slot, new Map()).get(slot);
        const e = byTask.get(key) || { weight: 0, days: 0, raw: String(task).trim() };
        e.weight += w; e.days += 1;
        byTask.set(key, e);
      }
    }
  }

  const out = {};
  for (const a of roster || []) {
    if (!a?.name || a.status === "absent" || isLeadership(a)) continue;
    if (typeof a.shiftStart !== "number" || typeof a.shiftEnd !== "number") continue;
    const name = norm(a.name);
    const bySlot = seen.get(name);
    if (!bySlot) continue;
    const lunch = lunchWindow(a);

    const mine = {};
    for (let slot = a.shiftStart; slot < a.shiftEnd; slot++) {
      if (a.slots?.[slot]) continue;
      const byTask = bySlot.get(String(slot));
      const total = worked.get(name)?.get(String(slot)) || 0;
      if (!byTask || !total) continue;
      const ranked = [...byTask.entries()].sort((x, y) => y[1].weight - x[1].weight);
      const [key, best] = ranked[0];
      if (ranked[1] && ranked[1][1].weight === best.weight) continue;   // a tie is no habit
      if (NOT_SUGGESTED.has(key)) continue;
      // A habitual lunch hour only makes sense inside today's legal window.
      if (/^L(30)?$/.test(key) && (!lunch || slot < lunch.from || slot >= lunch.to)) continue;
      const share = best.weight / total;
      if (best.days < MIN_DAYS || share < MIN_SHARE) continue;
      mine[slot] = { task: best.raw, confidence: Math.round(share * 100) };
    }
    if (Object.keys(mine).length) out[a.name] = mine;
  }
  return out;
}
