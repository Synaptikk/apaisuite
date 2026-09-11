import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { discoverExportSheets, replayExport } from '../sources/tableau_export_replay.js';

function installFrames(fetch) {
  const config = { sessionid: 'session', repositoryUrl: 'VizPick/VizPickDetails', site_root: '/t/site' };
  globalThis.chrome = { scripting: { executeScript: async ({ func, args = [] }) => {
    const results = [];
    for (const window of [{}, { tsConfig: config }]) {
      const isolated = vm.runInNewContext(`(${func.toString()})`, {
        window, location: { origin: 'https://example.test' }, FormData, AbortSignal, performance, fetch, btoa,
      });
      results.push({ result: await isolated(...args) });
    }
    return results;
  } } };
}

test('discover sheet IDs from nested metadata without DOM access or portal requests', async () => {
  let calls = 0;
  installFrames(async (url, options) => {
    calls++;
    assert.match(url, /\/commands\/tabsrv\/export-crosstab-server-dialog$/);
    assert.equal(options.body.get('thumbnailUris'), '{}');
    return { ok: true, json: async () => ({ result: { sheets: [{
      sheetdocId: '{test-guid}', sheetName: 'Download Department Breakout (Current Day)',
    }] } }) };
  });
  const result = await discoverExportSheets(17);
  assert.equal(result.ok, true, result.reason);
  assert.equal(calls, 1, 'only the viz frame issues discovery');
  assert.equal(result.tabId, 17);
  assert.equal(result.sheetIds['download department breakout (current day)'], '{test-guid}');
  assert.match(result.base, /\/sessions\/session$/);
});

test('empty/rejected discovery returns an actionable failure', async () => {
  installFrames(async () => ({ ok: true, json: async () => ({ errors: [] }) }));
  assert.match((await discoverExportSheets(1)).reason, /no sheets/);
});

test('Excel replay posts once then fetches bytes, without a download click', async () => {
  const requests = [];
  installFrames(async (url, options) => {
    requests.push(url);
    if (options.method === 'POST') {
      assert.match(options.body, /\{test-guid\}/);
      return { status: 200, text: async () => JSON.stringify({ resultKey: '123', fileName: 'Department.xlsx' }) };
    }
    return { ok: true, arrayBuffer: async () => Uint8Array.from([80, 75, 3, 4]).buffer };
  });
  const result = await replayExport(1, { base: 'https://example.test/vizql/t/site/w/VizPick/v/VizPickDetails/sessions/session', sheetdocId: '{test-guid}' });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.isZip, true);
  assert.equal(requests.length, 2, 'portal wrapper must not duplicate the export');
  assert.match(requests[0], /export-crosstab-to-excel-server$/);
  assert.match(requests[1], /\/tempfile\/sessions\/session\?key=123/);
});
