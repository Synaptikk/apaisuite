// modules/metricshot/lib/capture.js
//
// Screenshot capture using chrome.debugger (CDP). Mirrors the visibility-spoof
// pattern in modules/sparkfraud/service.js:204-231 and the attach/detach
// tracking in modules/aurorbuddy/lib/evidence_downloader.js:130-190. Runs in
// the service worker.
//
// Contract:
//   captureMetric(metric) →
//     { ok: true,  pngBase64, width, height, tabId, capturedAt }
//     { ok: false, reason, tabId?, capturedAt }
//
// Never throws — always resolves to a shaped result so the caller (service.js)
// can log + retry uniformly.
//
// Safety:
//   - Only reads. No clicks, no form submits, no navigations other than the
//     initial "open the URL" and (if the tab wandered) a re-navigation to
//     the target URL.
//   - Every attach is paired with a detach in `finally`. A tab-level Set
//     tracks in-flight attaches so overlapping calls to the same tab don't
//     collide with "another debugger is already attached".
//   - Detects login/SSO landings and refuses to capture — no bad screenshot
//     ever leaves this module.

import { looksLikeAuthWall } from "./validate.js";
import { SSO_SELECTORS, createAuth } from "../../../shared/auth.js";
import { getUserHomeStore } from "../../../shared/userStore.js";

const _auth = createAuth("metricshot");

const CDP_VERSION = "1.3";
const TAG = "[metricshot capture]";

// Tabs where we have CDP attached, tracked so we don't double-attach.
const _attached = new Set();
chrome.tabs?.onRemoved?.addListener?.((tabId) => _attached.delete(tabId));
chrome.debugger?.onDetach?.addListener?.((source) => {
  if (source?.tabId != null) _attached.delete(source.tabId);
});

/**
 * @param {object} metric  Metric config (see lib/metrics.js).
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<object>}  Shaped result — never throws.
 */
