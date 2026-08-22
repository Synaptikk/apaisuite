// shared/tests/debug_feed.test.mjs
//
// Run with: node --test shared/tests/debug_feed.test.mjs
//
// Three things here are easy to get wrong and invisible when they are:
//   · the feed must not double-print an event that arrives down both pipes;
//   · it must never print anything credential-shaped, because a debug panel
//     is precisely what gets screenshotted into a bug report;
//   · its onMessage listener must not return true, which would claim the
//     message and break the real sender's reply.

import { test } from "node:test";
import assert from "node:assert/strict";

function installChromeStub() {
  const local = new Map();
  const msgListeners = new Set();
  const changeListeners = new Set();
  globalThis.chrome = {
    storage: {
      local: {
        get: async (k) => (local.has(k) ? { [k]: local.get(k) } : {}),
        set: async (o) => { for (const [k, v] of Object.entries(o)) local.set(k, v); },
      },
      onChanged: {
        addListener: (f) => changeListeners.add(f),
        removeListener: (f) => changeListeners.delete(f),
      },
    },
    runtime: {
      onMessage: {
        addListener: (f) => msgListeners.add(f),
        removeListener: (f) => msgListeners.delete(f),
      },
    },
    alarms: { getAll: async () => [] },
  };
  return { local, msgListeners, changeListeners };
}

const load = () => import(`../debug_feed.js?t=${process.hrtime.bigint()}`);

test("redact strips credential-shaped keys at any depth", async () => {
  const { redact } = await load();
  const out = redact({
    store: "1458",
    authToken: "Bearer abc.def",
    nested: { cookie: "x=1", jwt: "e30.", safe: 5 },
    list: [{ apiKey: "k" }, { ok: 1 }],
  });
  assert.equal(out.store, "1458");
  assert.equal(out.authToken, "<redacted>");
  assert.equal(out.nested.cookie, "<redacted>");
  assert.equal(out.nested.jwt, "<redacted>");
  assert.equal(out.nested.safe, 5);
  assert.equal(out.list[0].apiKey, "<redacted>");
  assert.equal(out.list[1].ok, 1);
});

test("backfills from the telemetry ring so the panel opens populated", async () => {
  const { local } = installChromeStub();
  local.set("shell.telemetry", [
    { module: "vizpick", event: "capture_start", ts: 1000, payload: { store: "1" } },
    { module: "vizpick", event: "capture_done",  ts: 2000, payload: {} },
  ]);
  const { startDebugFeed } = await load();
  const got = [];
  await startDebugFeed({ onEvents: (e) => got.push(...e) });
  assert.equal(got.length, 2);
  assert.deepEqual(got.map((e) => e.event), ["capture_start", "capture_done"]);
  assert.equal(got[0].source, "sw");
});

test("an event arriving down BOTH pipes is printed once", async () => {
  const { local, changeListeners } = installChromeStub();
  local.set("shell.telemetry", []);
  const { startDebugFeed } = await load();
  const got = [];
  await startDebugFeed({ onEvents: (e) => got.push(...e) });

  const row = { module: "vizpick", event: "source_complete", ts: 5000, payload: { ok: true } };
  for (const f of changeListeners) f({ "shell.telemetry": { newValue: [row] } }, "local");
  for (const f of changeListeners) f({ "shell.telemetry": { newValue: [row] } }, "local");

  assert.equal(got.length, 1, "the same ring entry must not print twice on re-flush");
});

test("live broadcasts are captured, and redacted on the way in", async () => {
  const { local, msgListeners } = installChromeStub();
  local.set("shell.telemetry", []);
  const { startDebugFeed } = await load();
  const got = [];
  await startDebugFeed({ onEvents: (e) => got.push(...e) });

  for (const f of msgListeners) f({ module: "aurorbuddy", type: "auth_ok", authToken: "Bearer zzz", n: 3 });
  assert.equal(got.length, 1);
  assert.equal(got[0].module, "aurorbuddy");
  assert.equal(got[0].event, "auth_ok");
  assert.equal(got[0].detail.authToken, "<redacted>");
  assert.equal(got[0].detail.n, 3);
  assert.equal(got[0].source, "msg");
});

test("the onMessage listener never claims the message", async () => {
  const { local, msgListeners } = installChromeStub();
  local.set("shell.telemetry", []);
  const { startDebugFeed } = await load();
  await startDebugFeed({ onEvents: () => {} });
  // Returning true would tell Chrome this listener will reply asynchronously,
  // swallowing the response the real handler owes its caller.
  for (const f of msgListeners) {
    assert.notEqual(f({ module: "vizpick", type: "x" }), true);
    assert.notEqual(f({ module: "vizpick" }), true);   // no `type` -> ignored
    assert.notEqual(f(null), true);
  }
});

test("stop() removes both listeners", async () => {
  const { local, msgListeners, changeListeners } = installChromeStub();
  local.set("shell.telemetry", []);
  const { startDebugFeed } = await load();
  const feed = await startDebugFeed({ onEvents: () => {} });
  assert.equal(msgListeners.size, 1);
  assert.equal(changeListeners.size, 1);
  feed.stop();
  assert.equal(msgListeners.size, 0, "a surviving listener keeps the detached page alive");
  assert.equal(changeListeners.size, 0);
});

test("pause suppresses delivery but the feed keeps de-duplicating", async () => {
  const { local, msgListeners } = installChromeStub();
  local.set("shell.telemetry", []);
  const { startDebugFeed } = await load();
  const got = [];
  const feed = await startDebugFeed({ onEvents: (e) => got.push(...e) });

  feed.setPaused(true);
  for (const f of msgListeners) f({ module: "m", type: "a" });
  assert.equal(got.length, 0);

  feed.setPaused(false);
  for (const f of msgListeners) f({ module: "m", type: "b" });
  assert.equal(got.length, 1);
  assert.equal(got[0].event, "b");
});

test("unlock state round-trips and defaults to locked", async () => {
  installChromeStub();
  const { isDebugUnlocked, setDebugUnlocked } = await load();
  assert.equal(await isDebugUnlocked(), false, "hidden by default");
  await setDebugUnlocked(true);
  assert.equal(await isDebugUnlocked(), true);
  await setDebugUnlocked(false);
  assert.equal(await isDebugUnlocked(), false);
});
