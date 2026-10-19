// modules/claimsdisposition/lib/cvp.js
//
// CVP Performance fetcher — per-store sell-through from Ops Portal.
//
// Why we care: a store with HIGH disposal rate AND LOW sell-through is
// the signature of "CVP'd then immediately disposed instead of sold."
// Sell-through is what tells us whether CVP'd merchandise actually
// moved off the floor.
//
// Source: Ops Portal's `metric.cvp.megaCard.CVPOverview` (see the category
// section below), store total (depts/sbuIds [-9999], the CVP page's "Total"
// tile), one GET per store. This replaced the Hoops Report Hub GraphQL
// query (api.hoops.wal-mart.com/report-hub/v1/graphql), which started
// answering 404 and left every pull with `cvp: null`; found 2026-10-18.
//
// The returned shape is unchanged so the store table, drawer and R10
// outlier rule read it as before. `sellThrough` stays cvpSalesQty /
// cvpTotalQty (the ratio sellThroughTier's 25% / 15% bands were set on),
// NOT Ops Portal's own cvpSellThruPct, which runs ~55-70%.

const HISTORY_WEEKS = 8;

/**
 * Rolling 8-week CVP performance for the given stores:
 *
 *   { fetchedAt, latestWeek, byStore: { 1458: {
 *       week, yearWeek, firstCvpQty, cvpToCvpQty, cvpTotalQty,
 *       cvpSalesQty, cvpSalesRetailAmt, sellThrough,
 *       history: [{ wmWeekNbr, wmYearWkNbr, cvpTotalQty, cvpSalesQty, sellThrough }] } },
 *     errors: [] }
 *
 * The newest week is the current, partial one (Ops Portal timeOffset 0).
 * Per-store failures land in `errors`; throws only when every store failed,
 * so the pull handler logs it as before.
 */
export async function fetchCvpForStores(stores) {
  const byStore = {};
  const errors = [];
  let latestWeek = 0;
  await Promise.all(stores.map(async (s) => {
    try {
      const weeks = (await fetchOpsCvpWeeks(s, [-9999], [-9999])).slice(-HISTORY_WEEKS);
      if (!weeks.length) return;
      const cur = weeks[weeks.length - 1];
      if (cur.yearWeek > latestWeek) latestWeek = cur.yearWeek;
      byStore[Number(s)] = {
        week:              weekNbr(cur),
        yearWeek:          cur.yearWeek,
        firstCvpQty:       cur.firstCvpQty,
        cvpToCvpQty:       cur.cvpToCvpQty,
        cvpTotalQty:       cur.totalQty,
        cvpSalesQty:       cur.soldQty,
        cvpSalesRetailAmt: cur.salesRetailAmt,
        sellThrough:       ratio(cur.soldQty, cur.totalQty),
        history: weeks.map((w) => ({
          wmWeekNbr:   weekNbr(w),
          wmYearWkNbr: w.yearWeek,
          cvpTotalQty: w.totalQty,
          cvpSalesQty: w.soldQty,
          sellThrough: ratio(w.soldQty, w.totalQty),
        })),
      };
    } catch (e) {
      errors.push(`${s}: ${e?.message ?? e}`);
    }
  }));
  if (stores.length && !Object.keys(byStore).length) {
    throw new Error(`no store returned CVP (${errors[0] ?? "empty"})`);
  }
  return { fetchedAt: Date.now(), latestWeek, byStore, errors };
}

const ratio = (sold, total) => (total > 0 ? sold / total : 0);
const weekNbr = (w) => w.yearWeek % 100;

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

// ── Ops Portal CVP by store category ────────────────────────────
//
// The same tRPC call the Ops Portal CVP page makes for its Fresh / F&C / GM
// tiles (`metric.cvp.megaCard.CVPOverview`, cookie auth, plain GET), one per
// store per category, with the dept lists from categories.js so F&C excludes
// Fresh. timeType 202 = fiscal weeks: 14 rows, timeOffset -13 .. 0, where 0
// is the current, partial week. Verified 2026-10-18 for 1458 WK37: F&C-only
// 2,145 + Fresh 8,160 = the portal's F&C tile 10,305; GM by depts = by SBU.

