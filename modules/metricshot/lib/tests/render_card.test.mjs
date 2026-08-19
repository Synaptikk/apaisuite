// node modules/metricshot/lib/tests/render_card.test.mjs
//
// The renderer's output is fed to an image decoder, which rejects malformed
// XML silently — a broken card rasterises to nothing and the post fails with
// an unhelpful error. These tests guard the ways that markup can go wrong.

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMetricCard } from "../render_card.js";

// Minimal well-formedness check without pulling in an XML library: every tag
// must balance and no bare "&" may survive.
function assertWellFormed(svg) {
  assert.ok(svg.startsWith("<svg "), "must start with <svg");
  assert.ok(svg.endsWith("</svg>"), "must end with </svg>");
  assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'), "needs the SVG namespace");
  const bare = svg.match(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-f]+;)/gi);
  assert.equal(bare, null, `bare ampersand(s) in output: ${bare}`);
  assert.equal((svg.match(/<text/g) || []).length, (svg.match(/<\/text>/g) || []).length, "unbalanced <text>");
}

const SAMPLE = {
  ok: true,
  departmentBreakout: [
    { dept: "Dairy", pickPct: 0.94, totalPicked: 310 },
    { dept: "Bakery", pickPct: 0.55, totalPicked: 40 },
  ],
  locationDetails: [
    { location: "A1", hoursSinceLastScan: 14.2 },
    { location: "B1", hoursSinceLastScan: 7.5 },
  ],
};

test("renders well-formed SVG", () => {
  const { svg, width, height } = renderMetricCard(SAMPLE, { metricName: "VizPick Score" });
  assertWellFormed(svg);
  assert.ok(width > 0 && height > 0);
});

test("escapes markup in department names", () => {
  const { svg } = renderMetricCard(
    { ...SAMPLE, departmentBreakout: [{ dept: '<script>&"x"', pickPct: 0.5 }] },
    {},
  );
  assertWellFormed(svg);
  assert.ok(!svg.includes("<script>"), "raw tag leaked into output");
});

test("truncating a long name never splits an entity", () => {
  // Regression: the name was sliced AFTER escaping, cutting "&amp;" into "&a"
  // and producing XML the decoder rejects.
  const long = "Dry Grocery & More & Even More & Longer Still";
  const { svg } = renderMetricCard({ ...SAMPLE, departmentBreakout: [{ dept: long, pickPct: 0.5 }] }, {});
  assertWellFormed(svg);
});

test("bands against the goal: at/above blue, near orange, below red", () => {
  const { svg } = renderMetricCard(
    { ...SAMPLE, departmentBreakout: [
      { dept: "At",   pickPct: 0.80 },   // == goal  -> blue
      { dept: "Near", pickPct: 0.77 },   // within 5 -> orange
      { dept: "Miss", pickPct: 0.40 },   // clear miss -> red
    ] },
    { pickGoal: 80 },
  );
  assert.ok(svg.includes("#0053e2"), "expected the met/blue band");
  assert.ok(svg.includes("#e07b00"), "expected the near/orange band");
  assert.ok(svg.includes("#c53030"), "expected the missed/red band");
});

test("accepts pick % as either a 0..1 fraction or a 0..100 number", () => {
  const frac = renderMetricCard({ ...SAMPLE, departmentBreakout: [{ dept: "D", pickPct: 0.94 }] }, {});
  const whole = renderMetricCard({ ...SAMPLE, departmentBreakout: [{ dept: "D", pickPct: 94 }] }, {});
  assert.ok(frac.svg.includes(">94%<"), "fraction form should print 94%");
  assert.ok(whole.svg.includes(">94%<"), "whole-number form should print 94%");
});

test("empty data renders a placeholder instead of throwing", () => {
  const { svg } = renderMetricCard({ ok: false, departmentBreakout: [], locationDetails: [] }, {});
  assertWellFormed(svg);
  assert.ok(svg.includes("No department rows"));
});

test("counts aged bins by tier, inclusive of the boundary", () => {
  const { svg } = renderMetricCard(
    { ok: true, departmentBreakout: [], locationDetails: [
      { location: "a", hoursSinceLastScan: 12 },    // >=12 counts in all three tiers
      { location: "b", hoursSinceLastScan: 9.5 },   // >=9 and >=6
      { location: "c", hoursSinceLastScan: 1 },     // none
    ] },
    {},
  );
  // Tiers are cumulative: 1 urgent, 2 high, 2 aged.
  assert.ok(svg.includes(">1</text>"), "expected 1 in the >12h tile");
  assert.ok(svg.includes(">2</text>"), "expected 2 in the >9h and >6h tiles");
});
