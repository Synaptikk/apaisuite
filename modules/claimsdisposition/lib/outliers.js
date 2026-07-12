// modules/claimsdisposition/lib/outliers.js
//
// Outlier detection rules. Ported verbatim from the donor's
// outlierDetection.js. All rules operate on canonical claim records and
// emit a uniform "outlier event" shape that the UI renders directly.
//
// Rules implemented (each contributes to a store's composite score):
//   R1  Store disposal value > market disposal mean + 2σ          (multi-store)
//   R2  Store donation value > market donation mean + 2σ          (multi-store)
//   R3  Day disposal value > store daily mean + 2σ                (single-store)
//   R4  Day donation value > store daily mean + 2σ                (single-store)
//   R5  Hour bucket disposal count > store hourly mean + 2σ       (single-store)
//   R6  Disposal rate at a store is >1.5× the market rate         (multi-store)
//   R7  Donation value > 2× the store's earlier baseline          (single-store)
//
// The multi-store rules are gated by `canCompareAcrossStores` — with a
// single store in scope they're skipped, which is the intended behavior
// (mean = value, stdev = 0 → no signal).

import {
  fmtMoney, fmtPct, mean, stdev, summarize, byStore, byUserAtStore, dailyStoreSeries,
} from "./metrics.js";
import { formatDate } from "./dates.js";
import { cvpForWindow } from "./cvp.js";

const SEVERITY_ORDER = { Low: 1, Medium: 2, High: 3, Critical: 4 };

function severityFromZ(z) {
  if (z >= 4)   return "Critical";
  if (z >= 3)   return "High";
  if (z >= 2.5) return "Medium";
  return "Low";
}

// Reference-identity memo for detectOutliers + scoreStores. With live pulls
// (~186k records, 10 stores), each call costs 100-300ms because the per-
// store rules iterate days × hours × stores. Three components currently
// invoke detectOutliers per setState (summaryCards via filteredOutlierCount,
// storeTable via scoreStores, outlierPanel directly) — that's 3× the cost
// every render. View.js calls these with the SAME filtered-records array
// across all three components in one setState fanout, so a WeakMap keyed
// by the array identity cuts the repeat calls to a cache hit. The map
// holds at most one entry (the most recently filtered array) because the
// previous array becomes unreachable as soon as the next filterRecords
// returns a new one — GC reclaims it. No manual eviction needed.
const _outliersByRecords = new WeakMap();
const _scoresByRecords   = new WeakMap();

// R10 event cache keyed by (cvpByStore, window). Outer WeakMap → inner Map
// keyed by `${fromMs}|${toMs}|${fetchedAt}`. Independent from the
// _outliersByRecords cache because the inputs differ (R1–R9 keyed on
// records, R10 keyed on the CVP snapshot + the user's date window).
const _r10ByCvpByStore = new WeakMap();

function _r10Key(dateRange, fetchedAt) {
  const fr = dateRange?.from?.getTime?.() ?? "";
  const to = dateRange?.to?.getTime?.()   ?? "";
  return `${fr}|${to}|${fetchedAt ?? ""}`;
}

export function detectOutliers(records, cvpByStore = null, dateRange = null, fetchedAt = null) {
  let base = _outliersByRecords.get(records);
  if (!base) {
    base = _detectOutliersUncached(records);
    _outliersByRecords.set(records, base);
  }
  if (!cvpByStore || typeof cvpByStore !== "object") return base;
  let perWindow = _r10ByCvpByStore.get(cvpByStore);
  if (!perWindow) {
    perWindow = new Map();
    _r10ByCvpByStore.set(cvpByStore, perWindow);
  }
  const key = _r10Key(dateRange, fetchedAt);
  let r10 = perWindow.get(key);
  if (!r10) {
    r10 = _detectCvpOutliers(cvpByStore, dateRange, fetchedAt);
    perWindow.set(key, r10);
  }
  return r10.length ? [...base, ...r10] : base;
}

