// modules/digitalrollup/lib/pick_history.js
//
// "Items picked in the last hour", per store, from the board's running day
// total (`picking.total_picks`).
//
// The API only ever gives the day-to-date total — /api/trends, the one route
// to history, is broken server-side (see gif_api.js) — so the hourly figure is
// derived locally: every pull appends (time, total) per store, and the rolling
// hour is the latest total minus the total one hour before it, interpolated
// between the two samples that straddle that point.
//
// Time is the SOURCE's stamp (`refreshed_at_iso`, when the board last read
// GRT), not when this browser fetched. Two fetches of one unchanged board are
// one observation, not two — counting them twice would add flat stretches that
// were never really flat. Pure: no chrome.*, so it runs under node --test.

export const HOUR_MS = 60 * 60 * 1000;

// Enough for a whole day at one sample a minute. A cap, not a policy: the day
// reset below is what normally keeps the series short.
const MAX_SAMPLES_PER_STORE = 1500;

// Stored readings are kept at least this far apart. Live polls every 15 s, but
// a per-hour figure gains nothing from that resolution and it would eat the
// cap above in six hours. Readings closer than this refresh the newest entry
// in place instead, so the latest total is always current.
export const MIN_SAMPLE_GAP_MS = 60 * 1000;

/** Source time for a snapshot, falling back to our fetch time. */
export function sampleTime(snapshot) {
  const t = Date.parse(snapshot?.refreshedAtIso ?? "");
  return Number.isFinite(t) ? t : (snapshot?.capturedAt ?? null);
}

/**
 * The API ships `total_picks` pre-formatted — "9,630", a string with a
 * thousands comma (seen live 2026-09-23) — so a bare Number() is NaN. Null
 * and "—" are checked first because Number(null) is 0, which would log a store
 * that reported nothing as a reset to zero.
 */
export function parseCount(raw) {
  if (raw == null || raw === "" || raw === "—") return NaN;
  return typeof raw === "number" ? raw : Number(String(raw).replace(/,/g, ""));
}

/**
 * Fold one snapshot into the history. Returns a NEW history object.
 *
 * History shape: { v:1, market, day, series: { [store]: [[tMs, picks], …] } }
 *
 * The series restarts when the market or the report day changes, and per store
 * when the total goes DOWN — the running total only climbs within a day, so a
 * drop means the source reset it, and differencing across a reset would yield
 * a negative hour.
 */
export function recordSnapshot(history, snapshot, { stores = null } = {}) {
  // `stores` limits what is tracked (the module passes the user's home store
  // only). Compared numerically: the API's store_nbr is an integer, while a
  // home store can arrive as "01458".
  const only = stores ? new Set(stores.filter((x) => x != null).map(Number)) : null;
  const t = sampleTime(snapshot);
  const market = String(snapshot?.market ?? "");
  const day = snapshot?.reportDate ?? null;
  if (t == null || !Array.isArray(snapshot?.cards)) return history;

  const same = history && history.v === 1 && history.market === market && history.day === day;
  const series = same ? { ...history.series } : {};

  for (const card of snapshot.cards) {
    const picks = parseCount(card?.picking?.total_picks);
    if (card?.store_nbr == null || !Number.isFinite(picks)) continue;
    if (only && !only.has(Number(card.store_nbr))) continue;
    const store = String(card.store_nbr);
    let s = series[store] ? series[store].slice() : [];
    const last = s[s.length - 1];
    if (last && t <= last[0]) continue;          // same or older board — not new
    if (last && picks < last[1]) s = [];         // source reset its running total
    const prev = s[s.length - 2];
    // The tail keeps moving until it is a full gap past the entry before it;
    // only then does a new reading start a new entry.
    if (prev && last[0] - prev[0] < MIN_SAMPLE_GAP_MS) s[s.length - 1] = [t, picks];
    else s.push([t, picks]);
    if (s.length > MAX_SAMPLES_PER_STORE) s = s.slice(-MAX_SAMPLES_PER_STORE);
    series[store] = s;
  }
  return { v: 1, market, day, series };
}

/**
 * Items picked in the window ending at the store's latest sample.
 *
 * @returns {null | { picked:number, spanMs:number, full:boolean, perHour:number, asOf:number }}
 *   `full` is false while there is less than a window of history (just after
 *   install, or first thing in the day). `picked` then covers only `spanMs`,
 *   and `perHour` is that pace scaled to an hour, labelled as such by the view.
 *   null with fewer than two samples: one reading has no rate.
 */
