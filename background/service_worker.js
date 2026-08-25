// background/service_worker.js
//
// Single dispatcher for all module messages + synchronous registration of
// declarative webRequest filters that modules declare in their manifests.
//
// Routes by (msg.module, msg.type) to a handler exported by the module's
// service.js. Handlers are statically imported via the chain:
//
//   service_worker.js
//     ↳ shared/registry.js
//       ↳ modules/_registry.js
//         ↳ modules/<id>/module.js  (each STATICALLY imports its service.js)
//
// Why static, not dynamic: MV3 service workers cannot use dynamic import().
// The HTML spec disallows it on ServiceWorkerGlobalScope —
// https://github.com/w3c/ServiceWorker/issues/1356. The previous
// `handlers: () => import("./service.js")` thunk always threw inside the
// SW; the dispatcher's try/catch silently cached an empty handler map,
// which is why every message returned "Unknown handler <module>.<type>".
//
// Side effect: every module's top-level work runs at SW boot. For chrome.
// webRequest listeners that has to be synchronous (Chrome wakes the SW on
// matching events only if the listener was registered during initial
// script execution) — that's what the declarative webRequestFilters block
// below handles. Per-module service.js code that needs to run at boot
// (chrome.cookies subscriptions, chrome.debugger.onEvent, etc.) runs as
// part of the static import chain above.

import { listModules, getModule } from "../shared/registry.js";
import { setCapturedHeader }      from "../shared/captured_headers.js";
import { checkForUpdate }         from "../shared/updater.js";
import { ensurePushSubscription } from "../shared/push.js";
import { ensureAlarm }            from "../shared/alarms.js";
import { reapIdleTabs }          from "../shared/tabSessions.js";

// ── Declarative webRequest filter registration (SYNCHRONOUS, TOP-LEVEL) ──
//
// Walks every module's manifest.webRequestFilters array and registers one
// chrome.webRequest.onBeforeSendHeaders listener per entry. The registration
// happens synchronously during the SW's initial script execution so Chrome
// treats the listener as persistent — it will wake the SW on a matching
// request even after idle-shutdown.
//
// Each filter:
//   { urls: ["https://..."],         // webRequest filter
//     headerName: "authorization",   // lowercased
//     storageKey: "auror.jwt",       // becomes "<moduleId>.<storageKey>"
//     ttlMs: 1_200_000,              // informational; reader enforces
//     predicate: { startsWith: "Bearer " }   // serializable predicate
//   }
//
// Modules read the captured value via shared/auth.js::getCapturedHeader
// which reads chrome.storage.session[<moduleId>.<storageKey>].
function makePredicate(spec) {
  if (!spec) return null;
  if (spec.startsWith) return (v) => typeof v === "string" && v.startsWith(spec.startsWith);
  if (spec.endsWith)   return (v) => typeof v === "string" && v.endsWith(spec.endsWith);
  if (spec.matches)    {
    const re = new RegExp(spec.matches);
    return (v) => typeof v === "string" && re.test(v);
  }
  return null;
}

for (const mod of listModules()) {
  const filters = mod.manifest.webRequestFilters ?? [];
  for (const f of filters) {
    if (!f?.urls?.length || !f?.headerName || !f?.storageKey) {
      console.warn(`[APAISuite SW] skipping malformed webRequestFilter for ${mod.manifest.id}:`, f);
      continue;
    }
    const moduleId = mod.manifest.id;
    const wantName = f.headerName.toLowerCase();
    const fullKey  = `${moduleId}.${f.storageKey}`;
    const predicate = makePredicate(f.predicate);

    chrome.webRequest.onBeforeSendHeaders.addListener(
      (details) => {
        if (!details.requestHeaders) return;
        for (const h of details.requestHeaders) {
          if (h.name.toLowerCase() !== wantName) continue;
          if (!h.value) continue;
          if (predicate && !predicate(h.value)) continue;
          const now = Date.now();
          // Write to BOTH the in-memory map (synchronous, read by modules
          // via shared/auth.js::getCapturedHeader on the same tick) and
          // chrome.storage.session (persists across SW idle-shutdown).
          // The map is the perf win: without it, modules waited for the
          // storage.onChanged event roundtrip before seeing the new value,
          // and ensureAurorAuth often fell through to the slow tab-reload
          // path despite a fresh token just being captured.
          setCapturedHeader(fullKey, h.value, now);
          chrome.storage.session.set({
            [fullKey]: { value: h.value, at: now },
          }).catch(() => {});
          return;
        }
      },
      { urls: f.urls },
      ["requestHeaders", "extraHeaders"]
    );
  }
}

