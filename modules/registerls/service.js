// modules/registerls/service.js
//
// Service-worker handlers for Register L/S Triage.
//
//   refresh_queue      pull the WorkView long/short queue for the store
//   refresh_grid       re-capture the Power BI grid via the Live Dashboard
//                      register engine and run offset matching
//   analyze_item       Cash Research ledger + EJ receipts for one item, then
//                      the verdict/evidence bundle (cached per work item)
//   get_state          everything the view paints, with grid-only pre-verdicts
//   set_store_override / clear_cache
//
// Storage: raw chrome.storage.local, keys prefixed "registerls." (service.js
// has no host object — MODULE_CONTRACT.md §4).

import { getUserHomeStore } from "../../shared/userStore.js";
import { keepAwake } from "../../shared/sw_keepalive.js";
import { fetchRegister, runMatching, rollup } from "../livedashboard/lib/sources/register.js";
import { fetchWorkItems, LIST_PAGE_URL } from "./lib/workview.js";
import { fetchCashLedger } from "./lib/cash_research.js";
import { fetchReceipts, openEjSession, EJ_HOME } from "./lib/ej.js";
import { parseRecords } from "./lib/ej_parse.js";
import { buildEvidence, DEFAULT_CFG, findFindingFor, findDiscrepancyFor, findCounterpartFinding, unionDiscrepancies } from "./lib/evidence.js";
import { MATCH_OPTS } from "./lib/match_opts.js";
import { tieredMatching, comboOffsets, findComboFor } from "./lib/matching.js";
import { recurringOperators } from "./lib/recurrence.js";
import { prefillDisposition, completeDisposition } from "./lib/dispo.js";
import { normalizeCause } from "./lib/cause.js";
import { fetchCashRecycler } from "./lib/cash_recycler.js";
import { fetchOpenDrawer } from "./lib/open_drawer.js";
import { fetchCft, cftFor } from "./lib/cft.js";
import { parsePantryText, mergePantry } from "./lib/pantry.js";
import { tillsFor, wrongRegisterMoves, mergeDatedRows } from "./lib/till_events.js";
import { buildLedger, pantryEvents, pantryKey, cashierCsv, safeFileName, eventKey, aggregateEvents, ERROR_TYPES } from "./lib/cashiers.js";
import { buildRegisterMap, wideRegistersOf, ROLES, isRole } from "./lib/registers.js";

const TAG = "[registerls]";
const KEYS = {
  queue:  "registerls.queue",
  grid:   "registerls.grid",
  store:  "registerls.storeOverride",
  tills:  "registerls.tills",
  cft:    "registerls.cft",
  coaching: (id) => `registerls.coaching.${id}`,
  completed: "registerls.completed",
  ledger: "registerls.ledger",   // permanent: every attributed cashier event ever seen
  analysis: (id) => `registerls.analysis.${id}`,
  cause: (id) => `registerls.cause.${id}`,   // the analyst's "this transaction was the cause" (record, survives re-analysis and clears)
  pantry: (storeNbr) => `registerls.pantry.${storeNbr}`,   // the analyst's own pantry UPCs for the store (record)
  registers: (storeNbr) => `registerls.registers.${storeNbr}`,   // { roles: { [register]: role } } — the analyst's register-type overrides (record)
};
// WorkView keeps open items for months; two years is "everything open".
const QUEUE_DAYS = 730;
// Power BI grid width. WorkView items can lag the L/S by 11 days and the
// queue reaches back 30, so 60 days covers every item with headroom; the
// report's source keeps about that much anyway.
const GRID_DAYS = 60;
const TILL_DAYS = 60;   // the Cash Recycler report retains ~60 days: asking for 90 still returned 07-16 → 09-13 on 2026-09-14
const CFT_DAYS = 60;
// Items analyzed in parallel by analyze_all (APPRISS searchlite + EJ calls are light; 3 keeps the servers polite).
const ANALYZE_CONCURRENCY = 3;
// Bump when the evidence shape changes so cached analyses are re-run.
const ANALYSIS_SCHEMA = 12;  // 12: one overage closes one shortage (contested pairs, ties, filed pairs locked)
const POWERBI_REPORT_URL = "https://app.powerbi.com/groups/me/reports/65c97d6a-7ad8-498d-b752-69028d408993/ReportSection?ctid=3cbcc3d3-094d-4006-9849-0d11d61f484d&experience=power-bi";

function broadcast(type, payload) {
  chrome.runtime.sendMessage({ module: "registerls", type, payload }).catch(() => {});
}
async function get(key)        { return (await chrome.storage.local.get(key))[key]; }
async function set(key, value) { return chrome.storage.local.set({ [key]: value }); }

async function resolveStore(msg = {}) {
  const explicit = String(msg.storeNbr || "").trim();
  if (explicit) return { storeNbr: explicit, source: "request" };
  const override = String((await get(KEYS.store)) || "").trim();
  if (override) return { storeNbr: override, source: "override" };
  const home = await getUserHomeStore().catch(() => null);
  if (home) return { storeNbr: String(home), source: "profile" };
  return { storeNbr: null, source: "none" };
}

