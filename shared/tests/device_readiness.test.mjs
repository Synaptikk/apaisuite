import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceReadiness } from '../device_readiness.js';
const storage = (local = {}, sync = {}, session = {}) => Object.fromEntries(Object.entries({ local, sync, session }).map(([k, value]) => [k, { get: async () => value }]));
test('synced onboarding does not suppress a new device check', async () => {
  const s = await deviceReadiness(storage({}, { 'apai.onboardingCompletedAt': 'previous-pc' }));
  assert.equal(s.reviewed, false);
  assert.equal(s.aurorObserved, false);
  assert.equal(s.workvivoConfigured, false);
});
test('local dismissal is respected and stale tokens do not count', async () => {
  const s = await deviceReadiness(storage({ 'apai.deviceSetupReviewed.v1': 1 }, { 'workvivo.apiKey': 'configured' }, {
    'aurorbuddy.auror.jwt': { value: 'test', at: 1 }, 'safetyagent.safepass.token': { value: 'test', at: 29_999_000 },
  }), 30_000_000);
  assert.equal(s.reviewed, true);
  assert.equal(s.aurorObserved, false);
  assert.equal(s.safeiqObserved, true);
  assert.equal(s.workvivoConfigured, true);
});
