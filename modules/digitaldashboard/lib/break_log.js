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

/** Anything out longer than this is only reported once a fresh punch read rules out lunch. */
export const LUNCH_CHECK_MIN = 45;
/** Walking time allowed each way between the last pick and the meal punch (user rule: 2–4 min). */
export const LUNCH_TRAVEL_MIN = 4;
/** "Back" is the first watch run that saw them picking; runs are ~3 min apart, so it can be that late. */
export const WATCH_SLACK_MIN = 3;

/**
 * Minutes of [start, end] (ms) inside the punched meal and after clock-out.
 * punch: { clockIn, clockOut, mealOut, mealIn } in minutes since `day`'s
 * midnight; a meal still open (no punch back yet) runs to `now`.
 */
export function mealOverlap(start, end, punch, day, now = Date.now()) {
  const [y, mo, d] = String(day).split("-").map(Number);
  const at = (min) => new Date(y, mo - 1, d).getTime() + min * 60_000;
  const overlap = (a, b) => Math.max(0, Math.round((Math.min(end, b) - Math.max(start, a)) / 60_000));
  const p = punch || {};
  let mealMin = 0, meal = null, beforeMin = 0, afterMin = 0;
  if (p.mealOut != null) {
    const back = p.mealIn != null && p.mealIn > p.mealOut ? at(p.mealIn) : p.mealIn == null ? (p.clockOut != null ? at(p.clockOut) : now) : null;
    if (back != null) {
      mealMin = overlap(at(p.mealOut), back);
      if (mealMin) {
        meal = [p.mealOut, p.mealIn ?? null];
        // last pick → meal punch-out, and meal punch-in → back picking
        beforeMin = Math.max(0, Math.round((at(p.mealOut) - start) / 60_000));
        afterMin = p.mealIn != null ? Math.max(0, Math.round((end - back) / 60_000)) : 0;
      }
    }
  }
  const offClockMin = p.clockOut != null ? overlap(at(p.clockOut), Infinity) : 0;
  return { mealMin, offClockMin, meal, beforeMin, afterMin };
}

/**
 * The punch for `name`, if it was read late enough to rule out lunch for a
 * stretch that began at `start`: a lunch punch-out comes at the start of the
 * gap, so a read taken LUNCH_CHECK_MIN into it would show one. `_at` = when
 * that associate's punches were last read.
 */
export function findPunch(punches, name) {
  const key = Object.keys(punches || {}).find((n) => sameName(n, name));
  return key ? punches[key] : null;
}
const checked = (p, start, checkOverMin) => !!p && (p._at ?? 0) >= start + checkOverMin * 60_000;

/**
 * Take punched meals (GTA clock-ins, digitalmetrics.clockIns for the day) out
 * of the log. The watch only skips an hour the grid marks as lunch, so a lunch
 * taken off-grid, or a stretch running into one, was logged as a long break.
 *
 * Also folds a stretch the watch logged twice (dropped off the grid for an
 * hour, flagged again with the same last pick) back into one episode.
 *
 * punches: { NAME: { clockIn, clockOut, mealOut, mealIn, _at } } (minutes
 * since the day's midnight; _at = ms the punches were read). Each episode gains
 *   outMin      minutes out (episodeMinutes, or as of `now` while open)
 *   mealMin     the part of it inside the punched meal
 *   offClockMin the part after clock-out
 *   netMin      outMin less both — what counts against the break limit
 *   meal        [out, in|null] minutes when a meal overlaps, else null
 *   beforeMin / afterMin  last pick → meal punch-out, meal punch-in → back
 *   lunchOverMin minutes past the travel allowance (LUNCH_TRAVEL_MIN each way;
 *               the back side also gets WATCH_SLACK_MIN, as "back" is a watch run)
 *   kind        "break" | "lunch" (net within the limit once the meal is out)
 *               | "lunch-over" (a lunch with more than the travel allowance around it — reported)
 *               | "clocked-out" (same, after clock-out)
 *               | "unverified" (over checkOverMin, no punch read late enough
 *                 to rule out lunch — NOT reported)
 *               | "unchecked" (short, no punches for them)
 */
