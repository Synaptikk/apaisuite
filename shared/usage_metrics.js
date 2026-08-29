// shared/usage_metrics.js
//
// Suite-wide usage telemetry: which tools get used, by which store and
// market, and when. The question it exists to answer is "where should effort
// go next", not "what did this person do today".
//
// DELIBERATELY PSEUDONYMOUS. Rows carry a random installation id, store,
// market and role — never a name, an email, or a WIN ID. That is the whole
// difference between this and modules/aurorbuddy/lib/usage_metrics.js, which
// writes /tool_metric_events with the analyst's name and email attached
// because those rows are case-activity records that a supervisor reads.
// Mixing the two shapes in one collection would quietly re-identify these,
// so they are separate collections and stay that way.
//
// Backend: the `apaisuite` project, via shared/suiteBackend.js. This used to
// import the write primitive from modules/aurorbuddy/lib/firestore.js, on the
// reasoning that one client meant one token cache. But that client is pinned
// to the `aurorbuddy` project while these rows are governed by
// backend/firestore.suite.rules, which deploys to `apaisuite` — so every write
// 403'd. Sharing a token cache is worth nothing if it points at the wrong
// project; see the header of suiteBackend.js.

import { commitCreateWithServerTimestamp } from "./suiteBackend.js";
import { getUserHomeStore, getUserHomeMarket, getUserRole } from "./userStore.js";

const COLLECTION = "suite_usage_events";

// Same key shared/push.js uses, so an install has ONE id regardless of which
// subsystem asked for it first. Duplicated rather than imported because push.js
// is replaced by a no-op stub in the Chrome Web Store build (see
// scripts/stubs/push.js) — importing it would make telemetry ids differ
// between the store build and the unpacked build.
const INSTALL_ID_KEY = "shell.installationId";

// Bounded local queue. Without it every event recorded while the network is
// down is simply lost, which does not fail loudly — it silently undercounts,
// and an undercount is worse than no number because it still looks like data.
const QUEUE_KEY = "shell.usage.pending";
const MAX_QUEUE = 200;

// contextHint is the only free-text field. Every current caller passes either
// nothing or a short machine-built string, but the cap and the scrub are here
// so that a future caller cannot turn this collection into a PII sink by
// accident.
const CONTEXT_CAP = 120;
const SCRUB = [
  [/\b\d{13,19}\b/g, "[card]"],
  [/\b\d{9}\b/g, "[id]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  [/Bearer\s+[A-Za-z0-9._-]+/gi, "[token]"],
];

function scrub(value) {
  let s = String(value ?? "");
  for (const [re, rep] of SCRUB) s = s.replace(re, rep);
  return s.slice(0, CONTEXT_CAP);
}

async function getInstallationId() {
  try {
    const got = await chrome.storage.local.get(INSTALL_ID_KEY);
    if (typeof got?.[INSTALL_ID_KEY] === "string" && got[INSTALL_ID_KEY].length >= 32) {
      return got[INSTALL_ID_KEY];
    }
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ [INSTALL_ID_KEY]: id });
    return id;
  } catch {
    return "";
  }
}

function browserSlug() {
  const ua = (globalThis.navigator?.userAgent) || "";
  const m = ua.match(/(Edg|Chrome)\/(\d+)/);
  return m ? `${m[1] === "Edg" ? "Edge" : m[1]}/${m[2]}` : "";
}

/**
 * Build the row. Split out from the write so it can be tested without a
 * network or a Firebase project.
 */
// `trigger` separates work a person asked for from work an alarm did.
//
// Without it the numbers are worthless: vizpick checks every 30 minutes,
// digitalrollup every 10, sparkscango every 15, metricshot every minute and
// workvivo hourly — so every install would look permanently, identically busy
// and "which tools get used" could not be answered at all. digitalrollup makes
// it unavoidable rather than merely advisable: its manual refresh and its auto
// refresh are the SAME handler, so nothing else distinguishes them.
//
// Automation is still recorded, not dropped. These alarms are the least
// exercised code in the suite (CURRENT_TASKS.md §7 — several had never once
// fired before 2026-08-20), and an alarm that stops firing is invisible
// otherwise. Usage reporting just filters to trigger === "user".
export const TRIGGERS = Object.freeze(["user", "auto"]);

