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
import { leadershipForJob, byLeadershipFirst } from "./lib/data/job_classify.js";
import { weekLabel } from "./lib/data/wmweek.js";

const PAGES = {
  dashboard,
  insights,
  // Retired as a tab 2026-08-25 (see view.html) but kept registered: the page
  // still renders correctly, so restoring it is one line of markup rather than
  // a re-port. Unreachable until a .dm-tab points at it.
  classify:      classifyPage,
  comparison,
  opportunities,
  leaderboard,
  associates:    associatesPage,
  assignments:   assignmentsPage,
  faq,
};

export async function mount(host, container) {
  // ── Inject the module stylesheet, and WAIT for it ──────────────────────
  //
  // The shell loads styles/{tokens,base,layout,components}.css and nothing
  // else — each module links its own sheet from here (same as
  // digitalrollup/view.js and vizpick/view.js). The port omitted this
  // entirely, so every rule in styles.css was dead: tabs rendered as default
  // browser buttons, the stat grid laid out as stacked block text, and the
  // module looked unstyled because it WAS unstyled.
  //
  // Awaiting matters as much as adding: without it the first render happens
  // before the sheet applies, and the grid lays out with default block rules
  // until something forces a reflow.
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = host.url("styles.css");
  link.dataset.module = host.id;
  const cssReady = new Promise((resolve) => {
    if (link.sheet) return resolve();
    link.addEventListener("load", resolve, { once: true });
    // Render unstyled rather than not at all.
    link.addEventListener("error", resolve, { once: true });
    setTimeout(resolve, 3000);
  });
  document.head.appendChild(link);
  await cssReady;

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
    homeStore:   null,
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
  // host.messaging.send REJECTS on a non-ok response (shared/messaging.js), so
  // this has to catch as well as check — an uncaught rejection here shows up in
  // the console as a bare "digitalmetrics.<type> failed" with the real reason
  // nowhere in sight, which is exactly what it did.
  // The reason the LAST call failed. call() returns null on failure, which is
  // convenient at the call site but throws the reason away — and "save failed"
  // with the reason discarded is a dead end for whoever has to fix it. Kept
  // here so a caller can surface it without every caller having to unwrap the
  // envelope itself.
  let lastCallError = null;

  async function call(type, payload = {}) {
    let res;
    lastCallError = null;
    try {
      res = await host.messaging.send(type, payload);
    } catch (e) {
      const message = String(e?.message ?? e);
      lastCallError = message;
      setStatus(`error: ${message}`);
      host.ui.toast(`${type}: ${message}`, { kind: "error" });
      return null;
    }
    if (!res?.ok) {
      lastCallError = res?.error || "unknown";
      setStatus(`error: ${lastCallError}`);
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
      onSetTasks:      setTasks,
      onSetStatus:     toggleStatus,
      onAddAssociate:  addAssociate,
      onFinalize:      setFinalized,
      onAcceptAll:     acceptAllSuggestions,
      onDismissAll:    () => { state.suggestions = {}; renderPage(); },
      onPrint:         () => window.print(),
    };

    // ── Remember which cell had focus ──────────────────────────────────
    //
    // Every render replaces innerHTML, which destroys the focused element.
    // On the Assignments grid that made hotkeys look broken: the first
    // keypress set a task, the re-render dropped focus to <body>, and every
    // press after that went nowhere. A spreadsheet has to keep the cursor
    // where you left it.
    const active = document.activeElement;
    const keep = active && el.contains(active) && active.dataset?.dmRow !== undefined
      ? { row: active.dataset.dmRow, slot: active.dataset.dmSlot }
      : null;

    // ── Remember where every scroll container was ──────────────────────
    //
    // Replacing innerHTML destroys the scrolling elements too, and a fresh
    // one starts at 0,0. On the Assignments grid that made the view jump to
    // the top-left on every keystroke: you would type a task and lose your
    // place. Containers opt in with data-dm-scroll="<key>".
    const scrolls = [];
    for (const node of el.querySelectorAll("[data-dm-scroll]")) {
      scrolls.push({ key: node.dataset.dmScroll, top: node.scrollTop, left: node.scrollLeft });
    }

    // A renderer that throws must NOT leave the previous tab's markup sitting
    // there. Without this, `el.innerHTML = page.render(ctx)` never runs on a
    // throw, so five tabs silently displayed the Dashboard's content and
    // looked like they worked.
    try {
      el.innerHTML = page.render(ctx);
    } catch (err) {
      el.innerHTML =
        `<div class="dm-section"><h3 class="dm-section-title">${host.ui.escapeHtml(state.page)} failed to render</h3>` +
        `<p class="muted">${host.ui.escapeHtml(String(err?.message ?? err))}</p></div>`;
      console.error(`[digitalmetrics] ${state.page}.render threw:`, err);
      return;
    }

    try {
      disposePage = page.wire?.(ctx, el) || null;
    } catch (err) {
      console.error(`[digitalmetrics] ${state.page}.wire threw:`, err);
      disposePage = null;
    }

    // Scroll first, then focus — restoring focus into a container that is
    // still at 0,0 is what scrolls the page.
    for (const s of scrolls) {
      const node = el.querySelector(`[data-dm-scroll="${CSS.escape(s.key)}"]`);
      if (!node) continue;
      node.scrollTop = s.top;
      node.scrollLeft = s.left;
    }

    // preventScroll matters on a 17-column grid: without it, restoring focus
    // yanks the viewport back to the cell on every keystroke.
    if (keep) {
      el.querySelector(
        `[data-dm-row="${CSS.escape(keep.row)}"][data-dm-slot="${CSS.escape(keep.slot)}"]`,
      )?.focus({ preventScroll: true });
    }
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
    const list = (await call("list_stores")) || [];

    // Known stores become suggestions, not the only options — the field itself
    // accepts any store number.
    const dl = $("#dm-store-list");
    if (dl) {
      dl.innerHTML = list
        .map((s) => `<option value="${host.ui.escapeHtml(s)}"></option>`).join("");
    }

    state.classifications = (await call("get_classifications")) || {};

    if (list.length) {
      state.store = state.store && list.includes(state.store) ? state.store : list[0];
      $("#dm-store").value = state.store;
      await loadWeeks();
      return;
    }

    // Empty is the FIRST-RUN state, not an error: the database starts empty and
    // stores only appear once data is imported.
    // The Assignments tab is pinned to this and ignores the picker above.
    // Fetched once at mount: it comes from the cached identity, not the
    // network, and it does not change while the tab is open.
    const home = await call("get_home_store");
    state.homeStore = home?.store ? String(home.store) : null;

    const dflt = await call("get_default_store");
    if (dflt?.store) {
      state.store = dflt.store;
      $("#dm-store").value = dflt.store;
      setStatus(`store ${dflt.store} (from your profile) — Sync now to load it`);
    } else {
      setStatus("type a store number, then Sync now");
    }
  }

  /**
   * Switch to whatever store was typed.
   *
   * An unknown store is not an error — it is the way you add one. Register it,
   * then pull it, so typing a number is the whole workflow rather than a
   * separate "Add store" step.
   */
  async function selectStore(raw) {
    const entered = String(raw ?? "").trim();
    if (!entered) return;
    if (!/^\d{1,5}$/.test(entered)) {
      host.ui.toast("A store number is 1–5 digits.", { kind: "error" });
      return;
    }
    const store = String(parseInt(entered, 10));   // no leading zeros
    $("#dm-store").value = store;

    if (store === state.store) return;
    state.store = store;
    // Anything cached belongs to the store we just left.
    state.recentAssignments = null;
    state.patterns = null;
    state.ui = { ...state.ui, assocSelected: null, assocSearch: "" };

    const known = (await call("list_stores")) || [];
    if (!known.includes(store)) {
      setStatus(`adding store ${store}…`);
      const added = await call("add_store", { store });
      if (!added) return;
      setStatus(`pulling store ${store}… this opens a background tab`);
      const pulled = await call("pull_store", { store, force: true });
      if (pulled) {
        host.ui.toast(`Store ${store}: ${(pulled.rows ?? 0).toLocaleString()} rows imported.`);
      }
      await loadStores();
      return;
    }

    await loadWeeks();
  }

  async function loadWeeks() {
    if (!state.store) return;
    setStatus("loading weeks…");

    const weeks = await call("list_weeks", { store: state.store });
    if (!weeks) return;

    // Weeks are stored by their Saturday, but nobody at the store thinks in
    // Saturdays — they think in Walmart fiscal weeks, which is what Tableau's
    // WM_WEEK and the scheduler's "WK 30" both use. Label them that way and
    // keep the date range alongside, since the number alone does not say which
    // days you are looking at. See data/wmweek.js.
    const recentFirst = [...weeks].reverse();
    $("#dm-week").innerHTML = recentFirst.length
      ? recentFirst.map((w) =>
          `<option value="${host.ui.escapeHtml(w)}">${host.ui.escapeHtml(weekLabel(w))}</option>`).join("")
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

    // Names are clickable on every board now, and the breakdown lives on the
    // Associates tab — so selecting someone has to go there. Without this the
    // click set the selection and re-rendered the board you were already on,
    // which looked like nothing happened at all.
    if (state.page !== "associates") selectPage("associates");
    else renderPage();

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

  /**
   * The store the Assignments tab works on.
   *
   * Pinned to the signed-in user's home store, NOT the dashboard picker. A
   * daily plan is per store and shared; someone browsing another store's
   * metrics should not be able to overwrite that store's roster by leaving the
   * picker where they left it.
   *
   * Falls back to the selected store when the home store cannot be derived —
   * no cached identity yet, or a WIN this parser does not recognise. Locking
   * someone out of their own roster is a worse failure than the one the lock
   * prevents.
   */
  function assignmentStore() {
    return state.homeStore || state.store;
  }

  async function loadAssignments() {
    const store = assignmentStore();
    if (!store || !state.assignmentDate) return;

    setStatus("loading assignments…");
    const [doc, suggestions, schedule] = await Promise.all([
      call("get_assignments", { store, date: state.assignmentDate }),
      call("get_suggestions", { store, date: state.assignmentDate }),
      call("get_schedule",    { store, date: state.assignmentDate }),
    ]);

    // A day with no assignments yet starts from the imported schedule, so the
    // grid opens with the right people and their shift windows already marked
    // rather than empty.
    state.assignments = doc?.associates?.length
      ? digitalTeamOnly(mergeShifts(doc.associates, schedule?.associates))
      : rosterFromSchedule(schedule);

    // An empty grid is ambiguous — no schedule pulled, or a genuinely empty
    // day? The Workforce Planning pull only captures the week the scheduler
    // page happens to be showing, so picking a date outside it silently
    // produced a blank grid. Fetch what IS covered so the empty state can say
    // which dates exist instead of leaving you to guess.
    //
    // Only on the empty path: this is a collection listing, and there is no
    // reason to pay for it on the normal one.
    state.scheduleDates = state.assignments.length
      ? null
      : (await call("list_dates", { store, collection: "schedules" })) || [];
    state.locked      = isFinalized(doc || { date: state.assignmentDate });
    // Suggestions for cells that are already filled are noise; drop them here
    // rather than making every consumer re-check.
    state.suggestions = pruneSuggestions(suggestions || {});
    state.saveStatus  = "";
    renderPage();
    setStatus("ready");
  }

  /**
   * Is this person on the digital team?
   *
   * The scheduler hands back the WHOLE store roster — 232 people on a weekday
   * at store 1458 — and a task grid listing every stocker and cashier is
   * unusable. Classification is derived automatically now
   * (lib/data/job_classify.js), so the grid can filter to the people it is
   * actually for.
   *
   * Exceptions counts as digital: those ARE digital associates, just working
   * exception picks. Store Help is excluded but still reachable through
   * "Add associate" on the days someone helps out.
   */
  function isDigitalTeam(name) {
    const c = state.classifications[String(name || "").toUpperCase()]
           ?? state.classifications[name];
    return c === "Digital" || c === "Exceptions";
  }

  /**
   * Narrow a grid roster to the digital team, keeping anyone already working.
   *
   * Applied to SAVED days too, not just freshly-built ones. Days written
   * before the filter existed hold the whole 232-person store roster, and
   * leaving them unfiltered would mean the grid stayed unusable for exactly
   * the dates someone had already opened.
   *
   * The "already working" exemption is what makes that safe: a Store Help
   * associate added by hand, or given a task, keeps their row. Only untouched
   * non-digital rows are dropped.
   */
  function digitalTeamOnly(list) {
    if (!Array.isArray(list)) return [];
    if (!Object.keys(state.classifications).length) return list;
    return list.filter((a) =>
      isDigitalTeam(a.name) ||
      Object.keys(a.slots || {}).length > 0 ||
      a.status);
  }

  /** Schedule rows → blank grid rows, ordered by shift start. */
  function rosterFromSchedule(schedule) {
    const list = schedule?.associates;
    if (!Array.isArray(list)) return [];

    // Before the first sync there are no classifications, and filtering on
    // them would produce an empty grid — which reads as "broken", not as "not
    // synced yet". Show everyone until we actually know who is who.
    const known = Object.keys(state.classifications).length > 0;
    const roster = known ? list.filter((a) => isDigitalTeam(a.name)) : list;

    return [...roster]
      .map((a) => ({
        name:       a.name,
        slots:      {},
        status:     null,
        shiftStart: a.startSlot ?? null,
        shiftEnd:   a.endSlot ?? null,
        shiftLabel: a.shiftStart && a.shiftEnd ? `${a.shiftStart}-${a.shiftEnd}` : null,
        // Straight off the scheduler's job title: "Digital TL", "Digital Coach".
        role:       leadershipForJob(a.jobName),
      }))
      // Leadership first; everyone else keeps the shift-start order the
      // board is read in.
      .sort((a, b) => byLeadershipFirst(a, b)
        || (a.shiftStart ?? 99) - (b.shiftStart ?? 99)
        || a.name.localeCompare(b.name));
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
        // Re-derived from the schedule on every load, so a promotion shows
        // up without anyone having to re-save the day. Falls back to the
        // stored role when the title is missing.
        role:       leadershipForJob(s.jobName) ?? a.role ?? null,
        shiftStart: s.startSlot ?? a.shiftStart,
        shiftEnd:   s.endSlot ?? a.shiftEnd,
        shiftLabel: s.shiftStart && s.shiftEnd ? `${s.shiftStart}-${s.shiftEnd}` : a.shiftLabel,
      };
    })
    // A SAVED day is stored in its old order, so the pin has to be
    // reapplied on load rather than only when the roster is first built.
    .sort((a, b) => byLeadershipFirst(a, b));
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

  /**
   * Set many cells in ONE state change.
   *
   * Looping setTask() re-rendered per cell — a 30-cell paste meant 30 full
   * innerHTML swaps, each fighting the focus and scroll restore. This applies
   * the whole block, then renders once.
   */
  function setTasks(updates) {
    if (!updates?.length) return;

    const bySlotByName = new Map();
    for (const u of updates) {
      if (!bySlotByName.has(u.name)) bySlotByName.set(u.name, []);
      bySlotByName.get(u.name).push(u);
    }

    state.assignments = state.assignments.map((a) => {
      const mine = bySlotByName.get(a.name);
      if (!mine) return a;
      const slots = { ...a.slots };
      for (const u of mine) {
        if (u.task) slots[u.slot] = u.task;
        else        delete slots[u.slot];
      }
      return { ...a, slots };
    });

    // A cell the user has now decided on should not keep offering advice.
    const suggestions = { ...state.suggestions };
    for (const u of updates) {
      const slots = suggestions[u.name];
      if (!slots?.[u.slot]) continue;
      const rest = { ...slots };
      delete rest[u.slot];
      suggestions[u.name] = rest;
    }
    state.suggestions = suggestions;

    scheduleSave();
    renderPage();
    for (const name of bySlotByName.keys()) syncExceptionClassification(name);
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
    syncExceptionClassification(name);
  }

  /**
   * Assigning the EXC task IS how someone becomes an Exceptions associate.
   *
   * `Exceptions` is the one classification a job title cannot express — the
   * scheduler says "Digital Personal Shopper" whether or not that person spends
   * their day on exception picks. With the Classify tab retired, the grid is
   * the natural place to say it: give someone EXC and they are an exceptions
   * associate; take every EXC cell away and they go back to Digital.
   *
   * Only ever moves between Digital and Exceptions. Store Help is left alone —
   * a store associate covering an exception hour has not joined the digital
   * team, and reclassifying them would drag them into every digital benchmark.
   */
  function syncExceptionClassification(name) {
    const row = state.assignments.find((a) => a.name === name);
    if (!row) return;

    const hasExc = Object.values(row.slots || {}).some((t) => t === "EXC");
    const key = String(name).toUpperCase();
    const current = state.classifications[key] ?? state.classifications[name];

    if (hasExc && current === "Digital")          setClassification(name, "Exceptions");
    else if (!hasExc && current === "Exceptions") setClassification(name, "Digital");
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
    const store = assignmentStore();
    if (!store || !state.assignmentDate) return;

    state.saveStatus = "saving…";
    renderPage();

    const ok = await call("put_assignments", {
      store,
      date:  state.assignmentDate,
      doc: {
        associates:  state.assignments,
        date:        state.assignmentDate,
        day:         dayName(state.assignmentDate),
        updatedAt:   new Date().toISOString(),
        store,
        finalized:   state.locked,
        finalizedAt: state.locked ? new Date().toISOString() : null,
        ...extra,
      },
    });

    // "save failed" on its own is a dead end — the reason is the whole point,
    // and it is the difference between a kill switch, an expired token and a
    // rules rejection. It goes on the pill's tooltip and into the console,
    // because a day's assignments silently not persisting is worse than most
    // things this module can do wrong.
    state.saveStatus = ok ? "saved" : "save failed";
    state.saveError  = ok ? null : lastCallError;
    if (!ok) {
      console.error("[digitalmetrics] assignments save failed:", lastCallError,
                    { store: state.store, date: state.assignmentDate });
    }
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
  // Manual .xlsx upload was removed 2026-08-25: metrics and schedules now
  // arrive from the automated pull (Sync now / Auto-sync), which reads the same
  // Tableau worksheet the "Associate By Day" export came from. The parsers
  // themselves are kept — lib/data/xlsx.js and lib/data/daily_board.js still
  // back the import_metrics / import_daily_board handlers, which remain
  // available for a one-off recovery.

  // Schedule import was removed 2026-08-26. It asked you to paste an export
  // from "the extension's schedule scrape" — a scraper that never existed in
  // the suite — and the automated pull now reads the Workforce Planning portal
  // directly (lib/sources/wfm_schedule.js). lib/data/schedule_import.js and
  // the import_schedules handler remain for a one-off recovery.

  // ── Automated pull ───────────────────────────────────────────────────────
  //
  // A pull opens background tabs against Tableau and the scheduler, so it is
  // never silent: the pill reports what happened, including partial success.
  // A run that fetched metrics but not the schedule is a normal outcome, not
  // an error to swallow.

  function setPullStatus(text, { kind = "" } = {}) {
    const el = $("#dm-pull-status");
    if (!el) return;
    el.hidden = !text;
    el.textContent = text || "";
    el.dataset.kind = kind;
  }

  async function refreshPullState() {
    const state = await call("get_pull_state");
    if (!state) return;
    const box = $("#dm-pull-enabled");
    if (box) box.checked = !!state.enabled;
    if (state.running) { setPullStatus("syncing…"); return; }
    if (state.lastRunAt) {
      const mins = Math.round((Date.now() - state.lastRunAt) / 60000);
      const when = mins < 1 ? "just now" : mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
      const failed = state.lastResult?.errors?.length;
      setPullStatus(`synced ${when}${failed ? ` · ${failed} failed` : ""}`,
                    { kind: failed ? "warn" : "ok" });
    } else {
      setPullStatus("never synced");
    }
  }

  async function pullNow() {
    const btn = $("#dm-pull-now");
    const spinner = $("#dm-pull-spinner");
    if (btn) btn.disabled = true;
    if (spinner) spinner.hidden = false;
    setPullStatus("syncing…");
    try {
      const res = await call("pull_now", {});
      if (!res) { setPullStatus("sync failed", { kind: "error" }); return; }

      // The run declined to start (already running / too recent) — not a failure.
      if (res.notRun) {
        setPullStatus(res.notRun);
        host.ui.toast(res.notRun);
        return;
      }

      const rows = (res.metrics || []).reduce((n, m) => n + (m.rows || 0), 0);
      const storesDone = (res.metrics || []).filter((m) => !m.skipped).length;
      const parts = [];
      if (storesDone) parts.push(`${rows.toLocaleString()} rows from ${storesDone} store${storesDone === 1 ? "" : "s"}`);
      if (res.schedule) parts.push(`${res.schedule.shifts} shifts`);
      if (!parts.length) parts.push("already up to date");

      host.ui.toast(`Sync: ${parts.join(", ")}.`);

      // Surface every failure individually — one broken source must not read
      // as a total failure, and a silent partial is worse than either.
      for (const e of res.errors || []) {
        host.ui.toast(`${e.scope}: ${e.error}`, { kind: "error" });
      }
      for (const w of res.schedule?.warnings || []) {
        host.ui.toast(w, { kind: "error" });
      }

      await loadStores();
      if (state.page === "assignments") await loadAssignments();
    } finally {
      if (btn) btn.disabled = false;
      if (spinner) spinner.hidden = true;
      await refreshPullState();
    }
  }

  // ── Wiring ───────────────────────────────────────────────────────────────
  const offTabs = host.ui.delegate(container, "click", ".dm-tab", (_e, el) => {
    selectPage(el.dataset.dmPage);
  });

  // `change` fires on blur and on picking a datalist suggestion; Enter makes
  // typing a store feel immediate rather than requiring a click elsewhere.
  const onStore = (e) => selectStore(e.target.value);
  const onStoreKey = (e) => { if (e.key === "Enter") selectStore(e.target.value); };
  const onWeek  = async (e) => { state.week  = e.target.value; await loadWeek(); };
  $("#dm-store")?.addEventListener("change", onStore);
  $("#dm-store")?.addEventListener("keydown", onStoreKey);
  $("#dm-week")?.addEventListener("change", onWeek);

  const onPullClick = () => pullNow();
  const onPullToggle = async (e) => {
    await call("set_pull_enabled", { enabled: e.target.checked });
    await refreshPullState();
  };
  $("#dm-pull-now")?.addEventListener("click", onPullClick);
  $("#dm-pull-enabled")?.addEventListener("change", onPullToggle);

  selectPage("dashboard");
  loadStores();
  refreshPullState();

  // MODULE_CONTRACT §5: the shell unmounts but does not GC listeners.
  return () => {
    // A pending autosave would otherwise be lost when the user navigates away
    // mid-edit.
    if (state.saveStatus === "unsaved") saveAssignments();
    disposePage?.();
    offTabs?.();
    $("#dm-store")?.removeEventListener("change", onStore);
    $("#dm-store")?.removeEventListener("keydown", onStoreKey);
    $("#dm-week")?.removeEventListener("change", onWeek);
    link.remove();
    $("#dm-pull-now")?.removeEventListener("click", onPullClick);
    $("#dm-pull-enabled")?.removeEventListener("change", onPullToggle);
  };
}
