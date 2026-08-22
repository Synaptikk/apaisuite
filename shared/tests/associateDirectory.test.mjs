// shared/tests/associateDirectory.test.mjs
//
// The load-bearing claim of shared/associateDirectory.js is that a record can
// be kept forever without going stale, because tenure is stored as a hire date
// and recomputed on read. These tests pin that, plus the merge rules that stop
// one source blanking another's fields.

import test from "node:test";
import assert from "node:assert/strict";

// Minimal chrome.storage.local stub. The module only uses get/set/remove.
const store = new Map();
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        if (keys == null) return Object.fromEntries(store);
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of list) if (store.has(k)) out[k] = store.get(k);
        return out;
      },
      async set(obj) { for (const [k, v] of Object.entries(obj)) store.set(k, v); },
      async remove(keys) {
        for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k);
      },
    },
  },
};

const D = await import("../associateDirectory.js");

const DAY = 86_400_000;
const T0  = Date.UTC(2026, 7, 22);   // 2026-08-22, fixed so tests don't drift

test.beforeEach(() => store.clear());

test("parses Workday's length-of-service strings", () => {
  // The exact string Workday renders, parens and all.
  assert.equal(D.parseLengthOfService("13 year(s), 4 month(s), 4 day(s)"), 4874);
  assert.equal(D.parseLengthOfService("7 months"), 213);
  assert.equal(D.parseLengthOfService("14 days"), 14);
  assert.equal(D.parseLengthOfService("nothing numeric"), null);
  assert.equal(D.parseLengthOfService(null), null);
});

test("a duration round-trips through a hire date back to itself", () => {
  const days = D.parseLengthOfService("13 year(s), 4 month(s), 4 day(s)");
  const hire = D.hireDateFromTenureDays(days, T0);
  assert.equal(D.tenureDaysFor({ hireDateApprox: hire }, T0), days);
});

test("stored tenure grows with time instead of freezing — the whole point", async () => {
  await D.merge("ses008s", { lengthOfService: "13 year(s), 4 month(s), 4 day(s)" }, T0);
  const rec = await D.get("ses008s");

  assert.equal(D.tenureDaysFor(rec, T0), 4874);
  // Read the same untouched record a year later.
  assert.equal(D.tenureDaysFor(rec, T0 + 365 * DAY), 4874 + 365);
  assert.equal(D.tenureLabelFor(rec, T0), "13y 4m");
});

test("hits are permanent and misses are not", async () => {
  await D.merge("ses008s", { name: "Shane Smith" }, T0);
  assert.equal(await D.isKnown("ses008s"), true);

  await D.markMiss("nobody1", T0);
  assert.equal(await D.isRecentMiss("nobody1", T0 + 60_000), true);
  assert.equal(await D.isRecentMiss("nobody1", T0 + 2 * 3600_000), false);
});

test("resolving a WIN clears any recorded miss for it", async () => {
  await D.markMiss("ses008s", T0);
  await D.merge("ses008s", { name: "Shane Smith" }, T0);
  assert.equal(await D.isRecentMiss("ses008s", T0 + 60_000), false);
});

test("merge never blanks a known field with a null from another source", async () => {
  // Workday resolves name + tenure; Workvivo later resolves only a name.
  await D.merge("ses008s", {
    name: "Shane Smith", title: "AP Operations Coach",
    lengthOfService: "13 year(s), 4 month(s), 4 day(s)",
    sources: { name: "workday", tenure: "workday" },
  }, T0);

  const after = await D.merge("ses008s", {
    name: "Shane Smith", title: null, store: undefined,
    sources: { name: "workvivo" },
  }, T0 + DAY);

  assert.equal(after.title, "AP Operations Coach");
  assert.equal(D.tenureDaysFor(after, T0), 4874);
  assert.equal(after.sources.tenure, "workday");
  assert.equal(after.sources.name, "workvivo");
  assert.equal(after.firstSeenAt, T0, "first sighting is preserved across merges");
});

test("the hire date is set once and not re-derived on later sightings", async () => {
  await D.merge("ses008s", { lengthOfService: "13 year(s), 4 month(s), 4 day(s)" }, T0);
  const first = (await D.get("ses008s")).hireDateApprox;

  // A year later Workday reports the grown figure; the stored date must not move.
  await D.merge("ses008s", { lengthOfService: "14 year(s), 4 month(s), 4 day(s)" }, T0 + 365 * DAY);
  assert.equal((await D.get("ses008s")).hireDateApprox, first);
});

test("forget() drops a record so a transfer can be re-pulled", async () => {
  await D.merge("ses008s", { name: "Shane Smith" }, T0);
  await D.forget("ses008s");
  assert.equal(await D.isKnown("ses008s"), false);
});

test("WINs are matched case- and whitespace-insensitively", async () => {
  await D.merge("  SES008S ", { name: "Shane Smith" }, T0);
  assert.equal((await D.get("ses008s"))?.name, "Shane Smith");
  assert.equal(await D.isKnown("SES008S"), true);
});

test("getMany returns only the WINs it knows, in one read", async () => {
  await D.merge("aaa", { name: "A" }, T0);
  await D.merge("bbb", { name: "B" }, T0);
  const got = await D.getMany(["aaa", "bbb", "ccc", "aaa"]);
  assert.deepEqual([...got.keys()].sort(), ["aaa", "bbb"]);
});

test("listAll excludes miss markers", async () => {
  await D.merge("aaa", { name: "A" }, T0);
  await D.markMiss("zzz", T0);
  const all = await D.listAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].win, "aaa");
});
