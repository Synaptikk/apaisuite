// shared/tests/onboarding.test.mjs
//
// Pins the STATE half of first-run onboarding — when it runs, when it does
// not, and how it fails. The DOM half (wizard, coach marks) is verified by
// driving the real shell; what is testable here is the part that decides
// whether a person is interrupted, which is the part with a wrong answer that
// is genuinely annoying.
//
// What each test defends:
//   · completion lives in SYNC storage, so it follows the person to a second
//     machine rather than re-interrogating them on every install
//   · Skip counts as done — otherwise "Skip" means "ask me every time"
//   · storage being unavailable must NOT mean "show the wizard", because that
//     would show it on every single load
//   · reset genuinely restores first-run, which is the only way to test this
//     on a machine that has already completed it

import test from "node:test";
import assert from "node:assert/strict";

const DONE_KEY = "apai.onboardingCompletedAt";
const TIPS_KEY = "apai.onboardingTipsSeenAt";

function installChrome(sync = {}, { failing = false } = {}) {
  const api = {
    get: async (k) => {
      if (failing) throw new Error("storage unavailable");
      const out = {};
      for (const key of (Array.isArray(k) ? k : [k])) if (key in sync) out[key] = sync[key];
      return out;
    },
    set:    async (o) => { if (failing) throw new Error("storage unavailable"); Object.assign(sync, o); },
    remove: async (k) => { if (failing) throw new Error("storage unavailable");
                           for (const key of (Array.isArray(k) ? k : [k])) delete sync[key]; },
  };
  globalThis.chrome = { storage: { sync: api, local: api, session: api },
                        runtime: { getManifest: () => ({ version: "0.0.0-test" }) } };
  // userStore.js and onboarding.js touch document only inside the DOM paths,
  // but importing must not explode in Node.
  globalThis.document = globalThis.document ?? { addEventListener() {}, removeEventListener() {} };
  return sync;
}

const load = () => import(`../onboarding.js?t=${Math.random()}`);

test("a fresh install needs onboarding", async () => {
  installChrome({});
  const { needsOnboarding } = await load();
  assert.equal(await needsOnboarding(), true);
});

test("completing it records a timestamp in SYNC storage", async () => {
  const sync = installChrome({});
  const { completeOnboarding, needsOnboarding } = await load();

  await completeOnboarding();

  // Sync, not local: the same person on a second PC has already answered
  // these questions, and asking again reads as the tool forgetting them.
  assert.ok(sync[DONE_KEY], "completion flag written");
  assert.doesNotThrow(() => new Date(sync[DONE_KEY]).toISOString());
  assert.equal(await needsOnboarding(), false);
});

test("an already-onboarded install is not interrupted", async () => {
  installChrome({ [DONE_KEY]: "2026-08-01T00:00:00.000Z" });
  const { needsOnboarding } = await load();
  assert.equal(await needsOnboarding(), false);
});

test("reset restores genuine first-run state", async () => {
  const sync = installChrome({ [DONE_KEY]: "2026-08-01T00:00:00.000Z",
                               [TIPS_KEY]: "2026-08-01T00:00:00.000Z" });
  const { resetOnboarding, needsOnboarding } = await load();

  await resetOnboarding();

  // The completion flag is in sync storage, so there is no local state to
  // clear — this is the ONLY way to re-test the flow on a machine that has
  // already completed it.
  assert.equal(sync[DONE_KEY], undefined);
  assert.equal(sync[TIPS_KEY], undefined);
  assert.equal(await needsOnboarding(), true);
});

test("tips completion is tracked separately from setup", async () => {
  const sync = installChrome({});
  const { completeOnboarding, markTipsSeen } = await load();

  await completeOnboarding();
  assert.equal(sync[TIPS_KEY], undefined, "finishing setup must not imply the tips were seen");

  await markTipsSeen();
  assert.ok(sync[TIPS_KEY]);
});

test("storage failure means DO NOT interrupt, not interrupt always", async () => {
  installChrome({}, { failing: true });
  const { needsOnboarding } = await load();

  // The tempting default is `true` — "we don't know, so ask". That shows the
  // wizard on every single load for anyone whose sync storage is unavailable,
  // which is far worse than never showing it.
  assert.equal(await needsOnboarding(), false);
});

test("completeOnboarding swallows a storage failure rather than throwing", async () => {
  installChrome({}, { failing: true });
  const { completeOnboarding, markTipsSeen, resetOnboarding } = await load();
  // These are called from click handlers mid-wizard; throwing would leave the
  // dialog stuck open with no way past it.
  await assert.doesNotReject(() => completeOnboarding());
  await assert.doesNotReject(() => markTipsSeen());
  await assert.doesNotReject(() => resetOnboarding());
});

test("maybeRunOnboarding no-ops for an onboarded user", async () => {
  installChrome({ [DONE_KEY]: "2026-08-01T00:00:00.000Z" });
  const { maybeRunOnboarding } = await load();
  // Returns false without touching the DOM — the boot path calls this on every
  // single load, so the common case must do nothing at all.
  assert.equal(await maybeRunOnboarding(), false);
});