// Pre-warm the in-memory captured-headers map from storage at SW boot.
// Async — fires after the listeners are registered, populates the map for
// any module's first read attempt within the TTL window. Pre-warm guarantees
// that after an SW idle/wake, a cached-but-fresh token is read instantly
// instead of falling through to the slow tab-reload auth path.
(async () => {
  for (const mod of listModules()) {
    for (const f of mod.manifest.webRequestFilters ?? []) {
      const fullKey = `${mod.manifest.id}.${f.storageKey}`;
      try {
        const got = await chrome.storage.session.get(fullKey);
        const saved = got?.[fullKey];
        if (saved?.value) setCapturedHeader(fullKey, saved.value, saved.at ?? Date.now());
      } catch {}
    }
  }
})();

// ── Message router ─────────────────────────────────────────────
//
// Handlers are read directly from each module's already-imported manifest.
// No async load, no cache, no thunk — the static import chain above has
// every module's service.js evaluated by the time this listener fires.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const { module: moduleId, type } = msg ?? {};
  if (!moduleId || !type) {
    // Broadcast events also flow through this listener — ignore the ones
    // that aren't addressed to a specific handler (they're for UI page
    // subscribers via host.messaging.on).
    return false;
  }

  (async () => {
    try {
      const mod = getModule(moduleId);
      const handlers = mod?.manifest?.service?.handlers ?? {};
      const handler = handlers[type];
      if (!handler) {
        // Unknown (module, type) — could be a broadcast event, not an RPC
        // call. If sender expected a response, give them one; otherwise
        // silently ignore.
        sendResponse({ ok: false, error: `Unknown handler ${moduleId}.${type}` });
        return;
      }
      const result = await handler(msg, sender);
      // Handlers may return either { ok, ... } or a bare value (auto-wrap).
      if (result && typeof result === "object" && "ok" in result) {
        sendResponse(result);
      } else {
        sendResponse({ ok: true, data: result });
      }
    } catch (err) {
      console.error(`[APAISuite SW] ${moduleId}.${type} threw:`, err);
      sendResponse({
        ok: false,
        error: String(err?.message ?? err),
        stack: err?.stack ?? null,
      });
    }
  })();

  return true; // keep sendResponse alive for async
});

// ── Toolbar click → open shell ─────────────────────────────────
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("app.html");
  const existing = await chrome.tabs.query({ url });
  if (existing[0]) {
    await chrome.tabs.update(existing[0].id, { active: true });
    if (existing[0].windowId != null) {
      await chrome.windows.update(existing[0].windowId, { focused: true });
    }
  } else {
    await chrome.tabs.create({ url });
  }
});

// ── Update checker (SYNCHRONOUS top-level alarm registration) ──
//
// Polls https://qrcallbox.com/extension/version.json every UPDATER_PERIOD_MIN
// and writes the result to chrome.storage.local. The shell page reads this
// to show a "new version available" pill — see shared/updater.js for the
// full storage contract.
//
// Why top-level: chrome.alarms.onAlarm must be registered during initial SW
// script execution, otherwise Chrome will not wake the SW on a fired alarm
// after idle-shutdown. Same constraint as the webRequest listeners above.
const UPDATER_ALARM_NAME = "_suite_updater";
const UPDATER_PERIOD_MIN = 360; // 6 hours — slow on purpose; the SW idle/wake cost dwarfs the wire fetch.

// Idle-tab reaper. Some modules must keep a background tab alive between calls
// (Looker's CSRF chain, Hoops' SAML session, gscope's post-SSO tab) — closing
// those in a `finally` re-pays a 30s reauth on every use. They register with
// shared/tabSessions.js instead and this sweep closes whatever went quiet.
// Runs oftener than the updater because the cost of being late here is a tab
// sitting in the user's strip.
const TABREAP_ALARM_NAME = "_suite_tabreap";
const TABREAP_PERIOD_MIN = 5;

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATER_ALARM_NAME) {
    checkForUpdate().catch((e) => {
      console.warn("[APAISuite SW] updater check threw:", e);
    });
    return;
  }
  if (alarm.name === TABREAP_ALARM_NAME) {
    reapIdleTabs()
      .then(({ closed, kept, dropped }) => {
        // Only speak up when something happened. A reaper that closes tabs
        // silently is indistinguishable from a crash from the user's side.
        if (closed.length || dropped.length) {
          console.log("[APAISuite SW] tab reap:", { closed, kept, dropped });
        }
      })
      .catch((e) => console.warn("[APAISuite SW] tab reap threw:", e));
  }
});

