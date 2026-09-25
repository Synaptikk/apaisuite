// modules/sparkrisk/lib/rebuild.test.mjs
//
// Lineage guarantees of the full-rebuild pipeline: dedup, review migration,
// archive preservation, and re-import of a changed source.
//
//   node --test modules/sparkrisk/lib/rebuild.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { rebuild } from './rebuild.js';

const order = (id, day = '01', extra = {}) => ({
  order_id: id, trip_id: id, driver_uuid: 'driver', store_nbr: '1458',
  extraction_date: `2026-09-${day}`,
  pick_started_time: `2026-09-${day}T12:00:00Z`,
  picked_time: `2026-09-${day}T12:08:00Z`,
  dispatched_time: `2026-09-${day}T12:10:00Z`,
  total_order_qty: 10, ...extra,
});

test('an unmatched legacy review is archived, not dropped, and cannot collide with a live review', async () => {
  // Legacy review points at a session whose orders were never imported.
  const legacy = [{ session_id: 'legacy-gone', order_ids: '["ghost"]', store: '1458' }];
  const reviews = [{ id: 'r-ghost', session_id: 'legacy-gone', status: 'confirmed', notes: 'Escalated to HR' }];

  const r = await rebuild([], [order('a')], legacy, reviews);

  const archived = r.reviews.filter(x => x.archived);
  assert.equal(archived.length, 1);
  assert.equal(archived[0].notes, 'Escalated to HR', 'archived notes are preserved verbatim');
  assert.equal(archived[0].status, 'confirmed', 'archived decision is preserved verbatim');
  assert.equal(archived[0].original_session_id, 'legacy-gone', 'the original target is recorded');

  // The archived row must not be joinable onto any live session, and its
  // session_id must be distinct from every live one (the store's session_id
  // index would otherwise be ambiguous).
  const live = r.reviews.filter(x => !x.archived);
  assert.equal(live.length, r.sessions.length);
  const liveIds = new Set(live.map(x => x.session_id));
  assert.ok(!liveIds.has(archived[0].session_id));
  assert.equal(new Set(r.reviews.map(x => x.session_id)).size, r.reviews.length, 'session_id is unique across all rows');
  assert.equal(new Set(r.reviews.map(x => x.id)).size, r.reviews.length, 'primary keys stay unique');
});

test('a legacy review only migrates when exactly one session can own it', async () => {
  // Two orders picked in the same trip. A legacy single-order session is a
  // strict subset of the new two-order trip and is the only candidate, so it
  // migrates, flagged as a subset match.
  const rows = [order('a'), { ...order('b'), trip_id: 'a' }];
  const legacy = [{ session_id: 'old-a', order_ids: '["a"]', store: '1458' }];
  const reviews = [{ id: 'r1', session_id: 'old-a', status: 'cleared', notes: 'Checked' }];

  const r = await rebuild([], rows, legacy, reviews);
  assert.equal(r.sessions.length, 1, 'same trip_id merges into one session');
  const live = r.reviews.find(x => !x.archived);
  assert.equal(live.notes, 'Checked');
  assert.equal(live.migrated_by, 'subset');
  assert.equal(live.original_session_id, 'old-a');
});

test('an ambiguous legacy review is archived rather than attached to the wrong session', async () => {
  // Order "a" exists at two stores. The legacy session records no store, so
  // both new sessions are candidates and neither may claim the review.
  const rows = [order('a'), order('a', '01', { store_nbr: '999' })];
  const legacy = [{ session_id: 'old-a', order_ids: '["a"]' }];  // no store
  const reviews = [{ id: 'r1', session_id: 'old-a', status: 'confirmed', notes: 'Which store?' }];

  const r = await rebuild([], rows, legacy, reviews);
  assert.equal(r.sessions.length, 2);
  const archived = r.reviews.filter(x => x.archived);
  assert.equal(archived.length, 1, 'ambiguity archives instead of guessing');
  assert.equal(archived[0].notes, 'Which store?');
  assert.ok(r.reviews.filter(x => !x.archived).every(x => x.status === 'new'));
});

