// modules/sparkscango/service.js
//
// Service-worker handlers for Spark & Scan & Go.
//
// Adapter contracts are STABLE — the view.js and investigation_bridge.js
// contracts do not change based on whether an adapter has been discovery-
// unblocked yet. Unresolved adapters return { ok: false, errorClass:
// "DISCOVERY_REQUIRED", ... } so the view can render a clear state.
//
// Investigation lookups delegate to shared/sparkInvestigation/ — SparkFraud's
// canonical implementation. When the shared modules mature (oms.js,
// gscope_ui.js), the "investigate" handler will fully route through them;
// today it returns "NOT_IMPLEMENTED" for order/trip lookups (which need
// the SW-side driveOrderResolution extraction that's still pending Phase 1
// parity work).

import { ensureAlarm } from "../../shared/alarms.js";
import * as freshness from "./lib/freshness.js";
import { PAGES, STATUS_UNRESOLVED, isPageResolved } from "./lib/pages_registry.js";

export const ALARM_NAMES = Object.freeze({
  scango_exceptions: "sparkscango.pull.scango_exceptions",
  spark_exceptions:  "sparkscango.pull.spark_exceptions",
  scango_audits:     "sparkscango.pull.scango_audits",
  spark_audits:      "sparkscango.pull.spark_audits",
});

const CACHE_KEY = (sourceId) => `sparkscango.cache.${sourceId}`;

// ── Alarm installation ──────────────────────────────────────────────
// Genuinely idempotent now — see shared/alarms.js. The old version called
// chrome.alarms.create() per alarm, which cancels and reschedules rather than
// leaving an existing alarm alone, and it ran from module.js::register(), i.e.
// on every shell page load. The 15-minute exception pulls in particular could
// never fire for anyone who opened the suite more than once a quarter-hour.
export async function installAlarms() {
  for (const [key, name] of Object.entries(ALARM_NAMES)) {
    const period = key.endsWith("_audits") ? 60 : 15; // minutes
    await ensureAlarm(name, { periodInMinutes: period });
  }
}

export async function onAlarm(alarm) {
  switch (alarm.name) {
    case ALARM_NAMES.scango_exceptions: return pullExceptions("scango_exceptions");
    case ALARM_NAMES.spark_exceptions:  return pullExceptions("spark_exceptions");
    case ALARM_NAMES.scango_audits:     return pullAudits("scango_audits");
    case ALARM_NAMES.spark_audits:      return pullAudits("spark_audits");
  }
}

// ── Pulls ────────────────────────────────────────────────────────────
//
// Each pull follows the same lifecycle: startAttempt → adapter → markSuccess
// or markError → broadcast source_complete. Adapters that need discovery
// return DISCOVERY_REQUIRED without opening tabs or firing captures — no
// unnecessary side effects until we know what to capture.

async function pullExceptions(sourceId) {
  await freshness.startAttempt(sourceId);
  if (!isPageResolved(sourceId)) {
    const err = "Adapter awaiting live Power BI discovery — see docs/SPARKSCANGO_CHECKPOINT.md.";
    await freshness.markError(sourceId, STATUS_UNRESOLVED, err);
    broadcast("source_complete", { sourceId, ok: false, errorClass: STATUS_UNRESOLVED, error: err });
    return { ok: false, errorClass: STATUS_UNRESOLVED, error: err };
  }
  // Post-discovery: actual capture + decode goes here. Adapter files are
  // stubbed under lib/pull_*.js and will be filled in when the registry
  // is populated.
  const err = "Adapter implementation pending — page resolved but pull not yet wired.";
  await freshness.markError(sourceId, "NOT_IMPLEMENTED", err);
  broadcast("source_complete", { sourceId, ok: false, errorClass: "NOT_IMPLEMENTED", error: err });
  return { ok: false, errorClass: "NOT_IMPLEMENTED", error: err };
}

async function pullAudits(sourceId) {
  await freshness.startAttempt(sourceId);
  if (!isPageResolved(sourceId)) {
    const err = "Adapter awaiting live Power BI discovery — see docs/SPARKSCANGO_CHECKPOINT.md.";
    await freshness.markError(sourceId, STATUS_UNRESOLVED, err);
    broadcast("source_complete", { sourceId, ok: false, errorClass: STATUS_UNRESOLVED, error: err });
    return { ok: false, errorClass: STATUS_UNRESOLVED, error: err };
  }
  const err = "Adapter implementation pending — page resolved but pull not yet wired.";
  await freshness.markError(sourceId, "NOT_IMPLEMENTED", err);
  broadcast("source_complete", { sourceId, ok: false, errorClass: "NOT_IMPLEMENTED", error: err });
  return { ok: false, errorClass: "NOT_IMPLEMENTED", error: err };
}

