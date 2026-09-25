// modules/sparkrisk/lib/sessions.test.mjs
//
//   node --test modules/sparkrisk/lib/sessions.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { rebuild } from './rebuild.js';
import { buildSessionFromOrders, buildSessionsFromOrders, scoreSessions, BASE_SECONDS_PER_ITEM, MIN_SIGMA_FRACTION_OF_MEDIAN } from './sessions.js';

const order = (id, day = '01', extra = {}) => ({ order_id: id, trip_id: id, driver_uuid: 'driver', store_nbr: '1458', extraction_date: `2026-09-${day}`, pick_started_time: `2026-09-${day}T12:00:00Z`, picked_time: `2026-09-${day}T12:08:00Z`, dispatched_time: `2026-09-${day}T12:10:00Z`, total_order_qty: 10, ...extra });

test('reject null, missing, reversed and cancelled timestamps without epoch anomalies', () => {
  for (const patch of [{ pick_started_time: null }, { dispatched_time: '' }, { dispatched_time: '2026-09-01T11:00:00Z' }, { total_order_qty: 0 }, { status: 'CANCELLED' }]) assert.equal(buildSessionFromOrders([order('a', '01', patch)]), null);
  assert.equal(buildSessionFromOrders([order('a', '01', { total_order_qty: '10' })]).combined_items, 10);
});

test('a dispatch exactly equal to the pick start is rejected, not scored as a zero-second trip', () => {
  assert.equal(buildSessionFromOrders([order('a', '01', { dispatched_time: '2026-09-01T12:00:00Z' })]), null);
});

test('review_window_start is only derived when picked_time is inside the trip', () => {
  assert.equal(buildSessionFromOrders([order('a')]).review_window_start, '2026-09-01T12:08:00.000Z');
  // Missing, before the pick start, or after dispatch: no window may be shown.
  for (const patch of [{ picked_time: null }, { picked_time: '2026-09-01T11:00:00Z' }, { picked_time: '2026-09-01T13:00:00Z' }]) {
    assert.equal(buildSessionFromOrders([order('a', '01', patch)]).review_window_start, null,
      `picked_time ${JSON.stringify(patch)} must not produce a video window`);
  }
});

test('reimport is idempotent and review survives', async () => {
  const a = await rebuild([], [order('a')]);
  a.reviews[0].status = 'cleared'; a.reviews[0].notes = 'Video reviewed';
  const b = await rebuild(a.orders, [order('a')], a.sessions, a.reviews);
  assert.equal(b.orders.length, 1); assert.equal(b.sessions.length, 1);
  assert.equal(b.sessions[0].session_id, a.sessions[0].session_id);
  assert.equal(b.reviews[0].notes, 'Video reviewed');
  assert.equal(b.reviews[0].status, 'cleared');
});

test('history accumulates across imports and does not use future or tied sessions', async () => {
  const a = await rebuild([], [order('a'), order('b', '02'), order('c', '03')]);
  const b = await rebuild(a.orders, [order('d', '04', { dispatched_time: '2026-09-04T13:00:00Z' })], a.sessions, a.reviews);
  const d = b.sessions.find(s => s.trip_id === 'd');
  assert.equal(d.driver_prior_count, 3); assert.ok(d.driver_deviation > 0);
  assert.equal(b.sessions.find(s => s.trip_id === 'a').driver_prior_count, 0);
  const tied = await rebuild([], [order('x'), order('y')]);
  assert.ok(tied.sessions.every(s => s.driver_prior_count === 0));
});

test('sessions that start at the same instant never contribute to each other', async () => {
  // Four trips, all starting at 12:00 on different days but with identical
  // start instants within each pair, plus one genuinely later trip.
  const same = ['a', 'b', 'c'].map(id => order(id, '01', { trip_id: id }));
  const later = order('d', '02');
  const r = await rebuild([], [...same, later]);
  for (const id of ['a', 'b', 'c']) {
    assert.equal(r.sessions.find(s => s.trip_id === id).driver_prior_count, 0,
      `tied start for ${id} must not see its siblings`);
  }
  assert.equal(r.sessions.find(s => s.trip_id === 'd').driver_prior_count, 3);
});

test('history_coverage reports baseline depth and never claims confidence', async () => {
  const days = Array.from({ length: 12 }, (_, i) => order(`o${i}`, String(i + 1).padStart(2, '0')));
  const r = await rebuild([], days);
  const byTrip = Object.fromEntries(r.sessions.map(s => [s.trip_id, s]));
  assert.equal(byTrip.o0.history_coverage, 'none');      // 0 priors
  assert.equal(byTrip.o2.history_coverage, 'none');      // 2 priors
  assert.equal(byTrip.o3.history_coverage, 'limited');   // 3 priors
  assert.equal(byTrip.o10.history_coverage, 'recorded'); // 10 priors
  assert.ok(r.sessions.every(s => !('confidence' in s)), 'the confidence field is gone');
});

test('the explanation states the reference is arbitrary and peer data is missing', async () => {
  const r = await rebuild([], [order('a')]);
  const text = r.sessions[0].explanation;
  assert.match(text, /not a calibrated threshold/);
  assert.match(text, /Peer comparison is unavailable/);
  assert.match(text, /not a probability of fraud/);
  assert.match(text, new RegExp(`${BASE_SECONDS_PER_ITEM}-second-per-item`));
});

