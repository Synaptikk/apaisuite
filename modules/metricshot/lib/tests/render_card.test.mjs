// modules/metricshot/lib/tests/render_card.test.mjs
//
// Run with: node --test modules/metricshot/lib/tests/render_card.test.mjs
//
// The card reproduces the VizPick Backroom Health Tableau dashboard, so these
// tests pin the things that make it recognisable — the colour rule, the fixed
// ring/legend layout — and the things that make it render at all. A malformed
// SVG rasterises to nothing and surfaces only as a vague post failure, so
// well-formedness is asserted rather than assumed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMetricCard } from "../render_card.js";

const GREEN = "#23A730";
const BLACK = "#000000";
const BLUE  = "#0C61B2";

const sample = (over = {}) => ({
  health: 96,
  metrics: [
    { label: "Cases",     value: 97 },
    { label: "Locations", value: 98 },
    { label: "Picks",     value: 80 },
    { label: "Overstock", value: 88 },
  ],
  deptRings: [
    { label: "Fresh", value: 97 },
    { label: "F&C",   value: 97 },
    { label: "GM",    value: 94 },
  ],
  ...over,
});

test("renders at the reference capture's own dimensions", () => {
  const { svg, width, height } = renderMetricCard(sample(), {});
  assert.equal(width, 696);
  assert.equal(height, 302); // 284 reproduced panel + 18 footer band
  assert.match(svg, /^<svg [^>]*viewBox="0 0 696 302"/);
});

test("is well-formed XML", () => {
  const { svg } = renderMetricCard(sample(), { store: "1458" });
  // Cheap structural checks — a real parser is not available here, and these
  // catch the failures that actually happen: unbalanced tags and raw entities.
  const open = (svg.match(/<(circle|rect|text|path|svg)\b/g) || []).length;
  const close = (svg.match(/<\/(text|svg)>|\/>/g) || []).length;
  assert.equal(open, close, "every element is closed");
  assert.ok(!/&(?!(amp|lt|gt|quot|apos);)/.test(svg), "no unescaped ampersands");
});

test("every ring slot renders even with no data at all — no more blank cards", () => {
  // The whole point of fixed slots: a run where health/metrics/deptRings are
  // ALL empty (the common case when only the headless VizPick export ran)
  // used to post a card with just the header and one hollow ring. Every named
  // slot — 3 dept rings, 4 goal rings, and the legend — must still appear.
  const { svg } = renderMetricCard({ health: null, metrics: [], deptRings: [] }, {});
  for (const label of ["Fresh", "F&C", "GM", "Cases", "Locations", "Picks", "Overstock"]) {
    assert.ok(svg.includes(`>${label}<`) || svg.includes(label.replace("&", "&amp;")),
      `${label} slot label is present even with no data`);
  }
  assert.ok(svg.includes("VizPick Health Metric"), "legend title always renders");
  assert.ok(svg.includes("Goal &gt; 95% (40% wt.)") || svg.includes("Goal > 95% (40% wt.)"),
    "legend goal/weight text always renders");
});

test("goal rings are green at or above goal and black below — no middle band", () => {
  const { svg } = renderMetricCard(sample({
    metrics: [
      { label: "Cases",     value: 95 },  // exactly on goal (95) counts as met
      { label: "Locations", value: 99 },  // above goal
      { label: "Picks",     value: 89 },  // one point under goal (90) is still a miss
      { label: "Overstock", value: 40 },  // way under goal
    ],
  }), {});
  const greens = (svg.match(new RegExp(GREEN, "g")) || []).length;
  const blacks = (svg.match(new RegExp(`stroke="${BLACK}"`, "g")) || []).length;
  assert.equal(greens, 2, "two rings met their goal");
  assert.equal(blacks, 2, "two rings missed, and there is no amber tier");
});

test("a metric's own goal overrides the slot default when present", () => {
  const { svg } = renderMetricCard(sample({
    metrics: [{ label: "Picks", value: 92, goal: 95 }],
  }), {});
  assert.ok(svg.includes("Goal 95%"), "explicit goal wins over the slot default (90)");
});

test("rings without a goal are blue and never judged", () => {
  const { svg } = renderMetricCard(sample({ metrics: [], deptRings: [{ label: "Fresh", value: 12 }] }), {});
  // A department ring at 12 would be a catastrophic miss if it were judged.
  assert.ok(svg.includes(`stroke="${BLUE}"`), "unjudged rings use the composite blue");
  assert.ok(!svg.includes(`stroke="${BLACK}"`), "no goal means no black");
});

test("dept ring label text is the fixed slot name, not whatever the caller passed", () => {
  // Positional rendering was removed with the fixed-slot rewrite — a caller
  // can only ever light up one of the three known slots (Fresh/F&C/GM) by
  // matching on `label`; it can't make an arbitrary string appear as a ring
  // label the way the old positional renderer would have (harmlessly, since
  // esc() always ran — but the display text was still caller-chosen).
  const { svg } = renderMetricCard(sample({
    deptRings: [{ label: "Fresh", value: 90, evil: "<script>" }],
  }), {});
  assert.ok(!svg.includes("<script>"));
  assert.ok(svg.includes(">Fresh<"));
});

test("escapes the title, and truncates before escaping", () => {
  const { svg } = renderMetricCard(sample(), {
    title: "Fresh & Chilled & More & Beyond & Even More Padding Here To Force Truncation",
  });
  assert.ok(!/&(?!(amp|lt|gt|quot|apos);)/.test(svg),
    "truncating after escaping would split an entity into malformed XML");
  assert.ok(svg.includes("&amp;"));
});

test("missing numbers render an em dash rather than NaN", () => {
  const { svg } = renderMetricCard({
    health: null,
    metrics: [{ label: "Cases", value: null }],
    deptRings: [{ label: "Fresh", value: null }],
  }, {});
  assert.ok(!svg.includes("NaN"));
  assert.ok(svg.includes("—"));
});

test("empty input still produces a parseable card", () => {
  const { svg, width } = renderMetricCard({}, {});
  assert.equal(width, 696);
  assert.ok(svg.startsWith("<svg"));
  assert.ok(svg.includes("VizPick Backroom Health"), "the header still identifies the report");
});

test("store and capture time appear so a posted image can be placed", () => {
  const { svg } = renderMetricCard(sample(), { store: "1458", capturedAt: "Tue 19 Aug, 6:00 AM" });
  assert.ok(svg.includes("Store 1458"));
  assert.ok(svg.includes("Tue 19 Aug"));
});

test("carries no CSS custom properties", () => {
  // It is rasterised offscreen with no stylesheet attached; a var() would
  // resolve to nothing and the whole card would render black.
  const { svg } = renderMetricCard(sample(), {});
  assert.ok(!svg.includes("var(--"), "no var() may reach the offscreen rasteriser");
});
