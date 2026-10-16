// modules/digitaldashboard/lib/break_log.js
//
// The day's long-break log: every associate the break watch flagged as out of
// a pick walk over the limit, one episode per continuous stretch, kept per
// board day (gif_metrics.boardDay). Pure — the PC daemon (gif-daemon.mjs) and
// the QRCallBox cloud copy (functions/src/http/gif/lib/dd/) both fold each
// watch result in with mergeBreakLog and persist the log with their state.
//
// Log: { v: 1, lastAt, days: { "YYYY-MM-DD": [episode, …] } }
// Episode (all times ms epoch):
//   name              GIF name
//   location          last pick location (as the watch saw it)
//   lastSeenActiveAt  their last pick — when they went inactive
//   firstFlaggedAt    first watch run that had them over the limit
//   lastFlaggedAt     latest run that still had them over
//   longestMin        most minutes out any run reported
//   cleared           when they came back / dropped off the flagged list (null while open)
//   status            "open" | "cleared"
//
// Stretch rule: an open episode continues while the watch keeps flagging the
// same name with the same last pick. A different last pick means they picked
// in between, so the old episode closes (at its last flag) and a new one opens.
// A run that no longer flags them closes it at that run's time — unless the
// previous run was more than STALE_MS earlier (daemon down, hour with no one
// on the board), when it closes at lastFlaggedAt rather than overstate the break.

import { boardDay, sameName } from "./gif_metrics.js";

export const BREAK_LOG_KEEP_DAYS = 60;
export const STALE_MS = 10 * 60_000;
export const MAX_EPISODES_PER_DAY = 300;

export function emptyBreakLog() { return { v: 1, lastAt: 0, days: {} }; }

/** Minutes since midnight on `now`'s calendar date → ms. A time later than `now` belongs to the day before. */
export function clockToMs(min, now) {
  const d = new Date(now.getTime());
  d.setHours(0, 0, 0, 0);
  let t = d.getTime() + Math.round(min * 60_000);
  if (t > now.getTime() + 60_000) t -= 24 * 3600_000;
  return t;
}

const close = (ep, at) => ({ ...ep, status: "cleared", cleared: Math.max(at, ep.lastFlaggedAt) });

/** Close an open episode that no run has confirmed for STALE_MS, at its last flag. */
function settle(ep, now) {
  return ep.status === "open" && now - ep.lastFlaggedAt > STALE_MS ? close(ep, ep.lastFlaggedAt) : ep;
}

/**
 * Fold one break-watch result (gif_metrics.breakWatch, plus checkedAt) into the
 * log. Returns a NEW log; a result older than the last one merged is ignored.
 */
export function mergeBreakLog(log, watch, now = new Date(watch?.checkedAt ?? Date.now())) {
  const t = now.getTime();
  const base = log && log.v === 1 && log.days ? log : emptyBreakLog();
  if (!watch || t < (base.lastAt || 0)) return base;
  const day = boardDay(now);
  const days = { ...base.days };
  const gapped = base.lastAt && t - base.lastAt > STALE_MS;

  // Earlier days never get another run: settle anything left open there.
  for (const d of Object.keys(days)) {
    if (d !== day && days[d].some((e) => e.status === "open")) {
      days[d] = days[d].map((e) => (e.status === "open" ? close(e, e.lastFlaggedAt) : e));
    }
  }

  let eps = [...(days[day] || [])];
  const flagged = (watch.suspects || []).filter((s) => s.over && s.name);
  const seen = new Set();
  for (const s of flagged) {
    const outAt = s.lastSeen != null ? clockToMs(s.lastSeen, now) : null;
    const i = eps.findIndex((e) => e.status === "open" && sameName(e.name, s.name));
    if (i >= 0) {
      const ep = eps[i];
      // same last pick = same stretch, however long since the previous run
      if (ep.lastSeenActiveAt === outAt) {
        eps[i] = { ...ep, lastFlaggedAt: t, longestMin: Math.max(ep.longestMin ?? 0, s.idleMin ?? 0) };
        seen.add(i);
        continue;
      }
      // they picked in between, unseen by any run: the old stretch ended
      // sometime after its last flag — record that, not a guess past it
      eps[i] = close(ep, ep.lastFlaggedAt);
    }
    if (eps.length >= MAX_EPISODES_PER_DAY) continue;
    eps.push({
      name: s.name, location: s.location ?? null,
      lastSeenActiveAt: outAt, firstFlaggedAt: t, lastFlaggedAt: t,
      longestMin: s.idleMin ?? null, cleared: null, status: "open",
    });
    seen.add(eps.length - 1);
  }
  eps = eps.map((e, i) => {
    if (e.status !== "open" || seen.has(i)) return e;
    return gapped || t - e.lastFlaggedAt > STALE_MS ? close(e, e.lastFlaggedAt) : close(e, t);
  });
  days[day] = eps;

  // keep ~60 days
  const cut = boardDay(new Date(t - BREAK_LOG_KEEP_DAYS * 24 * 3600_000));
  for (const d of Object.keys(days)) if (d < cut) delete days[d];
  return { v: 1, lastAt: t, days };
}

/** One day's episodes, oldest first, with stale opens settled as of `now`. */
export function breakLogDay(log, day, now = new Date()) {
  const eps = (log?.days?.[day] || []).map((e) => settle(e, now.getTime()));
  return eps.sort((a, b) => (a.lastSeenActiveAt ?? a.firstFlaggedAt) - (b.lastSeenActiveAt ?? b.firstFlaggedAt));
}

/** Minutes out: went inactive → back (cleared), or the longest a run reported while still open. */
export function episodeMinutes(ep) {
  if (ep.status === "cleared" && ep.cleared != null && ep.lastSeenActiveAt != null) {
    return Math.max(ep.longestMin ?? 0, Math.round((ep.cleared - ep.lastSeenActiveAt) / 60_000));
  }
  return ep.longestMin ?? null;
}

/** The days the log holds, newest first. */
export function breakLogDays(log) {
  return Object.keys(log?.days || {}).sort().reverse();
}
