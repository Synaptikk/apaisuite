import test from 'node:test';
import assert from 'node:assert/strict';
import { singleFlight } from './single_flight.js';
test('concurrent requests share one operation and cleanup', async () => {
  const flight = singleFlight();
  let calls = 0, finish;
  const run = () => { calls++; return new Promise(r => { finish = r; }); };
  const a = flight('auth', run), b = flight('auth', run);
  assert.equal(a, b);
  await Promise.resolve();
  assert.equal(calls, 1);
  finish('token');
  assert.deepEqual(await Promise.all([a, b]), ['token', 'token']);
  assert.equal(await flight('auth', () => 'fresh'), 'fresh');
});
test('failures release the flight and distinct queries do not mix', async () => {
  const flight = singleFlight();
  await assert.rejects(flight('auth', () => { throw new Error('closed'); }), /closed/);
  assert.equal(await flight('auth', () => 'retry'), 'retry');
  assert.deepEqual(await Promise.all([flight('store1', () => 1), flight('store2', () => 2)]), [1, 2]);
});
