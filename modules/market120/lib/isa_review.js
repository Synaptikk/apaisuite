// modules/market120/lib/isa_review.js
//
// Pure model for the Market 120 ISA review. The SW turns built Power BI query
// rows (lib/sources/isa_powerbi.js) into a compact, storable review; the view
// filters it by reason and drills into stores without another round trip.
//
// Sign convention: adjustment dollars are negative for shrink. "Largest" means
// most negative, so lists sort ascending by dollars.
//
// Pure: no chrome, no DOM, no network.

const DAY = 86_400_000;

const n = (v) => { const x = typeof v === "string" ? Number(v) : v; return Number.isFinite(x) ? x : 0; };
const cents = (v) => Math.round(n(v) * 100) / 100;
const str = (v) => (v == null ? "" : String(v).trim());
const byDollars = (a, b) => a.dollars - b.dollars;

/** Epoch ms (UTC midnight from Power BI) → "YYYY-MM-DD". */
export function ymd(ms) {
  return new Date(n(ms)).toISOString().slice(0, 10);
}

/** Latest date that actually carries adjustment dollars. */
export function latestDataDate(rows) {
  let max = null;
  for (const r of rows || []) {
    const d = n(r.Date);
    if (d && n(r.Dollars) !== 0 && (max == null || d > max)) max = d;
  }
  return max;
}

/** A `days`-long window ending on (and including) the data-through date. */
export function windowFromMaxDate(maxMs, days) {
  const to = n(maxMs) + DAY;
  return { from: ymd(to - days * DAY), to: ymd(to), days };
}

