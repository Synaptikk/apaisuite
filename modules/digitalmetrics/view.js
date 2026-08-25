// modules/digitalmetrics/view.js
//
// Module shell: store/week selection, data loading, tab routing, and the
// re-render loop. Page modules own their own markup and wiring; this file owns
// the state they read.
//
// Data flow, deliberately one-directional:
//   SW handler → decoded plaintext → state → page.render(ctx) → DOM
//   DOM event  → onUiChange/onClassify → state → re-render
//
// Nothing here touches Firestore. Nothing here sees a token or a ciphertext —
// lib/firestore.js has already decoded by the time a handler returns.

import { analyse } from "./lib/data/metrics.js";
import { calculateAdherence, actualPickHoursByName } from "./lib/data/adherence.js";
import * as dashboard    from "./lib/pages/dashboard.js";
import * as classifyPage from "./lib/pages/classify.js";
import * as comparison   from "./lib/pages/comparison.js";
import * as opportunities from "./lib/pages/opportunities.js";
import * as leaderboard  from "./lib/pages/leaderboard.js";
import * as faq          from "./lib/pages/faq.js";
import * as insights     from "./lib/pages/insights.js";
import * as associatesPage from "./lib/pages/associates.js";
import { taskPatterns } from "./lib/data/associates.js";
import * as assignmentsPage from "./lib/pages/assignments/index.js";
import { isFinalized, defaultDate, dayName } from "./lib/data/grid.js";
import { parseWorkbook } from "./lib/data/xlsx.js";
import { parseDailyBoard } from "./lib/data/daily_board.js";
import { parseSchedulePayload } from "./lib/data/schedule_import.js";

const PAGES = {
  dashboard,
  insights,
  classify:      classifyPage,
  comparison,
  opportunities,
  leaderboard,
  associates:    associatesPage,
  assignments:   assignmentsPage,
  faq,
};