async function refreshAll() {
  const results = await Promise.allSettled([
    pullExceptions("scango_exceptions"),
    pullExceptions("spark_exceptions"),
    pullAudits("scango_audits"),
    pullAudits("spark_audits"),
  ]);
  return {
    scango_exceptions: results[0].status === "fulfilled" ? results[0].value : { ok: false, error: results[0].reason?.message },
    spark_exceptions:  results[1].status === "fulfilled" ? results[1].value : { ok: false, error: results[1].reason?.message },
    scango_audits:     results[2].status === "fulfilled" ? results[2].value : { ok: false, error: results[2].reason?.message },
    spark_audits:      results[3].status === "fulfilled" ? results[3].value : { ok: false, error: results[3].reason?.message },
  };
}

async function getDashboardState() {
  const [fr, cs, ce, aa, as] = await Promise.all([
    freshness.readAll(),
    chrome.storage.local.get(CACHE_KEY("scango_exceptions")),
    chrome.storage.local.get(CACHE_KEY("spark_exceptions")),
    chrome.storage.local.get(CACHE_KEY("scango_audits")),
    chrome.storage.local.get(CACHE_KEY("spark_audits")),
  ]);
  return {
    freshness: fr,
    pages: PAGES,
    caches: {
      scango_exceptions: cs[CACHE_KEY("scango_exceptions")] || null,
      spark_exceptions:  ce[CACHE_KEY("spark_exceptions")]  || null,
      scango_audits:     aa[CACHE_KEY("scango_audits")]     || null,
      spark_audits:      as[CACHE_KEY("spark_audits")]      || null,
    },
  };
}

// ── Investigation handler ─────────────────────────────────────────────
//
// Delegates to shared/sparkInvestigation/*. Today only the driver-name
// strategy is fully wired (via Dispatcher) — order/trip strategies return
// NOT_IMPLEMENTED until oms.js is extracted from SparkFraud service.js.
//
// This is by design: the plan calls for the shared oms.js extraction after
// discovery unblocks the adapters. Meanwhile the view can still render the
// strategy decision and show a clear state.
async function investigate(msg) {
  const { strategy, ids /*, source */ } = msg || {};
  if (!strategy || strategy === "none") {
    return { ok: false, errorClass: "NO_STRATEGY", reason: "No lookup strategy provided." };
  }
  switch (strategy) {
    case "order":
    case "trip":
    case "driver-id":
      return {
        ok: false,
        errorClass: "NOT_IMPLEMENTED",
        reason: "Order/trip/driver-ID lookups will route through shared/sparkInvestigation/oms.js after Phase 1 completes. Use SparkFraud's quick-lookup in the meantime.",
        candidates: [],
      };
    case "driver-name":
    case "store-window":
      // Wire to shared/sparkInvestigation/dispatcher.js when the SW-side
      // buildSwiftHeaders wrapper is confirmed working via SparkFraud parity.
      return {
        ok: false,
        errorClass: "NOT_IMPLEMENTED",
        reason: "Driver-name / store-window Dispatcher search wiring pending Phase 1 parity smoke. Ping the SparkFraud driver-lookup path first, then re-run.",
        candidates: [],
        ids,
      };
    default:
      return { ok: false, errorClass: "UNKNOWN_STRATEGY", reason: `Strategy '${strategy}' not recognized.` };
  }
}

// ── SW → view broadcasts ─────────────────────────────────────────────
function broadcast(type, payload) {
  chrome.runtime.sendMessage({ module: "sparkscango", type, ...payload }).catch(() => {});
}

// ── Handler dispatch ─────────────────────────────────────────────────
export const handlers = {
  async get_dashboard_state()        { return await getDashboardState(); },
  async refresh_all()                { return await refreshAll(); },
  async pull_scango_exceptions()     { return await pullExceptions("scango_exceptions"); },
  async pull_spark_exceptions()      { return await pullExceptions("spark_exceptions"); },
  async pull_scango_audits()         { return await pullAudits("scango_audits"); },
  async pull_spark_audits()          { return await pullAudits("spark_audits"); },
  async investigate(msg)             { return await investigate(msg); },
};
