// shared/tests/layoutPref.test.mjs
//
// Covers shared/layoutPref.js. The behavior worth pinning is the default:
// every unrecognized input must resolve to "current", never "preview" — a
// user who has never touched this setting, or whose stored value is stale or
// corrupt, must land on the layout they already know.
//
// Run with: node --test shared/tests/layoutPref.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { LAYOUTS, resolveLayoutPref, isPreviewLayout } from "../layoutPref.js";

test("resolves the literal preview value to preview", () => {
  assert.equal(resolveLayoutPref("preview"), LAYOUTS.PREVIEW);
});

test("resolves the literal current value to current", () => {
  assert.equal(resolveLayoutPref("current"), LAYOUTS.CURRENT);
});

test("defaults missing/undefined to current", () => {
  assert.equal(resolveLayoutPref(undefined), LAYOUTS.CURRENT);
  assert.equal(resolveLayoutPref(null), LAYOUTS.CURRENT);
});

test("defaults invalid/unrecognized values to current", () => {
  assert.equal(resolveLayoutPref("preview2"), LAYOUTS.CURRENT);
  assert.equal(resolveLayoutPref("PREVIEW"), LAYOUTS.CURRENT);
  assert.equal(resolveLayoutPref(""), LAYOUTS.CURRENT);
  assert.equal(resolveLayoutPref(0), LAYOUTS.CURRENT);
  assert.equal(resolveLayoutPref({}), LAYOUTS.CURRENT);
});

test("isPreviewLayout mirrors resolveLayoutPref", () => {
  assert.equal(isPreviewLayout("preview"), true);
  assert.equal(isPreviewLayout("current"), false);
  assert.equal(isPreviewLayout("garbage"), false);
  assert.equal(isPreviewLayout(undefined), false);
});
