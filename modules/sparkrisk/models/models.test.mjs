// modules/sparkrisk/models/models.test.mjs
//
// Exercises the real IndexedDB code path (schema upgrade + atomic replace)
// against the `fake-indexeddb` shim, which is a full spec implementation
// rather than a hand-rolled stub.
//
//   cd unified-extension-suite
//   node --test modules/sparkrisk/models/models.test.mjs
//
// The shim lives in dev/ (a devDependency of dev/package.json). If it cannot
// be resolved the whole file skips rather than failing, so the other SparkRisk
// suites still run on a machine where dev/ has not been installed:
//
//   cd dev && npm install

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

// Resolved from dev/node_modules, which is where the suite keeps its
// Node-side tooling; falls back to normal resolution.
const require = createRequire(import.meta.url);
const devDir = fileURLToPath(new URL('../../../dev/', import.meta.url));
let shimLoaded = false;
for (const paths of [[devDir], undefined]) {
  try {
    await import(pathToFileURL(require.resolve('fake-indexeddb/auto', paths ? { paths } : undefined)).href);
    shimLoaded = true;
    break;
  } catch { /* try the next resolution root, then skip */ }
}

const SKIP = shimLoaded ? false : 'fake-indexeddb not installed (run: cd dev && npm install)';

// The module is imported lazily so the shim is installed on globalThis first.
const { SparkRiskDB } = shimLoaded ? await import('./index.js') : { SparkRiskDB: null };

// Builds a v3-shaped database by hand, exactly as the shipped v3 code did,
// including the unique session_id index that v4 has to replace.
function seedLegacyV3(dbName, { orders, sessions, reviews }) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 3);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = () => {
      const db = req.result;
      const s = db.createObjectStore('sessions', { keyPath: 'session_id' });
      s.createIndex('driver_id', 'driver_id', { unique: false });
      s.createIndex('driver_key', 'driver_key', { unique: false });
      s.createIndex('extraction_date', 'extraction_date', { unique: false });
      s.createIndex('priority_score', 'priority_score', { unique: false });
      s.createIndex('session_start', 'session_start', { unique: false });
      const o = db.createObjectStore('orders', { keyPath: 'id', autoIncrement: true });
      o.createIndex('order_id', 'order_id', { unique: false });
      const r = db.createObjectStore('session_reviews', { keyPath: 'id' });
      r.createIndex('session_id', 'session_id', { unique: true });   // the v3 hazard
      r.createIndex('status', 'status', { unique: false });
      db.createObjectStore('items', { keyPath: ['order_id', 'item_id'] });
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(['orders', 'sessions', 'session_reviews'], 'readwrite');
      orders.forEach(x => tx.objectStore('orders').put(x));
      sessions.forEach(x => tx.objectStore('sessions').put(x));
      reviews.forEach(x => tx.objectStore('session_reviews').put(x));
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}

// Each test gets its own database name so they cannot see each other's state.
let n = 0;
function freshName() { return `sparkrisk-test-${++n}`; }

async function openAt(dbName) {
  const db = new SparkRiskDB();
  // DB_NAME is a module constant, so point the instance at the test database
  // by monkey-patching indexedDB.open for the duration of this open() call.
  const realOpen = indexedDB.open.bind(indexedDB);
  indexedDB.open = (name, version) => realOpen(name === 'sparkrisk' ? dbName : name, version);
  try { await db.open(); } finally { indexedDB.open = realOpen; }
  return db;
}

test('v3 -> v4 upgrade keeps every row and replaces the unique session_id index', { skip: SKIP }, async () => {
  const name = freshName();
  await seedLegacyV3(name, {
    orders: [{ order_id: 'a', store_nbr: '1458' }, { order_id: 'b', store_nbr: '1458' }],
    sessions: [{ session_id: 'old-1', order_ids: '["a"]', store: '1458', priority_score: 10 }],
    reviews: [{ id: 'r1', session_id: 'old-1', status: 'cleared', notes: 'kept' }],
  });

  const db = await openAt(name);

  assert.equal(db.db.version, 4);
  assert.ok(db.db.objectStoreNames.contains('backups'), 'v4 adds the backups store');

  // Nothing was destroyed by the upgrade itself.
  assert.equal((await db.getAll('orders')).length, 2);
  assert.equal((await db.getAll('sessions')).length, 1);
  assert.equal((await db.getAll('session_reviews'))[0].notes, 'kept');

  // The index must now be non-unique, or an archived legacy review sharing a
  // session_id with a live one would abort the rebuild transaction.
  const tx = db.db.transaction('session_reviews', 'readonly');
  assert.equal(tx.objectStore('session_reviews').index('session_id').unique, false);
  db.db.close();
});