/** Walmart fiscal year starts Feb 1. */
export function fiscalYearStart(ms) {
  const d = new Date(n(ms));
  const year = d.getUTCMonth() >= 1 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${year}-02-01`;
}

function upcText(v) {
  const x = n(v);
  return x ? String(Math.round(x)) : str(v);
}

/**
 * Compact, storable review model.
 *
 * @param {object} p
 * @param {{from,to,days}} p.window
 * @param {string} p.dataThrough   "YYYY-MM-DD"
 * @param {string} p.fyFrom        "YYYY-MM-DD"
 * @param {object[]} p.trend       rows {Store, Reason, Date, Dollars}
 * @param {object[]} p.rollup      rows {Store, Reason, Dept, Cat, Dollars, Qty, Lines}
 * @param {object[]} p.sources     rows {Store, Reason, Source, Dollars}
 * @param {object[]|null} p.brFy     rows {Store, Type, Dollars, Qty}
 * @param {object[]|null} p.brWindow rows {Store, Type, Dollars, Qty}
 */
export function buildReview({ window, dataThrough, fyFrom, trend = [], rollup = [], sources = [], brFy = null, brWindow = null }) {
  const storeReason = new Map();
  const reasonTotals = new Map();
  for (const r of rollup) {
    const store = str(r.Store), reason = str(r.Reason);
    const key = `${store}|${reason}`;
    const acc = storeReason.get(key) || { store, reason, dollars: 0, qty: 0, lines: 0 };
    acc.dollars += n(r.Dollars); acc.qty += n(r.Qty); acc.lines += n(r.Lines);
    storeReason.set(key, acc);
    reasonTotals.set(reason, (reasonTotals.get(reason) || 0) + n(r.Dollars));
  }
  const brRows = (rows) => rows
    ? rows.map((r) => [str(r.Store), str(r.Type), cents(r.Dollars), n(r.Qty)]).filter((x) => x[2] !== 0 || x[3] !== 0)
    : null;

  return {
    version: 1,
    market: "120",
    window,
    dataThrough,
    fyFrom,
    reasons: [...reasonTotals.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => k),
    stores: [...new Set(rollup.map((r) => str(r.Store)))].sort((a, b) => Number(a) - Number(b)),
    byStoreReason: [...storeReason.values()].map((a) => [a.store, a.reason, cents(a.dollars), a.qty, a.lines]),
    trend: trend
      .map((r) => [ymd(r.Date), str(r.Store), str(r.Reason), cents(r.Dollars)])
      .filter((x) => x[3] !== 0),
    cats: rollup
      .map((r) => [str(r.Store), str(r.Reason), str(r.Dept), str(r.Cat), cents(r.Dollars), n(r.Qty)])
      .filter((x) => x[4] !== 0),
    sources: sources
      .map((r) => [str(r.Store), str(r.Reason), str(r.Source), cents(r.Dollars)])
      .filter((x) => x[3] !== 0),
    br: { fy: brRows(brFy), window: brRows(brWindow) },
  };
}

const reasonFilter = (reasons) => {
  const want = Array.isArray(reasons) && reasons.length ? new Set(reasons) : null;
  return (reason) => !want || want.has(reason);
};

function rollupBy(entries, keyFn, init) {
  const m = new Map();
  for (const e of entries) {
    const k = keyFn(e);
    const acc = m.get(k) || init(e);
    acc.dollars += e.dollars;
    acc.qty += e.qty || 0;
    m.set(k, acc);
  }
  return [...m.values()].map((x) => ({ ...x, dollars: cents(x.dollars) })).sort(byDollars);
}

function brByType(rows, store = null) {
  if (!rows) return null;
  const m = new Map();
  for (const [s, type, dollars, qty] of rows) {
    if (store != null && s !== store) continue;
    const acc = m.get(type) || { type, dollars: 0, qty: 0 };
    acc.dollars += dollars; acc.qty += qty;
    m.set(type, acc);
  }
  return [...m.values()].map((x) => ({ ...x, dollars: cents(x.dollars) })).sort(byDollars);
}

function stolenByStore(rows) {
  if (!rows) return null;
  const m = {};
  for (const [store, type, dollars] of rows) if (type === "Stolen") m[store] = cents((m[store] || 0) + dollars);
  return m;
}

/**
 * Market view for a reason selection (empty/null = all reasons).
 */
export function summarize(review, { reasons = null } = {}) {
  const ok = reasonFilter(reasons);
  const byReason = new Map();
  const byStore = new Map();
  let total = 0, qty = 0, lines = 0;

  for (const [store, reason, dollars, q, l] of review.byStoreReason) {
    const r = byReason.get(reason) || { reason, dollars: 0, qty: 0, lines: 0, selected: ok(reason) };
    r.dollars += dollars; r.qty += q; r.lines += l;
    byReason.set(reason, r);
    if (!ok(reason)) continue;
    const s = byStore.get(store) || { store, dollars: 0, qty: 0, lines: 0, byReason: {} };
    s.dollars += dollars; s.qty += q; s.lines += l;
    s.byReason[reason] = cents((s.byReason[reason] || 0) + dollars);
    byStore.set(store, s);
    total += dollars; qty += q; lines += l;
  }

  const sFy = stolenByStore(review.br?.fy) || {};
  const sWin = stolenByStore(review.br?.window) || {};
  const stores = [...byStore.values()]
    .map((s) => ({ ...s, dollars: cents(s.dollars), stolenFy: sFy[s.store] ?? null, stolenWindow: sWin[s.store] ?? null }))
    .sort(byDollars);
  stores.forEach((s, i) => { s.rank = i + 1; });

  const trendMap = new Map();
  for (const [date, , reason, dollars] of review.trend) {
    if (!ok(reason)) continue;
    trendMap.set(date, (trendMap.get(date) || 0) + dollars);
  }

  const cats = review.cats.filter((c) => ok(c[1])).map(([store, reason, dept, cat, dollars, q]) => ({ store, reason, dept, cat, dollars, qty: q }));

  return {
    total: cents(total), qty, lines,
    storeAvg: stores.length ? cents(total / stores.length) : null,
    byReason: review.reasons.map((reason) => byReason.get(reason)).filter(Boolean)
      .map((r) => ({ ...r, dollars: cents(r.dollars) })),
    stores,
    trend: [...trendMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, dollars]) => ({ date, dollars: cents(dollars) })),
    topCats: rollupBy(cats, (c) => `${c.dept}|${c.cat}`, (c) => ({ dept: c.dept, cat: c.cat, dollars: 0, qty: 0 })).slice(0, 15),
    topDepts: rollupBy(cats, (c) => c.dept, (c) => ({ dept: c.dept, dollars: 0, qty: 0 })).slice(0, 10),
    brFyByType: brByType(review.br?.fy),
    brWindowByType: brByType(review.br?.window),
  };
}

/** One store's slice of the stored review (no network). */
export function storeSummary(review, store, { reasons = null } = {}) {
  const ok = reasonFilter(reasons);
  const s = String(store);
  const trendMap = new Map();
  for (const [date, st, reason, dollars] of review.trend) {
    if (st !== s || !ok(reason)) continue;
    trendMap.set(date, (trendMap.get(date) || 0) + dollars);
  }
  const cats = review.cats.filter((c) => c[0] === s && ok(c[1]))
    .map(([, reason, dept, cat, dollars, q]) => ({ reason, dept, cat, dollars, qty: q }));
  const sources = rollupBy(
    review.sources.filter((x) => x[0] === s && ok(x[1])).map(([, reason, source, dollars]) => ({ source, dollars, qty: 0 })),
    (x) => x.source, (x) => ({ source: x.source, dollars: 0, qty: 0 }),
  );
  return {
    store: s,
    trend: [...trendMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, dollars]) => ({ date, dollars: cents(dollars) })),
    topCats: rollupBy(cats, (c) => `${c.dept}|${c.cat}`, (c) => ({ dept: c.dept, cat: c.cat, dollars: 0, qty: 0 })).slice(0, 12),
    topDepts: rollupBy(cats, (c) => c.dept, (c) => ({ dept: c.dept, dollars: 0, qty: 0 })).slice(0, 8),
    sources,
    brFyByType: brByType(review.br?.fy, s),
    brWindowByType: brByType(review.br?.window, s),
  };
}

/**
 * Item-level ISA rows for one store → items per (item, reason), keeping the
 * top `perReason` of each reason so a reason filter in the view still has
 * items to show.
 *
 * Rows: {Date, Reason, Source, Rule, Dept, Cat, Item, UPC, Desc, ItemRetail, Qty, Dollars, Lines}
 */
export function aggregateStoreItems(rows, { perReason = 60 } = {}) {
  const items = new Map();
  let total = 0, qty = 0, lines = 0;
  for (const r of rows || []) {
    const reason = str(r.Reason);
    const item = str(r.Item) || upcText(r.UPC);
    const key = `${item}|${reason}`;
    const d = n(r.Dollars), q = n(r.Qty), l = n(r.Lines) || 1;
    total += d; qty += q; lines += l;
    let it = items.get(key);
    if (!it) {
      it = {
        item, upc: upcText(r.UPC), desc: str(r.Desc), dept: str(r.Dept), cat: str(r.Cat), reason,
        itemRetail: n(r.ItemRetail) || null, dollars: 0, qty: 0, lines: 0,
        dates: new Set(), sources: new Set(), rules: new Set(),
      };
      items.set(key, it);
    }
    it.dollars += d; it.qty += q; it.lines += l;
    if (r.Date != null && n(r.Date)) it.dates.add(ymd(r.Date));
    if (str(r.Source)) it.sources.add(str(r.Source));
    if (str(r.Rule)) it.rules.add(str(r.Rule));
  }

  const finish = (it) => {
    const dates = [...it.dates].sort();
    return {
      item: it.item, upc: it.upc, desc: it.desc, dept: it.dept, cat: it.cat, reason: it.reason,
      itemRetail: it.itemRetail, dollars: cents(it.dollars), qty: it.qty, lines: it.lines,
      firstDate: dates[0] || null, lastDate: dates.at(-1) || null, days: dates.length,
      sources: [...it.sources].join(", "), rules: [...it.rules].join(", "),
    };
  };
  const byReason = new Map();
  for (const it of items.values()) {
    if (!byReason.has(it.reason)) byReason.set(it.reason, []);
    byReason.get(it.reason).push(finish(it));
  }
  const kept = [];
  for (const list of byReason.values()) kept.push(...list.sort(byDollars).slice(0, perReason));

  return { total: cents(total), qty, lines, itemCount: items.size, items: kept.sort(byDollars) };
}

/**
 * Backroom Adjustments Stolen rows for one store →
 * totals, users, categories and top items.
 *
 * Rows: {Date, Dept, Category, Item, UPC, Desc, User, Qty, Dollars}
 */
export function aggregateStolenItems(rows, { topN = 50 } = {}) {
  const items = new Map(), users = new Map(), cats = new Map();
  let total = 0, qty = 0, lastDate = null;
  for (const r of rows || []) {
    const d = n(r.Dollars), q = n(r.Qty);
    total += d; qty += q;
    const date = r.Date != null && n(r.Date) ? ymd(r.Date) : null;
    if (date && (!lastDate || date > lastDate)) lastDate = date;
    const item = str(r.Item) || upcText(r.UPC);
    let it = items.get(item);
    if (!it) {
      it = { item, upc: upcText(r.UPC), desc: str(r.Desc), dept: str(r.Dept), cat: str(r.Category), dollars: 0, qty: 0, lines: 0, users: new Set(), lastDate: null };
      items.set(item, it);
    }
    it.dollars += d; it.qty += q; it.lines += 1;
    if (str(r.User)) it.users.add(str(r.User));
    if (date && (!it.lastDate || date > it.lastDate)) it.lastDate = date;
    const u = str(r.User) || "(none)";
    const ua = users.get(u) || { user: u, dollars: 0, qty: 0, lines: 0 };
    ua.dollars += d; ua.qty += q; ua.lines += 1; users.set(u, ua);
    const c = str(r.Category) || "(none)";
    const ca = cats.get(c) || { cat: c, dollars: 0, qty: 0, lines: 0 };
    ca.dollars += d; ca.qty += q; ca.lines += 1; cats.set(c, ca);
  }
  const done = (x) => ({ ...x, dollars: cents(x.dollars) });
  return {
    total: cents(total), qty, lines: (rows || []).length, lastDate,
    byUser: [...users.values()].map(done).sort(byDollars).slice(0, 10),
    byCategory: [...cats.values()].map(done).sort(byDollars).slice(0, 10),
    items: [...items.values()]
      .map((it) => ({ ...done(it), users: [...it.users].join(", ") }))
      .sort(byDollars).slice(0, topN),
  };
}
