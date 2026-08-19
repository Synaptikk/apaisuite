// shared/tests/userStore.test.mjs
//
// Covers the home-market and role halves of shared/userStore.js.
// Run with: node --test shared/tests/userStore.test.mjs
//
// The market functions existed as imports in modules/vizpick/view.js long
// before they existed as exports, which made the whole VizPick view fail to
// load with "does not provide an export named 'getUserHomeMarket'". The last
// test in this file is there to catch that specific regression: a named
// export vanishing is invisible to a syntax check.

import { test } from "node:test";
import assert from "node:assert/strict";

// Minimal chrome.storage double. Only sync is exercised here; onChanged
// dispatches synchronously, which is enough to assert subscribe/unsubscribe.
function installChromeStub() {
  const sync = new Map();
  const listeners = new Set();
  globalThis.chrome = {
    storage: {
      sync: {
        get: async (key) => (sync.has(key) ? { [key]: sync.get(key) } : {}),
        set: async (obj) => {
          for (const [k, v] of Object.entries(obj)) {
            const oldValue = sync.get(k);
            sync.set(k, v);
            for (const fn of listeners) fn({ [k]: { oldValue, newValue: v } }, "sync");
          }
        },
        remove: async (key) => {
          const oldValue = sync.get(key);
          sync.delete(key);
          for (const fn of listeners) fn({ [key]: { oldValue, newValue: undefined } }, "sync");
        },
      },
      local: { get: async () => ({}) },
      onChanged: {
        addListener: (fn) => listeners.add(fn),
        removeListener: (fn) => listeners.delete(fn),
      },
    },
  };
  return { sync, listeners };
}

installChromeStub();

const US = await import("../userStore.js");

test("market round-trips and clears", async () => {
  assert.equal(await US.getUserHomeMarket(), null);
  await US.setUserHomeMarket("120");
  assert.equal(await US.getUserHomeMarket(), "120");
  await US.clearUserHomeMarket();
  assert.equal(await US.getUserHomeMarket(), null);
});

test("market is stored un-normalised", async () => {
  // VizPick compares this with === against the Market column of the export,
  // so stripping the leading zero here would stop "0120" ever matching.
  await US.setUserHomeMarket("0120");
  assert.equal(await US.getUserHomeMarket(), "0120");
  await US.clearUserHomeMarket();
});

test("market rejects junk", async () => {
  await assert.rejects(() => US.setUserHomeMarket(""));
  await assert.rejects(() => US.setUserHomeMarket("12 34"));
  await assert.rejects(() => US.setUserHomeMarket("toolongvalue"));
});

test("onUserMarketChange fires, and stops after unsubscribe", async () => {
  const seen = [];
  const off = US.onUserMarketChange((m) => seen.push(m));

  await US.setUserHomeMarket("77");
  assert.deepEqual(seen, ["77"]);

  await US.clearUserHomeMarket();
  assert.deepEqual(seen, ["77", null], "clearing reports null, not empty string");

  off();
  await US.setUserHomeMarket("99");
  assert.equal(seen.length, 2, "no further calls after unsubscribe");
  await US.clearUserHomeMarket();
});

test("role round-trips, normalises case, rejects unknown values", async () => {
  assert.equal(await US.getUserRole(), null);
  await US.setUserRole("Market");
  assert.equal(await US.getUserRole(), "market", "stored lowercase so gating compares reliably");

  await assert.rejects(() => US.setUserRole("manager"));
  await assert.rejects(() => US.setUserRole(""));

  await US.clearUserRole();
  assert.equal(await US.getUserRole(), null);
});

test("USER_ROLES is the three declared roles and is frozen", () => {
  assert.deepEqual(US.USER_ROLES.map((r) => r.value), ["market", "salary", "hourly"]);
  assert.ok(Object.isFrozen(US.USER_ROLES));
  for (const r of US.USER_ROLES) assert.ok(r.label && r.hint, "each role needs a label and hint");
});

test("onUserRoleChange fires, and stops after unsubscribe", async () => {
  const seen = [];
  const off = US.onUserRoleChange((r) => seen.push(r));
  await US.setUserRole("hourly");
  await US.clearUserRole();
  off();
  await US.setUserRole("salary");
  assert.deepEqual(seen, ["hourly", null]);
  await US.clearUserRole();
});

test("market role hides the home-header strip; every other state shows it", () => {
  assert.equal(US.isHomeHeaderAllowedForRole("market"), false);
  assert.equal(US.isHomeHeaderAllowedForRole("Market"), false, "case must not defeat the gate");
  assert.equal(US.isHomeHeaderAllowedForRole("salary"), true);
  assert.equal(US.isHomeHeaderAllowedForRole("hourly"), true);
  // An unset role must not hide anything — the shell calls this synchronously
  // while the role is still loading, and blanking the UI on a slow storage
  // read would look like a broken home page.
  assert.equal(US.isHomeHeaderAllowedForRole(null), true);
  assert.equal(US.isHomeHeaderAllowedForRole(undefined), true);
  assert.equal(US.isHomeHeaderAllowedForRole(""), true);
});

test("every name modules import from userStore.js is exported", () => {
  // Kept in sync by hand with the import sites; see the file header for why.
  for (const name of [
    "getUserHomeStore", "setUserHomeStoreOverride", "clearUserHomeStoreOverride",
    "extractWidFromAurorSub", "extractStoreFromWid", "OVERRIDE_KEY",
    "getUserHomeMarket", "setUserHomeMarket", "clearUserHomeMarket", "onUserMarketChange",
    "getUserRole", "setUserRole", "clearUserRole", "onUserRoleChange", "USER_ROLES",
    "isHomeHeaderAllowedForRole", "isValidRole", "MARKET_KEY", "ROLE_KEY",
  ]) {
    assert.ok(name in US, `missing export: ${name}`);
  }
});
