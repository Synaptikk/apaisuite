// modules/claimsdisposition/lib/cvp.js
//
// CVP Performance fetcher — pulls per-store sell-through data from
// Walmart's Hoops Report Hub GraphQL API.
//
// Why we care: a store with HIGH disposal rate AND LOW sell-through is
// the signature of "CVP'd then immediately disposed instead of sold."
// Sell-through is what tells us whether CVP'd merchandise actually
// moved off the floor. Without it we're flying blind on the back end
// of the disposition pipeline.
//
// Endpoint
// ────────
//   POST https://api.hoops.wal-mart.com/report-hub/v1/graphql
//   Auth: SSO session cookies on *.wal-mart.com (the cookies we set
//   when the user signed into Hoops in their browser).
//
// Cross-origin from chrome-extension:// works without any CSRF/XSRF
// header dance (unlike Workvivo) — Hoops accepts the extension origin
// and the *.wal-mart.com cookies are SameSite-permissive enough that
// the request includes them. Verified 2026-06-02 via dev/probe-hoops-cvp.mjs.
//
// We grab the rolling 8-week window in one call so the detail drawer
// can render a sell-through trend without a second round trip.

const HOOPS_GRAPHQL = "https://api.hoops.wal-mart.com/report-hub/v1/graphql";

const QUERY = `query CvpLast8Weeks($market: Int!, $dept: Int!) {
  result: cvpBuTypeBuIdWeekDeptGroupGet(where: { and: [
    { marketNbr:    { eq: $market } },
    { last8WeekInd: { eq: 1 } },
    { buType:       { eq: 6 } },
    { deptGroupNbr: { eq: $dept } }
  ] }) {
    storeNbr wmWeekNbr wmYearWkNbr
    firstCvpQty_Ty454
    cvpToCvpQty_Ty454
    cvpTotalQty_Ty454
    cvpSalesQty_Ty454
    cvpSalesRetailAmt_Ty454
  }
}`;

/**
 * Fetch the rolling 8-week CVP performance for every store in the
 * given market. Returns a pivoted shape ready to merge into a pull
 * record:
 *
 *   {
 *     fetchedAt: <epoch-ms>,
 *     latestWeek: <wmYearWkNbr>,
 *     byStore: {
 *       658: {
 *         week, yearWeek,
 *         firstCvpQty, cvpToCvpQty, cvpTotalQty,
 *         cvpSalesQty, cvpSalesRetailAmt, sellThrough,
 *         history: [{wmWeekNbr, wmYearWkNbr, sellThrough, cvpTotalQty, cvpSalesQty}, ...]
 *       },
 *       669: {...},
 *       ...
 *     }
 *   }
 *
 * `sellThrough` is the headline metric: cvpSalesQty / cvpTotalQty.
 * Higher = healthier (more CVP'd merch sold instead of disposed).
 *
 * Throws on network / non-2xx / malformed response. The pull handler
 * should treat CVP failures as non-fatal — the claims pull still
 * produces value without CVP, and the next pull will retry.
 */
