// Morning catch-up: two browsers at one store, one shared claim store, one
// channel → exactly one post. Manual "Post now" bypasses the claim.
// Run with: node --test modules/safetyobs/lib/tests/catchup_post.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { postCatchUpOnce, catchUpMarker, CLAIM_KIND } from "../catchup_post.js";
import { decideClaim, claimIdFor } from "../../../../shared/post_claims.js";

/** In-memory postClaims with the real decideClaim (same as metricshot's two_client test). */
class FakeClaims {
  constructor() { this.docs = new Map(); this.down = false; }
  deps(owner, now) {
    return {
      claimPostSlot: async (spec) => {
        if (this.down) return { ok: false, error: "network" };
        const id = claimIdFor(spec);
        const cur = this.docs.get(id);
        const d = decideClaim(cur, now(), owner);
        if (d === "sent" || d === "held") return { ok: true, state: d, claimId: id, owner: cur.owner };
        this.docs.set(id, { owner, state: "sending", leaseUntil: now() + 600_000 });
        return { ok: true, state: "acquired", claimId: id, owner, takenOver: d === "takeover" || undefined };
      },
      completePostSlot: async (id, { messageId }) => { Object.assign(this.docs.get(id), { state: "sent", messageId }); return { ok: true }; },
      failPostSlot: async (id, { releaseLease = true } = {}) => {
        const c = this.docs.get(id); c.state = "failed"; if (releaseLease) c.leaseUntil = now(); return { ok: true };
      },
    };
  }
}
class FakeChannel {
  constructor() { this.msgs = []; }
  send(marker, { fail } = {}) {
    return async () => {
      if (fail === "definitive") return { ok: false, errorClass: "REST_FAIL", error: "post 403" };
      this.msgs.push({ marker, messageId: String(this.msgs.length + 1) });
      if (fail === "unknown") return { ok: false, errorClass: "POST_HUNG", error: "watchdog" };
      return { ok: true, messageId: String(this.msgs.length) };
    };
  }
  find = async ({ marker }) => {
    const m = this.msgs.find((x) => x.marker === marker);
    return m ? { ok: true, found: true, messageId: m.messageId } : { ok: true, found: false };
  };
}

const spec = { store: "1458", kind: CLAIM_KIND, slot: "2026-10-24", channel: "1458 management" };
const marker = catchUpMarker("1458", "2026-10-24");
function run(claims, ch, owner, { manual = false, fail, now = () => 1000 } = {}) {
  return postCatchUpOnce({
    manual, claimSpec: spec, channelName: spec.channel, marker, sinceTs: 0,
    send: ch.send(marker, { fail }),
    deps: { ...claims.deps(owner, now), findPostedMarker: ch.find },
  });
}

test("two browsers at 9:00 → one post, the other skips", async () => {
  const claims = new FakeClaims(), ch = new FakeChannel();
  const [a, b] = await Promise.all([run(claims, ch, "A"), run(claims, ch, "B")]);
  assert.equal(ch.msgs.length, 1);
  assert.deepEqual([a.outcome, b.outcome].sort(), ["sent", "skipped-claimed"]);
  const later = await run(claims, ch, "B");
  assert.equal(later.outcome, "skipped-claimed"); assert.equal(later.state, "sent");
});

test("claim service down → fail closed, nothing posted", async () => {
  const claims = new FakeClaims(), ch = new FakeChannel();
  claims.down = true;
  const r = await run(claims, ch, "A");
  assert.equal(r.outcome, "claim-failed"); assert.equal(r.posted, false); assert.equal(ch.msgs.length, 0);
});

test("manual Post now bypasses the claim but sends the marker", async () => {
  const claims = new FakeClaims(), ch = new FakeChannel();
  claims.down = true;
  const r = await run(claims, ch, "A", { manual: true });
  assert.equal(r.outcome, "sent"); assert.equal(ch.msgs[0].marker, marker);
});

test("unknown outcome that actually landed is recovered by read-back", async () => {
  const claims = new FakeClaims(), ch = new FakeChannel();
  const r = await run(claims, ch, "A", { fail: "unknown" });
  assert.equal(r.outcome, "recovered"); assert.equal(r.posted, true);
  assert.equal([...claims.docs.values()][0].state, "sent");
});

test("definitive failure releases the lease so another browser can post", async () => {
  const claims = new FakeClaims(), ch = new FakeChannel();
  let t = 1000;
  const a = await run(claims, ch, "A", { fail: "definitive", now: () => t });
  assert.equal(a.outcome, "failed");
  t += 1;
  const b = await run(claims, ch, "B", { now: () => t });
  assert.equal(b.outcome, "sent"); assert.equal(ch.msgs.length, 1);
});

test("takeover of a dead lease reads back first and does not re-post", async () => {
  const claims = new FakeClaims(), ch = new FakeChannel();
  let t = 1000;
  // A posted but died before completing the claim.
  await claims.deps("A", () => t).claimPostSlot(spec);
  ch.msgs.push({ marker, messageId: "9" });
  t += 700_000;                                   // lease expired
  const b = await run(claims, ch, "B", { now: () => t });
  assert.equal(b.outcome, "recovered"); assert.equal(ch.msgs.length, 1);
});
