#!/usr/bin/env node
// dev/sparkrisk-sample-orders.mjs
//
// Builds a DIAGNOSTIC order set for SparkRisk and writes it as the JSON the
// module's Import Data tab accepts.
//
//   node dev/sparkrisk-sample-orders.mjs > /tmp/sparkrisk-sample.json
//
// THIS IS NOT FRAUD DATA. Nothing in it is a real trip and nothing in it is a
// real outcome. It exists to answer one question — "does the pipeline do what
// it says it does?" — by planting trips whose expected treatment is known in
// advance. It cannot answer "does SparkRisk catch fraud"; see
// dev/SPARKRISK_FOUNDATIONS.md §6.
//
// Each case below carries an `expect` note so the queue can be read against
// intent rather than vibes.

// Deterministic PRNG so two runs produce the same file.
let seed = 20260920;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const jitter = (pct) => 1 + (rnd() - 0.5) * 2 * pct;

const iso = (day, hour, min = 0) =>
  new Date(Date.UTC(2026, 8, day, hour, min, 0)).toISOString();

const orders = [];
let seq = 0;

/**
 * One trip = one or more orders sharing a trip_id.
 * @param {object} o
 * @param {string} o.driver   driver uuid ("" for an unidentified trip)
 * @param {number} o.day      September day
 * @param {number} o.hour     start hour, UTC
 * @param {number} o.items    total items across the trip
 * @param {number} o.secPerItem  the pace this trip is built to
 * @param {number} [o.split]  how many orders to split the trip across
 * @param {string} [o.store]
 * @param {object} [o.extra]  fields merged into every order of the trip
 */
function trip({ driver, day, hour, items, secPerItem, split = 1, store = '1458', extra = {} }) {
  const tripId = `TRIP-${String(++seq).padStart(4, '0')}`;
  const durationSec = Math.round(items * secPerItem * jitter(0.06));
  const start = iso(day, hour);
  const end = new Date(Date.parse(start) + durationSec * 1000).toISOString();
  // picked_time sits three quarters of the way through the trip.
  const picked = new Date(Date.parse(start) + durationSec * 750).toISOString();

  const perOrder = Math.floor(items / split);
  for (let i = 0; i < split; i++) {
    orders.push({
      order_id: `${store}-${String(++seq).padStart(6, '0')}`,
      trip_id: tripId,
      store_nbr: store,
      driver_uuid: driver || null,
      driver_first_name: driver ? driver.split('-')[1] : null,
      driver_last_name: driver ? 'Driver' : null,
      pick_started_time: start,
      picked_time: picked,
      dispatched_time: end,
      total_order_qty: i === split - 1 ? items - perOrder * (split - 1) : perOrder,
      status: 'DISPATCHED',
      ...extra,
    });
  }
  return tripId;
}

// ── A. Established driver, steady pace, then one outlier ────────────────
// EXPECT: the outlier scores high on BOTH excess time and driver deviation;
// the eight steady trips score 0 (they are under the 60s/item reference).
for (let d = 8; d <= 15; d++) trip({ driver: 'drv-alpha', day: d, hour: 14, items: 28, secPerItem: 48 });
const ALPHA_OUTLIER = trip({ driver: 'drv-alpha', day: 16, hour: 14, items: 26, secPerItem: 210 });

// ── B. Habitually slow driver, then the same outlier ────────────────────
// EXPECT: every trip scores on excess time, but the outlier's DEVIATION is
// muted because this driver's own baseline is already slow. This is the
// masking blind spot: a consistently slow driver normalises their own
// anomalies away. Compare B's outlier score against A's.
for (let d = 8; d <= 15; d++) trip({ driver: 'drv-bravo', day: d, hour: 11, items: 24, secPerItem: 112 });
const BRAVO_OUTLIER = trip({ driver: 'drv-bravo', day: 16, hour: 11, items: 24, secPerItem: 210 });

