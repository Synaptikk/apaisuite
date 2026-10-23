// modules/digitaldashboard/lib/walk_log.js
//
// The day's pick walks, from the pick-walk cards on GIF's OPD Hourly → hour
// screens (the phone reads them every ~2 min). A card shows picker, section
// (Express, Ambient, Cold Chain, Oversized, Fashion, Exceptions, …), the items
// STILL TO PICK, due time and on-time/late. User, 2026-10-09: context for
// !performance — e.g. a slow picker who was on Oversized walks all day.
//
// A card is NOT one walk (2026-10-23, Deborah Greene "walks seen: Ambient 26"
// for GIF's 1 walk):
//  - its qty counts down as the walk is picked (53 → 51 → 47 … → 1), and
//  - one walk shows one card per hour slot it has orders due in (her walk was
//    an 8-9am card due 07:30 and a 9-10am card due 07:55, 53 + 35 ≈ 89 picks).
// So the log below is a log of SIGHTINGS (one entry per distinct qty), and
// walkMixByName() rebuilds walks from it: a card's countdown is one walk until
// its qty goes back up, and a picker's cards on screen at the same time are
// the same walk (a picker runs one walk at a time).
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

/**
 * The day's walks per picker, rebuilt from the sightings:
 * [{ name, section, items, firstSeen, lastSeen, cards }].
 * items = the highest remaining count seen on each card (its size when first
 * read; a walk already under way when first read counts low).
 */
export function walksFromLog(log) {
  // 1) one card = one (picker, slot, section, due) countdown; a rise in qty
  //    means a new walk on the same card key
  const tracks = new Map();
  for (const s of Object.values(log?.walks || {})) {
    const k = [s.name, s.slot, s.section ?? "", s.due].join("|");
    (tracks.get(k) || tracks.set(k, []).get(k)).push(s);
  }
  const runs = [];
  for (const list of tracks.values()) {
    list.sort((a, b) => a.firstSeen - b.firstSeen || (Number(b.qty) || 0) - (Number(a.qty) || 0));
    let run = null;
    for (const s of list) {
      const q = Number(s.qty) || 0;
      if (!run || q > run.lastQty) {
        run = { name: s.name, section: s.section || "Other", items: q, lastQty: q, firstSeen: s.firstSeen, lastSeen: s.lastSeen };
        runs.push(run);
      } else {
        run.lastQty = q;
        run.lastSeen = Math.max(run.lastSeen, s.lastSeen);
      }
    }
  }
  // 2) a picker's cards whose sightings overlap in time belong to one walk
  const byName = new Map();
  for (const r of runs) (byName.get(r.name) || byName.set(r.name, []).get(r.name)).push(r);
  const out = [];
  for (const [name, list] of byName) {
    list.sort((a, b) => a.firstSeen - b.firstSeen);
    let cur = null;
    for (const r of list) {
      if (cur && r.firstSeen <= cur.lastSeen) {
        cur.cards.push(r);
        cur.lastSeen = Math.max(cur.lastSeen, r.lastSeen);
      } else {
        cur = { name, firstSeen: r.firstSeen, lastSeen: r.lastSeen, cards: [r] };
        out.push(cur);
      }
    }
  }
  return out.map((w) => {
    const bySection = {};
    for (const c of w.cards) bySection[c.section] = (bySection[c.section] || 0) + c.items;
    const section = Object.entries(bySection).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    return { name: w.name, section, items: w.cards.reduce((t, c) => t + c.items, 0), firstSeen: w.firstSeen, lastSeen: w.lastSeen, cards: w.cards.length };
  });
}

/** { [name]: { walks, items, lastSeen, sections: { [section]: walks } } } for the day. */
export function walkMixByName(log) {
  const out = {};
  for (const w of walksFromLog(log)) {
    const m = (out[w.name] ||= { walks: 0, items: 0, lastSeen: 0, sections: {} });
    m.walks++;
    m.items += w.items;
    m.lastSeen = Math.max(m.lastSeen, w.lastSeen);
    m.sections[w.section] = (m.sections[w.section] || 0) + 1;
  }
  return out;
}

/** "Oversized 6, Ambient 2" — biggest first. */
export function mixText(mix) {
  return Object.entries(mix?.sections || {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([s, n]) => `${s} ${n}`).join(", ");
}