// Matching over BOTH sources: Power BI cells (with operator shifts, ~60 days)
// and the WorkView items themselves (further back). Cheap enough to run on
// every get_state; the grid's own findings are not used directly.
// `completed` (the registerls.completed log) supplies the pairs the analyst
// already filed: each becomes a locked pair, and a filed half that no source
// still carries is put back as a discrepancy so its overage stays claimed —
// otherwise a later pull would offer that overage to another shortage.
function matchingFor(grid, queue, storeNbr, completed = [], wideRegisters = null) {
  const gridDisc = grid && grid.storeNbr === String(storeNbr) ? grid.discrepancies : [];
  const discrepancies = unionDiscrepancies(gridDisc, queue?.items || [], storeNbr);
  const locked = [];
  const have = new Set(discrepancies.map((d) => `${d.registerNbr}|${d.date}`));
  for (const c of completed || []) {
    if (!c.counterpart?.register || !c.register || !c.date || c.amountCents == null || c.amountCents === 0) continue;
    if (String(c.store || storeNbr) !== String(storeNbr)) continue;
    for (const side of [{ register: c.register, date: c.date, amountCents: c.amountCents }, c.counterpart]) {
      if (side.amountCents == null || have.has(`${side.register}|${side.date}`)) continue;
      have.add(`${side.register}|${side.date}`);
      discrepancies.push({ storeNbr: String(storeNbr), date: side.date, registerNbr: String(side.register), amountCents: side.amountCents, type: side.amountCents < 0 ? "short" : "over", amountAbsCents: Math.abs(side.amountCents), operators: [], _source: { module: "registerls", sourceMethod: "completed-item", workItemId: c.id } });
    }
    const mine = { register: String(c.register), date: c.date }, theirs = { register: String(c.counterpart.register), date: c.counterpart.date };
    locked.push(c.amountCents < 0 ? { short: mine, over: theirs } : { short: theirs, over: mine });
  }
  const findings = discrepancies.length ? tieredMatching(discrepancies, undefined, { locked, wideRegisters }) : [];   // filed pairs first, then exact pairs, near-misses only for what is left
  const combos = findings.length ? comboOffsets(discrepancies, findings) : [];   // large leftovers explained by 2–3 entries store-wide (review only)
  // What the Power BI grid actually covers: an item older than gridMin can
  // only be matched against other OPEN WorkView items, never against a
  // closed or never-opened overage — so no "unmatched" claim is honest there.
  const coverage = gridDisc.length ? { gridMin: grid.dateMin || null, gridMax: grid.dateMax || null } : { gridMin: null, gridMax: null };
  return { discrepancies, findings, combos, coverage, gridCapturedAt: grid?.capturedAt || null };
}

// The store's register map — till-log labels, number-range defaults and
// the analyst's overrides (lib/registers.js) — and what matching/evidence
// take from it: which registers pair store-wide (the service desk).
async function roleContext(storeNbr, { tillRows = null, grid = null, queue = null } = {}) {
  const store = String(storeNbr || "");
  let rows = tillRows;
  if (rows == null) { const t = await get(KEYS.tills); rows = t && t.storeNbr === store ? t.rows : []; }
  const g = grid === null ? await get(KEYS.grid) : grid;
  const q = queue === null ? await get(KEYS.queue) : queue;
  const registers = [
    ...(g && g.storeNbr === store ? (g.discrepancies || []).map((d) => d.registerNbr) : []),
    ...((q?.items || []).map((i) => i.register)),
  ].filter(Boolean);
  const overrides = (await get(KEYS.registers(store)))?.roles || {};
  const map = buildRegisterMap({ tillRows: rows || [], registers, overrides });
  const wide = wideRegistersOf(map);
  return { map, wide, cfg: { ...DEFAULT_CFG, wideRegisters: wide } };
}

function lookups(match, item) {
  const isOver = (item.amountCents ?? 0) > 0;
  const finding = findFindingFor(match.findings, item) || (isOver ? findCounterpartFinding(match.findings, item) : null);
  const discrepancy = findDiscrepancyFor(match.discrepancies, item);
  const combo = findComboFor(match.combos, item);
  // The other register-day of the pair, for "who checked the tills in".
  let counterpart = null;
  if (finding && finding.matchType !== "none") {
    counterpart = isOver ? { register: String(finding.primaryRegister), date: finding.primaryDate } : (finding.matchedAgainst?.[0] ? { register: String(finding.matchedAgainst[0].registerNbr), date: finding.matchedAgainst[0].date } : null);
  }
  return { finding, discrepancy, counterpart, combo };
}

// Offset-only verdict for the queue list (no network). Same function the
// full analysis uses, so a row's pill never disagrees with its detail.
function preVerdict(item, match, tillRows = null, cfg = DEFAULT_CFG) {
  if (!match.discrepancies.length) return { verdict: "pending", verdictLabel: "no data yet", severity: "none" };
  const { finding, discrepancy, counterpart, combo } = lookups(match, item);
  const tills = tillRows ? tillsFor(tillRows, item, match.discrepancies, undefined, counterpart) : null;
  const ev = buildEvidence({ item, finding, discrepancy, tills, combo, coverage: match.coverage, cfg });
  return {
    verdict: ev.verdict, verdictLabel: ev.verdictLabel, severity: ev.severity, flipConfidence: ev.flipConfidence, matchedAgainst: ev.matchedAgainst,
    counterpart: finding && (item.amountCents ?? 0) > 0 ? { registerNbr: finding.primaryRegister, date: finding.primaryDate, amountCents: finding.primaryAmountCents } : null,
    why: ev.why, combo: ev.comboShort || null, gridAmountCents: ev.gridAmountCents ?? null, contested: ev.contested || null, tie: ev.tie || false, locked: ev.locked || false,
    // A clean pair needs no journal pull to be filed — carry the suggestion.
    suggestion: ev.suggestion && ev.suggestion.safe ? ev.suggestion : null,
  };
}

const SAFE = new Set(["flip", "bounceback"]);

