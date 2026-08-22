// shared/tests/sw_keepalive.test.mjs
//
// Run with: node --test shared/tests/sw_keepalive.test.mjs
//
// Refcounting is the whole risk here. Get it wrong in one direction and two
// overlapping captures each stop the other's keep-alive, reintroducing exactly
// the bug this exists to fix; wrong in the other and a leaked handle pins the
// service worker awake for the rest of the browser session.

import { test } from "node:test";
import assert from "node:assert/strict";

function installChromeStub() {
  const calls = { pings: 0 };
  globalThis.chrome = {
    runtime: {
      lastError: undefined,
      getPlatformInfo: (cb) => { calls.pings++; cb?.({ os: "win" }); },
    },
  };
  return calls;
}

const load = () => import(`../sw_keepalive.js?t=${process.hrtime.bigint()}`);

test("pings immediately, so a job shorter than one interval still counts", async () => {
  const calls = installChromeStub();
  const { keepAwake } = await load();
  const release = keepAwake("job");
  assert.equal(calls.pings, 1, "waiting a full interval would let a short job be collected");
  release();
});

test("overlapping jobs share one timer; the LAST release stops it", async () => {
  installChromeStub();
  const { keepAwake, _internals } = await load();

  const a = keepAwake("a");
  const b = keepAwake("b");
  assert.deepEqual(_internals.state(), { holders: 2, running: true, labels: ["a", "b"] });

  a();
  assert.equal(_internals.state().running, true, "b is still working — must stay awake");
  assert.equal(_internals.state().holders, 1);

  b();
  assert.equal(_internals.state().running, false);
  assert.equal(_internals.state().holders, 0);
});

test("release is idempotent — a double release cannot free someone else's hold", async () => {
  installChromeStub();
  const { keepAwake, _internals } = await load();
  const a = keepAwake("a");
  const b = keepAwake("b");
  a(); a(); a();
  assert.equal(_internals.state().holders, 1, "b's hold must survive a's over-release");
  assert.equal(_internals.state().running, true);
  b();
  assert.equal(_internals.state().running, false);
});

test("withKeepAwake releases even when the job throws", async () => {
  installChromeStub();
  const { withKeepAwake, _internals } = await load();
  await assert.rejects(withKeepAwake("boom", async () => { throw new Error("nope"); }));
  assert.equal(_internals.state().running, false, "an error path must not leak the hold");
});

test("withKeepAwake returns the job's value", async () => {
  installChromeStub();
  const { withKeepAwake } = await load();
  assert.equal(await withKeepAwake("j", async () => 42), 42);
});

test("no-ops safely where the API does not exist", async () => {
  // Extension pages have no idle timeout, so callers can share code across
  // contexts without branching.
  globalThis.chrome = { runtime: {} };
  const { keepAwake, _internals } = await load();
  const release = keepAwake("page");
  assert.equal(_internals.state().running, false);
  release();   // must not throw
});

test("survives the API throwing mid-flight", async () => {
  installChromeStub();
  const { keepAwake } = await load();
  chrome.runtime.getPlatformInfo = () => { throw new Error("worker going away"); };
  // The ping fires on acquire; a throw there must not propagate into the job.
  const release = keepAwake("j");
  release();
});
