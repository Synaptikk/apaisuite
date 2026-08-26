// modules/digitalmetrics/lib/data/associates.js
//
// Associate search, per-day breakdown, and historical task patterns. Pure.
//
// All of this runs on decrypted names in memory. It has to: ranking a search
// by prefix, and matching a metrics name to a differently-typed roster entry,
// are both impossible against tokens or ciphertext. See
// docs/DIGITAL_METRICS_PRIVACY.md §5.

import { classificationOf } from "./classify.js";
import { parsePickDate } from "./parse.js";

/**
 * Rank associates for the autocomplete.
 *
 * Three tiers, because "SMI" should offer "SMITH, JOHN" before
 * "GOLDSMITH, ANA", and a last-name prefix should still beat a mid-word hit:
 *   1. the whole name starts with the query
 *   2. some word in the name starts with the query
 *   3. the name merely contains it
 */
export function searchAssociates(associates, query, { limit = 10 } = {}) {
  const q = String(query || "").trim().toUpperCase();
  if (!q) return [];

  const tier = (name) => {
    const upper = name.toUpperCase();
    if (upper.startsWith(q)) return 0;
    if (upper.split(/\s+/).some((w) => w.startsWith(q))) return 1;
    return 2;
  };

  return (associates || [])
    .filter((a) => a.name?.toUpperCase().includes(q))
    .sort((a, b) => (tier(a.name) - tier(b.name)) || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** Per-day metric rows for one associate, most recent first. */
export function dailyBreakdown(rawData, name) {
  const target = String(name || "").toUpperCase();
  const out = [];
  let last = null;

  for (const row of rawData || []) {
    if (row["Pick Date"]) last = row["Pick Date"];
    if (String(row.Associate || "").toUpperCase() !== target) continue;

    const picked = (row["Picked As Req Qty"] || 0) + (row["Exception Picked As Req Qty"] || 0);
    const ftpExp = (row["FTP Expected"] || 0) + (row["Exception Qty Req to Pick"] || 0);
    const ftpAct = (row["FTP Actual"] || 0) + (row["Exception Picked As Req Qty"] || 0);
    const nil    = (row["Nil Pick Qty"] || 0) + (row["Exception Nil Pick Qty"] || 0);
    const sub    = (row["Substitution Qty"] || 0) + (row["Exception Substitution Qty"] || 0);

    out.push({
      date:      last,
      firstScan: row["Min. First Scan"] ?? null,
      hours:     Math.round((row["Pick Hours"] || 0) * 10) / 10,
      // Picks per hour, whole. Tableau hands this over at full float width
      // (92.421), and it was the one field here that went out unrounded —
      // every sibling is already rounded, so it read as a glitch beside them.
      // Tenths of a pick per hour is precision the number does not carry.
      //
      // Display only: the scoring path reads Tableau's raw row directly
      // (metrics.js::pickRateSum), so benchmarks and Opportunities scores are
      // unaffected.
      pickRate:  Math.round(row["Pick Rate"] || 0),
      picked, nil, sub,
      ftpr:     ftpExp > 0 ? Math.round((ftpAct / ftpExp) * 1000) / 10 : 0,
      nilRate:  picked > 0 ? Math.round((nil / picked) * 1000) / 10 : 0,
      subRate:  picked > 0 ? Math.round((sub / picked) * 1000) / 10 : 0,
    });
  }

  return out.sort((a, b) => (parsePickDate(b.date) ?? 0) - (parsePickDate(a.date) ?? 0));
}

/**
 * What this associate has historically been assigned, per time slot.
 *
 * Falls back to a first-name match because assignment rosters are hand-typed
 * and frequently hold only a first name — the same reason
 * data/adherence.js::findAssignmentMatch exists.
 *
 * @param assignmentDocs  recent dailyAssignments documents (decoded)
 * @returns { totalDays, slots: { [slotIdx]: { task, count, confidence }[] } }
 */
export function taskPatterns(assignmentDocs, name) {
  const target = String(name || "").toUpperCase();
  const first  = target.split(/\s+/)[0];
  const counts = new Map();   // slotIdx -> Map(task -> count)
  let totalDays = 0;

  for (const doc of assignmentDocs || []) {
    const roster = doc?.associates;
    if (!Array.isArray(roster)) continue;

    const match =
      roster.find((a) => String(a.name || "").toUpperCase() === target) ||
      roster.find((a) => String(a.name || "").toUpperCase().split(/\s+/)[0] === first);

    if (!match?.slots) continue;
    totalDays++;

    for (const [slot, task] of Object.entries(match.slots)) {
      const label = String(task || "").trim().toUpperCase();
      if (!label) continue;
      if (!counts.has(slot)) counts.set(slot, new Map());
      const bySlot = counts.get(slot);
      bySlot.set(label, (bySlot.get(label) || 0) + 1);
    }
  }

  const slots = {};
  for (const [slot, bySlot] of counts) {
    slots[slot] = [...bySlot.entries()]
      .map(([task, count]) => ({
        task, count,
        confidence: totalDays > 0 ? Math.round((count / totalDays) * 100) : 0,
      }))
      .sort((a, b) => b.count - a.count);
  }

  return { totalDays, slots };
}

/** Everything the associate report needs, assembled. */
export function associateReport(name, { associates = [], rawData = [], classifications = {}, adherence = {} }) {
  const summary = (associates || []).find((a) => a.name === name) || null;
  return {
    name,
    summary,
    classification: classificationOf(name, classifications),
    daily:     dailyBreakdown(rawData, name),
    adherence: adherence[name] || null,
  };
}