const OPS_CVP_TRPC = "https://hoops.wal-mart.com/ops-portal/v1/trpc/metric.cvp.megaCard.CVPOverview";

async function fetchOpsCvpWeeks(storeNbr, depts, sbuIds = []) {
  const input = encodeURIComponent(JSON.stringify({
    json: { buId: Number(storeNbr), buType: 6, timeType: 202, depts, sbuIds },
  }));
  const res = await fetch(`${OPS_CVP_TRPC}?input=${input}`, { credentials: "include" });
  if (!res.ok) throw new Error(`Ops Portal CVP ${res.status} for store ${storeNbr}`);
  const grid = (await res.json())?.result?.data?.json;
  const cols = grid?.meta?.columns;
  if (!Array.isArray(cols) || !Array.isArray(grid?.rows)) {
    throw new Error(`Ops Portal CVP returned no grid for store ${storeNbr}`);
  }
  const i = Object.fromEntries(cols.map((c, n) => [c, n]));
  return grid.rows.map((r) => ({
    week:         r[i.timeTextShort],          // "WK37"
    yearWeek:     r[i.timeInt],                // 202637
    offset:       r[i.timeOffset],             // 0 = current partial week
    totalQty:     Number(r[i.cvpTotalQty_Ty454]) || 0,
    soldQty:      Number(r[i.cvpSalesQty_Ty454]) || 0,
    firstCvpQty:  Number(r[i.firstCvpQty_Ty454]) || 0,
    cvpToCvpQty:  Number(r[i.cvpToCvpQty_Ty454]) || 0,
    salesRetailAmt: Number(r[i.cvpSalesRetailAmt_Ty454]) || 0,
    adherencePct: numOrNull(r[i.cvpAdherencePct_Ty454]),
    sellThruPct:  numOrNull(r[i.cvpSellThruPct_Ty454]),
  })).sort((a, b) => a.offset - b.offset);
}

function numOrNull(v) {
  const n = Number(v);
  return v == null || v === "" || !Number.isFinite(n) ? null : n;
}

/**
 * Ops Portal CVP weeks for every store × category. Per-store failures are
 * recorded, not thrown, so one store's 403 doesn't blank the rest.
 * Returns { fetchedAt, byStore: { [store]: { fc: weeks[], fresh, gm } }, errors }.
 */
export async function fetchOpsCvpByCategory(stores, deptsByCategory) {
  const byStore = {};
  const errors = [];
  const jobs = [];
  for (const s of stores) {
    byStore[s] = {};
    for (const [cat, depts] of Object.entries(deptsByCategory)) {
      jobs.push(fetchOpsCvpWeeks(s, depts)
        .then((weeks) => { byStore[s][cat] = weeks; })
        .catch((e) => { errors.push(`${s}/${cat}: ${e?.message ?? e}`); }));
    }
  }
  await Promise.all(jobs);
  return { fetchedAt: Date.now(), byStore, errors };
}

/**
 * One category's Ops Portal week across the given stores. Percentages are
 * averaged weighted by each store's CVP units (totalQty) — the portal ships
 * only percentages, so this is the closest multi-store figure it allows.
 * `offset` -1 = last full week, 0 = current week to date.
 */
export function opsCvpWeek(opsCvp, stores, category, offset = -1) {
  if (!opsCvp?.byStore) return null;
  let qty = 0, adhW = 0, adhQ = 0, stW = 0, stQ = 0, week = null, n = 0;
  for (const s of stores) {
    const w = opsCvp.byStore[s]?.[category]?.find((x) => x.offset === offset);
    if (!w) continue;
    n++;
    week = week || w.week;
    qty += w.totalQty;
    if (w.adherencePct != null) { adhW += w.adherencePct * w.totalQty; adhQ += w.totalQty; }
    if (w.sellThruPct  != null) { stW  += w.sellThruPct  * w.totalQty; stQ  += w.totalQty; }
  }
  if (!n) return null;
  return {
    week, stores: n, totalQty: qty,
    adherencePct: adhQ ? adhW / adhQ : null,
    sellThruPct:  stQ  ? stW  / stQ  : null,
  };
}