export async function captureMetric(metric, opts = {}) {
  const capturedAt = Date.now();
  let tabId = null;
  let attached = false;
  let deviceOverridden = false;

  // Progress breadcrumb hook. Lets the caller trace exactly which phase a
  // capture stalls on (preview showed "start" then silence = a hung await).
  // No-op safe if not provided.
  const step = (name, extra) => { try { opts.onStep?.(name, extra); } catch { /* ignore */ } };

  try {
    step("resolve-url");
    // 1. Locate / open the tab.
    const resolvedUrl = await _expandUrlTemplates(metric.url);
    const target = new URL(resolvedUrl);
    const originPattern = `${target.origin}/*`;
    const existing = await chrome.tabs.query({ url: originPattern });
    let tab;
    let openedFresh = false;
    if (existing.length) {
      // Only reuse a tab that's already on the exact viz + filters we want.
      // Otherwise we'd hijack the user's own Tableau tab (navigating it to
      // a different store or viz mid-session). The URL comparison is
      // hash-route aware and ignores Tableau session-only params.
      const matching = existing
        .filter((t) => typeof t.id === "number" && _pathMatches(t.url, resolvedUrl))
        .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
      tab = matching[0];
    }
    if (!tab) {
      tab = await chrome.tabs.create({ url: resolvedUrl, active: false });
      openedFresh = true;
    }
    tabId = tab.id;
    step("tab-ready", { tabId, openedFresh });

    // 2. Attach CDP + inject visibility spoof BEFORE navigation. This is
    //    critical for Tableau / other viz that pause rendering on hidden
    //    tabs — same rationale as sparkfraud/service.js:197-203.
    attached = await _attach(tabId);
    step("cdp-attached", { attached });
    if (attached) {
      await _sendCdp(tabId, "Page.enable", {}).catch(() => {});
      await _sendCdp(tabId, "Page.addScriptToEvaluateOnNewDocument", {
        source: `
          Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
          Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
          document.addEventListener('visibilitychange', e => e.stopImmediatePropagation(), true);
        `,
      }).catch((e) => console.warn(TAG, "spoof failed:", e?.message ?? e));
    }

    // 3. Optional viewport override — apply BEFORE we (possibly) reload so
    //    the page lays out at the intended width from the start.
    const cap = metric.capture || {};
    if (attached && (cap.viewportWidth || cap.viewportHeight || cap.zoom !== 1)) {
      try {
        await _sendCdp(tabId, "Emulation.setDeviceMetricsOverride", {
          width: cap.viewportWidth || 1440,
          height: cap.viewportHeight || 1000,
          deviceScaleFactor: 1,
          mobile: false,
        });
        if (cap.zoom && cap.zoom !== 1) {
          // NOTE: Emulation.setPageScaleFactor is pinch-zoom (compositor only)
          // — it does NOT reflow layout, and Tableau ignores it, so content
          // still overflowed and got clipped. Use CSS zoom on the root element
          // instead: it actually shrinks + reflows the page so a zoom < 1 fits
          // more of the report into the capture surface. Applied via
          // addScriptToEvaluateOnNewDocument so it survives the upcoming reload.
          const zoomJs = `try{document.documentElement.style.zoom='${cap.zoom}';}catch(e){}`;
          await _sendCdp(tabId, "Page.addScriptToEvaluateOnNewDocument", { source: zoomJs }).catch(() => {});
          await chrome.scripting.executeScript({
            target: { tabId, allFrames: false },
            func: (z) => { try { document.documentElement.style.zoom = String(z); } catch (e) {} },
            args: [cap.zoom],
          }).catch(() => {});
        }
        deviceOverridden = true;
      } catch (e) {
        console.warn(TAG, "device metrics override failed:", e?.message ?? e);
      }
    }

    // 4. Ensure the tab is on the right URL AND that our visibility spoof
    //    applies to the live document.
    //    The spoof is registered via Page.addScriptToEvaluateOnNewDocument,
    //    which only runs for a *new* document. So:
    //      - Wrong URL       → navigate (loads a new doc, spoof applies).
    //      - Freshly opened  → reload (spoof was registered after the initial
    //                          navigation started).
    //      - Reused + correct URL → reload anyway. Without a fresh document
    //        the spoof never runs on THIS doc; a hidden/reused Tableau tab
    //        then stays paused and renders blank — the classic "preview works
    //        once, then never loads again" bug.
    const currentTab = await chrome.tabs.get(tabId);
    const urlOk = !!currentTab.url
      && new URL(currentTab.url).origin === target.origin
      && _pathMatches(currentTab.url, resolvedUrl);
    const needsNavigate = !urlOk;

    if (needsNavigate) {
      await chrome.tabs.update(tabId, { url: resolvedUrl });
    } else if (attached) {
      // Correct URL already (fresh or reused) — reload so the spoof applies.
      await chrome.tabs.reload(tabId).catch(() => {});
    }

    // 5. Wait for tab.status === "complete".
    step("wait-load", { needsNavigate });
    const loadedOk = await _waitForTabStatus(tabId, "complete", cap.timeoutMs ?? 60_000);
    if (!loadedOk) return _fail(tabId, capturedAt, "page did not finish loading within timeout");
    step("loaded");

    // 6. SSO check: if URL doesn't match target, try one click on the SSO
    //    button, then wait to land on target.
    let landed = await chrome.tabs.get(tabId);
    if (!_pathMatches(landed.url, resolvedUrl)) {
      const clicked = await _tryClickSso(tabId).catch(() => null);
      if (clicked) {
        await _waitForUrlMatch(tabId, resolvedUrl, cap.timeoutMs ?? 60_000);
        landed = await chrome.tabs.get(tabId);
      }
      if (!_pathMatches(landed.url, resolvedUrl)) {
        return _fail(tabId, capturedAt, `landed on unexpected URL (possible auth wall): ${_safeUrl(landed.url)}`);
      }
    }

    // 7. In-page authenticity check: title/H1 sniff. Guards against a login
    //    surface served under the same origin/path.
    step("auth-probe");
    const auth = await _readAuthProbe(tabId);
    if (auth.probeError) {
      // The tab wouldn't run our probe script within the timeout — almost
      // always a wedged/zombie reused tab. Reload it so the NEXT scheduler
      // retry starts from a fresh document instead of re-hitting the same
      // stuck one, then fail fast with an actionable message.
      await chrome.tabs.reload(tabId).catch(() => {});
      return _fail(tabId, capturedAt, `page is unresponsive (auth probe failed: ${auth.probeError}) — the Tableau tab was stuck; reloaded it, retry should recover`);
    }
    if (looksLikeAuthWall(auth)) {
      return _fail(tabId, capturedAt, `page appears to be a login/access-denied surface (title="${(auth.title || "").slice(0, 60)}")`);
    }

    // 8. Optional required-selector gate.
    if (cap.requiredSelector) {
      step("wait-required-selector", { selector: cap.requiredSelector });
      const ok = await _waitForSelectorVisible(tabId, cap.requiredSelector, cap.timeoutMs ?? 60_000);
      if (!ok) return _fail(tabId, capturedAt, `requiredSelector never became visible: ${cap.requiredSelector}`);
    }

    // 8b. Inject Tableau parameter values (if configured). Runs BEFORE the
    //     settle delay so the settle gives Tableau time to re-query the viz
    //     with the injected values applied. See data/defaults.js::vizpick-score
    //     for why URL params are unreliable here.
    if (cap.parameterValues && Object.keys(cap.parameterValues).length) {
      const resolved = {};
      for (const [k, v] of Object.entries(cap.parameterValues)) {
        resolved[k] = await _expandUrlTemplates(v);
      }
      // Guard: if any template token failed to resolve (e.g. home store not
      // captured yet), the literal "{{TOKEN}}" would be injected into the
      // Tableau widget, which rejects it and silently falls back to its
      // default store ("1") — producing a blank, wrong-store report. Fail
      // loudly instead so the scheduler retries and the user isn't misled.
      const unresolved = Object.entries(resolved)
        .filter(([, v]) => typeof v === "string" && v.includes("{{"))
        .map(([k]) => k);
      if (unresolved.length) {
        return _fail(
          tabId, capturedAt,
          `could not resolve parameter value(s) [${unresolved.join(", ")}] — set your store in Settings → Defaults (or use Auto-detect); refusing to capture a default-store report`
        );
      }
      // Wait for Tableau's loading overlay (.wcGlassPane) to be dismissed so
      // the parameter widget's event handlers are wired up. If we inject
      // before that, our events are silently dropped and the default value
      // stands. Bounded so we don't hang if the overlay never appears.
      await _waitForTableauReady(tabId, Math.min(cap.timeoutMs ?? 60_000, 20_000)).catch(() => {});

      const injectRes = await _injectTableauParametersWithRetry(tabId, resolved, {
        attempts: 4, gapMs: 2_500,
      });
      // Verify the values actually stuck. If not a single required parameter
      // matched, Tableau is still on its default store — refuse to capture a
      // misleading blank/wrong-store report rather than warn-and-continue.
      const verify = await _verifyParameterValues(tabId, resolved);
      if (!verify.allMatch) {
        const missing = Object.keys(resolved).filter((k) => !verify.matched.includes(k));
        return _fail(
          tabId, capturedAt,
          `Tableau parameter(s) [${missing.join(", ")}] did not apply (set=${injectRes?.setCount ?? 0}); refusing to capture a default-store report`
        );
      }
    }

    // 9. DOM-stability + settle delay.
    step("wait-dom-stable");
    await _waitForDomStable(tabId, 1000, Math.min(cap.timeoutMs ?? 60_000, 15_000)).catch(() => {});
    if (cap.settleDelayMs > 0) { step("settle-delay", { ms: cap.settleDelayMs }); await _delay(cap.settleDelayMs); }

    // 10. Hide sticky headers / configured selectors.
    let restoreHide = null;
    if (Array.isArray(cap.hideSelectors) && cap.hideSelectors.length) {
      restoreHide = await _hideSelectors(tabId, cap.hideSelectors).catch(() => null);
    }

    let pngBase64 = null;
    let width = null;
    let height = null;
    let clipUsed = null;
    let anchorRegion = null;
    step("capture", { mode: cap.mode });
    try {
      // 11. Capture.
      if (cap.mode === "selector" && cap.selector) {
        const rect = await _selectorRect(tabId, cap.selector);
        if (!rect) return _fail(tabId, capturedAt, `capture.selector not found: ${cap.selector}`);
        const shot = await _sendCdp(tabId, "Page.captureScreenshot", {
          format: "png",
          clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
        });
        pngBase64 = shot?.data;
        width = Math.round(rect.width);
        height = Math.round(rect.height);
      } else if (cap.mode === "region") {
        let region = cap.clip;
        if (!region && Array.isArray(cap.containText) && cap.containText.length) {
          step("region-search", { anchors: cap.containText });
          const res = await _regionForContainText(tabId, cap.containText, Math.min(cap.timeoutMs ?? 60_000, 30_000));
          if (!res.region) {
            return _fail(tabId, capturedAt,
              `containText: missing anchors after ${res.waitedMs}ms — ${res.missing.map(m => `"${m}"`).join(", ")} (found: ${res.foundNames.join(", ") || "none"})`);
          }
          region = res.region;
          step("region-found", { x: region.x, y: region.y, width: region.width, height: region.height, anchors: res.foundNames?.length });
        }
        if (!region) return _fail(tabId, capturedAt, "region mode requires clip or containText");
        // Apply padding + clamp to viewport so we don't ask CDP for a clip
        // that spills off the rendered surface.
        let pad = cap.padding || { top: 0, right: 0, bottom: 0, left: 0 };
        const vw = cap.viewportWidth  || 1500;
        const vh = cap.viewportHeight || 1000;
        const MIN_DIM = 100;  // must clear validate.js's 100×100 floor

        // Self-heal: if the saved padding (e.g. a too-aggressive crop) would
        // collapse the region below the min capture size, drop the padding
        // and use the raw anchor region. Prevents a bad crop from silently
        // bricking every capture — the screenshot degrades to "uncropped"
        // instead of "13×12 garbage".
        const paddedW = region.width  + pad.left + pad.right;
        const paddedH = region.height + pad.top  + pad.bottom;
        if ((paddedW < MIN_DIM || paddedH < MIN_DIM) && region.width >= MIN_DIM && region.height >= MIN_DIM) {
          step("padding-collapsed", { paddedW, paddedH, regionW: region.width, regionH: region.height });
          pad = { top: 0, right: 0, bottom: 0, left: 0 };
        }

        const px = Math.max(0, region.x - pad.left);
        const py = Math.max(0, region.y - pad.top);
        // Guard against a bad saved crop: never ask CDP for a degenerate or
        // off-surface clip (that returns no image). Clamp width/height to at
        // least 1px and keep the box inside the viewport.
        const pw = Math.max(1, Math.min(vw - px, region.width  + pad.left + pad.right));
        const ph = Math.max(1, Math.min(vh - py, region.height + pad.top  + pad.bottom));
        const shot = await _sendCdp(tabId, "Page.captureScreenshot", {
          format: "png",
          clip: { x: px, y: py, width: pw, height: ph, scale: 1 },
        });
        pngBase64 = shot?.data;
        width  = Math.round(pw);
        height = Math.round(ph);
        // Expose the exact box we cropped + the anchor region before padding.
        // The UI's crop tool maps a sub-rectangle drawn on the preview back to
        // padding insets relative to `anchorRegion`.
        clipUsed = { x: px, y: py, width: pw, height: ph };
        anchorRegion = { x: region.x, y: region.y, width: region.width, height: region.height };
      } else {
        const shot = await _sendCdp(tabId, "Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: cap.mode === "fullpage",
        });
        pngBase64 = shot?.data;
      }
    } finally {
      if (restoreHide) await restoreHide().catch(() => {});
    }

    if (!pngBase64) return _fail(tabId, capturedAt, "Page.captureScreenshot returned no data");
    step("captured", { width, height, bytes: pngBase64.length });

    return {
      ok: true,
      pngBase64,
      width, height,
      clipUsed,
      anchorRegion,
      tabId,
      capturedAt,
    };
  } catch (err) {
    return _fail(tabId, capturedAt, String(err?.message ?? err));
  } finally {
    if (deviceOverridden) {
      await _sendCdp(tabId, "Emulation.clearDeviceMetricsOverride", {}).catch(() => {});
    }
    if (attached) await _detach(tabId).catch(() => {});
  }
}

