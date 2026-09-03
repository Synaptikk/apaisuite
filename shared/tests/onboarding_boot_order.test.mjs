// shared/tests/onboarding_boot_order.test.mjs
//
// Pins the shell's boot ordering around first-run setup (app.js, bottom of
// file). Three constraints that pull against each other:
//
//   1. The setup WIZARD must be awaited BEFORE the first route().
//      Usage rows stamp the home store at emit time
//      (shared/usage_metrics.js::buildUsageRow), and the first route emits
//      `module_opened` straight away. When onboarding was an unawaited call
//      placed AFTER route(), every brand-new install recorded its first event
//      with no store — a row that reads in the usage dashboard as an
//      unidentified user, and stays that way forever because the row is
//      already written by the time the wizard is filled in.
//   2. The coach marks (runTips) must run AFTER route(), because they anchor
//      to sidebar elements that do not exist until the first route renders.
//      Anchoring to missing elements silently drops every tip.
//   3. route() must not be able to hang forever behind the wizard. It paints
//      the entire suite now, so a runSetup() that never resolves would mean a
//      permanently blank window — worse than the bug in (1). Hence the race
//      against a timeout.
//
// Why a source scan rather than a behavioural test: the thing that regressed
// is a CALL SITE and an `await` keyword. Exercising it for real needs a DOM, a
// chrome stub and a fake Firestore, which is how this check would rot — the
// same reasoning as alarm_install_sites.test.mjs.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const APP_JS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "app.js");
const src = readFileSync(APP_JS, "utf8");

// The boot block only — earlier occurrences are the Settings "run setup again"
// path (forced, sidebar already rendered), which has none of these constraints.
const bootStart = src.indexOf("const SETUP_BLOCK_MAX_MS");
const boot = bootStart === -1 ? "" : src.slice(bootStart);

const posOf = (re) => {
  const m = boot.match(re);
  return m ? boot.indexOf(m[0]) : -1;
};

test("the boot block exists and is identifiable", () => {
  assert.ok(bootStart !== -1,
    "app.js no longer has the SETUP_BLOCK_MAX_MS boot block — if the boot sequence was " +
    "restructured, this test must be rewritten rather than deleted.");
});

test("the setup wizard is awaited before the first route", () => {
  const setup = posOf(/runSetup\s*\(/);
  const route = posOf(/await\s+route\s*\(/);
  assert.ok(setup !== -1, "runSetup() is not called during boot");
  assert.ok(route !== -1, "route() is not awaited during boot — an unawaited route cannot be ordered");
  assert.ok(setup < route,
    "runSetup() must come BEFORE route(). The first route emits module_opened, and " +
    "usage rows stamp the home store at emit time — mounting first means every new " +
    "install writes a permanently store-less first row.");
});

test("route is awaited, so what follows it really does follow it", () => {
  // `route().catch(...)` type-checks and runs, but everything below it then
  // executes BEFORE the route finishes — which is how the old ordering comment
  // came to describe an intent the code did not implement.
  assert.match(boot, /await\s+route\s*\(\s*\)/,
    "route() must be awaited during boot");
});

test("the coach marks run after the first route", () => {
  const route = posOf(/await\s+route\s*\(/);
  const tips  = posOf(/runTips\s*\(/);
  assert.ok(tips !== -1, "runTips() is not called during boot");
  assert.ok(route < tips,
    "runTips() must come AFTER route(). Tips anchor to sidebar elements that do not " +
    "exist until the first route has rendered, and anchoring to a missing element " +
    "drops the tip silently.");
});

test("the wizard cannot block boot forever", () => {
  // route() now paints the whole suite from behind the wizard. Without this
  // guard a wizard that never resolves is a blank window with no error.
  assert.match(boot, /Promise\.race\s*\(/,
    "runSetup() must be raced against a timeout — see constraint 3 in this file's header");
  assert.match(boot, /SETUP_BLOCK_MAX_MS/,
    "the race needs an explicit named bound, not a literal");
  const ms = boot.match(/const SETUP_BLOCK_MAX_MS\s*=\s*([\d_]+)/);
  assert.ok(ms, "SETUP_BLOCK_MAX_MS is not a plain numeric literal");
  const value = Number(ms[1].replaceAll("_", ""));
  // Long enough that a person answering three questions is never cut off;
  // short enough that a hang is not indistinguishable from a broken install.
  assert.ok(value >= 30_000 && value <= 300_000,
    `SETUP_BLOCK_MAX_MS is ${value}ms — expected between 30s and 5min`);
});

test("onboarding is gated so existing users pay only a storage read", () => {
  assert.match(boot, /needsOnboarding\s*\(/,
    "boot must gate on needsOnboarding() — running the wizard unconditionally would " +
    "show it to every existing user on every load");
});
