// modules/metricshot/lib/format_message.js
//
// Build the text-only follow-up message that accompanies the screenshot on
// the 2pm and 8pm posts. Two sections:
//
//   1. Un-scanned bins bucketed by hours since last scan (>12h / >9h / >6h)
//   2. Departments below a pick-% threshold (default 80%)
//
// Pure — no chrome.* or DOM access. Input is the parseVizPickResponse output
// plus the metric config + a `now` epoch for the header timestamp.

const DEFAULT_TIERS = [
  { minHours: 12, label: "URGENT (>12h)" },
  { minHours:  9, label: "HIGH (>9h)"    },
  { minHours:  6, label: "AGED (>6h)"    },
];

const MAX_BINS_PER_TIER = 20;
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
 * @param {Array}  [args.tiers]             override default 12/9/6 tiers
 * @param {number} [args.pickThreshold=0.80] list depts BELOW this pick % (fraction)
 * @returns {string|null}  the message body, or null if nothing to say
 */
export function formatUnscannedMessage({
  metricName, at, timezone,
  locationDetails, departmentBreakout,
  tiers = DEFAULT_TIERS,
  pickThreshold = DEFAULT_PICK_THRESHOLD,
}) {
  const lines = [];
  const timeStr = _fmtTime(at, timezone);
  lines.push(`${metricName} — details as of ${timeStr}`);

  const binsSection = _buildBinsSection(locationDetails || [], tiers);
  if (binsSection) {
    lines.push("");
    lines.push("Un-scanned locations:");
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

function _buildBinsSection(rows, tiers) {
  const withHours = rows
    .map((r) => ({ loc: r.location, h: r.hoursSinceLastScan }))
    .filter((r) => r.loc && Number.isFinite(r.h));
  if (!withHours.length) return null;

  // Sort by hours descending.
  withHours.sort((a, b) => b.h - a.h);

  // Group by tier: each row lands in the FIRST tier whose minHours it exceeds.
  // Tiers are already ordered highest-first in DEFAULT_TIERS.
  const buckets = tiers.map((t) => ({ ...t, rows: [] }));
  const consumed = new Set();
  for (const t of buckets) {
    for (const r of withHours) {
      if (consumed.has(r)) continue;
      if (r.h > t.minHours) { t.rows.push(r); consumed.add(r); }
    }
  }

  const out = [];
  let any = false;
  for (const t of buckets) {
    if (!t.rows.length) continue;
    any = true;
    out.push(`  ${t.label}: ${t.rows.length}`);
    const shown = t.rows.slice(0, MAX_BINS_PER_TIER);
    for (const r of shown) {
      out.push(`    · ${r.loc} (${_fmtHours(r.h)})`);
    }
    if (t.rows.length > shown.length) {
      out.push(`    · (+${t.rows.length - shown.length} more)`);
    }
  }
  return any ? out : null;
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

  // Worst first.
  scored.sort((a, b) => a.pickPct - b.pickPct);
  return scored.map((d) => {
    const suffix = d.total != null ? ` — ${d.total} picked` : "";
    return `  · Dept ${d.dept}: ${_fmtPct(d.pickPct)}${suffix}`;
  });
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
