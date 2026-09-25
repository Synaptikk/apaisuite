import test from 'node:test';
import assert from 'node:assert/strict';
import { SEED_METRICS } from '../../modules/metricshot/data/defaults.js';
test('new metric schedules require explicit enabling', () => {
  assert.ok(SEED_METRICS.length);
  assert.ok(SEED_METRICS.every(m => m.enabled === false));
});
