// modules/livedashboard/service.js
//
// SW handlers for the Live Dashboard module. Phase 1: pull_cvp + pull_absences.
// Sources B/C/E placeholders return a "phase 2" state so the widget renders
// the right empty/pending UX.

import { fetchCvp, fetchCvpBreakdown, CVP_CATEGORIES } from "./lib/sources/cvp.js";
import { peek, collect, normalize, rollup } from "./lib/sources/absences.js";
import { fetchCompliance, rollup as complianceRollup } from "./lib/sources/compliance.js";
import { fetchRegister, runMatching, rollup as registerRollup } from "./lib/sources/register.js";
import { fetchAccident, rollup as accidentRollup } from "./lib/sources/accident.js";
import { fetchRecognition, rollup7d as recognitionRollup7d } from "./lib/sources/recognition.js";
import * as freshness  from "./lib/freshness.js";
import { getUserHomeStore } from "../../shared/userStore.js";
import { ensureAlarm } from "../../shared/alarms.js";

// ── Storage keys ─────────────────────────────────────────────────────
const K = {
  settings:        "livedashboard.settings",
  cvpCache:        (storeNbr) => `livedashboard.cvp.cache.${storeNbr}`,
  // Absences are NOT store-keyed: the IVR scraper returns whatever the
  // user's account can see, independent of the dashboard's store setting.
  // Keying by store would (a) duplicate the same dataset under multiple
  // store keys and (b) make the widget go blank on every store switch
  // until a heavy IVR re-collect ran.
  absencesCache:   "livedashboard.absences.cache",
  complianceCache: "livedashboard.compliance.cache",
  registerCache:   "livedashboard.register.cache",     // import + findings
  accidentCache:   (storeNbr) => `livedashboard.accident.cache.${storeNbr}`,
  recognitionCache: (storeNbr) => `livedashboard.recognition.cache.${storeNbr}`,
};

// ── Alarms ───────────────────────────────────────────────────────────
export const ALARM_NAMES = {
  cvp:        "livedashboard.cvp",
  absences:   "livedashboard.absences",
  compliance: "livedashboard.compliance",
  register:   "livedashboard.register",
  accident:   "livedashboard.accident",
  recognition: "livedashboard.recognition",
};
const ALARM_INTERVAL_MIN = {
  [ALARM_NAMES.cvp]:        15,
  [ALARM_NAMES.absences]:   60,    // hourly per user request — IVR is heavy
  [ALARM_NAMES.compliance]: 360,   // 6h
  [ALARM_NAMES.register]:   360,   // 6h
  [ALARM_NAMES.accident]:   240,   // 4h — file regenerates daily, this catches it
  [ALARM_NAMES.recognition]: 360,  // 6h — observations get logged through the day
};

// ── Bootstrap (fire on initial dashboard open) ──────────────────────
//
// Called from module.js::register(host) when the dashboard first mounts.
// Fans out pulls for any source whose cache is empty or beyond its
// "stale" threshold. Skips pulls for sources that already have fresh data
// (so re-opening the dashboard 5 minutes later doesn't re-run heavy pulls).
//
// Returns immediately (Promise.allSettled in the background) so the shell
// boot isn't blocked. Each pull broadcasts source_complete on its own;
// the view's subscriber re-paints as data arrives.

// Per-source freshness threshold for bootstrap. If lastSuccess is older
// than this on dashboard open, a fresh pull fires immediately. A GLOBAL
// 12-hour cap also applies (BOOTSTRAP_MAX_AGE_MS below): any source
// older than 12h re-pulls regardless of per-source policy.
const BOOTSTRAP_STALE_MS = {
  cvp:          30 * 60_000,         // 30 min
  absences:     60 * 60_000,         // 1 h
  compliance:   60 * 60_000,         // 1 h
  register:     6  * 60 * 60_000,    // 6 h
  accident:     4  * 60 * 60_000,    // 4 h
  recognition:  6  * 60 * 60_000,    // 6 h
};
// Global cap: anything older than this on dashboard open ALWAYS re-pulls.
const BOOTSTRAP_MAX_AGE_MS = 12 * 60 * 60_000;

