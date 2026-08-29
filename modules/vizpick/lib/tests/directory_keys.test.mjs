// modules/vizpick/lib/tests/directory_keys.test.mjs
//
// Pins the WIN key discipline in the Associates view.
//
// shared/associateDirectory.js keys every record by normalizeWin(win) — trimmed
// and LOWER-CASED — so getMany() hands back lower-cased keys. The Tableau
// location-details export passes the scanner's WIN through verbatim
// (parse_vizpick_stores_csv.js: `String(c[iWin]).trim()`), and those are not
// guaranteed to be lower case.
//
// While view.js read its mount-local `directory` map with the raw export value,
// any WIN carrying upper case resolved SUCCESSFULLY and then rendered as an id
// anyway — the name was sitting in the map under a key nobody asked for. Worse,
// the "is this one resolved?" test used the same raw key, so the WIN also looked
// permanently unresolved to the retry logic and to the on-card explanation.
//
// A source scan rather than a behavioural test for the same reason
// shared/tests/alarm_install_sites.test.mjs is one: the thing that can regress
// is a CALL SITE inside mount()'s closure, which is not importable without a
// DOM. What must hold is that every read goes through dirGet().

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeWin } from "../../../../shared/associateDirectory.js";

const VIEW = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "view.js");
const src = readFileSync(VIEW, "utf8");

/** Source lines that are not comments — comments legitimately name the trap. */
function codeLines(text) {
  return text.split("\n")
    .map((line, i) => ({ n: i + 1, line }))
    .filter(({ line }) => {
      const t = line.trim();
      return t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    });
}

test("every read of the mount-local directory goes through dirGet()", () => {
  const offenders = codeLines(src)
    .filter(({ line }) => /\bdirectory\.get\s*\(/.test(line))
    // The one legal occurrence is dirGet's own body.
    .filter(({ line }) => !/return\s+directory\.get\(normalizeWin\(/.test(line));
  assert.deepEqual(
    offenders.map((o) => `${o.n}: ${o.line.trim()}`),
    [],
    "raw-key directory.get() found — use dirGet(win), which normalizes the WIN",
  );
});

test("dirGet normalizes the WIN before reading", () => {
  assert.match(src, /function dirGet\(win\)\s*\{\s*\n\s*return directory\.get\(normalizeWin\(win\)\);/);
});

test("the WIN set collected for resolution is normalized", () => {
  // If these go in raw, `attempted` and `missing` end up keyed differently from
  // the map they are compared against, and the whole retry gate misfires.
  assert.match(src, /wins\.add\(normalizeWin\(a\.win\)\)/);
});

test("normalizeWin actually lower-cases — the premise the above rests on", () => {
  assert.equal(normalizeWin("SES008S"), "ses008s");
  assert.equal(normalizeWin(" Ses008s "), "ses008s");
  assert.equal(normalizeWin("ses008s"), "ses008s");
});

test("a transient pass is not banked as attempted", () => {
  // Marking a WIN "tried" after Workvivo was merely unreachable is what made one
  // bad pass permanent for the life of the mount. The guard must remain.
  assert.match(src, /passWasTransient/);
  assert.match(src, /if \(passWasTransient\)/);
});

test("a completed capture clears the attempted set", () => {
  // The "reload fires, names update" path. Without it, ids that failed to
  // resolve on the first paint stay ids however many refreshes land behind them.
  const idx = src.indexOf(`host.messaging.on("source_complete"`);
  assert.ok(idx > 0, "source_complete subscription not found");
  const block = src.slice(idx, idx + 300);
  assert.match(block, /attempted\.clear\(\)/);
});