// ── CDP wrappers ──────────────────────────────────────────────────────────

async function _attach(tabId) {
  if (_attached.has(tabId)) return true;
  try {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
    _attached.add(tabId);
    return true;
  } catch (e) {
    // Common: another extension/DevTools already attached. We can still try
    // to capture without the spoof — the page might just show a stale render.
    console.warn(TAG, "attach failed:", e?.message ?? e);
    return false;
  }
}

async function _detach(tabId) {
  try { await chrome.debugger.detach({ tabId }); } catch (_) {}
  _attached.delete(tabId);
}

async function _sendCdp(tabId, method, params) {
  // chrome.debugger.sendCommand has NO built-in timeout. Against a reused /
  // wedged Tableau tab (openedFresh:false), commands like Page.enable or
  // Emulation.setDeviceMetricsOverride can hang forever — and a trailing
  // .catch() at the call site does nothing because the await never settles.
  // Wrap every command so a stuck CDP call rejects fast and the capture
  // pipeline can surface an error / retry instead of freezing at cdp-attached.
  return _withTimeout(
    chrome.debugger.sendCommand({ tabId }, method, params),
    15_000,
    `CDP ${method}`,
  );
}

// Race a promise against a timeout. chrome.scripting.executeScript and
// chrome.debugger.sendCommand have NO built-in timeout — against a wedged /
// zombie tab (e.g. a reused Tableau session stuck mid-render) they never
// resolve, and the only backstop was the blunt 90s capture watchdog. Wrapping
// individual probes lets a stuck step fail fast so the capture can surface a
// useful error (and the scheduler can retry) instead of hanging.
function _withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label || "operation"} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// ── Tab / navigation helpers ─────────────────────────────────────────────