export function withMeals(episodes, punches, day, { limitMin = 18, checkOverMin = LUNCH_CHECK_MIN, now = Date.now() } = {}) {
  const merged = [];
  for (const e of episodes || []) {
    const twin = e.lastSeenActiveAt != null && merged.find((m) => m.lastSeenActiveAt === e.lastSeenActiveAt && sameName(m.name, e.name));
    if (!twin) { merged.push({ ...e }); continue; }
    const open = twin.status === "open" || e.status === "open";
    Object.assign(twin, {
      firstFlaggedAt: Math.min(twin.firstFlaggedAt, e.firstFlaggedAt),
      lastFlaggedAt: Math.max(twin.lastFlaggedAt, e.lastFlaggedAt),
      longestMin: Math.max(twin.longestMin ?? 0, e.longestMin ?? 0),
      status: open ? "open" : "cleared",
      cleared: open ? null : Math.max(twin.cleared ?? 0, e.cleared ?? 0),
    });
  }
  return merged.map((e) => {
    const start = e.lastSeenActiveAt ?? e.firstFlaggedAt;
    const outMin = e.status === "open" ? Math.max(e.longestMin ?? 0, Math.round((now - start) / 60_000)) : (episodeMinutes(e) ?? 0);
    const p = findPunch(punches, e.name);
    const m = p ? mealOverlap(start, start + outMin * 60_000, p, day, now) : { mealMin: 0, offClockMin: 0, meal: null, beforeMin: 0, afterMin: 0 };
    const { mealMin, offClockMin } = m;
    const netMin = Math.max(0, outMin - mealMin - offClockMin);
    const lunchOverMin = mealMin ? Math.max(0, m.beforeMin - LUNCH_TRAVEL_MIN) + Math.max(0, m.afterMin - LUNCH_TRAVEL_MIN - WATCH_SLACK_MIN) : 0;
    const kind = outMin > checkOverMin && !mealMin && !checked(p, start, checkOverMin) ? "unverified"
      : !p ? "unchecked" : netMin > limitMin ? "break"
      : mealMin ? (lunchOverMin ? "lunch-over" : "lunch") : offClockMin ? "clocked-out" : "break";
    return { ...e, ...m, outMin, netMin, lunchOverMin, kind };
  });
}

/** Episodes (or watch suspects) over checkOverMin whose punches still need a read. */
export function needsLunchCheck(items, punches, { checkOverMin = LUNCH_CHECK_MIN, startOf, outOf, now = Date.now() }) {
  return (items || []).filter((x) => {
    const start = startOf(x);
    if (start == null || (outOf(x) ?? 0) <= checkOverMin) return false;
    return !checked(findPunch(punches, x.name), start, checkOverMin) && now >= start + checkOverMin * 60_000;
  });
}

/**
 * The live watch with punched meals applied: a suspect over checkOverMin is
 * only left `over` when a late-enough punch read shows no meal covering it;
 * otherwise `held` says why it is not reported.
 */
export function watchWithMeals(watch, punches, day, { limitMin = 18, checkOverMin = LUNCH_CHECK_MIN, now = new Date() } = {}) {
  if (!watch?.suspects) return watch;
  const t = now.getTime();
  const suspects = watch.suspects.map((s) => {
    if (!s.over || s.lastSeen == null) return s;
    const start = clockToMs(s.lastSeen, now);
    const p = findPunch(punches, s.name);
    const { mealMin, offClockMin } = p ? mealOverlap(start, t, p, day, t) : { mealMin: 0, offClockMin: 0 };
    const netMin = Math.max(0, (s.idleMin ?? 0) - mealMin - offClockMin);
    if (mealMin && netMin <= limitMin) return { ...s, over: false, held: "lunch", mealMin, netMin };
    if (offClockMin && netMin <= limitMin) return { ...s, over: false, held: "clocked-out", offClockMin, netMin };
    if ((s.idleMin ?? 0) > checkOverMin && !mealMin && !checked(p, start, checkOverMin)) return { ...s, over: false, held: "unverified" };
    return { ...s, mealMin, netMin };
  });
  return { ...watch, suspects };
}
