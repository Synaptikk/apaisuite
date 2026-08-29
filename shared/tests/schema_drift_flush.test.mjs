// shared/tests/schema_drift_flush.test.mjs
//
// Pins how the schema-drift queue drains, end to end through the real
// suiteBackend client (only `fetch` and `chrome` are stubbed).
//
// The doc id for this collection is a deterministic source+fingerprint, on
// purpose: the same drift seen by five analysts should converge on ONE row,
// because what matters is that a source changed, not how many people saw it.
// But the write primitive is create-only to match the append-only rules, so
// the second install to report a drift gets ALREADY_EXISTS back.
//
// While every write was 403ing that never came up. Now that writes land, a
// duplicate is the NORMAL steady state — and treating it as a failure would
// wedge the queue permanently: the loop stops at the first error, so that one
// row would be retried and fail identically on every future flush, blocking
// every genuinely new drift queued behind it.

import test from "node:test";
import assert from "node:assert/strict";

import { flushSchemaDrift, isAlreadyExists } from "../schema_watch_report.js";

const QUEUE_KEY = "shell.schemaWatch.pending";

function installChrome(pending) {
  const local = { [QUEUE_KEY]: pending }, session = {};
  const api = (bag) => ({
    get: async (k) => {
      const out = {};
      for (const key of (Array.isArray(k) ? k : [k])) if (key in bag) out[key] = bag[key];
      return out;
    },
    set:    async (obj) => { Object.assign(bag, obj); },
    remove: async (k) => { for (const key of (Array.isArray(k) ? k : [k])) delete bag[key]; },
  });
  globalThis.chrome = {
    storage: { local: api(local), session: api(session) },
    runtime: { getURL: (p) => p, getManifest: () => ({ version: "0.0.0-test" }) },
  };
  return local;
}

// Replies to auth once, then walks `commitResults` for each :commit.
function installFetch(commitResults) {
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes(":commit")) {
      const next = commitResults.shift() ?? { ok: true };
      return {
        ok:     next.ok !== false,
        status: next.status ?? 200,
        json:   async () => ({}),
        text:   async () => next.text ?? "{}",
      };
    }
    return {
      ok: true, status: 200,
      json: async () => ({ idToken: "id-1", refreshToken: "rt-1" }),
      text: async () => "{}",
    };
  };
}

const row = (sourceId) => ({ sourceId, fingerprint: "abc123", status: "added" });
const ALREADY_EXISTS = {
  ok: false, status: 409,
  text: '{"error":{"status":"ALREADY_EXISTS","message":"document already exists"}}',
};
const DENIED = {
  ok: false, status: 403,
  text: '{"error":{"status":"PERMISSION_DENIED"}}',
};

test("a clean flush drains the whole queue", async () => {
  const local = installChrome([row("a"), row("b")]);
  installFetch([{ ok: true }, { ok: true }]);

  const out = await flushSchemaDrift();

  assert.deepEqual(out, { drained: 2, remaining: 0 });
  assert.deepEqual(local[QUEUE_KEY], []);
});

test("ALREADY_EXISTS counts as drained — it is the convergence working", async () => {
  const local = installChrome([row("a")]);
  installFetch([ALREADY_EXISTS]);

  const out = await flushSchemaDrift();

  assert.equal(out.drained, 1);
  assert.deepEqual(local[QUEUE_KEY], [], "the row must not survive to be retried");
});

test("a duplicate does not block genuinely new drift queued behind it", async () => {
  const local = installChrome([row("a"), row("b"), row("c")]);
  installFetch([ALREADY_EXISTS, { ok: true }, ALREADY_EXISTS]);

  const out = await flushSchemaDrift();

  assert.deepEqual(out, { drained: 3, remaining: 0 });
  assert.deepEqual(local[QUEUE_KEY], []);
});

test("a real failure still stops the drain and keeps the rest queued", async () => {
  const local = installChrome([row("a"), row("b"), row("c")]);
  installFetch([{ ok: true }, DENIED, { ok: true }]);

  const out = await flushSchemaDrift();

  // Stopping at the first genuine failure is deliberate: a sustained outage
  // must not burn the queue on retries that will also fail.
  assert.deepEqual(out, { drained: 1, remaining: 2 });
  assert.equal(local[QUEUE_KEY].length, 2);
  assert.equal(local[QUEUE_KEY][0].sourceId, "b");
});

test("an empty queue is a no-op", async () => {
  installChrome([]);
  installFetch([]);
  assert.deepEqual(await flushSchemaDrift(), { drained: 0, remaining: 0 });
});

test("isAlreadyExists matches the status name, not a bare code", async () => {
  assert.equal(isAlreadyExists(new Error("commit failed (409) — ALREADY_EXISTS")), true);
  assert.equal(isAlreadyExists(new Error("document already exists")), true);
  assert.equal(isAlreadyExists(new Error("commit failed (403) — PERMISSION_DENIED")), false);
  assert.equal(isAlreadyExists(new Error("network error")), false);
  assert.equal(isAlreadyExists(undefined), false);
});