// ── C. Barely-seen driver ───────────────────────────────────────────────
// EXPECT: no baseline (fewer than 3 priors), so it is scored on excess time
// alone and reports history_coverage "none". A real first-week driver and a
// driver we simply have not imported look identical here.
trip({ driver: 'drv-charlie', day: 14, hour: 9, items: 20, secPerItem: 55 });
const CHARLIE_SLOW = trip({ driver: 'drv-charlie', day: 16, hour: 9, items: 22, secPerItem: 185 });

// ── D. Large batch, proportionally fast ─────────────────────────────────
// EXPECT: NOT flagged. 62 items in ~47 minutes is 45s/item. Before the
// context-multiplier removal this scored 10% higher purely for being a big
// batch. It must now sit at 0.
const BIG_BATCH = trip({ driver: 'drv-delta', day: 16, hour: 16, items: 62, secPerItem: 45 });

// ── E. Multi-order trip ─────────────────────────────────────────────────
// EXPECT: three orders collapse into ONE session with combined_items summed.
const MULTI = trip({ driver: 'drv-echo', day: 17, hour: 10, items: 33, secPerItem: 95, split: 3 });

// ── F. Unidentified driver ──────────────────────────────────────────────
// EXPECT: two separate sessions, both driver_key "unknown:…", neither
// contributing to nor receiving a baseline.
trip({ driver: '', day: 17, hour: 12, items: 18, secPerItem: 150 });
trip({ driver: '', day: 17, hour: 13, items: 18, secPerItem: 150 });

// ── G. Same order number at a second store ──────────────────────────────
// EXPECT: a separate session; the store-1458 session must NOT pick up this
// order, and drv-alpha gets no history credit here.
orders.push({
  order_id: '1458-000002',           // deliberately collides with a store-1458 id
  trip_id: 'TRIP-FOREIGN',
  store_nbr: '0999',
  driver_uuid: 'drv-alpha',
  pick_started_time: iso(16, 8),
  picked_time: iso(16, 8, 40),
  dispatched_time: iso(16, 8, 50),
  total_order_qty: 12,
  status: 'DISPATCHED',
  marker: 'other-store',
});

// ── H. Records that must be retained but never scored ───────────────────
// EXPECT: all four land in the orders store; "Orders not scored" counts them.
orders.push({ ...orders[0], order_id: '1458-900001', trip_id: 'TRIP-CANC', status: 'CANCELLED' });
orders.push({ ...orders[0], order_id: '1458-900002', trip_id: 'TRIP-ZERO', total_order_qty: 0 });
orders.push({ ...orders[0], order_id: '1458-900003', trip_id: 'TRIP-REV',
  pick_started_time: iso(16, 12), dispatched_time: iso(16, 11) });   // dispatch before pick
orders.push({ ...orders[0], order_id: '1458-900004', trip_id: 'TRIP-NOTS', dispatched_time: null });

// ── I. A record with no order_id at all ─────────────────────────────────
// EXPECT: rejected and counted, never stored.
orders.push({ ...orders[0], order_id: '   ', trip_id: 'TRIP-NOID' });

// ── J. A field carrying HTML, to prove the view escapes it ──────────────
// EXPECT: rendered as literal text in the Driver column, not interpreted.
trip({
  driver: 'drv-foxtrot', day: 18, hour: 15, items: 21, secPerItem: 170,
  extra: { driver_first_name: '<img src=x onerror=alert(1)>', driver_last_name: '"><b>XSS' },
});

const expectations = {
  ALPHA_OUTLIER, BRAVO_OUTLIER, CHARLIE_SLOW, BIG_BATCH, MULTI,
  note: 'Trip ids for the planted cases. See the comments in this file for what each one is supposed to do.',
};

if (process.argv.includes('--expectations')) {
  console.log(JSON.stringify(expectations, null, 2));
} else {
  console.log(JSON.stringify({ orders }, null, 2));
}
