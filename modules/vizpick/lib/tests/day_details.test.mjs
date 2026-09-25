import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detailFromRow, dayOfDetail, pickDetail, foldRows,
  detailFromHistoryEntry, lastHistoryDetails, recordFromRows, read, dayKeyOf, INDEX_KEY, MAX_DAYS,
} from '../day_details.js';
import { KEY as HISTORY_KEY } from '../home_history.js';

// Local-time ISO strings, so the day keys do not depend on the machine's zone.
const at = (day, hm) => new Date(`${day}T${hm}:00`).toISOString();
const stamp = (day, hm) => ({ raw: `${day} ${hm}`, iso: at(day, hm), hasTime: true });
const gap = (location, win, skipped = 1) => ({ locGroup: '1', location, picksSeen: skipped + 1, picksDone: 1, skipped, win, lastSeenAt: null });
const dept = (n, done, sug) => ({ dept: String(n), suggestedPicks: sug, suggestedPicksCompleted: done, pickPct: (done / sug) * 100, casesSeen: 1, casesExpected: 2, casesSeenPct: 50 });
const row = (store, day, hm, extra = {}) => ({
  store, sourceUpdate: stamp(day, hm), stampVia: 'summary', capturedAt: at(day, hm),
  depts: [dept(92, 1, 4)], deptCount: 1, deptGroups: [{ label: 'GM', value: 1 }],
  locations: { gaps: [gap(`${store}/001`, `w${store}`)], byLocGroup: {}, locationCount: 9, bins: [{ location: 'x' }], scans: [] },
  ...extra,
});

test('a row is filed under its own stamp day, not the day it was read', () => {
  const d = detailFromRow({ ...row('1458', '2026-09-15', '20:02'), capturedAt: at('2026-09-16', '01:10') });
  assert.equal(dayOfDetail(d), '2026-09-15');
  assert.equal(d.locations.bins, undefined, 'per-bin list stays in home history');
  assert.equal(detailFromRow({ store: '1', casesSeenPct: 5 }), null, 'no detail, nothing to keep');
  const old = detailFromRow({ store: '7', depts: [dept(1, 1, 2)], capturedAt: at('2026-09-14', '09:00') }, { sourceUpdate: stamp('2026-09-14', '08:03') });
  assert.equal(old.stampVia, 'crawl');
  assert.equal(dayOfDetail(old), '2026-09-14');
});

test('the last reading of the day stands; a failed export does not erase it', () => {
  const morning = detailFromRow(row('1458', '2026-09-15', '09:03'));
  const evening = detailFromRow(row('1458', '2026-09-15', '20:02', { depts: [dept(92, 3, 4)] }));
  assert.equal(pickDetail(morning, evening), evening);
  assert.equal(pickDetail(evening, morning), evening, 'an older reading never replaces a newer one');
  const thin = detailFromRow(row('1458', '2026-09-15', '21:02', { locations: null }));
  assert.equal(pickDetail(evening, thin), evening, 'later but missing the associate list');
  const retry = detailFromRow(row('1458', '2026-09-15', '20:02', { depts: null }));
  assert.equal(pickDetail(evening, retry), evening, 'same stamp, nothing new: no rewrite');
  const filled = pickDetail(retry, evening);
  assert.equal(filled.depts.length, 1);
});

test('foldRows keeps days apart and drops wrong-store location detail', () => {
  const rows = [row('1458', '2026-09-15', '20:02'), row('1458', '2026-09-16', '08:03'), row('1089', '2026-09-16', '08:03')];
  const { days, touched } = foldRows({}, rows);
  assert.deepEqual(touched.sort(), ['2026-09-15', '2026-09-16']);
  assert.deepEqual(Object.keys(days['2026-09-16']).sort(), ['1089', '1458']);
  assert.deepEqual(foldRows(days, rows).touched, [], 'idempotent');

  const same = [gap('1/1', 'abc'), gap('1/2', 'def')];
  const dup = foldRows({}, [
    row('10', '2026-09-16', '08:03', { locations: { gaps: same } }),
    row('11', '2026-09-16', '08:03', { locations: { gaps: same } }),
  ]).days['2026-09-16'];
  assert.equal(dup['10'].locations, null);
  assert.equal(dup['10'].depts.length, 1, 'departments survive');
});

