// modules/costinventory/lib/dates.js
//
// Cost inventory happens on the FOURTH Tuesday of every month — not the last
// Tuesday. The two only differ in months with five Tuesdays (Sept 2026: the
// 22nd vs the 29th; Dec 2026: the 22nd vs the 29th), which is exactly when
// getting it wrong puts the window a week out.
//
// Pure module: no chrome APIs, runs under `node --test`.

const TUESDAY = 2;

/** ISO "YYYY-MM-DD" for the nth weekday of a month (UTC, no DST surprises). */
export function nthWeekdayOfMonth(year, monthIndex, weekday, n) {
  const d = new Date(Date.UTC(year, monthIndex, 1));
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCDate(d.getUTCDate() + 7 * (n - 1));
  return d.getUTCMonth() === monthIndex ? iso(d) : null;
}

/** The inventory date for a given month: its fourth Tuesday. */
export function inventoryDateFor(year, monthIndex) {
  return nthWeekdayOfMonth(year, monthIndex, TUESDAY, 4);
}

/**
 * The window the worksheet's Sales and Purchases figures cover.
 *
 * Start is the most recent inventory date STRICTLY BEFORE today. "Strictly"
 * matters because the tool is used ON inventory day — on 2026-09-22 the
 * window has to reach back to 2026-08-25, not collapse onto today.
 * Both ends are inclusive.
 */
export function inventoryWindow(today = new Date()) {
  const t = typeof today === "string" ? new Date(today + "T00:00:00Z") : today;
  const end = iso(t);

  let y = t.getUTCFullYear();
  let m = t.getUTCMonth();
  for (let i = 0; i < 24; i++) {
    const candidate = inventoryDateFor(y, m);
    if (candidate && candidate < end) return { start: candidate, end };
    if (--m < 0) { m = 11; y--; }
  }
  throw new Error("inventoryWindow: no inventory date found in the last two years");
}

/**
 * The CaseVisibility business date for "last night's" freight — the night
 * whose trailers are not in the counted number yet. CV files a load under the
 * date it was scheduled to deliver, so the night before the count is simply
 * the day before.
 */
export function previousNight(today = new Date()) {
  const t = typeof today === "string" ? new Date(today + "T00:00:00Z") : new Date(today);
  const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - 1);
  return iso(d);
}

/** Shift an ISO date by whole days. Used to widen GDP's invoice-date filter. */
export function shiftDays(isoDate, days) {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
}

function iso(d) { return d.toISOString().slice(0, 10); }