async function _waitForTabStatus(tabId, wanted, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return false;
    if (t.status === wanted) return true;
    await _delay(200);
  }
  return false;
}

async function _waitForUrlMatch(tabId, targetUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return false;
    if (t.status === "complete" && _pathMatches(t.url, targetUrl)) return true;
    await _delay(400);
  }
  return false;
}

// Match target: same origin AND either same pathname prefix OR (for
// hash-routed apps like Tableau) same fragment route. Hash-routed apps
// keep the meaningful route in `#/...`; pathname is often just "/", so
// pathname-only comparison lets a Tableau tab on ANY viz register as
// "already there". Compare the hash's route portion (before any `?`)
// and ignore Tableau session identifiers like `:iid` in the query string
// so we don't force needless renavigation on a tab that's on the right viz
// but has a stale interaction id.
function _pathMatches(currentUrl, targetUrl) {
  try {
    const c = new URL(currentUrl);
    const t = new URL(targetUrl);
    if (c.origin !== t.origin) return false;

    // Hash-routed app: require the fragment route to match.
    const tHash = t.hash || "";
    if (tHash && tHash !== "#") {
      const tRoute = _hashRoute(tHash);
      const cRoute = _hashRoute(c.hash || "");
      if (tRoute !== cRoute) return false;
      // Additionally check meaningful query params in the fragment (Tableau
      // filters like Store=1458 live there when the hash contains a `?`).
      const tParams = _hashParams(tHash);
      const cParams = _hashParams(c.hash || "");
      for (const [k, v] of tParams) {
        // Ignore Tableau's session/UI-only params — matching them would
        // force a reload every time the tab's iid changed.
        if (k === ":iid" || k === ":linktarget" || k === ":embed") continue;
        if (cParams.get(k) !== v) return false;
      }
      return true;
    }

    // Path-routed: existing behavior.
    if (t.pathname === "/" || !t.pathname) return true;
    return c.pathname === t.pathname || c.pathname.startsWith(t.pathname);
  } catch {
    return false;
  }
}

