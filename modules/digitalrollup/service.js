// modules/digitalrollup/service.js
//
// SW handlers for the Digital Market Rollup. One pull, one endpoint, one
// snapshot — this is the simplest source in the suite because it is the only
// one that is an actual API rather than a dashboard we have to drive.
//
// NOTE: no host.storage here. `host` exists only in the view page, so a
// service worker uses raw chrome.storage with manually-prefixed keys.
// See docs/AI_CONTEXT_BRIEF.md §2.

import { ensureAlarm } from "../../shared/alarms.js";
import { keepAwake } from "../../shared/sw_keepalive.js";
import { createLogging } from "../../shared/logging.js";
import { watchSourceSchema } from "../../shared/schema_watch_report.js";
import { getUserHomeMarket } from "../../shared/userStore.js";
import { fetchDashboard, fetchHierarchy, GifApiError } from "./lib/gif_api.js";
import { flattenKeys, normalizeDashboard } from "./lib/normalize.js";

const K = {
  snapshot:  "digitalrollup.snapshot",
  hierarchy: "digitalrollup.hierarchy",
  debug:     "digitalrollup.debug",
  auto:      "digitalrollup.auto.v1",
  lastAuto:  "digitalrollup.auto.lastRun",
};

export const ALARM_NAMES = { autorefresh: "digitalrollup.autorefresh" };

// The board republishes off GRT in near real time, so unlike VizPick there is
// no cheap "has it changed?" probe to run first — and none is needed. One pull
// is a single sub-second JSON call returning ~13 KB, so a 10-minute poll is
// cheaper than the timestamp check VizPick does to AVOID pulling.
const AUTO_PERIOD_MIN = 10;

// Rate-limit for the SW-boot check. Pinned to the alarm period on purpose:
// bootstrapIfNeeded() runs on essentially every service-worker wake, so a
// separate, smaller constant here would quietly become the real refresh rate
// and override the period above. That exact bug cost VizPick three times its
// intended traffic — two constants controlling one rate must not be free to
// disagree. See CURRENT_TASKS.md §6.
const BOOTSTRAP_MIN_GAP_MS = AUTO_PERIOD_MIN * 60_000;

const log = createLogging("digitalrollup");

function broadcast(type, payload = {}) {
  chrome.runtime.sendMessage({ module: "digitalrollup", type, ...payload }).catch(() => {});
}

// One pull at a time. A second Refresh while the first is opening its tab
// would race for the same anchor tab and close it out from under the first.
let inFlight = null;

const AUTO_DEFAULTS = { enabled: true };

async function readAuto() {
  const got = await chrome.storage.local.get(K.auto);
  return { ...AUTO_DEFAULTS, ...(got[K.auto] || {}) };
}

async function readAll() {
  const got = await chrome.storage.local.get([K.snapshot, K.hierarchy, K.debug]);
  return {
    snapshot:  got[K.snapshot]  ?? null,
    hierarchy: got[K.hierarchy] ?? null,
    debug:     got[K.debug]     ?? null,
  };
}

/**
 * Pull one market's board.
 *
 * The hierarchy comes along on every pull rather than being cached
 * indefinitely: it is ~130 bytes, it is what populates the market picker, and
 * it is scoped server-side to the caller — so a change in the user's access
 * should show up on the next Refresh, not on the next reinstall.
 */
