// modules/cx/lib/market.js
//
// Every store in one market, side by side, from the Hoops Cx scorecard.
//
// ── What is and is not market-wide ──────────────────────────────────────
//
// The SCORES are. `metric.cx.megaCard.nps` and `.inStore` answer for any store's
// `buId`, and buType 5 addresses the market itself — so the market line is a
// real published figure, not an average of averages we invented.
//
// The COMMENTS are not. Medallia scopes to the role, and a Store Manager role
// sees exactly one store: a 1,000-response September sample taken with no store
// filter came back 1000/1000 store 1458 (dev/CX_FINDINGS.md section 2). So the
// theme breakdown stays home-store only, and the market view is deliberately a
// scoreboard rather than a second copy of the analysis.
//
// Cost: one request per store per metric, so 2N + 2. All plain cookie GETs with
// no tab driving, about 1 s each, run a few at a time — the whole of market 120
// (10 stores) lands in well under a minute.

import { fetchNps, fetchSubscores, SUBSCORES, TIME_TYPE, BU_TYPE_MARKET, HoopsError } from "./hoops.js";

/**
 * How many stores to read at once.
 *
 * Hoops is a shared internal service and these are someone's real quota. Four
 * keeps a ten-store market under a minute without arriving as a burst.
 */
const CONCURRENCY = 4;

/**
 * Pull the whole market.
 *
 * @param {number[]} storeNbrs  the roster (shared/marketRoster.js)
 * @param {object}   opts
 * @param {number|string} opts.marketNbr   pulled as its own buType-5 row
 * @param {string}   opts.homeStore        marked so it is findable in the table
 * @param {function} opts.onProgress       ({ done, total, store }) => void
 */
export async function fetchMarket(storeNbrs, { marketNbr = null, homeStore = null, onProgress = null } = {}) {
  const stores = [...new Set(storeNbrs.map(Number))].filter(Number.isFinite);
  if (!stores.length) throw new HoopsError("fetchMarket needs at least one store", "SHAPE");

  let done = 0;
  const total = stores.length + (marketNbr == null ? 0 : 1);

  const one = async (buId, buType) => {
    // Settled, not all: one store erroring must not lose the other nine. A
    // failed row is reported as a failed row.
    const [nps, sub] = await Promise.allSettled([
      fetchNps(buId, { timeType: TIME_TYPE.WEEK, buType }),
      fetchSubscores(buId, { timeType: TIME_TYPE.WEEK, buType }),
    ]);
    done++;
    onProgress?.({ done, total, store: buId });
    if (nps.status !== "fulfilled" && sub.status !== "fulfilled") {
      return { buId, ok: false, error: String(nps.reason?.message ?? nps.reason) };
    }
    return {
      buId,
      ok: true,
      nps: nps.status === "fulfilled" ? nps.value : null,
      subscores: sub.status === "fulfilled" ? sub.value : null,
    };
  };

  const rows = await mapWithLimit(stores, CONCURRENCY, (s) => one(s, 6));
  const market = marketNbr == null ? null : await one(Number(marketNbr), BU_TYPE_MARKET);

  return {
    marketNbr: marketNbr == null ? null : String(marketNbr),
    homeStore: homeStore == null ? null : String(homeStore),
    pulledAt: Date.now(),
    market,
    stores: rows,
  };
}

/**
 * Flatten a market pull into the table the panel draws: one row per store, the
 * latest published week, plus how each store sits against the market.
 *
 * "Latest published" is per store, not a shared cut-off — a store with no
 * responses this week would otherwise read as a zero rather than as a blank.
 */
export function marketTable(pull) {
  const marketLatest = latestOf(pull?.market);

  const rows = (pull?.stores ?? []).map((s) => {
    const latest = latestOf(s);
    return {
      store: String(s.buId),
      isHome: pull?.homeStore != null && String(s.buId) === String(pull.homeStore),
      ok: s.ok !== false,
      error: s.error ?? null,
      period: latest?.period ?? null,
      nps: latest?.nps ?? null,
      npsLy: latest?.npsLy ?? null,
      // Two different questions, and a store can be on opposite sides of them:
      // improving on itself while still behind the market, or the reverse.
      vsLy: diff(latest?.nps, latest?.npsLy),
      vsMarket: diff(latest?.nps, marketLatest?.nps),
      scores: latest?.scores ?? {},
      trend: latest?.trend ?? [],
    };
  });

  // Ranked by NPS. A store with no figure sorts last rather than as a zero.
  rows.sort((a, b) => (b.nps ?? -Infinity) - (a.nps ?? -Infinity));
  rows.forEach((r, i) => { r.rank = r.nps == null ? null : i + 1; });

  const scored = rows.filter((r) => r.nps != null);

  return {
    marketNbr: pull?.marketNbr ?? null,
    pulledAt: pull?.pulledAt ?? null,
    period: marketLatest?.period ?? scored[0]?.period ?? null,
    market: marketLatest
      ? { nps: marketLatest.nps, npsLy: marketLatest.npsLy, vsLy: diff(marketLatest.nps, marketLatest.npsLy),
          scores: marketLatest.scores, trend: marketLatest.trend }
      : null,
    rows,
    counts: { stores: rows.length, scored: scored.length },
    // Median, not mean: ten stores is a small set and one outlier drags a mean
    // somewhere no store actually is. Shown only as a sanity line beside the
    // published market figure, never in place of it.
    medianNps: median(scored.map((r) => r.nps)),
    homeRank: rows.find((r) => r.isHome)?.rank ?? null,
    subscores: SUBSCORES,
  };
}

// ── internals ───────────────────────────────────────────────────────────

function latestOf(entry) {
  if (!entry?.ok) return null;
  const periods = entry.nps?.periods ?? [];
  const withNps = periods.filter((p) => p.ty != null);
  const last = withNps[withNps.length - 1] ?? null;

  const subPeriods = entry.subscores?.periods ?? [];
  const lastSub = [...subPeriods].reverse()
    .find((p) => Object.values(p.scores ?? {}).some((v) => v.ty != null)) ?? null;

  if (!last && !lastSub) return null;

  const scores = {};
  for (const def of SUBSCORES) {
    const v = lastSub?.scores?.[def.key];
    scores[def.key] = { ty: v?.ty ?? null, ly: v?.ly ?? null };
  }

  return {
    period: last?.label ?? lastSub?.label ?? null,
    nps: last?.ty ?? null,
    npsLy: last?.ly ?? null,
    scores,
    // Sparkline data, trimmed to what the table cell can actually show.
    trend: withNps.slice(-13).map((p) => ({ label: p.label, ty: p.ty, ly: p.ly })),
  };
}

const diff = (a, b) => (a == null || b == null ? null : Math.round((a - b) * 100) / 100);

function median(nums) {
  const xs = nums.filter((n) => n != null).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : Math.round(((xs[mid - 1] + xs[mid]) / 2) * 10) / 10;
}

/** Run `fn` over `items` with at most `limit` in flight. Order is preserved. */
async function mapWithLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}
