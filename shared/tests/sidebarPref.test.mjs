// shared/tests/sidebarPref.test.mjs
//
// Covers shared/sidebarPref.js. As with layoutPref, the behaviour worth
// pinning is the default: every unrecognised input must resolve to
// "expanded", never "collapsed". Someone who has never touched this setting —
// or whose stored value is stale or corrupt — must not open the suite to a
// sidebar they did not ask to shrink.
//
// Run with: node --test shared/tests/sidebarPref.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { SIDEBAR, resolveSidebarPref, isCollapsed, toggledSidebarPref } from "../sidebarPref.js";

test("resolves the literal collapsed value to collapsed", () => {
  assert.equal(resolveSidebarPref("collapsed"), SIDEBAR.COLLAPSED);
});

test("resolves the literal expanded value to expanded", () => {
  assert.equal(resolveSidebarPref("expanded"), SIDEBAR.EXPANDED);
});

test("defaults missing/undefined to expanded", () => {
  assert.equal(resolveSidebarPref(undefined), SIDEBAR.EXPANDED);
  assert.equal(resolveSidebarPref(null), SIDEBAR.EXPANDED);
  assert.equal(resolveSidebarPref(""), SIDEBAR.EXPANDED);
});

test("anything unrecognised resolves to expanded, never collapsed", () => {
  // Stale values from an older build, a future build, or a corrupt store.
  for (const v of ["COLLAPSED", "mini", "minimised", "true", 1, {}, [], "preview"]) {
    assert.equal(resolveSidebarPref(v), SIDEBAR.EXPANDED, JSON.stringify(v));
  }
});

test("isCollapsed agrees with resolveSidebarPref", () => {
  assert.equal(isCollapsed("collapsed"), true);
  assert.equal(isCollapsed("expanded"), false);
  assert.equal(isCollapsed(undefined), false);
  assert.equal(isCollapsed("nonsense"), false);
});

test("toggling flips between the two states", () => {
  assert.equal(toggledSidebarPref("expanded"), SIDEBAR.COLLAPSED);
  assert.equal(toggledSidebarPref("collapsed"), SIDEBAR.EXPANDED);
});

test("toggling from an unrecognised value collapses", () => {
  // The default is expanded, so the first toggle must do something visible
  // rather than appear to be a no-op.
  assert.equal(toggledSidebarPref(undefined), SIDEBAR.COLLAPSED);
  assert.equal(toggledSidebarPref("nonsense"), SIDEBAR.COLLAPSED);
});

test("the two states are the only values", () => {
  assert.deepEqual(Object.values(SIDEBAR).sort(), ["collapsed", "expanded"]);
});