export const handlers = {
  async get_state(msg = {}) {
    const store = await resolveStore(msg);
    const [queue, grid, tillsCache, cftCache, completedLog] = await Promise.all([get(KEYS.queue), get(KEYS.grid), get(KEYS.tills), get(KEYS.cft), get(KEYS.completed)]);
    const items = queue?.items || [];
    const gridForStore = grid && grid.storeNbr === store.storeNbr ? grid : null;
    const tillRows = tillsCache && tillsCache.storeNbr === store.storeNbr ? tillsCache.rows : null;
    const roles = await roleContext(store.storeNbr, { tillRows: tillRows || [], grid, queue });
    const match = matchingFor(grid, queue, store.storeNbr, completedLog || [], roles.wide);
    const analyses = {};
    const analysisOps = {};   // EJ/Power BI operator timelines from cached analyses, for the recurrence pass
    const causes = {};
    if (items.length) {
      const gotCause = await chrome.storage.local.get(items.map((i) => KEYS.cause(i.id)));
      for (const i of items) if (gotCause[KEYS.cause(i.id)]) causes[i.id] = gotCause[KEYS.cause(i.id)];
      const got = await chrome.storage.local.get(items.map((i) => KEYS.analysis(i.id)));
      for (const i of items) {
        const a = got[KEYS.analysis(i.id)];
        if (a && a.schema === ANALYSIS_SCHEMA) analysisOps[i.id] = { operators: a.evidence?.operators || [] };
        if (a && a.schema === ANALYSIS_SCHEMA) analyses[i.id] = { at: a.at, verdict: a.evidence?.verdict, verdictLabel: a.evidence?.verdictLabel, severity: a.evidence?.severity, hasVideo: !!a.evidence?.videoCandidates?.length, stale: !!(gridForStore && a.gridCapturedAt !== gridForStore.capturedAt) };
      }
    }
    const pres = {};
    for (const i of items) pres[i.id] = preVerdict(i, match, tillRows, roles.cfg);
    // Who keeps turning up on shortages nobody can explain (store-wide, live).
    const recurring = recurringOperators({ items, verdicts: pres, discrepancies: match.discrepancies, tillRows: tillRows || [], analyses: analysisOps });
    return {
      store,
      recurring,
      registers: roles.map,
      queue: queue ? { fetchedAt: queue.fetchedAt, storeNbr: queue.storeNbr, otherCount: queue.otherCount, total: queue.total, totals: queue.totals || null, window: queue.window, items: items.map((i) => ({ ...i, pre: pres[i.id] })), others: queue.others || [] } : null,
      grid: gridForStore ? { capturedAt: gridForStore.capturedAt, storeNbr: gridForStore.storeNbr, cellCount: gridForStore.discrepancies?.length || 0, rollup: gridForStore.rollup, dateMin: gridForStore.dateMin || null, dateMax: gridForStore.dateMax || null } : (grid ? { staleStore: grid.storeNbr } : null),
      analyses,
      causes,
      tills: tillRows ? { fetchedAt: tillsCache.fetchedAt, rows: tillRows.length, dateMin: tillsCache.dateMin, dateMax: tillsCache.dateMax, reportUrl: tillsCache.reportUrl, moves: wrongRegisterMoves(tillRows).slice(0, 60) } : null,
      cft: cftCache && cftCache.storeNbr === store.storeNbr ? { fetchedAt: cftCache.fetchedAt, rows: cftCache.rows.length, dateMin: cftCache.dateMin, dateMax: cftCache.dateMax, reportUrl: cftCache.reportUrl } : null,
      links: {
        workview: store.storeNbr ? LIST_PAGE_URL(store.storeNbr, isoDaysAgo(QUEUE_DAYS), isoDaysAgo(0)) : null,
        powerbi: POWERBI_REPORT_URL,
        ej: EJ_HOME,
      },
    };
  },

  async set_store_override(msg = {}) {
    const v = String(msg.storeNbr || "").trim();
    if (v) await set(KEYS.store, v); else await chrome.storage.local.remove(KEYS.store);
    return { storeNbr: v || null };
  },

  async clear_cache() {
    const all = await chrome.storage.local.get(null);
    // Analyses and the WorkView queue only. The cashier ledger, coaching
    // notes, the completed log and the three pulled reports (grid, till log,
    // CFTs — their older days cannot be re-pulled) are records, not cache,
    // and survive a clear; a fresh pull overwrites its own window anyway.
    const keep = (k) => k === KEYS.store || k === KEYS.ledger || k === KEYS.completed || k === KEYS.tills || k === KEYS.grid || k === KEYS.cft || k.startsWith("registerls.coaching.") || k.startsWith("registerls.cause.") || k.startsWith("registerls.pantry.") || k.startsWith("registerls.registers.");
    const keys = Object.keys(all).filter((k) => k.startsWith("registerls.") && !keep(k));
    if (keys.length) await chrome.storage.local.remove(keys);
    return { removed: keys.length };
  },

  async refresh_queue(msg = {}) {
    const store = await resolveStore(msg);
    if (!store.storeNbr) return { ok: false, error: "No store set — enter a store number." };
    broadcast("progress", { step: "queue", text: `Pulling WorkView for ${store.storeNbr}…` });
    const res = await fetchWorkItems(store.storeNbr, { days: QUEUE_DAYS, onProgress: (p) => broadcast("progress", { step: "queue", text: `WorkView ${p.status}: ${p.fetched}${p.total ? ` / ${p.total}` : ""}…` }) });
    if (!res.ok) { broadcast("progress", { step: "queue", text: "" }); return res; }
    await set(KEYS.queue, { storeNbr: store.storeNbr, items: res.items, others: res.others, otherCount: res.otherCount, total: res.total, totals: res.totals, fetchedAt: res.fetchedAt, window: res.window });
    broadcast("progress", { step: "queue", text: "" });
    console.log(TAG, "queue", { store: store.storeNbr, items: res.items.length, other: res.otherCount });
    return { ok: true, count: res.items.length, otherCount: res.otherCount, fetchedAt: res.fetchedAt };
  },

  async refresh_tills(msg = {}) {
    const store = await resolveStore(msg);
    if (!store.storeNbr) return { ok: false, error: "No store set — enter a store number." };
    const release = keepAwake("registerls.refresh_tills");
    try {
      broadcast("progress", { step: "tills", text: `Pulling the Cash Recycler till log for ${store.storeNbr} (about a minute)…` });
      const res = await fetchCashRecycler(store.storeNbr, { days: TILL_DAYS, onProgress: (p) => broadcast("progress", { step: "tills", text: `Cash Recycler page ${p.page}: ${p.rows} events…` }) });
      broadcast("progress", { step: "tills", text: "" });
      if (!res.ok) return res;
      // The report forgets days older than ~60; the check-in names behind a
      // flip live only here, so rows from earlier pulls are kept (permanent,
      // like the cashier ledger). The fresh pull wins inside its own range.
      const prev = await get(KEYS.tills);
      const merged = mergeDatedRows(prev && prev.storeNbr === store.storeNbr ? prev.rows : [], res.rows, { dateMin: res.dateMin, dateMax: res.dateMax });
      await set(KEYS.tills, { storeNbr: store.storeNbr, rows: merged.rows, fetchedAt: res.fetchedAt, dateMin: merged.dateMin, dateMax: merged.dateMax, pulledMin: res.dateMin, pulledMax: res.dateMax, reportUrl: res.reportUrl, days: TILL_DAYS });
      console.log(TAG, "tills", { store: store.storeNbr, rows: res.rows.length, kept: merged.kept, range: [merged.dateMin, merged.dateMax] });
      return { ok: true, rows: merged.rows.length, pulled: res.rows.length, kept: merged.kept, dateMin: merged.dateMin, dateMax: merged.dateMax };
    } finally {
      release();
    }
  },

  // Power BI "Cash Fund Transfers": every CFT keyed at the store, with who,
  // why and when it was keyed. Lined up against shortages by amount + date.
  async refresh_cft(msg = {}) {
    const store = await resolveStore(msg);
    if (!store.storeNbr) return { ok: false, error: "No store set — enter a store number." };
    const release = keepAwake("registerls.refresh_cft");
    try {
      broadcast("progress", { step: "cft", text: `Pulling Cash Fund Transfers for ${store.storeNbr}…` });
      const res = await fetchCft(store.storeNbr, { days: CFT_DAYS, onProgress: (p) => broadcast("progress", { step: "cft", text: `Cash Fund Transfers page ${p.page}: ${p.rows} transfers…` }) });
      broadcast("progress", { step: "cft", text: "" });
      if (!res.ok) return res;
      const prev = await get(KEYS.cft);   // kept across pulls — the report forgets days older than ~60
      const merged = mergeDatedRows(prev && prev.storeNbr === store.storeNbr ? prev.rows : [], res.rows, { dateMin: res.dateMin, dateMax: res.dateMax });
      await set(KEYS.cft, { storeNbr: store.storeNbr, rows: merged.rows, fetchedAt: res.fetchedAt, dateMin: merged.dateMin, dateMax: merged.dateMax, pulledMin: res.dateMin, pulledMax: res.dateMax, reportUrl: res.reportUrl, days: CFT_DAYS });
      console.log(TAG, "cft", { store: store.storeNbr, rows: res.rows.length, kept: merged.kept, range: [merged.dateMin, merged.dateMax] });
      return { ok: true, rows: merged.rows.length, pulled: res.rows.length, kept: merged.kept, dateMin: merged.dateMin, dateMax: merged.dateMax };
    } finally {
      release();
    }
  },

  async refresh_grid(msg = {}) {
    const store = await resolveStore(msg);
    if (!store.storeNbr) return { ok: false, error: "No store set — enter a store number." };
    const release = keepAwake("registerls.refresh_grid");
    try {
      broadcast("progress", { step: "grid", text: `Capturing the Power BI long/short grid for ${store.storeNbr} (30–60 s)…` });
      const res = await fetchRegister(store.storeNbr, { days: GRID_DAYS });
      broadcast("progress", { step: "grid", text: "" });
      if (!res.ok) {
        const authy = res.errorClass === "AUTH";
        return { ok: false, errorClass: res.errorClass, error: res.error || "Power BI capture failed", loginUrl: authy ? POWERBI_REPORT_URL : undefined };
      }
      // The report keeps ~60 days; cells from earlier pulls are kept so an
      // item never loses its offset candidates once its window was pulled.
      // The fresh capture is authoritative for the days it returned.
      const pulled = [...new Set(res.discrepancies.map((d) => d.date))].sort();
      const prev = await get(KEYS.grid);
      const merged = mergeDatedRows(prev && prev.storeNbr === store.storeNbr ? prev.discrepancies : [], res.discrepancies, { dateMin: pulled[0] || null, dateMax: pulled.at(-1) || null });
      const findings = tieredMatching(merged.rows);   // exact pairs first — see lib/matching.js
      const grid = { storeNbr: store.storeNbr, discrepancies: merged.rows, findings, rollup: rollup(findings), capturedAt: res.capturedAt || new Date().toISOString(), cellCount: res.cellCount, days: GRID_DAYS, dateMin: merged.dateMin, dateMax: merged.dateMax, pulledMin: pulled[0] || null, pulledMax: pulled.at(-1) || null };
      await set(KEYS.grid, grid);
      console.log(TAG, "grid", { store: store.storeNbr, cells: res.discrepancies.length, kept: merged.kept, findings: findings.length, range: [grid.dateMin, grid.dateMax] });
      return { ok: true, cellCount: merged.rows.length, pulled: res.discrepancies.length, kept: merged.kept, findings: findings.length, rollup: grid.rollup, capturedAt: grid.capturedAt };
    } finally {
      release();
    }
  },

  // msg: { id } (from the cached queue) or { item } (a QueueItem)
  async analyze_item(msg = {}) {
    const queue = await get(KEYS.queue);
    const item = msg.item || (queue?.items || []).find((i) => i.id === String(msg.id));
    if (!item) return { ok: false, error: "Work item not in the cached queue — refresh WorkView." };
    if (!item.register || !item.date) return { ok: false, error: `Work item ${item.id} has no register/date to analyze.` };
    const store = item.store || (await resolveStore(msg)).storeNbr;
    const release = keepAwake(`registerls.analyze.${item.id}`);
    try {
      broadcast("progress", { step: "analyze", id: item.id, text: `Reg ${item.register} ${item.date}: pulling Cash Research, EJ and Open Drawer…` });
      // Cash Research counts trading days back from today, so reach far
      // enough to include the item's own day plus a few days after it.
      const ledgerDays = Math.min(60, Math.max(10, Math.ceil((Date.now() - new Date(item.date).getTime()) / 86_400_000) + 4));
      const [ledgerRes, ejRes, drawerRes] = await Promise.all([
        fetchCashLedger(store, item.register, { days: ledgerDays }),
        fetchReceipts(store, item.date, item.register, { session: msg.ejSession || null }),
        fetchOpenDrawer(store, item.register, item.date),
      ]);
      const grid = await get(KEYS.grid);
      const gridOk = grid && grid.storeNbr === String(store);
      const tillsCache = await get(KEYS.tills);
      const roles = await roleContext(store, { tillRows: tillsCache && tillsCache.storeNbr === String(store) ? tillsCache.rows : [], grid, queue });
      const match = matchingFor(grid, queue, store, (await get(KEYS.completed)) || [], roles.wide);
      const { finding, discrepancy, counterpart, combo } = lookups(match, item);
      const ej = ejRes.ok ? parseRecords(ejRes.records) : null;
      const tills = tillsCache && tillsCache.storeNbr === String(store) ? tillsFor(tillsCache.rows, item, match.discrepancies, undefined, counterpart) : null;
      const cftCache = await get(KEYS.cft);
      const cft = cftCache && cftCache.storeNbr === String(store) ? cftFor(cftCache.rows, item) : null;
      const cfg = { ...roles.cfg, pantry: mergePantry((await get(KEYS.pantry(String(store))))?.items) };
      const evidence = buildEvidence({ item, finding, discrepancy, ledger: ledgerRes.ok ? ledgerRes.rows : null, ej, tills, drawer: drawerRes.ok ? drawerRes : null, cft, combo, coverage: match.coverage, cfg });
      const analysis = {
        schema: ANALYSIS_SCHEMA,
        at: new Date().toISOString(),
        gridCapturedAt: gridOk ? grid.capturedAt : null,   // a newer grid makes this analysis stale
        item,
        evidence,
        sources: {
          grid:   gridOk ? { ok: true, capturedAt: grid.capturedAt, hasCell: !!(finding || discrepancy) } : { ok: false, error: "Power BI grid not pulled for this store" },
          ledger: ledgerRes.ok ? { ok: true, rows: ledgerRes.rows.length, explorerUrl: ledgerRes.explorerUrl } : { ok: false, error: ledgerRes.error, loginUrl: ledgerRes.loginUrl },
          ej:     ejRes.ok ? { ok: true, records: ejRes.records.length, via: ejRes.via } : { ok: false, error: ejRes.error, loginUrl: ejRes.loginUrl },
          tills:  tills ? { ok: true, events: tills.events.length } : { ok: false, error: "Cash Recycler till log not pulled for this store" },
          drawer: drawerRes.ok ? { ok: true, opens: drawerRes.rows.length, explorerUrl: drawerRes.explorerUrl } : { ok: false, error: drawerRes.error, loginUrl: drawerRes.loginUrl },
          cft:    cft ? { ok: true, transfers: cft.length } : { ok: false, error: "Cash Fund Transfers not pulled for this store" },
        },
      };
      await set(KEYS.analysis(item.id), analysis);
      console.log(TAG, "analyze", { id: item.id, verdict: evidence.verdict, ledger: ledgerRes.ok, ej: ejRes.ok });
      return { ok: true, analysis };
    } finally {
      release();
    }
  },

  // Analyze every long/short item in the cached queue, one after another
  // (APPRISS and EJ are shared services; no parallel hammering).
  async analyze_all(msg = {}) {
    const queue = await get(KEYS.queue);
    const gridNow0 = await get(KEYS.grid);
    const tillsNow = await get(KEYS.tills);
    const tillRowsNow = tillsNow && tillsNow.storeNbr === queue?.storeNbr ? tillsNow.rows : null;
    const rolesNow = await roleContext(queue?.storeNbr, { tillRows: tillRowsNow || [], grid: gridNow0, queue });
    const match = matchingFor(gridNow0, queue, queue?.storeNbr, (await get(KEYS.completed)) || [], rolesNow.wide);
    // Only the items that need a look: clean pairs are filed from the match
    // alone, so pulling their journal is wasted time (pass force to include).
    const items = (queue?.items || []).filter((i) => i.register && i.date).filter((i) => msg.force || !SAFE.has(preVerdict(i, match, tillRowsNow, rolesNow.cfg).verdict));
    if (!items.length) return { ok: false, error: "Nothing needs analysis — every register item is a clean pair, or refresh WorkView first." };
    const release = keepAwake("registerls.analyze_all");
    const done = [], failed = [];
    // What actually needs a pull (fresh analyses on the current grid are kept).
    const todo = [];
    const gridNow = await get(KEYS.grid);
    for (const it of items) {
      if (!msg.force) {
        const cached = await get(KEYS.analysis(it.id));
        const sameGrid = !gridNow || cached?.gridCapturedAt === gridNow.capturedAt;
        if (cached && cached.schema === ANALYSIS_SCHEMA && sameGrid && Date.now() - new Date(cached.at).getTime() < 6 * 60 * 60_000) { done.push(it.id); continue; }
      }
      todo.push(it);
    }
    if (!todo.length) { broadcast("progress", { step: "analyze_all", text: "" }); return { ok: true, analyzed: done.length, failed: 0 }; }
    // One EJ tab for the whole run and a few items in flight at once: the
    // per-item cost was dominated by opening ej.walmart.com every time.
    let ejSession = null;
    try { ejSession = await openEjSession(); } catch (e) { console.warn(TAG, "EJ session not opened, falling back per item", e?.message || e); }
    let next = 0, finished = 0;
    const worker = async () => {
      while (next < todo.length) {
        const it = todo[next++];
        const r = await handlers.analyze_item({ id: it.id, ejSession });
        (r.ok ? done : failed).push(it.id);
        finished++;
        broadcast("progress", { step: "analyze_all", text: `Analyzed ${finished}/${todo.length}${finished < todo.length ? `: reg ${it.register} ${it.date} done, ${Math.min(ANALYZE_CONCURRENCY, todo.length - finished)} in flight…` : ""}` });
      }
    };
    try {
      broadcast("progress", { step: "analyze_all", text: `Analyzing ${todo.length} items, ${Math.min(ANALYZE_CONCURRENCY, todo.length)} at a time…` });
      await Promise.all(Array.from({ length: Math.min(ANALYZE_CONCURRENCY, todo.length) }, worker));
    } finally {
      await ejSession?.close?.().catch?.(() => {});
      release();
    }
    broadcast("progress", { step: "analyze_all", text: "" });
    return { ok: true, analyzed: done.length, failed: failed.length };
  },

  // Verified by the analyst in the module: disposition the work item in a
  // background tab (Start Work → Disposition → reason → text → Complete),
  // close the tab, and drop the item from the cached queue. dryRun fills
  // and cancels instead — used to test the path without closing anything.
  async complete_disposition(msg = {}) {
    const id = String(msg.id || "");
    const reasonLabel = String(msg.reasonLabel || "").trim();
    const text = String(msg.text || "").trim();
    if (!id) return { ok: false, error: "no work item id" };
    if (!reasonLabel || !text) return { ok: false, error: "reason and text are required" };
    const release = keepAwake(`registerls.complete.${id}`);
    try {
      // Bank the cashier events for this item before it leaves the queue.
      try { await handlers.sync_ledger(msg); } catch {}
      const res = await completeDisposition(id, { reasonLabel, text, complete: true, dryRun: !!msg.dryRun });
      console.log(TAG, "complete", { id, ok: res.ok, completed: res.completed, dryRun: !!msg.dryRun, error: res.error, log: res.log });
      // Already closed in APPRISS (dispositioned by hand, or by another
      // session): not an error for the board — drop it from the cache.
      if (!res.ok && /already dispositioned|already completed|already closed|already abandoned/i.test(res.error || "")) {
        const queue = await get(KEYS.queue);
        if (queue) { queue.items = (queue.items || []).filter((i) => i.id !== id); queue.others = (queue.others || []).filter((i) => i.id !== id); await set(KEYS.queue, queue); }
        return { ok: true, completed: false, alreadyClosed: true, error: res.error, log: res.log };
      }
      if (res.ok && res.completed) {
        const queue = await get(KEYS.queue);
        if (queue) {
          const item = (queue.items || []).find((i) => i.id === id) || (queue.others || []).find((i) => i.id === id) || null;
          queue.items = (queue.items || []).filter((i) => i.id !== id);
          queue.others = (queue.others || []).filter((i) => i.id !== id);
          await set(KEYS.queue, queue);
          const done = (await get(KEYS.completed)) || [];
          // Remember the other half of a filed flip/bounceback, so the pair is
          // locked from now on and the overage can never be filed twice.
          let counterpart = null;
          if (item) {
            try {
              const rolesCp = await roleContext(queue.storeNbr || item.store, { queue: { ...queue, items: [...queue.items, item] } });
              const match = matchingFor(await get(KEYS.grid), { ...queue, items: [...queue.items, item] }, queue.storeNbr || item.store, done, rolesCp.wide);
              const pre = preVerdict(item, match, null, rolesCp.cfg);
              const cp = SAFE.has(pre.verdict) ? lookups(match, item).counterpart : null;
              const cpd = cp ? findDiscrepancyFor(match.discrepancies, cp) : null;
              if (cp) counterpart = { register: String(cp.register), date: cp.date, amountCents: cpd?.amountCents ?? null };
            } catch (e) { console.warn(TAG, "counterpart lookup failed", e?.message || e); }
          }
          done.unshift({ id, at: new Date().toISOString(), reasonLabel, text, register: item?.register || null, date: item?.date || null, amountCents: item?.amountCents ?? null, category: item?.category || null, sourceAppId: item?.sourceAppId || null, cause: (await get(KEYS.cause(id))) || null, store: queue.storeNbr || item?.store || null, counterpart });
          await set(KEYS.completed, done.slice(0, 500));
        }
        await chrome.storage.local.remove(KEYS.analysis(id)).catch(() => {});
      }
      return res;
    } finally {
      release();
    }
  },

  async get_completed() {
    return { completed: (await get(KEYS.completed)) || [] };
  },

  // Open the work item in APPRISS (foreground) and fill the disposition form
  // from the suggestion. Never clicks Complete.
  async prefill_disposition(msg = {}) {
    const id = String(msg.id || "");
    if (!id) return { ok: false, error: "no work item id" };
    const reasonLabel = String(msg.reasonLabel || "").trim();
    const text = String(msg.text || "").trim();
    if (!reasonLabel || !text) return { ok: false, error: "reason and text are required" };
    const release = keepAwake(`registerls.prefill.${id}`);
    try {
      const res = await prefillDisposition(id, { reasonLabel, text });
      console.log(TAG, "prefill", { id, ok: res.ok, chosen: res.chosen, error: res.error });
      return res;
    } finally {
      release();
    }
  },

  // Rebuild attributed events from the live sources and merge them into the
  // permanent ledger. Events are never removed: completing a work item or the
  // till window rolling past a date does not erase what an associate did.
  async sync_ledger(msg = {}) {
    const store = await resolveStore(msg);
    const [queue, grid, tillsCache] = await Promise.all([get(KEYS.queue), get(KEYS.grid), get(KEYS.tills)]);
    const tillRows = tillsCache && tillsCache.storeNbr === store.storeNbr ? tillsCache.rows : [];
    // Items that were completed from the module stay in the analysis so their
    // cashier events keep being derived while the till log still covers them.
    const done = ((await get(KEYS.completed)) || []).filter((c) => c.register && c.date && c.amountCents != null);
    const live = (queue?.items || []);
    const liveIds = new Set(live.map((i) => i.id));
    const items = [...live, ...done.filter((c) => !liveIds.has(c.id)).map((c) => ({ id: c.id, store: store.storeNbr, register: c.register, date: c.date, amountCents: c.amountCents, amountAbsCents: Math.abs(c.amountCents), type: c.amountCents < 0 ? "short" : "over", sourceAppId: c.sourceAppId || "overshort", category: c.category || "", completed: true }))];
    const rolesL = await roleContext(store.storeNbr, { tillRows, grid, queue: { ...queue, items } });
    const match = matchingFor(grid, { ...queue, items }, store.storeNbr, done, rolesL.wide);
    const verdicts = {};
    for (const i of items) verdicts[i.id] = preVerdict(i, match, tillRows, rolesL.cfg);
    const flipWho = {};
    for (const i of items) { const { finding, counterpart } = lookups(match, i); if (finding && finding.matchType === "nearby-register-offset" && counterpart) flipWho[i.id] = counterpart; }
    // Flip pairs the grid found whose shortage side is not a work item
    // (below WorkView's threshold, or not raised yet): still a pair of
    // check-ins somebody did, so the flip_checkin rule sees them too. The
    // synthetic id is replaced by the real one once WorkView raises the item.
    const itemKeys = new Set(items.map((i) => `${i.register}|${i.date}`));
    for (const f of match.findings) {
      if (f.matchType !== "nearby-register-offset" || !(f.primaryAmountCents < 0) || !f.matchedAgainst?.[0] || itemKeys.has(`${f.primaryRegister}|${f.primaryDate}`)) continue;
      const id = `grid:${f.primaryRegister}|${f.primaryDate}`;
      items.push({ id, store: store.storeNbr, register: String(f.primaryRegister), date: f.primaryDate, amountCents: f.primaryAmountCents, amountAbsCents: Math.abs(f.primaryAmountCents), type: "short", sourceAppId: "grid", gridOnly: true });
      flipWho[id] = { register: String(f.matchedAgainst[0].registerNbr), date: f.matchedAgainst[0].date };
    }
    // Analyst-named causes: live items from their cause key, completed ones
    // from the completed log (the key is kept too, but the log is the record).
    const causes = {};
    const gotCause = await chrome.storage.local.get(items.map((i) => KEYS.cause(i.id)));
    for (const i of items) if (gotCause[KEYS.cause(i.id)]) causes[i.id] = gotCause[KEYS.cause(i.id)];
    for (const c of done) if (c.cause && !causes[c.id]) causes[c.id] = c.cause;
    const built = buildLedger({ items, verdicts, tillRows, discrepancies: match.discrepancies, counterparts: flipWho, causes });
    const ledger = (await get(KEYS.ledger)) || { events: {} };
    let merged = 0;
    const isGrid = (e) => String(e.workItemId || "").startsWith("grid:");
    const bare = (e) => `${e.associateId}|${e.type}|${e.date}|${e.register}`;
    const stored = new Map();   // bare identity → stored key, so a grid-derived event and its later work item never both count
    for (const [k, e] of Object.entries(ledger.events)) if (e.storeNbr === store.storeNbr) stored.set(bare(e), k);
    for (const e of built.events) {
      const k = `${store.storeNbr}|${eventKey(e)}`;
      if (ledger.events[k]) continue;
      const prior = stored.get(bare(e));
      if (prior) {
        if (isGrid(e) || !isGrid(ledger.events[prior])) continue;   // already known under a real (or the same) id
        const old = ledger.events[prior]; delete ledger.events[prior];   // grid-derived → promote to the work item
        ledger.events[k] = { ...e, storeNbr: store.storeNbr, firstSeen: old.firstSeen };
      } else {
        ledger.events[k] = { ...e, storeNbr: store.storeNbr, firstSeen: new Date().toISOString() }; merged++;
      }
      stored.set(bare(e), k);
    }
    // Pantry runs cashed out without a CFT: a store-level process record
    // (nobody is charged), permanent like the events, keyed on the ticket.
    ledger.pantry = ledger.pantry || {};
    const got = await chrome.storage.local.get(items.map((i) => KEYS.analysis(i.id)));
    for (const e of pantryEvents(Object.values(got).filter((a) => a && a.schema === ANALYSIS_SCHEMA))) {
      const k = `${store.storeNbr}|${pantryKey(e)}`;
      if (!ledger.pantry[k]) { ledger.pantry[k] = { ...e, storeNbr: store.storeNbr, firstSeen: new Date().toISOString() }; merged++; }
    }
    ledger.updatedAt = new Date().toISOString();
    await set(KEYS.ledger, ledger);
    return { merged, stored: Object.keys(ledger.events).length, pantry: Object.keys(ledger.pantry).length };
  },

  // Per-associate error ledger from the PERMANENT store, optionally limited
  // to a date range (msg.from / msg.to, ISO dates), plus coaching notes.
  async get_cashiers(msg = {}) {
    const store = await resolveStore(msg);
    const sync = await handlers.sync_ledger(msg);
    const ledger = (await get(KEYS.ledger)) || { events: {} };
    const from = String(msg.from || ""), to = String(msg.to || "");
    const events = Object.entries(ledger.events).map(([key, e]) => ({ ...e, key })).filter((e) => e.storeNbr === store.storeNbr && (!from || e.date >= from) && (!to || e.date <= to));
    const cashiers = aggregateEvents(events);
    const all = Object.values(ledger.events).filter((e) => e.storeNbr === store.storeNbr).map((e) => e.date).sort();
    const noteKeys = cashiers.map((c) => KEYS.coaching(c.id));
    const got = noteKeys.length ? await chrome.storage.local.get(noteKeys) : {};
    const notes = {};
    for (const c of cashiers) notes[c.id] = got[KEYS.coaching(c.id)] || [];
    const tillsCache = await get(KEYS.tills);
    const pantry = Object.values(ledger.pantry || {}).filter((e) => e.storeNbr === store.storeNbr && (!from || e.date >= from) && (!to || e.date <= to)).sort((a, b) => b.date.localeCompare(a.date));
    return { storeNbr: store.storeNbr, cashiers, pantry, types: ERROR_TYPES, notes, hasTills: !!(tillsCache && tillsCache.storeNbr === store.storeNbr) || all.length > 0, range: { from, to }, stored: { events: all.length, dateMin: all[0] || null, dateMax: all.at(-1) || null }, synced: sync };
  },

  async add_coaching_note(msg = {}) {
    const id = String(msg.id || "").trim();
    if (!id) return { ok: false, error: "no associate id" };
    const note = { date: String(msg.date || new Date().toISOString().slice(0, 10)), action: String(msg.action || "Note"), note: String(msg.note || "").trim(), by: String(msg.by || ""), at: new Date().toISOString() };
    const key = KEYS.coaching(id);
    const cur = (await get(key)) || [];
    cur.push(note);
    await set(key, cur);
    return { ok: true, notes: cur };
  },

  async remove_coaching_note(msg = {}) {
    const id = String(msg.id || "").trim(); const at = String(msg.at || "");
    const key = KEYS.coaching(id);
    const cur = ((await get(key)) || []).filter((n) => n.at !== at);
    await set(key, cur);
    return { ok: true, notes: cur };
  },

  // One CSV per cashier into Downloads/APAISuite/cashiers/<store>/ — the
  // "local file for each cashier". Overwrites the previous export.
  async export_cashier_files(msg = {}) {
    const state = await handlers.get_cashiers(msg);
    const only = msg.id ? String(msg.id) : null;
    const list = state.cashiers.filter((c) => !only || c.id === only);
    if (!list.length) return { ok: false, error: "no cashiers to export — pull the till log first" };
    const files = [];
    for (const c of list) {
      const csv = cashierCsv(c, state.notes[c.id] || []);
      const url = "data:text/csv;charset=utf-8," + encodeURIComponent("\ufeff" + csv);
      const filename = `APAISuite/cashiers/${state.storeNbr}/${safeFileName(c)}`;
      try {
        await chrome.downloads.download({ url, filename, conflictAction: "overwrite", saveAs: false });
        files.push(filename);
      } catch (e) {
        return { ok: false, error: `download failed for ${filename}: ${e?.message || e}`, files };
      }
    }
    return { ok: true, files };
  },

  // "This transaction was the cause." Stored per work item, independent of
  // the analysis (re-analyzing must not lose the analyst's call). The ledger
  // is synced at once so the operator is charged without waiting for a
  // completion.
  async set_cause(msg = {}) {
    const id = String(msg.id || "").trim();
    const cause = normalizeCause(msg.cause || {});
    if (!id || !cause) return { ok: false, error: "work item id and a transaction number are required" };
    await set(KEYS.cause(id), cause);
    try { await handlers.sync_ledger(msg); } catch {}
    return { ok: true, cause };
  },

  async clear_cause(msg = {}) {
    const id = String(msg.id || "").trim();
    if (!id) return { ok: false, error: "no work item id" };
    await chrome.storage.local.remove(KEYS.cause(id));
    // The ledger is permanent by design; the analyst's own retraction is the
    // one case where an event should go — remove this item's cause events.
    const ledger = (await get(KEYS.ledger)) || { events: {} };
    let removed = 0;
    for (const [k, e] of Object.entries(ledger.events || {})) if (e.type === "cause_tx" && e.workItemId === id) { delete ledger.events[k]; removed++; }
    if (removed) await set(KEYS.ledger, ledger);
    return { ok: true, removed };
  },

  // The pantry list the analysis matches tickets against: the built-in
  // items plus whatever the analyst has added for this store. Additions
  // are a record (kept by clear_cache); re-analyze to apply them.
  async get_pantry(msg = {}) {
    const store = await resolveStore(msg);
    const custom = (await get(KEYS.pantry(store.storeNbr)))?.items || [];
    return { storeNbr: store.storeNbr, items: mergePantry(custom), customCount: custom.length };
  },
  async add_pantry_items(msg = {}) {
    const store = await resolveStore(msg);
    const { items, rejected } = parsePantryText(msg.text);
    if (!items.length) return { ok: false, error: rejected.length ? `No UPC found on: ${rejected.slice(0, 3).join(" · ")}` : "Nothing to add — one item per line, UPC first." };
    const key = KEYS.pantry(store.storeNbr);
    const cur = (await get(key))?.items || [];
    const byUpc = new Map(cur.map((p) => [p.upc.replace(/^0+/, ""), p]));
    let added = 0, updated = 0;
    for (const p of items) { const k = p.upc.replace(/^0+/, ""); if (byUpc.has(k)) updated++; else added++; byUpc.set(k, { upc: k, desc: p.desc, addedAt: new Date().toISOString() }); }
    await set(key, { storeNbr: store.storeNbr, items: [...byUpc.values()] });
    return { ...(await handlers.get_pantry(msg)), added, updated, rejected };
  },
  async remove_pantry_item(msg = {}) {
    const store = await resolveStore(msg);
    const key = KEYS.pantry(store.storeNbr);
    const want = String(msg.upc || "").replace(/\D/g, "").replace(/^0+/, "");
    const cur = (await get(key))?.items || [];
    await set(key, { storeNbr: store.storeNbr, items: cur.filter((p) => p.upc.replace(/^0+/, "") !== want) });
    return handlers.get_pantry(msg);
  },
  // ── Register map ─────────────────────────────────────────────────
  // What each register is at this store (lib/registers.js). The analyst's
  // overrides are a record (kept by clear_cache); the rest is derived from
  // the till log and the number-range defaults on every read.
  async get_registers(msg = {}) {
    const store = await resolveStore(msg);
    const roles = await roleContext(store.storeNbr);
    return { storeNbr: store.storeNbr, registers: Object.values(roles.map), roles: ROLES, wide: roles.wide };
  },
  async set_register_role(msg = {}) {
    const store = await resolveStore(msg);
    const reg = String(msg.register || "").replace(/^0+(?=\d)/, "").trim();
    if (!reg) return { ok: false, error: "no register" };
    const role = msg.role == null || msg.role === "" ? null : String(msg.role);
    if (role && !isRole(role)) return { ok: false, error: `unknown role ${role}` };
    const key = KEYS.registers(store.storeNbr);
    const cur = (await get(key)) || { storeNbr: store.storeNbr, roles: {} };
    if (role) cur.roles[reg] = role; else delete cur.roles[reg];
    cur.updatedAt = new Date().toISOString();
    await set(key, cur);
    return { ok: true, ...(await handlers.get_registers(msg)) };
  },

  // ── Manual ledger events ─────────────────────────────────────────
  // "Attach an unpaid training receipt to a cashier" (analyst, 2026-09-17):
  // a receipt printed in training mode that the customer never actually
  // paid. Nothing in the sources derives it, so the analyst records it
  // against the associate directly; it then counts in the ledger and the
  // CSV like any other event. Keyed on the receipt so the same one cannot
  // be attached twice.
  async add_training_receipt(msg = {}) {
    const store = await resolveStore(msg);
    const associateId = String(msg.associateId || "").trim();
    const date = String(msg.date || "").slice(0, 10);
    const receipt = String(msg.receipt || "").trim();
    const cents = Math.round(Math.abs(Number(msg.amount)) * 100);
    if (!store.storeNbr) return { ok: false, error: "No store set." };
    if (!associateId) return { ok: false, error: "Associate WIN is required." };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: "Date is required." };
    if (!receipt) return { ok: false, error: "Receipt number (TC# or TR#) is required." };
    if (!Number.isFinite(cents) || cents <= 0) return { ok: false, error: "Amount must be more than $0." };
    const register = String(msg.register || "").replace(/^0+(?=\d)/, "").trim();
    const note = String(msg.note || "").trim();
    const e = { associateId, associate: String(msg.associate || "").trim(), type: "training_receipt", date, register, cents, workItemId: `receipt:${receipt}`, detail: `Training receipt ${receipt}${note ? ` — ${note}` : ""}`, manual: true, storeNbr: store.storeNbr, firstSeen: new Date().toISOString() };
    const key = `${store.storeNbr}|${eventKey(e)}`;
    const ledger = (await get(KEYS.ledger)) || { events: {} };
    if (ledger.events[key]) return { ok: false, error: `Receipt ${receipt} is already attached to ${associateId} on ${date}.` };
    ledger.events[key] = e;
    ledger.updatedAt = new Date().toISOString();
    await set(KEYS.ledger, ledger);
    return { ok: true, key, event: e };
  },
  // Only events the analyst entered by hand can be removed by hand.
  async remove_manual_event(msg = {}) {
    const key = String(msg.key || "");
    const ledger = (await get(KEYS.ledger)) || { events: {} };
    const e = ledger.events[key];
    if (!e) return { ok: false, error: "event not found" };
    if (!e.manual) return { ok: false, error: "only events entered by hand can be removed" };
    delete ledger.events[key];
    ledger.updatedAt = new Date().toISOString();
    await set(KEYS.ledger, ledger);
    return { ok: true, removed: key };
  },

  async get_analysis(msg = {}) {
    const a = await get(KEYS.analysis(String(msg.id)));
    return { analysis: a && a.schema === ANALYSIS_SCHEMA ? a : null };   // auto-wrapped; "not yet" is not an error
  },
};

function isoDaysAgo(n) {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}