test('an exact order-set match beats a subset match', async () => {
  // Two legacy sessions: one exactly matches the new trip, one is a subset.
  // The exact match must win so the more specific decision is the live one.
  const rows = [order('a'), { ...order('b'), trip_id: 'a' }];
  const legacy = [
    { session_id: 'old-exact', order_ids: '["a","b"]', store: '1458' },
    { session_id: 'old-subset', order_ids: '["a"]', store: '1458' },
  ];
  const reviews = [
    { id: 'r-exact', session_id: 'old-exact', status: 'confirmed', notes: 'Exact', updated_at: '2026-09-02T00:00:00Z' },
    { id: 'r-subset', session_id: 'old-subset', status: 'cleared', notes: 'Subset', updated_at: '2026-09-01T00:00:00Z' },
  ];

  const r = await rebuild([], rows, legacy, reviews);
  const live = r.reviews.find(x => !x.archived);
  assert.equal(live.notes, 'Exact', 'newest meaningful review wins');
  assert.equal(live.merged_reviews.length, 2, 'the losing decision is kept verbatim');
  assert.deepEqual(live.merged_reviews.map(x => x.notes).sort(), ['Exact', 'Subset']);
});

test('reimporting the same source with a changed status and notes updates the order but keeps the decision', async () => {
  const first = await rebuild([], [order('a')]);
  const sessionId = first.sessions[0].session_id;
  first.reviews[0].status = 'cleared';
  first.reviews[0].notes = 'Video clean';
  first.reviews[0].updated_at = '2026-09-01T20:00:00Z';

  // Same order_id, but the source now reports a different status string and a
  // corrected quantity. The order row must be replaced, not duplicated.
  const changed = order('a', '01', { status: 'COMPLETED', total_order_qty: 12, source_note: 'revised export' });
  const second = await rebuild(first.orders, [changed], first.sessions, first.reviews);

  assert.equal(second.orders.length, 1, 'no duplicate order row');
  assert.equal(second.orders[0].total_order_qty, 12, 'incoming record wins');
  assert.equal(second.orders[0].source_note, 'revised export');
  assert.equal(second.sessions.length, 1);
  assert.equal(second.sessions[0].session_id, sessionId, 'session identity is stable');
  assert.equal(second.sessions[0].combined_items, 12, 'the session is rescored from the new quantity');

  const live = second.reviews.filter(x => !x.archived);
  assert.equal(live.length, 1);
  assert.equal(live[0].status, 'cleared', 'the reviewer decision survives re-import');
  assert.equal(live[0].notes, 'Video clean');
});

test('a source record that turns into a cancellation stops being scored but is still retained', async () => {
  const first = await rebuild([], [order('a'), order('b', '02')]);
  assert.equal(first.sessions.length, 2);

  const cancelled = order('a', '01', { status: 'CANCELLED' });
  const second = await rebuild(first.orders, [cancelled], first.sessions, first.reviews);

  assert.equal(second.orders.length, 2, 'the cancelled order stays in the DB as lineage');
  assert.equal(second.sessions.length, 1, 'but it no longer produces a scoreable trip');
  assert.equal(second.ineligibleOrders, 1);
  // Its review has nowhere to live any more, so it is archived, not deleted.
  assert.equal(second.reviews.filter(x => x.archived).length, 1);
});

test('records with no usable order_id are counted, not silently dropped', async () => {
  const r = await rebuild([], [order('a'), { ...order('b'), order_id: '   ' }, { ...order('c'), order_id: null }, null]);
  assert.equal(r.rejected, 3);
  assert.equal(r.orders.length, 1);
});

test('every session gets a review record, including zero-score ones', async () => {
  const r = await rebuild([], [order('a'), order('b', '02'), order('c', '03')]);
  assert.equal(r.sessions.length, 3);
  assert.ok(r.sessions.every(s => s.priority_score === 0), 'these trips are on the reference rate');
  const live = r.reviews.filter(x => !x.archived);
  assert.equal(live.length, 3, 'a low score must still be reviewable');
  assert.deepEqual([...new Set(live.map(x => x.priority))], [3]);
});