// Extract the route portion of a URL fragment: `#/site/foo/views/bar?...`
// → `/site/foo/views/bar`.
function _hashRoute(hash) {
  const body = hash.replace(/^#/, "");
  const q = body.indexOf("?");
  return q >= 0 ? body.slice(0, q) : body;
}

// Extract query-string params living inside a URL fragment (Tableau's
// convention: `#/site/OnlineGrocery/views/VizPick/VizPickDetails?Store=1458`).
function _hashParams(hash) {
  const q = hash.indexOf("?");
  if (q < 0) return new URLSearchParams();
  return new URLSearchParams(hash.slice(q + 1));
}

async function _tryClickSso(tabId) {
  return _auth.clickSso(tabId, SSO_SELECTORS);
}

// ── In-page probes (executeScript, ISOLATED world by default) ────────────

async function _readAuthProbe(tabId) {
  try {
    const [{ result }] = await _withTimeout(chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func: () => ({
        title: document.title || "",
        headings: [
          ...Array.from(document.querySelectorAll("h1, h2")).slice(0, 3).map((h) => (h.textContent || "").trim()),
        ],
      }),
    }), 15_000, "auth-probe executeScript");
    return result || { title: "", headings: [] };
  } catch (e) {
    // A wedged tab makes executeScript hang; the timeout lands here. Return a
    // sentinel so the caller can distinguish "probe failed" from "clean page".
    return { title: "", headings: [], probeError: String(e?.message ?? e) };
  }
}

