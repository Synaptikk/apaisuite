// shared/tests/tableau_lock.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { withTableauLock, tableauLockHolder } from "../tableau_lock.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("captures run one at a time, in arrival order", async () => {
  const log = [];
  const job = (name, ms) => withTableauLock(name, async () => {
    log.push(`${name}:start`);
    assert.equal(tableauLockHolder()?.label, name);
    await sleep(ms);
    log.push(`${name}:end`);
    return name;
  });
  const results = await Promise.all([job("a", 30), job("b", 10), job("c", 10)]);
  assert.deepEqual(results, ["a", "b", "c"]);
  assert.deepEqual(log, ["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  assert.equal(tableauLockHolder(), null);
});

test("a waiter is told who it is waiting on, exactly once", async () => {
  const waits = [];
  const first = withTableauLock("vizpick", async () => { await sleep(30); });
  await sleep(5);
  const second = withTableauLock("digitalmetrics", async () => "ran", { onWait: (i) => waits.push(i) });
  assert.equal(await second, "ran");
  await first;
  assert.equal(waits.length, 1);
  assert.equal(waits[0].heldBy, "vizpick");
  assert.ok(waits[0].heldMs >= 0);
});

test("a throwing capture still releases the lock", async () => {
  await assert.rejects(withTableauLock("bad", async () => { throw new Error("boom"); }), /boom/);
  assert.equal(tableauLockHolder(), null);
  assert.equal(await withTableauLock("next", async () => "ok"), "ok");
});

test("an uncontended capture never sees onWait", async () => {
  let called = 0;
  await withTableauLock("solo", async () => {}, { onWait: () => { called++; } });
  assert.equal(called, 0);
});

test("a waiter gives up after maxWaitMs and runs anyway", async () => {
  let release;
  const stuck = withTableauLock("stuck", () => new Promise((r) => { release = r; }));
  await sleep(5);
  const t0 = Date.now();
  const out = await withTableauLock("impatient", async () => "ran", { maxWaitMs: 40 });
  assert.equal(out, "ran");
  assert.ok(Date.now() - t0 >= 40);
  release();
  await stuck;
  assert.equal(tableauLockHolder(), null);
});

test("a holder past maxHoldMs is evicted so the next capture can start", async () => {
  let release;
  const leaked = withTableauLock("leaked", () => new Promise((r) => { release = r; }), { maxHoldMs: 20 });
  await sleep(30);
  const out = await withTableauLock("next", async () => tableauLockHolder()?.label, { maxHoldMs: 20 });
  assert.equal(out, "next");
  release();
  await leaked;
  assert.equal(tableauLockHolder(), null);
});
