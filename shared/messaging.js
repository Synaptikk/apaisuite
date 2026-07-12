// shared/messaging.js
//
// Module-aware messaging:
//   host.messaging.send(type, payload)         → SW handler for this module
//   host.messaging.sendToTab(tabId, type, ...) → content-script handler (with
//                                                 re-injection fallback on
//                                                 "Receiving end does not exist")
//   host.messaging.on(type, handler)           → SW-broadcast subscription
//                                                 (for streaming progress)
//   host.messaging.broadcast(type, payload)    → emit to other extension pages
//
// All messages carry { module, type, ...payload } so the SW dispatcher in
// background/service_worker.js can route by (module, type) without collision.

export function createMessaging(moduleId) {
  return {
    send(type, payload = {}) {
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ module: moduleId, type, ...payload }, (resp) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!resp) return reject(new Error(`no response from ${moduleId}.${type}`));
          if (!resp.ok) return reject(new Error(resp.error ?? `${moduleId}.${type} failed`));
          resolve(resp);
        });
      });
    },

    // Like send() but resolves with the raw response regardless of `ok`.
    // Use when the caller needs to differentiate between specific error
    // codes (e.g. `r?.error === "auth-opening"` flow control). Rejects only
    // on transport errors (chrome.runtime.lastError) or missing response.
    // Adds a per-call timeoutMs so callers can guard against a non-responsive
    // SW (the dispatcher's `return true` keeps channels open indefinitely).
    sendRaw(type, payload = {}, { timeoutMs = 60_000 } = {}) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`${moduleId}.${type} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        chrome.runtime.sendMessage({ module: moduleId, type, ...payload }, (resp) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!resp) return reject(new Error(`no response from ${moduleId}.${type}`));
          resolve(resp);
        });
      });
    },

    // Send to a content script with the canonical MV3 defensive pattern:
    // try, and if the receiver isn't there, re-inject the listed scripts
    // (in MAIN or ISOLATED world per contentScriptFile entries), then retry.
    async sendToTab(tabId, type, payload = {}, { fallbackScripts = [] } = {}) {
      const msg = { module: moduleId, type, ...payload };
      try {
        return await sendOnce(tabId, msg);
      } catch (err) {
        if (!isReceivingEndMissing(err) || !fallbackScripts.length) throw err;
        // Re-inject and retry once
        for (const script of fallbackScripts) {
          await chrome.scripting.executeScript({
            target: { tabId, allFrames: script.allFrames ?? false },
            files: [script.file],
            world: script.world ?? "ISOLATED",
          }).catch((e) => console.warn(`[APAISuite messaging] re-inject ${script.file} failed:`, e));
        }
        return await sendOnce(tabId, msg);
      }
    },

    // Subscribe to broadcast messages for this module.
    //
    // IMPORTANT: the returned unsubscribe function MUST be called from the
    // module's cleanup() — otherwise listeners accumulate on every mount of
    // the module. The shell unmounts but does not garbage-collect listeners.
    on(type, handler) {
      const listener = (msg) => {
        if (msg?.module !== moduleId) return;
        if (msg?.type   !== type)     return;
        handler(msg);
      };
      chrome.runtime.onMessage.addListener(listener);
      return () => chrome.runtime.onMessage.removeListener(listener);
    },

    // Emit a broadcast event from a service handler. Other extension pages
    // (the shell UI) receive it via .on(...).
    broadcast(type, payload = {}) {
      chrome.runtime.sendMessage({ module: moduleId, type, ...payload })
        .catch((e) => console.debug(`[APAISuite messaging] broadcast ${moduleId}.${type} swallowed:`, e?.message ?? e));
    },
  };
}

function sendOnce(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(resp);
    });
  });
}

function isReceivingEndMissing(err) {
  const m = String(err?.message ?? err).toLowerCase();
  return m.includes("receiving end does not exist")
      || m.includes("could not establish connection");
}
