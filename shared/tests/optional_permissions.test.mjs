// shared/tests/optional_permissions.test.mjs
//
// Pins the contract between scripts/pack-cws.sh and the modules whose
// permissions it strips for the Chrome Web Store build.
//
// `debugger` is dropped from the store package: it is the most heavily
// scrutinised permission a manifest can ask for, and only sparkfraud wants it
// (CDP visibility spoof + SSO click, working around a Walmart Edge MDM policy
// that only affects managed machines — which run the self-hosted build).
//
// Why a source scan rather than a behavioural test: the failure this pins is
// catastrophic and silent to develop against. `chrome.debugger.onDetach` sat at
// sparkfraud/service.js top level, so dropping the permission would have thrown
// during service-worker registration and taken EVERY module down — the suite
// simply would not start, with nothing pointing at sparkfraud. You only see it
// by loading the store build, which nobody does while developing. Importing
// service.js here instead would need a chrome stub wide enough for every
// transitive import, which is how a check like this rots.

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODULES_DIR = join(ROOT, "modules");

/** Every .js under modules/, skipping vendored and generated trees. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "vendor" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry.endsWith(".js")) out.push(p);
  }
  return out;
}

// Strip line and block comments so a comment ABOUT chrome.debugger — of which
// there are several, describing code that has since been removed — is not read
// as a use of it.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const files = walk(MODULES_DIR);

test("only sparkfraud uses chrome.debugger", () => {
  const users = files
    .filter((f) => /\bchrome\.debugger\b/.test(stripComments(readFileSync(f, "utf8"))))
    .map((f) => relative(ROOT, f).replace(/\\/g, "/"));

  assert.deepEqual(users, ["modules/sparkfraud/service.js"],
    "a second module started using chrome.debugger — either guard it the same " +
    "way sparkfraud does, or stop dropping the permission in pack-cws.sh");
});

test("sparkfraud survives the permission being absent", () => {
  const src = readFileSync(join(MODULES_DIR, "sparkfraud", "service.js"), "utf8");

  assert.match(src, /const HAS_DEBUGGER\s*=/,
    "sparkfraud/service.js must define HAS_DEBUGGER");

  // The listener is the only top-level use, and top level is what kills the
  // whole service worker. It must sit inside the guard.
  assert.match(src, /if\s*\(HAS_DEBUGGER\)\s*\{[\s\S]*?chrome\.debugger\.onDetach/,
    "chrome.debugger.onDetach must be registered inside `if (HAS_DEBUGGER)` — " +
    "unguarded it throws at module load and takes every module down with it");

  assert.match(src, /_spoofVisibility[\s\S]{0,200}?if\s*\(!HAS_DEBUGGER\)/,
    "_spoofVisibility must bail before touching chrome.debugger");
});

test("pack-cws.sh still drops the permission it is guarded for", () => {
  const sh = readFileSync(join(ROOT, "scripts", "pack-cws.sh"), "utf8");
  assert.match(sh, /DROP_PERMISSIONS=\([^)]*\bdebugger\b[^)]*\)/,
    "pack-cws.sh must drop `debugger` from the store manifest; if that stopped " +
    "being true, the guards above are dead code and the store build carries " +
    "the riskiest permission in the package");
});

test("the manifest still declares debugger for the self-hosted build", () => {
  const m = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  assert.ok(m.permissions.includes("debugger"),
    "the checked-in manifest is the SELF-HOSTED build and keeps `debugger` — " +
    "pack-cws.sh removes it from a staged copy, and errors if it is missing");
});
