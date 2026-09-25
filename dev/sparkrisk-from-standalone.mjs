#!/usr/bin/env node
// dev/sparkrisk-from-standalone.mjs
//
// Converts the standalone Spark-Risk tool's SQLite corpus into the JSON that
// the suite module's Import Data tab accepts.
//
//   node dev/sparkrisk-from-standalone.mjs 1458 > <somewhere outside the repo>.json
//   node dev/sparkrisk-from-standalone.mjs 1458 --stats     # mapping report only
//
// SOURCE: C:\Users\ses008s.s01458\Desktop\Spark-Risk\app\spark-risk\spark-risk.db
// Override with SPARKRISK_DB.
//
// ⚠ THE OUTPUT CONTAINS REAL DRIVER NAMES AND EMAIL ADDRESSES. Write it
// outside the repo, do not commit it, and do not send it anywhere.
//
// ── The mapping, and why ──────────────────────────────────────────────
// The standalone schema's own columns do NOT line up with the module's model:
// it has `picking_start_time` / `picking_end_time` and no dispatch column at
// all. But every row carries a `task_events` array holding the real source
// status stream, including the exact three the module is built around:
//
//     PICK_STARTED  →  pick_started_time
//     PICKED        →  picked_time        (drives the video review window)
//     DISPATCHED    →  dispatched_time
//
// So the events are used, NOT the derived columns. `picking_end_time` equals
// the PICKED event, which is several seconds to several minutes BEFORE
// DISPATCHED - using it as the trip end would silently drop the
// picked-to-dispatch interval, which is the one interval a reviewer can
// actually go look at on video.

import { DatabaseSync } from 'node:sqlite';

const STORE = process.argv[2];
const STATS_ONLY = process.argv.includes('--stats');
if (!STORE) { console.error('usage: node dev/sparkrisk-from-standalone.mjs <store> [--stats]'); process.exit(1); }

const DB_PATH = process.env.SPARKRISK_DB
  || 'C:\\Users\\ses008s.s01458\\Desktop\\Spark-Risk\\app\\spark-risk\\spark-risk.db';

const db = new DatabaseSync(DB_PATH, { readOnly: true });
const rows = db.prepare('SELECT * FROM orders WHERE store_id = ? ORDER BY extraction_date ASC').all(Number(STORE));

const eventTime = (events, status) => events.find(e => e.eventStatus === status)?.eventTime || null;

// The standalone primary key is `order_id|extraction_date`, so the same order
// re-pulled on a later day appears more than once. Keep the LAST one: a later
// pull has the more complete event stream. The module would dedup by
// (store, order_id) anyway - doing it here makes the choice explicit and
// countable rather than incidental.
const byOrder = new Map();
const report = { rows: rows.length, duplicates: 0, noEvents: 0, missingPickStarted: 0, missingDispatched: 0, missingPicked: 0 };

for (const r of rows) {
  let events = [];
  try { events = JSON.parse(r.task_events || '[]'); } catch { /* counted below */ }
  if (!events.length) report.noEvents++;

  const pickStarted = eventTime(events, 'PICK_STARTED');
  const picked = eventTime(events, 'PICKED');
  const dispatched = eventTime(events, 'DISPATCHED');
  if (!pickStarted) report.missingPickStarted++;
  if (!picked) report.missingPicked++;
  if (!dispatched) report.missingDispatched++;

  if (byOrder.has(String(r.order_id))) report.duplicates++;
  byOrder.set(String(r.order_id), {
    order_id: String(r.order_id),
    store_nbr: String(r.store_id),
    trip_id: r.trip_id || null,
    driver_uuid: r.driver_uuid || null,
    driver_id: r.driver_id || null,
    driver_first_name: r.driver_first_name || null,
    driver_last_name: r.driver_last_name || null,
    // Straight from the source status stream. A missing event stays null and
    // the module declines to score the trip rather than inventing a time.
    pick_started_time: pickStarted,
    picked_time: picked,
    dispatched_time: dispatched,
    total_order_qty: r.total_order_qty,
    status: r.status,
    // Carried for provenance; the module does not read these.
    source_carrier: r.carrier,
    source_delivery_mode: r.delivery_mode,
    source_extraction_date: r.extraction_date,
    source_analysis_eligible: r.analysis_eligible,
  });
}

const orders = [...byOrder.values()];
report.distinctOrders = orders.length;
report.scoreable = orders.filter(o =>
  o.pick_started_time && o.dispatched_time &&
  Date.parse(o.dispatched_time) > Date.parse(o.pick_started_time) &&
  Number(o.total_order_qty) > 0 && !/cancel/i.test(o.status || '')).length;
report.retainedNotScored = report.distinctOrders - report.scoreable;

if (STATS_ONLY) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.error(JSON.stringify(report));   // stats to stderr so stdout stays clean JSON
  console.log(JSON.stringify({ orders }));
}
