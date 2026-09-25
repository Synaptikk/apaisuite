// modules/sparkrisk/lib/handlers.test.mjs
//
// Drives service.js's message handlers against an in-memory stand-in for the
// IndexedDB layer. The real IndexedDB code path is covered separately by
// modules/sparkrisk/models/models.test.mjs.
//
//   node --test modules/sparkrisk/lib/handlers.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { rebuild, orderKey } from './rebuild.js';

const src = readFileSync(new URL('../service.js', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '')
  .replace('export { handlers };', 'globalThis.handlers = handlers;');

function setup(seed = {}) {
  const data = {
    orders: seed.orders || [],
    sessions: seed.sessions || [],
    session_reviews: seed.session_reviews || [],
    backups: seed.backups || [],
  };
  const db = {
    getAll: async (name, index, key) => index
      ? structuredClone(data[name].filter(x => x[index] === key))
      : structuredClone(data[name]),
    get: async (name, id) => structuredClone(data[name].find(x => (x.id || x.session_id) === id)),
    put: async (name, row) => { data[name] = data[name].filter(x => x.id !== row.id).concat(structuredClone(row)); },
    replaceAnalysis: async r => {
      data.orders = structuredClone(r.orders);
      data.sessions = structuredClone(r.sessions);
      data.session_reviews = structuredClone(r.reviews);
      data.backups = [{ id: 'foundation-v3-ready' }];
    },
  };
  // service.js's imports are stripped above, so everything it imports has to
  // be supplied here. A missing binding surfaces as a ReferenceError inside a
  // handler's try/catch, which is easy to miss - keep this list in sync.
  const ctx = { db, rebuild, orderKey, console, crypto: globalThis.crypto };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { handlers: ctx.handlers, data };
}

const order = {
  order_id: '1', trip_id: 't', driver_uuid: 'd', store_nbr: '1458',
  pick_started_time: '2026-09-01T12:00:00Z',
  dispatched_time: '2026-09-01T12:10:00Z',
  total_order_qty: 10,
};
const at = (day, extra = {}) => ({
  ...order, order_id: `o${day}`, trip_id: `t${day}`,
  pick_started_time: `2026-09-${day}T12:00:00Z`,
  dispatched_time: `2026-09-${day}T12:10:00Z`,
  ...extra,
});

test('handler import -> low score review -> reimport preserves saved decision', async () => {
  const { handlers: h } = setup();
  assert.equal((await h.ingestData({ orders: [order] })).ok, true);
  const q = await h.getQueue({});
  assert.equal(q.rows.length, 1);
  assert.equal(q.rows[0].priority_score, 0);
  const id = q.rows[0].session_id;
  assert.equal((await h.updateReview({ sessionId: id, status: 'cleared', notes: 'Checked footage' })).ok, true);
  await h.ingestData({ orders: [order] });
  const detail = await h.getSession({ sessionId: id });
  assert.equal(detail.review.notes, 'Checked footage');
  assert.equal((await h.getStats({})).cleared, 1);
});

test('concurrent imports do not overwrite each other', async () => {
  const { handlers: h } = setup();
  await Promise.all([h.ingestData({ orders: [order] }), h.ingestData({ orders: [{ ...order, order_id: '2', trip_id: 't2' }] })]);
  assert.equal((await h.getQueue({})).total, 2);
});

test('getSession scopes orders to the session store, not order_id alone', async () => {
  const { handlers: h } = setup();
  // Same order number at two stores - a real possibility, since order numbers
  // are only unique within a store's own numbering.
  const here = { ...order, store_nbr: '1458', marker: 'home' };
  const elsewhere = { ...order, store_nbr: '0999', marker: 'other-store' };
  await h.ingestData({ orders: [here, elsewhere] });

  const q = await h.getQueue({});
  assert.equal(q.total, 2, 'the two stores are two separate trips');

  for (const row of q.rows) {
    const detail = await h.getSession({ sessionId: row.session_id });
    assert.equal(detail.orders.length, 1, `session at store ${row.store} pulled ${detail.orders.length} orders`);
    assert.equal(detail.orders[0].store_nbr, row.store);
    assert.equal(detail.orders[0].marker, row.store === '1458' ? 'home' : 'other-store');
  }
});

test('driver history does not leak between stores', async () => {
  const { handlers: h } = setup();
  // Same driver uuid, four trips at store 1458 and one at store 0999.
  await h.ingestData({
    orders: [at('01'), at('02'), at('03'), at('04'),
             { ...at('05'), store_nbr: '0999' }],
  });
  const rows = (await h.getQueue({})).rows;
  const foreign = rows.find(r => r.store === '0999');
  assert.equal(foreign.driver_prior_count, 0, 'store 0999 has no prior history for this driver');
  assert.equal(foreign.driver_total_sessions, 1, 'driver counters are store-scoped too');
  assert.equal(rows.find(r => r.trip_id === 't04').driver_prior_count, 3);

  const detail = await h.getSession({ sessionId: foreign.session_id });
  assert.equal(detail.driverStats.total_sessions, 1);
  assert.equal(detail.driverSessions.length, 0);
});

test('archived reviews are invisible to the queue and to the counters', async () => {
  const { handlers: h, data } = setup();
  await h.ingestData({ orders: [order] });
  const id = (await h.getQueue({})).rows[0].session_id;

  // A confirmed decision that belongs to a session that no longer exists.
  data.session_reviews.push({
    id: 'r-archived', session_id: 'archived:r-archived', original_session_id: 'gone',
    status: 'confirmed', notes: 'old finding', archived: true,
  });

  const stats = await h.getStats({});
  assert.equal(stats.confirmed, 0, 'archived decisions must not inflate the counters');

  const rows = (await h.getQueue({})).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].review_status, 'new', 'the live row keeps its own status');

  const detail = await h.getSession({ sessionId: id });
  assert.notEqual(detail.review?.id, 'r-archived');

  // Still on disk, still readable.
  assert.equal(data.session_reviews.find(r => r.id === 'r-archived').notes, 'old finding');
});

