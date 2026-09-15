import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSchedule, failureKind } from '../collection.js';

test('healthy session uses one read without recovery', async () => {
  let calls = 0;
  const result = await collectSchedule({ collect: async () => { calls++; return { ok: true, data: [1] }; }, recover: async () => assert.fail('unexpected recovery') });
  assert.deepEqual(result.data, [1]);
  assert.equal(calls, 1);
});
test('expired session recovers once then returns fresh schedule', async () => {
  let calls = 0, recoveries = 0;
  const events = [];
  const result = await collectSchedule({ collect: async () => ++calls === 1 ? { ok: false, errorClass: 'AUTH', error: 'Expired' } : { ok: true, data: [2] }, recover: async () => { recoveries++; }, emit: (...args) => events.push(args) });
  assert.deepEqual(result.data, [2]);
  assert.equal(recoveries, 1);
  assert.equal(calls, 2);
  assert.deepEqual(events, [['schedule_auth_recovery', { attempt: 1 }]]);
});
test('persistent authentication failure cannot loop', async () => {
  let calls = 0, recoveries = 0;
  await assert.rejects(collectSchedule({ collect: async () => { calls++; return { ok: false, error: 'Main.ashx 401' }; }, recover: async () => { recoveries++; } }), /401/);
  assert.equal(calls, 2);
  assert.equal(recoveries, 1);
});
test('network and explicit format errors do not trigger sign-in', async () => {
  for (const response of [{ ok: false, error: 'Failed to fetch' }, { ok: false, errorClass: 'FORMAT', error: 'Unexpected content-type text/plain' }]) {
    await assert.rejects(collectSchedule({ collect: async () => response, recover: async () => assert.fail('unexpected recovery') }));
  }
});
test('failed recovery propagates without a second request', async () => {
  let calls = 0;
  await assert.rejects(collectSchedule({ collect: async () => { calls++; return { ok: false, error: 'Unexpected content-type text/html' }; }, recover: async () => { throw new Error('MFA required'); } }), /MFA/);
  assert.equal(calls, 1);
});
test('diagnostics classify errors without retaining their contents', () => {
  assert.equal(failureKind('IVR server returned ViewState MAC errors'), 'viewstate');
  assert.equal(failureKind('IVR collection timed out (180s)'), 'timeout');
  assert.equal(failureKind('Main.ashx 401: private response body'), 'auth');
});
