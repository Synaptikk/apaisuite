// modules/metricshot/lib/format_message.js
//
// Build the text-only follow-up message that accompanies the screenshot on
// the afternoon/evening posts. Two sections:
//
//   1. Un-scanned bins — locations NOT scanned during today's scan window
//   2. Departments below a pick-% threshold (default 80%)
//
// Pure — no chrome.* or DOM access. Input is the parseVizPickResponse output
// plus the metric config + a `now` epoch for the header timestamp.
//
// The un-scanned cutoff is DERIVED FROM THE POST TIME. Scanning happens
// ~9am-12pm, so a location's age only matters relative to when we send: any
// bin last scanned before the window opened (9:00 AM) was missed today. We
// express that as an age cutoff measured from the post time:
//
//     cutoff (h) = postHour - 9
//
// and list only bins STRICTLY OLDER than the cutoff. A bin scanned at 9:00 AM
// is exactly `cutoff` hours old at post time, so `age > cutoff` is false and
// it is correctly NOT flagged. Worked examples:
//     8:00 PM post → cutoff 11h (a 9am scan = 11h → excluded)
//     4:00 PM post → cutoff  7h
//     4:30 PM post → cutoff  7.5h
// A non-positive cutoff (posting at/before 9am) means nothing can be
// "un-scanned" yet, so the section is omitted.

// Anchor hour: bins older than (postHour - ANCHOR_HOUR) hours are un-scanned.
// 9 = start of the scan window; a bin scanned right as the window opens is on
// the boundary and (via strict >) not flagged.
const ANCHOR_HOUR = 9;

// Fallback cutoff used only when we can't determine the post time (should not
// happen in normal operation — every caller passes `at`). Mirrors an 8pm post.
const DEFAULT_CUTOFF_HOURS = 11;

// Decimal hour-of-day (0..24) for `epochMs` in the given timezone.
function _hourOfDayInZone(epochMs, zone) {
  const opts = { hour: "2-digit", minute: "2-digit", hour12: false };
  if (zone && zone !== "local") opts.timeZone = zone;
  const parts = new Intl.DateTimeFormat("en-US", opts).formatToParts(new Date(epochMs));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const hh = parseInt(map.hour === "24" ? "00" : map.hour, 10);
  const mm = parseInt(map.minute, 10);
  if (!Number.isFinite(hh)) return null;
  return hh + (Number.isFinite(mm) ? mm / 60 : 0);
}

// The un-scanned age cutoff (hours) for a given post time. Returns null when
// the post time is unknown or non-positive (nothing can be un-scanned yet).
function _cutoffForPostTime(at, zone) {
  const postHour = _hourOfDayInZone(at, zone);
  if (!Number.isFinite(postHour)) return null;
  const cutoff = postHour - ANCHOR_HOUR;
  return cutoff > 0 ? cutoff : null;
}

const MAX_BINS_LISTED = 50;
const MAX_DEPTS_LISTED = 10;
// Departments at or above this pick % are considered healthy and omitted.
// Expressed as a fraction (0..1) to match parseVizPickResponse's pickPct.
const DEFAULT_PICK_THRESHOLD = 0.80;

/**
 * @param {object} args
 * @param {string} args.metricName          e.g. "VizPick Score"
 * @param {number} args.at                  epoch ms of the run
 * @param {string} [args.timezone]          for formatting the local time
 * @param {Array}  args.locationDetails     from parseVizPickResponse
 * @param {Array}  args.departmentBreakout  from parseVizPickResponse
 * @param {number} [args.cutoffHours]        override the auto-derived age cutoff
 * @param {number} [args.pickThreshold=0.80] list depts BELOW this pick % (fraction)
 * @returns {string|null}  the message body, or null if nothing to say
 */
