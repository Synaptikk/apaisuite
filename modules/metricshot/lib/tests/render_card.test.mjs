// modules/metricshot/lib/tests/render_card.test.mjs
//
// Run with: node --test modules/metricshot/lib/tests/render_card.test.mjs
//
// The card reproduces the VizPick Backroom Health Tableau dashboard, so these
// tests pin the things that make it recognisable — the colour rule, the ring
// set — and the things that make it render at all. A malformed SVG rasterises
// to nothing and surfaces only as a vague post failure, so well-formedness is
// asserted rather than assumed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMetricCard } from "../render_card.js";

const GREEN = "#25A738";
const BLACK = "#000000";
const BLUE  = "#0B61B2";

const sample = (over = {}) => ({
  health: 96,
  metrics: [
    { label: "Cases",     value: 97, goal: 95 },
    { label: "Locations", value: 98, goal: 95 },
    { label: "Picks",     value: 80, goal: 90 },
    { label: "Overstock", value: 88, goal: 90 },
  ],
  deptRings: [
    { label: "Fresh", value: 97 },
    { label: "F&C",   value: 97 },
    { label: "GM",    value: 94 },
  ],
  ...over,
});

test("renders at the dashboard's own dimensions", () => {
  const { svg, width, height } = renderMetricCard(sample(), {});
  assert.equal(width, 980);
  assert.equal(height, 614);
  assert.match(svg, /^<svg [^>]*viewBox="0 0 980 614"/);
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

test("goal rings are green at or above goal and black below — no middle band", () => {
  const { svg } = renderMetricCard(sample({
    metrics: [
      { label: "AtGoal",   value: 95, goal: 95 },   // exactly on goal counts as met
      { label: "Above",    value: 99, goal: 95 },
      { label: "JustshY",  value: 94, goal: 95 },   // one point under is still a miss
      { label: "WayUnder", value: 40, goal: 90 },
    ],
    deptRings: [],
  }), {});
  const greens = (svg.match(new RegExp(GREEN, "g")) || []).length;
  const blacks = (svg.match(new RegExp(`stroke="${BLACK}"`, "g")) || []).length;
  assert.equal(greens, 2, "two rings met their goal");
  assert.equal(blacks, 2, "two rings missed, and there is no amber tier");
});

test("rings without a goal are blue and never judged", () => {
  const { svg } = renderMetricCard(sample({ metrics: [], deptRings: [{ label: "Fresh", value: 12 }] }), {});
  // A department ring at 12 would be a catastrophic miss if it were judged.
  assert.ok(svg.includes(`stroke="${BLUE}"`), "unjudged rings use the composite blue");
  assert.ok(!svg.includes(`stroke="${BLACK}"`), "no goal means no black");
});

test("escapes label text, and truncates before escaping", () => {
  const { svg } = renderMetricCard(sample({
    deptRings: [{ label: "Fresh & Chilled & More & Beyond", value: 90 }],
  }), {});
  assert.ok(!/&(?!(amp|lt|gt|quot|apos);)/.test(svg),
    "truncating after escaping would split an entity into malformed XML");
  assert.ok(svg.includes("&amp;"));
});

test("missing numbers render an em dash rather than NaN", () => {
  const { svg } = renderMetricCard({
    health: null,
    metrics: [{ label: "Cases", value: null, goal: 95 }],
    deptRings: [{ label: "Fresh", value: null }],
  }, {});
  assert.ok(!svg.includes("NaN"));
  assert.ok(svg.includes("—"));
});

test("empty input still produces a parseable card", () => {
  const { svg, width } = renderMetricCard({}, {});
  assert.equal(width, 980);
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