export function rollingWindow(samples, windowMs = HOUR_MS) {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  const [tEnd, pEnd] = samples[samples.length - 1];
  const target = tEnd - windowMs;
  const [t0, p0] = samples[0];

  if (t0 >= target) {
    const spanMs = tEnd - t0;
    if (spanMs <= 0) return null;
    const picked = pEnd - p0;
    return { picked, spanMs, full: false, perHour: Math.round(picked * HOUR_MS / spanMs), asOf: tEnd };
  }

  // Last sample at or before the target; the next one is after it.
  let i = samples.length - 1;
  while (i > 0 && samples[i][0] > target) i--;
  const [ta, pa] = samples[i];
  const [tb, pb] = samples[i + 1];
  const pAtTarget = tb === ta ? pa : pa + (pb - pa) * (target - ta) / (tb - ta);
  const picked = Math.round(pEnd - pAtTarget);
  return { picked, spanMs: windowMs, full: true, perHour: Math.round(picked * HOUR_MS / windowMs), asOf: tEnd };
}

/** Running total at time t, interpolated between the samples around it. */
function totalAt(samples, t) {
  if (t <= samples[0][0]) return samples[0][1];
  for (let i = 1; i < samples.length; i++) {
    const [tb, pb] = samples[i];
    if (t <= tb) {
      const [ta, pa] = samples[i - 1];
      return tb === ta ? pb : pa + (pb - pa) * (t - ta) / (tb - ta);
    }
  }
  return samples[samples.length - 1][1];
}

/**
 * When the board's day began. The API labels its window in `data_age.tooltip`
 * ("Real-time from GRT (2026-09-23 05:00:00 to 2026-09-24 04:59:59)", seen
 * 2026-09-23) and total_picks counts from that moment, so the running total is
 * 0 there. Read as local time; falls back to 5 AM on the day of `atMs`.
 */
export function dayStartFrom(snapshot, atMs = Date.now()) {
  const m = /\((\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(snapshot?.dataAge?.tooltip || "");
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
  const d = new Date(atMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 5, 0).getTime();
}

/**
 * Items picked in each clock hour from the day start to the latest reading.
 *
 * Only what the readings support is broken out. Before the first reading of
 * the day the one fact is the total since the day start (which began at 0),
 * so that stretch comes back as a single `before` entry at its average rate,
 * never as invented per-hour bars. The hour containing the latest reading is
 * `now` (picked so far). Everything else is `hour`, differenced from the
 * interpolated running total at each hour boundary.
 *
 * @returns {null | { dayStart:number, asOf:number, total:number, dayAvgPerHour:number,
 *   before: null | { start:number, end:number, picked:number, perHour:number },
 *   hours: Array<{ start:number, end:number, picked:number, kind:"hour"|"now" }> }}
 */
export function hourlyBars(samples, dayStart) {
  if (!Array.isArray(samples) || !samples.length || !Number.isFinite(dayStart)) return null;
  const [t0, p0] = samples[0];
  const [tEnd, pEnd] = samples[samples.length - 1];
  if (tEnd <= dayStart) return null;
  const dayAvgPerHour = Math.round(pEnd * HOUR_MS / (tEnd - dayStart));

  // The measured span starts at the first clock hour on or after the first
  // reading; the part of the day before that is the `before` block.
  const firstHour = Math.ceil(Math.max(t0, dayStart) / HOUR_MS) * HOUR_MS;
  const withZero = t0 > dayStart ? [[dayStart, 0], ...samples] : samples;
  const beforeEnd = Math.min(firstHour, tEnd);
  const before = t0 > dayStart
    ? {
        start: dayStart,
        end: beforeEnd,
        picked: Math.round(totalAt(withZero, beforeEnd)),
        perHour: Math.round(totalAt(withZero, beforeEnd) * HOUR_MS / (beforeEnd - dayStart)),
      }
    : null;

  const hours = [];
  for (let a = firstHour; a < tEnd; a += HOUR_MS) {
    const b = a + HOUR_MS;
    const now = b > tEnd;
    hours.push({
      start: a,
      end: now ? tEnd : b,
      picked: Math.round(totalAt(withZero, Math.min(b, tEnd)) - totalAt(withZero, a)),
      kind: now ? "now" : "hour",
    });
  }
  return { dayStart, asOf: tEnd, total: pEnd, dayAvgPerHour, before, hours };
}
