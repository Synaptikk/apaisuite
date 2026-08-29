// modules/sparkfraud/view.js
//
// SparkFraud UI controller. Mounted by the shell on #/sparkfraud.
// Adapted from donor extension/app.js (1300+ lines). Rendering logic and
// the entire trip / orders / items / confidence pipeline is preserved
// verbatim; changes are limited to shell-integration plumbing.
//
// Key migration changes:
//   - Exports mount(host, container) per docs/ARCHITECTURE.md::2
//   - chrome.runtime.sendMessage → host.messaging.sendRaw (preserves
//     SparkFraud's {ok, error, ...} pattern of structured error codes)
//   - chrome.runtime.getURL(path) → host.url(path) for fixtures + registries
//   - chrome.tabs.create → host.tabs.create
//   - Selectors prefixed sf-, scoped to container
//   - Storage key "omsHeaders" check → "sparkfraud.omsHeaders" (matches the
//     namespaced session storage write in service.js)
//   - Debug globals __SPARK_TRIPS / __SPARK_EVENT_MS → namespaced
//     __APAISUITE_SPARKFRAUD_TRIPS / __APAISUITE_SPARKFRAUD_EVENT_MS

import { toTrip, toCandidateMatch, computeInStoreWindow, attachOmsItems, toItem } from "./models/index.js";
import { emit, EVENTS } from "./telemetry/events.js";
import { saveInvestigation, toInvestigationRecord } from "./journal.js";

const SWIFT_DASHBOARD = "https://swift.walmart.com/sparkApp/api/proxy/v4/dashboard";

export async function mount(host, container) {
  // ── 1. Inject stylesheet ────────────────────────────────────────────
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = host.url("styles.css");
  link.dataset.module = host.id;
  document.head.appendChild(link);

  // ── 2. Load markup ──────────────────────────────────────────────────
  try {
    const resp = await fetch(host.url("view.html"));
    container.innerHTML = await resp.text();
  } catch (e) {
    container.innerHTML = `<div class="state-error">Failed to load SparkFraud view: ${String(e?.message ?? e)}</div>`;
    return async () => { link.remove(); };
  }

  // ── 3. Module-scoped DOM helper ─────────────────────────────────────
  const $ = (id) => container.querySelector("#" + id);

  // ── 4. State ────────────────────────────────────────────────────────
  let DELIVERY_TYPE_ITEMS = null;
  let allTrips = [];
  let allNormalizedTrips = [];
  let itemsByOrder = {};
  let lastWidenInfo = null;
  let lastConfidenceCounts = null;
  let lastSearchResult = null;
  let eventTimestampMs = null;
  let lookupMode = false;

  // Store timezone — defaults to America/New_York. Multi-store users can update
  // sparkfraud/registries/store_config.json; populated at runtime from gscope.
  const STORE_TZ = "America/New_York";

  // OMS-PAGINATION-01: batch size for OMS queries.
  const OMS_BATCH_SIZE = 10;

  // Auto-widen Dispatcher query: API filters by CUSTOMER promised window,
  // not by SHOPPER-at-store time. Widen to ±120m so viability filter has
  // enough material.
  const DISPATCHER_MIN_HALFWINDOW_MIN = 120;

  // ── 5. Replay mode (URL query string ?replay=NAME) ──────────────────
  function isReplayMode() {
    return new URLSearchParams(location.search).get("replay");
  }

  async function loadDeliveryTypeRegistry() {
    const url = host.url("registries/enums.json");
    const r = await fetch(url);
    if (!r.ok) throw new Error(`enums.json load failed: HTTP ${r.status}`);
    const enums = await r.json();
    const items = enums?.deliveryTypes?.items;
    if (!Array.isArray(items) || !items.length) {
      throw new Error("enums.json#deliveryTypes.items missing or empty");
    }
    // Registry ids are unprefixed (dt-spark); the suite's markup uses
    // sf-prefixed ids (sf-dt-spark) so they cannot collide with another
    // module's. Remap here so the checkbox lookup in runSearch still hits the
    // right elements.
    //
    // Only dt-spark is active — Express and Scheduled Grocery were retired
    // 2026-08-29 and moved to deliveryTypes.retired in enums.json. This loop
    // reads whatever `items` holds, so nothing here needs changing to add or
    // remove one.
    return items.map(item => ({
      ...item,
      checkbox_id: item.checkbox_id?.startsWith("sf-")
        ? item.checkbox_id
        : `sf-${item.checkbox_id}`,
    }));
  }

  async function loadDispatcherFixture(name) {
    const fname = `dispatcher_${name}.json`;
    const url = host.url(`fixtures/${fname}`);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Fixture load failed: ${fname} (HTTP ${r.status})`);
    const data = await r.json();
    console.log(`[SparkFraud] REPLAY: loaded fixture ${fname}`);
    emit(EVENTS.REPLAY_LOADED, { fixtureName: name });
    return data?.payload?.tasksByClientId?.["0"]?.trips || [];
  }

  // ── 6. SW messaging ────────────────────────────────────────────────
  // sendRaw preserves the donor's pattern of inspecting {ok, error, ...}
  // for flow-control codes like "auth-opening".
  function send(type, payload = {}, timeoutMs = 60_000) {
    return host.messaging.sendRaw(type, payload, { timeoutMs });
  }

  async function getCookies() {
    const r = await send("getGscopeCookies");
    console.log("[SparkFraud] cookie lookup:", r);
    if (r?.ok === false) {
      // Update the status badge with a short, user-friendly summary for the
      // known auth-flow codes; everything else falls through with the raw
      // error message so unexpected failures don't silently degrade to the
      // generic "(none)" cookies error from buildHeaders.
      const short =
        r.error === "auth-needs-interaction" ? "Finish sign-in in the foregrounded gscope tab, then retry" :
        r.error === "auth-cookies-missing"   ? "Session expired — re-auth in the focused gscope tab" :
        r.error === "auth-pending"           ? "Finish SSO in the open gscope tab" :
        r.error === "auth-opening"           ? "Opening gscope tab — complete SSO if asked" :
                                                `gscope auth failed: ${r.error || "unknown"}`;
      setStatus(short, "err");
      throw new Error(r.message || r.error || "getGscopeCookies failed");
    }
    return r?.cookies || {};
  }

  function setStatus(text, kind) {
    const el = $("sf-auth-status");
    el.textContent = text;
    el.className = "badge" + (kind ? " " + kind : "");
  }

  // ── 7. Misc formatting helpers ─────────────────────────────────────
  function fmtMoney(n) {
    const v = Number(n);
    return Number.isFinite(v) ? `$${v.toFixed(2)}` : "—";
  }

  function offsetStringFor(date, tz) {
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" });
    const parts = fmt.formatToParts(date);
    const tzPart = parts.find(p => p.type === "timeZoneName")?.value || "";
    let raw = tzPart.replace("GMT", "").trim() || "+00:00";
    if (/^[+-]\d$/.test(raw))    raw = raw.replace(/^([+-])(\d)$/, "$10$2:00");
    if (/^[+-]\d\d$/.test(raw))  raw = raw + ":00";
    return raw;
  }

  function tzAbbrFor(date, tz) {
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" });
    const parts = fmt.formatToParts(date);
    return parts.find(p => p.type === "timeZoneName")?.value || tz;
  }

  function makeStoreDate(dateStr, timeStr) {
    const fakeUtc = new Date(`${dateStr}T${timeStr}:00Z`);
    const local = new Date(fakeUtc.toLocaleString("en-US", { timeZone: STORE_TZ }));
    const utc   = new Date(fakeUtc.toLocaleString("en-US", { timeZone: "UTC" }));
    const offsetMs = utc.getTime() - local.getTime();
    return new Date(fakeUtc.getTime() + offsetMs);
  }

  function fmtTimeStoreTz(ms, opts = {}) {
    if (!ms) return "—";
    const d = ms instanceof Date ? ms : new Date(ms);
    const time = d.toLocaleTimeString("en-US", {
      timeZone: STORE_TZ, hour: "2-digit", minute: "2-digit", hour12: false,
    });
    if (opts.withTz === false) return time;
    return `${time} ${tzAbbrFor(d, STORE_TZ)}`;
  }
  function fmtTimeMs(ms) { return fmtTimeStoreTz(ms, { withTz: false }); }
  function formatEventTime() {
    if (!eventTimestampMs) return "?";
    return fmtTimeStoreTz(eventTimestampMs);
  }
  function pad2(n) { return String(n).padStart(2, "0"); }
  function parseOffsetMin(s) {
    const m = s.match(/^([+-])(\d\d):(\d\d)$/);
    if (!m) return 0;
    const sign = m[1] === "-" ? 1 : -1;
    return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // Open a driver's recent history inside our own popup window.
  //
  // TEMPORARILY DISABLED — see the no-op stub below. The full implementation
  // (preserved in git history) drove Dispatcher's Global Search → "In Drivers"
  // in a background helper tab. Walmart's Spark dashboard is a React SPA
  // inside a cross-origin swift.walmart.com iframe; cross-origin iframes
  // don't receive CDP's Page.addScriptToEvaluateOnNewDocument, and the SPA
  // defers mounting when document.visibilityState='hidden' (which is the
  // iframe's state in any background tab). A focused popup-window workaround
  // landed but still misbehaves in user testing; re-enable once the
  // driver-search-via-popup flow is verified.
  async function openDriverInDispatcher(driverName) {
    return runDriverLookup(driverName, $("sf-store").value.trim());
  }

  // Triggered by clicking the driver name on a trip card. Queries the
  // Dispatcher API for the last 7 days at the same store, filters to this
  // driver, renders newest-first in a popup. v1 limitation: pageSize=200
  // single call; a busy store may exceed that. Surface a notice on the
  // popup when the cap is hit.
  async function openDriverRecentOrders(driverName, store) {
    const w = window.open("", "_blank", "width=900,height=700");
    w.document.write(`<!doctype html>
<html><head><title>Loading driver orders…</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:24px;color:#222}</style>
</head><body>
<h2>Loading recent orders for ${escapeHtml(driverName)}…</h2>
<p>Querying Dispatcher for the last 7 days at store ${escapeHtml(store)}…</p>
</body></html>`);
    w.document.close();

    try {
      // Window: 7 days back AND 12 hours forward.
      // Dispatcher filters trips by CUSTOMER PROMISED DELIVERY WINDOW, not
      // by when the shopper was actually at the store. Capping endISO at
      // NOW excludes trips where the shopper has already been at the store
      // but the customer window is still in the future (typical for a
      // morning shopper with an 11am-12pm delivery slot). 12h forward
      // catches every reasonable in-flight trip while staying near the
      // requested "last 7 days" framing the user expects.
      const now = new Date();
      const start = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
      const end   = new Date(now.getTime() + 12 * 3600 * 1000);
      const fmt = d => {
        const offset = offsetStringFor(d, STORE_TZ);
        const shifted = new Date(d.getTime() - parseOffsetMin(offset) * 60_000);
        return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth()+1)}-${pad2(shifted.getUTCDate())}T` +
               `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}:${pad2(shifted.getUTCSeconds())}${offset}`;
      };

      // Use ALL delivery types from the registry — driver lookup spans
      // every service the registry knows about, not just what's checked.
      const services = new Set();
      const serviceTypes = new Set();
      for (const item of (DELIVERY_TYPE_ITEMS || [])) {
        for (const s of item.services) services.add(s);
        for (const t of item.serviceTypes) serviceTypes.add(t);
      }

      const trips = await fetchTrips({
        store,
        startISO: fmt(start),
        endISO:   fmt(end),
        services: [...services],
        serviceTypes: [...serviceTypes],
      });

      // Match driver names loosely — same first word + same last word,
      // case-insensitive, tolerant of middle names/initials on EITHER side.
      // (Walmart returns driver names like "DEDRICK K TSOSIE" while the
      // user may type just "DEDRICK TSOSIE", and vice versa.)
      const wantTokens = driverName.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const matching = trips.filter(t => {
        const d = t.driver || {};
        const full = `${d.firstName || ""} ${d.lastName || ""}`.trim().toLowerCase();
        if (!full) return false;
        const candTokens = full.split(/\s+/).filter(Boolean);
        if (!candTokens.length || !wantTokens.length) return false;
        return wantTokens[0] === candTokens[0]
            && wantTokens[wantTokens.length - 1] === candTokens[candTokens.length - 1];
      });

      // If no matches, gather every unique driver name in the window so the
      // user can spot a near-miss spelling (e.g. middle initial mismatch,
      // hyphenated last name, an extra space). Helps diagnose 0-result cases
      // without having to open DevTools.
      let candidateNames = [];
      if (!matching.length) {
        const seen = new Set();
        for (const t of trips) {
          const d = t.driver || {};
          const full = `${d.firstName || ""} ${d.lastName || ""}`.trim();
          if (full && !seen.has(full.toLowerCase())) {
            seen.add(full.toLowerCase());
            candidateNames.push(full);
          }
        }
        candidateNames.sort();
      }
      matching.sort((a, b) => {
        const aT = new Date(a.customerStartTime || 0).getTime();
        const bT = new Date(b.customerStartTime || 0).getTime();
        return bT - aT;
      });

      const tzAbbr = tzAbbrFor(new Date(), STORE_TZ);
      const rows = matching.map(t => {
        const startStr = t.customerStartTime
          ? new Date(t.customerStartTime).toLocaleString("en-US", { timeZone: STORE_TZ })
          : "?";
        const orderIds = (t.orders || []).map(o => o.orderId).filter(Boolean);
        const orders = orderIds.length ? orderIds.join(", ") : "—";
        const status = t.displayTripStatus || "?";
        const transit = t.transitStatus && t.transitStatus !== "ON_TIME" ? ` (${t.transitStatus})` : "";
        return `<tr>
          <td>${escapeHtml(startStr)} ${escapeHtml(tzAbbr)}</td>
          <td class="mono">${escapeHtml(orders)}</td>
          <td>${escapeHtml(status)}${escapeHtml(transit)}</td>
          <td>${escapeHtml(t.carrier || "?")}</td>
        </tr>`;
      }).join("");

      const capHit = trips.length >= 200
        ? `<div class="note">⚠ Dispatcher returned the maximum 200 trips for this 7-day window — older trips at this store may be missing. Narrow the time range or filter on the main page if needed.</div>`
        : "";

      w.document.open();
      w.document.write(`<!doctype html>
<html><head><title>Driver: ${escapeHtml(driverName)}</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; padding: 24px; color: #222; }
  h2 { margin: 0 0 6px 0; font-size: 18px; }
  .meta { color: #555; font-size: 13px; margin-bottom: 16px; }
  .note { background: #fff7e6; border-left: 3px solid #d97706; padding: 8px 12px; font-size: 12px; color: #864e00; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { background: #f5f5f5; padding: 8px; text-align: left; font-weight: 600; font-size: 11px; text-transform: uppercase; }
  td { padding: 8px; border-bottom: 1px solid #eee; vertical-align: top; }
  td.mono { font-family: ui-monospace, Consolas, monospace; }
  .empty { color: #888; font-style: italic; padding: 16px 0; }
  .candidates { background: #f5f5f5; border-radius: 4px; padding: 12px; margin-top: 12px; font-size: 11px; }
  .candidates-head { font-weight: 600; color: #333; margin-bottom: 6px; font-size: 12px; }
  .candidates-list { display: flex; flex-wrap: wrap; gap: 6px; }
  .candidates-list code { background: #fff; border: 1px solid #ddd; padding: 2px 6px; border-radius: 3px; font-size: 11px; }
</style></head>
<body>
  <h2>${escapeHtml(driverName)}</h2>
  <div class="meta">Store ${escapeHtml(store)} · last 7 days · ${matching.length} trip${matching.length === 1 ? "" : "s"} (of ${trips.length} total at this store in window)</div>
  ${capHit}
  ${matching.length
    ? `<table>
         <thead><tr><th>Customer Window Start</th><th>Order ID(s)</th><th>Trip Status</th><th>Carrier</th></tr></thead>
         <tbody>${rows}</tbody>
       </table>`
    : `<p class="empty">No trips found for "${escapeHtml(driverName)}" in the last 7 days at store ${escapeHtml(store)}.</p>
       ${candidateNames.length ? `
         <div class="candidates">
           <div class="candidates-head">Drivers seen at this store in the last 7 days (${candidateNames.length}) — spot the spelling:</div>
           <div class="candidates-list">${candidateNames.map(n => `<code>${escapeHtml(n)}</code>`).join("")}</div>
         </div>
       ` : ""}`}
</body></html>`);
      w.document.close();
    } catch (e) {
      w.document.open();
      w.document.write(`<!doctype html>
<html><head><title>Error</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:24px;color:#222}</style>
</head><body>
<h2>Couldn't load driver orders</h2>
<p>${escapeHtml(String(e?.message ?? e))}</p>
<p style="color:#666;font-size:12px">The Dispatcher query failed. If your gscope session has expired, re-auth on the main SparkFraud page and try again.</p>
</body></html>`);
      w.document.close();
    }
  }

  // ── 8b-2. Load a driver's recent trips into the main results panel ──
  async function runDriverLookup(driverName, store) {
    if (!driverName) return;
    lookupMode = true;
    eventTimestampMs = null;
    itemsByOrder = {};
    $("sf-results").innerHTML =
      `<p class="muted"><span class="spinner"></span>Loading trips for ${escapeHtml(driverName)}…</p>`;

    try {
      const now = new Date();
      const start = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
      const end   = new Date(now.getTime() + 12 * 3600 * 1000);
      const fmt = d => {
        const offset = offsetStringFor(d, STORE_TZ);
        const shifted = new Date(d.getTime() - parseOffsetMin(offset) * 60_000);
        return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth()+1)}-${pad2(shifted.getUTCDate())}T` +
               `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}:${pad2(shifted.getUTCSeconds())}${offset}`;
      };

      const services = new Set();
      const serviceTypes = new Set();
      for (const item of (DELIVERY_TYPE_ITEMS || [])) {
        for (const s of item.services) services.add(s);
        for (const t of item.serviceTypes) serviceTypes.add(t);
      }

      const trips = await fetchTrips({
        store, startISO: fmt(start), endISO: fmt(end),
        services: [...services], serviceTypes: [...serviceTypes],
      });

      const wantTokens = driverName.trim().toLowerCase().split(/\s+/).filter(Boolean);
      allTrips = trips.filter(t => {
        const d = t.driver || {};
        const full = `${d.firstName || ""} ${d.lastName || ""}`.trim().toLowerCase();
        if (!full) return false;
        const candTokens = full.split(/\s+/).filter(Boolean);
        if (!candTokens.length || !wantTokens.length) return false;
        return wantTokens[0] === candTokens[0]
            && wantTokens[wantTokens.length - 1] === candTokens[candTokens.length - 1];
      });

      renderTrips();

      const allOrderIds = [...new Set(
        allNormalizedTrips.flatMap(t => t.orders.map(o => o.id).filter(Boolean))
      )];
      if (allOrderIds.length) {
        await fetchOrderItems(
          allOrderIds, itemsByOrder,
          ({ batchOrderIds }) => renderItemsForBatch(batchOrderIds)
        );
        renderAllItems();
      }
    } catch (e) {
      $("sf-results").innerHTML = `<div class="error">${e.message}</div>`;
    }
  }

  // ── 8c. Who's here now? — snapshot of drivers currently at the store ──
  // Single button → popup window. Queries Dispatcher for NOW ± 30 min at
  // the current store, filters trips to ACTIVE statuses
  // (enrouteToPickup / atPickup / tripInProgress), classifies each into a
  // PHASE based on whether PICKED / DISPATCHED events have fired, then
  // auto-fetches OMS items for every order so the analyst sees the full
  // shopping list immediately. Refresh button at the top re-runs the
  // query in-place.
  const ACTIVE_DISPATCH_STATUSES = new Set(["enrouteToPickup", "atPickup", "tripInProgress"]);

  async function openWhosHereNow() {
    const store = $("sf-store").value.trim() || "";
    const w = window.open("", "_blank", "width=1200,height=800");
    w.document.write(`<!doctype html>
