// modules/sparkrisk/lib/sessions.js
//
// Trip-session construction + timing-review scoring for SparkRisk.
//
// SCOPE WARNING (read before changing any number in this file):
// This is a TIMING TRIAGE ranking, not a fraud classifier. Nothing here has
// been calibrated against confirmed outcomes, because no outcome-labelled
// source has been mapped yet (see dev/SPARKRISK_FOUNDATIONS.md). The
// 60-second-per-item figure is an arbitrary REFERENCE constant, not a
// threshold derived from data. `priority_score` orders a review queue; it is
// not a probability of anything.

// Statistical helpers
function median(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mad(arr) {
  if (!arr.length) return null;
  const med = median(arr);
  if (med === null) return null;
  const devs = arr.map(x => Math.abs(x - med));
  return median(devs);
}

function calculateDriverBaselines(sessions) {
  // Sort by session start time for chronological processing
  const sorted = [...sessions].sort((a, b) => 
    new Date(a.session_start) - new Date(b.session_start)
  );
  
  const driverHistory = new Map();  // driver_key → [session_spi, ...]
  const baselines = new Map();      // session_id → { count, median, mad }
  
  for (const s of sorted) {
    const driverKey = s.driver_key;
    if (!driverKey || driverKey.startsWith('unknown:')) continue;
    
    // Get prior sessions for this driver
    const historyKey = JSON.stringify([s.store || '', driverKey]);
    const priorSessions = (driverHistory.get(historyKey) || []).filter(x => x.at < s.session_start).map(x => x.spi);
    
    // Calculate baseline from prior sessions
    baselines.set(s.session_id, {
      count: priorSessions.length,
      median: median(priorSessions),
      mad: mad(priorSessions)
    });
    
    // Add this session to driver history for future sessions
    if (!driverHistory.has(historyKey)) {
      driverHistory.set(historyKey, []);
    }
    if (s.session_spi) {
      driverHistory.get(historyKey).push({ at: s.session_start, spi: s.session_spi });
    }
  }
  
  return baselines;
}

// Arbitrary reference rate. Changing it rescales every excess_minutes and
// priority_score in the DB; a full re-import is required afterwards.
export const BASE_SECONDS_PER_ITEM = 60;

// Lower bound on the deviation scale, as a fraction of the driver's median
// seconds-per-item. See the comment in scoreSessions().
export const MIN_SIGMA_FRACTION_OF_MEDIAN = 1 / 3;

export function scoreSessions(sessions, context) {
  // Calculate driver baselines first (FIX: use driver_key instead of driver_pseudonym)
  const baselines = calculateDriverBaselines(sessions);
  
  return sessions.map(session => {
    const baseline = baselines.get(session.session_id) || { count: 0, median: null, mad: null };
    
    // Driver deviation: a MAD-based z-score against this driver's own prior
    // trips at this store.
    //
    // The scale is FLOORED at a third of the median. Without that floor a
    // driver whose priors cluster tightly produces a near-zero MAD, and the
    // z-score explodes - a real run on sample data produced 109 sigma from
    // 8 trips, which is not a number anyone should act on or display. The
    // floor is the same scale the old `median / 3` fallback branch used when
    // MAD was exactly 0, so that branch is now just the limiting case of
    // this one rather than a separate rule.
    //
    // This is a numerical-stability guard, not a calibration. It bounds the
    // deviation term at roughly 3x the relative deviation from the median.
    let driverDeviation = null;
    if (baseline.count >= 3 && baseline.median !== null && baseline.median > 0) {
      const sigma = Math.max((baseline.mad || 0) * 1.4826, baseline.median * MIN_SIGMA_FRACTION_OF_MEDIAN);
      driverDeviation = (session.session_spi - baseline.median) / sigma;
    }
    
    // Expected duration uses a FIXED reference rate, not a fitted one.
    const expectedMs = BASE_SECONDS_PER_ITEM * (session.combined_items || 0) * 1000;
    const excessMs = (session.session_duration_ms || 0) - expectedMs;
    const excessMinutes = excessMs / 60000;
    
    // Calculate priority score
    const baseScore = calculateBaseScore({
      ...session,
      excess_minutes: excessMinutes,
      driver_deviation: driverDeviation
    });
    const contextScore = applyContextAdjustments(baseScore, session, context);
    
    // History coverage describes how much prior recorded activity this driver
    // has at this store. It is NOT a confidence that the session is anomalous.
    const historyCoverage = baseline.count >= 10 ? 'recorded'
      : baseline.count >= 3 ? 'limited'
      : 'none';
    
    return { 
      ...session, 
      driver_prior_count: baseline.count,
      driver_prior_median_spi: baseline.median ? Math.round(baseline.median * 10) / 10 : null,
      driver_deviation: driverDeviation == null ? null : Math.round(driverDeviation * 100) / 100,
      expected_duration_ms: Math.round(expectedMs),
      excess_minutes: Math.round(excessMinutes * 10) / 10,
      priority_score: contextScore,
      history_coverage: historyCoverage,
      explanation: `Timing review only. Compared with a fixed ${BASE_SECONDS_PER_ITEM}-second-per-item reference (an arbitrary constant, not a calibrated threshold) and ${baseline.count} prior recorded session(s) for this driver at this store. Peer comparison is unavailable — no peer source has been mapped. Picked and dispatched are source statuses, not verified register arrival or store exit. This score ranks a review queue; it is not a probability of fraud.`
    };
  });
}

function calculateBaseScore(session) {
  // Priority score = excess time + driver deviation + peer percentile
  const excessWeight = 0.4;
  const deviationWeight = 0.3;
  
  const excessScore = Math.max(0, Math.min((session.excess_minutes || 0) * 2, 100));
  const deviationScore = Math.max(0, Math.min((session.driver_deviation || 0) * 5, 100));
  
  const hasBaseline = session.driver_deviation != null;
  return ((excessScore * excessWeight) + (hasBaseline ? deviationScore * deviationWeight : 0)) /
    (excessWeight + (hasBaseline ? deviationWeight : 0));
}

// Context adjustments are deliberately a no-op.
//
// The previous implementation multiplied the score by 0.9 for `is_peak_1to4`,
// 0.95 for `is_weekend` and 1.1 for `order_count > 3`. The first two fields are
// never written by buildSessionFromOrders(), so those branches were dead code.
// The batch-size multiplier DID fire, and it had no supporting evidence: a
// larger batch already contributes more items to the expected-duration
// reference, so multiplying the result again double-counted batch size.
// Re-introduce an adjustment here only with a source that justifies it.
function applyContextAdjustments(score, _session, _context) {
  return Math.max(0, Math.min(score, 100));
}

export async function buildSessionsFromOrders(orders) {
  // Group orders by trip_id and driver
  const tripMap = new Map();
  
  for (const order of orders) {
    const tripKey = JSON.stringify([order.store_nbr || order.store_id || order.store || '', String(order.pick_started_time || '').slice(0, 10), driverIdentity(order), order.trip_id || `order:${order.order_id}`]);
    if (!tripMap.has(tripKey)) {
      tripMap.set(tripKey, []);
    }
    tripMap.get(tripKey).push(order);
  }
  
  // Build sessions
  const sessions = [];
  for (const [tripKey, tripOrders] of tripMap) {
    const session = buildSessionFromOrders(tripOrders);
    if (session) sessions.push(session);
  }
  
  return sessions;
}

export function buildSessionFromOrders(orders) {
  if (!orders.length) return null;
  
  const firstOrder = orders[0];
  const pickTimes = orders.map(o => timestamp(o.pick_started_time));
  const dispatchTimes = orders.map(o => timestamp(o.dispatched_time));
  
  if (pickTimes.some(t => t == null) || dispatchTimes.some(t => t == null)) return null;
  if (orders.some((o, i) => dispatchTimes[i] <= pickTimes[i] || /cancel/i.test(o.status || '') || !(Number(o.total_order_qty) > 0))) return null;
  
  const sessionStart = new Date(Math.min(...pickTimes));
  const sessionEnd = new Date(Math.max(...dispatchTimes));
  const durationMs = sessionEnd - sessionStart;
  
  const totalItems = orders.reduce((sum, o) => sum + Number(o.total_order_qty), 0);
  const spi = totalItems > 0 ? durationMs / 1000 / totalItems : null;
  
  // Longest picked-to-dispatch gap across the trip's orders. Named
  // register_time_ms for DB back-compat only: neither endpoint is a verified
  // register event, both are source order statuses.
  const registerTimeMs = orders.reduce((max, o) => {
    if (timestamp(o.picked_time) != null && timestamp(o.picked_time) >= timestamp(o.pick_started_time) && timestamp(o.picked_time) <= timestamp(o.dispatched_time)) {
      const rt = timestamp(o.dispatched_time) - timestamp(o.picked_time);
      return Math.max(max, rt);
    }
    return max;
  }, 0);
  
  // Create driver_key with proper fallback chain (FIX: driver grouping bug)
  const driverKey = driverIdentity(firstOrder);
  
  return {
    session_id: `trip:${JSON.stringify([firstOrder.store_nbr || firstOrder.store_id || firstOrder.store || '', String(firstOrder.pick_started_time).slice(0, 10), driverKey, firstOrder.trip_id || firstOrder.order_id])}`,
    store: String(firstOrder.store_nbr || firstOrder.store_id || firstOrder.store || ''),
    trip_id: firstOrder.trip_id,
    driver_id: firstOrder.driver_id,
    driver_uuid: firstOrder.driver_uuid,
    driver_key: driverKey,  // NEW: unified driver identifier
    driver_name: `${firstOrder.driver_first_name || ''} ${firstOrder.driver_last_name || ''}`.trim(),
    order_ids: JSON.stringify(orders.map(o => o.order_id)),
    order_count: orders.length,
    combined_items: totalItems,
    extraction_date: String(firstOrder.pick_started_time).slice(0, 10),
    session_start: sessionStart.toISOString(),
    session_duration_ms: durationMs,
    session_spi: spi,
    register_time_ms: registerTimeMs,
    dispatched_time: sessionEnd.toISOString(),
    review_window_start: orders.every(o => timestamp(o.picked_time) != null && timestamp(o.picked_time) >= timestamp(o.pick_started_time) && timestamp(o.picked_time) <= timestamp(o.dispatched_time)) ? new Date(Math.min(...orders.map(o => timestamp(o.picked_time)))).toISOString() : null,
    // Placeholders for scoring
    driver_prior_count: null,  // Will be filled by scoring
    driver_prior_median_spi: null,
    driver_deviation: null,
    excess_minutes: null,
    expected_duration_ms: null,
    priority_score: 0,
    history_coverage: 'none'
  };
}

function timestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}
function driverIdentity(o) {
  return String(o.driver_uuid || o.driver_id || o.driver_pseudonym || `unknown:${o.order_id}`);
}

