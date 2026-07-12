// modules/claimsdisposition/service.js
//
// Service-worker handlers for claimsdisposition. Loaded statically by the
// SW dispatcher via module.js → registry.
//
// Three responsibilities (moved here from the now-deleted claimspull module):
//   1. ensureEmbedTab — find / open a background tab on the Looker embed so
//      the user's Google session cookies are attached when we fire same-
//      origin POSTs against /embed/batchedDataV2. Direct SW-side fetch from
//      the extension origin tends to omit those cookies (or get blocked by
//      Google's Origin check) — going through an in-tab fetch via
//      chrome.scripting.executeScript is the well-trodden pattern in this
//      repo (mirrors sparkfraud/service.js::fetchJson for gscope).
//   2. pull — fetches per-store data + writes one pull record to IndexedDB
//      (via lib/db.js) for the dashboard view to render. Replaces the old
//      claimspull stash in chrome.storage.local.
//   3. downloadCsv — exports per-store CSVs for a chosen pull to ~/Downloads.

import {
  buildPayload, parseLookerJson, decodeRows, lastNDaysRange,
  EMBED_URL, DEFAULT_APP_VERSION,
} from "./lib/looker.js";
import { toCsv } from "./lib/looker_csv.js";
import { putPull, pruneOldPulls, getPullById } from "./lib/db.js";
import { fetchCvpForMarket } from "./lib/cvp.js";
import { classifyAuthResponse, isAuthFailureStatus, reloadTabAndWait } from "../../shared/auth.js";

const MODULE_ID = "claimsdisposition";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fallback store list used when the view omits `stores` in its message.
// Set to the Market 120 store roster Shane investigates by default —
// matches the store set in the user's most-recent successful pull. If
// you operate in a different market, override by passing `stores` in
// the pull message (the view's "stores" picker also passes it through).
export const DEFAULT_STORES = [658, 669, 756, 1089, 1215, 1458, 2988, 3660, 5151, 5173];

// Where per-store CSVs land in Downloads. Subfolder makes it trivial for
// the user to clean up + visually group successive pulls.
const DOWNLOAD_SUBFOLDER = "APAISuite-claims";

// Module-prefixed storage keys. Sibling modules follow the same convention
// (sparkfraud.*, workvivo.*) — the SW has no access to host.storage so
// raw chrome.storage with manual namespacing is the established pattern.
const STORAGE_KEEPALIVE_KEY = "claimsdisposition._keepalive";
// Per-pull live progress. The view subscribes via chrome.storage.onChanged
// on this key — more reliable than chrome.runtime.sendMessage broadcasts
// from the SW (those can silently drop when the SW is busy doing
// chrome.scripting.executeScript or under brief idle pressure). Doc shape:
// { pullId, startedAt, finishedAt?, total, doneCount, stores: { [id]: {status, totalCount, ms, error, warning} } }
const STORAGE_PROGRESS_KEY = "claimsdisposition.progress";

// Maximum autonomous-reauth attempts per pull. When a whole pull fails
// with auth-shaped errors (Google SSO redirect / login HTML / 401), we
// reload the embed tab and re-run the per-store loop. Most of the time
// the user's Google session was just sleeping and the reload re-attaches
// fresh cookies silently. We cap at MAX_REAUTH_ATTEMPTS to prevent a
// hard loop if the user is genuinely signed out and reload can't fix it.
const MAX_REAUTH_ATTEMPTS = 2;

// Per-store fetch timeout. Slowest store observed was ~6s; 60s is generous
// headroom that still cuts off truly hung calls before a single dead store
// wedges the batch and leaves the view stuck on "fetching" forever.
const FETCH_TIMEOUT_MS = 60_000;

// Number of historic pulls to retain in IndexedDB before auto-eviction.
// Each full 10-store/30-day pull is ~50MB of rows, so 30 ≈ 1.5GB worst case.
const KEEP_LAST_N_PULLS = 30;