<html><head><title>Who's here now? — Store ${escapeHtml(store)}</title>
<style>${whosHereStyles()}</style>
</head><body>
<h2>Who's here now? — Store ${escapeHtml(store)}</h2>
<p class="loading">Querying Dispatcher (NOW ± 30 min)…</p>
</body></html>`);
    w.document.close();

    const render = async () => {
      try {
        const now = new Date();
        const start = new Date(now.getTime() - 30 * 60_000);
        const end   = new Date(now.getTime() + 30 * 60_000);
        const fmt = d => {
          const offset = offsetStringFor(d, STORE_TZ);
          const shifted = new Date(d.getTime() - parseOffsetMin(offset) * 60_000);
          return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth()+1)}-${pad2(shifted.getUTCDate())}T` +
                 `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}:${pad2(shifted.getUTCSeconds())}${offset}`;
        };
        const services = new Set();
        const serviceTypes = new Set();
        for (const item of (DELIVERY_TYPE_ITEMS || [])) {
          for (const s of item.services) services.add(s);
          for (const t of item.serviceTypes) serviceTypes.add(t);
        }

        const trips = await fetchTrips({
          store,
          startISO: fmt(start),
          endISO: fmt(end),
          services: [...services],
          serviceTypes: [...serviceTypes],
        });

        const active = trips.filter(t => ACTIVE_DISPATCH_STATUSES.has(t.displayTripStatus));
        const normalized = active.map(t => toTrip(t, { fetchedBy: "live" }));

        // Classify each by PICKED/DISPATCHED event presence — gives the
        // analyst a clearer signal than the high-level displayTripStatus.
        const enriched = normalized.map(n => {
          const events = (n.orders || []).flatMap(o => o.taskEvents || []);
          const picked = events.some(e => e?.statusName === "PICKED");
          const dispatched = events.some(e => e?.statusName === "DISPATCHED");
          let phase = "?";
          let phaseClass = "phase-unknown";
          if (!picked) {
            phase = "Shopping (still picking)";
            phaseClass = "phase-shopping";
          } else if (!dispatched) {
            phase = "At register (PICKED, not DISPATCHED)";
            phaseClass = "phase-register";
          } else {
            phase = "Left store (DISPATCHED)";
            phaseClass = "phase-dispatched";
          }
          return { normalized: n, phase, phaseClass };
        });

        // Order: at-register first (most actionable), shopping next, dispatched last.
        const phaseRank = { "phase-register": 0, "phase-shopping": 1, "phase-dispatched": 2, "phase-unknown": 3 };
        enriched.sort((a, b) => (phaseRank[a.phaseClass] - phaseRank[b.phaseClass]));

        // Auto-fetch OMS items for every order across all active drivers.
        const allOrderIds = enriched.flatMap(e => (e.normalized.orders || []).map(o => o.id).filter(Boolean));
        const uniqueOrderIds = [...new Set(allOrderIds)];
        let itemsByOrder = {};
        let omsBlurb = "";
        if (uniqueOrderIds.length) {
          try {
            itemsByOrder = await fetchOrderItems(uniqueOrderIds);
            const totalRows = Object.values(itemsByOrder).reduce((n, rows) => n + rows.length, 0);
            omsBlurb = ` · ${uniqueOrderIds.length} orders / ${totalRows} item rows captured`;
          } catch (e) {
            omsBlurb = ` · OMS fetch failed: ${e?.message ?? e}`;
          }
        }

        const tzAbbr = tzAbbrFor(now, STORE_TZ);
        const stamp = now.toLocaleString("en-US", { timeZone: STORE_TZ });

        const driverRows = enriched.map(e => {
          const n = e.normalized;
          const d = n.driver || {};
          const orderIds = (n.orders || []).map(o => o.id).filter(Boolean);

          const itemsHtml = orderIds.length
            ? orderIds.map(oid => {
                const rows = itemsByOrder[oid] || [];
                if (!rows.length) return `<div class="order-block"><div class="order-head">Order ${escapeHtml(oid)}</div><div class="empty">No items returned.</div></div>`;
                const itemRows = rows.map(r => {
                  const cancelled = (r.lineStatus || "").toLowerCase() === "cancelled";
                  return `<tr${cancelled ? ' class="cancelled"' : ""}>
                    <td>${escapeHtml(r.itemName || "—")} <small>(${escapeHtml(r.itemId || "")})</small></td>
                    <td class="mono">${escapeHtml(r.upc || "")}</td>
                    <td class="num">${escapeHtml(String(r.quantity ?? "1"))}</td>
                    <td class="num price">${fmtMoney(r.unitPrice)}</td>
                    <td>${escapeHtml(r.lineStatus || "—")}</td>
                  </tr>`;
                }).join("");
                return `<div class="order-block">
                  <div class="order-head">Order ${escapeHtml(oid)} <span class="muted">· ${rows.length} item${rows.length === 1 ? "" : "s"}</span></div>
                  <table class="items"><thead><tr><th>Item</th><th>UPC</th><th>Qty</th><th>Price</th><th>Status</th></tr></thead><tbody>${itemRows}</tbody></table>
                </div>`;
              }).join("")
            : `<div class="empty">No orders on this trip.</div>`;

          return `<details class="driver-card">
            <summary class="driver-head">
              <span class="driver-name">${escapeHtml(d.fullName || "<unassigned>")}</span>
              <span class="driver-phone">${escapeHtml(d.phoneE164 || "—")}</span>
              <span class="phase ${e.phaseClass}">${escapeHtml(e.phase)}</span>
              <span class="status">${escapeHtml(n.status?.display || "?")}</span>
              <span class="carrier muted">${escapeHtml(n.carrier || "?")}</span>
            </summary>
            ${itemsHtml}
          </details>`;
        }).join("");

        w.document.open();
        w.document.write(`<!doctype html>
<html><head><title>Who's here now? — Store ${escapeHtml(store)}</title>
<style>${whosHereStyles()}</style>
</head><body>
<div class="toolbar">
  <h2>Who's here now? — Store ${escapeHtml(store)}</h2>
  <button id="refresh" class="refresh-btn">↻ Refresh</button>
</div>
<div class="meta">As of ${escapeHtml(stamp)} ${escapeHtml(tzAbbr)} · ${enriched.length} driver${enriched.length === 1 ? "" : "s"} in active status (of ${trips.length} trips in NOW ± 30min)${escapeHtml(omsBlurb)}</div>
${enriched.length
  ? driverRows
  : `<p class="empty">No drivers currently in active status at store ${escapeHtml(store)}.</p>`}
</body></html>`);
        w.document.close();

        const refreshBtn = w.document.getElementById("refresh");
        if (refreshBtn) {
          refreshBtn.addEventListener("click", () => {
            refreshBtn.disabled = true;
            refreshBtn.textContent = "Refreshing…";
            render().catch(() => {});
          });
        }
      } catch (e) {
        w.document.open();
        w.document.write(`<!doctype html>
<html><head><title>Who's here now? — error</title>
<style>${whosHereStyles()}</style></head><body>
<h2>Who's here now? — error</h2>
<div class="err">${escapeHtml(String(e?.message ?? e))}</div>
<p class="muted">If your gscope session expired, re-auth on the main SparkFraud page and click Refresh.</p>
<button id="refresh" class="refresh-btn">↻ Retry</button>
</body></html>`);
        w.document.close();
        const retry = w.document.getElementById("refresh");
        if (retry) retry.addEventListener("click", () => render().catch(() => {}));
      }
    };

    await render();
  }

  function whosHereStyles() {
    return `
      body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; padding: 16px 24px; color: #222; margin: 0; }
      .toolbar { display: flex; align-items: center; gap: 12px; }
      h2 { margin: 8px 0; font-size: 18px; flex: 1; }
      .refresh-btn { background: #0071ce; color: white; border: 0; padding: 6px 14px; border-radius: 999px; font-weight: 600; cursor: pointer; font-size: 13px; }
      .refresh-btn:disabled { opacity: 0.5; cursor: wait; }
      .meta { color: #555; font-size: 12px; margin-bottom: 16px; }
      .err { background: #fceaea; border-left: 3px solid #cc3333; padding: 10px 14px; color: #832222; margin-bottom: 12px; font-size: 13px; }
      .loading { color: #888; font-style: italic; }
      .empty { color: #888; font-style: italic; padding: 12px 0; }
      .muted { color: #888; font-weight: normal; }
      .driver-card { background: #fff; border: 1px solid #e3e6ea; border-radius: 6px; margin-bottom: 8px; padding: 0; }
      .driver-card[open] { padding-bottom: 12px; }
      .driver-head { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; padding: 10px 14px; cursor: pointer; user-select: none; list-style: none; }
      .driver-head::-webkit-details-marker { display: none; }
      .driver-head::before { content: "▸"; color: #888; font-size: 11px; transition: transform 0.15s ease; display: inline-block; width: 12px; }
      .driver-card[open] > .driver-head::before { content: "▾"; }
      .driver-head:hover { background: #f8f9fb; }
      .driver-card[open] > .driver-head { border-bottom: 1px solid #eef0f3; margin-bottom: 8px; }
      .driver-card > :not(.driver-head) { padding-left: 14px; padding-right: 14px; }
      .driver-name { font-weight: 700; font-size: 15px; }
      .driver-phone { color: #666; font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
      .phase { padding: 2px 10px; border-radius: 999px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: white; }
      .phase-shopping   { background: #d97706; }
      .phase-register   { background: #b91c1c; }
      .phase-dispatched { background: #6b7280; }
      .phase-unknown    { background: #9ca3af; }
      .status { padding: 2px 8px; border-radius: 10px; background: #e8eef9; color: #0071ce; font-size: 11px; font-weight: 600; }
      .carrier { font-size: 12px; }
      .order-block { background: #f9fafb; border-radius: 4px; padding: 8px 10px; margin-bottom: 6px; }
      .order-head { font-weight: 600; font-size: 12px; color: #333; margin-bottom: 4px; }
      table.items { width: 100%; border-collapse: collapse; font-size: 11px; }
      table.items th { background: #efefef; padding: 4px 6px; text-align: left; font-weight: 600; font-size: 10px; text-transform: uppercase; }
      table.items td { padding: 3px 6px; border-bottom: 1px solid #eee; vertical-align: top; }
      table.items td.num { text-align: right; font-variant-numeric: tabular-nums; }
      table.items td.price { color: #1f5e2a; }
      table.items tr.cancelled td { color: #999; text-decoration: line-through; }
      small { color: #999; font-size: 10px; }
    `;
  }

  // ── 8. Print trip (opens a printable popup window) ────────────────
  function printTrip(candidate, win, tripEl) {
    const thumbUrls = {};
    for (const img of (tripEl?.querySelectorAll("img.thumb") ?? [])) {
      if (img.title && img.src) thumbUrls[img.title] = img.src;
    }
    const trip = candidate.trip;
    const d = trip.driver || {};
    const driverName = d.fullName || "<unassigned>";
    const phone = d.phoneE164 || "—";
    const driverEmail = d.email || "";
    const carrier = trip.carrier || "?";
    const status = trip.status?.display || "?";
    const transit = trip.status?.transit || "";
    const tzAbbr = tzAbbrFor(new Date(eventTimestampMs || Date.now()), STORE_TZ);
    const eventStr = eventTimestampMs
      ? `${new Date(eventTimestampMs).toLocaleString("en-US", { timeZone: STORE_TZ })} ${tzAbbr}`
      : "—";
    const cwStart = trip.customerWindow?.startMs;
    const cwEnd   = trip.customerWindow?.endMs;
    const customerWindow = (cwStart && cwEnd)
      ? `${fmtTimeMs(cwStart)}–${fmtTimeMs(cwEnd)} ${tzAbbr}`
      : "—";
    const inStoreWindow = win.pickedMs && win.dispatchedMs
      ? `${fmtTimeMs(win.pickedMs)}–${fmtTimeMs(win.dispatchedMs)} ${tzAbbr} (${Math.round((win.dispatchedMs-win.pickedMs)/60000)}m)`
      : "unknown";

    const confidenceHtml = `
<div class="confidence-section confidence-${candidate.confidence}">
  <div class="conf-label">${candidate.confidence}</div>
  <div class="conf-note">Investigative lead quality only — NOT proof, NOT guilt.</div>
  ${candidate.rationale.length
    ? `<ul class="conf-list">${candidate.rationale.map(r => `<li class="conf-rationale">✓ ${escapeHtml(r)}</li>`).join("")}</ul>`
    : ""}
  ${candidate.ambiguity.length
    ? `<ul class="conf-list">${candidate.ambiguity.map(a => `<li class="conf-ambiguity">? ${escapeHtml(a)}</li>`).join("")}</ul>`
    : ""}
</div>`;

    const orderIds = trip.orders.map(o => o.id).filter(Boolean);
    const rowsByOrder = {};
    for (const oid of orderIds) rowsByOrder[oid] = itemsByOrder[oid] || [];

    emit(EVENTS.REDACTION_EXPANDED, {
      context: "printTrip",
      scope: "customer+items",
      orderCount: orderIds.length,
    });

    let itemsHtml = "";
    let missingThumbCount = 0;
    for (const oid of orderIds) {
      const rows = rowsByOrder[oid];
      const customer = (rows[0]?.customerFirstName || "").trim();
      const addr = `${rows[0]?.shipToAddress || ""}, ${rows[0]?.city || ""} ${rows[0]?.state || ""} ${rows[0]?.postalCode || ""}`;
      itemsHtml += `<h3>Order ${oid}${customer ? ` · ${customer}` : ""}</h3>`;
      if (addr.replace(/[\s,]/g, "")) itemsHtml += `<p class="addr">${addr}</p>`;
      if (!rows.length) {
        itemsHtml += `<p><i>No item details available.</i></p>`;
        continue;
      }
      itemsHtml += `<table class="items-table">
        <thead><tr><th></th><th>Item</th><th>UPC</th><th>Qty</th><th>Price</th><th>Status</th></tr></thead>
        <tbody>`;
      for (const r of rows) {
        const cancelled = (r.lineStatus || "").toLowerCase() === "cancelled";
        const thumbSrc = thumbUrls[r.itemId] || "";
        if (!thumbSrc) missingThumbCount++;
        const thumbCell = thumbSrc
          ? `<td><img src="${thumbSrc}" width="40" height="40" class="print-thumb" alt=""></td>`
          : `<td><div class="print-thumb-missing" title="${escapeHtml(r.itemId || "")}">no image</div></td>`;
        itemsHtml += `<tr${cancelled ? ' class="cancelled"' : ""}>
          ${thumbCell}
          <td>${r.itemName || "—"} <small>(${r.itemId || ""})</small></td>
          <td>${r.upc || ""}</td>
          <td>${r.quantity || "1"}</td>
          <td class="price">${fmtMoney(r.unitPrice)}</td>
          <td>${r.lineStatus || "—"}</td>
        </tr>`;
      }
      itemsHtml += `</tbody></table>`;
    }

    const evidence = trip.evidence || {};
    const evidenceLine = `${escapeHtml(evidence.fetchedBy || "live")} (${escapeHtml((evidence.sources || []).map(s => s.system).join(", ") || "—")})`;
    const storeIdDisplay = (trip.storeId ?? trip.orders?.[0]?.storeId ?? "");

    const html = `<!doctype html>
<html><head><title>SparkFraud — Trip ${orderIds.join(", ")}</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; margin: 24px; color: #222; }
  h1 { margin: 0 0 6px 0; font-size: 18px; }
  h3 { margin: 18px 0 4px 0; font-size: 13px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  .meta { font-size: 12px; color: #555; margin-bottom: 12px; }
  .meta dt { font-weight: 600; display: inline-block; min-width: 130px; }
  .meta div { padding: 1px 0; }
  .addr { font-size: 11px; color: #666; margin: 0 0 4px 0; }
  table.items-table { width: 100%; border-collapse: collapse; font-size: 11px; }
  table.items-table th, table.items-table td { padding: 4px 6px; text-align: left; border-bottom: 1px solid #eee; vertical-align: top; }
  table.items-table th { background: #f5f5f5; font-weight: 600; font-size: 10px; text-transform: uppercase; }
  .price { text-align: right; font-variant-numeric: tabular-nums; }
  .cancelled td { color: #999; text-decoration: line-through; }
  .print-thumb { object-fit: contain; display: block; }
  .print-thumb-missing { width: 40px; height: 40px; background: #f3f4f6; border: 1px dashed #d1d5db; border-radius: 3px; display: flex; align-items: center; justify-content: center; font-size: 9px; color: #9ca3af; }
  .thumb-banner { font-size: 10px; color: #92400e; background: #fef3c7; border: 1px solid #fde68a; border-radius: 3px; padding: 4px 8px; margin-bottom: 10px; }
  @media print { .thumb-banner { display: none; } }
  small { color: #777; font-size: 10px; }
  .confidence-section { border-left: 4px solid #ccc; padding: 8px 12px; margin: 10px 0 14px 0; background: #fafafa; font-size: 11px; }
  .confidence-section.confidence-VERIFIED    { border-color: #1a7f37; }
  .confidence-section.confidence-LIKELY      { border-color: #d97706; }
  .confidence-section.confidence-POSSIBLE    { border-color: #6b7280; }
  .confidence-section.confidence-UNKNOWN     { border-color: #9ca3af; }
  .confidence-section.confidence-CONFLICTING { border-color: #b91c1c; }
  .conf-label { font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
  .conf-note  { font-style: italic; color: #555; margin: 2px 0 6px 0; font-size: 10px; }
  .conf-list  { margin: 4px 0 0 0; padding-left: 18px; list-style: none; }
  .conf-list li { padding: 1px 0; font-size: 11px; }
  .conf-rationale { color: #1f5e2a; }
  .conf-ambiguity { color: #864e00; }
  @media print { body { margin: 0.5in; } }
</style></head><body>
<h1>SparkFraud — Trip Detail</h1>
${confidenceHtml}
<div class="meta">
  <div><dt>Driver:</dt> ${escapeHtml(driverName)} · ${escapeHtml(phone)}${driverEmail ? ` · ${escapeHtml(driverEmail)}` : ""}</div>
  <div><dt>Carrier:</dt> ${escapeHtml(carrier)}</div>
  <div><dt>Trip status:</dt> ${escapeHtml(status)} ${transit && transit !== "ON_TIME" ? `(${escapeHtml(transit)})` : ""}</div>
  <div><dt>Customer window:</dt> ${escapeHtml(customerWindow)}</div>
  <div><dt>Shopper at POS:</dt> ${escapeHtml(inStoreWindow)}</div>
  <div><dt>Investigated event:</dt> ${escapeHtml(eventStr)}</div>
  <div><dt>Store:</dt> ${storeIdDisplay} (${STORE_TZ})</div>
  <div><dt>Evidence:</dt> ${evidenceLine}</div>
  <div><dt>Generated:</dt> ${new Date().toLocaleString("en-US", { timeZone: STORE_TZ })} ${tzAbbr}</div>
</div>
${missingThumbCount ? `<div class="thumb-banner">⚠ ${missingThumbCount} thumbnail${missingThumbCount === 1 ? "" : "s"} unavailable (no product image found). Dashed boxes indicate missing images.</div>` : ""}
${itemsHtml}
<script>setTimeout(()=>window.print(), 400);</script>
</body></html>`;

    const w = window.open("", "_blank", "width=900,height=700");
    w.document.write(html);
    w.document.close();
  }

  // ── 9. Auth + headers ──────────────────────────────────────────────
  async function buildHeaders() {
    const c = await getCookies();
    const have = Object.keys(c).sort();
    if (!c.authToken && !c.authtoken) {
      setStatus("Not signed in to gscope", "err");
      const msg = "Missing gscope auth cookies. Cookies the extension found: " +
        (have.length ? have.join(", ") : "(none)") +
        ". Open https://gscope.walmartlabs.com/apphome in a tab in this same Edge profile, complete SSO, then refresh this page. " +
        "Open DevTools (F12) Console for the full lookup diagnostic.";
      throw new Error(msg);
    }
    const ci = {};
    for (const k of Object.keys(c)) ci[k.toLowerCase()] = c[k];

    let loginId  = ci.loginid || "";
    let display  = ci.displayname || "";
    // Walmart's gscope now ships displayname/loginid as EMPTY strings — the
    // canonical user identity moved to wire-id (format: "Display Name - loginId").
    // Fall back to that when the legacy cookies aren't populated; without this
    // the status badge reads "Signed in: unknown" even though auth succeeded.
    if ((!display || !loginId) && ci["wire-id"]) {
      const m = ci["wire-id"].match(/^(.*?)\s*-\s*([^-\s][^-]*?)\s*$/);
      if (m) {
        if (!display) display = m[1].trim();
        if (!loginId) loginId = m[2].trim();
      } else if (!display) {
        display = ci["wire-id"];
      }
    }
    const storeId  = ci["store-no"] || ci.storeno || "";
    const loggedDomain = ci.loggedindomain || "store";
    const loggedUser   = ci.loggedinusername || "";
    const firstName    = display.split(" ")[0] || "";
    const lastName     = display.split(" ").slice(1).join(" ") || "";

    setStatus("Signed in: " + (display || loginId || "unknown"), "ok");
    return {
      "content-type":          "application/json",
      "x-authheader":          ci.authheader || "",
      "x-authtoken":           ci.authtoken  || "",
      "x-userid":              loginId,
      "x-username":            display,
      "x-firstname":           firstName,
      "x-lastname":            lastName,
      "x-loggedindomain":      loggedDomain,
      "x-loggedinusername":    loggedUser,
      "x-storeid":             storeId,
      "x-realmid":             "DISPATCHER_WEB_UI",
      "x-source":              "DISPATCHER",
      "x-sourceapp":           "DISPATCHER_WEB_UI",
      "x-channel":             "WEB",
      "x-domain":              "USLM",
      "x-tenant":              "WALMART_US",
      "x-tenantid":            "0",
      "tenantid":              "0",
      "wm_tenant_id":          "0",
      "wm_consumer.tenant_id": "0",
      "x-timezone":            "+00:00",
      "device_timezone":       "America/New_York",
      "installed_app":         "spark-dispatcher.us",
    };
  }

  // ── 10. API calls ──────────────────────────────────────────────────
  async function fetchTrips({ store, startISO, endISO, services, serviceTypes }) {
    const replayName = isReplayMode();
    if (replayName) return loadDispatcherFixture(replayName);

    const headers = await buildHeaders();
    const body = {
      startTime: startISO, endTime: endISO,
      pickupPointIds: [String(store)], clients: ["0"],
      pageSize: 200, services,
      ...(serviceTypes.length ? { serviceTypes } : {}),
    };
    console.log("[SparkFraud] Dispatcher request:", body);
    const r = await send("fetchJson", { url: SWIFT_DASHBOARD, method: "POST", headers, body });
    console.log("[SparkFraud] Dispatcher response:", r);
    if (!r.ok) throw new Error(`Dispatcher: HTTP ${r.status}`);
    const cb = r.data?.payload?.tasksByClientId?.["0"];
    return cb?.trips || [];
  }

  async function _runOmsBatch(batch, tag) {
    const t0 = Date.now();
    try {
      const r = await send("driveOrderResolution", { orderIds: batch }, 90_000);
      const durationMs = Date.now() - t0;
      if (!r.ok) {
        console.warn(`[SparkFraud] OMS ${tag} failed in ${durationMs}ms:`, r.error || `HTTP ${r.status}`);
        return { ok: false, rows: [], error: r.error || `HTTP ${r.status}`, durationMs };
      }
      if (typeof r.data === "string") {
        const dataLen = r.data.length;
        console.error(
          `[SparkFraud] OMS ${tag} arrived unparsed (truncated?) — ${dataLen} chars in ${durationMs}ms. ` +
          `Reduce OMS_BATCH_SIZE (currently ${OMS_BATCH_SIZE}) or bump capture.js truncation above ${dataLen}.`
        );
        return { ok: false, rows: [], error: `truncated at ${dataLen} chars`, durationMs };
      }
      const rows = r.data?.payload || [];
      console.log(`[SparkFraud] OMS ${tag} → ${rows.length} rows in ${durationMs}ms`);
      return { ok: true, rows, durationMs };
    } catch (e) {
      const durationMs = Date.now() - t0;
      console.error(`[SparkFraud] OMS ${tag} threw in ${durationMs}ms:`, e);
      return { ok: false, rows: [], error: String(e), durationMs };
    }
  }

  function _mergeRows(grouped, rows) {
    for (const row of rows) {
      const oid = row.orderNo;
      if (!grouped[oid]) grouped[oid] = [];
      grouped[oid].push(row);
    }
    return rows.length;
  }

  async function fetchOrderItems(orderIds, target, onBatchComplete) {
    target = target || {};
    if (!orderIds.length) return target;

    if (isReplayMode()) {
      console.log("[SparkFraud] REPLAY: skipping OMS call (oms fixture support pending REPLAY-02)");
      return target;
    }

    const batches = [];
    for (let i = 0; i < orderIds.length; i += OMS_BATCH_SIZE) {
      batches.push(orderIds.slice(i, i + OMS_BATCH_SIZE));
    }
    console.log(
      `[SparkFraud] OMS: ${orderIds.length} order(s) in ${batches.length} batch(es) of <=${OMS_BATCH_SIZE}` +
      (batches.length > 1 ? ` (1 warm-up + ${batches.length - 1} parallel)` : "")
    );

    let totalRows = 0;
    let failedBatches = 0;

    const omsT0 = Date.now();
    const tag0 = `batch 1/${batches.length} (${batches[0].length} order${batches[0].length === 1 ? "" : "s"}, warm-up)`;
    const r0 = await _runOmsBatch(batches[0], tag0);
    if (r0.ok) {
      const added = _mergeRows(target, r0.rows);
      totalRows += added;
      if (onBatchComplete) {
        try { onBatchComplete({ batchNum: 1, totalBatches: batches.length, batchOrderIds: batches[0], rowsAdded: added }); }
        catch (e) { console.warn("[SparkFraud] onBatchComplete threw:", e); }
      }
    } else failedBatches++;
    const warmupMs = Date.now() - omsT0;

    let parallelMs = 0;
    if (batches.length > 1) {
      const parT0 = Date.now();
      const rest = batches.slice(1);
      const restResults = await Promise.all(
        rest.map((batch, i) => {
          const batchNum = i + 2;
          const tag = `batch ${batchNum}/${batches.length} (${batch.length} order${batch.length === 1 ? "" : "s"}, parallel)`;
          return _runOmsBatch(batch, tag).then(r => {
            if (r.ok) {
              const added = _mergeRows(target, r.rows);
              totalRows += added;
              if (onBatchComplete) {
                try { onBatchComplete({ batchNum, totalBatches: batches.length, batchOrderIds: batch, rowsAdded: added }); }
                catch (e) { console.warn("[SparkFraud] onBatchComplete threw:", e); }
              }
              return { ok: true, _merged: true };
            }
            return r;
          });
        })
      );
      parallelMs = Date.now() - parT0;
      for (const r of restResults) {
        if (!r.ok && !r._merged) failedBatches++;
      }
    }

    if (failedBatches) {
      console.warn(
        `[SparkFraud] OMS: ${failedBatches}/${batches.length} batches failed. ` +
        `Returning ${totalRows} rows from ${batches.length - failedBatches} successful batch(es).`
      );
    }
    console.log(
      `[SparkFraud] OMS done: ${totalRows} rows, ${batches.length - failedBatches}/${batches.length} batch(es). ` +
      `Warmup ${warmupMs}ms + parallel ${parallelMs}ms = ${warmupMs + parallelMs}ms total.`
    );
    return target;
  }

  // ── 11. UI rendering ───────────────────────────────────────────────
  function renderAllItems() {
    for (const tripEl of container.querySelectorAll(".trip")) {
      const normalizedTrip = tripEl.__normalizedTrip;
      if (!normalizedTrip) continue;
      attachOmsItems(normalizedTrip.orders, itemsByOrder, toItem);
      renderItemsForTrip(tripEl, normalizedTrip.orders);
    }
    updateOrderItemCounts();
  }

  function renderItemsForBatch(batchOrderIds) {
    const oidSet = new Set(batchOrderIds);
    for (const tripEl of container.querySelectorAll(".trip")) {
      const normalizedTrip = tripEl.__normalizedTrip;
      if (!normalizedTrip) continue;
      const matches = normalizedTrip.orders.some(o => o.id && oidSet.has(o.id));
      if (!matches) continue;
      attachOmsItems(normalizedTrip.orders, itemsByOrder, toItem);
      renderItemsForTrip(tripEl, normalizedTrip.orders);
    }
    updateOrderItemCounts();
  }

  function updateOrderItemCounts() {
    const itemsByOid = {};
    for (const tripEl of container.querySelectorAll(".trip")) {
      const normalizedTrip = tripEl.__normalizedTrip;
      if (!normalizedTrip) continue;
      for (const order of normalizedTrip.orders) {
        if (order.id) itemsByOid[order.id] = order.items || [];
      }
    }
    for (const span of container.querySelectorAll(".order-item-count")) {
      const oid = span.dataset.for;
      const items = itemsByOid[oid] || [];
      if (!items.length) { span.textContent = ""; continue; }
      const cancelled = items.filter(i => i.isCancelled).length;
      const live = items.length - cancelled;
      span.textContent = cancelled
        ? ` · ${live}+${cancelled}c`
        : ` · ${live} item${live === 1 ? "" : "s"}`;
    }
  }

  function renderTrips() {
    const root = $("sf-results");
    root.innerHTML = "";

    const INCLUDE_STATUSES = new Set(["completed", "enroutetopickup", "atpickup", "tripinprogress"]);
    let completed = lookupMode
      ? allTrips
      : allTrips.filter(t => INCLUDE_STATUSES.has((t.displayTripStatus || "").toLowerCase()));

    const fetchedBy = isReplayMode() ? "replay" : "live";
    const completedNorm = completed.map(t => {
      const normalized = toTrip(t, { fetchedBy });
      return { raw: t, normalized, win: computeInStoreWindow(normalized, eventTimestampMs) };
    });

    const viableOnly = !lookupMode && ($("sf-viable-only")?.checked ?? true);
    const viableFiltered = viableOnly
      ? completedNorm.filter(x => x.win.viable)
      : completedNorm;

    if (Object.keys(itemsByOrder).length) {
      attachOmsItems(completedNorm.flatMap(c => c.normalized.orders), itemsByOrder, toItem);
    }
    allNormalizedTrips = completedNorm.map(c => c.normalized);

    const viableCountAll = completedNorm.filter(x => x.win.viable).length;
    const hasEventsCount = completedNorm.filter(x => x.win.hasEvents).length;
    emit(EVENTS.SEARCH_VIABILITY_COMPUTED, {
      totalCompleted: completedNorm.length,
      viable: viableCountAll,
      dropped: completedNorm.length - viableCountAll,
      hasTaskEventsCount: hasEventsCount,
      noTaskEventsCount: completedNorm.length - hasEventsCount,
      lookupMode,
    });

    lastSearchResult = { totalCompleted: completedNorm.length, viableCount: viableCountAll, hasEventsCount };

    if (!viableFiltered.length) {
      const totalCompleted = completed.length;
      const viableCount = completedNorm.filter(x => x.win.viable).length;
      lastConfidenceCounts = { verified: 0, likely: 0, possible: 0, unknown: 0, conflicting: 0 };
      root.innerHTML =
        `<p class="muted">No viable candidate trips for event time ${formatEventTime()}. ` +
        `(Trips in window: ${totalCompleted}, of which viable: ${viableCount}. ` +
        `${!viableOnly ? "" : 'Uncheck "Only viable" to see all trips in window.'})</p>`;
      return;
    }

    const normalizedAllViable = completedNorm.filter(x => x.win.viable).map(x => x.normalized);

    lastConfidenceCounts = { verified: 0, likely: 0, possible: 0, unknown: 0, conflicting: 0 };

    for (const { normalized: normalizedTrip, win } of viableFiltered) {
      const tripEl = document.createElement("div");
      tripEl.className = "trip";
      tripEl.dataset.tripKey = normalizedTrip.id || "";
      tripEl.__normalizedTrip = normalizedTrip;

      const candidate = toCandidateMatch(normalizedTrip, {
        eventTimestampMs, allCandidateTrips: normalizedAllViable, lookupMode,
      });
      emit(EVENTS.CONFIDENCE_ASSIGNED, {
        confidence: candidate.confidence,
        metrics: candidate.metrics,
        rationaleCount: candidate.rationale.length,
        ambiguityCount: candidate.ambiguity.length,
        replay: !!isReplayMode(),
      });

      const cKey = (candidate.confidence || "unknown").toLowerCase();
      if (lastConfidenceCounts && cKey in lastConfidenceCounts) lastConfidenceCounts[cKey]++;

      const driverName = normalizedTrip.driver.fullName;
      const phone = normalizedTrip.driver.phoneE164 || "—";
      const orderIds = normalizedTrip.orders.map(o => o.id).filter(Boolean);
      const start = fmtTimeMs(normalizedTrip.customerWindow.startMs);
      const end   = fmtTimeMs(normalizedTrip.customerWindow.endMs);
      const isDelayed = normalizedTrip.status.delayed;
      const orderLinks = orderIds.map(oid =>
        `<a class="order-link" data-order="${oid}" title="Open ${oid} in Dispatcher">${oid}<span class="order-item-count" data-for="${oid}"></span></a>`
      ).join(" ");

      const pickedFmt = win.pickedMs ? fmtTimeMs(win.pickedMs) : "?";
      const dispFmt   = win.dispatchedMs ? fmtTimeMs(win.dispatchedMs) : "?";
      const tzAbbr    = win.pickedMs ? tzAbbrFor(new Date(win.pickedMs), STORE_TZ) : tzAbbrFor(new Date(), STORE_TZ);
      const inStoreMins = (win.pickedMs && win.dispatchedMs)
        ? Math.round((win.dispatchedMs - win.pickedMs) / 60000) : null;
      const windowLabel = win.pickedMs && win.dispatchedMs
        ? `<span class="in-store-window" title="Shopper at POS / register: between PICKED (completed shopping) and DISPATCHED (left store with goods). Times in ${STORE_TZ}.">At POS between ${pickedFmt}→${dispFmt} ${tzAbbr} (${inStoreMins}m)</span>`
        : win.inProgress
          ? `<span class="in-store-window in-progress-window" title="Trip in progress — shopper is active at this store. Customer window: ${fmtTimeMs(normalizedTrip.customerWindow.startMs)}–${fmtTimeMs(normalizedTrip.customerWindow.endMs)} ${tzAbbrFor(new Date(), STORE_TZ)}. In-store window available after PICKED/DISPATCHED events fire.">In progress — active in store · ${normalizedTrip.status.display || ""}</span>`
          : `<span class="in-store-window missing" title="No PICKED/DISPATCHED events in this trip's data">At POS: unknown</span>`;

      const _tipLines = [
        ...candidate.rationale.map(r => "✓ " + r),
        ...candidate.ambiguity.map(a => "? " + a),
      ];
      const confidenceBadge =
        `<span class="confidence-badge confidence-${candidate.confidence}" ` +
        `title="${escapeHtml(_tipLines.join("\n") || "(no rationale)")}">${candidate.confidence}</span>`;

      const isOmsLookup = driverName === "Looked up via OMS";
      tripEl.innerHTML = `
        <div class="trip-head">
          ${confidenceBadge}
          ${isOmsLookup
            ? `<span class="trip-driver-btn trip-driver-oms" title="Driver name unavailable for OMS-only lookups">OMS lookup</span>`
            : `<button class="trip-driver-btn" data-driver="${escapeHtml(driverName)}" title="Load all recent trips for ${escapeHtml(driverName)} (last 7 days)">${driverName}</button>`}
          <span class="trip-meta">${start}–${end} ${tzAbbr}${isDelayed ? ' <span class="delayed-flag">DELAYED</span>' : ""} · ${normalizedTrip.carrier || "?"} · ${phone}</span>
          ${windowLabel}
          ${isOmsLookup
            ? `<button class="trip-watch" disabled title="Cannot watch: driver name unknown for OMS-only lookups. Run a store search to find the driver.">+ Watch</button>`
            : `<button class="trip-watch" title="Add ${escapeHtml(driverName)} to the watchlist for the current store" data-driver="${escapeHtml(driverName)}">+ Watch</button>`}
          <button class="trip-print" title="Print full trip details + items"><span class="trip-print-icon">🖨</span> Print</button>
          <span class="trip-toggle">▾</span>
        </div>
        <div class="trip-orders">${orderLinks}</div>
        <div class="items"><p class="muted">Loading items…</p></div>
      `;
      tripEl.querySelector(".trip-head").addEventListener("click", () => {
        tripEl.classList.toggle("open");
        if (tripEl.classList.contains("open") && !tripEl.dataset.thumbsLoaded) {
          tripEl.dataset.thumbsLoaded = "1";
          loadThumbnailsFor(tripEl);
        }
      });
      tripEl.querySelector(".trip-print").addEventListener("click", async e => {
        e.preventDefault(); e.stopPropagation();
        const btn = e.currentTarget; // capture sync — nulled after event loop

        // Pre-fetch any thumbnails that haven't loaded yet, up to 5 s.
        const pending = [...tripEl.querySelectorAll(".thumb.placeholder[data-item-id]")]
          .map(d => d.dataset.itemId).filter(Boolean);
        if (pending.length) {
          const savedHTML = btn.innerHTML;
          btn.disabled = true;
          btn.innerHTML = `<span class="trip-print-icon">⏳</span> Loading ${pending.length} image${pending.length === 1 ? "" : "s"}…`;
          const itemsContainer = tripEl.querySelector(".items");
          await Promise.race([
            Promise.allSettled(pending.map(id => loadThumbnail(itemsContainer, id))),
            new Promise(r => setTimeout(r, 5000)),
          ]);
          btn.disabled = false;
          btn.innerHTML = savedHTML;
        }

        printTrip(candidate, win, tripEl);
      });
      const driverBtn = tripEl.querySelector(".trip-driver-btn");
      if (driverBtn) driverBtn.addEventListener("click", e => {
        e.preventDefault(); e.stopPropagation();
        openDriverInDispatcher(driverName);
      });
      tripEl.querySelector(".trip-watch").addEventListener("click", async e => {
        e.preventDefault(); e.stopPropagation();
        // Capture btn SYNCHRONOUSLY before any await — e.currentTarget is
        // nulled by the browser once event propagation finishes, which
        // happens before the SW response comes back.
        const btn = e.currentTarget;
        const store = $("sf-store").value.trim() || "";
        try {
          // Seed initial watchlist state from the trip the user is looking at.
          // Without this the panel shows "no data yet" until the next 3-min
          // poll fires — but we already have the most recent trip context
          // right here. Best last-seen signal in priority order: PICKED time
          // (shopper started shopping), DISPATCHED time (shopper left store),
          // customer window start, then "now" as a last resort.
          const lastSeenMs = win?.pickedMs
                          || win?.dispatchedMs
                          || normalizedTrip.customerWindow?.startMs
                          || Date.now();
          const tripOrderIds = (normalizedTrip.orders || []).map(o => o.id).filter(Boolean);
          const r = await send("watchlist_add", {
            driverName,
            store,
            initialState: {
              lastStatus:   normalizedTrip.status?.display || null,
              lastSeenMs,
              lastTripId:   normalizedTrip.id || null,
              lastOrderIds: tripOrderIds,
              seedSource:   "trip-card",
            },
          });
          if (!r.ok) throw new Error(r.error || "watchlist_add failed");
          if (btn) {
            btn.textContent = r.alreadyWatching ? "✓ Watching" : "✓ Added";
            btn.disabled = true;
          }
          await renderWatchlist();
        } catch (err) {
          console.error("[SparkFraud] watchlist_add failed:", err);
          alert("Couldn't add to watchlist: " + (err?.message ?? err));
        }
      });
      for (const a of tripEl.querySelectorAll(".trip-orders a.order-link")) {
        a.addEventListener("click", e => {
          e.preventDefault(); e.stopPropagation();
          const orderId = a.dataset.order;
          if (!orderId) return;
          a.classList.add("loading");
          send("openOrderInDispatcher", { orderId }).then(resp => {
            a.classList.remove("loading");
            if (!resp?.ok) {
              console.error("[SparkFraud] openOrderInDispatcher failed:", resp);
              alert("Failed to open order in Dispatcher: " + (resp?.error || "unknown"));
            }
          });
        });
      }
      root.appendChild(tripEl);
    }
    $("sf-result-summary").textContent =
      `${viableFiltered.length} viable trip(s)` +
      ` (of ${completed.length} in window)` +
      (lastWidenInfo ? ` · searched ±${lastWidenInfo.dispatcherWindowMin}m (widened from ±${lastWidenInfo.windowMin}m to catch shopper presence)` : "");
  }

  function renderItemsForTrip(tripEl, orders) {
    const itemsContainer = tripEl.querySelector(".items");
    // Flatten only to count — render is grouped per order below so each
    // customer's items are independently collapsible (drivers with 3-5 orders
    // were unreadable when everything flattened into one big table).
    const totalRows = orders.reduce((s, o) => s + (o.items?.length || 0), 0);
    if (!totalRows) {
      itemsContainer.innerHTML = `<p class="muted">No item details returned for this trip's orders.</p>`;
      tripEl.dataset.itemsReady = "1";
      return;
    }

    const ordersWithItems = orders.filter(o => (o.items?.length || 0) > 0);
    // If there's only one order, keep the old flat table for compactness.
    const multiOrder = ordersWithItems.length > 1;

    let html = "";
    for (let i = 0; i < ordersWithItems.length; i++) {
      const order = ordersWithItems[i];
      const items = order.items || [];
      const customer = order.customer;
      const customerName = customer
        ? ((customer._full().firstName || "").trim() || "—")
        : "—";
      const orderId = order.id || "—";
      const orderTotal = items.reduce((s, it) => s + (Number(it.unitPriceUsd) || 0) * (Number(it.quantity) || 1), 0);
      const summary = `Order ${orderId} · ${customerName} · ${items.length} item${items.length === 1 ? "" : "s"} · ${fmtMoney(orderTotal)}`;

      const tableRows = items.map(item => `
        <tr class="${item.isCancelled ? "cancelled" : ""}" data-item-name="${(item.name || "").toLowerCase()}" data-upc="${item.upc || ""}" data-item-id="${item.id || ""}">
          <td><div class="thumb placeholder" data-item-id="${item.id || ""}">${(item.id || "?").slice(0, 6)}</div></td>
          <td>${item.name || "—"} <a class="item-link" href="https://www.walmart.com/ip/${encodeURIComponent(item.id || "")}" target="_blank" rel="noopener" title="Open on walmart.com">${item.id || ""}</a></td>
          <td>${item.quantity != null ? item.quantity : "1"}</td>
          <td class="price">${fmtMoney(item.unitPriceUsd)}</td>
          <td>${item.lineStatus || "—"}</td>
        </tr>`).join("");

      const tableHtml = `<table>
        <thead><tr><th></th><th>Item</th><th>Qty</th><th>Price</th><th>Status</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table>`;

      if (multiOrder) {
        // First order open by default so the user sees something immediately;
        // subsequent orders collapsed to keep the card scannable.
        const openAttr = i === 0 ? " open" : "";
        html += `<details class="order-block"${openAttr}>
          <summary class="order-summary">${escapeHtml(summary)}</summary>
          ${tableHtml}
        </details>`;
      } else {
        html += tableHtml;
      }
    }
    itemsContainer.innerHTML = html;
    tripEl.dataset.itemsReady = "1";

    delete tripEl.dataset.thumbsLoaded;
    if (tripEl.classList.contains("open")) {
      tripEl.dataset.thumbsLoaded = "1";
      loadThumbnailsFor(tripEl);
    }
  }

  function loadThumbnailsFor(tripEl) {
    const itemsContainer = tripEl.querySelector(".items");
    if (!itemsContainer) return;
    const seen = new Set();
    for (const div of itemsContainer.querySelectorAll(".thumb.placeholder")) {
      const id = div.dataset.itemId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      loadThumbnail(itemsContainer, id);
    }
  }

  async function loadThumbnail(scope, itemId) {
    try {
      const r = await send("getItemImage", { itemId });
      if (!r?.ok || !r.url) return;
      for (const div of scope.querySelectorAll(`.thumb.placeholder[data-item-id="${itemId}"]`)) {
        const img = document.createElement("img");
        img.className = "thumb";
        img.src = r.url;
        img.alt = "";
        img.title = itemId;
        div.replaceWith(img);
      }
    } catch (_) { /* placeholder remains */ }
  }

  function applyItemFilter(query) {
    const q = (query || "").trim().toLowerCase();
    let visible = 0;
    for (const tripEl of container.querySelectorAll(".trip")) {
      const normalizedTrip = tripEl.__normalizedTrip;
      if (!normalizedTrip) continue;
      if (!q) { tripEl.classList.remove("hidden"); visible++; continue; }
      let matches = false;
      for (const order of normalizedTrip.orders) {
        for (const item of (order.items || [])) {
          if ((item.name || "").toLowerCase().includes(q) ||
              (item.upc || "").includes(q)) { matches = true; break; }
        }
        if (matches) break;
      }
      tripEl.classList.toggle("hidden", !matches);
      if (matches) visible++;
    }
    $("sf-result-summary").textContent =
      q ? `${visible} of ${allTrips.length} trip(s) contain "${q}"`
        : `${allTrips.length} trip(s)` +
          (lastWidenInfo ? ` · searched ±${lastWidenInfo.dispatcherWindowMin}m (widened from ±${lastWidenInfo.windowMin}m)` : "");
  }

  // ── 12. Search flows ───────────────────────────────────────────────
  async function runSearch() {
    // The search IS the investigation. driveOrderResolution fans out per
    // batch underneath and is not recorded separately — one intent, one row.
    host.usage.record("search");
    lookupMode = false;
    const btn = $("sf-search");
    btn.disabled = true;
    $("sf-results").innerHTML = `<p class="muted"><span class="spinner"></span>Querying Dispatcher…</p>`;
    console.log("[SparkFraud] runSearch started");
    const searchT0 = Date.now();
    let searchSuccess = true;
    let journalInput = null;
    let journalResult = null;
    try {
      const store = $("sf-store").value.trim() || "";
      const date  = $("sf-date").value || new Date().toISOString().slice(0, 10);
      const evtTime = $("sf-event-time").value || "08:40";
      const windowMin = Number($("sf-window-min").value || 30);

      const eventDate = makeStoreDate(date, evtTime);
      eventTimestampMs = eventDate.getTime();

      const dispatcherWindowMin = Math.max(windowMin, DISPATCHER_MIN_HALFWINDOW_MIN);
      const widened = dispatcherWindowMin > windowMin;
      lastWidenInfo = widened ? { windowMin, dispatcherWindowMin } : null;
      const startDate = new Date(eventDate.getTime() - dispatcherWindowMin * 60_000);
      const endDate   = new Date(eventDate.getTime() + dispatcherWindowMin * 60_000);
      if (widened) {
        console.log(
          `[SparkFraud] Dispatcher window auto-widened from ±${windowMin}m to ±${dispatcherWindowMin}m. ` +
          `Catches trips whose shoppers were at the store at event time but whose customer-promised ` +
          `delivery window starts later. Viability filter unchanged.`
        );
      }
      const fmt = d => {
        const offset = offsetStringFor(d, STORE_TZ);
        const shifted = new Date(d.getTime() - parseOffsetMin(offset) * 60_000);
        return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth()+1)}-${pad2(shifted.getUTCDate())}T` +
               `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}:${pad2(shifted.getUTCSeconds())}${offset}`;
      };
      const startISO = fmt(startDate);
      const endISO   = fmt(endDate);

      if (!DELIVERY_TYPE_ITEMS) {
        throw new Error("Delivery-type registry not loaded — reload the extension.");
      }
      const services = new Set();
      const serviceTypes = new Set();
      for (const item of DELIVERY_TYPE_ITEMS) {
        if ($(item.checkbox_id)?.checked) {
          for (const s of item.services) services.add(s);
          for (const t of item.serviceTypes) serviceTypes.add(t);
        }
      }
      if (!services.size) throw new Error("Select at least one delivery type.");

      emit(EVENTS.SEARCH_STARTED, {
        store, windowMin,
        services: [...services], serviceTypes: [...serviceTypes],
        lookupMode: false, replay: !!isReplayMode(),
      });

      journalInput = {
        store, date, eventTime: evtTime, windowMin, dispatcherWindowMin,
        services: [...services], serviceTypes: [...serviceTypes],
        lookupMode: false, replay: !!isReplayMode(),
      };

      const dispatcherT0 = Date.now();
      emit(EVENTS.SEARCH_DISPATCHER_REQUEST, {
        startTime: startISO, endTime: endISO,
        windowMin, dispatcherWindowMin, widened,
        services: [...services], serviceTypes: [...serviceTypes],
        replay: !!isReplayMode(),
      });
      try {
        allTrips = await fetchTrips({
          store, startISO, endISO,
          services: [...services], serviceTypes: [...serviceTypes],
        });
        emit(EVENTS.SEARCH_DISPATCHER_COMPLETED, {
          durationMs: Date.now() - dispatcherT0,
          trips: allTrips.length,
        });
      } catch (e) {
        emit(EVENTS.SEARCH_DISPATCHER_FAILED, {
          durationMs: Date.now() - dispatcherT0,
          error: e.name || "Error",
        });
        throw e;
      }

      window.__APAISUITE_SPARKFRAUD_TRIPS = allTrips;
      window.__APAISUITE_SPARKFRAUD_EVENT_MS = eventTimestampMs;

      renderTrips();

      const allOrderIds = [];
      for (const t of allNormalizedTrips) {
        for (const o of t.orders) if (o.id) allOrderIds.push(o.id);
      }
      if (allOrderIds.length) {
        const omsT0 = Date.now();
        try {
          itemsByOrder = {};
          await fetchOrderItems(
            [...new Set(allOrderIds)],
            itemsByOrder,
            ({ batchNum, totalBatches, batchOrderIds, rowsAdded }) => {
              console.log(
                `[SparkFraud] streaming: batch ${batchNum}/${totalBatches} ` +
                `(${batchOrderIds.length} order${batchOrderIds.length === 1 ? "" : "s"}, +${rowsAdded} rows) — rendering affected trips`
              );
              renderItemsForBatch(batchOrderIds);
            }
          );
          let rowCount = 0;
          for (const rows of Object.values(itemsByOrder)) rowCount += rows.length;
          emit(EVENTS.SEARCH_OMS_COMPLETED, {
            durationMs: Date.now() - omsT0,
            orderCount: allOrderIds.length,
            rowCount,
          });
        } catch (e) {
          emit(EVENTS.SEARCH_OMS_FAILED, {
            durationMs: Date.now() - omsT0,
            error: e.name || "Error",
          });
          throw e;
        }
        renderAllItems();
      }
      applyItemFilter($("sf-item-filter").value);

      journalResult = {
        tripsReturned: allTrips.length,
        ...(lastSearchResult || {}),
        fetchedBy: isReplayMode() ? "replay" : "live",
      };
    } catch (e) {
      searchSuccess = false;
      $("sf-results").innerHTML = `<div class="error">${e.message}</div>`;
    } finally {
      btn.disabled = false;
      emit(EVENTS.SEARCH_COMPLETED, {
        durationMs: Date.now() - searchT0,
        success: searchSuccess,
      });
      saveInvestigation(toInvestigationRecord({
        input: journalInput || {},
        result: journalResult || {},
        confidence: lastConfidenceCounts,
        durationMs: Date.now() - searchT0,
        success: searchSuccess,
      }));
    }
  }

  async function runOrderLookupFromText(rawText) {
    return runOrderLookup(rawText);
  }

  async function runOrderLookup(rawTextOverride) {
    lookupMode = true;
    const goBtn = $("sf-quick-go");
    if (goBtn) goBtn.disabled = true;
    // Check for cached OMS headers — sparkfraud.omsHeaders in session storage
    // (matches the write side in service.js).
    const cached = await new Promise(r =>
      chrome.storage.session.get("sparkfraud.omsHeaders", x => r(x["sparkfraud.omsHeaders"]))
    );
    const slowWarn = cached
      ? ""
      : ` <span class="muted">(first lookup of this session — opening Order Resolution to capture auth headers, ~10s. Subsequent lookups will be ~1s.)</span>`;
    $("sf-results").innerHTML = `<p class="muted"><span class="spinner"></span>Looking up order(s)…${slowWarn}</p>`;
    console.log("[SparkFraud] runOrderLookup started, cachedHeaders=" + !!cached);
    const lookupT0 = Date.now();
    let lookupSuccess = true;
    let lookupOrderCount = 0;
    try {
      // rawTextOverride comes from the unified quick-lookup dispatcher.
      const raw = (rawTextOverride ?? "").trim();
      if (!raw) throw new Error("Enter at least one order ID.");
      const orderIds = raw.split(/[,\s]+/).filter(Boolean);
      if (!orderIds.length) throw new Error("No valid order IDs parsed.");
      lookupOrderCount = orderIds.length;

      emit(EVENTS.LOOKUP_STARTED, {
        orderCount: orderIds.length, hadCachedHeaders: !!cached,
      });

      eventTimestampMs = null;
      itemsByOrder = await fetchOrderItems(orderIds);

      allTrips = orderIds.map(oid => {
        const rows = itemsByOrder[oid] || [];
        const first = rows[0] || {};
        return {
          orders: [{ orderId: oid, taskEvents: [] }],
          driver: { firstName: "Looked up via OMS", lastName: "", contact: { phoneNumber: "" } },
          carrier: first.fulfillmentType || "OMS",
          displayTripStatus: first.lineStatus || "lookup",
          transitStatus: "",
          customerStartTime: first.expectedShipDate ? new Date(Number(first.expectedShipDate)).toISOString() : null,
          customerEndTime:   first.expectedDeliveryDate ? new Date(Number(first.expectedDeliveryDate)).toISOString() : null,
          __lookup: true,
        };
      });

      // Best-effort: resolve real driver names from Dispatcher so the
      // watchlist gets a trackable name instead of the "Looked up via OMS"
      // sentinel. Silently falls back if gscope auth isn't ready.
      const store = $("sf-store").value.trim() || "";
      if (store) {
        try {
          const dr = await send("resolveOrderDrivers", { orderIds, store });
          if (dr.ok && dr.driverMap) {
            for (const fakeTrip of allTrips) {
              const oid = fakeTrip.orders[0]?.orderId;
              const info = oid && dr.driverMap[oid];
              if (!info) continue;
              fakeTrip.driver = { firstName: info.firstName, lastName: info.lastName, contact: { phoneNumber: "" } };
              if (info.carrier)           fakeTrip.carrier           = info.carrier;
              if (info.displayTripStatus) fakeTrip.displayTripStatus = info.displayTripStatus;
              delete fakeTrip.__lookup;
            }
          }
        } catch (_) { /* gscope not available — keep sentinel */ }
      }

      window.__APAISUITE_SPARKFRAUD_TRIPS = allTrips;

      renderTrips();
      renderAllItems();
    } catch (e) {
      lookupSuccess = false;
      $("sf-results").innerHTML = `<div class="error">${e.message}</div>`;
    } finally {
      if (goBtn) goBtn.disabled = false;
      emit(EVENTS.LOOKUP_COMPLETED, {
        durationMs: Date.now() - lookupT0,
        orderCount: lookupOrderCount,
        success: lookupSuccess,
      });
      saveInvestigation(toInvestigationRecord({
        input: {
          store: $("sf-store").value.trim() || "",
          date: new Date().toISOString().slice(0, 10),
          lookupMode: true,
          orderCount: lookupOrderCount,
          hadCachedHeaders: !!cached,
          replay: !!isReplayMode(),
        },
        result: {
          tripsReturned: allTrips.length,
          ...(lastSearchResult || {}),
          fetchedBy: isReplayMode() ? "replay" : "live",
        },
        confidence: lastConfidenceCounts,
        durationMs: Date.now() - lookupT0,
        success: lookupSuccess,
      }));
    }
  }

  // ── 13. Init ───────────────────────────────────────────────────────
  const now = new Date();
  const localDate = `${now.getFullYear()}-${pad2(now.getMonth()+1)}-${pad2(now.getDate())}`;
  $("sf-date").value = localDate;

  try {
    DELIVERY_TYPE_ITEMS = await loadDeliveryTypeRegistry();
    console.log("[SparkFraud] enums.json deliveryTypes loaded:", DELIVERY_TYPE_ITEMS.length, "items");
  } catch (e) {
    console.error("[SparkFraud] CRITICAL: enums.json failed to load:", e);
    setStatus("Registry load failed — see console", "err");
  }

  $("sf-search").addEventListener("click", runSearch);
  // Old sf-lookup-go / sf-lookup-order wiring removed — replaced by the
  // unified sf-quick-lookup row (see runQuickLookup below).
  $("sf-item-filter").addEventListener("input", e => applyItemFilter(e.target.value));
  $("sf-viable-only").addEventListener("change", () => {
    renderTrips();
    renderAllItems();
    applyItemFilter($("sf-item-filter").value);
  });
  $("sf-whos-here").addEventListener("click", () => {
    openWhosHereNow().catch(err => {
      console.error("[SparkFraud] Who's here failed:", err);
    });
  });
  $("sf-dev-reload").addEventListener("click", () => { chrome.runtime.reload(); });
  $("sf-dev-clear").addEventListener("click", async () => {
    if (!confirm("Clear all gscope cookies, cache, and service workers? You'll have to re-do SSO. Use this only if gscope is stuck.")) return;
    const r = await send("clearGscopeState");
    if (r?.ok) {
      alert("Cleared. Open a new tab to https://gscope.walmartlabs.com/apphome and re-do SSO.");
    } else {
      alert("Clear failed: " + (r?.error || "unknown"));
    }
  });

  // How-to-use modal: open on ? button, close on × or "Got it".
  const helpModal = $("sf-help-modal");
  if (helpModal) {
    $("sf-help").addEventListener("click", () => {
      if (typeof helpModal.showModal === "function") helpModal.showModal();
      else helpModal.setAttribute("open", "");
    });
    $("sf-help-close").addEventListener("click", () => helpModal.close());
    $("sf-help-close-btn").addEventListener("click", () => helpModal.close());
  }

  try { await buildHeaders(); }
  catch (_) { /* badge already updated */ }

  // ── 14b. Watchlist panel ──────────────────────────────────────────
  async function renderWatchlist() {
    const card = $("sf-watchlist-card");
    const body = $("sf-watchlist-body");
    const summary = $("sf-watchlist-summary");
    // Defensive: if the panel HTML wasn't loaded (stale view.html from an
    // older build cached by the SW), abort instead of crashing the caller's
    // try-block. Reload the extension at edge://extensions to pick up the
    // current view.html.
    if (!card || !body || !summary) {
      console.warn(
        "[SparkFraud] watchlist panel HTML missing (sf-watchlist-card/body/summary) — " +
        "view.html is likely stale. Reload the extension at edge://extensions."
      );
      return;
    }
    let watchlist = [];
    let hits = [];
    try {
      const wr = await send("watchlist_list");
      watchlist = wr.watchlist || [];
      const hr = await send("watchlist_hits_list");
      hits = hr.hits || [];
    } catch (e) {
      console.warn("[SparkFraud] watchlist render failed:", e);
    }

    if (!watchlist.length && !hits.length) {
      card.classList.add("hidden");
      return;
    }
    card.classList.remove("hidden");

    const recentHitCount = hits.filter(h => Date.now() - h.hitAt < 24 * 3600 * 1000).length;
    summary.textContent = `${watchlist.length} watched` + (recentHitCount ? ` · ${recentHitCount} hit${recentHitCount === 1 ? "" : "s"} (24h)` : "");

    const watchedRows = watchlist.map(w => {
      const seen = w.lastSeenMs ? new Date(w.lastSeenMs).toLocaleString("en-US", { timeZone: STORE_TZ }) : "—";
      const status = w.lastStatus
        ? `<span class="sf-wl-status sf-wl-status-${escapeHtml(w.lastStatus)}">${escapeHtml(w.lastStatus)}</span>`
        : `<span class="muted tiny">no data yet</span>`;
      const isOmsEntry = w.driverName === "Looked up via OMS";
      return `<tr${isOmsEntry ? ' class="sf-wl-oms-row"' : ""}>
        <td><button class="sf-wl-name-btn" data-driver="${escapeHtml(w.driverName)}" data-store="${escapeHtml(w.store)}" title="Open recent trips for ${escapeHtml(w.driverName)} at store ${escapeHtml(w.store)}">${escapeHtml(w.driverName)}</button>${isOmsEntry ? ' <span class="sf-wl-oms-warn" title="Driver name unknown — polling inactive. Remove this entry and re-add by watching from a store search result.">⚠ inactive</span>' : ""}</td>
        <td class="mono">${escapeHtml(w.store)}</td>
        <td>${status}</td>
        <td class="muted tiny">${escapeHtml(seen)}</td>
        <td><button class="sf-wl-remove" data-driver="${escapeHtml(w.driverName)}" data-store="${escapeHtml(w.store)}" title="Remove from watchlist">×</button></td>
      </tr>`;
    }).join("");

    const recentHits = hits.slice(-10).reverse();
    const hitRows = recentHits.map(h => {
      const t = new Date(h.hitAt).toLocaleString("en-US", { timeZone: STORE_TZ });
      const orderIds = (h.orderIds || []).slice(0, 3).join(", ") + ((h.orderIds || []).length > 3 ? "…" : "");
      const itemsBlurb = h.itemsByOrder
        ? ` · ${Object.values(h.itemsByOrder).reduce((n, rows) => n + rows.length, 0)} items captured`
        : "";
      return `<tr>
        <td class="muted tiny">${escapeHtml(t)}</td>
        <td><button class="sf-wl-name-btn" data-driver="${escapeHtml(h.driverName)}" data-store="${escapeHtml(h.store)}" title="Open recent trips for ${escapeHtml(h.driverName)} at store ${escapeHtml(h.store)}">${escapeHtml(h.driverName)}</button></td>
        <td class="mono">${escapeHtml(h.store)}</td>
        <td><span class="sf-wl-status sf-wl-status-${escapeHtml(h.status)}">${escapeHtml(h.status)}</span></td>
        <td class="mono">${escapeHtml(orderIds || "—")}${itemsBlurb}</td>
      </tr>`;
    }).join("");

    body.innerHTML = `
      ${watchlist.length ? `
        <div class="sf-wl-section">
          <div class="sf-wl-section-head">Currently watching</div>
          <table class="sf-wl-table">
            <thead><tr><th>Driver</th><th>Store</th><th>Last status</th><th>Last seen</th><th></th></tr></thead>
            <tbody>${watchedRows}</tbody>
          </table>
        </div>` : ""}
      ${recentHits.length ? `
        <div class="sf-wl-section">
          <div class="sf-wl-section-head">Recent hits (${recentHits.length})</div>
          <table class="sf-wl-table">
            <thead><tr><th>When</th><th>Driver</th><th>Store</th><th>Status</th><th>Orders</th></tr></thead>
            <tbody>${hitRows}</tbody>
          </table>
          <button id="sf-wl-clear-hits" class="btn btn-secondary btn-sm">Clear hits history</button>
        </div>` : ""}
      <div class="sf-wl-actions cluster">
        <button id="sf-wl-poll-now" class="btn btn-secondary btn-sm">Check now</button>
        <span class="muted tiny">Polls every 3 minutes via chrome.alarms while at least one driver is watched. OS notifications fire on status transitions into enroute / at pickup / trip in progress.</span>
      </div>
    `;

    for (const btn of body.querySelectorAll(".sf-wl-remove")) {
      btn.addEventListener("click", async () => {
        const driverName = btn.dataset.driver;
        const store = btn.dataset.store;
        try {
          await send("watchlist_remove", { driverName, store });
          await renderWatchlist();
        } catch (e) {
          alert("Remove failed: " + (e?.message ?? e));
        }
      });
    }
    // Click any watchlist driver name to open the popup with their recent
    // trips — same as clicking the driver on a trip card.
    for (const nameBtn of body.querySelectorAll(".sf-wl-name-btn")) {
      nameBtn.addEventListener("click", () => {
        runDriverLookup(nameBtn.dataset.driver, nameBtn.dataset.store);
      });
    }
    const clearBtn = $("sf-wl-clear-hits");
    if (clearBtn) clearBtn.addEventListener("click", async () => {
      try { await send("watchlist_clear_hits"); await renderWatchlist(); }
      catch (e) { alert("Clear failed: " + (e?.message ?? e)); }
    });
    const pollBtn = $("sf-wl-poll-now");
    if (pollBtn) pollBtn.addEventListener("click", async () => {
      pollBtn.disabled = true;
      pollBtn.textContent = "Checking…";
      try {
        const r = await send("watchlist_poll_now", {}, 60_000);
        await renderWatchlist();
        pollBtn.textContent = r.newHits ? `${r.newHits} new hit${r.newHits === 1 ? "" : "s"}` : "No new hits";
      } catch (e) {
        pollBtn.textContent = "Poll failed";
        console.warn("[SparkFraud] manual poll failed:", e);
      } finally {
        setTimeout(() => { pollBtn.disabled = false; pollBtn.textContent = "Check now"; }, 4000);
      }
    });
  }

  // Refresh watchlist on mount + every 30s while module is open.
  await renderWatchlist();
  const watchlistRefreshTimer = setInterval(() => {
    renderWatchlist().catch(e => console.warn("[SparkFraud] watchlist refresh:", e));
  }, 30_000);

  // Wire the unified quick-lookup row. Single input auto-detects type:
  //   - All tokens digit-only → order IDs (runs runOrderLookup)
  //   - Otherwise            → driver name (opens popup)
  // The + Watchlist button only appears when input parses as a driver name.
  function detectQueryType(input) {
    const trimmed = input.trim();
    if (!trimmed) return "empty";
    const tokens = trimmed.split(/[,\s]+/).filter(Boolean);
    if (tokens.every(t => /^\d+$/.test(t))) return "orders";
    return "driver";
  }

  function updateQuickLookupUI() {
    const kind = detectQueryType($("sf-quick-lookup").value);
    const watchBtn = $("sf-quick-watch");
    const goBtn = $("sf-quick-go");
    if (!watchBtn || !goBtn) return;
    watchBtn.classList.toggle("hidden", kind !== "driver");
    goBtn.textContent = kind === "orders" ? "Lookup orders"
                      : kind === "driver" ? "Find driver"
                      : "Go";
  }

  $("sf-quick-lookup").addEventListener("input", updateQuickLookupUI);
  updateQuickLookupUI();

  async function runQuickLookup() {
    const raw = $("sf-quick-lookup").value.trim();
    if (!raw) { alert("Type an order ID or driver name first."); return; }
    const kind = detectQueryType(raw);
    if (kind === "orders") {
      // Hand off to the existing order-lookup pipeline. It reads
      // sf-lookup-order — that input no longer exists, so synthesize the
      // value into the existing function by using a small adapter that
      // takes orderIds directly via a temporary input.
      await runOrderLookupFromText(raw);
    } else {
      // Driver name → open Dispatcher's native driver-search view.
      openDriverInDispatcher(raw);
    }
  }

  $("sf-quick-go").addEventListener("click", runQuickLookup);
  $("sf-quick-lookup").addEventListener("keydown", e => {
    if (e.key === "Enter") runQuickLookup();
  });
  $("sf-quick-watch").addEventListener("click", async ev => {
    // Capture button synchronously (e.currentTarget gets nulled after await).
    const btn = ev.currentTarget;
    const name = $("sf-quick-lookup").value.trim();
    if (!name) { alert("Type a driver name first."); return; }
    if (detectQueryType(name) !== "driver") {
      alert("That looks like an order ID, not a driver name. Use the Lookup button.");
      return;
    }
    const store = $("sf-store").value.trim() || "";
    try {
      const r = await send("watchlist_add", { driverName: name, store });
      if (!r.ok) throw new Error(r.error || "watchlist_add failed");
      $("sf-quick-lookup").value = "";
      updateQuickLookupUI();
      await renderWatchlist();
      if (btn) {
        btn.textContent = r.alreadyWatching ? "✓ Already" : "✓ Added";
        setTimeout(() => { if (btn) btn.textContent = "+ Watchlist"; }, 2500);
      }
    } catch (e) {
      alert("Couldn't add to watchlist: " + (e?.message ?? e));
    }
  });

  // ── 14. Watchlist audio alert ─────────────────────────────────────
  // Groups of 3 alternating-tone beeps, repeating for 15 seconds.
  function playWatchlistAlert() {
    try {
      const ctx           = new AudioContext();
      const totalSec      = 15;
      const beepSec       = 0.22;
      const beepGap       = 0.12;
      const groupGap      = 1.1;
      const groupPeriod   = 3 * (beepSec + beepGap) + groupGap;
      const groupCount    = Math.ceil(totalSec / groupPeriod);
      for (let g = 0; g < groupCount; g++) {
        for (let b = 0; b < 3; b++) {
          const t = ctx.currentTime + g * groupPeriod + b * (beepSec + beepGap);
          if (t - ctx.currentTime >= totalSec) break;
          const osc  = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.frequency.value = b % 2 === 0 ? 1050 : 880;
          gain.gain.setValueAtTime(1.0, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + beepSec);
          osc.start(t);
          osc.stop(t + beepSec + 0.05);
        }
      }
      setTimeout(() => ctx.close().catch(() => {}), (totalSec + 1) * 1000);
    } catch (_) { /* AudioContext unavailable */ }
  }

  function onWatchlistHitsChanged(changes) {
    if (!("sparkfraud.watchlist_hits" in changes)) return;
    const prev = (changes["sparkfraud.watchlist_hits"].oldValue || []).length;
    const next = (changes["sparkfraud.watchlist_hits"].newValue || []).length;
    if (next > prev) playWatchlistAlert();
  }
  chrome.storage.local.onChanged.addListener(onWatchlistHitsChanged);

  // ── 15. Cleanup ───────────────────────────────────────────────────
  return async () => {
    link.remove();
    clearInterval(watchlistRefreshTimer);
    chrome.storage.local.onChanged.removeListener(onWatchlistHitsChanged);
    // Container event listeners die when the shell wipes innerHTML.
    // Module-level state goes out of scope when mount() returns.
  };
}
