import test from 'node:test';
import assert from 'node:assert/strict';
import { investigate } from '../investigation.js';
import { cashMatches, buildEvidence } from '../evidence.js';
const tx = (id, extra = {}) => ({ transNum: id, time: '12:00:00', totalCents: 10000, cashTendCents: 10000, changeDueCents: 0, ...extra });
test('cancelled, postvoid, refund and incomplete receipts cannot become cash candidates', () => {
  const ej = { transactions: [tx('ok'), tx('cancel', { isCanceled: true }), tx('void', { isPostVoid: true }), tx('refund', { isRefund: true }), tx('unknown', { totalCents: null })] };
  assert.deepEqual(investigate(ej, 10000, 500).candidates.map(x => x.transNum), ['ok']);
  assert.deepEqual(cashMatches(ej, 10000).map(x => x.transNum), ['ok']);
});
test('independent context ranks competing exact matches; split tender adds no risk points', () => {
  const plain = tx('plain');
  const split = tx('split', { tenders: [{ kind: 'card', cents: 5000 }] });
  const service = tx('service', { items: [{ desc: 'MONEY ORDER', cents: 10000 }] });
  const result = investigate({ transactions: [plain, split, service] }, 10000, 500);
  assert.equal(result.candidates[0].transNum, 'service');
  assert.equal(result.candidates[1].score, result.candidates[2].score);
  assert.match(result.candidates.find(c => c.transNum === 'split').conflicting.join(' '), /legitimate split/);
});
test('nonmatching receipts remain reviewable with explicit residual and no proven cause', () => {
  const r = investigate({ transactions: [tx('partial', { cashTendCents: 7000, totalCents: 7000 })] }, 10000, 500);
  assert.equal(r.candidates[0].residualCents, 3000);
  assert.equal(r.status, 'Cause unconfirmed');
  assert.match(r.candidates[0].conflicting.join(' '), /does not reconcile/);
  assert.match(investigate({ transactions: [] }, 10000, 500).gaps.join(' '), /coverage is unverified/);
});
test('nearby drawer events require valid times and remain unconfirmed associations', () => {
  const r = investigate({ transactions: [tx('a'), tx('b', { time: null })], events: [{ kind: 'nosale', time: '12:02:00' }] }, 10000, 500);
  assert.equal(r.candidates[0].nearby.length, 1);
  assert.equal(r.candidates[1].nearby.length, 0);
});
test('unmatched investigation preserves receipt evidence and does not assign a disposition', () => {
  const ev = buildEvidence({ item: { register: '1', date: '2026-09-01', amountCents: -10000, amountAbsCents: 10000 }, ej: { transactions: [tx('a', { raw: '<receipt>' }), tx('b')] } });
  assert.equal(ev.videoCandidates.length, 2);
  assert.equal(ev.investigation.candidates[0].raw, '<receipt>');
  assert.equal(ev.suggestion.safe, false);
  assert.equal(ev.suggestion.reasonLabel, null);
});