const LOG = (...args) => console.log("[claimsdisposition]", ...args);

// ── Embed tab management ─────────────────────────────────────────────
async function findEmbedTab() {
  // Two URL shapes Looker uses for the embed; match both.
  const queries = await Promise.all([
    chrome.tabs.query({ url: "https://datastudio.google.com/embed/reporting/4d607b7f-15b3-488a-b7a3-c426c7dc5b37/*" }),
    chrome.tabs.query({ url: "https://lookerstudio.google.com/embed/reporting/4d607b7f-15b3-488a-b7a3-c426c7dc5b37/*" }),
  ]);
  return queries.flat()[0] ?? null;
}

async function ensureEmbedTab({ openIfMissing = true } = {}) {
  const existing = await findEmbedTab();
  if (existing) return { ok: true, tabId: existing.id, opened: false };
  if (!openIfMissing) return { ok: false, error: "no embed tab open" };

  // NOTE: this tab is intentionally LEFT OPEN after a successful pull —
  // Looker's anti-CSRF cookie chain is anchored to it, and closing forces
  // a 30s reauth on every subsequent pull. The trade-off (one persistent
  // background tab vs latency on every refresh) is acceptable today.
  // See docs/AUTH_AUDIT.md::Recommendation — the Pass-2 sessionManager
  // will own tab-lifecycle ("close idle tabs we opened after N minutes")
  // so this site no longer has to make the call.
  const tab = await chrome.tabs.create({ url: EMBED_URL, active: false });
  // Wait for SSO + initial JS to settle. The embed itself loads in ~2-3s
  // but the same-origin fetch only succeeds once Looker's bootstrap has
  // set up its anti-CSRF cookie chain. Probing every 500ms keeps happy-
  // path fast.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await sleep(500);
    const t = await chrome.tabs.get(tab.id).catch(() => null);
    if (t?.status === "complete" && (t.url ?? "").includes("/embed/reporting/")) {
      await sleep(1500); // one more breath for the bootstrap
      return { ok: true, tabId: tab.id, opened: true };
    }
  }
  // Timeout — close the tab we opened so failed attempts don't accumulate
  // a graveyard of broken embed tabs.
  try { await chrome.tabs.remove(tab.id); } catch (_) {}
  return { ok: false, error: `embed tab did not reach complete state within 30s` };
}

// Execute one batchedDataV2 fetch from inside the embed tab. The injected
// function MUST be pure: no closure variables. It's serialized into the page
// world, runs with same-origin cookies + Referer, returns the raw text body.
//
// Two failure modes the wrapper guards against:
//  1. chrome.scripting.executeScript itself hangs (observed on Walmart-corp
//     Edge MDM for some hosts — see sparkfraud/service.js for the same
//     family of bug). The Promise.race with a manual timeout converts that
//     into an explicit timeout error.
//  2. The page-side fetch hangs (Looker bootstrap not done, SSO redirect
//     in flight). The inner fetch uses AbortController bounded by
//     FETCH_TIMEOUT_MS - 2s so we surface a clean "in-page fetch timed out"
//     rather than the outer "executeScript timed out".
async function fetchInEmbedTab(tabId, payload, appVersion) {
  const url = `https://datastudio.google.com/embed/batchedDataV2?appVersion=${encodeURIComponent(appVersion)}`;

  const exec = chrome.scripting.executeScript({
    target: { tabId },
    args: [url, payload, FETCH_TIMEOUT_MS - 2000],
    func: async (u, body, innerTimeoutMs) => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), innerTimeoutMs);
        const t0 = performance.now();
        const r = await fetch(u, {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json",
            "accept": "application/json, text/plain, */*",
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        const text = await r.text();
        clearTimeout(timer);
        return {
          ok: r.ok,
          status: r.status,
          contentType: r.headers.get("content-type") || "",
          text,
          ms: Math.round(performance.now() - t0),
        };
      } catch (e) {
        return { ok: false, status: 0, contentType: "", error: String(e?.message ?? e) };
      }
    },
  });

  const timeout = new Promise((resolve) =>
    setTimeout(() => resolve("__claimsdisposition_outer_timeout__"), FETCH_TIMEOUT_MS));

  const winner = await Promise.race([exec, timeout]);
  if (winner === "__claimsdisposition_outer_timeout__") {
    LOG(`outer timeout: chrome.scripting.executeScript did not return within ${FETCH_TIMEOUT_MS}ms`);
    return { ok: false, status: 0, error: `executeScript timed out after ${FETCH_TIMEOUT_MS}ms — possibly Edge MDM blocking script injection on datastudio.google.com` };
  }
  const result = winner?.[0]?.result;
  return result ?? { ok: false, status: 0, error: "executeScript returned nothing" };
}