async function pull(market) {
  const started = Date.now();
  const release = keepAwake("digitalrollup.pull");
  try {
    log.emit("pull-start", { market: String(market ?? "") });

    // The picker is refreshed even when the caller already named a market, so
    // the two can never disagree about which markets exist.
    let hierarchy = null;
    try {
      hierarchy = await fetchHierarchy();
      await chrome.storage.local.set({ [K.hierarchy]: { ...hierarchy, capturedAt: Date.now() } });
    } catch (e) {
      // A failed hierarchy is not fatal — a caller that already knows its
      // market can still get a board. Only a failed dashboard is.
      log.emit("hierarchy-failed", { error: String(e?.message ?? e), kind: e?.kind ?? null });
    }

    const target = String(market ?? hierarchy?.markets?.[0]?.market ?? "");
    if (!target) {
      throw new GifApiError("HTTP", "No market to pull — the hierarchy returned none and none was given.");
    }

    const { raw, via } = await fetchDashboard(target);

    // Report the shape BEFORE deciding whether we can use it, so a rename is
    // recorded even on the run where it breaks us. Fire-and-forget by design.
    const cardKeys = flattenKeys(raw?.cards?.[0]);
    const norm = normalizeDashboard(raw, { market: target });
    if (cardKeys.length) watchSourceSchema("digitalrollup.dashboardCard", cardKeys, norm.ok);
    const summaryKeys = flattenKeys(raw?.summary);
    if (summaryKeys.length) watchSourceSchema("digitalrollup.dashboardSummary", summaryKeys, norm.ok);

    if (!norm.ok) {
      throw new GifApiError("PARSE", `The board is missing fields this module needs: ${norm.missing.join(", ")}`, {
        missing: norm.missing,
      });
    }

    const snapshot = { ...norm.snapshot, via };
    await chrome.storage.local.set({
      [K.snapshot]: snapshot,
      [K.debug]: { ok: true, at: Date.now(), via, market: target, ms: Date.now() - started },
    });
    log.emit("pull-ok", {
      market: target, via, stores: snapshot.cards.length, ms: Date.now() - started,
    });
    // An open view repaints from this. It matters most for the alarm-driven
    // pull, which no one is waiting on a response for.
    broadcast("board_updated", { ok: true, market: target });
    return { ok: true, snapshot };
  } catch (e) {
    const debug = {
      ok: false,
      at: Date.now(),
      market: String(market ?? ""),
      kind: e?.kind ?? "UNKNOWN",
      error: String(e?.message ?? e),
      detail: e?.detail ?? null,
      ms: Date.now() - started,
    };
    await chrome.storage.local.set({ [K.debug]: debug });
    log.emit("pull-failed", { market: debug.market, kind: debug.kind, error: debug.error });
    broadcast("board_updated", { ok: false, kind: debug.kind });
    // A failed pull leaves the stored snapshot ALONE — a board that is one
    // refresh stale beats an empty screen. The view says so rather than
    // letting the old data pass for current; see renderFreshness().
    return { ok: false, error: debug.error, kind: debug.kind, debug };
  } finally {
    release();
  }
}

/**
 * The one place `inFlight` is set. Both the manual Refresh and the alarm go
 * through here, so a background run and a click can never drive two pulls at
 * once — the second joins the first rather than opening a second anchor tab
 * and closing it out from under the first.
 */
function startPull(market) {
  if (inFlight) return inFlight;
  inFlight = pull(market).finally(() => { inFlight = null; });
  return inFlight;
}

// ── Auto-refresh ────────────────────────────────────────────────────────
//
// Which market the background pull follows, in order: whatever is already
// stored (so it keeps the board you were last looking at current), then the
// home market from Settings > Defaults, then the only market your access
// covers. With no answer to any of those there is nothing to refresh and the
// run says so rather than guessing a market nobody asked for.
async function autoTargetMarket() {
  const { snapshot, hierarchy } = await readAll();
  if (snapshot?.market) return { market: String(snapshot.market), from: "snapshot" };
  const home = await getUserHomeMarket();
  if (home) return { market: String(home), from: "home" };
  const first = hierarchy?.markets?.[0]?.market;
  if (first) return { market: String(first), from: "hierarchy" };
  return { market: null, from: "none" };
}

/**
 * One background refresh. Every branch that ends in "do nothing" logs why —
 * VizPick's auto-check decided something every 30 minutes and left no trace,
 * which is the only reason a one-line breakage took two days to find.
 */
async function autoRefresh(reason) {
  const auto = await readAuto();
  if (!auto.enabled) {
    log.emit("auto-skip", { reason, why: "disabled" });
    return { ok: true, skipped: "auto-refresh is off" };
  }

  const { market, from } = await autoTargetMarket();
  log.emit("auto-start", { reason, market: market ?? "", marketFrom: from });
  if (!market) {
    return { ok: true, skipped: "no market to refresh yet" };
  }

  // Stamp BEFORE the pull, not after. The gap this feeds is meant to stop the
  // SW re-checking on every wake; stamping only on success would let a run of
  // failures retry on every single wake instead of once per period.
  await chrome.storage.local.set({ [K.lastAuto]: Date.now() });

  if (inFlight) {
    // Logged rather than silently joined: a background run colliding with a
    // manual Refresh is worth being able to see in the feed.
    log.emit("auto-skip", { reason, why: "a pull is already running" });
    return { ok: true, skipped: "a pull is already running" };
  }
  return await startPull(market);
}

export async function onAlarm(alarm) {
  if (alarm?.name !== ALARM_NAMES.autorefresh) return;
  // Proves the alarm actually fires. Its absence from the feed is itself the
  // diagnosis — that was the 2026-08-20 bug across six modules, and nothing
  // recorded it at the time.
  log.emit("alarm-fired", { name: alarm.name });
  try { await autoRefresh("alarm"); }
  catch (e) { console.warn("[digitalrollup] auto-refresh failed:", e?.message ?? e); }
}

