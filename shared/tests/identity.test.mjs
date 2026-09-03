// shared/tests/identity.test.mjs
//
// Pins shared/identity.js — the multi-source home-store resolver.
//
// The bug this replaces: the home store came only from a manual override or
// AurorBuddy's cached Auror JWT, so anyone using another module was
// permanently unidentified and their usage rows carried an empty store
// forever. What matters here is therefore not "does it parse a WIN" but the
// merge rules — which source wins, and what a lower-ranked source is
// forbidden from doing to a better answer.

import test from "node:test";
import assert from "node:assert/strict";

// chrome.storage.local stub. Installed before importing the module under test
// because identity.js reads chrome lazily but the import must not throw.
const store = new Map();
globalThis.chrome = {
  storage: {
    local: {
      get: async (k) => (store.has(k) ? { [k]: store.get(k) } : {}),
      set: async (o) => { for (const [k, v] of Object.entries(o)) store.set(k, v); },
      remove: async (k) => { store.delete(k); },
    },
  },
};

const {
  observeIdentity, getIdentity, clearIdentity, observeIdentityFromJwt,
  winFromUpn, winFromAurorSub, storeFromWin, parseWireId, upnFromJwt,
  SOURCE_RANK,
} = await import("../identity.js");

const reset = async () => { store.clear(); };

// Build an unsigned JWT with the given payload — the decoder does not verify.
const jwt = (payload) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
};

// ── Parsing ─────────────────────────────────────────────────────────────

test("a UPN yields the WIN and the hire store", () => {
  assert.equal(winFromUpn("ses008s.s01458@us.wal-mart.com"), "ses008s.s01458");
  assert.equal(storeFromWin("ses008s.s01458"), "1458");
});

test("the store drops leading zeros, because store ids carry none", () => {
  // MEMORY.md::Claims Disposition store IDs — 669, never 0669.
  assert.equal(storeFromWin("abc.s00669"), "669");
  assert.equal(storeFromWin("abc.s0669"), "669");
});

test("an Auror sub is unwrapped, and a bare WIN passes through", () => {
  assert.equal(winFromAurorSub("samlp|wm-us|ses008s.s01458"), "ses008s.s01458");
  assert.equal(winFromAurorSub("ses008s.s01458"), "ses008s.s01458");
});

test("nothing parseable yields empty, never a guessed default", () => {
  // The whole point of returning null/"" is that callers show "set your store"
  // instead of quietly defaulting to somebody else's.
  assert.equal(storeFromWin("nostorehere"), "");
  assert.equal(storeFromWin(""), "");
  assert.equal(winFromUpn(""), "");
  assert.equal(upnFromJwt("not-a-jwt"), "");
  assert.equal(upnFromJwt(""), "");
});

test("wire-id splits into display name and WIN", () => {
  assert.deepEqual(parseWireId("Shane Smith - ses008s.s01458"),
    { displayName: "Shane Smith", win: "ses008s.s01458" });
});

// ── JWT decoding ────────────────────────────────────────────────────────

test("standard UPN claims are read, in preference order", () => {
  assert.equal(upnFromJwt(jwt({ upn: "a.s01458@us.wal-mart.com" })), "a.s01458@us.wal-mart.com");
  assert.equal(upnFromJwt(jwt({ unique_name: "b.s00669@us.wal-mart.com" })), "b.s00669@us.wal-mart.com");
  assert.equal(upnFromJwt(jwt({ preferred_username: "c.s0123@us.wal-mart.com" })), "c.s0123@us.wal-mart.com");
});

test("a Power BI MWCToken is decoded through its embedded JSON string", () => {
  // workloadClaims is a STRING, not an object — verified against a live token
  // captured 2026-08-29. Handling only the object form would silently miss it.
  const token = "MWCToken " + jwt({
    workloadClaims: JSON.stringify({ qes: { user: "ses008s.s01458@us.wal-mart.com" } }),
  });
  assert.equal(upnFromJwt(token), "ses008s.s01458@us.wal-mart.com");
});

test("the Bearer/MWCToken scheme prefix is tolerated", () => {
  const payload = { upn: "x.s01458@us.wal-mart.com" };
  assert.equal(upnFromJwt("Bearer " + jwt(payload)), "x.s01458@us.wal-mart.com");
  assert.equal(upnFromJwt(jwt(payload)), "x.s01458@us.wal-mart.com");
});

test("a claim without an @ is not mistaken for a UPN", () => {
  assert.equal(upnFromJwt(jwt({ unique_name: "ses008s" })), "");
});