// Pull one store. Returns { ok, store, rows, totalCount, ms, error?, warning?, authStatus? }.
//
// authStatus is set whenever the response classifies as an auth failure
// (per shared/auth.js::classifyAuthResponse). The pull handler aggregates
// these to decide whether the whole pull is an auth failure vs a real
// data problem — Looker SSO redirect returns 200 OK with HTML, which used
// to surface as a confusing per-store "JSON parse failed" with no hint that
// the user was signed out.
async function pullStore({ tabId, store, startDate, endDate, appVersion }) {
  const payload = buildPayload({ store, startDate, endDate });
  const t0 = Date.now();
  const r = await fetchInEmbedTab(tabId, payload, appVersion);
  const fetchMs = Date.now() - t0;

  // Classify the response before attempting JSON parse. A Google SSO
  // redirect returns 200 + HTML; without this check we'd hand it to the
  // parser and surface "JSON parse failed" with no actionable hint.
  const authStatus = classifyAuthResponse({
    status:      r.status,
    contentType: r.contentType || "",
    body:        r.text || r.error || "",
  });
  if (isAuthFailureStatus(authStatus)) {
    return {
      ok: false, store, ms: fetchMs, status: r.status, authStatus,
      error: authStatus === "EXPIRED"
        ? "Looker session expired — sign in to Google again."
        : authStatus === "SSO_REDIRECT"
        ? "Looker redirected to SSO — sign in to Google again."
        : "Looker returned a login page — sign in to Google again.",
    };
  }

  if (!r.ok) {
    return { ok: false, store, ms: fetchMs, status: r.status, error: r.error ?? `HTTP ${r.status}` };
  }
  let parsed;
  try {
    parsed = parseLookerJson(r.text);
  } catch (e) {
    return { ok: false, store, ms: fetchMs, status: r.status,
             error: `JSON parse failed: ${e.message}`,
             rawSnippet: r.text.slice(0, 300) };
  }
  const { rows, totalCount, warning } = decodeRows(parsed);
  return { ok: true, store, ms: fetchMs, status: r.status, rows, totalCount, warning };
}

// MV3 SWs idle-shutdown after ~30s of no activity. A 10-store sequential
// pull runs ~45s and the per-store fetch already counts as activity (it's
// a chrome.scripting call), but a single hanging fetch could let the timer
// expire mid-loop. A trivial chrome.storage.session write re-arms the
// timer — cheap, no quota concerns, throwaway value.
function keepalive() {
  chrome.storage.session.set({ [STORAGE_KEEPALIVE_KEY]: Date.now() }).catch(() => {});
}

