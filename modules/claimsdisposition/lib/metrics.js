// modules/claimsdisposition/lib/metrics.js
//
// Pure aggregation helpers. Every function takes an array of canonical
// claim records and returns a derived structure ready for charts/tables.
// No React, no DOM. Ported verbatim from the donor's claimsMetrics.js;
// the only change is the DAY_NAMES import path.
//
// Memoization: filterRecords + byStore are called by every visualisation
// component (summaryCards, marketCharts, storeTable, timeOfDay, dayOfWeek,
// outlierPanel) on every setState fanout. With ~186k records from a live
// pull they cost ~50-200ms each — so naively that's 600ms+ wasted on
// duplicate work per render. Both are now reference-keyed memoized:
//   - filterRecords: keyed by (records, filters-serialized)
//   - byStore: keyed by (records) via WeakMap
// view.js passes the SAME state.records / state.filters references across
// all component update() calls in a setState fanout, so the cache hits.
// On the next setState that changes filters or records, the cache misses
// and recomputes once — components after the first re-use that result.

import { DAY_NAMES } from "./dates.js";

// Reference-identity cache for filterRecords. WeakMap on records lets the
// GC reclaim entries when an old records array is no longer referenced.
// The nested Map on serialized-filters string is bounded by the number of
// distinct filter combos the user has used while this records array is
// live — typically 1-3. Cleared when state.records changes (the old array
// becomes unreachable + GC drops the WeakMap entry).
const _filteredByRecords = new WeakMap();
function _filtersKey(filters) {
  if (!filters) return "";
  // Stable JSON — Date objects in dateRange serialize to ISO strings which
  // is what we want (identity comparison on Date instances would miss
  // semantically-equal Dates created in separate setState calls).
  return JSON.stringify({
    s:  filters.storeNumbers,
    d:  filters.dispositionTypes,
    dp: filters.departments,
    fr: filters.dateRange?.from?.getTime?.() ?? null,
    to: filters.dateRange?.to?.getTime?.()   ?? null,
  });
}

export function filterRecords(records, filters) {
  let perFilter = _filteredByRecords.get(records);
  if (perFilter) {
    const key = _filtersKey(filters);
    const cached = perFilter.get(key);
    if (cached) return cached;
  }
  const result = _filterRecordsUncached(records, filters);
  if (!perFilter) {
    perFilter = new Map();
    _filteredByRecords.set(records, perFilter);
  }
  perFilter.set(_filtersKey(filters), result);
  return result;
}

function _filterRecordsUncached(records, filters) {
  const {
    storeNumbers,
    dateRange,
    dispositionTypes,
    departments,
  } = filters || {};

  return records.filter((r) => {
    if (storeNumbers && storeNumbers.length && !storeNumbers.includes(r.storeNumber)) return false;
    if (dispositionTypes && dispositionTypes.length && !dispositionTypes.includes(r.dispositionType)) return false;
    if (departments && departments.length && !departments.includes(r.department)) return false;
    if (dateRange && dateRange.from && r.timestamp < dateRange.from) return false;
    if (dateRange && dateRange.to && r.timestamp > dateRange.to) return false;
    return true;
  });
}