const entry = (store, day, hm, bins, extra = {}) => ({
  store, capturedAt: at(day, hm), lastConfirmedAt: at(day, hm), sourceIso: at(day, hm), sourceKey: `${day} ${hm}`, stampVia: 'summary',
  bins, depts: [{ dept: '92', suggested: 4, done: 1, casesSeen: 3, casesExpected: 6 }], ...extra,
});
const bins = (n, open) => Array.from({ length: n }, (_, i) => ({ location: `00${i % 3}/${100 + i}`, seen: 2, done: i < open ? 0 : 2, win: i < open ? 'abc123' : null, lastSeenAt: null }));

test('home history rebuilds a past day: open bins become gaps, depts take the card shape', () => {
  const d = detailFromHistoryEntry(entry('1458', '2026-09-14', '19:02', bins(10, 3)));
  assert.equal(d.locations.gaps.length, 3);
  assert.deepEqual({ ...d.locations.gaps[0] }, { locGroup: '0', location: '000/100', picksSeen: 2, picksDone: 0, skipped: 2, win: 'abc123', lastSeenAt: null });
  assert.equal(d.depts[0].suggestedPicksCompleted, 1);
  assert.equal(d.depts[0].pickPct, 25);
  assert.equal(d.fromHistory, true);
});

test('lastHistoryDetails takes the last entry by data time and regroups by stamp day', () => {
  const history = { v: 1, days: {
    '2026-09-14': [entry('1458', '2026-09-14', '09:03', bins(10, 5)), entry('1458', '2026-09-14', '19:02', bins(10, 2))],
    // Read after midnight, still the 14th's 8 PM update.
    '2026-09-15': [entry('1458', '2026-09-14', '20:02', bins(10, 1), { capturedAt: at('2026-09-15', '00:20') }), entry('1458', '2026-09-15', '09:03', bins(10, 6))],
  } };
  const out = lastHistoryDetails(history);
  assert.equal(out['2026-09-14']['1458'].locations.gaps.length, 1);
  assert.equal(out['2026-09-15']['1458'].locations.gaps.length, 6);
});

test('storage: records per day, prunes past MAX_DAYS, read() prefers the archive over history', async () => {
  const mem = {};
  globalThis.chrome = { storage: { local: {
    get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in mem).map((k) => [k, structuredClone(mem[k])])),
    set: async (obj) => { Object.assign(mem, structuredClone(obj)); },
    remove: async (keys) => { for (const k of [].concat(keys)) delete mem[k]; },
  } } };
  try {
    for (let i = 1; i <= MAX_DAYS + 2; i++) {
      await recordFromRows([row('1458', `2026-08-${String(i).padStart(2, '0')}`, '20:02')]);
    }
    assert.equal(mem[INDEX_KEY].length, MAX_DAYS);
    assert.equal(mem[dayKeyOf('2026-08-01')], undefined);
    assert.ok(mem[dayKeyOf('2026-08-16')]);
    const res = await recordFromRows([row('1458', '2026-08-16', '20:02')]);
    assert.deepEqual(res.touched, [], 'same reading again writes nothing');

    mem[HISTORY_KEY] = { v: 1, days: { '2026-08-16': [entry('1458', '2026-08-16', '19:02', bins(10, 4)), entry('999', '2026-08-16', '19:02', bins(10, 2))] } };
    const got = await read(['2026-08-16', '2026-07-01']);
    assert.equal(got['2026-08-16']['1458'].fromHistory, undefined, 'archived capture wins');
    assert.equal(got['2026-08-16']['999'].fromHistory, true, 'history fills a store the archive lacks');
    assert.equal(got['2026-07-01'], undefined);
  } finally { delete globalThis.chrome; }
});