// Pull every store in sequence. Extracted from the `pull` handler so the
// autonomous-reauth path can re-run the loop after a tab reload without
// duplicating progress / keepalive bookkeeping.
async function runPerStoreLoop({ stores, tabId, startDate, endDate, appVersion, progress }) {
  const perStore = [];
  for (const store of stores) {
    keepalive();
    LOG(`fetching store ${store}…`);
    progress.stores[store] = { status: "fetching" };
    await chrome.storage.session.set({ [STORAGE_PROGRESS_KEY]: progress });

    const r = await pullStore({ tabId, store, startDate, endDate, appVersion });
    perStore.push(r);
    progress.stores[store] = {
      status: r.ok ? "done" : "error",
      totalCount: r.totalCount ?? 0,
      ms: r.ms,
      error: r.error,
      warning: r.warning,
    };
    progress.doneCount += 1;
    await chrome.storage.session.set({ [STORAGE_PROGRESS_KEY]: progress });
    LOG(`store ${store}: ${r.ok ? `ok (${r.totalCount} rows, ${r.ms}ms)` : `error (${r.error})`}`);
  }
  return perStore;
}

// True when every store failed AND every failure is auth-shaped. Mixed
// network-timeout + auth pulls do NOT count — those need their own
// network-side retry strategy, and surfacing them as "auth" would mask
// the underlying transient.
function allFailedWithAuthSignal(perStore) {
  if (!perStore.length) return false;
  const failures = perStore.filter((r) => !r.ok);
  if (failures.length !== perStore.length) return false;
  const authFailures = failures.filter((r) => isAuthFailureStatus(r.authStatus));
  return authFailures.length === failures.length && authFailures.length > 0;
}

