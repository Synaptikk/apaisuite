// modules/digitalschedule/lib/rules.js
//
// The manager's people rules: things the availability data doesn't show.
// Kept as plain text in the user's own storage (never in this repo: it names
// associates). One rule per line, "#" starts a comment:
//
//   pair: First Last + First Last          always share a shift (moved together)
//   fixed: First Last 11:00-20:00          always this shift, never re-timed
//   days: First Last sat,sun               only works these days
//   window: First Last weekend 00:00-17:00 shifts on those days stay inside the window
//   window: First Last weekday 00:00-15:00 (days: all | weekend | weekday | sat,sun | mon-fri)
//   nodaymove: First Last                  never move to another day (e.g. 6-day streaks)
//   keep: First Last                       leave completely alone

import { SHORT, toMin } from "./coverage.js";

const DAYSETS = { all: [0, 1, 2, 3, 4, 5, 6], weekend: [0, 1], weekday: [2, 3, 4, 5, 6], weekdays: [2, 3, 4, 5, 6], weekends: [0, 1] };

function parseDays(s) {
  const t = String(s).toLowerCase().trim();
  if (DAYSETS[t]) return DAYSETS[t];
  const out = new Set();
  for (const part of t.split(",")) {
    const [a, b] = part.split("-").map((x) => SHORT.indexOf(x.trim().slice(0, 3)));
    if (a < 0 || (b !== undefined && b < 0)) return null;
    if (b === undefined) out.add(a); else for (let i = a; ; i = (i + 1) % 7) { out.add(i); if (i === b) break; }
  }
  return [...out];
}
const range = (s) => { const m = String(s).match(/^(\d{1,2}:\d\d)\s*-\s*(\d{1,2}:\d\d)$/); if (!m) return null;
  const a = toMin(m[1]); let b = toMin(m[2]); if (b <= a) b += 1440; return [a, b]; };
const key = (n) => String(n).trim().toLowerCase().replace(/\s+/g, " ");

export function parseRules(text) {
  const r = { pairs: [], fixed: new Map(), daysOnly: new Map(), windows: new Map(), noDayMove: new Set(), keep: new Set(), errors: [] };
  String(text || "").split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/#.*/, "").trim(); if (!line) return;
    const m = line.match(/^(\w+)\s*:\s*(.+)$/);
    const bad = (why) => r.errors.push(`line ${i + 1}: ${why} — "${raw.trim()}"`);
    if (!m) return bad("expected kind: details");
    const kind = m[1].toLowerCase(), rest = m[2].trim();
    if (kind === "pair") { const p = rest.split("+").map(key); if (p.length !== 2 || !p[0] || !p[1]) return bad("pair needs two names joined by +"); r.pairs.push(p); return; }
    if (kind === "nodaymove") { r.noDayMove.add(key(rest)); return; }
    if (kind === "keep") { r.keep.add(key(rest)); return; }
    if (kind === "fixed") { const mm = rest.match(/^(.+?)\s+(\d{1,2}:\d\d\s*-\s*\d{1,2}:\d\d)$/); const t = mm && range(mm[2]); if (!t) return bad("fixed needs a name then HH:MM-HH:MM"); r.fixed.set(key(mm[1]), t); return; }
    if (kind === "days") { const mm = rest.match(/^(.+?)\s+(\S+)$/); const d = mm && parseDays(mm[2]); if (!d) return bad("days needs a name then e.g. sat,sun"); r.daysOnly.set(key(mm[1]), d); return; }
    if (kind === "window") {
      const mm = rest.match(/^(.+?)\s+(\S+)\s+(\d{1,2}:\d\d\s*-\s*\d{1,2}:\d\d)$/); const d = mm && parseDays(mm[2]), t = mm && range(mm[3]);
      if (!d || !t) return bad("window needs a name, days, HH:MM-HH:MM");
      const k = key(mm[1]); if (!r.windows.has(k)) r.windows.set(k, []); r.windows.get(k).push({ days: d, lo: t[0], hi: t[1] }); return;
    }
    bad(`unknown rule "${kind}"`);
  });
  return r;
}

/** Names the rules mention that are not on this week's roster (likely typos). */
export function unknownNames(rules, workers) {
  const have = new Set(workers.map((w) => key(w.name)));
  const all = new Set([...rules.pairs.flat(), ...rules.fixed.keys(), ...rules.daysOnly.keys(), ...rules.windows.keys(), ...rules.noDayMove, ...rules.keep]);
  return [...all].filter((n) => !have.has(n));
}

export const nameKey = key;
