import test from 'node:test';
import assert from 'node:assert/strict';
import { needsImageRefresh, upgradeImageCache, IMAGE_SCHEMA } from './image_cache.js';
import { compactRow, hazardImageUrl, hazardSql } from './sql.js';

test('legacy rows without the image column require refresh', () => {
  assert.equal(needsImageRefresh({ rows: [Array(12).fill('')] }), true);
  assert.equal(needsImageRefresh({ rows: [Array(13).fill('')] }), false);
  assert.equal(needsImageRefresh({ schema: IMAGE_SCHEMA, rows: [Array(13).fill('')] }), false);
  assert.equal(needsImageRefresh(null), false);
  assert.equal(needsImageRefresh({ rows: [] }), false);
});
test('migration preserves the cached store and query window', async () => {
  const old = { store: '1458', from: '2026-09-01', to: '2026-09-10', rows: [Array(12).fill('')] };
  const fresh = { ...old, schema: IMAGE_SCHEMA, rows: [compactRow({ hzd_id: 'hazard/123' })] };
  const result = await upgradeImageCache(old, async query => {
    assert.deepEqual(query, { store: '1458', from: old.from, to: old.to });
    return { data: fresh };
  });
  assert.equal(result.data, fresh);
  assert.match(hazardImageUrl(result.data.rows[0][12]), /hazard%2F123_bbox_overlay\.jpg$/);
  assert.match(hazardSql({ store: '1458' }), /SELECT hzd.hzd_id/);
});
test('failed refresh preserves dashboard and gives a retry message', async () => {
  const old = { rows: [Array(12).fill('')] };
  const result = await upgradeImageCache(old, async () => { throw new Error('expired'); });
  assert.equal(result.data, old);
  assert.match(result.imageRefreshError, /Pull alerts/);
});
test('current cache is never fetched again just because an alert has no image ID', async () => {
  const data = { schema: IMAGE_SCHEMA, rows: [compactRow({})] };
  assert.equal((await upgradeImageCache(data, () => assert.fail('unexpected refresh'))).data, data);
});
