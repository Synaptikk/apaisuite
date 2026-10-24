// Two installs at one store, one Workvivo channel, one shared claim store.
//
// Adapted from the 2026-10-24 review's two_client_sim.mjs, which proved that
// two installs both posted "closing-list-daily" to "1458 Leadership", that a
// worker death between send and record re-sent, and that a watchdog-classified
// failure re-sent after backoff. Each client here runs the REAL scheduler,
// retry policy and post_guard protocol; only the transport is faked:
//   • FakeClaims  — in-memory postClaims with the same atomic create /
//                   updateTime-precondition semantics as shared/post_claims.js,
//                   deciding conflicts with its real decideClaim().
//   • FakeChannel — counts messages; read-back finds them by marker.
//
// Run with: node --test modules/metricshot/lib/tests/two_client.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { expandDueRuns } from "../scheduler.js";
import { runDecision, failureEntry } from "../retry_policy.js";
import { beginGuardedRun, readBack, guardedPost, finishGuardedRun, slotOf, markerFor } from "../post_guard.js";
import { decideClaim, claimIdFor, channelKey } from "../../../../shared/post_claims.js";

const MIN = 60_000;
const STORE = "1458";
const CHANNEL = "1458 Leadership";
const metric = {
  id: "closing-list-daily", enabled: true, timezone: "America/New_York",
  schedules: [{ days: ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"], time: "10:00" }],
  capture: { catchUpWindowMs: 2 * 60 * MIN },
  destination: { channelName: CHANNEL },
};
// Tuesday 2026-10-20 10:00:30 EDT.
const T0 = Date.parse("2026-10-20T14:00:30Z");

class Clock { constructor(t) { this.t = t; } now() { return this.t; } }

class FakeClaims {
  constructor(clock) { this.clock = clock; this.docs = new Map(); this.down = false; }
  async claim(self, { store, kind, slot, channel, leaseMs = 10 * MIN }) {
    if (this.down) return { ok: false, error: "unreachable" };
    const claimId = claimIdFor({ store, kind, slot, channel });
    const now = this.clock.now();
    const doc = { owner: self, state: "sending", at: now, leaseUntil: now + leaseMs, messageId: null, kind, store, slot, channel: channelKey(channel) };
    const cur = this.docs.get(claimId);
    if (!cur) { this.docs.set(claimId, { data: doc, v: 1 }); return { ok: true, state: "acquired", claimId, owner: self }; }
    const d = decideClaim(cur.data, now, self);
    if (d === "sent") return { ok: true, state: "sent", claimId, owner: cur.data.owner };
    if (d === "held") return { ok: true, state: "held", claimId, owner: cur.data.owner };
    this.docs.set(claimId, { data: doc, v: cur.v + 1 });
    return { ok: true, state: "acquired", claimId, owner: self, takenOver: true };
  }
  async complete(claimId, { messageId }) {
    const cur = this.docs.get(claimId);
    cur.data = { ...cur.data, state: "sent", messageId, at: this.clock.now() }; cur.v++;
  }
  async fail(claimId, { releaseLease = true } = {}) {
    const cur = this.docs.get(claimId);
    cur.data = { ...cur.data, state: "failed", at: this.clock.now(), ...(releaseLease ? { leaseUntil: this.clock.now() } : {}) }; cur.v++;
  }
}

class FakeChannel {
  constructor() { this.messages = []; }
  add(from, marker) { this.messages.push({ from, marker, messageId: String(this.messages.length + 1) }); return String(this.messages.length); }
  async find({ marker }) {
    const m = this.messages.find((x) => x.marker === marker);
    return m ? { ok: true, found: true, messageId: m.messageId } : { ok: true, found: false };
  }
}

/**
 * One install. Mirrors service.js::tick → _runOne's guard/post/record order
 * (capture elided). `behave` decides what the next send does:
 *   "ok"            posts and returns ok
 *   "crash"         posts, then the worker dies before anything is recorded
 *   "hung-landed"   posts, but the watchdog resolves POST_HUNG first
 *   "hung-late"     returns POST_HUNG; the message lands only after read-back
 */
function makeClient(name, { clock, claims, channel }) {
  const local = {};
  const self = { name, local, behave: "ok", late: [] };
  const deps = {
    markLocal: async (k, e) => { local[k] = e; },
    claimPostSlot: (spec) => claims.claim(name, spec),
    completePostSlot: (id, o) => claims.complete(id, o),
    failPostSlot: (id, o) => claims.fail(id, o),
    findPostedMarker: (q) => channel.find(q),
  };
  self.tick = async () => {
    const now = clock.now();
    for (const run of expandDueRuns(metric, now)) {
      if (!runDecision(local[run.runKey], now).run) continue;
      if (run.stale) { local[run.runKey] = { status: "skipped-stale", at: now }; continue; }
      const runKey = run.runKey;
      const prior = local[runKey];
      const marker = markerFor(runKey, STORE);
      const spec = { store: STORE, kind: `metricshot:${metric.id}`, slot: slotOf(metric.id, runKey), channel: CHANNEL, leaseMs: 10 * MIN };
      const g = await beginGuardedRun({ runKey, prior, claimSpec: spec, claimId: claimIdFor(spec), now, deps });
      if (!g.proceed) {
        if (g.outcome === "claim-failed") local[runKey] = failureEntry(local[runKey], now, { stage: "claim", error: g.error });
        return g.outcome;
      }
      if (g.needReadBack) {
        const rb = await readBack({ channelName: CHANNEL, marker, sinceTs: run.scheduledAt, deps });
        if (rb.found) {
          local[runKey] = { status: "ok", at: now, messageId: rb.messageId, recovered: true };
          await finishGuardedRun({ claimId: g.claimId, ok: true, messageId: rb.messageId, deps });
          return "recovered";
        }
      }
      const mode = self.behave;
      let crashed = false;
      const post = await guardedPost({
        channelName: CHANNEL, marker, sinceTs: run.scheduledAt, deps,
        send: async () => {
          if (mode === "hung-late") { self.late.push(marker); return { ok: false, errorClass: "POST_HUNG", error: "post hung > 120s" }; }
          const id = channel.add(name, marker);
          if (mode === "crash") { crashed = true; return { ok: true, messageId: id }; }
          if (mode === "hung-landed") return { ok: false, errorClass: "POST_HUNG", error: "post hung > 120s" };
          return { ok: true, messageId: id };
        },
      });
      if (crashed) return "crashed";   // worker died: nothing after the send ran
      if (post.ok) {
        local[runKey] = { status: "ok", at: now, messageId: post.messageId, recovered: post.recovered };
        await finishGuardedRun({ claimId: g.claimId, ok: true, messageId: post.messageId, deps });
        return post.recovered ? "recovered" : "posted";
      }
      local[runKey] = { ...failureEntry(local[runKey], now, { stage: "post", error: post.error }), ...(post.unknownOutcome ? { unknownOutcome: true } : {}) };
      await finishGuardedRun({ claimId: g.claimId, ok: false, error: post.error, unknownOutcome: !!post.unknownOutcome, deps });
      return "failed";
    }
    return "idle";
  };
  /** The hung upload finishes in the background. */
  self.landLate = () => { for (const m of self.late.splice(0)) channel.add(name, m); };
  return self;
}

function world() {
  const clock = new Clock(T0);
  const claims = new FakeClaims(clock);
  const channel = new FakeChannel();
  const mk = (n) => makeClient(n, { clock, claims, channel });
  return { clock, claims, channel, a: mk("install-A"), b: mk("install-B") };
}

test("two installs, same slot, unaligned alarms → exactly one message", async () => {
  const { clock, channel, a, b } = world();
  assert.equal(await a.tick(), "posted");
  clock.t += 20_000;
  assert.equal(await b.tick(), "skipped-claimed");
  for (let i = 0; i < 10; i++) { clock.t += MIN; await a.tick(); await b.tick(); }
  assert.equal(channel.messages.length, 1);
  assert.equal(Object.values(b.local)[0].status, "skipped-claimed");
});

test("two installs ticking concurrently → exactly one message", async () => {
  const { channel, a, b } = world();
  const outcomes = await Promise.all([a.tick(), b.tick()]);
  assert.deepEqual(outcomes.sort(), ["posted", "skipped-claimed"]);
  assert.equal(channel.messages.length, 1);
});

test("worker dies after the send, before the record → the resume reads back, one message", async () => {
  const { clock, channel, a, b } = world();
  a.behave = "crash";
  assert.equal(await a.tick(), "crashed");
  a.behave = "ok";
  // Minutes 1–14: the local "sending" entry says in-flight; B sees a live lease.
  for (let i = 0; i < 14; i++) { clock.t += MIN; assert.equal(await a.tick(), "idle"); await b.tick(); }
  assert.equal(channel.messages.length, 1);
  clock.t += 2 * MIN;                         // 16 min: stale "sending" → resume
  assert.equal(await a.tick(), "recovered");
  assert.equal(channel.messages.length, 1);
  assert.equal(Object.values(a.local)[0].status, "ok");
});

test("crashed owner never comes back → the other install takes over, reads back, one message", async () => {
  const { clock, channel, b, a } = world();
  a.behave = "crash";
  await a.tick();
  clock.t += 11 * MIN;                        // past the 10-min lease
  assert.equal(await b.tick(), "recovered");
  assert.equal(channel.messages.length, 1);
});

test("watchdog fires but the upload had landed → read-back turns it into success, one message", async () => {
  const { clock, channel, a, b } = world();
  a.behave = "hung-landed";
  assert.equal(await a.tick(), "recovered");
  for (let i = 0; i < 60; i++) { clock.t += MIN; a.behave = "ok"; await a.tick(); await b.tick(); }
  assert.equal(channel.messages.length, 1);
});

test("watchdog fires and the upload lands AFTER the read-back → lease kept, retry reads back, one message", async () => {
  const { clock, channel, a, b } = world();
  a.behave = "hung-late";
  assert.equal(await a.tick(), "failed");
  a.landLate();                               // the hung upload completes in the background
  a.behave = "ok";
  for (let i = 0; i < 60; i++) { clock.t += MIN; await a.tick(); await b.tick(); }
  assert.equal(channel.messages.length, 1);
  assert.equal(Object.values(a.local)[0].status, "ok");
});

test("claim service down → nobody posts (fail closed); it posts once when it comes back", async () => {
  const { clock, claims, channel, a, b } = world();
  claims.down = true;
  assert.equal(await a.tick(), "claim-failed");
  assert.equal(await b.tick(), "claim-failed");
  assert.equal(channel.messages.length, 0);
  claims.down = false;
  for (let i = 0; i < 60; i++) { clock.t += MIN; await a.tick(); await b.tick(); }
  assert.equal(channel.messages.length, 1);
});