export async function fetchCvpForMarket({ marketNbr = 120, deptGroupNbr = 2 } = {}) {
  const resp = await fetch(HOOPS_GRAPHQL, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json", "accept": "application/json" },
    body: JSON.stringify({
      query: QUERY,
      variables: { market: marketNbr, dept: deptGroupNbr },
    }),
  });
  if (!resp.ok) {
    throw new Error(`Hoops returned HTTP ${resp.status}`);
  }
  const json = await resp.json();
  if (json.errors?.length) {
    throw new Error(`Hoops GraphQL errors: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  const rows = Array.isArray(json?.data?.result) ? json.data.result : [];

  // Pivot: group by storeNbr, sort each group by week ascending.
  const byStoreHistory = new Map();
  for (const r of rows) {
    const store = Number(r.storeNbr);
    if (!Number.isFinite(store)) continue;
    if (!byStoreHistory.has(store)) byStoreHistory.set(store, []);
    byStoreHistory.get(store).push(r);
  }

  let latestWeek = 0;
  const byStore = {};
  for (const [store, history] of byStoreHistory.entries()) {
    history.sort((a, b) => a.wmYearWkNbr - b.wmYearWkNbr);
    const current = history[history.length - 1];
    if (current.wmYearWkNbr > latestWeek) latestWeek = current.wmYearWkNbr;
    byStore[store] = {
      week:               current.wmWeekNbr,
      yearWeek:           current.wmYearWkNbr,
      firstCvpQty:        Number(current.firstCvpQty_Ty454)        || 0,
      cvpToCvpQty:        Number(current.cvpToCvpQty_Ty454)        || 0,
      cvpTotalQty:        Number(current.cvpTotalQty_Ty454)        || 0,
      cvpSalesQty:        Number(current.cvpSalesQty_Ty454)        || 0,
      cvpSalesRetailAmt:  Number(current.cvpSalesRetailAmt_Ty454)  || 0,
      sellThrough:        computeSellThrough(current),
      history: history.map((r) => ({
        wmWeekNbr:     r.wmWeekNbr,
        wmYearWkNbr:   r.wmYearWkNbr,
        cvpTotalQty:   Number(r.cvpTotalQty_Ty454) || 0,
        cvpSalesQty:   Number(r.cvpSalesQty_Ty454) || 0,
        sellThrough:   computeSellThrough(r),
      })),
    };
  }

  return { fetchedAt: Date.now(), latestWeek, byStore };
}

function computeSellThrough(row) {
  const total = Number(row.cvpTotalQty_Ty454) || 0;
  const sold  = Number(row.cvpSalesQty_Ty454) || 0;
  return total > 0 ? sold / total : 0;
}

/** Severity buckets for the Store Comparison column cell coloring. */
export function sellThroughTier(rate) {
  if (rate >= 0.25) return "good";
  if (rate >= 0.15) return "amber";
  return "poor";
}

// Aggregate one store's CVP history into the same date window the user has
// active on the dashboard's filter. The Looker claim rollups already honour
// `filters.dateRange`; before this helper, the Sell-Through cell + drawer
// headline read `cvp.sellThrough` (one fiscal week from Hoops) and were
// visibly mismatched against the rest of the row.
//
// Hoops ships no calendar dates per week, so we synthesise them by walking
// back from `fetchedAt` in 7-day strides. The boundary is ±a few days off
// from Walmart's real fiscal week, which is fine for a comparison column.
//
// Returns null when there's nothing meaningful to render (no CVP data, no
// filter range). Returns zeroed totals + weeksUsed:0 when the filter range
// sits entirely outside the 8-week window — the caller distinguishes
// "missing CVP" vs "no overlap" to show "—" with a useful tooltip.
export function cvpForWindow(cvp, dateRange, fetchedAt) {
  if (!cvp?.history?.length || !dateRange?.from || !dateRange?.to) return null;
  const anchor = fetchedAt || Date.now();
  const WEEK_MS = 7 * 86400_000;

  // Walk newest → oldest, stamping a synthetic [start, end] on each week.
  const weeks = cvp.history.slice().reverse().map((w, i) => ({
    ...w,
    weekEnd:   anchor - i * WEEK_MS,
    weekStart: anchor - (i + 1) * WEEK_MS,
  }));

  const fromMs = dateRange.from.getTime();
  const toMs   = dateRange.to.getTime();
  const overlapping = weeks.filter((w) => w.weekEnd > fromMs && w.weekStart < toMs);

  const windowDays = Math.max(1, Math.ceil((toMs - fromMs) / 86400_000) + 1);
  const weeksWanted = Math.max(1, Math.ceil(windowDays / 7));
  const capped = weeksWanted > cvp.history.length;

  if (!overlapping.length) {
    return {
      sellThrough: 0, cvpTotalQty: 0, cvpSalesQty: 0,
      weeksUsed: 0, weeksAvailable: cvp.history.length, capped,
    };
  }

  let totalQty = 0, salesQty = 0;
  for (const w of overlapping) {
    totalQty += w.cvpTotalQty || 0;
    salesQty += w.cvpSalesQty || 0;
  }
  return {
    sellThrough:    totalQty > 0 ? salesQty / totalQty : 0,
    cvpTotalQty:    totalQty,
    cvpSalesQty:    salesQty,
    weeksUsed:      overlapping.length,
    weeksAvailable: cvp.history.length,
    capped,
  };
}