export async function mount(host, container) {
  container.innerHTML = await fetch(host.url("view.html")).then((r) => r.text());

  const $ = (sel) => container.querySelector(sel);
  const setStatus = (text) => { const el = $("#dm-status"); if (el) el.textContent = text; };

  const state = {
    page: "dashboard",
    store: null,
    week: null,
    rawData: [],
    classifications: {},
    associates: [],
    benchmarks: {},
    dates: [],
    adherence: {},
    // Assignments tab
    assignmentDate: defaultDate(),
    assignments: [],
    suggestions: {},
    locked: false,
    saveStatus: "",

    patterns: null,          // task patterns for the selected associate
    recentAssignments: null, // cached; one fetch serves every associate
    ui: {},
  };

  let disposePage = null;

  // ── Messaging helper ─────────────────────────────────────────────────────
  // Every SW call funnels through here so one failure path handles them all;
  // the donor let Firebase errors vanish into console.log.
  async function call(type, payload = {}) {
    const res = await host.messaging.send(type, payload);
    if (!res?.ok) {
      setStatus(`error: ${res?.error || "unknown"}`);
      return null;
    }
    return res.data;
  }

  // ── Rendering ────────────────────────────────────────────────────────────
  function renderPage() {
    const el = $("#dm-page");
    if (!el) return;

    disposePage?.();
    disposePage = null;

    const page = PAGES[state.page];
    if (!page) {
      el.innerHTML = `<div class="dm-todo"><strong>${host.ui.escapeHtml(state.page)}</strong>` +
                     ` — not yet ported from the standalone app.</div>`;
      return;
    }

    const ctx = {
      ...state,
      host,
      onUiChange: (patch) => { state.ui = { ...state.ui, ...patch }; renderPage(); },
      onClassify: setClassification,
      onSelectAssociate: selectAssociate,

      // Assignments
      date:            state.assignmentDate,
      suggestionCount: countSuggestions(),
      onDateChange:    setAssignmentDate,
      onSetTask:       setTask,
      onSetStatus:     toggleStatus,
      onAddAssociate:  addAssociate,
      onFinalize:      setFinalized,
      onAcceptAll:     acceptAllSuggestions,
      onDismissAll:    () => { state.suggestions = {}; renderPage(); },
      onImport:        importSchedule,
      onPrint:         () => window.print(),
    };

    el.innerHTML = page.render(ctx);
    disposePage = page.wire?.(ctx, el) || null;
  }

  function selectPage(page) {
    if (!(page in PAGES)) return;
    state.page = page;
    for (const btn of container.querySelectorAll(".dm-tab")) {
      btn.classList.toggle("is-active", btn.dataset.dmPage === page);
    }
    renderPage();
    // The grid is the only tab with its own date, so it loads on entry rather
    // than with the week.
    if (page === "assignments" && state.store) loadAssignments();
  }

  // ── Derived state ────────────────────────────────────────────────────────
  function recompute() {
    const { associates, benchmarks, dates } = analyse(state.rawData, state.classifications);
    Object.assign(state, { associates, benchmarks, dates });
  }

  async function loadAdherence() {
    if (!state.store || !state.associates.length) return;

    // Adherence needs one assignment document per date in the loaded week.
    const entries = await Promise.all(state.dates.map(async (iso) => {
      const doc = await call("get_assignments", { store: state.store, date: iso });
      if (!doc) return null;
      // Assignment docs are keyed by ISO date; metrics rows key by MM/DD/YY.
      const [y, m, d] = iso.split("-");
      return [`${m}/${d}/${y.slice(2)}`, doc];
    }));

    const byDate = Object.fromEntries(entries.filter(Boolean));
    state.adherence = calculateAdherence(
      state.associates, byDate, actualPickHoursByName(state.rawData), state.classifications,
    );
    renderPage();
  }

  // ── Data loading ─────────────────────────────────────────────────────────
  async function loadStores() {
    setStatus("loading stores…");
    const list = await call("list_stores");
    if (!list) return;

    const sel = $("#dm-store");
    sel.innerHTML = list.length
      ? list.map((s) => `<option value="${host.ui.escapeHtml(s)}">${host.ui.escapeHtml(s)}</option>`).join("")
      : `<option value="">no stores</option>`;

    state.classifications = (await call("get_classifications")) || {};

    if (list.length) {
      state.store = list[0];
      await loadWeeks();
    } else {
      setStatus("no stores");
    }
  }

  async function loadWeeks() {
    if (!state.store) return;
    setStatus("loading weeks…");

    const weeks = await call("list_weeks", { store: state.store });
    if (!weeks) return;

    const recentFirst = [...weeks].reverse();
    $("#dm-week").innerHTML = recentFirst.length
      ? recentFirst.map((w) => `<option value="${host.ui.escapeHtml(w)}">${host.ui.escapeHtml(w)}</option>`).join("")
      : `<option value="">no data</option>`;

    state.week = recentFirst[0] || null;
    await loadWeek();
  }

  async function loadWeek() {
    if (!state.store || !state.week) {
      state.rawData = [];
      recompute();
      renderPage();
      setStatus("no data");
      return;
    }

    setStatus("loading…");
    const doc = await call("get_week", { store: state.store, weekKey: state.week });
    state.rawData = doc?.rawData || [];
    state.adherence = {};
    recompute();
    renderPage();
    setStatus(`${state.associates.length} associates`);

    loadAdherence();   // background; re-renders when it lands
  }

  /**
   * Show one associate's report and load their historical task patterns.
   *
   * The 30-day assignment window is fetched once and reused for every
   * associate — it is the same set of documents each time, and re-fetching per
   * click would be 30 reads per name the user tries.
   */
  async function selectAssociate(name) {
    state.ui = { ...state.ui, assocSelected: name, assocSearch: name };
    state.patterns = null;
    renderPage();

    if (!state.store) return;
    if (!state.recentAssignments) {
      state.recentAssignments = (await call("recent_assignments", { store: state.store })) || [];
    }
    state.patterns = taskPatterns(state.recentAssignments, name);
    renderPage();
  }

  // ── Assignments ──────────────────────────────────────────────────────────
  function countSuggestions() {
    return Object.values(state.suggestions)
      .reduce((n, slots) => n + Object.keys(slots || {}).length, 0);
  }

  async function loadAssignments() {
    if (!state.store || !state.assignmentDate) return;

    setStatus("loading assignments…");
    const [doc, suggestions, schedule] = await Promise.all([
      call("get_assignments", { store: state.store, date: state.assignmentDate }),
      call("get_suggestions", { store: state.store, date: state.assignmentDate }),
      call("get_schedule",    { store: state.store, date: state.assignmentDate }),
    ]);

    // A day with no assignments yet starts from the imported schedule, so the
    // grid opens with the right people and their shift windows already marked
    // rather than empty.
    state.assignments = doc?.associates?.length
      ? mergeShifts(doc.associates, schedule?.associates)
      : rosterFromSchedule(schedule);
    state.locked      = isFinalized(doc || { date: state.assignmentDate });
    // Suggestions for cells that are already filled are noise; drop them here
    // rather than making every consumer re-check.
    state.suggestions = pruneSuggestions(suggestions || {});
    state.saveStatus  = "";
    renderPage();
    setStatus("ready");
  }

  /** Schedule rows → blank grid rows, ordered by shift start. */
  function rosterFromSchedule(schedule) {
    const list = schedule?.associates;
    if (!Array.isArray(list)) return [];

    return [...list]
      .sort((a, b) => (a.startSlot ?? 99) - (b.startSlot ?? 99) || a.name.localeCompare(b.name))
      .map((a) => ({
        name:       a.name,
        slots:      {},
        status:     null,
        shiftStart: a.startSlot ?? null,
        shiftEnd:   a.endSlot ?? null,
        shiftLabel: a.shiftStart && a.shiftEnd ? `${a.shiftStart}-${a.shiftEnd}` : null,
      }));
  }

  /**
   * Refresh shift windows on an existing grid from the schedule.
   *
   * Saved assignments keep their tasks, but shift times change after the grid
   * is first built — someone picks up a later start — and a stale window makes
   * adherence measure against hours the associate was never scheduled for.
   */
  function mergeShifts(assignments, scheduleAssociates) {
    if (!Array.isArray(scheduleAssociates)) return assignments;
    const byName = new Map(scheduleAssociates.map((a) => [a.name, a]));

    return assignments.map((a) => {
      const s = byName.get(a.name);
      if (!s) return a;
      return {
        ...a,
        shiftStart: s.startSlot ?? a.shiftStart,
        shiftEnd:   s.endSlot ?? a.shiftEnd,
        shiftLabel: s.shiftStart && s.shiftEnd ? `${s.shiftStart}-${s.shiftEnd}` : a.shiftLabel,
      };
    });
  }

  function pruneSuggestions(raw) {
    const byName = new Map(state.assignments.map((a) => [a.name, a]));
    const out = {};
    for (const [name, slots] of Object.entries(raw)) {
      const assoc = byName.get(name);
      if (!assoc) continue;
      const keep = Object.fromEntries(
        Object.entries(slots || {}).filter(([slot]) => !assoc.slots?.[slot]));
      if (Object.keys(keep).length) out[name] = keep;
    }
    return out;
  }

  async function setAssignmentDate(date) {
    state.assignmentDate = date;
    await loadAssignments();
  }

  function mutateAssociate(name, fn) {
    state.assignments = state.assignments.map((a) => (a.name === name ? fn({ ...a }) : a));
    scheduleSave();
    renderPage();
  }

  function setTask(name, slot, task) {
    mutateAssociate(name, (a) => {
      a.slots = { ...a.slots };
      if (task) a.slots[slot] = task;
      else      delete a.slots[slot];
      return a;
    });
    // A cell the user has now decided on should not keep offering advice.
    const slots = state.suggestions[name];
    if (slots?.[slot]) {
      const rest = { ...slots };
      delete rest[slot];
      state.suggestions = { ...state.suggestions, [name]: rest };
    }
  }

  function toggleStatus(name, status) {
    mutateAssociate(name, (a) => ({ ...a, status: a.status === status ? null : status }));
  }

  function addAssociate(assoc) {
    if (state.assignments.some((a) => a.name === assoc.name)) {
      host.ui.toast(`${assoc.name} is already on this day.`, { kind: "error" });
      return;
    }
    state.assignments = [...state.assignments, assoc];
    scheduleSave();
    renderPage();
  }

  function acceptAllSuggestions() {
    state.assignments = state.assignments.map((a) => {
      const slots = state.suggestions[a.name];
      if (!slots) return a;
      const merged = { ...a.slots };
      for (const [slot, s] of Object.entries(slots)) {
        if (!merged[slot]) merged[slot] = s.task;
      }
      return { ...a, slots: merged };
    });
    state.suggestions = {};
    scheduleSave();
    renderPage();
  }

  async function setFinalized(finalized) {
    state.locked = finalized;
    renderPage();
    await saveAssignments({ finalized });
  }

  // Autosave. The delay is deliberately long: the grid is filled in bursts,
  // and a short debounce would write on every keystroke.
  let saveTimer = null;
  function scheduleSave() {
    if (state.locked) return;
    clearTimeout(saveTimer);
    state.saveStatus = "unsaved";
    saveTimer = setTimeout(saveAssignments, assignmentsPage.AUTOSAVE_DELAY_MS);
  }

  async function saveAssignments(extra = {}) {
    clearTimeout(saveTimer);
    if (!state.store || !state.assignmentDate) return;

    state.saveStatus = "saving…";
    renderPage();

    const ok = await call("put_assignments", {
      store: state.store,
      date:  state.assignmentDate,
      doc: {
        associates:  state.assignments,
        date:        state.assignmentDate,
        day:         dayName(state.assignmentDate),
        updatedAt:   new Date().toISOString(),
        store:       state.store,
        finalized:   state.locked,
        finalizedAt: state.locked ? new Date().toISOString() : null,
        ...extra,
      },
    });

    state.saveStatus = ok ? "saved" : "save failed";
    renderPage();
  }

  async function setClassification(name, classification) {
    state.classifications = { ...state.classifications, [name]: classification };
    recompute();
    renderPage();
    setStatus("saving…");
    const ok = await call("put_classifications", { map: state.classifications });
    setStatus(ok ? "saved" : "save failed");
  }

  // ── Imports ──────────────────────────────────────────────────────────────
  // Parsing happens here, in the page, and only the parsed records are sent to
  // the service worker — see service.js::import_metrics for why.

  async function bytesOf(file) {
    return new Uint8Array(await file.arrayBuffer());
  }

  async function uploadMetrics(file) {
    if (!file) return;
    setStatus(`reading ${file.name}…`);

    const parsed = await parseWorkbook(await bytesOf(file));
    if (!parsed.ok) {
      setStatus("import failed");
      host.ui.toast(parsed.reason, { kind: "error" });
      return;
    }

    setStatus(`importing ${parsed.records.length} rows…`);
    const result = await call("import_metrics", {
      records: parsed.records, fileName: file.name,
    });
    if (!result) return;

    const weeksWritten = result.written.length;
    const stores = [...new Set(result.written.map((w) => w.store))];
    host.ui.toast(
      `Imported ${weeksWritten} week${weeksWritten === 1 ? "" : "s"} across ` +
      `${stores.length} store${stores.length === 1 ? "" : "s"}` +
      (result.skippedRows ? ` (${result.skippedRows} rows skipped)` : ""));

    await loadStores();
  }

  async function uploadDailyBoard(file) {
    if (!file) return;
    if (!state.store) {
      host.ui.toast("Select a store first.", { kind: "error" });
      return;
    }

    setStatus(`reading ${file.name}…`);
    const parsed = await parseDailyBoard(await bytesOf(file));
    if (!parsed.ok) {
      setStatus("import failed");
      host.ui.toast(parsed.reason, { kind: "error" });
      return;
    }

    const result = await call("import_daily_board", { store: state.store, days: parsed.days });
    if (!result) return;

    host.ui.toast(`Imported ${result.written.length} days into store ${state.store}.`);
    setStatus("ready");
    if (state.page === "assignments") await loadAssignments();
  }

  /**
   * Import a week of schedules from the scraper's clipboard export.
   *
   * Uses a modal rather than reading the clipboard directly: clipboard-read
   * permission prompts are confusing here, and the paste box also lets someone
   * see and correct what they are about to import.
   */
  async function importSchedule() {
    if (!state.store) {
      host.ui.toast("Select a store on the Dashboard first.", { kind: "error" });
      return;
    }

    const text = prompt(
      `Paste the schedule export for store ${state.store}.\n\n` +
      `Copy it from the extension's schedule scrape.`);
    if (!text) return;

    const parsed = parseSchedulePayload(text);
    if (!parsed.ok) {
      host.ui.toast(parsed.reason, { kind: "error" });
      return;
    }

    // A paste from the wrong store would write another store's roster into
    // this one, which is very hard to notice afterwards.
    if (parsed.store && parsed.store !== state.store) {
      const proceed = confirm(
        `That export is for store ${parsed.store}, but store ${state.store} is selected.\n\n` +
        `Import it into ${state.store} anyway?`);
      if (!proceed) return;
    }

    setStatus("importing schedules…");
    const result = await call("import_schedules", {
      store: state.store, schedules: parsed.schedules,
    });
    if (!result) return;

    for (const w of parsed.warnings || []) host.ui.toast(w, { kind: "error" });
    host.ui.toast(
      `Imported ${result.written.length} days (${parsed.associateCount} shifts) ` +
      `into store ${state.store}.`);

    setStatus("ready");
    if (state.page === "assignments") await loadAssignments();
  }

  // ── Wiring ───────────────────────────────────────────────────────────────
  const offTabs = host.ui.delegate(container, ".dm-tab", "click", (_e, el) => {
    selectPage(el.dataset.dmPage);
  });

  const onStore = async (e) => {
    state.store = e.target.value;
    // Assignment cache and any open associate report belong to the old store.
    state.recentAssignments = null;
    state.patterns = null;
    state.ui = { ...state.ui, assocSelected: null, assocSearch: "" };
    await loadWeeks();
  };
  const onWeek  = async (e) => { state.week  = e.target.value; await loadWeek(); };
  $("#dm-store")?.addEventListener("change", onStore);
  $("#dm-week")?.addEventListener("change", onWeek);

  // Reset the input's value after each pick so choosing the same file twice
  // still fires a change event.
  const onMetricsFile = async (e) => { await uploadMetrics(e.target.files?.[0]); e.target.value = ""; };
  const onBoardFile   = async (e) => { await uploadDailyBoard(e.target.files?.[0]); e.target.value = ""; };
  $("#dm-upload-metrics")?.addEventListener("change", onMetricsFile);
  $("#dm-upload-board")?.addEventListener("change", onBoardFile);

  selectPage("dashboard");
  loadStores();

  // MODULE_CONTRACT §5: the shell unmounts but does not GC listeners.
  return () => {
    // A pending autosave would otherwise be lost when the user navigates away
    // mid-edit.
    if (state.saveStatus === "unsaved") saveAssignments();
    disposePage?.();
    offTabs?.();
    $("#dm-store")?.removeEventListener("change", onStore);
    $("#dm-week")?.removeEventListener("change", onWeek);
    $("#dm-upload-metrics")?.removeEventListener("change", onMetricsFile);
    $("#dm-upload-board")?.removeEventListener("change", onBoardFile);
  };
}