export async function bootstrapIfNeeded() {
  const storeNbr = await getStoreNbr();
  const fresh    = await freshness.readAll();
  const tasks    = [];

  // Store-keyed sources only run when we know which store. The view's
  // first paint shows a "Set your store" hint in their place.
  if (storeNbr) {
    if (shouldBootstrap(fresh.cvp, BOOTSTRAP_STALE_MS.cvp)) {
      console.log("[livedashboard] bootstrap → pullCvp");
      tasks.push(pullCvp({ storeNbr }).catch((e) => console.warn("[livedashboard] bootstrap pullCvp threw:", e?.message)));
    }
    if (shouldBootstrap(fresh.register, BOOTSTRAP_STALE_MS.register)) {
      console.log("[livedashboard] bootstrap → pullRegister");
      tasks.push(pullRegister({ storeNbr }).catch((e) => console.warn("[livedashboard] bootstrap pullRegister threw:", e?.message)));
    }
    if (shouldBootstrap(fresh.accident, BOOTSTRAP_STALE_MS.accident)) {
      console.log("[livedashboard] bootstrap → pullAccident");
      tasks.push(pullAccident({ storeNbr }).catch((e) => console.warn("[livedashboard] bootstrap pullAccident threw:", e?.message)));
    }
    if (shouldBootstrap(fresh.recognition, BOOTSTRAP_STALE_MS.recognition)) {
      console.log("[livedashboard] bootstrap → pullRecognition");
      tasks.push(pullRecognition({ storeNbr }).catch((e) => console.warn("[livedashboard] bootstrap pullRecognition threw:", e?.message)));
    }
  } else {
    console.log("[livedashboard] bootstrap: no store set — skipping store-keyed sources");
  }

  // Account-global sources run regardless of store: absences (IVR returns
  // whatever the analyst's account can see) and compliance (Enviance is
  // panel-keyed, not store-keyed).
  if (shouldBootstrap(fresh.absences, BOOTSTRAP_STALE_MS.absences)) {
    console.log("[livedashboard] bootstrap → pullAbsences");
    tasks.push(pullAbsences({ storeNbr }).catch((e) => console.warn("[livedashboard] bootstrap pullAbsences threw:", e?.message)));
  }
  if (shouldBootstrap(fresh.compliance, BOOTSTRAP_STALE_MS.compliance)) {
    console.log("[livedashboard] bootstrap → pullCompliance");
    tasks.push(pullCompliance().catch((e) => console.warn("[livedashboard] bootstrap pullCompliance threw:", e?.message)));
  }

  if (tasks.length === 0) {
    console.log("[livedashboard] bootstrap: all sources fresh, no pulls needed");
    return { ok: true, pulled: 0 };
  }

  // Fire-and-forget — don't block register(). Pulls broadcast on completion.
  Promise.allSettled(tasks).then((results) => {
    const ok = results.filter((r) => r.status === "fulfilled").length;
    console.log(`[livedashboard] bootstrap complete: ${ok}/${tasks.length} sources pulled`);
  });

  return { ok: true, pulled: tasks.length };
}

function shouldBootstrap(fresh, staleMs) {
  if (!fresh || !fresh.lastSuccess) return true;
  if (fresh.inFlight) return false;
  // If the most recent attempt errored, ALWAYS retry on bootstrap. Common
  // case: CVP/Hoops auth expired, user signs into Hoops in another tab,
  // returns to dashboard — we want the next bootstrap to clear the error
  // automatically rather than waiting for the per-source alarm tick.
  if (fresh.lastError) return true;
  const age = Date.now() - new Date(fresh.lastSuccess).getTime();
  // Global cap: anything older than 12h on dashboard open re-pulls
  // regardless of the per-source threshold.
  if (age > BOOTSTRAP_MAX_AGE_MS) return true;
  return age > staleMs;
}