function _detectOutliersUncached(records) {
  const events = [];

  const storeRollup = byStore(records);
  if (storeRollup.length === 0) return events;

  const canCompareAcrossStores = storeRollup.length >= 2;

  // ---- Market-wide stats for store-level rules ----
  const disposalValues = storeRollup.map((s) => s.disposalValue);
  const donationValues = storeRollup.map((s) => s.donationValue);
  const marketDispMean = mean(disposalValues);
  const marketDispSd   = stdev(disposalValues);
  const marketDonMean  = mean(donationValues);
  const marketDonSd    = stdev(donationValues);

  const marketSummary  = summarize(records);
  const marketDispRate = marketSummary.disposalRate;

  if (canCompareAcrossStores) {
    for (const s of storeRollup) {
      // R1
      if (marketDispSd > 0) {
        const z = (s.disposalValue - marketDispMean) / marketDispSd;
        if (z >= 2) {
          events.push({
            id: `R1-${s.storeNumber}`,
            ruleId: "R1",
            storeNumber: s.storeNumber,
            type: "Disposal",
            dateLabel: "Period total",
            timeWindow: null,
            metric: "Total disposal value",
            expectedRange: `≤ ${fmtMoney(marketDispMean + 2 * marketDispSd)} (market mean + 2 SD)`,
            actualValue: fmtMoney(s.disposalValue),
            severity: severityFromZ(z),
            zScore: z,
            explanation: `Store ${s.storeNumber} disposal value is ${z.toFixed(1)} SD above the Market 120 average (${fmtMoney(marketDispMean)}).`,
          });
        }
      }
      // R2
      if (marketDonSd > 0) {
        const z = (s.donationValue - marketDonMean) / marketDonSd;
        if (z >= 2) {
          events.push({
            id: `R2-${s.storeNumber}`,
            ruleId: "R2",
            storeNumber: s.storeNumber,
            type: "Donation",
            dateLabel: "Period total",
            timeWindow: null,
            metric: "Total donation value",
            expectedRange: `≤ ${fmtMoney(marketDonMean + 2 * marketDonSd)}`,
            actualValue: fmtMoney(s.donationValue),
            severity: severityFromZ(z),
            zScore: z,
            explanation: `Store ${s.storeNumber} donation value is ${z.toFixed(1)} SD above the market average (${fmtMoney(marketDonMean)}).`,
          });
        }
      }
      // R6 (disposal-rate skew)
      if (marketDispRate > 0 && s.disposalRate > marketDispRate * 1.5 && s.total >= 200) {
        events.push({
          id: `R6-${s.storeNumber}`,
          ruleId: "R6",
          storeNumber: s.storeNumber,
          type: "Disposal",
          dateLabel: "Period total",
          timeWindow: null,
          metric: "Disposal rate vs market",
          expectedRange: `≤ ${fmtPct(marketDispRate * 1.5)}`,
          actualValue: fmtPct(s.disposalRate),
          severity: s.disposalRate > marketDispRate * 2 ? "High" : "Medium",
          zScore: s.disposalRate / Math.max(marketDispRate, 1e-6),
          explanation: `Store ${s.storeNumber}'s disposal rate (${fmtPct(s.disposalRate)}) is well above the market average (${fmtPct(marketDispRate)}).`,
        });
      }
    }

    // ---- R9 — Sparse staffing (unusually few disposal-handling associates) ----
    // For each store, count distinct users with ≥ 1 disposal. Compare each
    // store's count to the market-wide mean. Anomalously LOW (mean − 1.5 SD
    // or more) on a store with ≥ 200 disposals = a small group handling
    // the volume of a much larger team. Floor on disposal count avoids
    // false positives at tiny stores where 2 associates is normal.
    const userCountByStore = new Map();
    for (const s of storeRollup) {
      const usersAtStore = byUserAtStore(records, s.storeNumber)
        .filter((u) => u.disposalValue > 0);
      userCountByStore.set(s.storeNumber, usersAtStore.length);
    }
    const userCounts = [...userCountByStore.values()];
    const userCountMean = mean(userCounts);
    const userCountSd   = stdev(userCounts);
    if (userCountSd > 0) {
      for (const s of storeRollup) {
        if (s.disposalCount < 200) continue;
        const userCount = userCountByStore.get(s.storeNumber) ?? 0;
        const deficitSd = (userCountMean - userCount) / userCountSd;
        if (deficitSd >= 1.5) {
          events.push({
            id: `R9-${s.storeNumber}`,
            ruleId: "R9",
            storeNumber: s.storeNumber,
            type: "Disposal",
            dateLabel: "Period total",
            timeWindow: null,
            metric: "Unique disposal users vs market",
            expectedRange: `≥ ${(userCountMean - 1.5 * userCountSd).toFixed(0)} associates (market mean − 1.5 SD)`,
            actualValue: `${userCount} associates`,
            severity: deficitSd >= 2.5 ? "High" : "Medium",
            zScore: deficitSd,
            explanation: `Store ${s.storeNumber} processed ${s.disposalCount.toLocaleString()} disposals via only ${userCount} associates — ${deficitSd.toFixed(1)} SD below the market mean of ${userCountMean.toFixed(1)} associates per store.`,
          });
        }
      }
    }
  }

  // ---- Per-store day-of-period rules ----
  const storeRecordMap = new Map();
  for (const r of records) {
    if (!storeRecordMap.has(r.storeNumber)) storeRecordMap.set(r.storeNumber, []);
    storeRecordMap.get(r.storeNumber).push(r);
  }

  for (const [storeNumber, recs] of storeRecordMap.entries()) {
    const dailySeries = dailyStoreSeries(recs, storeNumber);
    const dailyDisp = dailySeries.map((d) => d.disposalValue);
    const dailyDispMean = mean(dailyDisp);
    const dailyDispSd   = stdev(dailyDisp);
    const dailyDon = dailySeries.map((d) => d.donationValue);
    const dailyDonMean = mean(dailyDon);
    const dailyDonSd   = stdev(dailyDon);

    for (const d of dailySeries) {
      // R3
      if (dailyDispSd > 0) {
        const z = (d.disposalValue - dailyDispMean) / dailyDispSd;
        if (z >= 2 && d.disposalValue > 0) {
          events.push({
            id: `R3-${storeNumber}-${d.dateIso}`,
            ruleId: "R3",
            storeNumber,
            type: "Disposal",
            dateLabel: formatDate(d.dateIso),
            timeWindow: null,
            metric: "Daily disposal value",
            expectedRange: `≤ ${fmtMoney(dailyDispMean + 2 * dailyDispSd)} (store mean + 2 SD)`,
            actualValue: fmtMoney(d.disposalValue),
            severity: severityFromZ(z),
            zScore: z,
            explanation: `Store ${storeNumber} disposal value on ${formatDate(d.dateIso)} was ${(d.disposalValue / Math.max(dailyDispMean, 1)).toFixed(1)}× its ${dailySeries.length}-day baseline.`,
          });
        }
      }
      // R4
      if (dailyDonSd > 0) {
        const z = (d.donationValue - dailyDonMean) / dailyDonSd;
        if (z >= 2 && d.donationValue > 0) {
          events.push({
            id: `R4-${storeNumber}-${d.dateIso}`,
            ruleId: "R4",
            storeNumber,
            type: "Donation",
            dateLabel: formatDate(d.dateIso),
            timeWindow: null,
            metric: "Daily donation value",
            expectedRange: `≤ ${fmtMoney(dailyDonMean + 2 * dailyDonSd)}`,
            actualValue: fmtMoney(d.donationValue),
            severity: severityFromZ(z),
            zScore: z,
            explanation: `Store ${storeNumber} donations on ${formatDate(d.dateIso)} ran ${(d.donationValue / Math.max(dailyDonMean, 1)).toFixed(1)}× the store's baseline.`,
          });
        }
      }
    }

    // R5 (hour-of-day disposal spike) — REMOVED 2026-05-31.
    // Hour-bucket peaks are normal: every store processes the bulk of
    // claims at open and close, so 2σ spikes there reflect workflow,
    // not fraud. The rule generated almost-pure noise. If we want to
    // bring hour patterns back, the right framing is "this store's
    // hour distribution differs significantly from the market's
    // distribution" (KL-divergence) — but that's a future-work signal.

    // ---- R8 — Disposal volume concentrated in top 20% of users ----
    // Pareto signal. Even when no single user trips U3's 30% threshold,
    // a small subset of users handling most of the volume is meaningful.
    // Requires ≥ 5 disposal-active users at the store; otherwise "top 20%"
    // is too granular and any 1-user store would trivially trip it.
    const usersAtStore = byUserAtStore(records, storeNumber)
      .filter((u) => u.disposalValue > 0);
    if (usersAtStore.length >= 5) {
      const byDispDesc = [...usersAtStore].sort((a, b) => b.disposalValue - a.disposalValue);
      const top20Count = Math.max(1, Math.ceil(byDispDesc.length * 0.20));
      const top20Total = byDispDesc.slice(0, top20Count).reduce((s, u) => s + u.disposalValue, 0);
      const storeDispTotal = byDispDesc.reduce((s, u) => s + u.disposalValue, 0);
      if (storeDispTotal > 0) {
        const share = top20Total / storeDispTotal;
        if (share >= 0.70) {
          const sev = share >= 0.90 ? "High" : share >= 0.80 ? "Medium" : "Low";
          events.push({
            id: `R8-${storeNumber}`,
            ruleId: "R8",
            storeNumber,
            type: "Disposal",
            dateLabel: "Period total",
            timeWindow: null,
            metric: "Top-20% user disposal-$ concentration",
            expectedRange: "< 50% (broadly distributed)",
            actualValue: fmtPct(share),
            severity: sev,
            zScore: share,
            explanation: `Top ${top20Count} of ${usersAtStore.length} disposal-handling associates at store ${storeNumber} account for ${fmtPct(share)} of disposal $ (${fmtMoney(top20Total)} of ${fmtMoney(storeDispTotal)}).`,
          });
        }
      }
    }

    // R7 — donation against an earlier-period baseline (last 7 vs prior days)
    if (dailySeries.length >= 14) {
      const recent   = dailySeries.slice(-7).map((d) => d.donationValue);
      const baseline = dailySeries.slice(0, -7).map((d) => d.donationValue);
      const recentMean = mean(recent);
      const baseMean   = mean(baseline);
      if (baseMean > 0 && recentMean > 2 * baseMean && recentMean > 50) {
        events.push({
          id: `R7-${storeNumber}`,
          ruleId: "R7",
          storeNumber,
          type: "Donation",
          dateLabel: "Last 7 days",
          timeWindow: null,
          metric: "Donation value vs prior baseline",
          expectedRange: `≤ ${fmtMoney(baseMean * 2)}`,
          actualValue: fmtMoney(recentMean),
          severity: recentMean > 3 * baseMean ? "High" : "Medium",
          zScore: recentMean / Math.max(baseMean, 1),
          explanation: `Store ${storeNumber} donations over the last 7 days are ${(recentMean / baseMean).toFixed(1)}× the prior baseline.`,
        });
      }
    }
  }

  events.sort((a, b) =>
    SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || b.zScore - a.zScore);
  return events;
}

