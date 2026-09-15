import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../../content/casevisibility.js', import.meta.url), 'utf8');
async function request(response) {
  let listener, options;
  vm.runInNewContext(source, {
    window: {}, URLSearchParams, AbortSignal,
    fetch: async (_url, opts) => { options = opts; return response; },
    chrome: { runtime: { onMessage: { addListener: fn => { listener = fn; } } } },
  });
  const result = await new Promise(resolve => listener({ module: 'closinglist', type: 'collect-schedule', storeNbr: '1458', businessDate: '2026-09-14' }, {}, resolve));
  assert.ok(options.signal);
  return result;
}
test('HTML login response is an auth failure without leaking body', async () => {
  const r = await request({ ok: true, headers: { get: () => 'text/html' }, text: async () => 'sensitive login body' });
  assert.equal(r.errorClass, 'AUTH');
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.error, /sensitive/);
});
test('HTTP 500 stays a server failure, not an auth recovery', async () => {
  const r = await request({ ok: false, status: 500 });
  assert.equal(r.errorClass, 'HTTP');
  assert.match(r.error, /500/);
});
test('valid schedule is returned unchanged', async () => {
  const data = { schedule: [] };
  const r = await request({ ok: true, headers: { get: () => 'application/json' }, json: async () => data });
  assert.equal(r.ok, true);
  assert.equal(r.data, data);
});