// Idempotent — see shared/alarms.js. Previously a bare chrome.alarms.create()
// per source, called from module.js::register(), which runs only on shell page
// load: each load cancelled and rescheduled every alarm, so a dashboard opened
// more often than a source's interval kept that source's alarm permanently
// pending and it refreshed only via bootstrapIfNeeded().
export async function installAlarms() {
  for (const [name, periodInMinutes] of Object.entries(ALARM_INTERVAL_MIN)) {
    await ensureAlarm(name, { periodInMinutes });
  }
}

export async function onAlarm(alarm) {
  if (!alarm?.name?.startsWith("livedashboard.")) return;
  const storeNbr = await getStoreNbr();
  // Store-keyed alarms are silent no-ops until the user has a store set.
  // Compliance + absences are account-global and always allowed to run.
  const needsStore = alarm.name === ALARM_NAMES.cvp
                  || alarm.name === ALARM_NAMES.register
                  || alarm.name === ALARM_NAMES.accident
                  || alarm.name === ALARM_NAMES.recognition;
  if (needsStore && !storeNbr) return;
  switch (alarm.name) {
    case ALARM_NAMES.cvp:          await pullCvp({ storeNbr });        break;
    case ALARM_NAMES.absences:     await pullAbsences({ storeNbr });   break;
    case ALARM_NAMES.compliance:   await pullCompliance();             break;
    case ALARM_NAMES.register:     await pullRegister({ storeNbr });   break;
    case ALARM_NAMES.accident:     await pullAccident({ storeNbr });   break;
    case ALARM_NAMES.recognition:  await pullRecognition({ storeNbr }); break;
  }
}

// ── Settings helpers ─────────────────────────────────────────────────
// Store-number resolution order:
//   1. User-set value in chrome.storage.sync["livedashboard.settings"].storeNbr
//   2. Auto-detected from cached Auror JWT (shared/userStore.js)
//   3. "" — the view prompts the user to enter their store
//
// Returning the empty string when nothing is known is intentional: every
// store-keyed pull guards against it (see pullCvp/pullRegister/etc. — they
// short-circuit with errorClass "NO_STORE"), so we never persist garbage
// caches under a null store key.
async function getSettings() {
  const got = await chrome.storage.sync.get(K.settings);
  const raw = got[K.settings] || {};
  if (raw.storeNbr) return raw;
  const detected = await getUserHomeStore();
  return { ...raw, storeNbr: detected || "" };
}

async function setSettings(patch) {
  const got = await chrome.storage.sync.get(K.settings);
  const cur  = got[K.settings] || {};
  const next = { ...cur, ...patch };
  await chrome.storage.sync.set({ [K.settings]: next });
  return next;
}

async function getStoreNbr() {
  return (await getSettings()).storeNbr || "";
}

// ── Pull: CVP ────────────────────────────────────────────────────────
// Pulls all 4 variants (headline + Fresh + Food + GM) in parallel.
// The headline is the dashboard's primary metric; the others power
// the drill-down breakdown.
async function pullCvp({ storeNbr } = {}) {
  storeNbr = storeNbr || (await getStoreNbr());
  if (!storeNbr) return noStoreSet("cvp");
  await freshness.startAttempt("cvp");

  const res = await fetchCvpBreakdown(storeNbr);
  if (!res.ok) {
    await freshness.markError("cvp", `${res.errorClass}: ${res.error}`);
    broadcast("source_complete", { sourceId: "cvp", ok: false, error: res.error });
    return res;
  }

  // Persist full breakdown.
  const headline = res.byCategory.headline;
  await chrome.storage.local.set({
    [K.cvpCache(storeNbr)]: {
      storeNbr,
      rows:        headline.rows,             // backwards-compat — headline rows at top level
      currentWeek: headline.currentWeek,
      byCategory:  res.byCategory,            // full breakdown
      capturedAt:  res.capturedAt,
    },
  });
  await freshness.markSuccess("cvp");
  broadcast("source_complete", {
    sourceId:  "cvp",
    ok:        true,
    rolledUp:  { sellThruPctTy: headline.currentWeek.sellThruPctTy },
  });
  return res;
}