test('updateReview creates a review for a session that has none, and rejects an unknown status', async () => {
  const { handlers: h, data } = setup();
  await h.ingestData({ orders: [order] });
  const id = (await h.getQueue({})).rows[0].session_id;

  data.session_reviews = [];   // simulate a session with no review row at all
  const bad = await h.updateReview({ sessionId: id, status: 'definitely_fraud' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Invalid review status/);

  const ok = await h.updateReview({ sessionId: id, status: 'in_review', notes: 'Pulling video' });
  assert.equal(ok.ok, true);
  assert.equal(ok.review.session_id, id);
  assert.equal(ok.review.archived, false);
  assert.equal((await h.getSession({ sessionId: id })).review.notes, 'Pulling video');

  assert.equal((await h.updateReview({ sessionId: 'no-such-session', status: 'cleared' })).ok, false);
});

test('stats report retained-but-unscored orders and the stores present', async () => {
  const { handlers: h } = setup();
  await h.ingestData({
    orders: [order, { ...order, order_id: 'z', trip_id: 'tz', status: 'CANCELLED' },
             { ...order, order_id: 'y', trip_id: 'ty', store_nbr: '0999' }],
  });
  const stats = await h.getStats({});
  assert.equal(stats.storedOrders, 3);
  assert.equal(stats.ineligibleOrders, 1, 'the cancelled order is kept but not scored');
  assert.equal(stats.total, 2);
  // Re-wrapped in this realm: arrays built inside the vm context have a
  // different Array prototype, which strict deepEqual rejects.
  assert.deepEqual([...stats.stores], ['0999', '1458']);
});

test('the queue sorts by date instead of silently not sorting', async () => {
  const { handlers: h } = setup();
  await h.ingestData({ orders: [at('03'), at('01'), at('02')] });
  const desc = await h.getQueue({ sort: 'extraction_date', dir: 'DESC' });
  assert.deepEqual(desc.rows.map(r => r.extraction_date), ['2026-09-03', '2026-09-02', '2026-09-01']);
  const asc = await h.getQueue({ sort: 'extraction_date', dir: 'ASC' });
  assert.deepEqual(asc.rows.map(r => r.extraction_date), ['2026-09-01', '2026-09-02', '2026-09-03']);
});

test('ingest rejects an empty payload and reports records with no order_id', async () => {
  const { handlers: h } = setup();
  assert.equal((await h.ingestData({ orders: [] })).ok, false);
  const r = await h.ingestData({ orders: [order, { ...order, order_id: '' }] });
  assert.equal(r.ok, true);
  assert.equal(r.rejected, 1);
  assert.equal(r.sessions, 1);
  assert.equal(r.reviews, 1);
});

test('a legacy DB with sessions but no orders is left alone, not silently emptied', async () => {
  // v1/v2 shipped without persisted orders. Rebuilding from nothing would
  // delete the analyst's whole queue, so the migration must decline.
  const { handlers: h, data } = setup({
    sessions: [{ session_id: 'legacy', order_ids: '["a"]', store: '1458', priority_score: 80, extraction_date: '2026-09-01', driver_key: 'd' }],
    session_reviews: [{ id: 'r1', session_id: 'legacy', status: 'confirmed', notes: 'do not lose me' }],
  });

  const q = await h.getQueue({});
  assert.equal(q.total, 1, 'the legacy session is still queued');
  assert.equal(q.rows[0].review_status, 'confirmed');
  assert.equal(data.sessions.length, 1);
  assert.equal(data.session_reviews[0].notes, 'do not lose me');
  assert.equal(data.backups.length, 0, 'no migration marker was written');

  // Importing real orders takes over: the legacy session is replaced and its
  // review is archived rather than deleted.
  await h.ingestData({ orders: [order] });
  assert.equal((await h.getQueue({})).total, 1);
  assert.notEqual((await h.getQueue({})).rows[0].session_id, 'legacy');
  const archived = data.session_reviews.filter(r => r.archived);
  assert.equal(archived.length, 1);
  assert.equal(archived[0].notes, 'do not lose me');
});
