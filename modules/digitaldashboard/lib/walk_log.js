// modules/digitaldashboard/lib/walk_log.js
//
// The day's pick walks, from the pick-walk cards on GIF's OPD Hourly → hour
// screens (the phone reads them every ~2 min). Each card = one walk: picker,
// section (Express, Ambient, Cold Chain, Oversized, Fashion, Exceptions, …),
// item count, due time, on-time/late. A walk stays on the screen while it's
// being picked, so first/last seen brackets how long it ran (to the reading
// interval). User, 2026-10-09: context for !performance — e.g. a slow picker
// who was on Oversized walks all day.
//
// Pure; the daemon keeps the log in its state.

const keyOf = (slot, w) => [w.name, slot, w.section ?? "", w.due, w.qty ?? ""].join("|");

export function emptyWalkLog(day) { return { day, walks: {} }; }

/** Fold one OPD reading's hours[].walks into the log. Returns a NEW log. */
export function noteWalks(log, hours, now = Date.now(), day) {
  const base = log && log.day === day ? log : emptyWalkLog(day);
  const walks = { ...base.walks };
  for (const h of hours || []) {
    for (const w of h?.walks || []) {
      // a card cut off at the screen edge reads without its due time — the
      // same walk shows whole in the same reading, so skip the partial one
      if (!w?.name || !w.due) continue;
      const k = keyOf(h.slot, w);
      const old = walks[k];
      walks[k] = {
        name: w.name, slot: h.slot, section: w.section ?? null, qty: w.qty ?? null, due: w.due,
        status: w.status ?? old?.status ?? null,
        firstSeen: old?.firstSeen ?? now,
        lastSeen: now,
      };
    }
  }
  return { day: base.day, walks };
}

/** { [name]: { walks, items, sections: { [section]: walks } } } for the day. */
export function walkMixByName(log) {
  const out = {};
  for (const w of Object.values(log?.walks || {})) {
    const m = (out[w.name] ||= { walks: 0, items: 0, sections: {} });
    m.walks++;
    m.items += Number(w.qty) || 0;
    const s = w.section || "Other";
    m.sections[s] = (m.sections[s] || 0) + 1;
  }
  return out;
}

/** "Oversized 6, Ambient 2" — biggest first. */
export function mixText(mix) {
  return Object.entries(mix?.sections || {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([s, n]) => `${s} ${n}`).join(", ");
}
