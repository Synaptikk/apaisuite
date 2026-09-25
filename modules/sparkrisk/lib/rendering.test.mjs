// modules/sparkrisk/lib/rendering.test.mjs
//
// Guards the two rendering hazards in view.js that have no DOM to test
// against here: HTML escaping of imported values, and the fact that a
// SparkRisk session_id is a JSON array containing double quotes.
//
//   node --test modules/sparkrisk/lib/rendering.test.mjs
//
// The first group is a real behavioural test of shared/ui.js::escapeHtml.
// The second is a source-level guard: it asserts that specific interpolations
// in view.js still route through esc(). It cannot prove the whole view is
// safe - it prevents the known-bad patterns from coming back.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { escapeHtml } from '../../../shared/ui.js';
import { buildSessionFromOrders } from './sessions.js';

const view = readFileSync(new URL('../view.js', import.meta.url), 'utf8');

test('a session_id contains characters that would break an HTML attribute unescaped', () => {
  const session = buildSessionFromOrders([{
    order_id: 'a', trip_id: 't', driver_uuid: 'd', store_nbr: '1458',
    pick_started_time: '2026-09-01T12:00:00Z',
    dispatched_time: '2026-09-01T12:10:00Z',
    total_order_qty: 10,
  }]);

  assert.ok(session.session_id.includes('"'), 'session ids are JSON arrays - this is the whole hazard');
  const escaped = escapeHtml(session.session_id);
  assert.ok(!escaped.includes('"'), 'escaped form is safe to place inside a double-quoted attribute');
  // Round-trip: the browser decodes &quot; back to " when reading dataset,
  // so the value the click handler receives must equal the original.
  assert.equal(escaped.replace(/&quot;/g, '"').replace(/&amp;/g, '&'), session.session_id);
});

test('escapeHtml neutralises the field shapes that arrive from imported files and OMS', () => {
  const cases = [
    ['<script>alert(1)</script>', /^&lt;script&gt;/],
    ['" onmouseover="alert(1)', /^&quot;/],
    ["Smith & Sons", /&amp;/],
    ["O'Brien", /./],
  ];
  for (const [input, pattern] of cases) {
    const out = escapeHtml(input);
    assert.ok(!/<|>/.test(out), `angle brackets survived escaping of: ${input}`);
    assert.ok(!out.includes('"'), `double quote survived escaping of: ${input}`);
    assert.match(out, pattern);
  }
});

test('view.js escapes the session id it writes into the row attribute', () => {
  assert.match(view, /data-session="\$\{esc\(r\.session_id\)\}"/,
    'an unescaped session_id terminates the data-session attribute and the row stops opening');
  assert.doesNotMatch(view, /data-session="\$\{r\.session_id\}"/);
});

test('view.js routes every imported or reviewer-supplied field through esc()', () => {
  // Each entry is a value that originates outside this file: an imported
  // order field, an OMS response field, or a reviewer's own note.
  const mustBeEscaped = [
    'r.driver_name || r.driver_id',
    'item.itemName || item.itemId',
    'item.upc',
    'item.lineStatus',
    'orderId',
    'result.real_order_ids.join(", ")',
    'review?.notes',
    'r.notes || "No notes"',
    'fmt.date(r.extraction_date)',
    'session.explanation',
  ];
  for (const expr of mustBeEscaped) {
    assert.ok(view.includes(`${'${'}esc(${expr}`),
      `expected view.js to render ${expr} through esc()`);
    assert.ok(!view.includes(`${'${'}${expr}`),
      `${expr} is also interpolated somewhere without esc()`);
  }
});

test('view.js no longer renders a peer percentile or a confidence label', () => {
  assert.doesNotMatch(view, /peer_percentile/, 'peer data is not populated and must not be shown as a column');
  assert.doesNotMatch(view, /r\.confidence/, 'confidence was renamed to history_coverage');
  assert.match(view, /historyLabel\(r\.history_coverage\)/);
});

test('view.js has no leftover references to the removed extraction controls', () => {
  for (const removed of ['sr-date-from', 'sr-date-to', 'startWismoExtraction', 'extraction_state']) {
    assert.ok(!view.includes(removed), `view.js still references removed control: ${removed}`);
  }
  // The context-bar button must actually do something.
  assert.match(view, /\$\("sr-extract-btn"\)\?\.addEventListener/);
  // The import button is re-enabled on both paths.
  assert.match(view, /finally \{[\s\S]{0,200}button\.disabled = false;/);
});
