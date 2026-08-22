// modules/metricshot/lib/capture.js
//
// Builds the posted image for a metric. Runs in the service worker.
//
// This used to screenshot the Tableau viz over CDP (chrome.debugger). It now
// prepares the tab, reads VizPick's own VizQL rows via lib/sources/
// vizpick_export.js, renders them with lib/render_card.js, and rasterises that
// through lib/rasterize.js. Same {ok, pngBase64, ...} contract as before, so
// service.js did not change — but no "debugger" permission, and no dependence
// on where Tableau happens to draw a panel this week.
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
//   - Detects login/SSO landings and refuses to capture, so a login page can
//     never be mistaken for data.
//   - Only VizPick metrics can be rendered: the card is built from parsed
//     VizPick rows. A metric pointing anywhere else fails with a clear reason
//     rather than posting something wrong.

import { looksLikeAuthWall } from "./validate.js";
import { SSO_SELECTORS, createAuth } from "../../../shared/auth.js";
import { getUserHomeStore } from "../../../shared/userStore.js";
import { mapRowToRingData } from "./sources/vizpick_snapshot.js";
import { getFollowUpSheets } from "./sources/followup_data.js";
import { renderMetricCard } from "./render_card.js";
import { svgToPngBase64 } from "./rasterize.js";

const _auth = createAuth("metricshot");

const TAG = "[metricshot capture]";


/**
 * @param {object} metric  Metric config (see lib/metrics.js).
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<object>}  Shaped result — never throws.
 */
