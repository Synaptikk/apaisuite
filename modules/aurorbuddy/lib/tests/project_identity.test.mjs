// modules/aurorbuddy/lib/tests/project_identity.test.mjs
//
// Pins the cutover guard in lib/firestore.js.
//
// Firebase anonymous identities are per PROJECT, so moving this module from
// the standalone `aurorbuddy` project onto a named database inside `apaisuite`
// invalidates every credential cached in chrome.storage. Two things break at
// once if nothing notices:
//
//   · getIdToken() hands the OLD refresh token to the NEW project's API key,
//     gets a 400, and (before the fallback) threw — auth wedged permanently.
//   · getUid() returns the OLD uid, commonRowFields() stamps it as analystUid,
//     and the rules compare that to request.auth.uid — so every write 403s as
//     not-yours, on a token that is itself perfectly valid.
//
// The subtle half is the BACK-FILL. Installs predating the marker have no
// stored project value, and reading that as "belongs to nothing" would wipe a
// good credential on every existing install, mint a new uid, and orphan that
// analyst's tool_metrics/{uid} doc — causing the exact damage the guard exists
// to prevent. Absent must mean "the project this module has always used".

import test from "node:test";
import assert from "node:assert/strict";

const K = {
  refresh: "aurorbuddy.fb_refreshToken",
  uid:     "aurorbuddy.fb_uid",
  metrics: "aurorbuddy.fb_metricsInitialized",
  project: "aurorbuddy.fb_project",
  pending: "aurorbuddy.fb_pendingWrites",
  idTok:   "aurorbuddy.fb_idToken",
};

function installChrome(local = {}, session = {}) {
  const api = (bag) => ({
    get: async (k) => {
      const out = {};
      for (const key of (Array.isArray(k) ? k : [k])) if (key in bag) out[key] = bag[key];
      return out;
    },
    set:    async (o) => { Object.assign(bag, o); },
    remove: async (k) => { for (const key of (Array.isArray(k) ? k : [k])) delete bag[key]; },
  });
  globalThis.chrome = {
    storage: { local: api(local), session: api(session), sync: api({}) },
    runtime: { getManifest: () => ({ version: "0.0.0-test" }) },
    alarms:  { get: async () => null, create: () => {} },
  };
  return { local, session };
}

// The guard reads projectId at module scope, so each case needs a fresh module
// with the config stubbed. Cache-bust and re-stub per test.
async function loadWith(projectId, local, session) {
  installChrome(local, session);
  const mod = await import(`../firestore.js?p=${projectId}&t=${Math.random()}`);
  return mod;
}

// firestore_config.js is a static import, so the project is whatever ships.
// These tests therefore exercise the guard against the CURRENT configured
// project — which is the case that matters: they fail the day someone flips
// the switch without the guard being right.
const { FIREBASE_CONFIG } = await import("../firestore_config.js");
const CURRENT = FIREBASE_CONFIG.projectId;
const OTHER   = CURRENT === "aurorbuddy" ? "apaisuite" : "aurorbuddy";

test("a marker matching the configured project changes nothing", async () => {
  const local = { [K.project]: CURRENT, [K.refresh]: "rt", [K.uid]: "u1", [K.metrics]: true };
  const { ensureProjectIdentity } = await loadWith(CURRENT, local, {});

  const out = await ensureProjectIdentity();

  assert.equal(out.changed, false);
  assert.equal(local[K.refresh], "rt", "a matching project must not disturb credentials");
  assert.equal(local[K.uid], "u1");
});

test("a marker from a DIFFERENT project clears the cached identity", async () => {
  const local   = { [K.project]: OTHER, [K.refresh]: "rt-old", [K.uid]: "u-old", [K.metrics]: true };
  const session = { [K.idTok]: "id-old" };
  const { ensureProjectIdentity } = await loadWith(CURRENT, local, session);

  const out = await ensureProjectIdentity();

  assert.equal(out.changed, true);
  assert.equal(out.from, OTHER);
  assert.equal(out.to, CURRENT);
  assert.equal(local[K.refresh], undefined, "old-realm refresh token must go");
  assert.equal(local[K.uid],     undefined, "old uid would 403 every write as not-yours");
  assert.equal(local[K.metrics], undefined, "new project has no tool_metrics doc yet");
  assert.equal(session[K.idTok], undefined);
  assert.equal(local[K.project], CURRENT, "marker is re-stamped");
});

test("a missing marker is back-filled, NOT treated as a project change", async () => {
  // The pre-guard install: credentials belong to the original project.
  const local = { [K.refresh]: "rt", [K.uid]: "u1" };
  const { ensureProjectIdentity } = await loadWith("aurorbuddy", local, {});

  const out = await ensureProjectIdentity();

  if (CURRENT === "aurorbuddy") {
    assert.equal(out.changed, false, "an existing install must not be reset by the guard's arrival");
    assert.equal(local[K.refresh], "rt");
    assert.equal(local[K.uid], "u1", "clearing this would orphan tool_metrics/{uid}");
    assert.equal(local[K.project], "aurorbuddy", "and the assumption is stamped so it is made only once");
  } else {
    // Post-cutover: absent means the legacy project, which is now a change.
    assert.equal(out.changed, true);
    assert.equal(out.from, "aurorbuddy");
    assert.equal(local[K.refresh], undefined);
  }
});

test("the retry queue survives a project change", async () => {
  const local = {
    [K.project]: OTHER,
    [K.refresh]: "rt-old",
    [K.pending]: [{ kind: "event", payload: { a: 1 } }],
  };
  const { ensureProjectIdentity } = await loadWith(CURRENT, local, {});

  await ensureProjectIdentity();

  // Queued items hold the raw payload; dispatch() rebuilds each row through
  // commonRowFields() at flush time, so they pick up the NEW uid by themselves.
  // Dropping them here would discard real writes for no reason.
  assert.deepEqual(local[K.pending], [{ kind: "event", payload: { a: 1 } }]);
});

test("the check is memoised — repeat calls do not re-clear", async () => {
  const local = { [K.project]: OTHER, [K.refresh]: "rt-old" };
  const { ensureProjectIdentity } = await loadWith(CURRENT, local, {});

  assert.equal((await ensureProjectIdentity()).changed, true);
  local[K.refresh] = "rt-new";                      // a fresh sign-in lands
  assert.equal((await ensureProjectIdentity()).changed, false);
  assert.equal(local[K.refresh], "rt-new", "a second call must not wipe the new credential");
});

test("storage failure degrades to 'no change' rather than throwing", async () => {
  installChrome();
  globalThis.chrome.storage.local.get = async () => { throw new Error("storage unavailable"); };
  const { ensureProjectIdentity } = await import(`../firestore.js?fail=${Math.random()}`);

  assert.deepEqual(await ensureProjectIdentity(), { changed: false });
});
