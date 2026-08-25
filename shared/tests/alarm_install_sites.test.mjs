// shared/tests/alarm_install_sites.test.mjs
//
// Pins the rule from shared/alarms.js and MODULE_CONTRACT.md::Periodic alarms:
// a module that wants to be woken by an alarm must BOTH register the listener
// AND install the alarm at module.js top level, under the IS_SERVICE_WORKER
// guard.
//
// Why a source scan rather than a behavioural test: the thing that regressed is
// a CALL SITE, and it regressed twice. The 2026-08-20 sweep moved six modules'
// installs out of register(); metricshot was left behind because it lacked the
// other half of that bug (period reset), and shipped for months with an alarm
// that only came into existence when someone opened its page — so none of its
// scheduled posts ever fired unprompted. Importing each module.js to observe
// the effect needs a chrome stub wide enough to satisfy every transitive import
// in that module's service.js, which is how this check would rot.
//
// register() runs ONLY in the shell page (app.js::mountModule). The service
// worker never calls it. Anything the SW must do on boot belongs at top level.

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const MODULES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "modules");

// `scheduleCleanupAlarm()` (aurorbuddy), `installAlarms()`, `installTickAlarm()`,
// `ensureAlarm()` — one shape, several names.
const INSTALL_CALL = /\b(install|schedule|ensure)\w*Alarms?\s*\(/;

function moduleSources() {
  return readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ id: e.name, path: join(MODULES_DIR, e.name, "module.js") }))
    .filter((m) => {
      try { readFileSync(m.path, "utf8"); return true; } catch { return false; }
    })
    .map((m) => ({ ...m, src: readFileSync(m.path, "utf8") }));
}

test("every module that listens for an alarm also installs one at top level", () => {
  const listeners = moduleSources().filter((m) => m.src.includes("onAlarm.addListener"));
  assert.ok(listeners.length >= 5, "expected several alarm-driven modules; did the scan break?");

  for (const m of listeners) {
    assert.match(
      m.src,
      INSTALL_CALL,
      `${m.id}/module.js registers an alarm listener but never installs the alarm here. ` +
      `Installing from service.js::register() does not count — the service worker never calls it.`
    );
  }
});

// aurorbuddy writes `if (IS_SERVICE_WORKER && typeof chrome !== "undefined" ...)`,
// so match the opening of the condition rather than one exact spelling.
const GUARD = /if\s*\(\s*IS_SERVICE_WORKER\b/;

// Everything from the guard onwards. Prose ABOVE it does not count as wiring —
// the first draft of this test passed on metricshot's explanatory comment.
function afterGuard(src) {
  const at = src.search(GUARD);
  return at === -1 ? null : src.slice(at);
}

test("both the listener and the install sit under the IS_SERVICE_WORKER guard", () => {
  for (const m of moduleSources().filter((s) => s.src.includes("onAlarm.addListener"))) {
    const body = afterGuard(m.src);
    assert.ok(body, `${m.id}/module.js has no IS_SERVICE_WORKER guard`);

    // An ungated listener fires the handler once in the SW and once in every
    // open suite tab — two instances with separate in-flight locks, both
    // driving the same background tabs.
    assert.ok(
      body.includes("onAlarm.addListener"),
      `${m.id}/module.js registers its alarm listener before the IS_SERVICE_WORKER guard`
    );
    assert.match(
      body,
      INSTALL_CALL,
      `${m.id}/module.js installs its alarm before the IS_SERVICE_WORKER guard`
    );
  }
});

test("metricshot specifically installs its tick alarm in the worker", () => {
  // The regression this file exists for. Named so a failure reads as itself
  // rather than as "some module, somewhere".
  const body = afterGuard(readFileSync(join(MODULES_DIR, "metricshot", "module.js"), "utf8"));
  assert.ok(body, "metricshot/module.js has no IS_SERVICE_WORKER guard");
  assert.ok(
    body.includes("installTickAlarm()"),
    "metricshot/module.js must call installTickAlarm() in the service worker — " +
    "service.js::register() only ever runs in the shell page"
  );
});
