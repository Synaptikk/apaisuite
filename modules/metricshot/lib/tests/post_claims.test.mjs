// Pure decision logic of shared/post_claims.js — what a client does with the
// claim document that beat its atomic create. Transport is not exercised here
// (it needs chrome.storage + the network); two_client.test.mjs drives the
// whole protocol against an in-memory store built on this same function.
//
// Run with: node --test modules/metricshot/lib/tests/post_claims.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { decideClaim, claimIdFor, channelKey } from "../../../../shared/post_claims.js";

const NOW = 1_000_000;

test("no existing doc → acquire", () => {
  assert.equal(decideClaim(null, NOW, "me"), "acquire");
});

test("a sent slot is never re-taken, even with an expired lease or by its owner", () => {
  assert.equal(decideClaim({ state: "sent", owner: "a", leaseUntil: 0 }, NOW, "b"), "sent");
  assert.equal(decideClaim({ state: "sent", owner: "me", leaseUntil: 0 }, NOW, "me"), "sent");
});

test("another install's live lease → held", () => {
  assert.equal(decideClaim({ state: "sending", owner: "a", leaseUntil: NOW + 1 }, NOW, "b"), "held");
  assert.equal(decideClaim({ state: "failed", owner: "a", leaseUntil: NOW + 1 }, NOW, "b"), "held");
});

test("an expired lease (crashed or failed owner) → takeover", () => {
  assert.equal(decideClaim({ state: "sending", owner: "a", leaseUntil: NOW - 1 }, NOW, "b"), "takeover");
  assert.equal(decideClaim({ state: "failed", owner: "a", leaseUntil: NOW - 1 }, NOW, "b"), "takeover");
  assert.equal(decideClaim({ state: "sending", owner: "a" }, NOW, "b"), "takeover", "missing lease counts as expired");
});

test("our own unfinished claim → takeover (our retry after our own failure / SW death)", () => {
  assert.equal(decideClaim({ state: "sending", owner: "me", leaseUntil: NOW + 60_000 }, NOW, "me"), "takeover");
  assert.equal(decideClaim({ state: "failed", owner: "me", leaseUntil: NOW + 60_000 }, NOW, "me"), "takeover");
});

test("claim ids are deterministic, safe for a Firestore path, and channel-case-insensitive", () => {
  const a = claimIdFor({ store: "1458", kind: "metricshot:closing-list-daily", slot: "2026-10-24:10:00", channel: " 1458 Leadership " });
  const b = claimIdFor({ store: "1458", kind: "metricshot:closing-list-daily", slot: "2026-10-24:10:00", channel: "1458 leadership" });
  assert.equal(a, b);
  assert.match(a, /^[A-Za-z0-9_.:~-]+$/);
  assert.ok(!a.includes("/"));
  assert.equal(channelKey("  A B "), "a b");
});

test("distinct slots, stores, kinds and channels never share an id", () => {
  const base = { store: "1458", kind: "k", slot: "2026-10-24:10:00", channel: "c" };
  const ids = new Set([
    claimIdFor(base),
    claimIdFor({ ...base, store: "1459" }),
    claimIdFor({ ...base, kind: "k2" }),
    claimIdFor({ ...base, slot: "2026-10-24:16:45" }),
    claimIdFor({ ...base, channel: "d" }),
    // Escaping is reversible: "a b" and "a_b" stay distinct.
    claimIdFor({ ...base, channel: "a b" }),
    claimIdFor({ ...base, channel: "a_b" }),
    claimIdFor({ ...base, channel: "a/b" }),
  ]);
  assert.equal(ids.size, 8);
});
