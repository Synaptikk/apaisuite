// shared/alarms.js
//
// Two small pieces every module with a periodic alarm needs, extracted after
// the same pair of bugs was found in five of them (vizpick, digitallocks,
// workvivo, livedashboard, sparkscango) on 2026-08-20.
//
// BUG 1 — chrome.alarms.create() is NOT idempotent.
// -------------------------------------------------
// Calling create() with the name of an existing alarm does not leave it
// alone: it cancels that alarm and schedules a fresh one, restarting the
// period from zero. Several modules carried a comment asserting the opposite
// ("Idempotent — replaces any prior entry with the same name"). Replacing is
// precisely the problem. ensureAlarm() below reads first and only writes when
// the alarm is missing or its period no longer matches the code.
//
// BUG 2 — module.js::register() never runs in the service worker.
// ---------------------------------------------------------------
// register() is called from app.js when the shell mounts a module. Every
// module installed its alarm there, so the alarm was (re)created on each
// shell page load and nowhere else. Combined with bug 1: open or reload the
// suite tab more often than the alarm period and the alarm never fires once.
// digitallocks was the worst case at periodInMinutes: 24 * 60 — for anyone
// who opens the suite daily it could never have fired.
//
// The fix is to install from module.js TOP LEVEL, which the service worker
// evaluates on every boot — guarded by IS_SERVICE_WORKER, see below.

/**
 * True in the service worker, false in an extension page (app.html).
 *
 * module.js files are imported by BOTH: the SW pulls them in through
 * shared/registry.js -> modules/_registry.js, and the shell page imports the
 * same registry to read manifests. Anything with a side effect at top level
 * therefore runs twice unless it is gated.
 *
 * This matters most for chrome.alarms.onAlarm. Extension pages receive alarm
 * events too, so an ungated listener runs its handler once in the SW and once
 * in every open suite tab — two module instances with separate in-flight
 * guards, both driving the same background tabs. Register alarm listeners and
 * install alarms only when this is true.
 *
 * `window` is the discriminator: a ServiceWorkerGlobalScope has none.
 */
export const IS_SERVICE_WORKER = typeof window === "undefined";

/**
 * Create a periodic alarm only if it is missing or its period has drifted
 * from the code. Safe to call on every service-worker boot.
 *
 * @param {string} name
 * @param {object} opts
 * @param {number} opts.periodInMinutes  Repeat interval.
 * @param {number} [opts.delayInMinutes] When the FIRST fire happens.
 *   Defaults to `periodInMinutes`, which is also Chrome's own behaviour when
 *   the field is omitted — so leaving it unset preserves whatever a caller
 *   had before. Pass a small value when a freshly installed alarm should do
 *   something soon rather than after a full period.
 * @returns {Promise<{created: boolean, reason: string}>}
 */
export async function ensureAlarm(name, { periodInMinutes, delayInMinutes } = {}) {
  if (!name) throw new Error("ensureAlarm: name is required");
  if (!(periodInMinutes > 0)) throw new Error(`ensureAlarm(${name}): periodInMinutes must be > 0`);

  // A get() failure (permission missing, API unavailable) must not be
  // swallowed into "already fine" — fall through and let create() surface it.
  const existing = await chrome.alarms.get(name).catch(() => null);
  if (existing && existing.periodInMinutes === periodInMinutes) {
    return { created: false, reason: "already scheduled with this period" };
  }

  await chrome.alarms.create(name, {
    delayInMinutes: delayInMinutes ?? periodInMinutes,
    periodInMinutes,
  });
  return {
    created: true,
    reason: existing
      ? `period changed ${existing.periodInMinutes} -> ${periodInMinutes}`
      : "no alarm existed",
  };
}
