import test from 'node:test';
import assert from 'node:assert/strict';
import { TODAY_DATA_REVISION, isTodayRowComplete, mergeTodayRow } from '../today_coverage.js';
import { todayCoveredStores } from '../snapshots.js';
const complete = { store: '1', dataRevision: TODAY_DATA_REVISION, hasHealth: true,
  casesSeenPct: 0, locationPct: 0, overstockPct: 0, pickPct: 0, vizpick: 0,
  deptGroups: [{ label: 'GM', value: 0 }], locations: { gaps: [] } };
test('only current, fully captured rows suppress same-stamp retries', () => {
  assert.equal(isTodayRowComplete(complete), true, 'zero metrics and no outstanding gaps are valid');
  const rows = [complete, { ...complete, store: '2', locations: null },
    { ...complete, store: '3', deptGroups: null }, { ...complete, store: '4', hasHealth: false },
    { ...complete, store: '5', dataRevision: undefined }];
  assert.deepEqual(todayCoveredStores({ today: { market: '120', rows } }, '120'), ['1']);
  assert.deepEqual(todayCoveredStores({ today: { market: '120', rows } }, '121'), []);
});
test('retry merges independently successful sections and replaces corrupt older revisions', () => {
  const old = { ...complete, locations: null };
  const next = { ...complete, hasHealth: false, deptGroups: null };
  assert.equal(isTodayRowComplete(mergeTodayRow(old, next)), true);
  assert.equal(mergeTodayRow({ ...complete, dataRevision: undefined }, next).hasHealth, false);
  assert.deepEqual(mergeTodayRow(complete, { store: '1' }), complete);
});
