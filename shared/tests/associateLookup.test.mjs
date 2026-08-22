// shared/tests/associateLookup.test.mjs
//
// Run with: node --test shared/tests/associateLookup.test.mjs
//
// Covers the "have we already asked Workday?" gate. This is the expensive
// decision in the whole lookup: a wrong `true` means a background tab and a
// DOM scrape, per associate, on every repaint — and the first version of this
// got it wrong in exactly that direction.

import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } } };
const { needsWorkdayLookup, lookupDiagnostics, diffLookupDiagnostics } =
  await import("../associateLookup.js");

test("an unknown WIN is looked up", () => {
  assert.equal(needsWorkdayLookup(null), true);
  assert.equal(needsWorkdayLookup(undefined), true);
});

test("a record with a title is never looked up again", () => {
  assert.equal(needsWorkdayLookup({ win: "x", title: "Stocking Team Associate" }), false);
});

test("a Workday visit that returned NO title is not repeated", () => {
  // The regression. Workday does not have a title for everyone, and merge()
  // clears the miss key whenever it stores anything — so gating on `title`
  // meant re-scraping every titleless associate on every single repaint,
  // forever, for a field that was never going to arrive.
  assert.equal(needsWorkdayLookup({
    win: "x", name: "A. Associate", hireDateApprox: "2021-04-02",
    sources: { name: "workday", tenure: "workday" },
  }), false);

  // Even with no hire date derived, the source stamp alone proves we asked.
  assert.equal(needsWorkdayLookup({
    win: "x", name: "A. Associate", sources: { tenure: "workday" },
  }), false);
});

test("a name resolved by Workvivo still needs Workday for the title", () => {
  // Workvivo returns a name and nothing else, so this WIN has never been asked
  // the title question. This is the case that must still cost a lookup.
  assert.equal(needsWorkdayLookup({
    win: "x", name: "A. Associate", sources: { name: "workvivo" },
  }), true);
});

test("a hire date alone counts as having asked", () => {
  // Only Workday produces this, so its presence is evidence of the visit.
  assert.equal(needsWorkdayLookup({ win: "x", hireDateApprox: "2019-01-01" }), false);
});

test("an empty record is looked up", () => {
  assert.equal(needsWorkdayLookup({ win: "x" }), true);
  assert.equal(needsWorkdayLookup({ win: "x", sources: {} }), true);
});

// ── Resolution diagnostics ────────────────────────────────────────────────
//
// The Associates view renders a bare WIN whenever resolution fails, and for
// two days that was indistinguishable from the feature being broken. These
// counters are what lets the card say WHICH failure it was, so they need to
// survive a refactor that "tidies up" the unused-looking fields.

test("a snapshot carries every counter the caller branches on", () => {
  const d = lookupDiagnostics();
  for (const k of ["attempts", "resolved", "definitiveMiss", "transient", "cachedMiss"]) {
    assert.equal(typeof d[k], "number", `missing counter: ${k}`);
  }
});

test("a snapshot is a copy, not a live handle on the counters", () => {
  // The caller holds `before` across an await. If it aliased the real object,
  // every diff would come out zero and the note would never appear.
  const a = lookupDiagnostics();
  a.attempts = 999;
  assert.notEqual(lookupDiagnostics().attempts, 999);
});

test("the diff is per-pass, not the process total", () => {
  const before = { attempts: 10, resolved: 8, definitiveMiss: 1, transient: 1, cachedMiss: 4 };
  const after  = { attempts: 13, resolved: 8, definitiveMiss: 2, transient: 3, cachedMiss: 4 };
  const d = diffLookupDiagnostics(before, after);
  assert.deepEqual(d.attempts, 3);
  assert.deepEqual(d.resolved, 0);
  assert.deepEqual(d.transient, 2);
  assert.deepEqual(d.cachedMiss, 0);
});

