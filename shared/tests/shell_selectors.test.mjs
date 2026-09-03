// shared/tests/shell_selectors.test.mjs
//
// app.js imports `$` from shared/ui.js, which is querySelector:
//
//     export function $(sel, root = document) { return root.querySelector(sel); }
//
// So an id needs its `#`. Passing a bare id looks completely reasonable —
// several modules define their own `$` as getElementById and are written that
// way — but in app.js it silently matches nothing, and because every call site
// uses `?.` the miss is swallowed without an error.
//
// Found in the wild 2026-08-31: `$("settings-rerun-setup")` searched for a
// <settings-rerun-setup> ELEMENT. The "Run setup again" button in Settings had
// therefore never done anything, with no console error, since it was added.
//
// This scans app.js only. It deliberately does NOT scan modules/, where `$` is
// frequently a local getElementById helper and a bare id is correct.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = readFileSync(join(ROOT, "app.js"), "utf8");

test("app.js's $ is the querySelector import, not a local getElementById", () => {
  // The whole check below is void if app.js ever defines its own `$`.
  assert.match(src, /import\s*\{[^}]*\$[^}]*\}\s*from\s*"\.\/shared\/ui\.js"/,
    "app.js no longer imports $ from shared/ui.js — re-derive this test before trusting it");
  assert.doesNotMatch(src, /^\s*(const|let|function)\s+\$\s*[=(]/m,
    "app.js now defines its own $ — this test assumes the shared querySelector one");

  const ui = readFileSync(join(ROOT, "shared", "ui.js"), "utf8");
  assert.match(ui, /export function \$\([^)]*\)\s*\{\s*return root\.querySelector/,
    "shared/ui.js::$ is no longer querySelector — the # requirement may no longer hold");
});

test("no $()/$$( ) call in app.js passes a bare id where a selector is required", () => {
  // Every id the shell's own markup defines. A bare argument matching one of
  // these was meant to be "#id" — a tag selector like $("main") is left alone.
  const ids = new Set([...src.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

  const offenders = [];
  for (const m of src.matchAll(/\$\$?\(\s*"([^"]+)"/g)) {
    const sel = m[1];
    if (!/^[a-zA-Z][\w-]*$/.test(sel)) continue;   // has #, ., [ etc — fine
    if (!ids.has(sel)) continue;                    // not one of our ids — a tag selector
    const line = src.slice(0, m.index).split("\n").length;
    offenders.push(`app.js:${line} — $("${sel}") should be $("#${sel}")`);
  }

  assert.deepEqual(offenders, [],
    `querySelector was passed a bare id, so it matches nothing and the ?. hides it:\n  ` +
    offenders.join("\n  "));
});