ensureAlarm(TABREAP_ALARM_NAME, {
  delayInMinutes: 1,
  periodInMinutes: TABREAP_PERIOD_MIN,
}).catch(() => {});

// Ensure the alarm exists, re-creating it only if Chrome restarted and lost
// it. The get() is required: chrome.alarms.create with an existing name is
// NOT a no-op — it cancels that alarm and reschedules, restarting the period
// from zero. (An earlier version of this comment claimed the opposite, and
// five modules were written against that belief; see shared/alarms.js.)
// delayInMinutes puts the first check 30s out instead of 6 hours.
ensureAlarm(UPDATER_ALARM_NAME, {
  delayInMinutes: 0.5,
  periodInMinutes: UPDATER_PERIOD_MIN,
}).catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  // Kick off an immediate check on install/update so the user sees the
  // current state right away rather than waiting for the first alarm tick.
  checkForUpdate().catch(() => {});
  // Also (re)register our Web Push subscription on first install / update.
  ensurePushSubscription().catch(() => {});
});

// ── Web Push handlers (SYNCHRONOUS, TOP-LEVEL) ─────────────────
//
// Same MV3 wake constraint as chrome.webRequest/chrome.alarms above:
// the `push` event listener MUST be registered during the SW's initial
// script execution, otherwise Chrome won't wake the SW when an FCM
// message arrives at our endpoint.
//
// The push payload is a JSON blob set by /api/extension/notify-update
// (see QRCallBox/functions/src/http/extension/notify-update.js). When
// type === "extension-update":
//   1. Show a system notification (Chrome enforces userVisibleOnly:true
//      on Web Push subscriptions, so a notification on every push is
//      non-optional — we make it meaningful).
//   2. Run checkForUpdate() immediately so the in-shell pill also lights
//      up; the user gets the signal whether they look at the OS
//      notification or open the extension.
self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data?.json() ?? {}; } catch (e) { /* malformed */ }

  event.waitUntil((async () => {
    if (payload.type === "extension-update") {
      const title   = payload.title   || `APAISuite ${payload.version || ""} available`;
      const message = payload.message || "Click to download and reload the extension.";
      const url     = payload.downloadUrl || "https://qrcallbox.com/extension/";
      await self.registration.showNotification(title, {
        body: message,
        icon: chrome.runtime.getURL("assets/icons/suite-128.png"),
        tag:  "extension-update",   // dedupe: replaces prior pending pill
        data: { url },
      });
      // Fire-and-forget. Updater writes to chrome.storage.local; the shell
      // page's updater_ui subscription picks up the change and re-renders.
      await checkForUpdate().catch((e) => {
        console.warn("[SW push] checkForUpdate after push failed:", e?.message);
      });
    } else {
      console.debug("[SW push] unknown payload type, ignoring:", payload);
    }
  })());
});

// Click the OS notification → open the download landing page.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url;
  if (!url) return;
  event.waitUntil(chrome.tabs.create({ url }).catch(() => {}));
});

// Ensure we have a Push subscription registered with QRCallBox. Fires
// on every SW wake; the function is internally throttled to one register
// POST per 7 days (see shared/push.js).
ensurePushSubscription().catch((e) => {
  console.warn("[SW push] ensurePushSubscription threw:", e?.message);
});

// ── Sanity log on SW wake ──────────────────────────────────────
{
  const summaries = listModules().map((m) => {
    const id = m.manifest.id;
    const handlers = m.manifest.service?.handlers ?? {};
    const names = Object.keys(handlers);
    return `${id} (${names.length} handlers: ${names.join(", ") || "none"})`;
  });
  console.log(
    `[APAISuite SW] worker boot — ${summaries.length} module(s) registered: ${summaries.join("; ") || "(none)"}`
  );
}
