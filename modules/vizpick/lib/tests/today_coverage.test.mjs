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

import { locationSignature, withholdDuplicateLocations } from '../today_coverage.js';
test('identical location detail on two stores is withheld from both, and named', () => {
  const gaps = [{ location: '001/002', win: 'A0B0C1D', skipped: 2 }, { location: '003/004', win: 'e0f0g2h', skipped: 1 }];
  const a = { store: '1458', locations: { gaps } };
  const b = { store: '5173', locations: { gaps: [...gaps].reverse().map((g) => ({ ...g, win: g.win.toLowerCase() })) } };
  const c = { store: '658', locations: { gaps: [{ location: '001/002', win: 'zzz999z', skipped: 4 }] } };
  const d = { store: '669', locations: { gaps: [] } };
  const e = { store: '756', locations: { gaps: [] } };
  assert.equal(locationSignature(a), locationSignature(b), 'order and case do not matter');
  assert.equal(locationSignature(d), '', 'no gaps, no signature');
  const out = withholdDuplicateLocations([a, b, c, d, e]);
  assert.equal(out[0].locations, null); assert.deepEqual(out[0].locationsWithheld, { store: '5173' });
  assert.equal(out[1].locations, null); assert.deepEqual(out[1].locationsWithheld, { store: '1458' });
  assert.equal(out[2].locations.gaps.length, 1, 'a distinct store keeps its detail');
  assert.equal(out[3].locations.gaps.length, 0, 'two empty stores are not duplicates of each other');
  assert.equal(out[3].locationsWithheld, undefined);
  assert.equal(a.locations.gaps.length, 2, 'input rows are not mutated');
});
