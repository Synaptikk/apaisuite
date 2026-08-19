// shared/tests/usage_metrics.test.mjs
//
// Run with: node --test shared/tests/usage_metrics.test.mjs
//
// The point of these tests is the pseudonymity guarantee. The row shape is the
// privacy promise made on the listing and in the policy, so "no name or email
// ever reaches this collection" is asserted rather than assumed.

import { test } from "node:test";
import assert from "node:assert/strict";

const sync = new Map();
const local = new Map();
const writes = [];
let failNextWrites = 0;

globalThis.chrome = {
  runtime: { getManifest: () => ({ version: "0.9.3" }) },
  storage: {
    sync:  { get: async (k) => (sync.has(k) ? { [k]: sync.get(k) } : {}),
             set: async (o) => { for (const [k, v] of Object.entries(o)) sync.set(k, v); },
             remove: async (k) => { sync.delete(k); } },
    local: { get: async (k) => (local.has(k) ? { [k]: local.get(k) } : {}),
             set: async (o) => { for (const [k, v] of Object.entries(o)) local.set(k, v); },
             remove: async (k) => { local.delete(k); } },
    onChanged: { addListener() {}, removeListener() {} },
  },
};
// node:24 exposes navigator as a getter-only global, so it has to be replaced
// rather than assigned.
function setUserAgent(ua) {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: ua }, configurable: true, writable: true,
  });
}
setUserAgent("Mozilla/5.0 (Macintosh) Chrome/151.0.0.0 Safari/537.36");

// buildUsageRow is pure and the queue helpers only touch chrome.storage, so
// nothing here reaches Firestore or the network. The write path itself is not
// covered — it needs a live Firebase project, and stubbing an ESM import
// binding to fake one would test the stub rather than the code.
const UM = await import("../usage_metrics.js");

test("row carries store, market and role — and never a name or email", async () => {
  sync.set("apai.userHomeStoreOverride", "1458");
  sync.set("apai.userHomeMarket", "120");
  sync.set("apai.userRole", "salary");

  const row = await UM.buildUsageRow({ moduleName: "vizpick", actionName: "module_opened" });

  assert.equal(row.storeNumber, "1458");
  assert.equal(row.marketNumber, "120");
  assert.equal(row.role, "salary");
  assert.equal(row.moduleName, "vizpick");
  assert.equal(row.actionName, "module_opened");
  assert.equal(row.toolVersion, "0.9.3");
  assert.equal(row.browser, "Chrome/151");
  assert.ok(row.installationId.length >= 32, "a random installation id identifies the install, not the person");

  const serialised = JSON.stringify(row).toLowerCase();
  for (const forbidden of ["email", "aurorusername", "auroruseremail", "wid", "@"]) {
    assert.ok(!serialised.includes(forbidden), `row must not contain ${forbidden}`);
  }
});

test("installation id is stable across calls", async () => {
  const a = await UM.buildUsageRow({ moduleName: "m", actionName: "a" });
  const b = await UM.buildUsageRow({ moduleName: "m", actionName: "a" });
  assert.equal(a.installationId, b.installationId);
});

test("unset store, market and role degrade to empty strings, not undefined", async () => {
  sync.clear();
  const row = await UM.buildUsageRow({ moduleName: "m", actionName: "a" });
  assert.equal(row.storeNumber, "");
  assert.equal(row.marketNumber, "");
  assert.equal(row.role, "");
  // Firestore rejects undefined; empty string is the only safe absence here.
  for (const v of Object.values(row)) assert.notEqual(v, undefined);
});

test("contextHint is scrubbed and capped", () => {
  const { scrub, CONTEXT_CAP } = UM._internals;
  assert.equal(scrub("store=1458"), "store=1458");
  assert.ok(scrub("mailto shane@example.com now").includes("[email]"));
  assert.ok(scrub("card 4111111111111111").includes("[card]"));
  assert.ok(scrub("Bearer abc.def-ghi").includes("[token]"));
  assert.equal(scrub("x".repeat(500)).length, CONTEXT_CAP);
});

test("durationMs is rounded, or null when not a number", async () => {
  const a = await UM.buildUsageRow({ moduleName: "m", actionName: "a", durationMs: 12.7 });
  assert.equal(a.durationMs, 13);
  const b = await UM.buildUsageRow({ moduleName: "m", actionName: "a" });
  assert.equal(b.durationMs, null);
  const c = await UM.buildUsageRow({ moduleName: "m", actionName: "a", durationMs: "nope" });
  assert.equal(c.durationMs, null);
});

test("browser slug maps Edg to Edge and tolerates an unknown agent", () => {
  const { browserSlug } = UM._internals;
  setUserAgent("Mozilla/5.0 Edg/151.0.0.0");
  assert.equal(browserSlug(), "Edge/151");
  setUserAgent("something else entirely");
  assert.equal(browserSlug(), "");
  setUserAgent("Mozilla/5.0 Chrome/151.0.0.0");
});

test("queue is bounded so a long outage cannot fill storage", async () => {
  const { QUEUE_KEY, MAX_QUEUE } = UM._internals;
  local.set(QUEUE_KEY, Array.from({ length: MAX_QUEUE + 50 }, (_, i) => ({ n: i })));
  // flushUsageQueue writes the remainder back through the same cap.
  await UM.flushUsageQueue().catch(() => {});
  const after = local.get(QUEUE_KEY) || [];
  assert.ok(after.length <= MAX_QUEUE, `queue capped at ${MAX_QUEUE}, got ${after.length}`);
});