// Composite outlier score per store → drives the risk flag column.
// Rolls in BOTH store-level R-events AND per-user U-events so the
// Store Comparison Risk pill reflects associate-level signals (a
// single dominant disposer at a store should raise the store's risk,
// not just sit hidden in the drawer). Memoized via WeakMap on records.
//
// Cost: detectUserOutliers runs once per store (memoized itself), so
// the first scoreStores() call after a pull is O(stores × users) on
// top of detectOutliers. For ~10 stores × ~50 users that's ~100ms; all
// subsequent renders are cache hits.
export function scoreStores(records, cvpByStore = null, dateRange = null, fetchedAt = null) {
  let base = _scoresByRecords.get(records);
  if (!base) {
    base = new Map();
    const events = _outliersByRecords.get(records) || _detectOutliersUncached(records);
    if (!_outliersByRecords.has(records)) _outliersByRecords.set(records, events);
    for (const e of events) {
      const w = SEVERITY_ORDER[e.severity] || 1;
      base.set(e.storeNumber, (base.get(e.storeNumber) || 0) + w);
    }
    // Per-store user-event contribution: ONLY the top severity at the
    // store, NOT the sum. Summing was over-counting concentration — a
    // store with one dominant disposer triggers U1+U3+U4 simultaneously,
    // which used to add 7 weight on its own and instantly maxed the Risk
    // pill. Top-severity-only means "what's the worst user signal at
    // this store"; the Assoc. Flags column already shows the count
    // separately so the analyst sees magnitude vs concentration.
    for (const sn of new Set(records.map((r) => r.storeNumber))) {
      const userEvents = detectUserOutliers(records, sn);
      if (!userEvents.length) continue;
      let topWeight = 0;
      for (const e of userEvents) {
        const w = SEVERITY_ORDER[e.severity] || 1;
        if (w > topWeight) topWeight = w;
      }
      base.set(sn, (base.get(sn) || 0) + topWeight);
    }
    _scoresByRecords.set(records, base);
  }
  if (!cvpByStore || typeof cvpByStore !== "object") return base;
  // R10 contributions are added on top of the cached base without
  // mutating it (different CVP snapshots or filter windows can re-augment
  // the same records cache).
  const augmented = new Map(base);
  for (const e of _detectCvpOutliers(cvpByStore, dateRange, fetchedAt)) {
    const w = SEVERITY_ORDER[e.severity] || 1;
    augmented.set(e.storeNumber, (augmented.get(e.storeNumber) || 0) + w);
  }
  return augmented;
}

