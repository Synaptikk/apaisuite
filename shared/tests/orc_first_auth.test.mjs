import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../../modules/orcmonitor/service.js', import.meta.url), 'utf8');
const fn = source.slice(source.indexOf('async function ensureAurorAuth()'), source.indexOf('// ── Handlers'));
async function run({ captured = false, existing = false } = {}) {
  const removed = [];
  let token = false;
  const tab = { id: 5, url: 'https://app.us.auror.co/login' };
  const context = { aurorJwt: { get: () => token }, _findAurorTab: async () => existing ? tab : null,
    _waitLoad: async () => {}, _pollToken: async () => { token = captured; return captured; },
    _auth: { clickSso: async () => false }, AUROR_HOME: '', AUROR_FAST_MS: 0, AUROR_SLOW_MS: 0, AUROR_SSO_SELECTORS: [],
    chrome: { tabs: { create: async () => tab, get: async () => tab, reload: async () => {}, remove: async id => { removed.push(id); } } } };
  const result = await vm.runInNewContext(`${fn}\nensureAurorAuth()`, context);
  return { result, removed };
}
test('MFA sign-in tab survives unsuccessful first authentication', async () => {
  const { result, removed } = await run();
  assert.equal(result.ok, false);
  assert.match(result.reason, /Sign in/);
  assert.deepEqual(removed, []);
});
test('successful owned tab is closed; existing user tab is retained', async () => {
  assert.ok((await run({ captured: true })).removed.includes(5));
  assert.deepEqual((await run({ captured: true, existing: true })).removed, []);
});
