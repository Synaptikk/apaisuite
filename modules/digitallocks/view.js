// modules/digitallocks/view.js
//
// DigitalLocks UI controller. Mounted by the shell on #/digitallocks.
//
// Data flow:
//   mount → load latest import from IndexedDB (if any) + apply status
//           overlay from host.storage.local → render summary/filters/table
//   import → file picker → parseLockEventsFile → scoreEvents → ask user
//            (replace | append | archive) → putImport + applyOverlay →
//            switchImport(newId)
//   status edit → setStatus(...) → mutate row in memory → re-render only
//                 the affected rows / summary
//
// Single state object; setState() patches it and calls render(). No
// component framework — the module is small enough that imperative DOM
// updates keyed off the active tab are easier to follow than a fan-out
// of update(state) calls.

import { h, replace, clear }       from "./lib/dom.js";
import { parseLockEventsFile,
         normalize as normalizeLockEvents } from "./lib/parseLockEvents.js";
import { scoreEvents,
         groupIntoEpisodes,
         RISK_LEVEL_TO_BADGE_CLASS }              from "./lib/riskScoring.js";
import { newImportId, putImport, listImports,
         getImport, deleteImport,
         deleteImportsBefore,
         newMappingId, putMapping, getMapping,
         listMappings, deleteMapping }         from "./lib/db.js";
import { STATUSES, STATUS_LABEL,
         applyOverlay, setStatus, archiveImport } from "./lib/statusStore.js";
import { exportActiveCsv, exportChecklistCsv,
         exportHistoryCsv, exportCaseOpeningsCsv,
         exportCaseSummaryCsv }                   from "./lib/exportChecklist.js";
import { parseCaseItemsFile, lookupCaseItems }    from "./lib/parseCaseItems.js";

const POWER_BI_URL = "https://app.powerbi.com/groups/me/reports/a118e7e7-9431-4240-b630-04575d36cc37/217785fb10b56ddae020?ctid=3cbcc3d3-094d-4006-9849-0d11d61f484d&experience=power-bi";

const ACTIVE_KEY  = "activeImportId";   // host.storage.local
const MAPPING_KEY = "activeMappingId";  // host.storage.local