// Risk thresholds rebalanced 2026-06-02 after the U-event-folding
// scoring change inflated every store to Critical. With user-events
// now contributing top-severity-only, the score ceiling drops by
// ~10–20 points per store; thresholds shift down to compensate while
// still requiring meaningfully more signal than the old R-only era.
export function riskFlagFromScore(score) {
  if (score >= 10) return "Critical";
  if (score >= 6)  return "High";
  if (score >= 3)  return "Watch";
  return "Normal";
}

// Per-store associate-flag counts → drives the "Associate Flags" column
// in the Store Comparison table. Returns Map<storeNumber, {count, topSeverity}>
// where topSeverity is the highest severity ("Critical" > "High" > "Medium"
// > "Low") of any user-event at that store, or null if no flags.
const _userFlagsByRecords = new WeakMap();
export function userFlagCountByStore(records) {
  if (_userFlagsByRecords.has(records)) return _userFlagsByRecords.get(records);
  const out = new Map();
  for (const sn of new Set(records.map((r) => r.storeNumber))) {
    const events = detectUserOutliers(records, sn);
    if (!events.length) { out.set(sn, { count: 0, topSeverity: null }); continue; }
    let topSeverity = events[0].severity;
    for (const e of events) {
      if (SEVERITY_ORDER[e.severity] > SEVERITY_ORDER[topSeverity]) topSeverity = e.severity;
    }
    out.set(sn, { count: events.length, topSeverity });
  }
  _userFlagsByRecords.set(records, out);
  return out;
}

