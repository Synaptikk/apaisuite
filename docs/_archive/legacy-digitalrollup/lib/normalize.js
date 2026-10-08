// modules/digitalrollup/lib/normalize.js
//
// Turns a /api/dashboard payload into the snapshot we store and render.
//
// Deliberately thin. The GIF app already returns every metric BOTH raw and
// pre-formatted, and — unusually — already banded:
//
//   "pick_rate": 92.51, "pick_rate_fmt": "92.5", "pick_rate_status": "yellow"
//
// So there is no arithmetic to do here and no thresholds to invent. Renaming
// its forty-odd fields into a house vocabulary would add a translation layer
// whose only possible contribution is disagreeing with the source, so the card
// objects are kept VERBATIM and the view reads `card.picking.on_time_fmt`
// directly. What this module owns instead is the guard: confirming the fields
// the UI depends on are still present, and reporting the shape upward so a
// silent rename surfaces the way VizPick's did not (CURRENT_TASKS.md §8).

/**
 * Fields the cards cannot be rendered without. Everything else degrades to an
 * em-dash on its own, which is a legitimate value here — `ftp_pct` and
 * `nil_pick_pct` are null for every store in market 120 today, and
 * `scan_stage_pct` is null wherever scan-to-stage isn't in use.
 */
export const REQUIRED_CARD_PATHS = [
  "store_nbr",
  "picking.on_time_fmt",
  "picking.pick_rate_fmt",
  "picking.total_picks",
  "staging.totes_to_stage_fmt",
  "dispense.in_queue",
  "dispense.wait_time_fmt",
  "quality.pre_sub_fmt",
  "quality.post_sub_fmt",
];

export const REQUIRED_SUMMARY_PATHS = [
  "avg_on_time_pick",
  "avg_wait_time",
  "avg_pre_sub",
  "total_items_picked",
];

const at = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** Dotted key list for one object, for shared/schema_watch. Order-stable. */
export function flattenKeys(obj, prefix = "") {
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) return [];
  const out = [];
  for (const k of Object.keys(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    const v = obj[k];
    // One level of nesting is the whole shape here (card -> group -> field),
    // and stopping there keeps the watched list readable in a drift report.
    if (v != null && typeof v === "object" && !Array.isArray(v) && !prefix) {
      out.push(...flattenKeys(v, key));
    } else {
      out.push(key);
    }
  }
  return out.sort();
}

/**
 * @param {any} raw            the /api/dashboard body
 * @param {{market: string}} ctx
 * @returns {{ok:boolean, missing:string[], snapshot:object|null}}
 */
export function normalizeDashboard(raw, { market } = {}) {
  const cards = Array.isArray(raw?.cards) ? raw.cards : [];
  const missing = [];

  if (!cards.length) missing.push("cards[]");
  for (const p of REQUIRED_SUMMARY_PATHS) {
    if (at(raw?.summary, p) === undefined) missing.push(`summary.${p}`);
  }
  // Check the first card only. The API builds every card through one code
  // path, so a field missing from one is missing from all — and reporting the
  // same nine paths ten times would bury the signal.
  if (cards.length) {
    for (const p of REQUIRED_CARD_PATHS) {
      if (at(cards[0], p) === undefined) missing.push(`cards[].${p}`);
    }
  }

  if (missing.length) return { ok: false, missing, snapshot: null };

  return {
    ok: true,
    missing: [],
    snapshot: {
      version: 1,
      market: String(market ?? raw?.market_nbr ?? ""),
      capturedAt: Date.now(),

      // The app's own stamps. `refreshed_at_iso` is when the app last pulled
      // from GRT, which is NOT when we fetched — the freshness strip shows
      // both, because a stale board and a stale capture need different fixes.
      reportDate:      raw?.report_date ?? null,
      reportDateFmt:   raw?.report_date_fmt ?? null,
      granularity:     raw?.data_granularity ?? null,
      dataAge:         raw?.data_age ?? null,
      refreshedAt:     raw?.refreshed_at ?? null,
      refreshedAtFull: raw?.refreshed_at_full ?? null,
      refreshedAtIso:  raw?.refreshed_at_iso ?? null,

      storeCount: raw?.store_count ?? cards.length,
      summary:    raw?.summary ?? {},
      // Verbatim, see the header note.
      cards,
    },
  };
}