async function _waitForSelectorVisible(tabId, selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        args: [selector],
        // Same-origin iframe walk: Tableau's actual viz is inside an
        // <iframe src="…/t/OnlineGrocery/views/…?:embed=y…"> when opened
        // via the outer VizPortal URL. When opened via the direct embed
        // URL the viz DOM is at top level. Either way this searches both.
        // Cross-origin frames throw on contentDocument access — caught + skipped.
        //
        // Visibility: many Tableau wrapper divs have height 0 (position:absolute
        // children fill them), so we can't require w > 0 && h > 0. Use
        // offsetParent (falsy when display:none or position:fixed detached).
        // Fall back to any non-zero dimension for fixed-positioned elements.
        func: (sel) => {
          function isVisible(el) {
            if (!el) return false;
            if (el.tagName === "IFRAME" || el.tagName === "HTML") return true;
            if (el.offsetParent !== null) return true;
            const r = el.getBoundingClientRect();
            return r.width > 0 || r.height > 0;
          }
          function findIn(doc) {
            const el = doc.querySelector(sel);
            if (isVisible(el)) return true;
            for (const f of doc.querySelectorAll("iframe")) {
              try {
                const inner = f.contentDocument;
                if (inner && findIn(inner)) return true;
              } catch (_) { /* cross-origin — skip */ }
            }
            return false;
          }
          return findIn(document);
        },
      });
      if (result === true) return true;
    } catch (_) { /* tab may be mid-nav */ }
    await _delay(300);
  }
  return false;
}

async function _waitForDomStable(tabId, quietMs, maxMs) {
  const start = Date.now();
  let lastCount = -1;
  let quietSince = Date.now();
  while (Date.now() - start < maxMs) {
    let count;
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        func: () => document.getElementsByTagName("*").length,
      });
      count = result;
    } catch (_) { return; }
    if (count === lastCount) {
      if (Date.now() - quietSince >= quietMs) return;
    } else {
      lastCount = count;
      quietSince = Date.now();
    }
    await _delay(250);
  }
}

async function _selectorRect(tabId, selector) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      args: [selector],
      func: (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.max(0, r.left), y: Math.max(0, r.top), width: r.width, height: r.height };
      },
    });
    if (!result || result.width < 1 || result.height < 1) return null;
    return result;
  } catch (_) { return null; }
}

/**
 * Compute the smallest bounding rect that includes an element matching each
 * of the provided text strings. Polls up to `timeoutMs` because Tableau
 * viz zones render several seconds after the loading gate.
 *
 * Anchor matching is:
 *   1. exact-match on trimmed textContent (preferred)
 *   2. case-insensitive exact match
 *   3. case-insensitive substring match against a small-text leaf element
 *
 * Lenient behavior: as long as at least 2 anchors are found, returns the
 * bounding box of the found ones. Some Tableau text renders as image tiles
 * (no DOM text), so requiring 100% match would frequently fail. `missing` is
 * still populated so callers can log/warn.
 *
 * Walks same-origin iframes. Returns `{region, missing, foundNames, waitedMs}`.
 */
async function _regionForContainText(tabId, texts, timeoutMs = 20_000) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let last = { region: null, missing: [...texts], foundNames: [], waitedMs: 0 };
  const MIN_FOUND = Math.min(2, texts.length);
  while (Date.now() < deadline) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        args: [texts],
        func: (needles) => {
          function findByText(doc, needle) {
            const wanted = String(needle).trim();
            const wantedLc = wanted.toLowerCase();
            for (const el of doc.querySelectorAll("*")) {
              if ((el.textContent || "").trim() === wanted) return el;
            }
            for (const el of doc.querySelectorAll("*")) {
              if ((el.textContent || "").trim().toLowerCase() === wantedLc) return el;
            }
            for (const el of doc.querySelectorAll("*")) {
              const t = (el.textContent || "").trim();
              if (t.length && t.length < 200 && t.toLowerCase().includes(wantedLc)
                  && (el.children.length === 0 || t.length < wanted.length + 60)) {
                return el;
              }
            }
            return null;
          }
          function collectFrames(root) {
            const out = [root];
            for (const f of root.querySelectorAll("iframe")) {
              try {
                const d = f.contentDocument;
                if (d) out.push(...collectFrames(d));
              } catch (_) {}
            }
            return out;
          }
          const rects = [];
          const foundNames = [];
          const missing = [];
          for (const needle of needles) {
            let hit = null;
            for (const d of collectFrames(document)) {
              hit = findByText(d, needle);
              if (hit) break;
            }
            if (!hit) { missing.push(needle); continue; }
            const r = hit.getBoundingClientRect();
            if (r.width < 1 || r.height < 1) { missing.push(needle); continue; }
            rects.push({ x1: r.left, y1: r.top, x2: r.right, y2: r.bottom });
            foundNames.push(needle);
          }
          if (!rects.length) return { region: null, missing, foundNames };
          const region = rects.reduce((acc, r) => ({
            x1: Math.min(acc.x1, r.x1),
            y1: Math.min(acc.y1, r.y1),
            x2: Math.max(acc.x2, r.x2),
            y2: Math.max(acc.y2, r.y2),
          }));
          return {
            missing,
            foundNames,
            region: {
              x: Math.max(0, Math.floor(region.x1)),
              y: Math.max(0, Math.floor(region.y1)),
              width: Math.ceil(region.x2 - region.x1),
              height: Math.ceil(region.y2 - region.y1),
            },
          };
        },
      });
      last = { ...result, waitedMs: Date.now() - started };
      // Accept once we have enough anchors — either all, or MIN_FOUND if the
      // rest keep missing.
      if (result?.region && result.foundNames.length >= MIN_FOUND
          && (result.missing.length === 0 || Date.now() > deadline - 2_000)) {
        return last;
      }
    } catch (_) { /* tab mid-nav */ }
    await _delay(500);
  }
  return last;
}