export async function mount(host, container) {
  // Hoisted so the await-then-cancelled-check guards below the fetch and
  // the rule-file Promise.all can read it. Flipped true by the cleanup
  // function the shell calls on route change.
  let cancelled = false;
  // Unsubscribe function for the daily-refresh storage watcher; set after
  // initial load and called in cleanup.
  let stopRefreshWatch = () => {};
  // Track any open <dialog> we appended to document.body so cleanup can
  // close them — otherwise an orphan dialog backdrop lingers on top of
  // the next module's UI after route change.
  const openDialogs = new Set();

  // ── Inject module stylesheet (shell wraps in .module-digitallocks) ──
  const styleLink = document.createElement("link");
  styleLink.rel = "stylesheet";
  styleLink.href = host.url("styles.css");
  document.head.appendChild(styleLink);

  // ── Pull the static markup shell ──
  const html = await (await fetch(host.url("view.html"))).text();
  // The user may have navigated away during the fetch. Bail with a no-op
  // cleanup so we never write into a detached container or wire up
  // listeners against shell-page DOM the shell has already replaced.
  if (cancelled) { styleLink.remove(); return () => {}; }
  container.innerHTML = html;
  const $ = (id) => container.querySelector(`#${id}`);
  const els = {
    headerActions:    $("dl-header-actions"),
    importBanner:     $("dl-import-banner"),
    importWarnings:   $("dl-import-warnings"),
    summary:          $("dl-summary"),
    filters:          $("dl-filters"),
    tabs:             $("dl-tabs"),
    empty:            $("dl-empty"),
    content:          $("dl-content"),
    drawerHost:       $("dl-drawer-host"),
  };

  // ── Load configurable rules (JSON files shipped with the module) ──
  // Done in parallel; tolerant of any one file being absent (logs and uses
  // built-in defaults). All three files are user-editable per the spec.
  let rules;
  try {
    const [weights, highRisk, roleZone] = await Promise.all([
      fetchJson(host.url("data/risk_weights.json")),
      fetchJson(host.url("data/high_risk_keywords.json")),
      fetchJson(host.url("data/role_zone_rules.json")),
    ]);
    if (cancelled) { styleLink.remove(); return () => {}; }
    rules = {
      weights:          weights.weights,
      bands:            weights.bands,
      timeWindows:      weights.timeWindows,
      thresholds:       weights.thresholds,
      calibration:      weights.calibration,
      highRiskKeywords: highRisk.keywords,
      roleZone,
    };
  } catch (e) {
    console.error("[digitallocks] failed to load rule files:", e);
    container.innerHTML = `<div class="state-error">DigitalLocks: failed to load rules — ${escapeHtml(String(e?.message ?? e))}</div>`;
    return () => { styleLink.remove(); };
  }

  // ── State ─────────────────────────────────────────────────────
  let state = {
    importsIndex:    [],
    activeImportId:  null,
    events:          [],
    importMeta:      null,
    importWarnings:  [],
    dataDateMin:     null,
    dataDateMax:     null,
    // Case-item mapping
    mappingsIndex:   [],
    activeMappingId: null,
    caseMapping:     null,   // full mapping record (with .items[])
    // On-demand async context keyed by eventId / userId
    orderCtx:        {},     // { [eventId]: { loading, found, orderCount, lineStatuses, error } }
    assocCtx:        {},     // { [userId]:  { loading, name, title, tenureDays, lengthOfSvc, error } }
    filters: {
      query:      "",
      store:      "",
      user:       "",
      position:   "",
      zone:       "",
      riskLevel:  "",
      status:     "active",
      dateFrom:   null,
      dateTo:     null,
      newHireOnly: false,
    },
    tab:               "active",
    sortBy:            "riskScore",
    sortDir:           "desc",
    selectedId:        null,
    // Cases tab — "who opened this case, and when". Independent of the
    // event table's sort so switching tabs doesn't scramble either one.
    selectedCaseKey:   null,   // caseKeyOf(event) of the case being drilled into
    caseUserFilter:    "",     // userId; set by clicking a row in the openers table
    casesSortBy:       "openings",
    casesSortDir:      "desc",
    busyImporting:     false,
    showNonMalicious:  false,   // toggle to reveal hidden (non-malicious) events in active tab
    users: {
      status:    "idle",   // "idle" | "loading" | "crossref" | "ready" | "error"
      list:      [],       // raw InVue user objects
      lookup:    {},       // { [win]: { ok, name, title, fromCache, error } }
      homeStore: "",       // read from host.storage.local on first render
    },
  };

  // ── Header buttons ─────────────────────────────────────────────
  replace(els.headerActions,
    h("input", {
      type: "text",
      id: "dl-store-input",
      class: "dl-input",
      placeholder: "Store #",
      "aria-label": "Store number to pull",
      style: { width: "100px" },
      value: localStorage.getItem("digitallocks.lastStore") || "",
      onKeydown: (e) => { if (e.key === "Enter") onSearchByStore(); },
    }),
    h("button", {
      type: "button", class: "btn btn-primary",
      title: "Pull this store's data from Power BI automatically",
      onClick: onSearchByStore,
    }, "Search"),
    h("button", { type: "button", class: "btn btn-secondary",
                  title: "Open the source Power BI report in a new tab",
                  onClick: openPowerBi },
      "Open Power BI report"),
    h("button", { type: "button", class: "btn btn-secondary",
                  title: "Manage case-item mapping (what items are in each case)",
                  onClick: openCaseMapPicker },
      "Case Map…"),
    h("button", { type: "button", class: "btn btn-secondary",
                  title: "Manage saved imports (switch, delete)",
                  onClick: openImportPicker },
      "Imports…"),
  );

  // ── Tab handlers ───────────────────────────────────────────────
  for (const btn of els.tabs.querySelectorAll(".dl-tab")) {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.view;
      setState({ tab });
    });
  }

  // ── Initial load ──────────────────────────────────────────────
  const IMPORT_TTL_MS = 72 * 60 * 60 * 1000;
  try {
    const purged = await deleteImportsBefore(Date.now() - IMPORT_TTL_MS);
    if (purged > 0) console.info(`[digitallocks] purged ${purged} import(s) older than 72h`);
  } catch (e) {
    console.warn("[digitallocks] TTL purge failed (non-fatal):", e?.message ?? e);
  }
  try {
    const [imports, mappings, activeIdGot, activeMappingIdGot] = await Promise.all([
      listImports(),
      listMappings(),
      host.storage.local.get(ACTIVE_KEY),
      host.storage.local.get(MAPPING_KEY),
    ]);
    if (cancelled) return () => {};
    let activeId = activeIdGot || null;
    if (activeId && !imports.find((i) => i.importId === activeId)) activeId = null;
    if (!activeId && imports.length) activeId = imports[0].importId;

    let activeMappingId = activeMappingIdGot || null;
    if (activeMappingId && !mappings.find((m) => m.mappingId === activeMappingId)) activeMappingId = null;
    if (!activeMappingId && mappings.length) activeMappingId = mappings[0].mappingId;

    state.importsIndex = imports;
    state.mappingsIndex = mappings;
    state.activeMappingId = activeMappingId;

    if (activeMappingId) {
      state.caseMapping = await getMapping(activeMappingId);
    }

    if (activeId) {
      await loadImportInto(activeId);
    } else {
      setState({});
    }

    // Seed host.storage.local homeStore from localStorage if not yet set (one-time migration).
    const savedStore = localStorage.getItem("digitallocks.lastStore");
    if (savedStore) host.storage.local.set("homeStore", savedStore).catch(() => {});

    // Pick up any pending daily auto-refresh result the SW stored while view was closed.
    try {
      const pending = await host.storage.local.get("autoRefresh");
      if (pending && !cancelled) {
        await ingestAutoRefreshResult(pending);
        await host.storage.local.remove("autoRefresh");
      }
    } catch (e) {
      console.warn("[digitallocks] auto-refresh pick-up failed:", e?.message ?? e);
    }
  } catch (e) {
    console.error("[digitallocks] initial load failed:", e);
  }

  // Subscribe to storage changes so a mid-session alarm pick-up is seamless.
  stopRefreshWatch = host.storage.local.onChange(async (changes) => {
    if (!changes.autoRefresh?.newValue || cancelled) return;
    await ingestAutoRefreshResult(changes.autoRefresh.newValue).catch(() => {});
    await host.storage.local.remove("autoRefresh").catch(() => {});
  });

  // ── Cleanup contract ──────────────────────────────────────────
  return () => {
    cancelled = true;
    stopRefreshWatch();
    // Close any open <dialog> we appended to document.body so the next
    // module doesn't render under a stale backdrop.
    for (const d of openDialogs) {
      try { d.close(); d.remove(); } catch {}
    }
    openDialogs.clear();
    styleLink.remove();
    closeDrawer();
  };

  // ── Functions in closure (have access to host/state/els) ──────

  function setState(patch) {
    state = { ...state, ...patch };
    render();
  }

  async function loadImportInto(importId) {
    // Don't clear events first — it causes a flash of empty state when navigating
    // back to this module. Keep existing events visible while the IDB read runs.
    setState({ activeImportId: importId, importMeta: null, importWarnings: [] });
    const rec = await getImport(importId);
    if (cancelled || !rec) return;
    const events = rec.events.map((e) => ({ ...e })); // detach from frozen blob
    await applyOverlay(host.storage.local, events);
    // Re-score so a rules-file change is reflected immediately without
    // requiring re-import. Stable: scoring is pure of import + rules.
    scoreEvents(events, rules);
    await host.storage.local.set(ACTIVE_KEY, importId);
    state.importsIndex = await listImports();
    const bounds = computeDateBounds(events);
    const defaults = defaultDateWindow(bounds);
    setState({
      events,
      importMeta: state.importsIndex.find((i) => i.importId === importId) || null,
      dataDateMin: bounds.min,
      dataDateMax: bounds.max,
      filters: { ...state.filters, dateFrom: defaults.from, dateTo: defaults.to },
    });
  }

  // ── Import flow ───────────────────────────────────────────────
  async function onFileChosen(ev) {
    const file = ev.target.files?.[0];
    ev.target.value = "";  // allow re-importing the same file
    if (!file) return;
    await ingestFile(file);
  }

  // ── SW-driven store search ────────────────────────────────────
  // User types a store, clicks Search; SW finds the open Power BI tab,
  // reads the data-grid DAX query the MAIN-world capture script has
  // recorded, replays it with the requested store filter, and returns
  // decoded rows. View hands them to the shared ingest pipeline.
  async function onSearchByStore() {
    const input = container.querySelector("#dl-store-input");
    const storeNumber = (input?.value || "").trim();
    if (!storeNumber) {
      alert("Type a store number (e.g. 1458) before clicking Search.");
      return;
    }
    if (state.busyImporting) return;
    setState({ busyImporting: true });
    localStorage.setItem("digitallocks.lastStore", storeNumber);
    // Also persist for SW daily-refresh alarm.
    host.storage.local.set("homeStore", storeNumber).catch(() => {});
    host.usage.record("search_store");
    showImportProgress(`Querying Power BI for store ${storeNumber}…`);
    try {
      // V1.5: the SW takes auth + modelId from a captured Power BI request
      // (MAIN-world content script) and issues its OWN query, filtered to this
      // store and nothing else. No UI driving, no .xlsx download. Returns rows
      // already keyed by Power BI column names.
      //
      // The SW refuses rather than returns a truncated store, so a resp.ok
      // here means every event for the store is present.
      const resp = await host.messaging.sendRaw("searchByStore", { storeNumber }, { timeoutMs: 180_000 });
      if (!resp?.ok) throw new Error(resp?.error || "Search failed");
      const daxRows = resp.rows || [];
      if (!daxRows.length) {
        showImportProgress(null);
        alert(`Power BI returned 0 rows for store ${storeNumber}. Either the store has no lock events in the current date range, or Power BI doesn't have data for that store.`);
        return;
      }
      showImportProgress(`Got ${daxRows.length} rows from Power BI — scoring…`);
      // The DSR decoder keys rows by column Property name ("Lock Name",
      // "store", "USER ID", ...) — these match parseLockEvents' HEADER_ALIASES
      // so normalize() handles them unchanged.
      const headers = Object.keys(daxRows[0]);
      const parsed = normalizeLockEvents(headers, daxRows, `Power BI: store ${storeNumber}`);
      await ingestParsed(parsed, `Power BI: store ${storeNumber}`);
      showImportProgress(null);
    } catch (e) {
      console.error("[digitallocks] searchByStore failed:", e);
      alert("Search failed: " + (e?.message ?? e));
      showImportProgress(null);
    } finally {
      setState({ busyImporting: false });
    }
  }

  function showImportProgress(text) {
    if (!text) {
      els.importBanner.classList.add("dl-hidden");
      return;
    }
    els.importBanner.classList.remove("dl-hidden");
    replace(els.importBanner, h("div", null, h("strong", null, "Working: "), text));
  }

  // Manual file picker path: parse XLSX/CSV → hand off to ingestParsed.
  async function ingestFile(file) {
    if (state.busyImporting && file.size === 0) return; // sanity
    let parsed;
    try {
      parsed = await parseLockEventsFile(file);
    } catch (e) {
      alert(`Import failed: ${e?.message ?? e}`);
      return;
    }
    await ingestParsed(parsed, file.name);
  }

  // Called when the SW daily-refresh alarm has deposited new rows.
  async function ingestAutoRefreshResult({ rows, storeNumber, refreshedAt }) {
    if (!rows?.length || !storeNumber || cancelled) return;
    const when = refreshedAt ? new Date(refreshedAt).toLocaleTimeString() : "just now";
    showImportProgress(`Daily refresh (${when}): processing ${rows.length} rows for store ${storeNumber}…`);
    try {
      const headers = Object.keys(rows[0]);
      const parsed = normalizeLockEvents(headers, rows, `Daily refresh: store ${storeNumber}`);
      if (parsed.rows.length) await ingestParsed(parsed, `Daily refresh: store ${storeNumber}`);
    } finally {
      showImportProgress(null);
    }
  }

  // Shared post-parse pipeline: dispatched from both the manual file picker
  // AND the SW DAX-replay path. `sourceName` shows up in import history.
  async function ingestParsed(parsed, sourceName) {
    if (parsed.rows.length === 0) {
      alert("No rows found.");
      return;
    }
    let dispositionChoice = "replace";
    if (state.events.length > 0) {
      dispositionChoice = await askActiveDisposition();
      if (!dispositionChoice) return;
    }
    let merged = parsed.rows;
    if (dispositionChoice === "append" && state.events.length) {
      const byId = new Map(state.events.map((e) => [e.id, e]));
      for (const r of parsed.rows) byId.set(r.id, r);
      merged = [...byId.values()];
    } else if (dispositionChoice === "archive" && state.events.length) {
      const n = await archiveImport(host.storage.local, state.events.filter((e) => e.reviewStatus === "active"));
      console.log(`[digitallocks] archived ${n} prior active event(s)`);
    }
    scoreEvents(merged, rules);

    const importId = newImportId();
    const importedAt = Date.now();
    const summary = summarizeForIndex(merged);
    await putImport({
      importId, importedAt,
      sourceFileName: sourceName,
      summary,
      events: merged.map(stripTransientFields),
    });
    state.importsIndex = await listImports();
    await loadImportInto(importId);
    setState({ importWarnings: parsed.warnings || [] });
  }

  function askActiveDisposition() {
    return new Promise((resolve) => {
      // Tiny inline modal — confirm() is too plain for a 3-way choice.
      const dlg = h("dialog", { class: "modal" },
        h("div", { class: "modal-head" }, "You already have an active review queue"),
        h("div", { class: "modal-body" },
          h("p", { class: "dl-muted" }, "How should this import combine with the existing events?"),
        ),
        h("div", { class: "modal-foot" },
          h("button", { class: "btn", onClick: () => { dlg.close(); resolve(null); } }, "Cancel"),
          h("button", { class: "btn btn-secondary", onClick: () => { dlg.close(); resolve("archive"); } },
            "Archive old, start new"),
          h("button", { class: "btn btn-secondary", onClick: () => { dlg.close(); resolve("append"); } },
            "Append to existing"),
          h("button", { class: "btn btn-primary",   onClick: () => { dlg.close(); resolve("replace"); } },
            "Replace active list"),
        ),
      );
      document.body.appendChild(dlg);
      openDialogs.add(dlg);
      dlg.addEventListener("close", () => { openDialogs.delete(dlg); dlg.remove(); }, { once: true });
      dlg.showModal();
    });
  }

  function openPowerBi() {
    chrome.tabs.create({ url: POWER_BI_URL }).catch((e) => {
      console.warn("[digitallocks] couldn't open Power BI:", e);
      window.open(POWER_BI_URL, "_blank", "noopener");
    });
  }

  async function openCaseMapPicker() {
    const active = state.caseMapping;
    const dlg = h("dialog", { class: "modal" },
      h("div", { class: "modal-head" }, "Case-item mapping"),
      h("div", { class: "modal-body" },
        h("p", { class: "dl-muted", style: { marginTop: 0 } },
          "Maps lock names to the items stored inside each case. Used to cross-check online orders when a digital associate opens a case."),
        active
          ? h("div", { class: "dl-case-map-active" },
              h("strong", null, "Active: "), active.sourceFileName || "(unknown)",
              h("span", { class: "dl-muted" }, ` · ${active.summary?.itemCount ?? "?"} items · ${active.summary?.lockCount ?? "?"} locks · imported ${new Date(active.importedAt).toLocaleString()}`),
            )
          : h("p", { class: "dl-muted" }, "No case map loaded."),
        h("p", null,
          h("strong", null, "Expected CSV columns: "),
          "zoneName, lockName, upc (required) · itemNumber, description, store (optional)"),
        h("p", { class: "dl-muted", style: { fontSize: "12px" } },
          "Zone and lock names must match the InVue system exactly (e.g. \"72-ELECTRONICS-TIER 1\", \"K6-1\"). UPCs accepted in any standard format."),
        state.mappingsIndex.length > 0
          ? h("table", { class: "dl-table", style: { marginTop: "12px" } },
              h("thead", null, h("tr", null,
                h("th", null, "Imported"), h("th", null, "File"),
                h("th", null, "Items"), h("th", null, "Active"), h("th", null, ""),
              )),
              h("tbody", null, ...state.mappingsIndex.map((m) =>
                h("tr", null,
                  h("td", null, new Date(m.importedAt).toLocaleString()),
                  h("td", null, m.sourceFileName || "(unknown)"),
                  h("td", null, String(m.summary?.itemCount ?? "")),
                  h("td", null, m.mappingId === state.activeMappingId ? "✓" : ""),
                  h("td", null,
                    h("button", {
                      class: "btn btn-sm",
                      onClick: async () => { dlg.close(); await loadMappingInto(m.mappingId); },
                    }, "Activate"),
                    " ",
                    h("button", {
                      class: "btn btn-sm btn-danger",
                      onClick: async () => {
                        if (!confirm(`Delete case map "${m.sourceFileName}"?`)) return;
                        await deleteMapping(m.mappingId);
                        state.mappingsIndex = await listMappings();
                        if (state.activeMappingId === m.mappingId) {
                          state.activeMappingId = null;
                          state.caseMapping = null;
                          await host.storage.local.remove(MAPPING_KEY);
                        }
                        dlg.close();
                        setState({});
                      },
                    }, "Delete"),
                  ),
                ),
              )),
            )
          : null,
      ),
      h("div", { class: "modal-foot" },
        h("button", { class: "btn", onClick: () => dlg.close() }, "Close"),
        h("button", { class: "btn btn-secondary",
          title: "Pull all locks from InVue and download a device-map Excel workbook",
          onClick: async () => {
            dlg.close();
            await exportInvueCaseMap();
          },
        }, "Create Locking Case Map"),
        h("label", { class: "btn btn-primary", style: { cursor: "pointer" } },
          "Import CSV / Excel",
          h("input", {
            type: "file", accept: ".csv,.xlsx,.xlsm", style: { display: "none" },
            onChange: async (ev) => {
              const file = ev.target.files?.[0];
              ev.target.value = "";
              if (!file) return;
              dlg.close();
              await ingestCaseMapFile(file);
            },
          }),
        ),
      ),
    );
    document.body.appendChild(dlg);
    openDialogs.add(dlg);
    dlg.addEventListener("close", () => { openDialogs.delete(dlg); dlg.remove(); }, { once: true });
    dlg.showModal();
  }

  async function ingestCaseMapFile(file) {
    let parsed;
    try {
      parsed = await parseCaseItemsFile(file);
    } catch (e) {
      alert(`Case map import failed: ${e?.message ?? e}`);
      return;
    }
    if (!parsed.rows.length) { alert("No rows found in case map file."); return; }
    const mappingId = newMappingId();
    const summary = {
      itemCount: parsed.rows.length,
      lockCount: new Set(parsed.rows.map((r) => `${r.zoneName}|${r.lockName}`)).size,
      stores: [...new Set(parsed.rows.map((r) => r.store).filter(Boolean))],
    };
    await putMapping({ mappingId, importedAt: Date.now(), sourceFileName: file.name, summary, items: parsed.rows });
    await loadMappingInto(mappingId);
    if (parsed.warnings?.length) {
      alert(`Case map imported with notes:\n${parsed.warnings.join("\n")}`);
    }
  }

  function locksToCsv(locks) {
    const cols = [
      { key: "name",                label: "Lock Name"     },
      { key: "Zone.name",           label: "Zone"          },
      { key: "latchStatus",         label: "Latch"         },
      { key: "batteryHealthStatus", label: "Battery %"     },
      { key: "fwVersion",           label: "Firmware"      },
      { key: "serialNumber",        label: "Serial Number" },
      { key: "description",         label: "Notes"         },
      { key: "_newName",            label: "New Lock Name" },
    ];
    const cell = (v) => {
      if (v == null) return "";
      const s = String(v);
      return (s.includes(",") || s.includes('"') || s.includes("\n"))
        ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.map((c) => c.label).join(",")];
    for (const lock of locks) {
      lines.push(cols.map(({ key }) => {
        if (key === "Zone.name")       return cell(lock.Zone?.name);
        if (key === "dualAuthEnabled") return cell(lock.dualAuthEnabled ? "Yes" : "No");
        return cell(lock[key]);
      }).join(","));
    }
    return lines.join("\r\n");
  }

  async function exportInvueCaseMap() {
    const banner = document.createElement("div");
    banner.textContent = "Pulling locks from InVue…";
    banner.style.cssText = "position:fixed;bottom:16px;right:16px;padding:10px 16px;background:#222;color:#fff;border-radius:6px;z-index:99999;font-size:13px;";
    document.body.appendChild(banner);
    try {
      const resp = await host.messaging.sendRaw("buildCaseMap", {}, { timeoutMs: 60_000 });
      if (!resp?.ok) throw new Error(resp?.error || "buildCaseMap failed");
      const csv  = locksToCsv(resp.locks);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `invue-case-map-${new Date().toISOString().slice(0, 10)}.csv`;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      banner.textContent = `Done — ${resp.count} locks exported.`;
      setTimeout(() => banner.remove(), 3000);
    } catch (e) {
      banner.remove();
      alert(`Case map export failed: ${e?.message ?? e}`);
    }
  }

  async function loadMappingInto(mappingId) {
    const rec = await getMapping(mappingId);
    if (!rec) return;
    state.mappingsIndex = await listMappings();
    state.activeMappingId = mappingId;
    state.caseMapping = rec;
    state.orderCtx = {};  // clear stale order context when mapping changes
    await host.storage.local.set(MAPPING_KEY, mappingId);
    setState({});
  }

  // Expose for external file-drop on the page (future enhancement hook).
  async function openImportPicker() {
    const dlg = h("dialog", { class: "modal" },
      h("div", { class: "modal-head" }, "Saved imports"),
      h("div", { class: "modal-body" },
        state.importsIndex.length === 0
          ? h("p", { class: "dl-muted" }, "No imports saved yet.")
          : h("table", { class: "dl-table" },
              h("thead", null, h("tr", null,
                h("th", null, "Imported"),
                h("th", null, "File"),
                h("th", null, "Rows"),
                h("th", null, "Active"),
                h("th", null, ""),
              )),
              h("tbody", null, ...state.importsIndex.map((imp) =>
                h("tr", null,
                  h("td", null, new Date(imp.importedAt).toLocaleString()),
                  h("td", null, imp.sourceFileName || "(unknown)"),
                  h("td", null, String(imp.summary?.rowCount ?? "")),
                  h("td", null, imp.importId === state.activeImportId ? "✓" : ""),
                  h("td", null,
                    h("button", {
                      class: "btn btn-sm",
                      onClick: async () => { dlg.close(); await loadImportInto(imp.importId); },
                    }, "Open"),
                    " ",
                    h("button", {
                      class: "btn btn-sm btn-danger",
                      onClick: async () => {
                        if (!confirm(`Delete import "${imp.sourceFileName}" (${imp.summary?.rowCount} rows)? Status history for these events stays in local storage.`)) return;
                        await deleteImport(imp.importId);
                        state.importsIndex = await listImports();
                        if (state.activeImportId === imp.importId) {
                          state.activeImportId = null;
                          state.events = [];
                          await host.storage.local.remove(ACTIVE_KEY);
                        }
                        dlg.close();
                        setState({});
                      },
                    }, "Delete"),
                  ),
                ),
              )),
            ),
      ),
      h("div", { class: "modal-foot" },
        h("button", { class: "btn btn-primary", onClick: () => dlg.close() }, "Close"),
      ),
    );
    document.body.appendChild(dlg);
    openDialogs.add(dlg);
    dlg.addEventListener("close", () => { openDialogs.delete(dlg); dlg.remove(); }, { once: true });
    dlg.showModal();
  }

  // ── Render ────────────────────────────────────────────────────
  function render() {
    renderImportBanner();
    renderWarnings();
    renderSummary();
    renderFilters();
    renderTabs();
    renderContent();
    renderDrawer();
  }

  function renderImportBanner() {
    if (!state.importMeta) {
      els.importBanner.classList.add("dl-hidden");
      els.importBanner.innerHTML = "";
      return;
    }
    const imp = state.importMeta;
    const when = new Date(imp.importedAt).toLocaleString();
    els.importBanner.classList.remove("dl-hidden");
    replace(els.importBanner,
      h("div", null,
        h("strong", null, `Active import: ${imp.sourceFileName || "(unknown)"}`),
        " ",
        h("span", { class: "dl-banner-meta" },
          `imported ${when} · ${imp.summary?.rowCount ?? "?"} rows · ${imp.summary?.dateRange?.min ?? "?"} → ${imp.summary?.dateRange?.max ?? "?"} · ${(imp.summary?.stores || []).join(", ") || "no store info"}`),
      ),
    );
  }

  function renderWarnings() {
    if (!state.importWarnings.length) {
      els.importWarnings.classList.add("dl-hidden");
      els.importWarnings.innerHTML = "";
      return;
    }
    els.importWarnings.classList.remove("dl-hidden");
    replace(els.importWarnings,
      h("strong", null, "Import notes"),
      h("ul", null, ...state.importWarnings.map((w) => h("li", null, w))),
    );
  }

  function renderSummary() {
    // Summary always reflects ALL active events in the import, ignoring the
    // current date/store/query filters. This prevents the mismatch/critical
    // counts from going to 0 just because a date-range filter is active.
    const allActive = state.events.filter((e) => e.reviewStatus === "active");
    const critical = allActive.filter((e) => e.riskLevel === "Critical").length;
    const high     = allActive.filter((e) => e.riskLevel === "High").length;
    const afterHours = allActive.filter((e) => (e.riskReasons || []).some((r) => r.includes("after-hours") || r.includes("edge after"))).length;
    const mismatch   = allActive.filter((e) => (e.riskReasons || []).some((r) => r.includes("role/zone mismatch"))).length;

    const today = new Date().toISOString().slice(0, 10);
    const clearedToday = state.events.filter((e) => e.clearedAt && new Date(e.clearedAt).toISOString().slice(0, 10) === today).length;

    const topUser  = mostBy(allActive, (e) => e.fullName || e.userId);
    const topStore = mostBy(allActive, (e) => e.store);

    replace(els.summary,
      summaryCard("Active events",         allActive.length,   "needs review"),
      summaryCard("Critical",              critical,           "score ≥ 75",  "dl-card-critical"),
      summaryCard("High",                  high,               "score 50-74", "dl-card-high"),
      summaryCard("After-hours",           afterHours,         "11pm-7am"),
      summaryCard("Role/zone mismatch",    mismatch,           "needs context"),
      summaryCard("Most active user",      topUser?.key || "—", topUser ? `${topUser.count} events` : ""),
      summaryCard("Highest-volume store",  topStore?.key || "—", topStore ? `${topStore.count} events` : ""),
      summaryCard("Cleared today",         clearedToday,       ""),
    );
  }

  function summaryCard(label, value, sub, extraClass = "") {
    return h("div", { class: `dl-card ${extraClass}` },
      h("div", { class: "dl-card-label" }, label),
      h("div", { class: "dl-card-value" }, String(value)),
      sub ? h("div", { class: "dl-card-sub" }, sub) : null,
    );
  }

  function renderFilters() {
    const stores    = uniqueSorted(state.events.map((e) => e.store));
    const positions = uniqueSorted(state.events.map((e) => e.position));
    const zones     = uniqueSorted(state.events.map((e) => e.zoneName));

    replace(els.filters,
      filterField("Search", h("input", { class: "dl-input", type: "search", placeholder: "user, lock, zone…",
                                          value: state.filters.query,
                                          onInput: (e) => setFilter("query", e.target.value) })),
      filterField("Store",     selectField("store",     stores,     state.filters.store)),
      filterField("Position",  selectField("position",  positions,  state.filters.position)),
      filterField("Zone",      selectField("zone",      zones,      state.filters.zone)),
      filterField("Risk level",
        selectField("riskLevel", ["Critical", "High", "Watch", "Normal"], state.filters.riskLevel)),
      filterField("Status",
        selectField("status",
          ["active", "needs_follow_up", "confirmed_theft_review", "non_malicious", "dismissed", ""],
          state.filters.status, (s) => s === "" ? "All" : STATUS_LABEL[s])),
      dateRangeField(),
      h("div", { class: "dl-filters-clear" },
        h("button", { class: "btn btn-secondary btn-sm",
                      onClick: () => {
                        const d = defaultDateWindow({ min: state.dataDateMin, max: state.dataDateMax });
                        setState({ filters: { query:"", store:"", user:"", position:"", zone:"", riskLevel:"",
                                              status: state.filters.status,
                                              dateFrom: d.from, dateTo: d.to } });
                      } },
          "Reset filters"),
        " ",
        h("button", {
          class: `btn btn-secondary btn-sm${state.showNonMalicious ? " is-active" : ""}`,
          title: state.showNonMalicious ? "Hide non-malicious events" : "Show hidden (non-malicious) events in active view",
          onClick: () => setState({ showNonMalicious: !state.showNonMalicious }),
        }, state.showNonMalicious ? "Hide non-malicious" : "Show hidden"),
        " ",
        h("button", { class: "btn btn-secondary btn-sm",
                      onClick: doExport },
          "Export CSV"),
      ),
    );
  }

  function dateRangeField() {
    const minIso = state.dataDateMin ? fmtDateInput(state.dataDateMin) : "";
    const maxIso = state.dataDateMax ? fmtDateInput(state.dataDateMax) : "";
    const fromVal = state.filters.dateFrom ? fmtDateInput(state.filters.dateFrom) : "";
    const toVal   = state.filters.dateTo   ? fmtDateInput(state.filters.dateTo)   : "";

    const onFromChange = (e) => {
      const v = e.target.value ? startOfDay(new Date(e.target.value + "T00:00:00")) : null;
      setFilter("dateFrom", v);
    };
    const onToChange = (e) => {
      const v = e.target.value ? endOfDay(new Date(e.target.value + "T00:00:00")) : null;
      setFilter("dateTo", v);
    };

    const presetBtn = (label, days) => h("button", {
      type: "button", class: "btn btn-sm btn-secondary",
      title: days === null
        ? "Show all imported events"
        : `Last ${days} days of imported data (anchored to ${maxIso || "the latest event"})`,
      onClick: () => applyDatePreset(days),
    }, label);

    return h("div", { class: "dl-field dl-field-daterange" },
      h("span", { class: "dl-field-label" }, "Date range"),
      h("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center" } },
        h("input", { type: "date", class: "dl-input",
                     value: fromVal, min: minIso, max: maxIso,
                     "aria-label": "From date",
                     onChange: onFromChange }),
        h("span", { class: "dl-muted", style: { fontSize: "12px" } }, "→"),
        h("input", { type: "date", class: "dl-input",
                     value: toVal, min: minIso, max: maxIso,
                     "aria-label": "To date",
                     onChange: onToChange }),
        presetBtn("7d",  7),
        presetBtn("14d", 14),
        presetBtn("30d", 30),
        presetBtn("All", null),
      ),
    );
  }

  function applyDatePreset(days) {
    if (!state.dataDateMax) return;
    let from, to;
    if (days === null) {
      from = state.dataDateMin;
      to   = state.dataDateMax;
    } else {
      to = endOfDay(state.dataDateMax);
      const candidate = new Date(state.dataDateMax);
      candidate.setDate(candidate.getDate() - (days - 1));
      from = startOfDay(candidate);
      // Clamp so the preset never pretends to span beyond the imported data.
      if (state.dataDateMin && from < state.dataDateMin) from = state.dataDateMin;
    }
    setState({ filters: { ...state.filters, dateFrom: from, dateTo: to } });
  }

  function setFilter(key, value) {
    setState({ filters: { ...state.filters, [key]: value } });
  }

  function selectField(key, options, value, labeller = (s) => String(s)) {
    return h("select", {
      class: "dl-select",
      onChange: (e) => setFilter(key, e.target.value),
    },
      h("option", { value: "" }, "All"),
      ...options.map((o) =>
        h("option", { value: o, selected: o === value ? true : undefined }, labeller(o)),
      ),
    );
  }

  function filterField(label, control) {
    return h("label", { class: "dl-field" },
      h("span", { class: "dl-field-label" }, label),
      control,
    );
  }

  function renderTabs() {
    for (const btn of els.tabs.querySelectorAll(".dl-tab")) {
      btn.classList.toggle("is-active", btn.dataset.view === state.tab);
    }
  }

  function renderContent() {
    // Users tab is independent of event imports — always render it directly.
    if (state.tab === "users") {
      els.empty.classList.add("dl-hidden");
      els.content.classList.remove("dl-hidden");
      renderUsersTab();
      return;
    }

    if (state.events.length === 0) {
      els.empty.classList.remove("dl-hidden");
      els.content.classList.add("dl-hidden");
      replace(els.empty,
        h("div", null,
          h("p", null, h("strong", null, "No imports yet."), " Type a store number above and click ", h("em", null, "Search"), " — the extension will pull the data directly from Power BI."),
          h("div", { class: "dl-empty-actions" },
            h("button", { class: "btn btn-secondary", onClick: openPowerBi }, "Open Power BI"),
          ),
        ),
      );
      return;
    }
    els.empty.classList.add("dl-hidden");
    els.content.classList.remove("dl-hidden");

    if (state.tab === "active")    renderActiveTable();
    else if (state.tab === "cases")     renderCasesTab();
    else if (state.tab === "checklist") renderChecklist();
    else if (state.tab === "history")   renderHistoryTable();
    else                                renderUsersTab();
  }

  function renderActiveTable() {
    const status = state.filters.status;
    const baseFilter = { ...state.filters, status: "" };
    let filtered;

    if (!status || status === "active") {
      // Default: show both active and needs_follow_up (both are unresolved work).
      // Marking "Needs Follow-Up" no longer causes the row to disappear.
      filtered = filterEvents(state.events, baseFilter)
        .filter((e) => e.reviewStatus === "active" || e.reviewStatus === "needs_follow_up");
      if (state.showNonMalicious) {
        const nm = filterEvents(state.events, { ...baseFilter, status: "non_malicious" });
        filtered = [...filtered, ...nm];
      }
    } else {
      filtered = filterEvents(state.events, { ...baseFilter, status });
    }

    filtered = sortRows(filtered);
    replace(els.content, makeEventTable(filtered));
    // No batch tenure prefetch here. Each lookup drives a real browser tab to
    // a Workday directory search, and this ran on EVERY render of the table —
    // every filter change, sort, and remount — queueing one navigation per
    // visible row. The event table renders no tenure data anyway; the drawer
    // fetches on open (renderDrawerTenure), which is the only place it shows.
  }

  // ── Cases tab ───────────────────────────────────────────────────────────────
  //
  // Answers "who has been opening the fragrance case, and when?" — the
  // opposite question to the active queue, which hides everything already
  // cleared and ranks by risk. A case opened forty times by one associate
  // at ordinary hours is invisible there by design; here it is the headline.
  //
  // Honoured filters: store, zone, position, date range, search.
  // Ignored:          status and risk level. Either one would hide openings,
  //                   which is the single thing this view exists to show.
  //                   The note under the table says so on screen.

  function casesBaseEvents() {
    return filterEvents(state.events, { ...state.filters, status: "", riskLevel: "" });
  }

  // After-hours is computed from the event's own hour rather than from its
  // risk reasons: base-rate calibration can zero the AFTERHOURS reason out of
  // riskReasons entirely (see riskScoring.js), and a case-history view still
  // needs to say "opened at 3am" even when 3am is normal for this store.
  function isAfterHoursHour(hour) {
    if (hour == null) return false;
    const tw = rules.timeWindows || {};
    const inWin = (w) => w && hour >= w.fromHour && hour < w.toHour;
    if (inWin(tw.deepAfterHours)) return true;
    return (tw.edgeAfterHours || []).some(inWin);
  }

  function renderCasesTab() {
    const cases = groupByCase(casesBaseEvents(), isAfterHoursHour);
    if (state.selectedCaseKey) {
      const one = cases.find((c) => c.key === state.selectedCaseKey);
      if (one) { renderCaseDetail(one); return; }
      // The case dropped out of the current filter window (usually a narrowed
      // date range). Say so rather than silently bouncing back to the list.
      replace(els.content,
        backToCasesBar(),
        h("div", { class: "dl-empty" },
          "That case has no openings inside the current date range and filters."),
      );
      return;
    }
    renderCasesList(cases);
  }

  function backToCasesBar() {
    return h("div", { class: "dl-case-backbar" },
      h("button", {
        class: "btn btn-secondary btn-sm",
        onClick: () => setState({ selectedCaseKey: null, caseUserFilter: "" }),
      }, "← All cases"),
    );
  }

  function renderCasesList(cases) {
    if (!cases.length) {
      replace(els.content,
        h("div", { class: "dl-empty" },
          h("strong", null, "No openings match the current filters."),
          " Widen the date range or clear the store/zone filters."),
      );
      return;
    }
    const sorted = sortCases(cases);
    const totalOpenings = cases.reduce((n, c) => n + c.openings, 0);

    const table = h("div", { class: "dl-table-wrap" },
      h("table", { class: "dl-table" },
        h("thead", null,
          h("tr", null,
            caseTh("Case",         "lockName"),
            caseTh("Zone",         "zoneName"),
            caseTh("Store",        "store"),
            caseTh("Openings",     "openings"),
            caseTh("People",       "people"),
            h("th", null, "Most openings by"),
            caseTh("After-hours",  "afterHours"),
            caseTh("First",        "firstMs"),
            caseTh("Last",         "lastMs"),
            h("th", null, ""),
          )),
        h("tbody", null, ...sorted.map((c) => caseRow(c))),
      ),
    );

    replace(els.content,
      h("div", { class: "dl-case-intro" },
        h("div", null,
          h("strong", null, `${cases.length} case${cases.length === 1 ? "" : "s"}`),
          ` · ${totalOpenings} opening${totalOpenings === 1 ? "" : "s"} in the selected date range`,
        ),
        h("button", { class: "btn btn-secondary btn-sm", onClick: doExport },
          "Export case summary CSV"),
      ),
      table,
      h("p", { class: "dl-muted dl-case-note" },
        "Every opening is listed here, including events already cleared or marked non-malicious — ",
        "the Status and Risk level filters deliberately do not apply to this tab. ",
        "Counts are a record of access, not an allegation."),
    );
  }

  function caseRow(c) {
    const open = () => setState({ selectedCaseKey: c.key, caseUserFilter: "" });
    const top = c.topOpener;
    return h("tr", { class: "dl-case-row", onClick: open },
      h("td", { class: "dl-cell-user" }, c.lockName || h("span", { class: "dl-muted" }, "(no lock name)")),
      h("td", null, c.zoneName || ""),
      h("td", null, c.store || ""),
      h("td", null, h("strong", null, String(c.openings))),
      h("td", null, String(c.people)),
      h("td", null,
        top
          ? h("div", null,
              h("div", null, top.name || h("span", { class: "dl-muted" }, "(unattributed)")),
              h("div", { class: "dl-cell-id" }, `${top.openings} of ${c.openings}`))
          : "—"),
      h("td", null, c.afterHours
        ? h("span", { class: "dl-chip dl-chip-warn" }, String(c.afterHours))
        : h("span", { class: "dl-muted" }, "0")),
      h("td", { class: "dl-mono" }, c.firstMs ? fmtDateTime(c.firstMs) : ""),
      h("td", { class: "dl-mono" }, c.lastMs  ? fmtDateTime(c.lastMs)  : ""),
      h("td", null,
        h("button", {
          class: "btn btn-sm btn-secondary",
          onClick: (ev) => { ev.stopPropagation(); open(); },
        }, "Openings")),
    );
  }

  // Numeric/time columns default to descending on first click — "most
  // openings" and "most recent" are what a reviewer wants first; names sort
  // A→Z.
  const CASE_DESC_FIRST = new Set(["openings", "people", "afterHours", "firstMs", "lastMs"]);

  function caseTh(label, key) {
    const isSorted = state.casesSortBy === key;
    return h("th", {
      class: "dl-sortable",
      onClick: () => setState({
        casesSortBy: key,
        casesSortDir: isSorted
          ? (state.casesSortDir === "asc" ? "desc" : "asc")
          : (CASE_DESC_FIRST.has(key) ? "desc" : "asc"),
      }),
    },
      label,
      isSorted ? h("span", { class: "dl-sort-arrow" }, state.casesSortDir === "asc" ? "▲" : "▼") : null,
    );
  }

  function sortCases(cases) {
    const dir = state.casesSortDir === "asc" ? 1 : -1;
    const key = state.casesSortBy;
    return [...cases].sort((a, b) => {
      const av = a[key], bv = b[key];
      if (av == null && bv == null) return 0;
      if (av == null) return  1 * dir;
      if (bv == null) return -1 * dir;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }

  // ── One case: who opened it, and every opening in order ────────────────────

  function renderCaseDetail(c) {
    const userFilter = state.caseUserFilter;
    const openings = [...c.events].sort((a, b) => {
      const at = Date.parse(a.eventTime), bt = Date.parse(b.eventTime);
      return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
    });
    const shown = userFilter
      ? openings.filter((e) => (e.userId || "(unattributed)") === userFilter)
      : openings;

    const busiestDay = c.days.reduce((best, d) => (!best || d[1] > best[1] ? d : best), null);

    replace(els.content,
      backToCasesBar(),
      h("div", { class: "dl-case-head" },
        h("h2", null, c.lockName || "(no lock name)"),
        h("div", { class: "dl-muted" },
          `${c.zoneName || "(no zone)"} · store ${c.store || "?"}`),
      ),
      h("div", { class: "dl-summary" },
        summaryCard("Openings",     c.openings, "in selected range"),
        summaryCard("People",       c.people,   "distinct users"),
        summaryCard("After-hours",  c.afterHours, "11pm–7am", c.afterHours ? "dl-card-high" : ""),
        summaryCard("Flagged",      c.flagged,  "High or Critical", c.flagged ? "dl-card-critical" : ""),
        summaryCard("Busiest day",  busiestDay ? busiestDay[0] : "—", busiestDay ? `${busiestDay[1]} openings` : ""),
        summaryCard("Last opened",  c.lastMs ? fmtDateTime(c.lastMs) : "—", ""),
      ),
      renderCaseItems(c),
      c.days.length > 1 ? h("section", { class: "dl-case-section" },
        h("h3", null, "Openings per day"),
        dayBars(c.days),
      ) : null,
      h("section", { class: "dl-case-section" },
        h("h3", null, "Who opened it"),
        openersTable(c),
      ),
      h("section", { class: "dl-case-section" },
        h("div", { class: "dl-case-section-head" },
          h("h3", null,
            userFilter
              ? `Openings by ${c.byUser.get(userFilter)?.name || userFilter}`
              : "Every opening",
            h("span", { class: "dl-muted" }, ` (${shown.length})`)),
          h("div", { class: "dl-case-section-actions" },
            userFilter
              ? h("button", { class: "btn btn-sm btn-secondary",
                              onClick: () => setState({ caseUserFilter: "" }) }, "Show everyone")
              : null,
            h("button", { class: "btn btn-sm btn-secondary", onClick: doExport },
              "Export CSV"),
          ),
        ),
        openingsTable(shown),
      ),
    );
  }

  function renderCaseItems(c) {
    const section = h("section", { class: "dl-case-section" },
      h("h3", null, "Items in this case"));
    if (!state.caseMapping) {
      section.appendChild(h("p", { class: "dl-muted" },
        "No case map loaded. Click ", h("strong", null, "Case Map…"), " in the header to import one — ",
        "that's what turns a lock name into the merchandise behind it."));
      return section;
    }
    const items = lookupCaseItems(state.caseMapping.items, {
      zoneName: c.zoneName, lockName: c.lockName, store: c.store,
    });
    if (!items.length) {
      section.appendChild(h("p", { class: "dl-muted" },
        `No items mapped for "${c.lockName}" in "${c.zoneName}".`));
      return section;
    }
    section.appendChild(
      h("div", { class: "dl-table-wrap" },
        h("table", { class: "dl-table dl-table-compact" },
          h("thead", null, h("tr", null,
            h("th", null, "UPC"), h("th", null, "Item #"), h("th", null, "Description"))),
          h("tbody", null, ...items.map((item) =>
            h("tr", null,
              h("td", { class: "dl-mono" }, item.upc),
              h("td", null, item.itemNumber || "—"),
              h("td", null, item.description || "—"),
            ))),
        )),
    );
    return section;
  }

  function openersTable(c) {
    const rows = c.openers.map((u) => {
      const key = u.userId || "(unattributed)";
      const isSelected = state.caseUserFilter === key;
      const share = c.openings ? Math.round((u.openings / c.openings) * 100) : 0;
      return h("tr", {
        class: isSelected ? "dl-case-row is-selected" : "dl-case-row",
        onClick: () => setState({ caseUserFilter: isSelected ? "" : key }),
      },
        h("td", { class: "dl-cell-user" },
          h("div", null, u.name || h("span", { class: "dl-muted" }, "(unattributed)")),
          h("div", { class: "dl-cell-id" }, u.userId || ""),
        ),
        h("td", null, u.position || ""),
        h("td", null, h("strong", null, String(u.openings))),
        h("td", null,
          h("div", { class: "dl-share" },
            h("div", { class: "dl-share-bar", style: { width: `${share}%` } })),
          h("span", { class: "dl-cell-id" }, `${share}%`),
        ),
        h("td", null, u.afterHours
          ? h("span", { class: "dl-chip dl-chip-warn" }, String(u.afterHours))
          : h("span", { class: "dl-muted" }, "0")),
        h("td", { class: "dl-mono" }, u.firstMs ? fmtDateTime(u.firstMs) : ""),
        h("td", { class: "dl-mono" }, u.lastMs  ? fmtDateTime(u.lastMs)  : ""),
      );
    });
    return h("div", { class: "dl-table-wrap" },
      h("table", { class: "dl-table" },
        h("thead", null, h("tr", null,
          h("th", null, "User"),
          h("th", null, "Position"),
          h("th", null, "Openings"),
          h("th", null, "Share"),
          h("th", null, "After-hours"),
          h("th", null, "First"),
          h("th", null, "Last"),
        )),
        h("tbody", null, ...rows),
      ),
    );
  }

  function openingsTable(events) {
    if (!events.length) {
      return h("div", { class: "dl-empty" }, "No openings match the current filters.");
    }
    return h("div", { class: "dl-table-wrap" },
      h("table", { class: "dl-table" },
        h("thead", null, h("tr", null,
          h("th", null, "Time"),
          h("th", null, "User"),
          h("th", null, "Position"),
          h("th", null, "Source"),
          h("th", null, "Risk"),
          h("th", null, "Status"),
          h("th", null, ""),
        )),
        h("tbody", null, ...events.map((e) => {
          const badgeClass = RISK_LEVEL_TO_BADGE_CLASS[e.riskLevel] || "dl-risk-normal";
          const after = isAfterHoursHour(e.eventHour);
          return h("tr", null,
            h("td", { class: "dl-mono" },
              fmtDateTime(e.eventTime),
              after ? h("span", { class: "dl-chip dl-chip-warn", style: { marginLeft: "6px" } }, "after-hours") : null,
            ),
            h("td", { class: "dl-cell-user" },
              h("div", null, e.fullName || h("span", { class: "dl-muted" }, "(unattributed)")),
              h("div", { class: "dl-cell-id" }, e.userId || ""),
            ),
            h("td", null, e.position || ""),
            h("td", null, e.unlockSource || ""),
            h("td", null, h("span", { class: `dl-risk-badge ${badgeClass}` }, String(e.riskScore))),
            h("td", null, h("span", { class: `dl-status dl-status-${e.reviewStatus}` },
              STATUS_LABEL[e.reviewStatus] || e.reviewStatus)),
            h("td", null,
              h("button", { class: "btn btn-sm btn-secondary",
                            onClick: () => setState({ selectedId: e.id }) }, "Details")),
          );
        })),
      ),
    );
  }

  function dayBars(days) {
    const max = Math.max(...days.map((d) => d[1]), 1);
    return h("div", { class: "dl-case-days" },
      ...days.map(([day, n]) =>
        h("div", { class: "dl-case-day", title: `${day} — ${n} opening${n === 1 ? "" : "s"}` },
          h("div", { class: "dl-case-day-count" }, String(n)),
          h("div", { class: "dl-case-day-bar",
                     style: { height: `${Math.max(3, Math.round((n / max) * 56))}px` } }),
          h("div", { class: "dl-case-day-label" }, day.slice(5)),
        )),
    );
  }

  // ── Users audit tab ─────────────────────────────────────────────────────────

  function renderUsersTab() {
    const u = state.users;

    // Lazy-load home store from storage on first render.
    if (!u.homeStore) {
      host.storage.local.get("homeStore").then((val) => {
        if (val) setState({ users: { ...state.users, homeStore: String(val) } });
      });
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    // Extract store number from Workday title, e.g. "Store 01458" → "1458".
    function storeFromTitle(title) {
      const m = (title ?? "").match(/Store\s+0*(\d{3,5})/i);
      return m ? m[1] : null;
    }

    // Pick the WIN field from whatever InVue returns (confirmed on first run).
    function winOf(user) {
      return user.username ?? user.userId ?? user.employeeId ?? user.login ?? "";
    }

    // Classify a user's status relative to the home store.
    function statusOf(win) {
      const entry = u.lookup[win];
      if (!entry) return "unchecked";
      if (!entry.ok) return "notfound";
      const store = storeFromTitle(entry.title);
      if (!store) return "notfound";
      return store === u.homeStore ? "current" : "wrongstore";
    }

    const STATUS_LABEL = {
      unchecked:  "— Not checked",
      current:    "✓ Current",
      wrongstore: "⚠ Wrong store",
      notfound:   "✗ Not found",
    };
    const STATUS_CLASS = {
      unchecked:  "dl-user-status-unchecked",
      current:    "dl-user-status-current",
      wrongstore: "dl-user-status-warn",
      notfound:   "dl-user-status-bad",
    };

    // ── Fetch users from InVue ──────────────────────────────────────────────

    async function handleFetch() {
      setState({ users: { ...state.users, status: "loading" } });
      try {
        const resp = await host.messaging.sendRaw("fetchInvueUsers", {}, { timeoutMs: 60_000 });
        if (!resp?.ok) throw new Error(resp?.error || "fetchInvueUsers failed");
        setState({ users: { ...state.users, status: "ready", list: resp.users } });
      } catch (e) {
        setState({ users: { ...state.users, status: "error" } });
        alert(`Fetch failed: ${e?.message ?? e}`);
      }
    }

    // ── Cross-reference each WIN against One Walmart directory ──────────────

    async function handleCrossRef() {
      const users = state.users.list;
      if (!users.length) return;
      setState({ users: { ...state.users, status: "crossref" } });

      for (const user of users) {
        const win = winOf(user);
        if (!win) continue;
        // Skip if already looked up (cache hit still shows fromCache:true).
        if (state.users.lookup[win]) continue;
        try {
          const resp = await host.messaging.sendRaw("lookupAssociate", { userId: win }, { timeoutMs: 20_000 });
          setState({ users: { ...state.users, lookup: { ...state.users.lookup, [win]: resp } } });
        } catch {
          setState({ users: { ...state.users, lookup: { ...state.users.lookup, [win]: { ok: false, error: "timeout" } } } });
        }
      }
      setState({ users: { ...state.users, status: "ready" } });
    }

    // ── Delete a single user ────────────────────────────────────────────────

    async function handleDelete(user) {
      const win  = winOf(user);
      const name = user.firstName ? `${user.firstName} ${user.lastName}` : win;
      if (!confirm(`Remove ${name} (${win}) from InVue?\n\nThis cannot be undone.`)) return;

      try {
        const resp = await host.messaging.sendRaw("deleteInvueUser", { invueUserId: user.id }, { timeoutMs: 15_000 });
        if (!resp?.ok) throw new Error(resp?.error || "delete failed");
        // Remove from local list.
        setState({ users: { ...state.users, list: state.users.list.filter((u2) => u2.id !== user.id) } });
      } catch (e) {
        alert(`Delete failed: ${e?.message ?? e}`);
      }
    }

    // ── Build rows ──────────────────────────────────────────────────────────

    const rows = u.list.map((user) => {
      const win    = winOf(user);
      const entry  = u.lookup[win] ?? {};
      const status = statusOf(win);
      const canDel = status === "wrongstore" || status === "notfound";
      const invueName = [user.firstName, user.lastName].filter(Boolean).join(" ") || win;
      const wdStore   = storeFromTitle(entry.title);

      return h("tr", { class: status === "current" ? "" : "dl-user-row-flag" },
        h("td", null, win),
        h("td", null, invueName),
        h("td", null, entry.name ?? ""),
        h("td", null, wdStore ? `Store ${wdStore}` : (entry.title ?? "")),
        h("td", { class: STATUS_CLASS[status] }, STATUS_LABEL[status]),
        h("td", null,
          canDel
            ? h("button", { class: "btn btn-danger btn-xs", onClick: () => handleDelete(user) }, "Delete")
            : null,
        ),
      );
    });

    // ── Render ──────────────────────────────────────────────────────────────

    const loading   = u.status === "loading";
    const crossref  = u.status === "crossref";
    const hasUsers  = u.list.length > 0;
    const allChecked = hasUsers && u.list.every((user) => u.lookup[winOf(user)]);
    const flagCount  = hasUsers
      ? u.list.filter((user) => { const s = statusOf(winOf(user)); return s === "wrongstore" || s === "notfound"; }).length
      : 0;

    replace(els.content,
      h("div", { class: "dl-users-panel" },
        h("div", { class: "dl-users-toolbar" },
          h("button", {
            class: "btn btn-primary",
            disabled: loading || crossref,
            onClick: handleFetch,
          }, loading ? "Fetching…" : "Fetch from InVue"),
          hasUsers && h("button", {
            class: "btn btn-secondary",
            disabled: crossref,
            onClick: handleCrossRef,
          }, crossref ? "Checking Workday…" : "Cross-reference Workday"),
          u.homeStore && h("span", { class: "dl-users-store-badge" }, `Home store: ${u.homeStore}`),
          allChecked && flagCount > 0 && h("span", { class: "dl-users-flag-count" }, `${flagCount} flagged`),
        ),

        !hasUsers && u.status !== "loading" && h("p", { class: "dl-users-hint" },
          "Click \"Fetch from InVue\" to load all InVue users. You must be logged into InVue in another tab.",
        ),

        hasUsers && h("table", { class: "dl-users-table" },
          h("thead", null,
            h("tr", null,
              h("th", null, "WIN"),
              h("th", null, "InVue Name"),
              h("th", null, "Workday Name"),
              h("th", null, "Workday Store"),
              h("th", null, "Status"),
              h("th", null, "Action"),
            ),
          ),
          h("tbody", null, ...rows),
        ),
      ),
    );
  }

  function renderHistoryTable() {
    const filtered = sortRows(filterEvents(state.events, { ...state.filters, status: "" })
                                .filter((e) => e.reviewStatus !== "active"));
    if (!filtered.length) {
      replace(els.content,
        h("div", { class: "dl-empty" }, h("strong", null, "No cleared events yet."), " Mark events as reviewed and they'll appear here."),
      );
      return;
    }
    replace(els.content, makeEventTable(filtered, /* historyMode */ true));
    // Same as the events tab: no batch tenure prefetch. See renderEventsTab.
  }

  function renderChecklist() {
    // Daily checklist groups active events into episodes (per-user, per-zone,
    // 30-min windows). Sorted by max episode score desc.
    const active = filterEvents(state.events, { ...state.filters, status: state.filters.status || "active" });
    const episodes = groupIntoEpisodes(active, { windowMinutes: rules.thresholds.multiZoneWindowMinutes });
    if (!episodes.length) {
      replace(els.content, h("div", { class: "dl-empty" }, "Nothing currently flagged for the daily checklist."));
      return;
    }
    const exportBtn = h("button", { class: "btn btn-primary",
      onClick: () => {
        const today = new Date().toISOString().slice(0, 10);
        exportChecklistCsv(episodes, `digitallocks-checklist-${today}.csv`);
      },
    }, "Export checklist CSV");

    const list = episodes.map((ep) => {
      const badgeClass = RISK_LEVEL_TO_BADGE_CLASS[labelFromScore(ep.maxScore)];
      const sugg = suggestActionsForEpisode(ep);
      return h("div", { class: "dl-episode" },
        h("div", { class: "dl-episode-head" },
          h("span", { class: `dl-risk-badge ${badgeClass}` }, labelFromScore(ep.maxScore)),
          h("h3", null, `${ep.name || "(unattributed)"} — ${ep.zoneName || "(no zone)"}`),
          h("span", { class: "dl-episode-meta" },
            `${ep.position || "—"} · store ${ep.store || "?"} · ${fmtDateTime(ep.startTime)}${ep.startTime !== ep.endTime ? `–${fmtTime(ep.endTime)}` : ""} · ${ep.eventCount} event${ep.eventCount === 1 ? "" : "s"} · ${ep.locks.length} lock${ep.locks.length === 1 ? "" : "s"}`),
        ),
        h("div", { class: "dl-episode-score" }, String(ep.maxScore)),
        h("div", { class: "dl-episode-reasons" },
          ...ep.reasons.map((r) => h("span", { class: "dl-chip" }, r)),
        ),
        h("div", { class: "dl-episode-actions" },
          h("strong", null, "Suggested review: "), sugg.join(" · "),
        ),
      );
    });
    replace(els.content,
      h("div", { style: { marginBottom: "12px", display: "flex", justifyContent: "flex-end" } }, exportBtn),
      ...list,
    );
  }

  function makeEventTable(events, historyMode = false) {
    if (!events.length) {
      return h("div", { class: "dl-empty" }, "No events match the current filters.");
    }
    const wrap = h("div", { class: "dl-table-wrap" },
      h("table", { class: "dl-table" },
        h("thead", null,
          h("tr", null,
            sortableTh("Risk",    "riskScore"),
            sortableTh("Store",   "store"),
            sortableTh("Time",    "eventTime"),
            h("th", null, "User"),
            h("th", null, "Position"),
            sortableTh("Lock",    "lockName"),
            sortableTh("Zone",    "zoneName"),
            h("th", null, "Source"),
            h("th", null, "Reasons"),
            h("th", null, "Status"),
            h("th", null, "Actions"),
          )),
        h("tbody", null, ...events.map((e) => eventRow(e, historyMode))),
      ),
    );
    return wrap;
  }

  function sortableTh(label, key) {
    const isSorted = state.sortBy === key;
    return h("th", {
      class: "dl-sortable",
      onClick: () => setState({
        sortBy: key,
        sortDir: isSorted ? (state.sortDir === "asc" ? "desc" : "asc") : (key === "riskScore" ? "desc" : "asc"),
      }),
    },
      label,
      isSorted ? h("span", { class: "dl-sort-arrow" }, state.sortDir === "asc" ? "▲" : "▼") : null,
    );
  }

  function eventRow(e, historyMode) {
    const badgeClass = RISK_LEVEL_TO_BADGE_CLASS[e.riskLevel] || "dl-risk-normal";
    const rowClass = e.reviewStatus === "needs_follow_up" ? "dl-row-needs-followup"
                   : e.reviewStatus === "non_malicious"   ? "dl-row-hidden"
                   : null;
    return h("tr", { class: rowClass },
      h("td", null,
        h("span", { class: `dl-risk-badge ${badgeClass}` }, String(e.riskScore)),
      ),
      h("td", null, e.store || ""),
      h("td", { class: "dl-mono" }, fmtDateTime(e.eventTime)),
      h("td", { class: "dl-cell-user" },
        h("div", null, e.fullName || h("span", { class: "dl-muted" }, "(unattributed)")),
        h("div", { class: "dl-cell-id" }, e.userId || ""),
      ),
      h("td", null, e.position || ""),
      h("td", null, e.lockName || ""),
      h("td", null, e.zoneName || ""),
      h("td", null, e.unlockSource || ""),
      h("td", null,
        h("div", { class: "dl-cell-reasons" },
          ...(e.riskReasons || []).map((r) => h("span", { class: "dl-chip" }, r)),
          // Reasons that fired but scored nothing because they fire on nearly
          // every event in this import (see riskScoring.js base-rate
          // calibration). Shown muted so the row still reads truthfully
          // without implying the event is unusual.
          ...(e.baselineReasons || []).map((r) =>
            h("span", { class: "dl-chip dl-chip-baseline", title: "Normal for this import — not scored" }, r)),
        ),
      ),
      h("td", null,
        h("select", {
          class: `dl-status-inline dl-status-${e.reviewStatus}`,
          title: "Change status",
          onChange: async (ev) => {
            const newStatus = ev.target.value;
            try {
              await setStatus(host.storage.local, e.id, { status: newStatus, clearedReason: newStatus });
            } catch (err) {
              alert(`Failed to save: ${err?.message ?? err}`);
              return;
            }
            const found = state.events.find((x) => x.id === e.id);
            if (found) {
              found.reviewStatus = newStatus;
              if (newStatus !== "active") { found.clearedAt = Date.now(); found.clearedReason = newStatus; }
              else { found.clearedAt = null; found.clearedReason = null; }
            }
            setState({});
          },
        },
          ...STATUSES.map((s) =>
            h("option", { value: s, selected: s === e.reviewStatus ? true : undefined }, STATUS_LABEL[s]),
          ),
        ),
      ),
      h("td", null,
        h("div", { class: "dl-cell-actions" },
          h("button", { class: "btn btn-sm btn-secondary", onClick: () => setState({ selectedId: e.id }) }, "Details"),
        ),
      ),
    );
  }

  // ── Details drawer ────────────────────────────────────────────
  function renderDrawer() {
    clear(els.drawerHost);
    if (!state.selectedId) return;
    const e = state.events.find((x) => x.id === state.selectedId);
    if (!e) { state.selectedId = null; return; }

    const backdrop = h("div", { class: "dl-drawer-backdrop", onClick: closeDrawer });
    const drawer = h("aside", { class: "dl-drawer", role: "dialog", "aria-label": "Event details" },
      h("div", { class: "dl-drawer-head" },
        h("div", null,
          h("div", { style: { fontWeight: 600 } }, e.fullName || "(unattributed)"),
          h("div", { class: "dl-muted", style: { fontSize: "12px" } }, e.userId || ""),
        ),
        h("button", { class: "btn-icon", onClick: closeDrawer, title: "Close" }, "✕"),
      ),
      h("div", { class: "dl-drawer-body" },
        h("p", { class: "dl-muted", style: { marginTop: 0 } },
          "This event is suggested for review. Inclusion here does not indicate wrongdoing."),
        h("dl", null,
          dt("Risk"),       dd(`${e.riskScore} (${e.riskLevel})`),
          dt("Store"),      dd(e.store || "—"),
          dt("Time"),       dd(fmtDateTime(e.eventTime)),
          dt("Position"),   dd(e.position || "—"),
          dt("Lock"),       dd(e.lockName || "—"),
          dt("Zone"),       dd(e.zoneName || "—"),
          dt("Source"),     dd(e.unlockSource || "—"),
          dt("Status"),     dd(STATUS_LABEL[e.reviewStatus] || e.reviewStatus),
          e.clearedAt ? dt("Cleared at") : null,
          e.clearedAt ? dd(new Date(e.clearedAt).toLocaleString()) : null,
          e.clearedReason ? dt("Cleared reason") : null,
          e.clearedReason ? dd(STATUS_LABEL[e.clearedReason] || e.clearedReason) : null,
        ),

        // One click from "this opening" to "every opening of this case" —
        // the question a single flagged row almost always raises.
        h("p", { style: { marginTop: "12px", marginBottom: 0 } },
          h("button", {
            class: "btn btn-sm btn-secondary",
            title: `Show every opening of ${e.lockName || "this case"}`,
            onClick: () => setState({
              tab: "cases",
              selectedCaseKey: caseKeyOf(e),
              caseUserFilter: "",
              selectedId: null,
            }),
          }, "See all openings of this case →"),
        ),

        h("h4", { style: { marginTop: "20px", marginBottom: "8px" } }, "Why this surfaced"),
        e.riskReasons?.length
          ? h("ul", { class: "dl-reason-list" }, ...e.riskReasons.map((r) => h("li", null, r)))
          : h("p", { class: "dl-muted" }, "No risk rules fired."),

        // ── Case items ─────────────────────────────────────────────────────
        renderDrawerCaseItems(e),

        // ── Order context ──────────────────────────────────────────────────
        renderDrawerOrderContext(e),

        // ── Tenure context ─────────────────────────────────────────────────
        renderDrawerTenure(e),

        h("h4", { style: { marginTop: "20px", marginBottom: "8px" } }, "Reviewer notes"),
        h("textarea", {
          id: "dl-note-edit",
          placeholder: "Add context, schedule info, CCTV reference, conversation notes…",
        }, e.reviewerNotes || ""),
      ),
      h("div", { class: "dl-drawer-foot" },
        h("button", { class: "btn", onClick: closeDrawer }, "Close"),
        h("button", { class: "btn btn-secondary",
          onClick: () => saveStatus(e.id, "needs_follow_up") }, "Needs Follow-Up"),
        h("button", { class: "btn btn-secondary",
          title: "Open email client with event details pre-filled",
          onClick: () => openEmailCompose(e) }, "Email Investigator"),
        h("button", { class: "btn btn-secondary",
          onClick: () => saveStatus(e.id, "non_malicious") }, "Mark Non-Malicious"),
        h("button", { class: "btn btn-danger",
          title: "Open Auror and pre-fill an Employee Theft event with associate details",
          onClick: () => onConvertToEvent(e) }, "Convert to Event"),
        h("button", { class: "btn btn-secondary",
          onClick: () => saveStatus(e.id, "dismissed") }, "Dismiss"),
      ),
    );
    els.drawerHost.appendChild(backdrop);
    els.drawerHost.appendChild(drawer);
  }

  function dt(label) { return h("dt", null, label); }
  function dd(value) { return h("dd", null, value); }

  // ── Drawer section: items mapped to this case ─────────────────────────────

  function renderDrawerCaseItems(e) {
    const section = h("div", { class: "dl-drawer-section" },
      h("h4", null, "Items in this case"),
    );
    if (!state.caseMapping) {
      section.appendChild(
        h("p", { class: "dl-muted dl-drawer-hint" },
          "No case map loaded. Click ", h("strong", null, "Case Map…"), " in the header to import one."),
      );
      return section;
    }
    const items = lookupCaseItems(state.caseMapping.items, {
      zoneName: e.zoneName, lockName: e.lockName, store: e.store,
    });
    if (!items.length) {
      section.appendChild(
        h("p", { class: "dl-muted dl-drawer-hint" },
          `No items mapped for "${e.lockName}" in "${e.zoneName}". Check that the case map covers this lock.`),
      );
      return section;
    }
    const table = h("table", { class: "dl-table dl-table-compact" },
      h("thead", null, h("tr", null,
        h("th", null, "UPC"), h("th", null, "Item #"), h("th", null, "Description"),
      )),
      h("tbody", null, ...items.map((item) =>
        h("tr", null,
          h("td", { class: "dl-mono" }, item.upc),
          h("td", null, item.itemNumber || "—"),
          h("td", null, item.description || "—"),
        ),
      )),
    );
    section.appendChild(table);
    return section;
  }

  // ── Drawer section: GScope order cross-check ──────────────────────────────

  function renderDrawerOrderContext(e) {
    const section = h("div", { class: "dl-drawer-section" },
      h("h4", null, "Online order context"),
    );

    const isDigitalAssoc = isDigitalPosition(e.position);
    if (!isDigitalAssoc) {
      section.appendChild(
        h("p", { class: "dl-muted dl-drawer-hint" },
          "Order cross-check applies to digital / OGP associates only."),
      );
      return section;
    }

    if (!state.caseMapping) {
      section.appendChild(
        h("p", { class: "dl-muted dl-drawer-hint" },
          "Load a case map first to enable order cross-check."),
      );
      return section;
    }

    const caseItems = lookupCaseItems(state.caseMapping.items, {
      zoneName: e.zoneName, lockName: e.lockName, store: e.store,
    });
    if (!caseItems.length) {
      section.appendChild(
        h("p", { class: "dl-muted dl-drawer-hint" }, "No items mapped — cannot check orders."),
      );
      return section;
    }

    const ctx = state.orderCtx[e.id];
    if (!ctx) {
      // Trigger lookup and re-render when done
      triggerOrderLookup(e, caseItems);
      section.appendChild(h("p", { class: "dl-muted dl-drawer-hint" }, "Checking orders…"));
      return section;
    }
    if (ctx.loading) {
      section.appendChild(h("p", { class: "dl-muted dl-drawer-hint" }, "Checking orders…"));
      return section;
    }
    if (ctx.error) {
      section.appendChild(
        h("div", { class: "dl-order-result dl-order-error" },
          h("span", { class: "dl-chip" }, "Unable to verify"),
          h("span", { class: "dl-muted" }, ` ${ctx.error}`),
          h("button", { class: "btn btn-sm btn-secondary", style: { marginLeft: "8px" },
            onClick: () => retriggerOrderLookup(e, caseItems) }, "Retry"),
        ),
      );
      return section;
    }

    const anyMatch = ctx.results?.some((r) => r.found);
    const matchLabel = anyMatch ? "Matching order found" : "No matching order found";
    const matchClass = anyMatch ? "dl-order-matched" : "dl-order-nomatch";
    const W = rules?.weights?.ORDER_NO_MATCH ?? 0;

    section.appendChild(
      h("div", { class: `dl-order-result ${matchClass}` },
        h("span", { class: `dl-chip dl-chip-${anyMatch ? "success" : "warn"}` }, matchLabel),
        !anyMatch && W > 0
          ? h("span", { class: "dl-muted" }, ` +${W} to risk score`)
          : h("span", { class: "dl-muted" }, ` (${ctx.results?.length ?? 0} UPC${ctx.results?.length === 1 ? "" : "s"} checked)`),
        h("button", { class: "btn btn-sm btn-secondary", style: { marginLeft: "8px" },
          onClick: () => retriggerOrderLookup(e, caseItems) }, "Refresh"),
      ),
    );
    if (ctx.results?.length) {
      const rows = ctx.results.filter((r) => r.found);
      if (rows.length) {
        rows.forEach((r) => {
          section.appendChild(
            h("div", { class: "dl-order-detail" },
              h("span", { class: "dl-mono" }, r.upc),
              h("span", { class: "dl-muted" }, ` — ${r.orderCount} order(s) · statuses: ${(r.lineStatuses || []).join(", ") || "unknown"}`),
            ),
          );
        });
      }
    }
    return section;
  }

  function triggerOrderLookup(e, caseItems) {
    if (state.orderCtx[e.id]?.loading) return;
    setState({ orderCtx: { ...state.orderCtx, [e.id]: { loading: true } } });
    const upcs = [...new Set(caseItems.map((i) => i.upc))];
    host.messaging.sendRaw("lookupUpcOrders", { upcs, storeNumber: e.store }, { timeoutMs: 30_000 })
      .then((resp) => {
        if (cancelled) return;
        const ctx = resp?.ok
          ? { results: resp.results }
          : { error: resp?.error || "Lookup failed" };
        // Apply score boost in memory if no matching order found and not already applied.
        if (resp?.ok && !ctx.results?.some((r) => r.found)) {
          const W = rules?.weights?.ORDER_NO_MATCH ?? 0;
          const ev = state.events.find((x) => x.id === e.id);
          if (ev && !ev._orderCtxScored && W > 0) {
            ev.riskScore   += W;
            ev.riskReasons  = [...(ev.riskReasons || []), "no matching online order (digital associate)"];
            ev.riskLevel    = labelFromScore(ev.riskScore);
            ev._orderCtxScored = true;
          }
        }
        setState({ orderCtx: { ...state.orderCtx, [e.id]: ctx } });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ orderCtx: { ...state.orderCtx, [e.id]: { error: err?.message ?? String(err) } } });
      });
  }

  function retriggerOrderLookup(e, caseItems) {
    const newCtx = { ...state.orderCtx };
    delete newCtx[e.id];
    setState({ orderCtx: newCtx });
  }

  function isDigitalPosition(position) {
    if (!position) return false;
    const p = position.toLowerCase();
    return p.includes("personal shopper") || p.includes("digital personal") ||
           p.includes("ogp") || p.includes("online grocery") || p.includes("pickup associate") ||
           p.includes("curbside") || p.includes("digital associate");
  }

  // ── Drawer section: tenure / hire date ────────────────────────────────────

  function renderDrawerTenure(e) {
    const section = h("div", { class: "dl-drawer-section" },
      h("h4", null, "Associate tenure"),
      h("p", { class: "dl-muted dl-drawer-hint", style: { fontSize: "11px", marginTop: 0 } },
        "Tenure is scheduling context only — recent hires frequently open cases for legitimate reasons."),
    );

    if (!e.userId) {
      section.appendChild(h("p", { class: "dl-muted" }, "No associate ID — cannot look up tenure."));
      return section;
    }

    const ctx = state.assocCtx[e.userId];
    if (!ctx) {
      triggerAssocLookup(e.userId);
      section.appendChild(h("p", { class: "dl-muted dl-drawer-hint" }, "Looking up tenure…"));
      return section;
    }
    if (ctx.loading) {
      section.appendChild(h("p", { class: "dl-muted dl-drawer-hint" }, "Looking up tenure…"));
      return section;
    }
    if (ctx.error || ctx.ok === false) {
      section.appendChild(
        h("p", { class: "dl-muted" },
          "Tenure unavailable. ",
          h("button", { class: "btn btn-sm btn-secondary", onClick: () => retriggerAssocLookup(e.userId) }, "Retry"),
        ),
      );
      return section;
    }

    const tenureDays = ctx.tenureDays ?? null;
    const newHireThreshold = rules?.thresholds?.newHireThresholdDays ?? 90;
    const isNewHire = tenureDays != null && tenureDays < newHireThreshold;
    const approxHireDate = tenureDays != null
      ? new Date(Date.now() - tenureDays * 86_400_000).toLocaleDateString()
      : null;

    section.appendChild(
      h("dl", null,
        ctx.name ? [dt("Name (directory)"), dd(ctx.name)] : null,
        ctx.title ? [dt("Title (directory)"), dd(ctx.title)] : null,
        tenureDays != null ? [dt("Length of service"), dd(
          h("span", null, ctx.lengthOfSvc || `${tenureDays} days`),
          isNewHire
            ? h("span", { class: "dl-badge dl-badge-warn", style: { marginLeft: "8px" } },
                `Recently hired (<${newHireThreshold}d)`)
            : null,
        )] : null,
        approxHireDate ? [dt("Approx. hire date"), dd(
          h("span", { class: "dl-muted" }, `${approxHireDate} (derived from length of service)`),
        )] : null,
        ctx.fromCache
          ? [dt("Data source"), dd(h("span", { class: "dl-muted" }, "Directory (cached 24h)"))]
          : null,
      ),
    );
    return section;
  }

  function triggerAssocLookup(userId) {
    if (state.assocCtx[userId]?.loading) return;
    setState({ assocCtx: { ...state.assocCtx, [userId]: { loading: true } } });
    host.messaging.sendRaw("lookupAssociate", { userId }, { timeoutMs: 20_000 })
      .then((resp) => {
        if (cancelled) return;
        setState({ assocCtx: { ...state.assocCtx, [userId]: resp } });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ assocCtx: { ...state.assocCtx, [userId]: { ok: false, error: err?.message ?? String(err) } } });
      });
  }

  function retriggerAssocLookup(userId) {
    const newCtx = { ...state.assocCtx };
    delete newCtx[userId];
    setState({ assocCtx: newCtx });
  }

  function closeDrawer() {
    if (state.selectedId != null) setState({ selectedId: null });
  }

  function openEmailCompose(e) {
    const ctx = e.userId ? state.assocCtx[e.userId] : null;
    const name = ctx?.name || e.fullName || "(unknown associate)";
    const noteEl = els.drawerHost.querySelector("#dl-note-edit");
    const notes = noteEl?.value || e.reviewerNotes || "";
    const subject = `Digital Lock Event — Needs Follow-Up — Store ${e.store || "?"}`;
    const body = [
      `Associate: ${name} (ID: ${e.userId || "—"})`,
      `Event time: ${fmtDateTime(e.eventTime)}`,
      `Store: ${e.store || "—"} · Zone: ${e.zoneName || "—"} · Lock: ${e.lockName || "—"}`,
      `Risk score: ${e.riskScore} (${e.riskLevel})`,
      `Reasons: ${(e.riskReasons || []).join("; ") || "none"}`,
      notes ? `\nReviewer notes:\n${notes}` : "",
    ].filter(Boolean).join("\n");
    window.open(`mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, "_self");
  }

  async function onConvertToEvent(e) {
    const ctx = e.userId ? state.assocCtx[e.userId] : null;
    const assocName = ctx?.name || e.fullName || "";
    const tenureDays = ctx?.tenureDays ?? null;
    const approxHireDate = tenureDays != null
      ? new Date(Date.now() - tenureDays * 86_400_000).toLocaleDateString()
      : "unknown";

    const noteEl = els.drawerHost.querySelector("#dl-note-edit");
    const currentNotes = noteEl?.value || e.reviewerNotes || "";

    const defaultDescription = [
      `On ${fmtDateTime(e.eventTime)},`,
      assocName ? `${assocName} (Walmart ID: ${e.userId || "—"}, approx. hire date: ${approxHireDate})` : `associate ID: ${e.userId || "—"}`,
      e.position ? `, ${e.position},` : null,
      `was observed opening case ${e.lockName || "—"} in zone ${e.zoneName || "—"} at store ${e.store || "—"}.`,
      (e.riskReasons || []).length ? `Risk factors: ${e.riskReasons.join("; ")}.` : null,
      currentNotes ? `Reviewer notes: ${currentNotes}` : null,
      "This event was flagged by the Digital Locks automated review system.",
    ].filter(Boolean).join(" ");

    // Confirmation dialog with editable description before opening Auror.
    const confirmed = await new Promise((resolve) => {
      let descriptionText = defaultDescription;
      const dlg = h("dialog", { class: "modal" },
        h("div", { class: "modal-head" }, "Convert to Auror Event"),
        h("div", { class: "modal-body" },
          h("p", { class: "dl-muted", style: { marginTop: 0 } },
            "This will open Auror → event/new and pre-fill an Employee Theft event. You will review and submit it."),
          h("dl", null,
            dt("Associate"), dd(assocName || "(not resolved — name field will be blank)"),
            dt("Hire date"), dd(`${approxHireDate} (derived)`),
            dt("Store / Lock"), dd(`${e.store || "—"} · ${e.zoneName || "—"} / ${e.lockName || "—"}`),
            dt("Event time"), dd(fmtDateTime(e.eventTime)),
          ),
          h("label", { style: { display: "block", marginTop: "12px" } },
            h("strong", null, "Narrative (editable before sending)"),
            h("textarea", {
              style: { display: "block", width: "100%", marginTop: "6px", minHeight: "100px", fontSize: "12px" },
              onInput: (ev) => { descriptionText = ev.target.value; },
            }, defaultDescription),
          ),
        ),
        h("div", { class: "modal-foot" },
          h("button", { class: "btn", onClick: () => { dlg.close(); resolve(null); } }, "Cancel"),
          h("button", { class: "btn btn-danger", onClick: () => { dlg.close(); resolve(descriptionText); } },
            "Open Auror & Fill Form"),
        ),
      );
      document.body.appendChild(dlg);
      openDialogs.add(dlg);
      dlg.addEventListener("close", () => { openDialogs.delete(dlg); dlg.remove(); }, { once: true });
      dlg.showModal();
    });

    if (!confirmed) return;

    // Save notes + mark as confirmed_theft_review before opening Auror.
    await saveStatus(e.id, "confirmed_theft_review");

    showImportProgress("Opening Auror and filling event form…");
    try {
      const result = await host.messaging.sendRaw("createAurorEvent", {
        store:         e.store,
        eventTime:     e.eventTime,
        lockName:      e.lockName,
        zoneName:      e.zoneName,
        position:      e.position,
        associateName: assocName,
        associateId:   e.userId,
        tenureDays,
        notes:         confirmed,   // use the (possibly edited) description as the narrative
      }, { timeoutMs: 90_000 });
      if (result?.status === "error") {
        alert(`Auror form fill encountered an issue: ${result.error}\n\nThe tab is still open — you can fill it manually.`);
      }
    } catch (err) {
      alert(`Failed to open Auror: ${err?.message ?? err}`);
    } finally {
      showImportProgress(null);
    }
  }

  async function saveStatus(id, status) {
    const noteEl = els.drawerHost.querySelector("#dl-note-edit");
    const notes = noteEl ? noteEl.value : undefined;
    try {
      await setStatus(host.storage.local, id, { status, notes, clearedReason: status });
    } catch (e) {
      alert(`Failed to save status: ${e?.message ?? e}`);
      return;
    }
    // Update in-memory event so we don't reload the entire import.
    const ev = state.events.find((x) => x.id === id);
    if (ev) {
      ev.reviewStatus = status;
      if (typeof notes === "string") ev.reviewerNotes = notes;
      if (status !== "active") {
        ev.clearedAt = Date.now();
        ev.clearedReason = status;
      } else {
        ev.clearedAt = null;
        ev.clearedReason = null;
      }
    }
    setState({ selectedId: null });
  }

  function doExport() {
    if (!state.events.length) return;
    const today = new Date().toISOString().slice(0, 10);
    if (state.tab === "history") {
      const rows = filterEvents(state.events, { ...state.filters, status: "" }).filter((e) => e.reviewStatus !== "active");
      exportHistoryCsv(rows, `digitallocks-history-${today}.csv`);
    } else if (state.tab === "cases") {
      const cases = groupByCase(casesBaseEvents(), isAfterHoursHour);
      const one = state.selectedCaseKey ? cases.find((c) => c.key === state.selectedCaseKey) : null;
      if (one) {
        const rows = state.caseUserFilter
          ? one.events.filter((e) => (e.userId || "(unattributed)") === state.caseUserFilter)
          : one.events;
        const slug = (one.lockName || "case").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
        exportCaseOpeningsCsv(rows, `digitallocks-openings-${slug || "case"}-${today}.csv`);
      } else {
        exportCaseSummaryCsv(sortCases(cases), `digitallocks-cases-${today}.csv`);
      }
    } else if (state.tab === "checklist") {
      const active = filterEvents(state.events, { ...state.filters, status: state.filters.status || "active" });
      const eps = groupIntoEpisodes(active, { windowMinutes: rules.thresholds.multiZoneWindowMinutes });
      exportChecklistCsv(eps, `digitallocks-checklist-${today}.csv`);
    } else {
      const rows = filterEvents(state.events, { ...state.filters, status: state.filters.status || "active" });
      exportActiveCsv(rows, `digitallocks-active-${today}.csv`);
    }
  }

  function labelFromScore(score) {
    let label = rules.bands[0]?.label || "Normal";
    for (const b of rules.bands) if (score >= b.min) label = b.label;
    return label;
  }

  function suggestActionsForEpisode(ep) {
    const out = [];
    const reasons = new Set(ep.reasons.map((r) => r.toLowerCase()));
    if ([...reasons].some((r) => r.includes("after-hours") || r.includes("edge after"))) {
      out.push("Verify schedule", "Review CCTV");
    }
    if ([...reasons].some((r) => r.includes("role/zone mismatch"))) {
      out.push("Confirm assigned task");
    }
    if ([...reasons].some((r) => r.includes("high-risk zone"))) {
      out.push("Compare to transactions");
    }
    if ([...reasons].some((r) => r.includes("repeated") || r.includes("zones in"))) {
      out.push("Check pattern across prior days");
    }
    if ([...reasons].some((r) => r.includes("unusual unlock source"))) {
      out.push("Verify source device/account");
    }
    if (out.length === 0) out.push("Brief eyeball review");
    return out;
  }
  // Sort the current page's rows by the active sort column. Closure over
  // state so callers don't need to thread the sort spec through.
  function sortRows(events) {
    const { sortBy, sortDir } = state;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...events].sort((a, b) => {
      const av = a[sortBy], bv = b[sortBy];
      if (av == null && bv == null) return 0;
      if (av == null) return  1 * dir;
      if (bv == null) return -1 * dir;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }
}

// ── Pure helpers ──────────────────────────────────────────────

function summarizeForIndex(events) {
  const stores = [...new Set(events.map((e) => e.store).filter(Boolean))].sort();
  const dates  = events.map((e) => e.eventDate).filter(Boolean).sort();
  const scoreBands = { Normal: 0, Watch: 0, High: 0, Critical: 0 };
  for (const e of events) scoreBands[e.riskLevel] = (scoreBands[e.riskLevel] || 0) + 1;
  return {
    rowCount: events.length,
    dateRange: { min: dates[0] ?? null, max: dates[dates.length - 1] ?? null },
    stores,
    scoreBands,
  };
}

// Drop transient pre-scoring scratch fields before persisting to IDB so the
// stored blob is smaller and re-scoring on load is deterministic.
function stripTransientFields(e) {
  const { _multiZoneWindow, _repeatedSameLock, ...rest } = e;
  return rest;
}

function filterEvents(events, f) {
  const q = (f.query || "").trim().toLowerCase();
  const fromMs = f.dateFrom ? f.dateFrom.getTime() : null;
  const toMs   = f.dateTo   ? f.dateTo.getTime()   : null;
  return events.filter((e) => {
    if (f.store     && e.store     !== f.store)     return false;
    if (f.position  && e.position  !== f.position)  return false;
    if (f.zone      && e.zoneName  !== f.zone)      return false;
    if (f.riskLevel && e.riskLevel !== f.riskLevel) return false;
    if (f.status    && e.reviewStatus !== f.status) return false;
    if (fromMs != null || toMs != null) {
      const t = e.eventTime ? Date.parse(e.eventTime) : NaN;
      if (Number.isFinite(t)) {
        if (fromMs != null && t < fromMs) return false;
        if (toMs   != null && t > toMs)   return false;
      }
      // Events with unparseable timestamps pass through — same defensive
      // stance the rest of the filter takes (unknown ≠ excluded).
    }
    if (q) {
      const hay = `${e.fullName} ${e.userId} ${e.lockName} ${e.zoneName} ${e.position}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function uniqueSorted(arr) {
  return [...new Set(arr.filter(Boolean))].sort();
}

// A "case" is one physical locked fixture: the same lock name, in the same
// zone, at the same store. Store is part of the key because lock names repeat
// across stores ("Fragrance 1" exists everywhere) and merging two stores'
// openings into one row would invent a pattern that isn't there.
export function caseKeyOf(e) {
  return [e.store || "", e.zoneName || "", e.lockName || ""].join("\u0000");
}

/**
 * Group events into per-case opening histories.
 *
 * @param {object[]} events
 * @param {(hour:number|null) => boolean} isAfterHours — injected so this stays
 *        pure of the rules file; the caller owns the time windows.
 * @returns {object[]} cases, each with .events, .openers (desc by openings),
 *          .days ([dayKey, count] ascending), and roll-up counts.
 */
export function groupByCase(events, isAfterHours = () => false) {
  const map = new Map();
  for (const e of events) {
    const key = caseKeyOf(e);
    let c = map.get(key);
    if (!c) {
      c = {
        key,
        store: e.store || "", zoneName: e.zoneName || "", lockName: e.lockName || "",
        events: [], openings: 0, afterHours: 0, flagged: 0, maxScore: 0,
        firstMs: null, lastMs: null,
        byUser: new Map(), byDay: new Map(),
      };
      map.set(key, c);
    }
    const t = e.eventTime ? Date.parse(e.eventTime) : NaN;
    const after = isAfterHours(e.eventHour);

    c.events.push(e);
    c.openings++;
    if (after) c.afterHours++;
    if (e.riskLevel === "High" || e.riskLevel === "Critical") c.flagged++;
    if ((e.riskScore || 0) > c.maxScore) c.maxScore = e.riskScore || 0;
    if (Number.isFinite(t)) {
      if (c.firstMs == null || t < c.firstMs) c.firstMs = t;
      if (c.lastMs  == null || t > c.lastMs)  c.lastMs  = t;
    }
    if (e.eventDate) c.byDay.set(e.eventDate, (c.byDay.get(e.eventDate) || 0) + 1);

    // Unattributed rows (no USER ID) collapse into one bucket rather than
    // one bucket each — "12 openings nobody is named on" is the useful shape.
    const uid = e.userId || "(unattributed)";
    let u = c.byUser.get(uid);
    if (!u) {
      u = { userId: e.userId || "", name: "", position: "",
            openings: 0, afterHours: 0, firstMs: null, lastMs: null, maxScore: 0 };
      c.byUser.set(uid, u);
    }
    u.openings++;
    if (!u.name && e.fullName) u.name = e.fullName;
    if (!u.position && e.position) u.position = e.position;
    if (after) u.afterHours++;
    if ((e.riskScore || 0) > u.maxScore) u.maxScore = e.riskScore || 0;
    if (Number.isFinite(t)) {
      if (u.firstMs == null || t < u.firstMs) u.firstMs = t;
      if (u.lastMs  == null || t > u.lastMs)  u.lastMs  = t;
    }
  }

  const out = [...map.values()];
  for (const c of out) {
    c.people    = c.byUser.size;
    c.openers   = [...c.byUser.values()].sort((a, b) => b.openings - a.openings);
    c.topOpener = c.openers[0] || null;
    c.days      = [...c.byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }
  return out;
}

function mostBy(arr, keyFn) {
  const counts = new Map();
  for (const item of arr) {
    const k = keyFn(item);
    if (!k) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let best = null;
  for (const [k, c] of counts) {
    if (!best || c > best.count) best = { key: k, count: c };
  }
  return best;
}

function fmtDateTime(t) {
  if (!t) return "";
  const d = new Date(t);
  if (!Number.isFinite(d.getTime())) return String(t);
  return d.toISOString().replace("T", " ").replace(/:\d\d\.\d+Z$/, "").replace(/Z$/, "");
}
function fmtTime(t) {
  if (!t) return "";
  const d = new Date(t);
  if (!Number.isFinite(d.getTime())) return String(t);
  return d.toISOString().slice(11, 16);
}

// Local-time YYYY-MM-DD for <input type="date"> values. Using ISO would
// shift the displayed day by the user's UTC offset (we live west of UTC).
function fmtDateInput(d) {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  if (!Number.isFinite(dt.getTime())) return "";
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function endOfDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

// Min/max event timestamps across the loaded events. Returns {min:null,
// max:null} when nothing parses — the filter falls back to "no bounds".
function computeDateBounds(events) {
  let minMs = Infinity;
  let maxMs = -Infinity;
  for (const e of events) {
    const t = e.eventTime ? Date.parse(e.eventTime) : NaN;
    if (!Number.isFinite(t)) continue;
    if (t < minMs) minMs = t;
    if (t > maxMs) maxMs = t;
  }
  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs)) {
    return { min: null, max: null };
  }
  return { min: startOfDay(new Date(minMs)), max: endOfDay(new Date(maxMs)) };
}

// Default date filter on import load: last 7 days of the imported data,
// anchored to the latest event (NOT today). Anchoring to the data's max
// keeps the default useful when reviewing a stale import — "last 7 days"
// of an import from a month ago shouldn't render empty.
function defaultDateWindow(bounds) {
  if (!bounds.max) return { from: null, to: null };
  const to = bounds.max;
  const candidate = new Date(bounds.max);
  candidate.setDate(candidate.getDate() - 6); // inclusive 7-day span
  let from = startOfDay(candidate);
  if (bounds.min && from < bounds.min) from = bounds.min;
  return { from, to };
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]
  ));
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} → ${r.status}`);
  return r.json();
}