// ── Pull: Absences ───────────────────────────────────────────────────
async function pullAbsences({ storeNbr, forceCollect = false } = {}) {
  storeNbr = storeNbr || (await getStoreNbr());
  await freshness.startAttempt("absences");

  // Try cache peek first unless force; the IVR flow is heavy (~5–60s)
  // and the closinglist cache is the source of truth either way.
  let result = forceCollect ? null : await peek();

  if (!result || !result.ok || result.stale) {
    result = await collect();
  }

  if (!result?.ok) {
    await freshness.markError("absences", result?.error || "IVR collect failed");
    broadcast("source_complete", { sourceId: "absences", ok: false, error: result?.error });
    return result;
  }

  const todayIso = isoToday();
  const records  = (result.rows || []).map((r) =>
    normalize(r, storeNbr, result.capturedAt, result.sourceUrl ?? null)
  );
  const counts   = rollup(records, todayIso);

  await chrome.storage.local.set({
    [K.absencesCache]: {
      storeNbr,
      records,
      counts,
      todayIso,
      capturedAt: result.capturedAt,
      sourceUrl:  result.sourceUrl ?? null,
    },
  });
  await freshness.markSuccess("absences");
  broadcast("source_complete", {
    sourceId: "absences",
    ok:       true,
    rolledUp: counts,
  });
  return { ok: true, records, counts };
}

// ── Pull: Accident Evidence ──────────────────────────────────────────
async function pullAccident({ storeNbr } = {}) {
  storeNbr = storeNbr || (await getStoreNbr());
  if (!storeNbr) return noStoreSet("accident");
  await freshness.startAttempt("accident");
  const res = await fetchAccident(storeNbr);
  if (!res.ok) {
    await freshness.markError("accident", `${res.errorClass}: ${res.error}`);
    broadcast("source_complete", { sourceId: "accident", ok: false, error: res.error });
    return res;
  }
  const counts = accidentRollup(res.records);
  await chrome.storage.local.set({
    [K.accidentCache(storeNbr)]: {
      storeNbr,
      records:             res.records,
      counts,
      capturedAt:          res.capturedAt,
      sourceDataUpdatedOn: res.sourceDataUpdatedOn,
    },
  });
  await freshness.markSuccess("accident");
  broadcast("source_complete", { sourceId: "accident", ok: true, rolledUp: counts });
  return { ok: true, records: res.records, counts };
}

// ── Pull: Register (V1.5 — automated capture from Power BI) ─────────
async function pullRegister({ storeNbr } = {}) {
  storeNbr = storeNbr || (await getStoreNbr());
  if (!storeNbr) return noStoreSet("register");
  await freshness.startAttempt("register");

  const res = await fetchRegister(storeNbr);
  if (!res.ok) {
    await freshness.markError("register", `${res.errorClass}: ${res.error}`);
    broadcast("source_complete", { sourceId: "register", ok: false, error: res.error });
    return res;
  }

  const findings = runMatching(res.discrepancies);
  const counts   = registerRollup(findings);
  await chrome.storage.local.set({
    [K.registerCache]: {
      storeNbr,
      discrepancies: res.discrepancies,
      findings,
      counts,
      capturedAt: res.capturedAt,
      replayed:   res.replayed,
      cellCount:  res.cellCount,
      shiftCount: res.shiftCount,
    },
  });
  await freshness.markSuccess("register");
  broadcast("source_complete", { sourceId: "register", ok: true, rolledUp: counts });
  return { ok: true, counts, cellCount: res.cellCount, findings: findings.length };
}

// ── Pull: Compliance ─────────────────────────────────────────────────
async function pullCompliance() {
  await freshness.startAttempt("compliance");
  const res = await fetchCompliance();
  if (!res.ok) {
    await freshness.markError("compliance", `${res.errorClass}: ${res.error}`);
    broadcast("source_complete", { sourceId: "compliance", ok: false, error: res.error });
    return res;
  }
  const counts = complianceRollup(res.rows);
  await chrome.storage.local.set({
    [K.complianceCache]: {
      tasks: res.rows,
      counts,
      capturedAt: res.capturedAt,
      fromReplay: !!res.fromReplay,
      captureAgeMs: res.captureAgeMs ?? null,
    },
  });
  await freshness.markSuccess("compliance");
  broadcast("source_complete", { sourceId: "compliance", ok: true, rolledUp: counts });
  return { ok: true, rows: res.rows, counts };
}