// ── Merge rules — the part that actually matters ────────────────────────

test("a UPN-only observation still resolves a store", async () => {
  await reset();
  await observeIdentity({ source: "powerbi_token", upn: "ses008s.s01458@us.wal-mart.com" });
  const id = await getIdentity();
  assert.equal(id.store, "1458");
  assert.equal(id.win, "ses008s.s01458");
  assert.equal(id.storeSource, "powerbi_token");
});

test("the gscope SESSION store outranks any WIN-derived hire store", async () => {
  await reset();
  // Someone hired at 1458 who now works at 669. The WIN says 1458 forever.
  await observeIdentity({ source: "auror_jwt", win: "ses008s.s01458" });
  assert.equal((await getIdentity()).store, "1458");
  await observeIdentity({ source: "gscope_session", store: "669" });
  const id = await getIdentity();
  assert.equal(id.store, "669", "the session store must win — it is where they work now");
  assert.equal(id.storeSource, "gscope_session");
});

test("a weaker source cannot overwrite a stronger one", async () => {
  await reset();
  await observeIdentity({ source: "gscope_session", store: "669" });
  await observeIdentity({ source: "auror_jwt", win: "ses008s.s01458" });
  const id = await getIdentity();
  assert.equal(id.store, "669", "auror_jwt must not clobber the session store");
  // ...but it may still contribute the field the better source lacked.
  assert.equal(id.win, "ses008s.s01458");
  assert.equal(id.winSource, "auror_jwt");
});

test("merging is PER FIELD, so a partial source fills gaps without damage", async () => {
  await reset();
  await observeIdentity({ source: "gscope_session", store: "669", displayName: "Shane Smith" });
  await observeIdentity({ source: "powerbi_token", upn: "ses008s.s01458@us.wal-mart.com" });
  const id = await getIdentity();
  assert.equal(id.store, "669");            // kept — higher rank
  assert.equal(id.displayName, "Shane Smith");
  assert.equal(id.upn, "ses008s.s01458@us.wal-mart.com"); // gained — nobody else had it
});

test("the same source may update its own value — people transfer", async () => {
  await reset();
  await observeIdentity({ source: "gscope_session", store: "669" });
  await observeIdentity({ source: "gscope_session", store: "1458" });
  assert.equal((await getIdentity()).store, "1458",
    "a repeat observation must refresh, not pin the first value seen forever");
});

test("empty fields are ignored rather than erasing what is known", async () => {
  await reset();
  await observeIdentity({ source: "gscope_session", store: "669" });
  await observeIdentity({ source: "manual", store: "" , win: ""});
  assert.equal((await getIdentity()).store, "669");
});

test("an unknown source is rejected loudly", async () => {
  await reset();
  await assert.rejects(() => observeIdentity({ source: "guesswork", store: "1" }), /Unknown identity source/);
});

test("manual outranks everything, including the session store", async () => {
  await reset();
  await observeIdentity({ source: "gscope_session", store: "669" });
  await observeIdentity({ source: "manual", store: "1458" });
  assert.equal((await getIdentity()).store, "1458", "nothing may override a human");
});

test("the ranking puts the session store above every derived source", () => {
  const derived = ["profile_email", "powerbi_token", "auror_jwt", "workvivo"];
  for (const s of derived) {
    assert.ok(SOURCE_RANK.gscope_session > SOURCE_RANK[s],
      `gscope_session must outrank ${s} — it is the only non-hire-store source`);
  }
  assert.ok(SOURCE_RANK.manual > SOURCE_RANK.gscope_session);
});

test("observeIdentityFromJwt is a no-op on a token with no UPN", async () => {
  await reset();
  assert.equal(await observeIdentityFromJwt("powerbi_token", jwt({ sub: "nope" })), null);
  assert.deepEqual(await getIdentity(), {});
});

test("a no-op observation does not churn updatedAt", async () => {
  await reset();
  await observeIdentity({ source: "gscope_session", store: "669" });
  const first = (await getIdentity()).updatedAt;
  await observeIdentity({ source: "gscope_session", store: "669" });
  assert.equal((await getIdentity()).updatedAt, first,
    "this runs on a hot path; an unchanged observation must not write");
});

test("clearIdentity empties the record", async () => {
  await reset();
  await observeIdentity({ source: "manual", store: "1458" });
  await clearIdentity();
  assert.deepEqual(await getIdentity(), {});
});