// ── Per-user outlier rules (scoped to a single store) ────────────
//
// The detail drawer drills into one store at a time. Within that store,
// some users handle more value than peers — flag them so the analyst
// sees who's driving the store's totals.
//
//   U1  User's disposal value > store user-mean + 2σ
//   U2  User's donation value > store user-mean + 2σ
//   U3  User handles ≥ 30% of the store's disposal value AND has ≥ 50
//       disposal records (concentration risk — one person responsible
//       for the bulk of the store's disposal $)
//
// Memoized the same way as the store-level rules.
const _userOutliersByRecordsStore = new WeakMap();   // records → Map<storeNumber, events[]>

export function detectUserOutliers(records, storeNumber) {
  let perStore = _userOutliersByRecordsStore.get(records);
  if (perStore) {
    const cached = perStore.get(storeNumber);
    if (cached) return cached;
  }
  const events = _detectUserOutliersUncached(records, storeNumber);
  if (!perStore) {
    perStore = new Map();
    _userOutliersByRecordsStore.set(records, perStore);
  }
  perStore.set(storeNumber, events);
  return events;
}

function _detectUserOutliersUncached(records, storeNumber) {
  const events = [];
  const userRows = byUserAtStore(records, storeNumber);
  if (userRows.length < 2) return events;   // need peers to compare against

  // Store-level totals (for the concentration rule)
  const storeDispTotal = userRows.reduce((s, r) => s + r.disposalValue, 0);

  // U1 / U2: z-score against peer users at this store
  const userDisp = userRows.map((r) => r.disposalValue);
  const userDon  = userRows.map((r) => r.donationValue);
  const dispMean = mean(userDisp);
  const dispSd   = stdev(userDisp);
  const donMean  = mean(userDon);
  const donSd    = stdev(userDon);

  for (const row of userRows) {
    // U1
    if (dispSd > 0) {
      const z = (row.disposalValue - dispMean) / dispSd;
      if (z >= 2 && row.disposalValue > 0) {
        events.push({
          id: `U1-${storeNumber}-${row.userId}`,
          ruleId: "U1",
          storeNumber,
          userId: row.userId,
          type: "Disposal",
          metric: "User disposal value",
          actualValue: fmtMoney(row.disposalValue),
          expectedRange: `≤ ${fmtMoney(dispMean + 2 * dispSd)} (store user-mean + 2 SD)`,
          severity: severityFromZ(z),
          zScore: z,
          explanation:
            `${row.userId} disposed ${fmtMoney(row.disposalValue)} — ${z.toFixed(1)} SD above the store's per-user average (${fmtMoney(dispMean)}).`,
        });
      }
    }
    // U2
    if (donSd > 0) {
      const z = (row.donationValue - donMean) / donSd;
      if (z >= 2 && row.donationValue > 0) {
        events.push({
          id: `U2-${storeNumber}-${row.userId}`,
          ruleId: "U2",
          storeNumber,
          userId: row.userId,
          type: "Donation",
          metric: "User donation value",
          actualValue: fmtMoney(row.donationValue),
          expectedRange: `≤ ${fmtMoney(donMean + 2 * donSd)}`,
          severity: severityFromZ(z),
          zScore: z,
          explanation:
            `${row.userId} donated ${fmtMoney(row.donationValue)} — ${z.toFixed(1)} SD above the store's per-user average (${fmtMoney(donMean)}).`,
        });
      }
    }
    // U3: concentration
    if (storeDispTotal > 0 && row.disposalCount >= 50) {
      const share = row.disposalValue / storeDispTotal;
      if (share >= 0.4) {
        events.push({
          id: `U3-${storeNumber}-${row.userId}`,
          ruleId: "U3",
          storeNumber,
          userId: row.userId,
          type: "Disposal",
          metric: "Share of store disposal value",
          actualValue: fmtPct(share),
          expectedRange: `< ${fmtPct(0.4)}`,
          severity: share >= 0.6 ? "High" : "Medium",
          zScore: share,
          explanation:
            `${row.userId} accounts for ${fmtPct(share)} of store ${storeNumber}'s disposal value (${row.disposalCount} disposal records).`,
        });
      }
    }
  }

  // ---- U4 — Top-3 disposer at ≥ 2× the store's median user disposal $ ----
  // Catches standout individuals even when the store has too few users
  // for U1's z-score to be reliable. Uses median (not mean) because the
  // distribution is heavily right-skewed — one big disposer would inflate
  // the mean enough to hide the next-most-suspicious user.
  // Requires ≥ 3 disposal-active users (otherwise top-3 is the whole list)
  // and ≥ 5 disposals per user (avoid noise from one-off transactions).
  const dispUsers = userRows
    .filter((u) => u.disposalValue > 0 && u.disposalCount >= 5);
  if (dispUsers.length >= 3) {
    const sortedByDisp = [...dispUsers].sort((a, b) => b.disposalValue - a.disposalValue);
    const top3 = sortedByDisp.slice(0, 3);
    // Median across all disposal-active users at the store
    const vals = dispUsers.map((u) => u.disposalValue).sort((a, b) => a - b);
    const mid = Math.floor(vals.length / 2);
    const median = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
    if (median > 0) {
      for (const user of top3) {
        const ratio = user.disposalValue / median;
        if (ratio >= 3) {
          const sev = ratio >= 8 ? "High" : ratio >= 5 ? "Medium" : "Low";
          events.push({
            id: `U4-${storeNumber}-${user.userId}`,
            ruleId: "U4",
            storeNumber,
            userId: user.userId,
            type: "Disposal",
            metric: "Disposal $ vs store median",
            actualValue: fmtMoney(user.disposalValue),
            expectedRange: `< ${fmtMoney(median * 2)} (2× store median)`,
            severity: sev,
            zScore: ratio,
            explanation:
              `${user.userId} disposed ${fmtMoney(user.disposalValue)} — ${ratio.toFixed(1)}× the store's median disposer (${fmtMoney(median)}) and a top-3 producer at store ${storeNumber}.`,
          });
        }
      }
    }
  }

  events.sort((a, b) =>
    SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || b.zScore - a.zScore);
  return events;
}