async function _hideSelectors(tabId, selectors) {  // Inject a style tag; return a restore fn that removes it.
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      args: [selectors],
      func: (sels) => {
        const id = "__metricshot_hide__";
        let tag = document.getElementById(id);
        if (!tag) {
          tag = document.createElement("style");
          tag.id = id;
          document.documentElement.appendChild(tag);
        }
        tag.textContent = sels.map((s) => `${s} { visibility: hidden !important; }`).join("\n");
      },
    });
  } catch (_) { /* fall through */ }
  return async () => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        func: () => {
          const tag = document.getElementById("__metricshot_hide__");
          if (tag) tag.remove();
        },
      });
    } catch (_) {}
  };
}

// ── Misc ─────────────────────────────────────────────────────────────────

/**
 * Wait until Tableau's loading overlay (.wcGlassPane) has been dismissed
 * (display:none or opacity 0) and at least one parameter widget is mounted.
 * Tableau shows the parameter's default value in the DOM before its event
 * handlers are wired up; injecting during that window silently no-ops.
 */
async function _waitForTableauReady(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        func: () => {
          function checkIn(doc) {
            const glass = doc.querySelector(".wcGlassPane");
            if (glass) {
              const cs = getComputedStyle(glass);
              const visible = cs.display !== "none" && parseFloat(cs.opacity || "1") > 0.05;
              if (visible) return false;                                    // still loading
            }
            const hasParam = doc.querySelector(".tab-parameter textarea.QueryBox");
            if (hasParam) return true;
            for (const f of doc.querySelectorAll("iframe")) {
              try {
                const inner = f.contentDocument;
                if (inner && checkIn(inner)) return true;
              } catch (_) { /* cross-origin */ }
            }
            return false;
          }
          return checkIn(document);
        },
      });
      if (result === true) return true;
    } catch (_) { /* mid-nav */ }
    await _delay(400);
  }
  return false;
}

/**
 * Inject parameters, then verify they stuck. If a value didn't take, retry
 * after a gap. Tableau's parameter widget takes a beat between mount and
 * "handlers ready", and its input listener is finicky about event ordering.
 * A few retries with growing gaps is cheaper than tuning the timing exactly.
 */
async function _injectTableauParametersWithRetry(tabId, values, { attempts, gapMs }) {
  let last = null;
  const remaining = { ...values };
  for (let i = 0; i < attempts && Object.keys(remaining).length; i++) {
    last = await _injectTableauParameters(tabId, remaining);
    if (last?.setNames) for (const n of last.setNames) delete remaining[n];
    if (!Object.keys(remaining).length) return last;
    // Ask Tableau to actually commit by verifying the value stuck. If it
    // didn't, wait then retry.
    const verified = await _verifyParameterValues(tabId, values);
    if (verified.allMatch) return last;
    for (const n of verified.matched) delete remaining[n];
    if (!Object.keys(remaining).length) return last;
    await _delay(gapMs);
  }
  return last || { setCount: 0, setNames: [], missing: Object.keys(values) };
}

/** Read each parameter's current value from the DOM. Returns which match. */
async function _verifyParameterValues(tabId, values) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      args: [values],
      func: (want) => {
        function checkIn(doc, out) {
          for (const p of doc.querySelectorAll(".tab-parameter")) {
            const titleEl = p.querySelector(".ParamTitle[title]");
            if (!titleEl) continue;
            const title = titleEl.getAttribute("title");
            if (!(title in want)) continue;
            const textarea = p.querySelector("textarea.QueryBox");
            if (!textarea) continue;
            if (String(textarea.value) === String(want[title])) out.matched.push(title);
            else out.mismatched.push({ title, want: want[title], actual: textarea.value });
          }
          for (const f of doc.querySelectorAll("iframe")) {
            try {
              const inner = f.contentDocument;
              if (inner) checkIn(inner, out);
            } catch (_) {}
          }
        }
        const out = { matched: [], mismatched: [] };
        checkIn(document, out);
        return { ...out, allMatch: out.mismatched.length === 0 && out.matched.length === Object.keys(want).length };
      },
    });
    return result || { matched: [], mismatched: [], allMatch: false };
  } catch (_) {
    return { matched: [], mismatched: [], allMatch: false };
  }
}