test("the diff distinguishes the three causes the note branches on", () => {
  const zero = { attempts: 0, resolved: 0, definitiveMiss: 0, transient: 0, cachedMiss: 0 };

  // Workvivo unreachable: attempts made, all of them failed outright.
  const unreachable = diffLookupDiagnostics(zero, { ...zero, attempts: 5, transient: 5 });
  assert.ok(unreachable.transient > 0);

  // Backing off: nothing was even attempted, because misses are still standing.
  const backoff = diffLookupDiagnostics(zero, { ...zero, cachedMiss: 5 });
  assert.equal(backoff.attempts, 0);
  assert.ok(backoff.cachedMiss > 0);

  // Genuinely not in Workvivo: asked, got a definitive "no".
  const absent = diffLookupDiagnostics(zero, { ...zero, attempts: 5, definitiveMiss: 5 });
  assert.equal(absent.transient, 0);
  assert.ok(absent.definitiveMiss > 0);
});

test("a missing baseline is treated as zero, not NaN", () => {
  // First pass after mount has nothing to diff against.
  const d = diffLookupDiagnostics(null, { attempts: 2, resolved: 2 });
  assert.equal(d.attempts, 2);
  assert.equal(d.cachedMiss, 0);
  assert.ok(Object.values(d).every((v) => typeof v !== "number" || Number.isFinite(v)));
});

// ── Name casing ───────────────────────────────────────────────────────────
//
// Workvivo returns some names ALL CAPS and others all lowercase. A list
// showing both reads as broken even though every name in it is correct.

const { titleCaseName } = await import("../associateDirectory.js");

test("fixes the two cases the source actually produces", () => {
  assert.equal(titleCaseName("JOHN SMITH"), "John Smith");
  assert.equal(titleCaseName("jane doe"), "Jane Doe");
});

test("leaves an already-mixed-case name ALONE", () => {
  // The source's own capitalisation is more likely correct than anything this
  // function would reconstruct. Mangling "McDonald" into "Mcdonald" would be a
  // regression dressed up as a fix.
  for (const name of ["McDonald", "van der Berg", "DeSoto", "O'Brien-Smith"]) {
    assert.equal(titleCaseName(name), name);
  }
});

test("capitalises after internal punctuation", () => {
  assert.equal(titleCaseName("mary ann o'brien"), "Mary Ann O'Brien");
  assert.equal(titleCaseName("SMITH-JONES"), "Smith-Jones");
});

test("keeps generational suffixes uppercase", () => {
  assert.equal(titleCaseName("JOSE GARCIA III"), "Jose Garcia III");
});

test("collapses stray whitespace", () => {
  assert.equal(titleCaseName("  MARY   ANN  "), "Mary Ann");
});

test("is idempotent — applied on both write and read", () => {
  for (const name of ["JOHN SMITH", "jane doe", "McDonald", ""]) {
    assert.equal(titleCaseName(titleCaseName(name)), titleCaseName(name));
  }
});

test("tolerates null and non-strings", () => {
  for (const bad of [null, undefined, 42, {}]) {
    assert.equal(typeof titleCaseName(bad), "string");
  }
});

// ── "has a record" is not "has a name" ────────────────────────────────────
//
// The bug this pins: the Associates view gated its resolver on whether
// getMany() returned anything for a WIN. digitallocks writes title/tenure
// records with NO name for anyone a reviewer opened in Workday, so every
// associate the other tools had already touched looked "known", skipped the
// Workvivo lookup entirely, and rendered as a bare id. It presented as one
// store being broken — the home store, the only one with prior tool usage —
// and it survived reloads, because the nameless record is in local storage.

const { hasName } = await import("../associateDirectory.js");

test("a record with title/tenure but NO name does not count as resolved", () => {
  // Exactly what digitallocks' Workday scrape leaves behind.
  assert.equal(hasName({ win: "aaa111a", title: "Stocking Team Associate" }), false);
  assert.equal(hasName({ win: "aaa111a", hireDateApprox: "2021-04-02", sources: { tenure: "workday" } }), false);
});

test("an empty or whitespace name does not count as resolved", () => {
  // presentable() can hand back name:"" rather than dropping the key.
  for (const bad of ["", "   ", "\t"]) {
    assert.equal(hasName({ win: "x", name: bad }), false);
  }
});

test("a real name counts", () => {
  assert.equal(hasName({ win: "x", name: "Jane Doe" }), true);
});

test("absent, null and non-record inputs count as unresolved", () => {
  for (const bad of [null, undefined, {}, "Jane Doe", 42]) {
    assert.equal(hasName(bad), false);
  }
});
