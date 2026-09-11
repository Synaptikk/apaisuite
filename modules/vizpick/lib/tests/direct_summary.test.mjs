import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { directSummaryExport } from '../sources/tableau_export_replay.js';
import { parseDonutHealth, parseDepartmentGroups, parseLocationDetails } from '../parse_vizpick_stores_csv.js';

async function summary(columns, tuples) {
  const schema = columns.map((_, i) => `column${i}`);
  const model = { showDataFormattedTable: JSON.stringify({ table: { schema, tuples } }),
    showDataTableColumnPresModels: columns.map((fieldCaption, i) => ({ fieldCaption, uniqueName: schema[i] })) };
  globalThis.chrome = { scripting: { executeScript: async ({ func, args }) => {
    // Chrome serializes this function: no access to the module's helpers.
    const isolated = vm.runInNewContext(`(${func.toString()})`, {
      window: { tsConfig: { sessionid: 'test', repositoryUrl: 'VizPick/VizPickDetails', site_root: '/t/test' } },
      location: { origin: 'https://example.test' }, FormData, AbortSignal, performance,
      fetch: async () => ({ ok: true, json: async () => ({ vqlCmdResponse: { cmdResultList: [{ commandReturn: { dataTablePresModel: model } }] } }) }),
    });
    return [{ result: await isolated(...args) }];
  } } };
  const result = await directSummaryExport(1, { sheet: 'test' });
  assert.equal(result.ok, true, result.reason);
  return result.text;
}

const healthColumns = ['AGG(Cases Seen %)', 'AGG(New Location %)', 'AGG(New Overstock %)', 'AGG(New Pick %)', 'AGG(New VizPick )'];
test('isolated injected summary skips Tableau Null background arcs and preserves real zero', async () => {
  const text = await summary(healthColumns, [Array(5).fill('Null'), ['96%', '98%', '94%', '0%', '100']]);
  const result = parseDonutHealth(text);
  assert.equal(result.ok, true);
  assert.deepEqual(result.health, { casesSeenPct: 96, locationPct: 98, overstockPct: 94, pickPct: 0, vizpick: 100 });
});
test('null arcs cannot overwrite populated department group scores', async () => {
  const text = await summary(['Department Group', ...healthColumns], [
    ['GM', '96%', '98%', '94%', '92%', '98'], ['GM', ...Array(5).fill('Null')],
  ]);
  assert.deepEqual(parseDepartmentGroups(text).groups, [{ label: 'GM', value: 98, casesSeenPct: 96, locationPct: 98, overstockPct: 94, pickPct: 92 }]);
});
test('locations preserve counts and do not invent Null users or scan timestamps', async () => {
  const text = await summary(['Location', 'Seen Today', 'SUM(Suggested Picks Seen)', 'SUM(Suggested Picks Done)', 'MAX(user_id)', 'MAX(last_seen_timestamp)'],
    ['001/001', '001/002', '001/003'].map(loc => [loc, 'No', '5', '2', 'Null', 'Null']));
  const result = parseLocationDetails(text, { allScans: true });
  assert.equal(result.ok, true);
  assert.equal(result.gaps.length, 3);
  assert.equal(result.gaps[0].skipped, 3);
  assert.equal(result.gaps[0].win, null);
  assert.deepEqual(result.scans, []);
});

test('missing location pick columns cannot claim every suggested pick was pulled', () => {
  assert.equal(parseLocationDetails('Location\tSeen Today\n001/001\tYes\n001/002\tYes\n001/003\tYes').ok, false);
});