export async function captureMetric(metric, opts = {}) {
  const capturedAt = Date.now();
  let tabId = null;
  // The store this run actually points Tableau at, captured off the
  // parameterValues resolution below. Used to look up the SAME store's
  // already-captured ring data from vizpick's Today snapshot (see step 11).
  let resolvedStore = null;

  // Progress breadcrumb hook. Lets the caller trace exactly which phase a
  // capture stalls on (preview showed "start" then silence = a hung await).
  // No-op safe if not provided.
  // Progress breadcrumb AND abort checkpoint.
  //
  // The abort check sits OUTSIDE the try on purpose: a caller that has given
  // up must be able to stop this capture, and swallowing the abort would
  // defeat that. Every phase boundary already calls step(), so this yields a
  // cancellation point at each one without threading a signal through every
  // helper.
  //
  // Why this exists (2026-08-21): service.js raced captureMetric against a 90s
  // watchdog and, on timeout, simply moved to the next attempt. The abandoned
  // capture kept running and kept driving the SAME Tableau tab, so attempt N+1
  // fought attempt N over one tab — visible in telemetry as attempt 1 logging
  // `settle-delay` and `scrape` while attempt 2 was logging `run-start`. The
  // overlap made each successive attempt likelier to hang, which is how one
  // screenshot became ~39 captures across 65 minutes.
  const step = (name, extra) => {
    if (opts.signal?.aborted) throw new CaptureAborted();
    try { opts.onStep?.(name, extra); } catch { /* ignore */ }
  };

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

    // 2. Keep the tab out of Chrome's discard path. Tableau stops painting in
    //    a background tab; the visibility unblock that fixes that now lives in
    //    content/tableau_capture.js (MAIN world, document_start), which the
    //    manifest already declares for this host. It used to be injected from
    //    here with CDP Page.addScriptToEvaluateOnNewDocument, which is what
    //    cost the extension the "debugger" permission.
    try { await chrome.tabs.update(tabId, { autoDiscardable: false }); } catch { /* best effort */ }
    step("tab-kept-awake");

    const cap = metric.capture || {};

    const currentTab = await chrome.tabs.get(tabId);
    const urlOk = !!currentTab.url
      && new URL(currentTab.url).origin === target.origin
      && _pathMatches(currentTab.url, resolvedUrl);
    const needsNavigate = !urlOk;

    if (needsNavigate) {
      await chrome.tabs.update(tabId, { url: resolvedUrl });
    } else {
      // Correct URL already (fresh or reused) — reload so the content script's
      // fetch patch is installed before the viz issues its VizQL requests. A
      // tab that was already open when the module loaded has an empty ring.
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
      const ok = await _waitForSelectorVisible(tabId, cap.requiredSelector, cap.timeoutMs ?? 60_000, opts.signal);
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
      if (resolved.Store) resolvedStore = resolved.Store;
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
    await _waitForDomStable(tabId, 1000, Math.min(cap.timeoutMs ?? 60_000, 15_000), opts.signal)
      // Swallow ordinary failures (this wait is best-effort) but never an
      // abort — that has to unwind.
      .catch((e) => { if (e instanceof CaptureAborted) throw e; });
    if (cap.settleDelayMs > 0) { step("settle-delay", { ms: cap.settleDelayMs }); await _delay(cap.settleDelayMs); }

    // 11. Render the card from VizPick's own numbers.
    //
    // This replaced a CDP Page.captureScreenshot of the Tableau viz. The old
    // path had to find the panel by matching visible anchor strings, pad the
    // crop so glyph tails weren't clipped, and wait for the viz to finish
    // painting — all of which broke whenever Tableau reflowed. Reading the
    // VizQL rows the page already fetched is both steadier and honest about
    // what the numbers are.
    // 10b. Get VizPick's numbers — from the market rollup's own capture if it
    // has them, and only otherwise by exporting them again ourselves.
    //
    // vizpick's Today crawl already exports the same sheets this module needs,
    // for every store in the market. Re-exporting them here meant two Tableau
    // sessions pulling identical rows minutes apart, each able to report a
    // different "now". sources/followup_data.js owns that preference order now
    // — shared with the three service.js handlers that used to each call the
    // headless export directly.
    const store = resolvedStore || (await getUserHomeStore().catch(() => null));
    step("followup-data", { store });
    const sheets = await getFollowUpSheets({ store, tabId });
    if (!sheets.ok) {
      return _fail(tabId, capturedAt,
        `no VizPick data in this capture (${sheets.errorClass || "NO_DATA"}): ${sheets.error || "no rows"}`);
    }
    const { locationDetails, departmentBreakout, snapshot: snapshotRow } = sheets;
    step("followup-ready", {
      locations: locationDetails.length,
      departments: departmentBreakout.length,
      source: sheets.source,
      replayed: sheets.replayed,
      refreshed: !!snapshotRow?.refreshed,
      ageMin: Number.isFinite(snapshotRow?.ageMs) ? Math.round(snapshotRow.ageMs / 60_000) : null,
    });

    step("render");
    // The headless replay above (getVizPickFollowUpData) reliably gets the
    // Location Details + Department Breakout sheets (real, hard-coded
    // sheetdocIds) but has never been able to resolve the "VizPick Donut
    // Health" / "Department Groups" sheets that back the health ring, the
    // four goal rings, and the Fresh/F&C/GM rings (see sources/vizpick_export.js's
    // _resolveSheetIds note) — so data.health/data.metrics/data.deptRings are
    // effectively always empty. The vizpick module's own Today capture gets
    // those same sheets reliably, by driving the real Download UI instead of
    // guessing at their sheetdocIds. Prefer its already-stored row for this
    // store; fall back to whatever the headless replay produced (in case that
    // ever starts working) and finally to render_card's own legacy derivation.
    // health/metrics and deptRings come from INDEPENDENT exports in vizpick's
    // Today crawl — one can fail without the other. mapRowToRingData returns
    // null per-field (not an empty array) for whichever export failed on the
    // last crawl, so each field below falls back to the headless source
    // independently instead of one missing export blanking everything.
    const ring = snapshotRow ? mapRowToRingData(snapshotRow.row) : null;
    // The header stamp must read as "as of" the SOURCE data (Tableau's own
    // "Last update" for the VizPickDetails view this store's Today row came
    // from), not the moment this extension happened to run. sourceUpdate
    // exists on the snapshot regardless of whether the donut-health sheet
    // parsed, since it's stamped once per store crawl. Only fall back to our
    // own capture time when there's no snapshot at all to read a real stamp
    // from (store never crawled by VizPick's Today capture).
    const sourceStamp = snapshotRow?.sourceUpdate?.iso
      ? new Date(snapshotRow.sourceUpdate.iso).toLocaleString()
      : snapshotRow?.sourceUpdate?.raw || null;
    step("ring-source", {
      healthSource: ring?.health != null ? "vizpick-snapshot" : "headless-export",
      deptRingsSource: ring?.deptRings != null ? "vizpick-snapshot" : "headless-export",
      store, snapshotAt: snapshotRow?.capturedAt ?? null, sourceStamp,
    });

    // The card reproduces the Tableau dashboard, so it wants the eight ring
    // values rather than the detail sheets. getVizPickFollowUpData now returns
    // both; pass the rings through and let render_card fall back to its legacy
    // path if the donut sheets were unavailable this run.
    const card = renderMetricCard({
      health:    ring?.health ?? sheets.health ?? null,
      metrics:   ring?.metrics ?? sheets.metrics ?? [],
      deptRings: ring?.deptRings ?? sheets.deptRings ?? [],
      // Kept so the legacy shape still resolves if the rings are missing.
      departmentBreakout,
      locationDetails,
    }, {
      title: metric.name || "VizPick Backroom Health",
      store,
      capturedAt: sourceStamp || new Date(capturedAt).toLocaleString(),
    });

    step("rasterize", { width: card.width, height: card.height });
    const raster = await svgToPngBase64(card.svg, {
      width: card.width,
      height: card.height,
      scale: cap.rasterScale ?? 1,
    });
    if (!raster.ok) return _fail(tabId, capturedAt, `render failed: ${raster.reason}`);

    const pngBase64 = raster.pngBase64;
    const width  = Math.round(card.width  * (cap.rasterScale ?? 1));
    const height = Math.round(card.height * (cap.rasterScale ?? 1));
    step("captured", { width, height, bytes: pngBase64.length });

    return {
      ok: true,
      pngBase64,
      width, height,
      clipUsed: null,
      anchorRegion: null,
      rowCounts: {
        locations: locationDetails.length,
        departments: departmentBreakout.length,
        // Which route each sheet actually came from, so a card that looks
        // wrong can be traced to a source without re-running the capture.
        source: sheets.source,
      },
      tabId,
      capturedAt,
    };
  } catch (err) {
    return _fail(tabId, capturedAt, String(err?.message ?? err));
  }
}

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

/** Thrown to unwind a capture whose caller has already given up on it. Not an
 *  error condition — captureMetric converts it to an ordinary ok:false result
 *  so the scheduler's accounting stays uniform. */
class CaptureAborted extends Error {
  constructor() { super("capture aborted by caller"); this.name = "CaptureAborted"; }
}

async function _waitForSelectorVisible(tabId, selector, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Checked per poll, not only at phase boundaries: this loop can consume
    // the entire watchdog window by itself.
    if (signal?.aborted) throw new CaptureAborted();
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

async function _waitForDomStable(tabId, quietMs, maxMs, signal) {
  const start = Date.now();
  let lastCount = -1;
  let quietSince = Date.now();
  while (Date.now() - start < maxMs) {
    // Per-poll, same reason as the selector wait: this loop can hold the
    // capture for its whole maxMs on its own, so a check only at the phase
    // boundary would never interrupt it.
    if (signal?.aborted) throw new CaptureAborted();
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