// Composite per-user score for the drawer's risk pill. Same severity
// weighting as scoreStores.
export function scoreUsersAtStore(records, storeNumber) {
  const events = detectUserOutliers(records, storeNumber);
  const byUser = new Map();
  for (const e of events) {
    const w = SEVERITY_ORDER[e.severity] || 1;
    byUser.set(e.userId, (byUser.get(e.userId) || 0) + w);
  }
  return byUser;
}

// ── R10 — Low CVP sell-through ────────────────────────────────
//
// "CVP then immediately dispose" pattern: the store marked items down to
// clearance (CVP) but instead of selling them, they're heading straight
// to disposal. Low sell-through ratio paired with high disposal $ is
// the strongest fraud signal we have on the back end of the disposition
// pipeline. R10 surfaces the low-sell-through half; analysts combine
// it with the existing disposal-side signals (R1, R3, U1, etc.) in the
// store drawer.
//
// Window: sums all Hoops history weeks that overlap the user's date
// filter (via cvpForWindow), so R10 fires on the same period the rest of
// the dashboard reports — not just the latest fiscal week.
//
// Thresholds chosen against typical Market 120 ranges (10-25% is normal):
//   < 15%  → Medium
//   < 10%  → High
//   <  5%  → Critical
//
// Floor: store must have ≥ 100 active CVP units across the window. Tiny
// CVP volumes make the percentage noisy (1 unit moves 10% on a 10-unit
// base). The floor stays at 100 across windows because that's about the
// minimum sample where a rate is meaningful — scaling it by week count
// would let large multi-week sums slip past on noisy tiny stores.
function _detectCvpOutliers(cvpByStore, dateRange = null, fetchedAt = null) {
  const events = [];
  for (const [snStr, cvp] of Object.entries(cvpByStore || {})) {
    const sn = Number(snStr);
    if (!Number.isFinite(sn) || !cvp) continue;

    // Prefer windowed totals; fall back to the latest-week snapshot when
    // no filter is in effect (cold render before the view has wired up
    // state.filters.dateRange).
    const win = cvpForWindow(cvp, dateRange, fetchedAt);
    const total      = win && win.weeksUsed > 0 ? win.cvpTotalQty : (Number(cvp.cvpTotalQty) || 0);
    const salesQty   = win && win.weeksUsed > 0 ? win.cvpSalesQty : (Number(cvp.cvpSalesQty) || 0);
    const st         = win && win.weeksUsed > 0 ? win.sellThrough : (Number(cvp.sellThrough) || 0);
    const weeksUsed  = win ? win.weeksUsed : 1;
    const dateLabel  = weeksUsed > 1 ? `Last ${weeksUsed} weeks` : `Week ${cvp.week ?? "?"}`;

    if (total < 100) continue;
    if (st >= 0.15) continue;

    const sev = st < 0.05 ? "Critical" : st < 0.10 ? "High" : "Medium";
    events.push({
      id: `R10-${sn}`,
      ruleId: "R10",
      storeNumber: sn,
      type: "CVP",
      dateLabel,
      timeWindow: null,
      metric: "CVP sell-through rate",
      expectedRange: "≥ 15% units sold while in CVP",
      actualValue: `${(st * 100).toFixed(1)}% (${salesQty.toLocaleString()}/${total.toLocaleString()} units)`,
      severity: sev,
      zScore: 1 - st,
      explanation:
        `Store ${sn} sold only ${(st * 100).toFixed(1)}% of its ${total.toLocaleString()} CVP'd units over ${dateLabel.toLowerCase()}. Low sell-through paired with high disposal $ is the signal of "CVP then dispose" rather than "CVP then sell".`,
    });
  }
  return events;
}
