// modules/safetyagent/lib/response.js
//
// Accepted / declined / ignored, per person, on the alerts that were theirs.
//
// "Theirs" (the user's rules, 2026-10-19):
//   associates  alerts on their team's cameras that fired while they were
//               clocked in (the camera → team list in lib/camteams.js)
//   team leads  only alerts on their OWN area's cameras (Fashion TL → Fashion).
//               Escalations from other areas are never held against them —
//               SafeIQ escalates every alert to every lead at ~80 s.
//   not counted coaches, the store manager, Digital / eComm leads (backroom),
//               leads whose role owns no cameras (stocking, AP, clean, RX),
//               and anyone in the view's "Don't count" list.
//
// Per alert, the person's outcome:
//   accepted  they pressed Accept (detections_log RESERVE)
//   declined  they pressed Decline and never accepted
//   ignored   they pressed nothing and the alert sat open IGNORE_MIN+ (CREATE →
//             first accept, else complete) — an alert someone else took
//             inside that minute is nobody's to ignore
//
// Measured (store 1458, 8/25→10/19) and why leads count from CREATE: leads'
// presses before any escalation land a median 11 s in, ~80% on their own
// area's cameras, so they are in the first wave for their own area.
//
// Pure: no chrome.*, Node-testable.

import { nameKeys, presence, isLeader, camTeamMap, buildDays } from "./oncall.js";

export const IGNORE_MIN = 1;

/** Lead job title (WFM schedule) → the camera team it answers for. */
export const LEAD_AREA = Object.freeze([
  [/^Front End TL\b/i,          "Front End"],
  [/^Fashion TL\b/i,            "Fashion"],
  [/^Food & Consumables TL\b/i, "Food and Consumables"],
  [/^Home TL\b/i,               "Home"],
  [/^Health & Beauty TL\b/i,    "Health and Beauty"],
  [/^Entertainment TL\b/i,      "Entertainment"],
  [/^Hardlines TL\b/i,          "Hardlines"],
  [/^Seasonal TL\b/i,           "Seasonal"],
  [/^Meat\/Produce TL\b/i,      "Meat and Produce"],
  [/^Deli\/Bakery TL\b/i,       "Bakery and Deli"],
  [/^ACC Team Lead\b/i,         "Auto Care Center"],
]);
export const NOT_COUNTED_RE = /\bCoach\b|Store Manager|Digital|e-?Comm|\bOGP\b/i;

export function leadArea(job) {
  const j = String(job || "").trim();
  for (const [re, area] of LEAD_AREA) if (re.test(j)) return area;
  return null;
}

/** "Jane Doe, John Smith" → Set of name keys to leave out. */
export function skipKeys(text) {
  const keys = new Set();
  for (const n of String(text || "").split(/[,;\n]/)) for (const k of nameKeys(n.trim())) keys.add(k);
  return keys;
}

const midnight = (iso) => Math.round(Date.parse(`${iso}T00:00:00`) / 1000);

/**
 * @param rows     compact alert rows (date-filtered)
 * @param actions  service cache { byDate: { iso: { hzdId: entry } } } — lib/sql.js::compactActions
 * @param oncall   service cache { camTeam, days }
 * @param COL      lib/aggregate.js::COL
 * @param opts     { skip: Set<nameKey>, today: { iso, min } }
 * @returns { people: [{ key, name, job, area, lead, since, sent, acc, dec, ign, rows }],
 *            summary: { alerts, counted, noLog, noTeam, missingDays: [] } }
 *          person.rows = the alerts they declined or ignored (row gallery)
 *          job/area/lead = the newest title in range (since = that day); each
 *          alert is still judged by the title held on its own day
 */
export function responseBreakdown(rows, actions, oncall, COL, { skip = new Set(), today = null } = {}) {
  const camTeam = camTeamMap(oncall);
  const { days, missingDays } = buildDays(rows, oncall, COL, today);
  const by = new Map();
  const summary = { alerts: rows.length, counted: 0, noLog: 0, noTeam: 0, missingDays };
  const skipped = (p) => NOT_COUNTED_RE.test(p.job || "") || nameKeys(p.name).some((k) => skip.has(k));

  for (const r of rows) {
    const date = r[COL.date], team = camTeam[r[COL.camera]];
    if (!team) { summary.noTeam++; continue; }
    const people = days[date];
    if (!people) continue;
    const a = actions?.byDate?.[date]?.[r[COL.id]];
    if (!a || a.c == null) { summary.noLog++; continue; }
    summary.counted++;
    const min = (a.c - midnight(date)) / 60;
    const end = a.r ?? a.k ?? a.c + 600;
    const accKeys = new Set(a.acc.flatMap(nameKeys)), decKeys = new Set(a.dec.flatMap(nameKeys));
    for (const p of people) {
      const lead = isLeader(p.job);
      const area = lead ? leadArea(p.job) : p.team;
      if (area !== team || skipped(p) || !presence(p, min)) continue;
      const keys = nameKeys(p.name);
      let g = by.get(p.name);
      if (!g) by.set(p.name, g = { key: p.name, name: p.name, job: p.job, area, lead, since: date, sent: 0, acc: 0, dec: 0, ign: 0, rows: [] });
      // Promotions (TA → TL mid-range): the row shows the newest title.
      if (date > g.since) Object.assign(g, { job: p.job, area, lead, since: date });
      g.sent++;
      if (keys.some((k) => accKeys.has(k))) g.acc++;
      else if (keys.some((k) => decKeys.has(k))) { g.dec++; g.rows.push(r); }
      else if (end - a.c >= IGNORE_MIN * 60) { g.ign++; g.rows.push(r); }
    }
  }
  return { people: [...by.values()], summary };
}