export function formatUnscannedMessage({
  metricName, at, timezone,
  locationDetails, departmentBreakout,
  cutoffHours,
  pickThreshold = DEFAULT_PICK_THRESHOLD,
}) {
  // The cutoff scales with the post time (see _cutoffForPostTime). An explicit
  // `cutoffHours` arg still wins; DEFAULT_CUTOFF_HOURS is the last-resort
  // fallback when the post time can't be resolved.
  const cutoff = Number.isFinite(cutoffHours)
    ? cutoffHours
    : (_cutoffForPostTime(at, timezone) ?? DEFAULT_CUTOFF_HOURS);
  const lines = [];
  const timeStr = _fmtTime(at, timezone);
  lines.push(`${metricName} — details as of ${timeStr}`);

  const binsSection = _buildBinsSection(locationDetails || [], cutoff);
  if (binsSection) {
    lines.push("");
    lines.push(`Un-scanned locations (not scanned in >${_fmtHours(cutoff)}):`);
    lines.push(...binsSection);
  }

  const deptsSection = _buildDeptsSection(departmentBreakout || [], pickThreshold);
  if (deptsSection) {
    lines.push("");
    lines.push(`Departments below ${_fmtPct(pickThreshold)} pick:`);
    lines.push(...deptsSection);
  }

  // Only worth sending if we found anything meaningful.
  if (!binsSection && !deptsSection) return null;
  return lines.join("\n");
}

function _buildBinsSection(rows, cutoffHours) {
  const withHours = rows
    .map((r) => ({ loc: r.location, h: r.hoursSinceLastScan }))
    .filter((r) => r.loc && Number.isFinite(r.h));
  if (!withHours.length) return null;

  // A location is "un-scanned" if it was last scanned before today's scan
  // window opened — i.e. strictly OLDER than the cutoff. Strict `>` keeps a
  // bin scanned exactly at the window open (age === cutoff) OUT of the list.
  const unscanned = withHours
    .filter((r) => r.h > cutoffHours)
    .sort((a, b) => b.h - a.h);       // oldest first
  if (!unscanned.length) return null;

  const out = [`  ${unscanned.length} location(s):`];
  const shown = unscanned.slice(0, MAX_BINS_LISTED);
  for (const r of shown) {
    out.push(`    · ${r.loc} (${_fmtHours(r.h)})`);
  }
  if (unscanned.length > shown.length) {
    out.push(`    · (+${unscanned.length - shown.length} more)`);
  }
  return out;
}

function _buildDeptsSection(rows, pickThreshold) {
  const scored = rows
    .filter((r) => r.dept && r.dept !== "Total" && Number.isFinite(r.pickPct))
    .map((r) => ({
      dept: r.dept,
      // Normalize to a fraction so the threshold compare is consistent
      // whether Tableau hands us 0..1 or 0..100.
      pickPct: r.pickPct <= 1.5 ? r.pickPct : r.pickPct / 100,
      total: Number.isFinite(r.totalPicked) ? r.totalPicked : null,
    }))
    .filter((d) => d.pickPct < pickThreshold);
  if (!scored.length) return null;

  // Worst first, capped to the lowest MAX_DEPTS_LISTED.
  scored.sort((a, b) => a.pickPct - b.pickPct);
  const shown = scored.slice(0, MAX_DEPTS_LISTED);
  const out = shown.map((d) => {
    const suffix = d.total != null ? ` — ${d.total} picked` : "";
    return `  · Dept ${d.dept}: ${_fmtPct(d.pickPct)}${suffix}`;
  });
  if (scored.length > shown.length) {
    out.push(`  · (+${scored.length - shown.length} more)`);
  }
  return out;
}

function _fmtHours(h) {
  if (!Number.isFinite(h)) return "?";
  if (h < 1) return "<1h";
  if (h < 10) return `${Math.round(h * 10) / 10}h`;
  return `${Math.round(h)}h`;
}

function _fmtPct(p) {
  if (!Number.isFinite(p)) return "?";
  // Tableau may already return 0-100 or 0-1. If <= 1.5, treat as fraction.
  const pct = p <= 1.5 ? p * 100 : p;
  return `${Math.round(pct)}%`;
}

function _fmtTime(epochMs, zone) {
  const opts = { dateStyle: "medium", timeStyle: "short" };
  if (zone && zone !== "local") opts.timeZone = zone;
  try { return new Intl.DateTimeFormat([], opts).format(new Date(epochMs)); }
  catch { return new Date(epochMs).toString(); }
}