test('batch size no longer multiplies the score', () => {
  // Same duration and item count, split across one order vs four. Before the
  // context-adjustment removal the four-order trip scored 10% higher for no
  // reason that any source supports.
  const base = {
    session_id: 's', store: '1458', driver_key: 'd', session_start: '2026-09-01T12:00:00Z',
    session_duration_ms: 40 * 60_000, combined_items: 20, session_spi: 120,
  };
  const [one] = scoreSessions([{ ...base, order_count: 1 }], {});
  const [many] = scoreSessions([{ ...base, session_id: 's2', order_count: 8 }], {});
  assert.equal(one.priority_score, many.priority_score);
  assert.ok(one.priority_score > 0, 'the trip is still over the reference');
});

test('scores are clamped to 0-100 in both directions', () => {
  const mk = (durationMin, items) => ({
    session_id: `s${durationMin}`, store: '1458', driver_key: 'd',
    session_start: '2026-09-01T12:00:00Z', order_count: 1,
    session_duration_ms: durationMin * 60_000, combined_items: items,
    session_spi: (durationMin * 60) / items,
  });
  // Far under the reference, and far over it.
  const scored = scoreSessions([mk(1, 60), mk(600, 1)], {});
  assert.equal(scored[0].priority_score, 0);
  assert.equal(scored[1].priority_score, 100);
  assert.ok(scored.every(s => s.priority_score >= 0 && s.priority_score <= 100));
});

test('distinct stores and unknown drivers cannot share history or merge trips', async () => {
  const rows = [order('a'), order('b', '01', { store_nbr: '999', trip_id: 'a' }), order('c', '01', { trip_id: null, driver_uuid: null }), order('d', '01', { trip_id: null, driver_uuid: null })];
  assert.equal((await buildSessionsFromOrders(rows)).length, 4);
});

test('unknown drivers are isolated from every baseline', async () => {
  // Four trips with no driver identity at all. They must not pool into a
  // shared "unknown driver" history.
  const rows = ['a', 'b', 'c', 'd'].map((id, i) => order(id, String(i + 1).padStart(2, '0'), { driver_uuid: null, driver_id: null, trip_id: null }));
  const r = await rebuild([], rows);
  assert.equal(r.sessions.length, 4);
  assert.ok(r.sessions.every(s => s.driver_key.startsWith('unknown:')));
  assert.ok(r.sessions.every(s => s.driver_prior_count === 0));
  assert.ok(r.sessions.every(s => s.driver_deviation === null));
});

test('legacy duplicate reviews preserve notes and decisions in merged history', async () => {
  const legacy = ['old1', 'old2'].map(session_id => ({ session_id, order_ids: '["a"]' }));
  const reviews = legacy.map((s, i) => ({ id: String(i), session_id: s.session_id, notes: `Note ${i}`, status: i ? 'new' : 'cleared' }));
  const r = await rebuild([order('a'), order('a')], [], legacy, reviews);
  assert.equal(r.sessions.length, 1); assert.equal(r.reviews.length, 1);
  assert.equal(r.reviews[0].status, 'cleared');
  assert.deepEqual(r.reviews[0].merged_reviews.map(x => x.notes), ['Note 0', 'Note 1']);
});

test('scores stay bounded; all sessions can be reviewed; invalid orders remain retained', async () => {
  const r = await rebuild([], [order('a', '01', { dispatched_time: '2026-09-01T13:00:00Z', total_order_qty: 5 }), order('b', '02', { pick_started_time: null }), order('c', '03', { total_order_qty: 100 })]);
  assert.equal(r.orders.length, 3); assert.equal(r.ineligibleOrders, 1);
  assert.equal(r.sessions[0].priority_score, 100);
  assert.ok(r.sessions.every(s => s.priority_score >= 0 && s.priority_score <= 100));
  assert.equal(r.reviews.length, r.sessions.length);
});

test('the deviation scale is floored so a tight baseline cannot explode the z-score', async () => {
  // Eight near-identical trips then one three-times-slower trip. With a raw
  // MAD denominator this produced ~109 sigma on real sample data.
  const priors = Array.from({ length: 8 }, (_, i) =>
    order(`p${i}`, String(i + 1).padStart(2, '0'), { dispatched_time: `2026-09-${String(i + 1).padStart(2, '0')}T12:20:00Z` }));
  const outlier = order('out', '09', { dispatched_time: '2026-09-09T13:00:00Z' });
  const r = await rebuild([], [...priors, outlier]);
  const hit = r.sessions.find(s => s.trip_id === 'out');

  assert.equal(hit.driver_prior_count, 8);
  assert.ok(hit.driver_deviation > 0, 'the outlier is still above baseline');
  assert.ok(hit.driver_deviation <= 3 / MIN_SIGMA_FRACTION_OF_MEDIAN,
    `deviation ${hit.driver_deviation} exceeds the bound implied by the sigma floor`);
  assert.ok(hit.driver_deviation < 20, `deviation ${hit.driver_deviation} is not a reportable number`);
});

test('a zero-MAD baseline still yields a finite deviation', () => {
  // Every prior identical: MAD is exactly 0, so only the floor prevents a
  // division by zero.
  const priors = Array.from({ length: 5 }, (_, i) => ({
    session_id: `p${i}`, store: '1458', driver_key: 'd', order_count: 1,
    session_start: `2026-09-0${i + 1}T12:00:00Z`,
    session_duration_ms: 20 * 60_000, combined_items: 20, session_spi: 60,
  }));
  const target = {
    session_id: 'target', store: '1458', driver_key: 'd', order_count: 1,
    session_start: '2026-09-09T12:00:00Z',
    session_duration_ms: 60 * 60_000, combined_items: 20, session_spi: 180,
  };
  const scored = scoreSessions([...priors, target], {});
  const hit = scored.find(s => s.session_id === 'target');
  assert.ok(Number.isFinite(hit.driver_deviation), 'deviation must be finite when MAD is 0');
  assert.equal(hit.driver_deviation, 6);   // (180 - 60) / (60 / 3)
});