/**
 * Inject values into Tableau parameter widgets by their display title.
 *
 * Tableau's URL-param support requires the workbook's internal parameter id
 * (often "Store Number (copy)_2219430255132946450") — brittle and unknown to
 * the analyst who authors a metric. Instead we find the `.tab-parameter`
 * whose `.ParamTitle[title="…"]` matches the requested display name, set
 * the textarea value via the native property setter, and dispatch the events
 * Tableau listens for.
 *
 * Tableau parameters commit on Enter or blur. Setting `.value` alone does
 * not fire the input listeners because Tableau uses input-event-based
 * bindings — we must dispatch a synthetic input event so React/Tableau's
 * controlled-input machinery sees the change. Then Enter triggers commit.
 * Blur is a belt-and-suspenders commit trigger.
 *
 * Also walks same-origin iframes.
 *
 * @returns {Promise<{setCount:number, missing:string[], setNames:string[]}>}
 */
async function _injectTableauParameters(tabId, values) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      args: [values],
      func: (paramValues) => {
        function primeIn(doc, out) {
          for (const p of doc.querySelectorAll(".tab-parameter")) {
            const titleEl = p.querySelector(".ParamTitle[title]");
            if (!titleEl) continue;
            const title = titleEl.getAttribute("title");
            if (!(title in paramValues)) continue;
            const textarea = p.querySelector("textarea.QueryBox");
            if (!textarea) continue;
            const value = String(paramValues[title]);
            try {
              // Reproduce the Enter-key commit path a human uses. Tableau
              // parses the DOM value on `keydown Enter`, not on `change`.
              textarea.focus();
              // Select all so the setter replaces existing text (Tableau's
              // Dojo-based input mirror may otherwise concatenate).
              textarea.select();
              const setter = Object.getOwnPropertyDescriptor(
                HTMLTextAreaElement.prototype, "value"
              ).set;
              setter.call(textarea, value);
              textarea.dispatchEvent(new Event("input", { bubbles: true }));
              textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
              textarea.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
              textarea.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
              textarea.dispatchEvent(new Event("change", { bubbles: true }));
              textarea.blur();
              out.setNames.push(title);
              out.setCount++;
            } catch (_) { /* keep trying others */ }
          }
          for (const f of doc.querySelectorAll("iframe")) {
            try {
              const inner = f.contentDocument;
              if (inner) primeIn(inner, out);
            } catch (_) { /* cross-origin — skip */ }
          }
        }
        const out = { setCount: 0, setNames: [], missing: [] };
        primeIn(document, out);
        for (const k of Object.keys(paramValues)) {
          if (!out.setNames.includes(k)) out.missing.push(k);
        }
        return out;
      },
    });
    return result;
  } catch (e) {
    return { setCount: 0, setNames: [], missing: Object.keys(values), error: String(e?.message ?? e) };
  }
}

function _fail(tabId, capturedAt, reason) {
  return { ok: false, reason, tabId, capturedAt };
}

/**
 * Expand `{{HOME_STORE}}` in a URL against the user's resolved home store
 * (shared/userStore.js). Unknown / unresolved tokens are left in place so
 * the failure is loud (Tableau will render its default store) rather than
 * silent (URL becomes `?Store=` and Tableau's parameter fallback kicks in).
 *
 * Currently supported tokens: `{{HOME_STORE}}`. Everything else is left as-is.
 */
async function _expandUrlTemplates(url) {
  if (!url || !url.includes("{{")) return url;
  let expanded = url;
  if (expanded.includes("{{HOME_STORE}}")) {
    const store = await getUserHomeStore().catch(() => null);
    if (store) expanded = expanded.replaceAll("{{HOME_STORE}}", store);
  }
  return expanded;
}

// Strip query + fragment before logging — we never surface raw URLs.
function _safeUrl(u) {
  try {
    const url = new URL(u);
    return `${url.origin}${url.pathname}`;
  } catch { return "<unparseable>"; }
}

function _delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