// ── Exported handlers ────────────────────────────────────────────────
export const handlers = {
  // Trigger a full multi-store pull. Per-store progress is published to
  // chrome.storage.session[STORAGE_PROGRESS_KEY] so the view can subscribe
  // via chrome.storage.onChanged. Pulled rows land in IndexedDB via db.js;
  // the view reloads from db.getLatestPull on completion.
  async pull(msg) {
    const stores = (msg?.stores?.length ? msg.stores : DEFAULT_STORES).map(String);
    const days   = Math.max(1, Math.min(365, Number(msg?.days) || 30));
    const appVersion = msg?.appVersion || DEFAULT_APP_VERSION;
    const { startDate, endDate } = lastNDaysRange(days);
    const pullId = `pull-${Date.now()}`;

    LOG(`pull starting: pullId=${pullId} stores=[${stores.join(",")}] days=${days} range=${startDate}..${endDate}`);

    // Seed progress doc so the view's onChanged subscriber gets immediate
    // state. `total` lets the progress-bar compute % without re-reading
    // anything else.
    const progress = {
      pullId, startedAt: Date.now(), startDate, endDate, days,
      total: stores.length, doneCount: 0,
      stores: Object.fromEntries(stores.map((s) => [s, { status: "pending" }])),
    };
    await chrome.storage.session.set({ [STORAGE_PROGRESS_KEY]: progress });

    const tabRes = await ensureEmbedTab();
    if (!tabRes.ok) {
      LOG(`ensureEmbedTab failed: ${tabRes.error}`);
      progress.fatal = tabRes.error;
      await chrome.storage.session.set({ [STORAGE_PROGRESS_KEY]: progress });
      return { ok: false, error: tabRes.error };
    }
    LOG(`embed tab ready: tabId=${tabRes.tabId} opened=${tabRes.opened}`);

    // Run the per-store loop. If the result is dominated by auth-shaped
    // failures (every store failed with SSO_REDIRECT / LOGIN_HTML / 401),
    // attempt autonomous reauth: reload the embed tab — which forces
    // Google to re-attach session cookies if they're still cached — then
    // re-run the loop. Repeat up to MAX_REAUTH_ATTEMPTS. Most Google
    // sessions sleep but stay valid; the reload silently re-authenticates
    // without bothering the user.
    let perStore = await runPerStoreLoop({
      stores, tabId: tabRes.tabId, startDate, endDate, appVersion, progress,
    });
    let reauthAttempts = 0;
    while (reauthAttempts < MAX_REAUTH_ATTEMPTS && allFailedWithAuthSignal(perStore)) {
      reauthAttempts++;
      LOG(`auth-shaped failure detected; reloading embed tab (autonomous reauth ${reauthAttempts}/${MAX_REAUTH_ATTEMPTS})`);
      const reloaded = await reloadTabAndWait(tabRes.tabId, {
        settleMs: 2500,
        timeoutMs: 30_000,
        waitForReady: async (tabId) => {
          const t = await chrome.tabs.get(tabId).catch(() => null);
          return !!t?.url && t.url.includes("/embed/reporting/") && t.status === "complete";
        },
      });
      if (!reloaded.ok) {
        LOG(`reauth reload failed: ${reloaded.reason} — giving up on autonomous reauth`);
        break;
      }
      // Reset per-store progress slots so the view's progress bar shows
      // the retry as a fresh pass instead of skipping straight to "done
      // with errors". keepalive() is called inside runPerStoreLoop.
      for (const s of stores) progress.stores[s] = { status: "pending" };
      progress.doneCount = 0;
      await chrome.storage.session.set({ [STORAGE_PROGRESS_KEY]: progress });
      perStore = await runPerStoreLoop({
        stores, tabId: tabRes.tabId, startDate, endDate, appVersion, progress,
      });
    }
    if (reauthAttempts > 0 && !allFailedWithAuthSignal(perStore)) {
      LOG(`autonomous reauth succeeded after ${reauthAttempts} attempt(s)`);
    } else if (reauthAttempts >= MAX_REAUTH_ATTEMPTS) {
      LOG(`autonomous reauth exhausted (${MAX_REAUTH_ATTEMPTS} attempts); leaving pull in failed state`);
    }

    // Persist to IndexedDB. Skip writing when totalRows is 0 — that record
    // would clutter the source-picker dropdown with a useless "0 rows" entry
    // and confuse the auto-pull-on-empty logic. The per-store error details
    // are still returned to the view in the handler response below.
    const storesByNumber = {};
    let totalRows = 0;
    for (const r of perStore) {
      if (!r.ok || !r.rows?.length) continue;
      storesByNumber[r.store] = r.rows;
      totalRows += r.rows.length;
    }
    if (totalRows > 0) {
      // Sidecar fetch: pull this market's CVP performance data (sell-through
      // + 8-week history per store) from Hoops and bundle it into the same
      // pull record. Non-fatal: if Hoops is unreachable, the pull still
      // lands without CVP and the user just sees blank Sell-Through cells
      // until the next pull retries.
      let cvp = null;
      try {
        cvp = await fetchCvpForMarket({ marketNbr: 120 });
        LOG(`CVP fetched: latestWeek=${cvp.latestWeek} stores=${Object.keys(cvp.byStore).length}`);
      } catch (e) {
        LOG(`CVP fetch failed (non-fatal): ${e?.message ?? e}`);
      }

      const pullRecord = {
        pullId,
        pulledAt: Date.now(),
        days,
        startDate, endDate,
        totalRows,
        storesByNumber,
        perStoreSummary: perStore.map((r) => ({
          store: r.store, ok: r.ok, totalCount: r.totalCount ?? 0,
          ms: r.ms, error: r.error ?? null, warning: r.warning ?? null,
        })),
        cvp,   // null on Hoops failure — view side handles missing CVP gracefully
      };
      try {
        await putPull(pullRecord);
        const prune = await pruneOldPulls(KEEP_LAST_N_PULLS);
        LOG(`pull saved to IndexedDB: kept=${prune.kept} deleted=${prune.deleted.length}`);
      } catch (e) {
        LOG(`IndexedDB putPull failed: ${e?.message ?? e}`);
        progress.dbError = String(e?.message ?? e);
      }
    } else {
      LOG(`pull yielded zero rows across all stores — skipping IndexedDB write`);
    }

    // After autonomous-reauth retries, classify the final state. Only
    // returned to the view as a diagnostic — there is no longer a sticky
    // guard or user-action prompt. The dashboard will simply auto-pull
    // again on the next mount (Looker SSO usually re-establishes silently
    // once the user has another Google tab open).
    const failures = perStore.filter((r) => !r.ok);
    const authFailures = failures.filter((r) => isAuthFailureStatus(r.authStatus));
    const stillAuthFailed = allFailedWithAuthSignal(perStore);
    if (stillAuthFailed) {
      progress.fatal = `Looker auth failed after ${reauthAttempts} autonomous reauth attempt(s). ` +
                       `Will retry on next dashboard mount.`;
      LOG(progress.fatal);
    }

    progress.finishedAt = Date.now();
    await chrome.storage.session.set({ [STORAGE_PROGRESS_KEY]: progress });
    LOG(`pull complete: pullId=${pullId} total=${stores.length} ok=${perStore.filter((p) => p.ok).length} err=${failures.length} rows=${totalRows} reauthAttempts=${reauthAttempts}`);

    return {
      ok: !stillAuthFailed,
      pullId,
      startDate, endDate, days,
      totalRows,
      reauthAttempts,
      authFailure: stillAuthFailed ? {
        authStatus: authFailures[0].authStatus,
        message:    `${authFailures[0].error} (auto-retried ${reauthAttempts}x)`,
      } : null,
      stores: perStore.map((r) => ({
        store: r.store, ok: r.ok, totalCount: r.totalCount ?? 0,
        ms: r.ms, error: r.error ?? null, warning: r.warning ?? null,
        authStatus: r.authStatus ?? null,
      })),
    };
  },

  // Export per-store CSVs for a given pull to ~/Downloads/APAISuite-claims/.
  // The view passes the currently-selected pullId — defaults to latest if
  // omitted.
  async downloadCsv(msg) {
    const pullId = msg?.pullId;
    if (!pullId) return { ok: false, error: "pullId required" };
    const pull = await getPullById(pullId);
    if (!pull) return { ok: false, error: `no pull found for ${pullId}` };

    const isoFrom = lookerIntToIso(pull.startDate);
    const isoTo   = lookerIntToIso(pull.endDate);

    const results = [];
    for (const [store, rows] of Object.entries(pull.storesByNumber || {})) {
      if (!rows?.length) { results.push({ store, skipped: "empty" }); continue; }
      const csv = toCsv(rows);
      const filename = `${DOWNLOAD_SUBFOLDER}/claims_${store}_${isoFrom}_${isoTo}.csv`;
      // Blob + object URL instead of `data:text/csv;...` URL — percent-
      // encoded data URLs balloon to ~3x raw and chrome.downloads quietly
      // fails on multi-MB CSVs in some Edge builds. A 23k-row pull is well
      // over that limit. The URL is revoked after download() initiates so
      // the Blob can be GC'd; chrome.downloads keeps its own reference to
      // the bytes once the download starts.
      let objectUrl = null;
      try {
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
        objectUrl = URL.createObjectURL(blob);
        const downloadId = await chrome.downloads.download({
          url: objectUrl,
          filename,
          saveAs: false,
          conflictAction: "uniquify",
        });
        results.push({ store, downloadId, filename, rows: rows.length, bytes: csv.length });
      } catch (e) {
        results.push({ store, error: String(e?.message ?? e) });
      } finally {
        if (objectUrl) {
          setTimeout(() => { try { URL.revokeObjectURL(objectUrl); } catch (_) {} }, 0);
        }
      }
    }
    return { ok: true, results };
  },

  // Lightweight diagnostic so the view can show whether the embed tab is
  // already open before the user hits Pull. (Saves them a 30s wait on the
  // cold-start pull if they pre-load the embed themselves.)
  async embedStatus() {
    const tab = await findEmbedTab();
    return tab ? { ok: true, present: true, tabId: tab.id, tabUrl: tab.url }
               : { ok: true, present: false };
  },
};

function lookerIntToIso(n) {
  const s = String(n);
  if (s.length !== 8) return s;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}
