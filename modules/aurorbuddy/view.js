// modules/aurorbuddy/view.js
//
// AurorBuddy UI controller. Mounted by the shell on #/aurorbuddy.
// Adapted from donor extension/app.js. Behavioral changes are limited to
// shell-integration plumbing; rendering logic is preserved verbatim.
//
// Key migration changes:
//   - Exports mount(host, container) per docs/ARCHITECTURE.md::2
//   - All chrome.* calls routed through host.* (storage, messaging, tabs)
//     EXCEPT chrome.windows.create (for the receipt popup, which needs a
//     true OS-window — host doesn't abstract that yet) and chrome.scripting/
//     chrome.tabs.create from lib/ which run service-side.
//   - Selectors prefixed ab- to avoid collisions; queries scoped to container
//   - host.messaging.on subscriptions tracked + unsubscribed on cleanup
//   - Show-all-stores toggle on the module root (.module-aurorbuddy), not body
//   - localStorage["aurorbuddy:show-all-stores"] → host.storage.local
//   - Per-stage timings accumulated from each service response, rendered as
//     the donor's ⏱ Scan timings panel

import { mergeTimings } from "./lib/timings.js";

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
    container.innerHTML = `<div class="state-error">Failed to load AurorBuddy view: ${String(e?.message ?? e)}</div>`;
    return async () => { link.remove(); };
  }

  const $ = (id) => container.querySelector("#" + id);

  // ── 3. State ────────────────────────────────────────────────────────
  let currentDays  = "Last30days";
  let currentMiles = 20;
  // Cached store list from the most recent scan — lets the Fill Auror
  // handler look up the full address for the txn's store and include it
  // in the event description. Populated after each successful find_stores
  // call; cleared by clearResults().
  let _scanStores = [];
  // Timings accumulator — each service handler returns its own dict; this
  // merges them all into one panel rendered at the end of the scan.
  let _scanTimings = {};

  // Scan generation counter — every Search click bumps it. Each runFullScan
  // captures its own generation at start; any in-flight generation that
  // doesn't match scanGeneration is stale and bails out after the next
  // await. Underlying service-worker work still runs to completion but
  // its results are discarded.
  let scanGeneration = 0;
  let scanStartedAtGeneration = 0;
  let _scanFinalised = false;
  function newScanGeneration() {
    const g = ++scanGeneration;
    scanStartedAtGeneration = g;
    _scanFinalised = false;
    return g;
  }
  const isStale = (g) => g !== scanGeneration;
  const ticksBelongToCurrentScan = () =>
    !isStale(scanStartedAtGeneration) && !_scanFinalised;

  // ── 4. Listeners (form controls) ────────────────────────────────────
  $("ab-miles").addEventListener("input", (e) => {
    currentMiles = Number(e.target.value);
    $("ab-miles-label").textContent = String(currentMiles);
  });

  container.querySelectorAll(".ab-days-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentDays = btn.dataset.days;
      container.querySelectorAll(".ab-days-btn").forEach((b) =>
        b.classList.toggle("is-active", b === btn));
    });
  });

  // Show-all-stores toggle — class lives on the module root (container).
  const showAllCheckbox = $("ab-show-all-stores");
  const stored = await host.storage.local.get("showAllStores");
  showAllCheckbox.checked = stored === true || stored === "1";
  applyShowAll(showAllCheckbox.checked);
  showAllCheckbox.addEventListener("change", () => {
    host.storage.local.set("showAllStores", showAllCheckbox.checked).catch(() => {});
    applyShowAll(showAllCheckbox.checked);
  });

  // Auror auto-login username — persisted to chrome.storage.sync per-user.
  // Used by the service worker's ensureAurorAuth slow path to auto-fill the
  // Auror Auth0 identifier page (login.us.auror.co/u/login/identifier) so
  // the SSO flow can complete without the user touching the background tab.
  const usernameInput = $("ab-auror-username");
  if (usernameInput) {
    const savedUsername = await host.storage.sync.get("aurorUsername");
    if (typeof savedUsername === "string") usernameInput.value = savedUsername;
    usernameInput.addEventListener("change", () => {
      host.storage.sync.set("aurorUsername", usernameInput.value.trim()).catch(() => {});
    });
  }
  function applyShowAll(val) {
    container.classList.toggle("show-all-stores", !!val);
    container.querySelectorAll(".card-block").forEach(refreshCardCount);
    refreshHiddenCount();
  }

  function refreshCardCount(cardBlock) {
    const counter = cardBlock.querySelector(".card-count");
    if (!counter) return;
    const total   = Number(cardBlock.dataset.txnTotal || 0);
    const homeCnt = Number(cardBlock.dataset.txnHome  || 0);
    const others  = total - homeCnt;
    const showing = container.classList.contains("show-all-stores") ? total : homeCnt;
    if (total === 0) {
      counter.textContent = "0 transactions";
    } else if (others === 0) {
      counter.textContent = `${total} transaction${total === 1 ? "" : "s"}`;
    } else {
      counter.textContent =
        `${showing} of ${total} transaction${total === 1 ? "" : "s"} ` +
        `(${homeCnt} at your store, ${others} at others)`;
    }
  }

  // ── 5. Event delegation for dynamic table buttons (CSP-safe) ────────
  const delegatedClick = (e) => {
    const btn = e.target.closest(
      "button.save-evidence, button.fill-auror, button.receipt-popup, button.open-dl-settings"
    );
    if (!btn) return;
    if (btn.classList.contains("save-evidence"))       saveEvidence(btn);
    else if (btn.classList.contains("fill-auror"))     fillAuror(btn);
    else if (btn.classList.contains("receipt-popup")) openReceiptPopup(btn);
    else if (btn.classList.contains("open-dl-settings"))
      host.tabs.create({ url: "edge://settings/downloads" });
  };
  container.addEventListener("click", delegatedClick);

  const delegatedError = (e) => {
    const el = e.target;
    if (!(el instanceof HTMLImageElement)) return;
    if (!el.classList.contains("mug")) return;
    const ph = document.createElement("div");
    ph.className   = "mug mug-empty";
    ph.textContent = "?";
    el.replaceWith(ph);
  };
  container.addEventListener("error", delegatedError, true);

  // ── 6. Search button ───────────────────────────────────────────────
  $("ab-btn-search").addEventListener("click", () => {
    const myGen = newScanGeneration();
    runFullScan(myGen).catch((err) => {
      if (err?.message === "__stale_scan__" || isStale(myGen)) return;
      console.error("[AurorBuddy] scan failed:", err);
      setProgress(`✗ ${String(err?.message ?? err)}`);
      const btn = $("ab-btn-search");
      if (btn) btn.disabled = false;
    });
  });

  // ── 7. Receipt popup window ────────────────────────────────────────
  async function openReceiptPopup(btn) {
    const url = btn?.dataset?.url;
    const tid = btn?.dataset?.tid || "";
    if (!url) { console.warn("[AurorBuddy] receipt btn has no url"); return; }

    try {
      if (tid) {
        const wins = await chrome.windows.getAll({ populate: true });
        for (const w of wins) {
          if (w.type !== "popup") continue;
          const match = (w.tabs || []).some((t) => t.url && t.url.startsWith(url));
          if (match) {
            await chrome.windows.update(w.id, { focused: true });
            return;
          }
        }
      }
      await chrome.windows.create({
        url, type: "popup", width: 720, height: 1000, focused: true,
      });
    } catch (err) {
      console.error("[AurorBuddy] receipt popup failed:", err);
      try { await host.tabs.create({ url }); } catch {}
    }
  }

  // ── 8. Save Evidence ───────────────────────────────────────────────
  async function saveEvidence(btn) {
    const tid      = btn.dataset.txnid || "";
    const suspect  = btn.dataset.suspect || "unknown";
    const statusEl = container.querySelector(`#savestatus-${cssEscape(tid)}`);
    console.log("[AurorBuddy] Save click", { tid, suspect });

    btn.disabled = true;
    btn.textContent = "⏳ Saving receipt…";
    if (statusEl) {
      statusEl.textContent = "opening Secure receipt viewer…";
      statusEl.classList.remove("hidden");
    }

    try {
      const resp = await host.messaging.send("download_evidence", {
        transactionId: tid,
        suspectName:   suspect,
      });
      const cctv    = resp.cctv    || {};
      const receipt = resp.receipt || {};
      const parts = [];
      if (cctv.disabled)   parts.push("CCTV: disabled");
      else if (cctv.error) parts.push(`CCTV: ${cctv.error}`);
      else                 parts.push(`CCTV: ${cctv.segments ?? 0} seg, ${Math.round((cctv.bytes || 0) / 1024)} KB`);
      if (receipt.error)   parts.push(`Receipt: ${receipt.error}`);
      else                 parts.push(`Receipt: ${Math.round((receipt.bytes || 0) / 1024)} KB`);

      const allOk = !receipt.error && (cctv.disabled || !cctv.error);
      btn.textContent = allOk ? "✓ Saved" : "⚠ Partial";
      btn.classList.remove("btn-gray");
      btn.classList.add(allOk ? "btn-green" : "btn-red");
      if (statusEl) {
        statusEl.innerHTML =
          `Saved to <code>%USERPROFILE%\\Downloads\\${escapeHtml(resp.folder || "")}</code>` +
          ` · ${escapeHtml(parts.join(" · "))} ` +
          `<button type="button" class="btn-gray open-dl-settings" style="padding:1px 6px;font-size:10px">Change download folder</button>`;
      }
    } catch (err) {
      btn.textContent = "✗ Error";
      btn.disabled = false;
      if (statusEl) statusEl.textContent = String(err?.message ?? err);
    }
  }

  // ── 9. Fill Auror Event ────────────────────────────────────────────
  async function fillAuror(btn) {
    const txn        = JSON.parse(btn.dataset.txn || "{}");
    const suspect    = btn.dataset.suspect || "";
    const personId   = btn.dataset.personid || "";
    const tid        = btn.dataset.fillid || "";
    const statusEl   = container.querySelector(`#fillstatus-${cssEscape(tid)}`);
    const store      = ($("ab-store").value || "").trim();
    const match      = _scanStores.find((s) => String(s.number) === String(txn.store ?? store));
    const storeDetails = match?.auror_site
      ? match.auror_site.replace(/^SITE:\s*/i, "").replace(/^WALMART\s+/i, "Walmart ")
      : `Walmart ${txn.store ?? store}`;
    console.log("[AurorBuddy] Fill click", { tid, suspect, store, personId, storeDetails, txn });

    btn.disabled = true;
    btn.textContent = "⏳ Filling…";
    if (statusEl) { statusEl.textContent = "opening Auror tab…"; statusEl.classList.remove("hidden"); }

    try {
      const resp = await host.messaging.send("create_event", {
        store,
        suspectName: suspect,
        personId,
        storeDetails,
        transaction: txn,
      });
      if (resp.status === "filled") {
        btn.textContent = "✓ Filled";
        btn.classList.remove("btn-blue");
        btn.classList.add("btn-green");
        if (statusEl) {
          const openLink = resp.url
            ? ` — <a href="${resp.url}" target="_blank" rel="noopener">open draft</a>`
            : "";
          statusEl.innerHTML = `Form ready for review${openLink}. Click Publish in Auror when done.`;
        }
      } else {
        btn.textContent = "✗ Failed";
        btn.disabled = false;
        if (statusEl) statusEl.textContent = resp.error || "unknown error";
      }
    } catch (err) {
      btn.textContent = "✗ Error";
      btn.disabled = false;
      if (statusEl) statusEl.textContent = String(err?.message ?? err);
    }
  }

  // ── 10. Live streamed progress from service handlers ──────────────
  const offSubs = [];
  offSubs.push(host.messaging.on("download_progress", (msg) => {
    const { phase, received, expected, bytes, message, fetched, total, count, errors, missing } = msg;
    if (phase === "start")                    setProgress(message || "Saving evidence…");
    else if (phase === "cctv_open")           setProgress("Opening CCTV viewer…");
    else if (phase === "cctv_playlist")       setProgress(`CCTV: playlist has ${expected} segments`);
    else if (phase === "cctv_segment_seen")   setProgress(`CCTV: ${received}/${expected || "?"} segment URLs seen`);
    else if (phase === "cctv_fetch_start")    setProgress(`CCTV: fetching ${count} segments…`);
    else if (phase === "cctv_fetch_progress") setProgress(`CCTV: ${fetched}/${total} segments fetched${errors ? ` · ${errors} error(s)` : ""}`);
    else if (phase === "cctv_segment")        setProgress(`CCTV: ${received}/${total} segments fetched`);
    else if (phase === "cctv_saved")          setProgress(`CCTV saved (${Math.round((bytes || 0) / 1024)} KB)${missing ? ` · ${missing} segment(s) missing` : ""}`);
    else if (phase === "receipt_open")        setProgress("Opening receipt viewer…");
    else if (phase === "receipt_fetch")       setProgress("Fetching receipt image…");
    else if (phase === "receipt_saved")       setProgress(`Receipt saved (${Math.round((bytes || 0) / 1024)} KB)`);
    else if (phase === "done")                setProgress("Evidence download complete.");
  }));

  offSubs.push(host.messaging.on("fill_progress", (msg) => {
    setProgress(`Fill Auror: ${msg.line}`);
  }));

  offSubs.push(host.messaging.on("appriss_progress", (msg) => {
    if (!ticksBelongToCurrentScan()) return;
    const { phase, completed = 0, total = 0, matched = 0, errors, suspect, timeouts, windowMs } = msg;

    if (phase === "start") {
      setProgress("");
      setCtxReviewing(0, total, 0);
      setScanProgressBar({ completed: 0, total, matched, visible: true });
      ensureSuspectsTable();
    } else if (phase === "tick") {
      if (suspect) appendSuspectRow(suspect);
      setCtxReviewing(completed, total, matched);
      setScanProgressBar({ completed, total, matched, visible: true });
    } else if (phase === "congestion") {
      const secs = Math.round((windowMs ?? 30_000) / 1000);
      setWarning(
        `⚠ Secure is congested — ${timeouts ?? 3}+ request timeouts in the last ${secs}s. ` +
        `The scan will continue and retry, but expect longer load times.`
      );
    } else if (phase === "done") {
      const errLine = errors ? ` (${errors} error${errors === 1 ? "" : "s"})` : "";
      setCtxLine("ab-ctx-reviewing",
        `Reviewed all <b>${total}</b> individual${total === 1 ? "" : "s"} — <b>${matched}</b> with transactions at your store${errLine}.`);
      setScanProgressBar({ completed, total, matched, visible: true, done: true });
      setTimeout(() => setScanProgressBar({ visible: false }), 4000);
    }
  }));

  // ── 11. Main scan flow ────────────────────────────────────────────
  async function runFullScan(myGen) {
    const store = $("ab-store").value.trim();
    if (!store) return alert("Enter a home store number first.");

    const check = () => { if (isStale(myGen)) throw new Error("__stale_scan__"); };
    const scanStartedAt = Date.now();

    clearResults();
    $("ab-step-2").classList.remove("hidden");
    setPill("auror",   "checking");
    setPill("appriss", "checking");
    setProgress("Pre-flight: opening/reloading tabs, capturing JWT, checking Secure session…");

    const pre = await host.messaging.send("preflight");
    check();
    _scanTimings = mergeTimings(_scanTimings, pre.timings);
    const aurorOk   = !!pre.auror?.ok;
    const apprissOk = !!pre.appriss?.ok;
    setPill("auror",   aurorOk   ? "ok" : "fail", pre.auror?.reason);
    setPill("appriss", apprissOk ? "ok" : "fail", pre.appriss?.reason);

    if (!aurorOk || !apprissOk) {
      const parts = [];
      if (!aurorOk)   parts.push("Auror: "   + (pre.auror?.reason   ?? "unknown"));
      if (!apprissOk) parts.push("Secure: " + (pre.appriss?.reason ?? "unknown"));
      setProgress(parts.join(" · "));
      return;
    }

    setProgress(`Finding stores within ${currentMiles} mi of ${store}…`);
    const findResp = await host.messaging.send("find_stores", { store, miles: currentMiles });
    check();
    _scanTimings = mergeTimings(_scanTimings, findResp.timings);
    const result = findResp.result;
    const stores = result?.stores ?? [];
    if (!stores.length) {
      setProgress(`No stores found within ${currentMiles} mi of #${store}. Try a larger radius.`);
      return;
    }
    _scanStores = stores;
    renderStores(stores, result);
    setCtxStores(stores.length, currentMiles);

    setProgress(`Querying Auror (${currentDays})…`);
    const scanResp = await host.messaging.send("scan_auror", {
      stores, homeStore: store, days: currentDays,
    });
    check();
    _scanTimings = mergeTimings(_scanTimings, scanResp.timings);
    const suspects = scanResp.suspects ?? [];
    const diag     = scanResp.diag     ?? {};

    if (suspects.length === 0) {
      const diagLine = diag.rawTotal != null
        ? ` · Auror index reported ${diag.rawTotal} matching Person record(s); ${diag.rowsFetched ?? 0} fetched; ${diag.afterActionableFilter ?? 0} passed the actionable filter ($100-$10k, 2+ events, named).`
        : "";
      const hint = diag.rawTotal === 0
        ? " If you know suspects exist, either (a) the siteTraits format is off — check the 'auror_site' column above — or (b) they're outside the selected date range. Try 60/90 days."
        : "";
      setProgress(`Auror returned 0 suspects.${diagLine}${hint}`);
      console.log("[auror] full diag:", diag);
      renderTimings(_scanTimings);
      return;
    }

    setProgress(`Auror returned ${suspects.length} suspect(s) (index total: ${diag.rawTotal ?? "?"}). Cross-referencing Secure…`);
    setCtxIndividuals(suspects.length, _scanStores.length);

    const apprResp = await host.messaging.send("appriss_lookup", { suspects, homeStore: store });
    check();
    _scanTimings = mergeTimings(_scanTimings, apprResp.timings);
    const matched = apprResp.matched ?? [];
    const errors  = apprResp.errors  ?? [];

    const errLine = errors.length
      ? ` · ${errors.length} error(s): ${errors.slice(0, 3).map((e) => `${e.name} (${e.error.slice(0, 60)})`).join(" · ")}${errors.length > 3 ? "…" : ""}`
      : "";
    setProgress(`Secure matched ${matched.length} / ${suspects.length} at store ${store}.${errLine}`);
    _scanFinalised = true;
    renderSuspects(matched, store);
    renderTimings(_scanTimings);

    // Write the canonical /tool_scans row now that we know the post-pipeline
    // counts. Fire-and-forget — telemetry must never block the user-visible
    // result. The handler queues to chrome.storage.local on failure.
    host.messaging.send("record_scan_complete", {
      homeStore:          store,
      miles:              currentMiles,
      days:               currentDays,
      storesFound:        _scanStores.length,
      aurorSuspects:      suspects.length,
      actionableSuspects: Number(diag?.afterActionableFilter ?? suspects.length) || suspects.length,
      secureMatched:      matched.length,
      elapsedMs:          Date.now() - scanStartedAt,
    }).catch(() => {});
  }

  // ── 12. Rendering helpers ─────────────────────────────────────────
  function renderStores(stores, result) {
    const host_ = $("ab-stores-result");
    const headerCity  = result?.city ?? "";
    const headerState = result?.state ?? "";
    const headerZip   = result?.zip ?? "?";
    const homeNum     = String(result?.home ?? "");
    const badParseCount = stores.filter((s) => !s.parse_ok).length;

    const header = `${stores.length} nearby stores · scanning ${Math.max(0, stores.length - 1)} neighbours`
      + (headerCity ? ` · ${escapeHtml(headerCity)}, ${escapeHtml(headerState)}` : "")
      + ` (zip ${escapeHtml(headerZip)})`;

    const warning = badParseCount > 0
      ? `<div class="muted" style="color:var(--apai-error); margin-top:4px">
           ⚠ ${badParseCount} store address${badParseCount === 1 ? "" : "es"} didn't parse — Auror lookups for those stores will miss.
           Check the <code>raw address</code> column; if Walmart's format changed, update ADDR_RE in lib/stores.js.
         </div>`
      : "";

    const rows = stores.map((s) => {
      const isHome = s.number === homeNum;
      const badge  = isHome  ? `<span title="home store — excluded from Auror scan" style="color:var(--apai-muted)">home</span>` : "";
      const parseBadge = s.parse_ok ? "" : `<span title="ADDR_RE didn't match — auror_site will be missing street/city/state" style="color:var(--apai-error)">⚠</span>`;
      return `
        <tr${isHome ? ' style="background:#F9FAFB"' : ""}>
          <td>${escapeHtml(s.number)} ${badge} ${parseBadge}</td>
          <td>${escapeHtml(s.store_type)}</td>
          <td>${s.miles.toFixed(1)} mi</td>
          <td>${escapeHtml(s.city)}, ${escapeHtml(s.state)}</td>
          <td style="font-family:var(--font-mono);font-size:11px;color:var(--apai-muted)">${escapeHtml(s.address)}</td>
          <td style="font-family:var(--font-mono);font-size:11px;color:${s.parse_ok ? "var(--apai-blue)" : "var(--apai-error)"}">${escapeHtml(s.auror_site)}</td>
        </tr>`;
    }).join("");

    host_.innerHTML = `
      <div style="margin-top:8px">${header}</div>
      ${warning}
      <details style="margin-top:8px">
        <summary>Show store list (${stores.length})</summary>
        <table style="width:100%;margin-top:8px;border-collapse:collapse;font-size:13px">
          <thead>
            <tr style="text-align:left;border-bottom:1px solid var(--apai-border);color:var(--apai-muted)">
              <th style="padding:4px 8px">#</th>
              <th style="padding:4px 8px">Type</th>
              <th style="padding:4px 8px">Distance</th>
              <th style="padding:4px 8px">City / State</th>
              <th style="padding:4px 8px">Raw address</th>
              <th style="padding:4px 8px">auror_site (what Auror indexes on)</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </details>`;
  }

  function ensureSuspectsTable() {
    const hostEl = $("ab-suspects");
    let tbody = hostEl.querySelector("table.suspects tbody");
    if (tbody) return tbody;
    hostEl.innerHTML = `
      <table class="suspects">
        <thead>
          <tr>
            <th class="col-num">#</th>
            <th class="col-photo">Photo</th>
            <th>Name</th>
            <th class="col-num">Events</th>
            <th class="col-total">Total $</th>
            <th>Flags</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>`;
    return hostEl.querySelector("table.suspects tbody");
  }

  function suspectRowsHtml(s, i) {
    const photo = s.photo_url
      ? `<img src="${escapeHtml(s.photo_url)}" alt="" class="mug">`
      : `<div class="mug mug-empty">?</div>`;
    const nameCell = s.auror_url
      ? `<a href="${escapeHtml(s.auror_url)}" target="_blank" rel="noopener"><b>${escapeHtml(s.name || "Unknown")}</b></a>`
      : `<b>${escapeHtml(s.name || "Unknown")}</b>`;
    const personId = s.person_id ? `<div class="muted mono tiny">${escapeHtml(s.person_id)}</div>` : "";
    const threat   = s.threatening
      ? `<span class="badge badge-threat" title="${escapeHtml((s.threatening_types || []).join(", "))}">⚠ THREAT</span>`
      : "";
    const orc      = s.is_orc ? `<span class="badge badge-orc">ORC</span>` : "";

    const hasHomeTxn = (s.appriss_cards || []).some((c) =>
      (c.transactions || []).some((t) => t.at_home)
    );
    const rowCls = [
      "suspect-row",
      i % 2 ? "zebra" : "",
      hasHomeTxn ? "suspect-has-home-txns" : "suspect-no-home-txns",
    ].filter(Boolean).join(" ");
    const detCls = hasHomeTxn ? "appriss-detail" : "appriss-detail suspect-no-home-txns";

    return `
      <tr class="${rowCls}">
        <td class="col-num muted">${i + 1}</td>
        <td class="col-photo">${photo}</td>
        <td>${nameCell}${personId}</td>
        <td class="col-num mono">${s.event_count}</td>
        <td class="col-total mono total-val">$${Number(s.total_value).toFixed(2)}</td>
        <td>${threat}${orc}</td>
      </tr>
      <tr class="${detCls}">
        <td colspan="6">${renderApprissHtml(s)}</td>
      </tr>`;
  }

  function appendSuspectRow(suspect) {
    const tbody = ensureSuspectsTable();
    const index = tbody.querySelectorAll("tr.suspect-row").length;
    tbody.insertAdjacentHTML("beforeend", suspectRowsHtml(suspect, index));
    refreshHiddenCount();
  }

  function refreshHiddenCount() {
    const tbody = container.querySelector("table.suspects tbody");
    if (!tbody) return;
    let hostEl = container.querySelector("#ab-hidden-count");
    if (!hostEl) {
      hostEl = document.createElement("div");
      hostEl.id = "ab-hidden-count";
      hostEl.className = "muted tiny";
      hostEl.style.marginTop = "8px";
      $("ab-suspects").appendChild(hostEl);
    }
    const total  = tbody.querySelectorAll("tr.suspect-row").length;
    const hidden = tbody.querySelectorAll("tr.suspect-row.suspect-no-home-txns").length;
    const visible = total - hidden;
    if (!total) {
      hostEl.textContent = "";
      return;
    }
    if (container.classList.contains("show-all-stores") || hidden === 0) {
      hostEl.textContent = `${total} suspect${total === 1 ? "" : "s"} matched in Secure.`;
    } else {
      hostEl.textContent =
        `${visible} suspect${visible === 1 ? "" : "s"} with home-store activity · ` +
        `${hidden} hidden (Secure summary flagged them but detail shows no home-store transactions — ` +
        `enable 'Show all stores' above to view).`;
    }
  }

  function renderSuspects(suspects, homeStore) {
    const hostEl = $("ab-suspects");
    if (!suspects.length) {
      hostEl.innerHTML = `<p class="muted">No suspects with Secure activity at store ${homeStore}.</p>`;
      return;
    }
    const tbody = ensureSuspectsTable();
    tbody.innerHTML = suspects.map((s, i) => suspectRowsHtml(s, i)).join("");
    // Match the streaming path: keep the 'N hidden by home-only filter'
    // summary line in sync after a batch re-render (e.g. when no
    // appriss_progress ticks fired during the scan).
    refreshHiddenCount();
  }

  function renderApprissHtml(s) {
    const cards = s.appriss_cards || [];
    if (!cards.length) {
      return `<span class="muted italic">No matching payment cards in Secure.</span>`;
    }
    let html = "";
    for (const card of cards) {
      const txns = card.transactions || [];
      const homeCount  = txns.filter((t) => t.at_home).length;
      const otherCount = txns.length - homeCount;
      let headerCount;
      if (txns.length === 0) {
        headerCount = "0 transactions";
      } else if (otherCount === 0) {
        headerCount = `${txns.length} transaction${txns.length === 1 ? "" : "s"}`;
      } else {
        headerCount =
          `${homeCount} of ${txns.length} transaction${txns.length === 1 ? "" : "s"} ` +
          `(${homeCount} at your store, ${otherCount} at others)`;
      }

      html += `
        <div class="card-block" data-txn-total="${txns.length}" data-txn-home="${homeCount}">
          <div class="card-head">
            <span class="card-name">${escapeHtml(card.name)}</span>
            <span class="card-last4 mono">****${escapeHtml(card.last4)}</span>
            <span class="card-count muted tiny">${headerCount}</span>
          </div>`;

      if (homeCount === 0 && otherCount > 0) {
        html += `
          <div class="hidden-rows-note muted tiny pad">
            No transactions at your store — ${otherCount} at other stores.
            Enable <b>Show all stores</b> above to view them.
          </div>`;
      }

      if (txns.length) {
        html += `
          <table class="txns">
            <thead>
              <tr>
                <th>Store</th>
                <th>Register</th>
                <th>Trans#</th>
                <th class="txt-right">Amount</th>
                <th>Date/Time</th>
                <th class="txt-center">Links</th>
              </tr>
            </thead>
            <tbody>`;
        txns.forEach((t, ti) => {
          const cctv = t.cctv_url
            ? `<a href="${escapeHtml(t.cctv_url)}" target="_blank" rel="noopener" class="btn-red">▶ CCTV</a>`
            : "";
          const rcpt = t.receipt_url
            ? `<button type="button" class="btn-green receipt-popup"
                  data-url="${escapeHtml(t.receipt_url)}"
                  data-tid="${escapeHtml(t.transaction_id || "")}"
               >🧾 Receipt</button>`
            : "";
          const save = t.transaction_id
            ? `<button type="button" class="btn-gray save-evidence"
                 data-txnid="${escapeHtml(t.transaction_id)}"
                 data-suspect="${escapeHtml(s.name || "unknown")}"
               >⬇ Save</button>
               <span class="save-status muted tiny" id="savestatus-${escapeHtml(t.transaction_id)}"></span>`
            : "";
          const fill = (t.transaction_id && t.register && t.datetime)
            ? `<button type="button" class="btn-orange fill-auror btn-pushed-right"
                 data-txn='${escapeHtml(JSON.stringify(t))}'
                 data-suspect="${escapeHtml(s.name || "")}"
                 data-personid="${escapeHtml(s.person_id || "")}"
                 data-fillid="${escapeHtml(t.transaction_id)}"
               >+ Create Auror Event</button>
               <span class="fill-status muted tiny" id="fillstatus-${escapeHtml(t.transaction_id)}"></span>`
            : "";
          const links = (cctv || rcpt || save || fill)
            ? `<div class="link-row">${cctv} ${rcpt} ${save} ${fill}</div>`
            : "—";
          const storeCell = t.at_home
            ? `<span class="mono">${escapeHtml(t.store)}</span> <span class="badge badge-home">HOME</span>`
            : `<span class="mono">${escapeHtml(t.store)}</span>`;
          const rowCls = [
            ti % 2 ? "zebra" : "",
            t.at_home ? "row-home" : "row-nonhome",
          ].filter(Boolean).join(" ");
          html += `
            <tr class="${rowCls}">
              <td>${storeCell}</td>
              <td class="mono">POS ${escapeHtml(t.register)}</td>
              <td class="mono">${escapeHtml(t.trans_no)}</td>
              <td class="mono txt-right bold">$${escapeHtml(t.amount)}</td>
              <td>${escapeHtml(t.datetime)}</td>
              <td class="txt-center">${links}</td>
            </tr>`;
        });
        html += `</tbody></table>`;
      } else {
        html += `<div class="muted tiny pad">No transactions found at this store.</div>`;
      }
      html += `</div>`;
    }
    return html;
  }

  // ── 13. Status / pill / progress / context helpers ────────────────
  function clearResults() {
    $("ab-stores-result").innerHTML = "";
    $("ab-suspects").innerHTML = "";
    $("ab-progress").textContent = "";
    setWarning("");
    resetScanContext();
    _scanStores = [];
    _scanTimings = {};
    const tCard = $("ab-timings-card");
    if (tCard) { tCard.classList.add("hidden"); tCard.open = false; }
    setPill("auror",   "checking");
    setPill("appriss", "checking");
    setScanProgressBar({ visible: false });
  }

  // Render the ⏱ Scan timings panel from the accumulated wire-format dict.
  // Sorted by total_s descending. Hidden when there's nothing to show.
  function renderTimings(timings) {
    const card = $("ab-timings-card");
    const body = $("ab-timings-body");
    if (!card || !body) return;
    const keys = Object.keys(timings || {});
    if (!keys.length) {
      card.classList.add("hidden");
      return;
    }
    keys.sort((a, b) => (timings[b].total_s || 0) - (timings[a].total_s || 0));
    const rows = keys.map((k) => {
      const s = timings[k];
      const total = (s.total_s ?? 0).toFixed(2).padStart(7, " ");
      const avg   = s.count > 1
        ? ` · avg ${(s.avg_s ?? 0).toFixed(2)}s × ${s.count}`
        : "";
      return `<div><span class="t-total">${escapeHtml(total)}s</span> &nbsp; ${escapeHtml(k)}${escapeHtml(avg)}</div>`;
    });
    body.innerHTML = rows.join("");
    card.classList.remove("hidden");
  }

  const PILL_LABELS = { auror: "Auror", appriss: "Secure" };
  function setPill(which, state, tooltip) {
    const el = $(`ab-pill-${which}`);
    if (!el) return;
    el.className = `pill pill-${state}`;
    const label = PILL_LABELS[which] ?? which.toUpperCase();
    el.textContent = `${label}: ${state}`;
    if (tooltip) el.title = tooltip;
    else el.removeAttribute("title");
  }

  function setProgress(msg) {
    $("ab-progress").textContent = msg;
  }

  function setWarning(msg) {
    const el = $("ab-warning");
    if (!el) return;
    if (msg) {
      el.textContent = msg;
      el.classList.remove("hidden");
    } else {
      el.textContent = "";
      el.classList.add("hidden");
    }
  }

  function setScanProgressBar({ completed = 0, total = 0, matched = 0, visible = true, done = false } = {}) {
    const bar = $("ab-scan-progressbar");
    if (!bar) return;
    bar.classList.toggle("hidden", !visible);
    bar.classList.toggle("done", !!done);
    if (!visible) return;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    bar.style.setProperty("--pct", `${pct}%`);
    const label = `${completed} / ${total} checked · ${matched} matched`;
    for (const el of bar.querySelectorAll(".progress-text")) el.textContent = label;
  }

  function resetScanContext() {
    $("ab-scan-context").classList.add("hidden");
    for (const id of ["ab-ctx-stores", "ab-ctx-individuals", "ab-ctx-reviewing"]) {
      const el = $(id);
      if (!el) continue;
      el.innerHTML = "";
      el.classList.remove("active");
    }
  }
  function setCtxLine(id, html) {
    $("ab-scan-context").classList.remove("hidden");
    const el = $(id);
    el.innerHTML = html;
    el.classList.add("active");
  }
  function setCtxStores(n, miles) {
    setCtxLine("ab-ctx-stores",
      `We've located <b>${n}</b> store${n === 1 ? "" : "s"} within <b>${miles}</b> miles of you.`);
  }
  function setCtxIndividuals(individuals, storeCount) {
    setCtxLine("ab-ctx-individuals",
      `We have identified <b>${individuals}</b> individual${individuals === 1 ? "" : "s"} at ` +
      `those <b>${storeCount}</b> store${storeCount === 1 ? "" : "s"} that have a high probability of having ` +
      `impacted your store.`);
  }
  function setCtxReviewing(current, total, matched) {
    setCtxLine("ab-ctx-reviewing",
      `Reviewing individual <b>${current}</b> of <b>${total}</b> for transactions at your store — ` +
      `<b>${matched}</b> individual${matched === 1 ? "" : "s"} found with transactions so far.`);
  }

  // ── 13b. Awaiting final value (Mark Submitted UX, V1) ─────────────
  // FINAL_VALUE_CAPTURE_PLAN.md §2 Option A: list this analyst's submitted
  // events with no confirmed finalEventValue and let them enter / skip.
  const awaitingCard = $("ab-awaiting");
  const awaitingBody = $("ab-awaiting-body");
  const awaitingRefreshBtn = $("ab-awaiting-refresh");

  async function refreshAwaitingFinalValue() {
    if (!awaitingCard || !awaitingBody) return;
    try {
      const res = await host.messaging.send("list_awaiting_final_value", {});
      const rows = res?.rows || [];
      if (!rows.length) {
        awaitingCard.classList.add("hidden");
        awaitingBody.innerHTML = "";
        return;
      }
      awaitingCard.classList.remove("hidden");
      awaitingBody.innerHTML = rows.map((r) => {
        const ts = r.createdAt ? new Date(r.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
        const cand = (r.transactionTotalCandidate != null)
          ? `$${Number(r.transactionTotalCandidate).toFixed(2)}`
          : "—";
        const aurorLink = r.aurorEventUrl
          ? `<a href="${escapeHtml(r.aurorEventUrl)}" target="_blank" rel="noopener">Event ${escapeHtml(r.aurorEventId || "")}</a>`
          : `Event ${escapeHtml(r.aurorEventId || "")}`;
        return `
          <div class="ab-awaiting-row" data-event-id="${escapeHtml(r.aurorEventId || "")}" data-workflow-id="${escapeHtml(r.workflowId || "")}">
            <div class="ab-awaiting-meta">
              <div><b>${escapeHtml(r.suspectName || "(unknown suspect)")}</b> · ${escapeHtml(r.storeNumber || "")} · ${ts}</div>
              <div class="muted small">Candidate (tender): ${cand} · ${aurorLink}</div>
            </div>
            <div class="ab-awaiting-action">
              <span class="ab-money-prefix">$</span>
              <input type="number" min="0" step="0.01" class="input ab-final-value-input" placeholder="final value">
              <button class="btn btn-primary btn-sm ab-mark-submitted">Mark Submitted</button>
              <button class="btn btn-secondary-sm ab-mark-skipped">Skip</button>
            </div>
            <div class="ab-awaiting-status muted small"></div>
          </div>
        `;
      }).join("");
    } catch (err) {
      console.warn("[AurorBuddy] refreshAwaitingFinalValue failed:", err?.message || err);
    }
  }

  async function submitMark(row, { skipped }) {
    const aurorEventId = row.dataset.eventId;
    const workflowId = row.dataset.workflowId || null;
    const input = row.querySelector(".ab-final-value-input");
    const statusEl = row.querySelector(".ab-awaiting-status");
    if (!aurorEventId) return;
    let finalEventValue = null;
    if (!skipped) {
      const raw = (input?.value || "").trim();
      if (!raw) {
        statusEl.textContent = "Enter a value or click Skip.";
        return;
      }
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0) {
        statusEl.textContent = "Enter a non-negative number.";
        return;
      }
      finalEventValue = v;
    }
    // Disable the row while in-flight.
    row.querySelectorAll("button, input").forEach((el) => (el.disabled = true));
    statusEl.textContent = skipped ? "Recording as unknown…" : "Confirming…";
    try {
      const res = await host.messaging.send("mark_event_submitted", {
        aurorEventId,
        workflowId,
        finalEventValue,
        skipped: !!skipped,
      });
      if (res?.ok) {
        statusEl.textContent = skipped ? "✓ Marked unknown." : `✓ Confirmed $${finalEventValue.toFixed(2)}.`;
        // Remove the row after a brief delay so the user sees the confirmation.
        setTimeout(() => {
          row.remove();
          if (!awaitingBody.querySelector(".ab-awaiting-row")) awaitingCard.classList.add("hidden");
        }, 800);
      } else {
        statusEl.textContent = `✗ ${res?.error || "failed"}`;
        row.querySelectorAll("button, input").forEach((el) => (el.disabled = false));
      }
    } catch (err) {
      statusEl.textContent = `✗ ${String(err?.message ?? err)}`;
      row.querySelectorAll("button, input").forEach((el) => (el.disabled = false));
    }
  }

  if (awaitingBody) {
    awaitingBody.addEventListener("click", (e) => {
      const mark = e.target.closest(".ab-mark-submitted");
      const skip = e.target.closest(".ab-mark-skipped");
      if (!mark && !skip) return;
      const row = e.target.closest(".ab-awaiting-row");
      if (!row) return;
      submitMark(row, { skipped: !!skip });
    });
  }
  if (awaitingRefreshBtn) {
    awaitingRefreshBtn.addEventListener("click", refreshAwaitingFinalValue);
  }
  // Initial load + refresh on every successful create_event (the moment a
  // new awaiting row would appear). The create_event call site doesn't emit
  // a discrete "completed" event today, so use a coarse 30s poll while the
  // module is mounted. Cheap (one Firestore read).
  refreshAwaitingFinalValue();
  const awaitingPollId = setInterval(refreshAwaitingFinalValue, 30_000);

  // ── 14. Cleanup ───────────────────────────────────────────────────
  return async () => {
    link.remove();
    container.removeEventListener("click", delegatedClick);
    container.removeEventListener("error", delegatedError, true);
    for (const off of offSubs) {
      try { off(); } catch {}
    }
    clearInterval(awaitingPollId);
    // Bump scanGeneration so any in-flight scan bails on its next check().
    scanGeneration++;
  };
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]
  ));
}

// CSS.escape polyfill — used to safely interpolate transaction IDs into
// `#savestatus-${tid}` selectors. CSS.escape exists in all modern browsers
// but defensively fall back if missing.
function cssEscape(s) {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(String(s));
  return String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}
