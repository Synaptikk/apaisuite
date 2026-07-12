// modules/licenseintake/view.js
//
// Full-page UI for LicenseIntake. Mounts into the suite shell page;
// fetches view.html + styles.css from the module's own dir, wires the
// scanner-input → parse → search → review flow.
//
// PII rules applied here:
//   - The "preview" line uses redactedPreview only.
//   - The "show full fields" is a <details> collapsed by default — the
//     operator must explicitly expand to see DOB / DL# / address.
//   - The host.logging.emit() path auto-redacts (we extended forbidden
//     keys in module.js::register), but we ALSO never pass raw values
//     to console.log here — only counts, statuses, sessionIds.

import { copyDraftToClipboard } from "./lib/auror_person_draft_adapter.js";
import { formatDraftForClipboard } from "./lib/auror_person_draft_adapter.js";
import { summarizeCandidates, scoreTransactionCandidate } from "./lib/card_lookup_adapter.js";

export async function mount(host, container) {
  // 1. Inject this module's stylesheet (removed on cleanup).
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = host.url("styles.css");
  link.dataset.module = host.id;
  document.head.appendChild(link);

  // 2. Load markup.
  try {
    const resp = await fetch(host.url("view.html"));
    container.innerHTML = await resp.text();
  } catch (e) {
    container.innerHTML = `<div class="state-error">Failed to load License Intake view: ${String(e?.message ?? e)}</div>`;
    return () => { link.remove(); };
  }

  const $ = (id) => container.querySelector("#" + id);

  // ── Settings + dry-run ─────────────────────────────────────────────
  const settingsResp = await host.messaging.send("get_settings");
  const settings = settingsResp?.data || { dryRun: true, defaultHomeStore: null };
  let dryRun = !!settings.dryRun;
  let homeStore = settings.defaultHomeStore || "";
  $("li-dryrun-toggle").checked = dryRun;
  $("li-home-store").value = homeStore;
  updateModePill();

  // If no home store is saved yet, try to auto-detect from the Auror email.
  if (!homeStore) {
    host.messaging.send("resolve_home_store").then((r) => {
      if (r?.data?.homeStore) {
        homeStore = r.data.homeStore;
        $("li-home-store").value = homeStore;
        setStatus(`APPRISS store auto-detected: ${homeStore}`, "ok");
      }
    }).catch(() => { /* non-blocking — user can still type manually */ });
  }

  $("li-dryrun-toggle").addEventListener("change", async (e) => {
    dryRun = e.target.checked;
    await host.messaging.send("set_settings", { patch: { dryRun } });
    updateModePill();
    setStatus(dryRun ? "Dry-run on" : "Dry-run OFF — live calls enabled", "");
  });

  $("li-home-store").addEventListener("change", async (e) => {
    homeStore = e.target.value.trim();
    await host.messaging.send("set_settings", { patch: { defaultHomeStore: homeStore } });
    setStatus(homeStore ? `Home store set to ${homeStore}` : "Home store cleared", "");
  });

  function updateModePill() {
    const pill = $("li-mode-pill");
    pill.textContent = dryRun ? "DRY_RUN" : "LIVE";
    pill.className = "pill " + (dryRun ? "pill-info" : "pill-warn");
  }

  function setStatus(text, kind /* "ok" | "error" | "warn" | "" */) {
    const el = $("li-status");
    el.textContent = text || "";
    el.className = "li-status" + (kind ? ` li-status-${kind}` : "");
  }

  // ── Current session in this view ───────────────────────────────────
  /** @type {import("./lib/intake_models.js").IntakeSession | null} */
  let currentSession = null;

  // ── Flatbed scanner button ─────────────────────────────────────────
  const flatbedBtn    = $("li-flatbed-btn");
  const flatbedHint   = $("li-flatbed-hint");
  const printToggle   = $("li-print-toggle");
  const dlPreviewWrap = $("li-dl-preview-wrap");
  const dlPreviewImg  = $("li-dl-preview-img");
  const dlPreviewCap  = $("li-dl-preview-caption");
  const dlPreviewPath = $("li-dl-preview-path");

  flatbedBtn.addEventListener("click", async () => {
    flatbedBtn.disabled = true;
    flatbedBtn.textContent = "⏳ Scanning…";
    flatbedHint.textContent = "Scanner warming up — do not move the license.";
    setStatus("Scanning with Canon…", "");
    dlPreviewWrap.hidden = true;

    let resp;
    try {
      resp = await host.messaging.send("scan_from_flatbed", {
        print: printToggle.checked,
      });
    } catch (err) {
      flatbedBtn.textContent = "📄 Scan with Canon";
      flatbedBtn.disabled = false;
      flatbedHint.textContent = "Place license on flatbed (front or back - OCR + barcode supported).";
      setStatus(`Scan error: ${err?.message || err}`, "error");
      return;
    }

    flatbedBtn.textContent = "📄 Scan with Canon";
    flatbedBtn.disabled = false;
    flatbedHint.textContent = "Place license on flatbed (front or back - OCR + barcode supported).";

    if (!resp?.ok) {
      setStatus(`Scan failed: ${resp?.error || "unknown error"}`, "error");
      return;
    }

    const d = resp.data;

    // Show the DL preview image (base64 thumbnail from host)
    if (d.croppedB64) {
      dlPreviewImg.src = `data:image/jpeg;base64,${d.croppedB64}`;
      if (d.barcodeDecoded) {
        dlPreviewCap.textContent = "✅ PDF417 barcode decoded — fields populated below.";
      } else if (d.ocrDecoded) {
        dlPreviewCap.textContent = "✅ OCR from front of license — fields populated below.";
      } else {
        dlPreviewCap.textContent = "⚠️ No barcode or text found — try repositioning the license.";
      }
      dlPreviewPath.textContent = d.croppedPath || "";
      dlPreviewWrap.hidden = false;
    }

    if (d.needsManualEntry) {
      setStatus(d.message || "Scan complete — barcode not found. Try the back of the license.", "warn");
      return;
    }

    // Successful decode: populate the session exactly like scan_and_search does.
    if (!d.sessionId) {
      setStatus("Scan response missing session ID.", "error");
      return;
    }

    const fullResp = await host.messaging.send("get_session", { sessionId: d.sessionId });
    if (!fullResp?.ok) { setStatus("Session lookup failed.", "error"); return; }
    currentSession = fullResp.data;
    const p = currentSession.parsedPerson;
    let printNote = "";
    if (printToggle.checked) {
      if (d.printOk === true)        printNote = ` · Printed on ${d.printPrinter || "Canon"}`;
      else if (d.printOk === false)  printNote = ` · Print failed: ${d.printError || "unknown"}`;
      else                           printNote = " · Print sent";
    }
    setStatus(
      `Scanned ✓ — ${p?.redactedPreview || "(no preview)"} · Auror ${currentSession.aurorMatchClass} · APPRISS ${currentSession.cardLookupClass}` +
      printNote,
      d.printOk === false ? "warn" : "ok",
    );
    renderAurorSection();
    renderCardSection();
    renderReviewSection();
    await refreshSessionList();
    const target = currentSession.aurorMatches?.length
      ? "li-auror-section"
      : currentSession.createPersonDraft
        ? "li-draft-section"
        : "li-cards-section";
    $(target)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });

  // ── Scanner input (focus-only capture; mirrors AurorImport pattern) ──
  const scannerInput = /** @type {HTMLTextAreaElement} */ ($("li-scanner-input"));
  const listenBadge = $("li-listen-badge");
  let parseTimer = null;

  function refreshListenBadge() {
    const focused = document.activeElement === scannerInput;
    listenBadge.textContent = focused ? "Listening — scan now" : "Click textarea to scan here";
    listenBadge.className = "pill li-listen " + (focused ? "pill-good" : "pill-warn");
  }
  scannerInput.addEventListener("focus", refreshListenBadge);
  scannerInput.addEventListener("blur", refreshListenBadge);
  refreshListenBadge();

  // Document-level capture so scanner-emitted Tab/Enter/Alt don't shift
  // focus mid-payload. Same rules as AurorImport: only active when the
  // scanner textarea is the currently-focused element.
  const onDocKeyDown = (e) => {
    if (document.activeElement !== scannerInput) return;
    // Let modifier combos through (Ctrl+V paste, Ctrl+A select-all,
    // Ctrl+Z undo) — they trigger a native `input`/`paste` event which
    // hits the listener below and reschedules the parse on its own.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    const k = e.key;
    let toAppend = "";
    if (k.length === 1) toAppend = k;
    else if (k === "Enter") toAppend = "\n";
    else if (k === "Tab") toAppend = "\t";
    else if (k === "Backspace") {
      scannerInput.value = scannerInput.value.slice(0, -1);
    }
    if (toAppend) {
      scannerInput.value += toAppend;
    }
    // ALWAYS reschedule on any keystroke into the scanner input, even
    // unrecognized ones (scanners often emit a final sentinel — F-key,
    // Escape, or an "Unidentified" key event for a special byte — that
    // we don't append but MUST treat as "burst still in flight" so the
    // debounce window stays open. Without this, the prior timer fires
    // before the burst finishes and the operator has to click Parse.
    scheduleParse();
  };
  document.addEventListener("keydown", onDocKeyDown, true);

  function scheduleParse() {
    if (parseTimer) clearTimeout(parseTimer);
    parseTimer = setTimeout(runParse, 200);
  }
  scannerInput.addEventListener("input", scheduleParse);

  // ── Parse flow ─────────────────────────────────────────────────────
  // Single-call workflow: parse → create session → Auror search →
  // (if no match) stage draft → APPRISS lookup → save. The operator
  // doesn't click anything between scanning and seeing results.
  async function runParse() {
    parseTimer = null;
    const raw = scannerInput.value || "";
    if (!raw) return;
    setStatus("Parsing + searching Auror + APPRISS…", "");
    let resp;
    try {
      resp = await host.messaging.send("scan_and_search", { rawText: raw });
    } catch (err) {
      setStatus(`Scan failed: ${err?.message || err}`, "error");
      return;
    }
    if (!resp?.ok) {
      setStatus(`Scan failed: ${resp?.error || "unknown"}`, "error");
      return;
    }
    // The controller did everything. Pull the fully-populated session.
    const fullResp = await host.messaging.send("get_session", { sessionId: resp.data.sessionId });
    if (!fullResp?.ok) { setStatus("Session lookup failed.", "error"); return; }
    currentSession = fullResp.data;
    const p = currentSession.parsedPerson;
    $("li-format-hint").textContent = resp.data.format || "";
    setStatus(`Scanned — ${p?.redactedPreview || "(no preview)"} · Auror ${currentSession.aurorMatchClass} · APPRISS ${currentSession.cardLookupClass}`, "ok");
    // Render only the actionable sections. Parsed-person panel is dropped
    // — the operator decides via Auror match (use existing) or draft fields.
    renderAurorSection();
    renderCardSection();
    renderReviewSection();
    await refreshSessionList();
    // Scroll to whichever section has actionable content.
    const target = currentSession.aurorMatches?.length
      ? "li-auror-section"
      : currentSession.createPersonDraft
        ? "li-draft-section"
        : "li-cards-section";
    $(target)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  $("li-parse-btn").addEventListener("click", runParse);
  $("li-clear-btn").addEventListener("click", () => {
    scannerInput.value = "";
    $("li-format-hint").textContent = "";
    currentSession = null;
    $("li-parsed-section").hidden = true;
    $("li-auror-section").hidden = true;
    $("li-draft-section").hidden = true;
    $("li-cards-section").hidden = true;
    $("li-review-section").hidden = true;
    setStatus("Cleared", "");
    scannerInput.focus();
  });

  // ── Parsed section render ──────────────────────────────────────────
  function renderParsedSection() {
    if (!currentSession?.parsedPerson) return;
    const p = currentSession.parsedPerson;
    $("li-preview").textContent = p.redactedPreview;
    const dl = $("li-fields");
    dl.innerHTML = "";
    for (const [k, label] of FIELD_LABELS) {
      if (p[k]) {
        const dt = document.createElement("dt"); dt.textContent = label;
        const dd = document.createElement("dd"); dd.textContent = String(p[k]);
        dl.appendChild(dt); dl.appendChild(dd);
      }
    }
    $("li-confidence").textContent = `Parse confidence ${(p.parseConfidence * 100).toFixed(0)}% · `;
    $("li-warnings").textContent = p.parseWarnings.length
      ? `Warnings: ${p.parseWarnings.join("; ")}`
      : "";
    $("li-parsed-section").hidden = false;
  }

  const FIELD_LABELS = [
    ["firstName", "First name"],
    ["middleName", "Middle name"],
    ["lastName", "Last name"],
    ["dob", "DOB"],
    ["licenseNumber", "License #"],
    ["sex", "Sex"],
    ["address1", "Street"],
    ["address2", "Street 2"],
    ["city", "City"],
    ["state", "State"],
    ["postalCode", "Postal"],
    ["expirationDate", "Expires"],
    ["issueDate", "Issued"],
    ["issuingState", "Issuing state"],
  ];

  // ── Auror section ──────────────────────────────────────────────────
  function renderAurorSection() {
    if (!currentSession) return;
    $("li-auror-section").hidden = false;
    // Always sync the draft section first so its visibility tracks the
    // session, regardless of which early-return branch we hit below
    // (idle / loading / error / empty-candidates). Without this, an
    // ERROR or empty-result run would leave section 4 hidden and the
    // operator would have no way to import the scanned license.
    toggleDraftSection();
    const meta = $("li-auror-meta");
    const list = $("li-auror-matches");
    list.innerHTML = "";
    if (currentSession.aurorSearchStatus === "idle") {
      meta.textContent = "Not searched yet.";
      return;
    }
    if (currentSession.aurorSearchStatus === "loading") {
      meta.textContent = "Searching…";
      return;
    }

    // Show Auror's top 5 as returned, in their order. Score is for
    // display only — Auror's relevance ranking is the source of truth.
    const allCands = currentSession.aurorMatches || [];
    const visible = allCands.slice(0, 5);

    let metaText = `Status: ${currentSession.aurorSearchStatus} · class: ${currentSession.aurorMatchClass} · showing ${visible.length} of ${allCands.length}`;
    // Only surface the error string if the CURRENT run actually failed.
    // Otherwise stale entries from prior runs (e.g. "no JWT captured")
    // leak into the meta line after a successful retry.
    if (currentSession.aurorSearchStatus === "error") {
      const aurorErr = (currentSession.errors || []).filter((e) => /auror search/i.test(e)).slice(-1)[0];
      if (aurorErr) metaText += ` · ${aurorErr}`;
    }
    // Show the most recent search note (UI-search hint, etc.) when no
    // candidates surfaced — that's exactly when the operator needs to
    // know whether the UI search couldn't reach the Auror tab.
    if (visible.length === 0 && Array.isArray(currentSession._aurorSearchNotes)) {
      const interestingNotes = currentSession._aurorSearchNotes.filter(
        (n) => /UI search|RELOAD|fallback/i.test(n),
      );
      if (interestingNotes.length) {
        metaText += ` · ${interestingNotes.slice(-1)[0]}`;
      }
    }
    meta.textContent = metaText;

    // If the UI-search failed because the Auror tab's content script is
    // stale, offer a one-click "Reload Auror tab" affordance.
    const needsReload = (currentSession._aurorSearchNotes || []).some(
      (n) => /RELOAD the Auror tab|Receiving end/i.test(n),
    );
    if (needsReload) {
      const reloadLi = document.createElement("li");
      reloadLi.className = "state-empty";
      reloadLi.innerHTML = `
        The Auror tab is running an old content script (this happens after
        every extension reload). Click below to reload the tab and re-search.
        <div style="margin-top:8px;">
          <button type="button" class="btn btn-primary" id="li-reload-auror">Reload Auror tab + re-search</button>
        </div>
      `;
      list.appendChild(reloadLi);
      reloadLi.querySelector("#li-reload-auror")?.addEventListener("click", async () => {
        setStatus("Reloading Auror tab…", "");
        const tabs = await chrome.tabs.query({ url: ["https://app.us.auror.co/*", "https://*.auror.co/*"] });
        if (!tabs.length) {
          setStatus("No Auror tab open. Open https://app.us.auror.co/ first.", "warn");
          return;
        }
        const tab = tabs.find((t) => t.active) || tabs[0];
        await chrome.tabs.reload(tab.id);
        setStatus("Auror tab reloading… give it a moment, then click Search Auror.", "");
      });
    }

    if (visible.length === 0) {
      // Section 3 has nothing useful — collapse it entirely and let
      // section 4 take over as the primary affordance. We pass `noResults`
      // to toggleDraftSection so it can switch into "primary" mode (open,
      // loud styling, "no Auror match" summary text).
      $("li-auror-section").hidden = true;
      toggleDraftSection({ noResults: true });
      return;
    }

    const ul = document.createElement("ul");
    ul.className = "li-match-list";
    const selectedPNumber = currentSession.selectedAurorPerson?.pNumber || null;
    for (const cand of visible) {
      const li = document.createElement("li");
      li.className = "li-match";
      const isSelected = cand.pNumber && cand.pNumber === selectedPNumber;
      if (isSelected) li.classList.add("li-match-selected");
      const photoHtml = cand.photoUrl
        ? `<img class="li-match-photo" alt="" src="${escapeAttr(cand.photoUrl)}" referrerpolicy="no-referrer" />`
        : `<div class="li-match-photo li-match-photo-empty">?</div>`;
      const nameHtml = cand.aurorUrl
        ? `<a class="li-match-name" href="${escapeAttr(cand.aurorUrl)}" target="_blank" rel="noopener"></a>`
        : `<span class="li-match-name"></span>`;
      const threatHtml = cand.threatening
        ? `<span class="pill pill-threat" title="threatening behaviors flagged">THREAT</span>`
        : "";
      const orcHtml = cand.isOrc
        ? `<span class="pill pill-orc" title="Organized Retail Crime flag">ORC</span>`
        : "";
      const selectedBadge = isSelected ? `<span class="pill pill-good">SELECTED</span>` : "";

      li.innerHTML = `
        <div class="li-match-row">
          ${photoHtml}
          <div class="li-match-body">
            <div class="li-match-head">
              ${nameHtml}
              <span class="pill li-match-score"></span>
            </div>
            <div class="li-match-sub">
              <span class="li-match-pnum mono"></span>
              <span class="li-match-stat"></span>
              <span class="li-match-stat li-match-total"></span>
              ${threatHtml}
              ${orcHtml}
              ${selectedBadge}
            </div>
            <div class="li-match-reasons"></div>
            <div class="li-match-actions">
              <button type="button" class="btn li-match-select">${isSelected ? "✓ Selected (click to change)" : "Use this person"}</button>
              ${cand.aurorUrl ? `<a class="btn" target="_blank" rel="noopener" href="${escapeAttr(cand.aurorUrl)}">Open in Auror ↗</a>` : ""}
            </div>
          </div>
        </div>
      `;
      // Fill text nodes (textContent is XSS-safe; we built the structure
      // above so we can drop user-controlled strings here without escaping).
      li.querySelector(".li-match-name").textContent = cand.displayName || "(no name)";
      li.querySelector(".li-match-score").textContent = `${Math.round((cand.matchScore || 0) * 100)}%`;
      li.querySelector(".li-match-pnum").textContent = cand.pNumber || "";
      const eventCount = Number(cand.eventCount || 0);
      const totalValue = Number(cand.totalValue || 0);
      li.querySelector(".li-match-stat").textContent = eventCount ? `${eventCount} event${eventCount === 1 ? "" : "s"}` : "";
      li.querySelector(".li-match-total").textContent = totalValue ? `$${totalValue.toFixed(2)}` : "";
      li.querySelector(".li-match-reasons").textContent = (cand.matchReasons || []).join(" + ");
      li.querySelector(".li-match-select").addEventListener("click", async () => {
        // Clicking SELECTED toggles: pass null to clear, otherwise the candidate.
        const payloadCand = isSelected ? null : cand;
        const r = await host.messaging.send("select_auror_person", {
          sessionId: currentSession.sessionId, candidate: payloadCand,
        });
        if (r?.ok) {
          currentSession = r.data;
          renderAurorSection();
          renderCardSection();
          setStatus(
            isSelected
              ? `Cleared selection.`
              : `Selected ${cand.displayName || cand.pNumber} — APPRISS 'Create Auror Event' will now link to this person.`,
            "ok",
          );
        }
      });
      ul.appendChild(li);
    }
    list.appendChild(ul);

    // Show draft section if NO match worth picking — i.e., no candidate
    // cleared the 50% bar. We ALWAYS show it when a draft exists, even
    // when there are decent candidates, so the operator can fall back
    // to "create new person" if none of the matches is right.
    toggleDraftSection();
  }

  // Centralized show/hide for the create-person card. Two display modes:
  //   - PRIMARY (noResults: true)  — section 3 is hidden; this card is the
  //     operator's main affordance. Card is open, full warn styling, summary
  //     text emphasises "no Auror match — create new person".
  //   - FALLBACK (default)         — section 3 shows Auror matches; this
  //     card collapses below as a "none of the above are right?" backstop.
  //     Quieter styling, summary text invites import as a backup.
  function toggleDraftSection({ noResults = false } = {}) {
    const section = $("li-draft-section");
    const details = $("li-draft-details");
    const summary = $("li-draft-summary-text");
    if (!currentSession?.createPersonDraft) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    if (noResults) {
      section.classList.remove("li-draft-fallback");
      if (details) details.open = true;
      if (summary) summary.textContent = "No Auror match — create new person from this license";
    } else {
      section.classList.add("li-draft-fallback");
      if (details) details.open = false;
      if (summary) summary.textContent = "Wrong person? Click to import this license as a new Auror person";
    }
    renderDraftSection(currentSession.createPersonDraft);
  }

  // Render the license-person draft as a visible field grid + collapsed
  // clipboard preview. The grid is the primary affordance — the <pre>
  // is only there for operators who want to paste manually into Auror.
  function renderDraftSection(draft) {
    const grid = $("li-person-grid");
    if (grid) {
      const a = draft.address || {};
      const heightStr = draft.heightInches
        ? `${Math.floor(draft.heightInches / 12)}'${draft.heightInches % 12}" (${draft.heightInches} in)`
        : null;
      const rows = [
        ["First name",    draft.firstName],
        ["Middle name",   draft.middleName],
        ["Last name",     draft.lastName],
        ["DOB",           draft.dob],
        ["Sex",           draft.sex],
        ["Height",        heightStr],
        ["Weight",        draft.weightPounds ? `${draft.weightPounds} lb` : null],
        ["License #",     draft.licenseNumber],
        ["Expires",       draft.expirationDate],
        ["Street",        a.street],
        ["City",          a.city],
        ["State",         a.state],
        ["Postal",        a.postal],
      ];
      grid.innerHTML = rows.map(([label, value]) => {
        const v = value && String(value).trim();
        return `<dt>${escapeAttr(label)}</dt>` +
               (v
                 ? `<dd>${escapeAttr(v)}</dd>`
                 : `<dd class="li-empty">—</dd>`);
      }).join("");
    }
    const pre = $("li-draft-preview");
    if (pre) pre.textContent = formatDraftForClipboard(draft);
    const status = $("li-handoff-status");
    if (status) status.textContent = "";
  }

  function escapeAttr(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  $("li-auror-search-btn").addEventListener("click", async () => {
    if (!currentSession) return;
    setStatus("Searching Auror…", "");
    const r = await host.messaging.send("search_auror", { sessionId: currentSession.sessionId });
    if (!r?.ok) { setStatus(`Search failed: ${r?.error}`, "error"); return; }
    currentSession = r.data.session;
    renderAurorSection();
    renderCardSection();
    setStatus(`Search done — class: ${currentSession.aurorMatchClass}`, "ok");
  });

  // ── Draft section ──────────────────────────────────────────────────
  $("li-copy-draft-btn").addEventListener("click", async () => {
    if (!currentSession?.createPersonDraft) return;
    const r = await copyDraftToClipboard(currentSession.createPersonDraft, { confirmed: true });
    setStatus(r.status === "ok" ? `Copied draft (${r.charsCopied} chars)` : `Copy failed: ${r.error}`,
              r.status === "ok" ? "ok" : "error");
  });

  $("li-handoff-btn").addEventListener("click", async () => {
    if (!currentSession?.createPersonDraft) return;
    const confirmed = window.confirm(
      "This opens Auror /event/new in a new tab. AurorBuddy will pre-fill " +
      "event details, type the name into the person lookup, and best-effort " +
      "fill DOB / DL # / address into the new-person sub-form.\n\n" +
      "You must review and click Submit yourself. Continue?"
    );
    if (!confirmed) return;

    // Auto-copy the formatted block so the operator can paste anything
    // AurorBuddy's selectors couldn't fill. Best-effort — clipboard
    // permission may be denied in some contexts; we don't block on it.
    let clipNote = "";
    try {
      const r = await copyDraftToClipboard(currentSession.createPersonDraft, { confirmed: true });
      clipNote = r.status === "ok" ? ` (copied ${r.charsCopied} chars to clipboard)` : "";
    } catch { /* ignore — clipboard is a nice-to-have here */ }

    const statusEl = $("li-handoff-status");
    if (statusEl) statusEl.textContent = "Opening Auror /event/new and driving the form…";
    setStatus("Driving Auror new-person form via AurorBuddy…", "");

    const r = await host.messaging.send("handoff_create_person", {
      sessionId: currentSession.sessionId, confirmed: true,
    });
    if (r?.ok) {
      currentSession = r.data.session;
      const res = r.data.result;
      const okish = res.status === "ok" || res.status === "dry_run";
      setStatus(`Handoff: ${res.status} (${res.mode || "n/a"})${clipNote}`, okish ? "ok" : "error");
      if (statusEl) {
        statusEl.textContent = okish
          ? `Tab opened. Review the form in Auror and click Submit when ready.${clipNote}`
          : `Handoff returned status=${res.status}. ${res.error || ""}${clipNote}`;
      }
      renderReviewSection();
    } else {
      setStatus(`Handoff failed: ${r?.error}`, "error");
      if (statusEl) statusEl.textContent = `Handoff failed: ${r?.error || "unknown error"}`;
    }
  });

  // ── Card lookup section ────────────────────────────────────────────
  function renderCardSection() {
    if (!currentSession) return;
    $("li-cards-section").hidden = false;
    const meta = $("li-cards-meta");
    const list = $("li-cards");
    list.innerHTML = "";
    if (currentSession.apprissLookupStatus === "idle") {
      meta.textContent = "Not run yet.";
      return;
    }
    if (currentSession.apprissLookupStatus === "loading") {
      meta.textContent = "Looking up…";
      return;
    }

    const blocks = currentSession._cardsBlocks || [];
    const totalTxns = blocks.reduce((n, b) => n + (b.transactions || []).length, 0);

    let metaText = `Status: ${currentSession.apprissLookupStatus} · class: ${currentSession.cardLookupClass}`;
    if (blocks.length > 0) {
      metaText += ` · ${blocks.length} card${blocks.length === 1 ? "" : "s"}, ${totalTxns} transaction${totalTxns === 1 ? "" : "s"}`;
    } else {
      metaText += ` · ${summarizeCandidates(currentSession.cardTransactionCandidates)}`;
    }
    const cardErr = (currentSession.errors || []).filter((e) => /card lookup/i.test(e)).slice(-1)[0];
    if (cardErr) metaText += ` · ${cardErr}`;
    if (
      blocks.length === 0 &&
      Array.isArray(currentSession._cardLookupNotes) &&
      currentSession._cardLookupNotes.length
    ) {
      metaText += ` · ${currentSession._cardLookupNotes.slice(-2).join(" · ")}`;
    }
    meta.textContent = metaText;

    if (blocks.length === 0) {
      list.innerHTML = `<li class="state-empty">No matching payment cards in APPRISS.</li>`;
      return;
    }

    // Relaxed-pass warning banner.
    if (currentSession._apprissRelaxedSurfaced) {
      const warn = document.createElement("div");
      warn.className = "li-cards-warn";
      warn.textContent = "First name on the license does NOT match these cardholders — these are other people with the same last name at your store.";
      list.appendChild(warn);
    }

    const suspectName = currentSession._apprissSuspectName
      || [currentSession.parsedPerson?.firstName, currentSession.parsedPerson?.lastName].filter(Boolean).join(" ")
      || "unknown";

    for (const block of blocks) {
      const cardEl = document.createElement("div");
      cardEl.className = "li-card-block";
      const txns = block.transactions || [];
      cardEl.innerHTML = `
        <div class="li-card-head">
          <span class="li-card-cardholder"></span>
          <span class="li-card-last4 mono"></span>
          <span class="li-card-txn-count"></span>
        </div>
        <table class="li-txns">
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
          <tbody></tbody>
        </table>
      `;
      cardEl.querySelector(".li-card-cardholder").textContent = block.name || "(no name)";
      cardEl.querySelector(".li-card-last4").textContent = block.last4 ? `****${block.last4}` : "(no last4)";
      cardEl.querySelector(".li-card-txn-count").textContent = `${txns.length} transaction${txns.length === 1 ? "" : "s"}`;

      const tbody = cardEl.querySelector("tbody");
      if (txns.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="state-empty">No transactions for this card.</td></tr>`;
      } else {
        txns.forEach((t, i) => {
          const tr = document.createElement("tr");
          tr.className = i % 2 ? "zebra" : "";
          tr.innerHTML = `
            <td class="mono"></td>
            <td class="mono"></td>
            <td class="mono"></td>
            <td class="mono txt-right bold"></td>
            <td></td>
            <td class="li-links txt-center"></td>
          `;
          const cells = tr.querySelectorAll("td");
          cells[0].textContent = t.store || "";
          cells[1].textContent = t.register ? `POS ${t.register}` : "";
          cells[2].textContent = t.transNo || "";
          cells[3].textContent = t.amount != null ? `$${t.amount}` : "";
          cells[4].textContent = t.datetime || "";

          const links = cells[5];
          if (t.cctvUrl) {
            const a = document.createElement("a");
            a.href = t.cctvUrl;
            a.target = "_blank";
            a.rel = "noopener";
            a.className = "btn btn-red";
            a.textContent = "▶ CCTV";
            links.appendChild(a);
          }
          if (t.receiptUrl) {
            const a = document.createElement("a");
            a.href = t.receiptUrl;
            a.target = "_blank";
            a.rel = "noopener";
            a.className = "btn btn-green";
            a.textContent = "🧾 Receipt";
            links.appendChild(a);
          }
          if (t.transactionId) {
            const saveBtn = document.createElement("button");
            saveBtn.type = "button";
            saveBtn.className = "btn btn-gray";
            saveBtn.textContent = "⬇ Save";
            saveBtn.title = "Download CCTV clip + receipt to Downloads/AurorBuddyDownloads/<suspect>/";
            saveBtn.addEventListener("click", async () => {
              saveBtn.disabled = true;
              const orig = saveBtn.textContent;
              saveBtn.textContent = "Saving…";
              try {
                const resp = await sendToBg("aurorbuddy", "download_evidence", {
                  transactionId: t.transactionId,
                  suspectName,
                });
                saveBtn.textContent = resp?.ok ? "✓ Saved" : "✗ Failed";
              } catch (err) {
                saveBtn.textContent = "✗ Error";
                console.warn("[lc/view] download_evidence error:", err?.message || err);
              } finally {
                setTimeout(() => { saveBtn.textContent = orig; saveBtn.disabled = false; }, 4000);
              }
            });
            links.appendChild(saveBtn);
          }
          if (t.transactionId && t.register && t.datetime) {
            const fillBtn = document.createElement("button");
            fillBtn.type = "button";
            fillBtn.className = "btn btn-orange";
            fillBtn.textContent = "+ Create Auror Event";
            fillBtn.title = "Open Auror /event/new pre-filled with this transaction (operator submits manually).";
            fillBtn.addEventListener("click", async () => {
              if (!homeStore) {
                fillBtn.textContent = "Set APPRISS store first";
                setTimeout(() => { fillBtn.textContent = "+ Create Auror Event"; }, 3000);
                return;
              }
              if (!window.confirm(`Open Auror /event/new pre-filled with txn ${t.transactionId}?`)) return;
              fillBtn.disabled = true;
              const orig = fillBtn.textContent;
              fillBtn.textContent = "Opening…";
              try {
                const sel = currentSession.selectedAurorPerson;
                // AurorBuddy's fromTransaction + lookupPerson1 both expect
                // personId in the form "P<digits>" (see auror_event.js:40
                // "auror_scraper returns it as 'P<digits>'; pass it through
                // unchanged"). Pass our pNumber as-is — don't strip the P.
                const personId = sel?.pNumber || null;
                const transactionShim = {
                  transaction_id: t.transactionId,
                  store: t.store,
                  cashier: null,
                  register: t.register,
                  trans_no: t.transNo,
                  amount: t.amount,
                  datetime: t.datetime,
                  cardholder: t.cardholder || block.name,
                };
                const resp = await sendToBg("aurorbuddy", "create_event", {
                  store: homeStore,
                  transaction: transactionShim,
                  // Prefer the selected Auror person's display name over the
                  // scanned license name — that's what AurorBuddy matches
                  // against in the autocomplete.
                  suspectName: sel?.displayName || suspectName,
                  personId,
                  storeDetails: null,
                  _source: "licenseintake",
                });
                fillBtn.textContent = resp?.ok ? "✓ Opened" : "✗ Failed";
                if (!resp?.ok) console.warn("[lc/view] create_event response:", resp);
              } catch (err) {
                fillBtn.textContent = "✗ Error";
                console.warn("[lc/view] create_event error:", err?.message || err);
              } finally {
                setTimeout(() => { fillBtn.textContent = orig; fillBtn.disabled = false; }, 4000);
              }
            });
            links.appendChild(fillBtn);
          }

          tbody.appendChild(tr);
        });
      }
      list.appendChild(cardEl);
    }
  }

  /**
   * Cross-module messaging from the view (extension page context). The
   * SW dispatcher routes by `{ module, type }` regardless of sender.
   */
  function sendToBg(targetModule, type, payload = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { module: targetModule, type, ...payload },
        (resp) => {
          if (chrome.runtime.lastError) {
            return reject(new Error(chrome.runtime.lastError.message));
          }
          resolve(resp);
        },
      );
    });
  }

  $("li-card-lookup-btn").addEventListener("click", async () => {
    if (!currentSession) return;
    setStatus("Running APPRISS lookup…", "");
    const r = await host.messaging.send("card_lookup", {
      sessionId: currentSession.sessionId,
      confirmed: true,
    });
    if (!r?.ok) { setStatus(`Lookup failed: ${r?.error}`, "error"); return; }
    currentSession = r.data.session;
    renderCardSection();
    setStatus(`Lookup done — class: ${currentSession.cardLookupClass}`, "ok");
  });

  // ── Review section ─────────────────────────────────────────────────
  function renderReviewSection() {
    if (!currentSession) return;
    $("li-review-section").hidden = false;
    $("li-notes").value = currentSession.notes || "";
  }

  $("li-mark-completed").addEventListener("click", async () => {
    if (!currentSession) return;
    const r = await host.messaging.send("mark_completed", {
      sessionId: currentSession.sessionId,
      notes: $("li-notes").value,
    });
    if (r?.ok) { currentSession = r.data; setStatus("Marked completed", "ok"); refreshSessionList(); }
  });

  $("li-mark-dismissed").addEventListener("click", async () => {
    if (!currentSession) return;
    const r = await host.messaging.send("mark_dismissed", { sessionId: currentSession.sessionId });
    if (r?.ok) { currentSession = r.data; setStatus("Dismissed", ""); refreshSessionList(); }
  });

  $("li-delete-session").addEventListener("click", async () => {
    if (!currentSession) return;
    if (!window.confirm("Delete this session permanently?")) return;
    const r = await host.messaging.send("delete_session", { sessionId: currentSession.sessionId });
    if (r?.ok) {
      currentSession = null;
      $("li-parsed-section").hidden = true;
      $("li-auror-section").hidden = true;
      $("li-draft-section").hidden = true;
      $("li-cards-section").hidden = true;
      $("li-review-section").hidden = true;
      setStatus("Deleted", "");
      refreshSessionList();
    }
  });

  // ── Session list ───────────────────────────────────────────────────
  async function refreshSessionList() {
    const r = await host.messaging.send("list_sessions");
    if (!r?.ok) return;
    const sessions = r.data.sessions;
    const list = $("li-sessions");
    list.innerHTML = "";
    if (sessions.length === 0) {
      list.innerHTML = `<li class="state-empty">No sessions yet.</li>`;
      return;
    }
    for (const s of sessions.slice(0, 20)) {
      const li = document.createElement("li");
      li.className = "li-session-row";
      const preview = s.parsedPerson?.redactedPreview || "(unparsed)";
      const when = new Date(s.lastUpdated).toLocaleString();
      li.innerHTML = `
        <span class="li-session-preview"></span>
        <span class="pill"></span>
        <span class="li-session-when"></span>
        <button type="button" class="btn">Open</button>
      `;
      li.querySelector(".li-session-preview").textContent = preview;
      li.querySelector(".pill").textContent = s.reviewStatus;
      li.querySelector(".li-session-when").textContent = when;
      li.querySelector("button").addEventListener("click", async () => {
        const got = await host.messaging.send("get_session", { sessionId: s.sessionId });
        if (got?.ok) {
          currentSession = got.data;
          renderParsedSection();
          renderAurorSection();
          renderCardSection();
          renderReviewSection();
        }
      });
      list.appendChild(li);
    }
  }
  await refreshSessionList();

  $("li-clear-all").addEventListener("click", async () => {
    if (!window.confirm("Permanently delete ALL stored license intake sessions?")) return;
    const r = await host.messaging.send("clear_all_sessions");
    if (r?.ok) { setStatus(`Cleared ${r.data.cleared} session(s)`, "ok"); refreshSessionList(); }
  });

  // Initial focus on the scanner input.
  scannerInput.focus();

  // Cleanup.
  return () => {
    document.removeEventListener("keydown", onDocKeyDown, true);
    if (parseTimer) clearTimeout(parseTimer);
    link.remove();
  };
}