test('two rows may share a session_id after the upgrade', { skip: SKIP }, async () => {
  const name = freshName();
  await seedLegacyV3(name, { orders: [], sessions: [], reviews: [{ id: 'r1', session_id: 'dup' }] });
  const db = await openAt(name);
  await db.put('session_reviews', { id: 'r2', session_id: 'dup', archived: true });
  assert.equal((await db.getAll('session_reviews', 'session_id', 'dup')).length, 2);
  db.db.close();
});

test('replaceAnalysis swaps all three stores and snapshots the pre-migration data once', { skip: SKIP }, async () => {
  const name = freshName();
  await seedLegacyV3(name, {
    orders: [{ order_id: 'legacy', store_nbr: '1458' }],
    sessions: [{ session_id: 'legacy-session', order_ids: '["legacy"]', store: '1458' }],
    reviews: [{ id: 'r-legacy', session_id: 'legacy-session', status: 'confirmed' }],
  });
  const db = await openAt(name);

  await db.replaceAnalysis({
    orders: [{ id: '["1458","a"]', order_id: 'a', store_nbr: '1458' }],
    sessions: [{ session_id: 'new-1', order_ids: '["a"]', store: '1458' }],
    reviews: [{ id: 'rev-new', session_id: 'new-1', status: 'new' }],
  });

  // Old contents are gone from the live stores...
  assert.deepEqual((await db.getAll('sessions')).map(x => x.session_id), ['new-1']);
  assert.deepEqual((await db.getAll('orders')).map(x => x.order_id), ['a']);
  assert.deepEqual((await db.getAll('session_reviews')).map(x => x.id), ['rev-new']);

  // ...but recoverable from the one-time backup.
  const backup = await db.get('backups', 'before-foundation-v3');
  assert.ok(backup, 'the first rebuild snapshots the original data');
  assert.deepEqual(backup.sessions.map(x => x.session_id), ['legacy-session']);
  assert.deepEqual(backup.session_reviews.map(x => x.status), ['confirmed']);
  assert.ok(await db.get('backups', 'foundation-v3-ready'), 'the migration marker is written');

  // A second rebuild must not overwrite the original snapshot with the
  // already-migrated data.
  await db.replaceAnalysis({
    orders: [], sessions: [],
    reviews: [{ id: 'rev-2', session_id: 'new-2', status: 'new' }],
  });
  const backup2 = await db.get('backups', 'before-foundation-v3');
  assert.deepEqual(backup2.sessions.map(x => x.session_id), ['legacy-session'], 'snapshot is written once, never refreshed');
  assert.equal(backup2.at, backup.at);
  db.db.close();
});

test('a failed write aborts the whole swap and leaves the previous analysis intact', { skip: SKIP }, async () => {
  const name = freshName();
  await seedLegacyV3(name, { orders: [], sessions: [], reviews: [] });
  const db = await openAt(name);

  await db.replaceAnalysis({
    orders: [{ id: '["1458","a"]', order_id: 'a' }],
    sessions: [{ session_id: 'keep-me', order_ids: '["a"]', store: '1458' }],
    reviews: [{ id: 'rev-keep', session_id: 'keep-me', status: 'cleared' }],
  });

  // A review with no `id` violates the keyPath and makes the put fail, which
  // aborts the transaction that already called clear() on all three stores.
  await assert.rejects(() => db.replaceAnalysis({
    orders: [{ id: '["1458","b"]', order_id: 'b' }],
    sessions: [{ session_id: 'new', order_ids: '["b"]', store: '1458' }],
    reviews: [{ session_id: 'new', status: 'new' }],   // no id
  }));

  assert.deepEqual((await db.getAll('sessions')).map(x => x.session_id), ['keep-me'], 'the clear() was rolled back');
  assert.deepEqual((await db.getAll('session_reviews')).map(x => x.status), ['cleared']);
  assert.deepEqual((await db.getAll('orders')).map(x => x.order_id), ['a']);
  db.db.close();
});
