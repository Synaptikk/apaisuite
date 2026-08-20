// shared/sparkInvestigation/time_window.js
//
// Timezone-aware datetime helpers for Spark investigation flows. Every
// exception/order/trip carries a store-local event time; the Dispatcher API
// wants ISO-8601 with the store's UTC offset, and the UI displays times in
// the store's local zone.
//
// Extracted from modules/sparkfraud/view.js:143-165, parameterized on `tz`
// instead of the hardcoded `STORE_TZ = "America/New_York"` constant.
//
// Callers:
//   - SparkFraud (view.js) passes tz = "America/New_York" (its historical
//     hardcoded value — most stores it investigates are in that zone).
//   - Spark & Scan&Go passes tz derived from the exception row's store
//     when available; falls back to "America/New_York" otherwise.
//
// Runtime-inert: pure functions, no I/O.

/**
 * UTC offset string for a given zone at a given moment, in `±HH:MM` form.
 * Used to stamp Dispatcher API request bodies with the store's local offset.
 *
 * @param {Date} date  The moment (for DST correctness).
 * @param {string} tz  IANA zone name, e.g. "America/New_York".
 * @returns {string}   `"-04:00"` etc. Always well-formed.
 */
export function offsetStringFor(date, tz) {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" });
  const parts = fmt.formatToParts(date);
  const tzPart = parts.find((p) => p.type === "timeZoneName")?.value || "";
  let raw = tzPart.replace("GMT", "").trim() || "+00:00";
  if (/^[+-]\d$/.test(raw))    raw = raw.replace(/^([+-])(\d)$/, "$10$2:00");
  if (/^[+-]\d\d$/.test(raw))  raw = raw + ":00";
  return raw;
}

/**
 * Short zone abbreviation (e.g. "EDT", "PST") for display.
 */
export function tzAbbrFor(date, tz) {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" });
  const parts = fmt.formatToParts(date);
  return parts.find((p) => p.type === "timeZoneName")?.value || tz;
}

/**
 * Build a Date from a user-entered date + time string treated as store-local.
 *
 * The naïve `new Date("2026-07-31T14:30:00")` interprets in the browser's
 * zone, not the store's. This trick pretends the input is UTC, then shifts
 * by the delta between UTC and the target zone at that moment (which correctly
 * handles DST).
 *
 * @param {string} dateStr  "YYYY-MM-DD"
 * @param {string} timeStr  "HH:MM"
 * @param {string} tz       IANA zone
 * @returns {Date}
 */
export function makeStoreDate(dateStr, timeStr, tz) {
  const fakeUtc = new Date(`${dateStr}T${timeStr}:00Z`);
  const local = new Date(fakeUtc.toLocaleString("en-US", { timeZone: tz }));
  const utc   = new Date(fakeUtc.toLocaleString("en-US", { timeZone: "UTC" }));
  const offsetMs = utc.getTime() - local.getTime();
  return new Date(fakeUtc.getTime() + offsetMs);
}