/**
 * Idempotent — safe to call on every SW boot. See shared/alarms.js for why
 * chrome.alarms.create() on its own is not: calling it with an existing name
 * CANCELS that alarm and restarts its period from zero.
 *
 * delayInMinutes: 1 rather than the default full period, so a freshly
 * installed alarm gets the board current within a minute instead of sitting
 * idle for the first ten.
 */
export async function installAlarms() {
  const r = await ensureAlarm(ALARM_NAMES.autorefresh, {
    periodInMinutes: AUTO_PERIOD_MIN,
    delayInMinutes: 1,
  });
  log.emit("alarm-ensured", { created: r.created, reason: r.reason, periodMin: AUTO_PERIOD_MIN });
}

/**
 * Runs at service-worker boot, which includes every browser start — so the
 * board is already current when the module is opened rather than showing the
 * last capture until someone clicks Refresh. Rate-limited, because the SW
 * wakes for many reasons besides a browser start.
 */
export async function bootstrapIfNeeded() {
  try {
    const got = await chrome.storage.local.get(K.lastAuto);
    const sinceMs = Date.now() - (got[K.lastAuto] || 0);
    if (sinceMs < BOOTSTRAP_MIN_GAP_MS) {
      log.emit("bootstrap-skip", { sinceMs, gapMs: BOOTSTRAP_MIN_GAP_MS });
      return { ok: true, skipped: "refreshed recently" };
    }
    return await autoRefresh("bootstrap");
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// Every handler returns an explicit { ok: true, ... }. The SW dispatcher
// auto-wraps a bare return as { ok: true, data: <value> }, and callers then
// have to remember which handlers are wrapped and which are not — so we
// never return a bare value.
export const handlers = {
  async "get_state"(_msg) {
    const [all, auto, lastAuto] = await Promise.all([
      readAll(),
      readAuto(),
      chrome.storage.local.get(K.lastAuto),
    ]);
    return { ok: true, ...all, auto, periodMin: AUTO_PERIOD_MIN, lastAuto: lastAuto[K.lastAuto] || 0 };
  },

  async "pull"(msg) {
    return await startPull(msg?.market);
  },

  // The auto-refresh on/off switch. Turning it back on should not wait up to
  // a full period to prove it works, so it refreshes immediately.
  async "set_auto"(msg) {
    const auto = { ...(await readAuto()), ...(msg?.auto || {}) };
    await chrome.storage.local.set({ [K.auto]: auto });
    log.emit("auto-set", { enabled: !!auto.enabled });
    if (auto.enabled) autoRefresh("toggled").catch(() => {});
    return { ok: true, auto };
  },

  async "get_auto"(_msg) {
    return { ok: true, auto: await readAuto(), periodMin: AUTO_PERIOD_MIN };
  },

  // Counts, stamps and error classes only — no store-level figures — so it is
  // safe to paste into a chat when reporting a board that will not load.
  async "diagnostics"(_msg) {
    const { snapshot, hierarchy, debug } = await readAll();
    const auto = await readAuto();
    const lastAuto = (await chrome.storage.local.get(K.lastAuto))[K.lastAuto] || 0;
    const alarm = await chrome.alarms.get(ALARM_NAMES.autorefresh).catch(() => null);
    let tabs = [];
    try {
      const found = await chrome.tabs.query({ url: "https://ai-innovation-lab-app-bebdeibbicjffabd.walmart.com/*" });
      tabs = found.map((t) => ({ id: t.id, status: t.status, url: (t.url || "").split("?")[0] }));
    } catch (e) {
      tabs = [{ error: String(e?.message ?? e) }];
    }
    const diagnostics = {
      module: "digitalrollup",
      at: new Date().toISOString(),
      lastRun: debug,
      inFlight: !!inFlight,
      // "Is the auto-refresh actually running?" must be answerable from this
      // paste alone — a missing alarm row here IS the diagnosis.
      auto: {
        enabled: !!auto.enabled,
        periodMin: AUTO_PERIOD_MIN,
        lastRunAt: lastAuto ? new Date(lastAuto).toISOString() : null,
        alarm: alarm
          ? { periodInMinutes: alarm.periodInMinutes, nextFire: new Date(alarm.scheduledTime).toISOString() }
          : null,
      },
      snapshot: snapshot && {
        market: snapshot.market,
        stores: snapshot.cards?.length ?? 0,
        via: snapshot.via,
        reportDate: snapshot.reportDate,
        refreshedAtIso: snapshot.refreshedAtIso,
        capturedAt: new Date(snapshot.capturedAt).toISOString(),
      },
      hierarchy: hierarchy && { markets: hierarchy.markets?.length ?? 0, via: hierarchy.via },
      tabs,
    };
    return { ok: true, diagnostics };
  },
};
