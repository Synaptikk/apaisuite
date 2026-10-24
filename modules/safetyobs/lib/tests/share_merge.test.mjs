// shareToday's compare-and-set: two browsers sharing the same day's
// safetyObs doc, interleaved, must both survive.
// Run with: node --test modules/safetyobs/lib/tests/share_merge.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeShareEntries, casShareEntries, MAX_SHARE_ATTEMPTS } from "../share_merge.js";

/** One Firestore doc with updateTime preconditions, like setDoc({ifUpdateTime}). */
class FakeDoc {
  constructor() { this.doc = null; this.updateTime = null; this.n = 0; this.writes = 0; }
  async read() { return { doc: this.doc && structuredClone(this.doc), updateTime: this.updateTime }; }
  async write(doc, ifUpdateTime) {
    if (ifUpdateTime === null ? this.doc !== null : ifUpdateTime !== this.updateTime) {
      return { ok: false, conflict: true, errorClass: "CONFLICT", error: "precondition" };
    }
    this.doc = structuredClone(doc);
    this.updateTime = `t${++this.n}`;
    this.writes++;
    return { ok: true, updateTime: this.updateTime };
  }
}

const hist = (at, submitter) => ({ at, answers: { type: "Safe" }, submitter });

test("mergeShareEntries dedupes by id and keeps existing entries verbatim", () => {
  const existing = [{ id: "1", at: 1, type: "x", name: "Ann" }];
  const r = mergeShareEntries(existing, [hist(1, "Ann"), hist(2), hist(2)], "Me");
  assert.equal(r.added, 1);
  assert.deepEqual(r.entries, [existing[0], { id: "2", at: 2, type: "Safe", name: "Me" }]);
});

test("two interleaved writers (both read before either writes) both survive", async () => {
  const store = new FakeDoc();
  // Writer A reads, then B reads + writes, then A writes on a stale updateTime.
  let gate;
  const bDone = new Promise((r) => { gate = r; });
  let aReads = 0;
  const a = casShareEntries({
    read: async () => { const r = await store.read(); if (++aReads === 1) await bDone; return r; },
    write: (d, t) => store.write(d, t),
    pending: [hist(100, "Ann")], me: "Ann", store: "1458",
  });
  const b = casShareEntries({
    read: () => store.read(), write: (d, t) => store.write(d, t),
    pending: [hist(200, "Bob")], me: "Bob", store: "1458",
  }).then((r) => { gate(); return r; });
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.ok, true); assert.equal(rb.ok, true);
  assert.equal(ra.attempts, 2, "A lost its first precondition and retried");
  assert.deepEqual(store.doc.entries.map((e) => e.name).sort(), ["Ann", "Bob"]);
  assert.equal(store.doc.store, "1458");
});

test("an existing doc is written with its updateTime; nothing new → no write", async () => {
  const store = new FakeDoc();
  await store.write({ entries: [{ id: "5", at: 5, type: null, name: "Cy" }], store: "1458" }, null);
  const r = await casShareEntries({ read: () => store.read(), write: (d, t) => store.write(d, t), pending: [hist(5)], me: "Cy", store: "1458" });
  assert.deepEqual(r, { ok: true, written: false, attempts: 1 });
  assert.equal(store.writes, 1);
});

test("gives up after MAX attempts of constant conflict; other errors stop at once", async () => {
  let writes = 0;
  const r = await casShareEntries({
    read: async () => ({ doc: null, updateTime: null }),
    write: async () => { writes++; return { ok: false, conflict: true }; },
    pending: [hist(1)], me: "Me", store: "1458",
  });
  assert.equal(r.ok, false); assert.equal(r.conflict, true); assert.equal(writes, MAX_SHARE_ATTEMPTS);

  const e = await casShareEntries({
    read: async () => ({ doc: null, updateTime: null }),
    write: async () => ({ ok: false, error: "writer disabled" }),
    pending: [hist(1)], me: "Me", store: "1458",
  });
  assert.deepEqual(e, { ok: false, error: "writer disabled", attempts: 1 });
});