// ── Pull: Recognition (Safety Observations Power BI table) ─────────
async function pullRecognition({ storeNbr } = {}) {
  storeNbr = storeNbr || (await getStoreNbr());
  if (!storeNbr) return noStoreSet("recognition");
  await freshness.startAttempt("recognition");
  const res = await fetchRecognition(storeNbr);
  if (!res.ok) {
    await freshness.markError("recognition", `${res.errorClass}: ${res.error}`);
    broadcast("source_complete", { sourceId: "recognition", ok: false, error: res.error });
    return res;
  }
  const rolling7d = recognitionRollup7d(res.rows);
  await chrome.storage.local.set({
    [K.recognitionCache(storeNbr)]: {
      storeNbr,
      rows:       res.rows,
      rolling7d,
      capturedAt: res.capturedAt,
      replayed:   res.replayed,
    },
  });
  await freshness.markSuccess("recognition");
  broadcast("source_complete", { sourceId: "recognition", ok: true, rolledUp: { rolling7d } });
  return { ok: true, rows: res.rows, rolling7d };
}

// ── refresh_all ─────────────────────────────────────────────────────
async function refreshAll() {
  const storeNbr = await getStoreNbr();
  const [cvp, abs, comp, reg, acc, rec] = await Promise.allSettled([
    pullCvp({ storeNbr }),
    pullAbsences({ storeNbr }),
    pullCompliance(),
    pullRegister({ storeNbr }),
    pullAccident({ storeNbr }),
    pullRecognition({ storeNbr }),
  ]);
  return {
    cvp:        cvp.status  === "fulfilled" ? cvp.value  : { ok: false, error: String(cvp.reason) },
    absences:   abs.status  === "fulfilled" ? abs.value  : { ok: false, error: String(abs.reason) },
    compliance: comp.status === "fulfilled" ? comp.value : { ok: false, error: String(comp.reason) },
    register:   reg.status  === "fulfilled" ? reg.value  : { ok: false, error: String(reg.reason) },
    accident:   acc.status  === "fulfilled" ? acc.value  : { ok: false, error: String(acc.reason) },
    recognition: rec.status === "fulfilled" ? rec.value  : { ok: false, error: String(rec.reason) },
  };
}

// ── get_dashboard_state ─────────────────────────────────────────────
// One round-trip read for the view to mount with. Returns everything
// needed to paint the initial widget grid. When no store is set yet,
// the per-store cache reads are skipped (would read junk-key paths) and
// the view paints "Set your store" placeholders for those widgets.
async function getDashboardState() {
  const settings  = await getSettings();
  const storeNbr  = settings.storeNbr || "";
  const freshAll  = await freshness.readAll();
  const absGot    = await chrome.storage.local.get(K.absencesCache);
  const complianceGot = await chrome.storage.local.get(K.complianceCache);
  const registerGot   = await chrome.storage.local.get(K.registerCache);
  const [cvpGot, accidentGot, recognitionGot] = storeNbr
    ? await Promise.all([
        chrome.storage.local.get(K.cvpCache(storeNbr)),
        chrome.storage.local.get(K.accidentCache(storeNbr)),
        chrome.storage.local.get(K.recognitionCache(storeNbr)),
      ])
    : [{}, {}, {}];
  return {
    settings,
    storeNbr,
    freshness: freshAll,
    sources: {
      absences: {
        cache: absGot[K.absencesCache] || null,
        phase: "phase1",
      },
      compliance: {
        cache: complianceGot[K.complianceCache] || null,
        phase: "phase2",
        note:  "Capture from go.enviance.com tab.",
      },
      accident: {
        cache: storeNbr ? (accidentGot[K.accidentCache(storeNbr)] || null) : null,
        phase: "phase2",
        note:  "Static HTML at storage.googleapis.com/cas_storage/cas_static_html/<storeNbr>.html",
      },
      cvp: {
        cache: storeNbr ? (cvpGot[K.cvpCache(storeNbr)] || null) : null,
        phase: "phase1",
      },
      register: {
        cache: registerGot[K.registerCache] || null,
        phase: "v1.5",
        note:  "Captured automatically from Power BI report tab; polls every 6h.",
      },
      recognition: {
        cache: storeNbr ? (recognitionGot[K.recognitionCache(storeNbr)] || null) : null,
        phase: "v1.6",
        note:  "Captured from Field_Dashboard Safety Observations page; rolling 7d daily counts.",
      },
    },
  };
}