export function fmtMoney(n) {
  return Number(n).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

export function fmtPct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

export function summarize(records) {
  let total = records.length;
  let disposalCount = 0, donationCount = 0, returnCount = 0, cvpCount = 0, otherCount = 0;
  let disposalValue = 0, donationValue = 0, totalValue = 0;
  for (const r of records) {
    totalValue += r.totalCost;
    switch (r.dispositionType) {
      case "Disposal": disposalCount++; disposalValue += r.totalCost; break;
      case "Donation": donationCount++; donationValue += r.totalCost; break;
      case "Return":   returnCount++;   break;
      case "CVP":      cvpCount++;      break;
      default:         otherCount++;
    }
  }
  return {
    total,
    disposalCount, donationCount, returnCount, cvpCount, otherCount,
    disposalValue, donationValue, totalValue,
    disposalRate: total ? disposalCount / total : 0,
    donationRate: total ? donationCount / total : 0,
  };
}

// Per-store rollup keyed by store number. Memoized for the same reason
// as filterRecords — called by storeTable, summaryCards (via highestStoreBy),
// AND outliers.js::detectOutliers within one setState fanout.
const _byStoreCache = new WeakMap();
export function byStore(records) {
  const cached = _byStoreCache.get(records);
  if (cached) return cached;
  const result = _byStoreUncached(records);
  _byStoreCache.set(records, result);
  return result;
}

function _byStoreUncached(records) {
  const map = new Map();
  for (const r of records) {
    if (!map.has(r.storeNumber)) map.set(r.storeNumber, []);
    map.get(r.storeNumber).push(r);
  }
  const out = [];
  for (const [storeNumber, recs] of map.entries()) {
    const s = summarize(recs);
    out.push({ storeNumber, ...s });
  }
  out.sort((a, b) => a.storeNumber - b.storeNumber);
  return out;
}

// Per-day series for the market (or single store after pre-filter).
export function dailyMarketSeries(records) {
  const byDay = new Map();
  for (const r of records) {
    if (!byDay.has(r.dateIso)) {
      byDay.set(r.dateIso, {
        dateIso: r.dateIso,
        disposalCount: 0,
        donationCount: 0,
        disposalValue: 0,
        donationValue: 0,
      });
    }
    const d = byDay.get(r.dateIso);
    if (r.dispositionType === "Disposal") {
      d.disposalCount++;
      d.disposalValue += r.totalCost;
    } else if (r.dispositionType === "Donation") {
      d.donationCount++;
      d.donationValue += r.totalCost;
    }
  }
  return Array.from(byDay.values()).sort((a, b) => a.dateIso.localeCompare(b.dateIso));
}

export function dailyStoreSeries(records, storeNumber) {
  return dailyMarketSeries(records.filter((r) => r.storeNumber === storeNumber));
}

// Hour-of-day rollup; returns 24 rows.
export function hourSeries(records, type /* "Disposal" | "Donation" | undefined */) {
  const buckets = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    count: 0,
    value: 0,
  }));
  for (const r of records) {
    if (type && r.dispositionType !== type) continue;
    buckets[r.hour].count++;
    buckets[r.hour].value += r.totalCost;
  }
  return buckets;
}

// Day-of-week rollup. Returns 7 rows ordered Mon..Sun for cleaner display.
export function dayOfWeekSeries(records) {
  const order = [1, 2, 3, 4, 5, 6, 0];
  const acc = new Map(order.map((d) => [
    d,
    { dow: d, name: DAY_NAMES[d], disposalCount: 0, donationCount: 0, disposalValue: 0, donationValue: 0 },
  ]));
  for (const r of records) {
    const row = acc.get(r.dayOfWeek);
    if (!row) continue;
    if (r.dispositionType === "Disposal") {
      row.disposalCount++;
      row.disposalValue += r.totalCost;
    } else if (r.dispositionType === "Donation") {
      row.donationCount++;
      row.donationValue += r.totalCost;
    }
  }
  return order.map((d) => acc.get(d));
}

// Highest store by metric. Returns { storeNumber, value } or null.
export function highestStoreBy(records, metric) {
  const rollup = byStore(records);
  if (!rollup.length) return null;
  return rollup.reduce((best, s) => (s[metric] > best[metric] ? s : best), rollup[0]);
}

// Per-user rollup scoped to a single store. Returns one row per distinct
// userId at the given store, sorted by total disposal+donation value desc.
// Used by the detail drawer's per-user breakdown table.
const _byUserAtStoreCache = new WeakMap();   // records → Map<storeNumber, rows[]>
export function byUserAtStore(records, storeNumber) {
  let perStore = _byUserAtStoreCache.get(records);
  if (perStore) {
    const cached = perStore.get(storeNumber);
    if (cached) return cached;
  }
  const storeRecs = records.filter((r) => r.storeNumber === storeNumber);
  const byUser = new Map();
  for (const r of storeRecs) {
    const u = r.userId || "(unknown)";
    if (!byUser.has(u)) byUser.set(u, []);
    byUser.get(u).push(r);
  }
  const rows = [];
  for (const [userId, recs] of byUser.entries()) {
    const s = summarize(recs);
    rows.push({ userId, ...s });
  }
  rows.sort((a, b) =>
    (b.disposalValue + b.donationValue) - (a.disposalValue + a.donationValue));
  if (!perStore) {
    perStore = new Map();
    _byUserAtStoreCache.set(records, perStore);
  }
  perStore.set(storeNumber, rows);
  return rows;
}

export function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

export function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance =
    arr.reduce((s, v) => s + (v - m) * (v - m), 0) / (arr.length - 1);
  return Math.sqrt(variance);
}