export async function buildUsageRow({ moduleName, actionName, result = "success", durationMs = null, contextHint = null, trigger = "user" }) {
  const [installationId, storeNumber, marketNumber, role] = await Promise.all([
    getInstallationId(),
    getUserHomeStore().catch(() => null),
    getUserHomeMarket().catch(() => null),
    getUserRole().catch(() => null),
  ]);

  return {
    installationId,
    storeNumber:  storeNumber  || "",
    marketNumber: marketNumber || "",
    role:         role         || "",
    moduleName:   String(moduleName || ""),
    actionName:   String(actionName || ""),
    result:       String(result || "success"),
    // Unknown values collapse to "user" rather than passing through: a typo
    // must not create a third bucket that silently drops rows out of both the
    // usage filter and the automation filter.
    trigger:      TRIGGERS.includes(trigger) ? trigger : "user",
    durationMs:   Number.isFinite(durationMs) ? Math.round(durationMs) : null,
    contextHint:  contextHint == null ? null : scrub(contextHint),
    toolVersion:  chrome.runtime?.getManifest?.().version || "",
    browser:      browserSlug(),
    // Recorded client-side as well as by the server timestamp: `timestamp` is
    // authoritative, this one survives a queued event being flushed days late.
    occurredAt:   new Date().toISOString(),
  };
}

async function writeRow(row) {
  const docId = crypto.randomUUID();
  return await commitCreateWithServerTimestamp(COLLECTION, docId, row, "timestamp");
}

async function readQueue() {
  try {
    const got = await chrome.storage.local.get(QUEUE_KEY);
    return Array.isArray(got?.[QUEUE_KEY]) ? got[QUEUE_KEY] : [];
  } catch {
    return [];
  }
}

async function writeQueue(rows) {
  try {
    await chrome.storage.local.set({ [QUEUE_KEY]: rows.slice(-MAX_QUEUE) });
  } catch { /* storage full or unavailable; dropping is the only option left */ }
}

/**
 * Flush anything queued by earlier failures. Stops at the first failure so a
 * sustained outage doesn't burn the whole queue on retries that will also
 * fail; the remainder waits for the next call.
 */
export async function flushUsageQueue() {
  const queued = await readQueue();
  if (!queued.length) return { drained: 0, remaining: 0 };

  let drained = 0;
  for (const row of queued) {
    try {
      await writeRow(row);
      drained++;
    } catch {
      break;
    }
  }
  const remaining = queued.slice(drained);
  await writeQueue(remaining);
  return { drained, remaining: remaining.length };
}

/**
 * Record one usage event. Never throws and never blocks the caller's work —
 * telemetry that can break a feature is worse than no telemetry.
 */
export async function recordUsage(opts) {
  try {
    const row = await buildUsageRow(opts || {});
    try {
      await writeRow(row);
    } catch {
      const q = await readQueue();
      q.push(row);
      await writeQueue(q);
      return { ok: false, queued: true };
    }
    // Only drain on a proven-good connection, so the queue isn't retried
    // pointlessly on every event while offline.
    flushUsageQueue().catch(() => {});
    // Piggyback the schema-drift queue on the same proven connection rather
    // than giving it an alarm of its own. Drift is rare and never urgent — it
    // just has to arrive before someone asks "what changed this week".
    import("./schema_watch_report.js")
      .then((m) => m.flushSchemaDrift())
      .catch(() => {});
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export const _internals = { COLLECTION, QUEUE_KEY, MAX_QUEUE, CONTEXT_CAP, scrub, browserSlug };