// Short-circuit return shape for store-keyed pulls when no store is set.
// Skips freshness updates (don't surface "error" on the widget when the
// user just hasn't picked a store yet) and tells the broadcast subscribers
// to render the "Set your store" placeholder.
function noStoreSet(sourceId) {
  broadcast("source_complete", { sourceId, ok: false, errorClass: "NO_STORE", error: "No store set" });
  return { ok: false, errorClass: "NO_STORE", error: "No store set" };
}

// ── Broadcast helper ─────────────────────────────────────────────────
// Sends a message into the extension page bus. View subscribers (via
// host.messaging.on) receive it.
function broadcast(type, payload) {
  chrome.runtime.sendMessage({ module: "livedashboard", type, payload }).catch(() => {});
}

// ── Date helper ─────────────────────────────────────────────────────
function isoToday() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

// ── Handler exports ─────────────────────────────────────────────────
export const handlers = {
  async "get_dashboard_state"(_msg) { return await getDashboardState(); },
  async "bootstrap"(_msg)           { return await bootstrapIfNeeded(); },
  async "pull_cvp"(msg)             { return await pullCvp(msg || {}); },
  async "pull_absences"(msg)        { return await pullAbsences(msg || {}); },
  async "pull_compliance"(_msg)     { return await pullCompliance(); },
  async "pull_register"(msg)        { return await pullRegister(msg || {}); },
  async "pull_accident"(msg)        { return await pullAccident(msg || {}); },
  async "pull_recognition"(msg)     { return await pullRecognition(msg || {}); },
  async "focus_enviance_tab"(_msg)  {
    // Find an existing go.enviance.com tab and focus it. Open one if none.
    // Used by the compliance drill — clicking a task row brings the user
    // to the Enviance panel where they can act on the task.
    const existing = await chrome.tabs.query({ url: "https://go.enviance.com/CustomApp/*" });
    if (existing.length) {
      const tab = existing[0];
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      return { ok: true, tabId: tab.id, focused: true };
    }
    const url = "https://go.enviance.com/CustomApp/ddde6520-3955-4d83-b0ab-78f6e5cbaf10/index.html?SystemID=774d2e17-a8fc-409f-9480-e3fa9310c1c5#/panel/cd2f57ae-5625-4762-8f88-1d47d915cc54/false";
    const created = await chrome.tabs.create({ url, active: true });
    return { ok: true, tabId: created.id, opened: true };
  },
  async "refresh_all"(_msg)         { return await refreshAll(); },
  async "set_store"(msg)            {
    const storeNbr = String(msg?.storeNbr ?? "").trim();
    if (!/^\d{1,5}$/.test(storeNbr)) return { ok: false, error: "Store nbr must be 1–5 digits" };
    const next = await setSettings({ storeNbr });
    // Auto-pull CVP for the new store synchronously so the view can read
    // fresh data on its next get_dashboard_state. Absences are NOT
    // re-pulled — IVR is account-global; the existing cache applies to
    // every store. Compliance/accident/register are Phase 2; their pulls
    // will be added here when those handlers exist.
    let cvpResult = null;
    try { cvpResult = await pullCvp({ storeNbr }); }
    catch (e) { cvpResult = { ok: false, error: String(e?.message ?? e) }; }
    return { ok: true, settings: next, cvp: cvpResult };
  },
};
