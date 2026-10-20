// shared/tests/identity_probe.test.mjs
//
// Pins shared/identity_probe.js — the active name lookup Door Catches uses to
// match a user against the store's AP schedule. The 2026-10-19 failure: an AP
// associate opened gscope as told, yet the suite sent no name because nothing
// read the gscope cookie until a Spark Fraud search ran.

import test from "node:test";
import assert from "node:assert/strict";

const store = new Map();
let cookieJar = {};     // url → [{ name, value }]
let tabs = [];          // [{ id, url, cookie }]
let opens = [];         // tabs.create calls
let openLandsOn = null; // what a background-opened gscope tab becomes
globalThis.chrome = {
  storage: {
    local: {
      get: async (k) => (store.has(k) ? { [k]: store.get(k) } : {}),
      set: async (o) => { for (const [k, v] of Object.entries(o)) store.set(k, v); },
      remove: async (k) => { store.delete(k); },
    },
  },
  cookies: { getAll: async ({ url }) => cookieJar[url] || [] },
  tabs: {
    query: async ({ url }) => tabs.filter((t) => t.url.startsWith(url.replace("/*", ""))),
    create: async ({ url, active }) => {
      opens.push({ url, active });
      const t = { id: 100 + opens.length, status: "complete", ...(openLandsOn || { url: "https://pfedprod.wal-mart.com/idp/SSO.saml2" }) };
      tabs.push({ ...t, opened: true });
      return { id: t.id };
    },
    get: async (id) => tabs.find((t) => t.id === id),
    remove: async (id) => { tabs = tabs.filter((t) => t.id !== id); },
  },
  scripting: {
    executeScript: async ({ target }) => {
      const t = tabs.find((x) => x.id === target.tabId);
      if (t.hang) return new Promise(() => {});
      return [{ result: { cookie: t.cookie || "", form: t.form || {} } }];
    },
  },
};

const { checkIdentity, gscopeIdentityFromCookies, looksLikePersonName } = await import("../identity_probe.js");

function reset() { store.clear(); cookieJar = {}; tabs = []; opens = []; openLandsOn = null; }

test("looksLikePersonName", () => {
  for (const ok of ["Cody J Howard", "Howard, Cody", "MERLE, MATTHEW", "Mary-Kate O'Neil"]) assert.ok(looksLikePersonName(ok), ok);
  for (const no of ["", "chowar1", "c.howard@walmart.com", "Cody", "ses008s.s01458", "Store 1458"]) assert.ok(!looksLikePersonName(no), no);
});

test("wire-id in every encoding gscope has used", () => {
  const cases = [
    [{ "wire-id": "Cody Howard - chowar1" }, "Cody Howard", "chowar1"],
    [{ "Wire-Id": "Cody%20Howard%20-%20chowar1" }, "Cody Howard", "chowar1"],
    [{ "wire-id": "Cody+Howard+-+chowar1" }, "Cody Howard", "chowar1"],
    [{ "wire-id": "Howard, Cody - chowar1" }, "Howard, Cody", "chowar1"],
    [{ "wire-id": "", displayname: "Wanda Sligh", loginid: "wsligh" }, "Wanda Sligh", "wsligh"],
    [{ "wire-id": "chowar1" }, "", ""],
  ];
  for (const [jar, name, win] of cases) {
    const got = gscopeIdentityFromCookies(jar);
    assert.equal(got.displayName, name, JSON.stringify(jar));
    if (win) assert.equal(got.win, win);
  }
  assert.equal(gscopeIdentityFromCookies({ "store-no": "01458" }).store, "1458");
});

test("reads the gscope cookie through the cookies API and records the name", async () => {
  reset();
  cookieJar["https://gscope.walmartlabs.com"] = [{ name: "wire-id", value: "Cody%20Howard%20-%20chowar1" }, { name: "store-no", value: "1458" }];
  const r = await checkIdentity();
  assert.equal(r.displayName, "Cody Howard");
  assert.equal(r.store, "1458");
  assert.ok(r.sources.find((s) => s.id === "gscope").ok);
});

test("falls back to an open gscope tab when the cookies API hides wire-id", async () => {
  reset();
  tabs = [
    { id: 1, url: "https://gscope.walmart.com/apphome", hang: true },
    { id: 2, url: "https://gscope.walmartlabs.com/x", cookie: "a=1; wire-id=Wanda%20Sligh%20-%20wsligh; store-no=1458" },
  ];
  const r = await checkIdentity();
  assert.equal(r.displayName, "Wanda Sligh");
});

test("uses the Auror sign-in name when gscope has none", async () => {
  reset();
  store.set("aurorbuddy.fb_aurorIdentity", { name: "Matthew Merle", aurorUserId: "samlp|wm-us|mmerle1.s01458" });
  const r = await checkIdentity();
  assert.equal(r.displayName, "Matthew Merle");
  assert.equal(r.win, "mmerle1.s01458");
  assert.ok(!r.sources.find((s) => s.id === "gscope").ok);
});

test("an email-ish Auror name is not a name", async () => {
  reset();
  store.set("aurorbuddy.fb_aurorIdentity", { name: "mmerle1", aurorUserId: "samlp|wm-us|mmerle1.s01458" });
  const r = await checkIdentity();
  assert.equal(r.displayName, "");
  assert.match(r.sources.find((s) => s.id === "auror").detail, /didn't give a full name/);
});

test("no gscope tab: opens one in the background, reads the name, closes it", async () => {
  reset();
  openLandsOn = { url: "https://gscope.walmartlabs.com/", cookie: "WIN=ses008s.s01458; wire-id=Shane%20Smith%20-%20ses008s.s01458; store-no=1458" };
  const r = await checkIdentity();
  assert.equal(r.displayName, "Shane Smith");
  assert.equal(opens.length, 1);
  assert.match(opens[0].url, /^https:\/\/pfedprod\.wal-mart\.com\/idp\/startSSO/);
  assert.equal(opens[0].active, false);
  assert.equal(tabs.length, 0, "background tab closed");
});

test("store-select form: reads hidden wireId without pressing Go", async () => {
  reset();
  openLandsOn = { url: "https://gscope.walmartlabs.com/api/wmstoresso", cookie: "QuantumMetricUserID=x", form: { wireId: "Shane Smith - ses008s.s01458", storeno: "1458" } };
  const r = await checkIdentity();
  assert.equal(r.displayName, "Shane Smith");
  assert.equal(r.store, "1458");
  assert.equal(tabs.length, 0);
});

test("Auror name found: no gscope tab is opened", async () => {
  reset();
  store.set("aurorbuddy.fb_aurorIdentity", { name: "Matthew Merle", aurorUserId: "samlp|wm-us|mmerle1.s01458" });
  await checkIdentity();
  assert.equal(opens.length, 0);
});

test("gscope stuck on SSO: says to sign in, tab closed", async () => {
  reset();
  const r = await checkIdentity();
  assert.equal(r.displayName, "");
  assert.deepEqual(r.sources.map((s) => s.id), ["gscope", "auror"]);
  assert.match(r.sources[0].detail, /needs you to sign in/);
  assert.equal(tabs.length, 0);
});

test("openTab: false never opens a tab", async () => {
  reset();
  const r = await checkIdentity({ openTab: false });
  assert.equal(opens.length, 0);
  assert.match(r.sources[0].detail, /no gscope sign-in/);
});
