// modules/boblisa/service.js
//
// BoB and Lisa — service-worker handlers.
//
//   get_state           cached days for the store + range, flattened pairs + trainings
//   pull_range          pull each missing (or all, with force) store-day from EJ
//                       Viewer, run lib/pairs.js, cache per day; broadcasts `progress`
//   set_store_override  / clear_cache
//   link_video          APPRISS transaction ids for a pair via Open Drawer
//                       (registerls' route), cached per register-day
//   save_miss / delete_miss / export_misses
//                       the analyst's documented cashier misses, one object
//                       per store (boblisa.misses.<store>) that survives
//                       clear_cache and re-pulls; export = one CSV in Downloads
//   set_review          clear a pair or training receipt as reviewed / not a
//                       miss (boblisa.review.<store>); cleared rows leave the
//                       queue and stay cleared across re-pulls
//   set_cashier_name / export_cashiers
//                       the cashier ledger (boblisa.cashiers.<store>): misses
//                       and second-transaction dollars per manned-lane
//                       operator, rebuilt from the records on every save
//
// EJ access: lib/ej_day.js opens a fresh ej.walmart.com tab for the range,
// then fetches AND analyzes each whole store-day
// (~8k records) inside that tab and returns only the ~25 KB result. Raw
// records are never stored, so a day analyzed under an older ANALYSIS_SCHEMA
// has to be pulled again (once) after the rules change; days on the current
// schema are never re-pulled unless the user asks for it.

import { getUserHomeStore } from "../../shared/userStore.js";
import { withKeepAwake } from "../../shared/sw_keepalive.js";
import { EJ_HOME, fetchReceipts } from "../registerls/lib/ej.js";
import { operatorNames } from "../registerls/lib/ej_parse.js";
import { fetchDayAnalysis, openEjDayTab } from "./lib/ej_day.js";
import { DEFAULT_OPTS } from "./lib/pairs.js";
import { DEFAULT_REGISTERS } from "./lib/registers.js";
import { buildRecord, buildCashierLedger, cashiersCsv, missesCsv, pairFromRecord } from "./lib/misses.js";
import { getIdentity } from "../../shared/identity.js";
import { fetchOpenDrawer, linkVideo } from "../registerls/lib/open_drawer.js";
import { fetchEmployee } from "./lib/appriss_people.js";
import { apprissAuthGate } from "../../shared/appriss.js";

const TAG = "[boblisa]";
const KEYS = {
  store: "boblisa.storeOverride",
  range: "boblisa.range",
  day: (store, date) => `boblisa.day.${store}.${date}`,
  misses: (store) => `boblisa.misses.${store}`,   // { records: { [pairKey]: record }, updatedAt }
  review: (store) => `boblisa.review.${store}`,   // { items: { [key]: { status: "cleared", at, by, byName } }, updatedAt }
  cashiers: (store) => `boblisa.cashiers.${store}`,   // { ledger: { [op]: {...} }, updatedAt } — see lib/misses.js::buildCashierLedger
  operators: (store) => `boblisa.operators.${store}`, // { names: { [op]: name }, updatedAt } — from each pulled day's sign-on banners, merged
  drawer: (store, date, reg) => `boblisa.drawer.${store}.${date}.${reg}`,   // Open Drawer rows, one register-day
};
// Bump when lib/pairs.js changes what a stored day contains.
const ANALYSIS_SCHEMA = 6;   // 3: 92-94 = Money Center, 95 = Automotive, 98 = Vision; 4: same-register <2 min excluded; 5: money-service lines (bill pay, card loads, gift cards) ignored; 6: a sale pays for a training receipt only when all its lines are on it and cover half its lines or dollars
// A quarter at ~25 KB a day; the EJ Viewer itself only keeps a few months.
const MAX_RANGE_DAYS = 93;

async function get(key)        { return (await chrome.storage.local.get(key))[key]; }
async function set(key, value) { return chrome.storage.local.set({ [key]: value }); }
function broadcast(type, payload) { chrome.runtime.sendMessage({ module: "boblisa", type, payload }).catch(() => {}); }

async function resolveStore(msg = {}) {
  const explicit = String(msg.storeNbr || "").trim();
  if (explicit) return { storeNbr: explicit, source: "request" };
  const override = String((await get(KEYS.store)) || "").trim();
  if (override) return { storeNbr: override, source: "override" };
  const home = await getUserHomeStore().catch(() => null);
  if (home) return { storeNbr: String(home), source: "profile" };
  return { storeNbr: null, source: "none" };
}

const isoDay = (d) => d.toISOString().slice(0, 10);
function defaultRange() {
  const to = new Date(); to.setUTCDate(to.getUTCDate() - 1);          // yesterday: today's journal is still being written
  const from = new Date(to); from.setUTCDate(from.getUTCDate() - 6);   // one week
  return { from: isoDay(from), to: isoDay(to) };
}
export function datesBetween(from, to) {
  const out = [];
  const a = new Date(`${from}T00:00:00Z`), b = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || a > b) return out;
  for (let d = new Date(a); d <= b && out.length < MAX_RANGE_DAYS; d.setUTCDate(d.getUTCDate() + 1)) out.push(isoDay(d));
  return out;
}
/** Days the user asked for that datesBetween had to drop (0 when the range fits). */
function droppedDays(from, to) {
  const a = new Date(`${from}T00:00:00Z`), b = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || a > b) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000) + 1 - MAX_RANGE_DAYS);
}

async function resolveRange(msg = {}) {
  const saved = (await get(KEYS.range)) || {};
  const def = defaultRange();
  const from = String(msg.from || saved.from || def.from).slice(0, 10);
  const to = String(msg.to || saved.to || def.to).slice(0, 10);
  const range = datesBetween(from, to).length ? { from, to } : def;
  if (msg.from || msg.to) await set(KEYS.range, range);
  return range;
}

async function loadDays(storeNbr, dates) {
  const keys = dates.map((d) => KEYS.day(storeNbr, d));
  const got = await chrome.storage.local.get(keys);
  return dates.map((d) => ({ date: d, day: got[KEYS.day(storeNbr, d)] || null }));
}

async function loadMisses(storeNbr) {
  const doc = await get(KEYS.misses(storeNbr));
  return { records: {}, ...(doc || {}) };
}
async function loadReview(storeNbr) {
  const doc = await get(KEYS.review(storeNbr));
  return { items: {}, ...(doc || {}) };
}
async function loadCashiers(storeNbr) {
  const doc = await get(KEYS.cashiers(storeNbr));
  return { ledger: {}, ...(doc || {}) };
}
async function loadOperators(storeNbr) {
  const doc = await get(KEYS.operators(storeNbr));
  return { names: {}, people: {}, ...(doc || {}) };   // names: op → display name; people: op → APPRISS { name, first, last, win, userId, role, at }
}
// Names from a pulled day's sign-on banners, merged per store: an operator
// who signed on any pulled day is named on every day. A full APPRISS name
// (lookup_names) is never overwritten by a truncated banner.
async function mergeOperators(storeNbr, names = {}) {
  const entries = Object.entries(names || {}).filter(([op, name]) => op && name);
  if (!entries.length) return;
  const doc = await loadOperators(storeNbr);
  for (const [op, name] of entries) if (!doc.people[op]) doc.names[op] = name;
  doc.updatedAt = new Date().toISOString();
  await set(KEYS.operators(storeNbr), doc);
}

// Records are the source of truth; the ledger is the per-cashier tally kept
// in step with them. Names: typed on a record > remembered by the ledger >
// APPRISS / the journal's sign-on banner. WIN comes from APPRISS only.
async function saveMissesAndLedger(storeNbr, doc) {
  const [{ ledger: prior }, { names, people }] = await Promise.all([loadCashiers(storeNbr), loadOperators(storeNbr)]);
  const ledger = buildCashierLedger(doc.records, prior);
  for (const c of Object.values(ledger)) {
    if (!c.name && names[c.op]) c.name = names[c.op];
    if (people[c.op]?.win) c.win = people[c.op].win;
  }
  const at = new Date().toISOString();
  doc.updatedAt = at;
  await chrome.storage.local.set({ [KEYS.misses(storeNbr)]: doc, [KEYS.cashiers(storeNbr)]: { ledger, updatedAt: at } });
  return ledger;
}

async function stateFor(storeNbr, range) {
  const dates = datesBetween(range.from, range.to);
  const rows = await loadDays(storeNbr, dates);
  const days = rows.map(({ date, day }) => ({
    date,
    fetchedAt: day?.fetchedAt || null,
    stale: !!day && day.schema !== ANALYSIS_SCHEMA,
    stats: day?.stats || null,
    pairs: day?.pairs?.length ?? null,
    error: day?.error || null,
  }));
  const pairs = rows.flatMap(({ day }) => day?.pairs || []);
  const trainings = rows.flatMap(({ day }) => day?.trainings || []);
  const [misses, review, cashiers, operators] = await Promise.all([loadMisses(storeNbr), loadReview(storeNbr), loadCashiers(storeNbr), loadOperators(storeNbr)]);
  return {
    store: storeNbr, range, days, pairs, trainings,
    misses: misses.records, review: review.items, cashiers: cashiers.ledger, operators: operators.names, people: operators.people,
    missing: days.filter((d) => !d.fetchedAt || d.stale).map((d) => d.date),
    dropped: droppedDays(range.from, range.to), maxDays: MAX_RANGE_DAYS,
    opts: DEFAULT_OPTS, registers: DEFAULT_REGISTERS, ejHome: EJ_HOME,
  };
}

export const handlers = {
  async get_state(msg) {
    const store = await resolveStore(msg);
    const range = await resolveRange(msg);
    if (!store.storeNbr) return { ok: true, store: null, storeSource: store.source, range, days: [], pairs: [], trainings: [], misses: {}, review: {}, cashiers: {}, operators: {}, missing: [], dropped: 0, maxDays: MAX_RANGE_DAYS, opts: DEFAULT_OPTS, registers: DEFAULT_REGISTERS, ejHome: EJ_HOME };
    return { ok: true, storeSource: store.source, ...(await stateFor(store.storeNbr, range)) };
  },

  async pull_range(msg) {
    const store = await resolveStore(msg);
    if (!store.storeNbr) return { ok: false, error: "No store number. Set one in the toolbar or in Settings." };
    const range = await resolveRange(msg);
    const storeNbr = store.storeNbr;
    const all = datesBetween(range.from, range.to);
    const have = await loadDays(storeNbr, all);
    const todo = msg.force ? all : have.filter(({ day }) => !day?.fetchedAt || day.schema !== ANALYSIS_SCHEMA || day.error).map(({ date }) => date);
    if (!todo.length) return { ok: true, pulled: 0, ...(await stateFor(storeNbr, range)) };

    return withKeepAwake("boblisa.pull_range", async () => {
      let session = null;
      try { session = await openEjDayTab(); } catch (e) { console.warn(TAG, "EJ tab not opened, falling back per day", e?.message || e); }
      let pulled = 0, failed = 0, lastError = null;
      try {
        for (let i = 0; i < todo.length; i++) {
          const date = todo[i];
          broadcast("progress", { storeNbr, date, i, n: todo.length, phase: "pull" });
          const res = await fetchDayAnalysis(storeNbr, date, { session, opts: DEFAULT_OPTS });
          if (!res.ok) {
            failed += 1; lastError = res;
            await set(KEYS.day(storeNbr, date), { schema: ANALYSIS_SCHEMA, date, fetchedAt: null, error: res.error, loginUrl: res.loginUrl || null, pairs: [], trainings: [] });
            broadcast("progress", { storeNbr, date, i, n: todo.length, phase: "error", error: res.error });
            if (res.errorClass === "AUTH") break;   // every later day would fail the same way
            continue;
          }
          const day = res.day;
          await set(KEYS.day(storeNbr, date), { schema: ANALYSIS_SCHEMA, fetchedAt: res.fetchedAt, via: res.via, ...day });
          await mergeOperators(storeNbr, day.operators);
          pulled += 1;
          broadcast("progress", { storeNbr, date, i, n: todo.length, phase: "done", pairs: day.pairs.length, records: day.stats.records });
        }
      } finally {
        await session?.close?.().catch?.(() => {});
      }
      const state = await stateFor(storeNbr, range);
      broadcast("state_changed", { storeNbr });
      if (failed && !pulled) return { ok: false, error: lastError?.error || "EJ pull failed", errorClass: lastError?.errorClass, loginUrl: lastError?.loginUrl || EJ_HOME, ...state };
      return { ok: true, pulled, failed, ...state };
    });
  },

  async set_store_override(msg) {
    const v = String(msg.storeNbr || "").trim();
    if (v) await set(KEYS.store, v); else await chrome.storage.local.remove(KEYS.store);
    return handlers.get_state({});
  },

  // ── video ──────────────────────────────────────────────────────
  // APPRISS video keyed on its own transaction id, the way the L/S triage does
  // it: Open Drawer lists every drawer-opening transaction on a register-day
  // with APPRISS's id. A card sale that never opened the drawer falls back to
  // the nearest drawer open within 90 s (same camera, same minute; flagged
  // byTime). msg: { date, t1: { reg, tr, time }, t2: { reg, tr, time } }.
  async link_video(msg = {}) {
    const store = await resolveStore(msg);
    if (!store.storeNbr) return { ok: false, error: "No store number." };
    const date = String(msg.date || "").slice(0, 10);
    const tx = [msg.t1, msg.t2].map((t) => (t && t.reg != null ? t : null));
    if (!date || !tx.some(Boolean)) return { ok: false, error: "date and transactions required" };
    const drawer = {}, empty = []; let explorer = null;
    // One silent APPRISS reauth for this lookup (shared/appriss.js): the
    // session is cold on the first Open Drawer call after the browser starts,
    // and without this the analyst had to open Secure by hand first.
    const gate = apprissAuthGate({ moduleId: "boblisa" });
    for (const reg of [...new Set(tx.filter(Boolean).map((t) => String(t.reg)))]) {
      const key = KEYS.drawer(store.storeNbr, date, reg);
      let cached = await get(key);
      if (!cached?.fetchedAt) {
        const res = await gate.run(() => fetchOpenDrawer(store.storeNbr, reg, date));
        if (!res.ok) return { ok: false, error: res.error, loginUrl: res.loginUrl || null };
        cached = { fetchedAt: res.fetchedAt, rows: res.rows, explorerUrl: res.explorerUrl };
        await set(key, cached);
      }
      drawer[reg] = cached.rows;
      if (!cached.rows.length) empty.push(reg);
      explorer = explorer || cached.explorerUrl;
    }
    const out = { ok: true, date, empty, explorer, t1: null, t2: null };
    tx.forEach((t, i) => {
      if (!t) return;
      const [x] = linkVideo([{ transNum: t.tr, time: t.time }], drawer[String(t.reg)] || []);
      out[i === 0 ? "t1" : "t2"] = x.video || null;
    });
    return out;
  },

  // ── documented misses ──────────────────────────────────────────
  // msg: { storeNbr?, pair?, key?, fields: { cause, outcome, cashierName, note } }
  // `pair` comes from the review table; an edit from the Documented tab sends
  // only `key` and the stored record supplies the pair.
  async save_miss(msg = {}) {
    const store = await resolveStore(msg);
    if (!store.storeNbr) return { ok: false, error: "No store number." };
    const doc = await loadMisses(store.storeNbr);
    const key = String(msg.pair?.key || msg.key || "");
    const prior = doc.records[key] || null;
    const pair = msg.pair?.key ? msg.pair : pairFromRecord(prior);
    if (!pair) return { ok: false, error: "Nothing to document: no pair and no saved record for that key." };
    const who = await getIdentity().catch(() => ({}));
    const fields = { ...(msg.fields || {}), videoIds: msg.videoIds || msg.fields?.videoIds };
    if (!String(fields.cashierName || "").trim()) {   // journal sign-on banner name unless the analyst typed one
      const { names } = await loadOperators(store.storeNbr);
      fields.cashierName = names[String(pair.t1?.op || "")] || prior?.cashier?.name || "";
    }
    const record = buildRecord(pair, store.storeNbr, fields, { win: who.win || "", displayName: who.displayName || "" }, prior);
    doc.records[record.key] = record;
    const cashiers = await saveMissesAndLedger(store.storeNbr, doc);
    broadcast("state_changed", { storeNbr: store.storeNbr });
    return { ok: true, record, misses: doc.records, cashiers };
  },

  async delete_miss(msg = {}) {
    const store = await resolveStore(msg);
    if (!store.storeNbr) return { ok: false, error: "No store number." };
    const doc = await loadMisses(store.storeNbr);
    const key = String(msg.key || "");
    const existed = !!doc.records[key];
    delete doc.records[key];
    const cashiers = await saveMissesAndLedger(store.storeNbr, doc);
    broadcast("state_changed", { storeNbr: store.storeNbr });
    return { ok: true, removed: existed, misses: doc.records, cashiers };
  },

  // ── review state ───────────────────────────────────────────────
  // msg: { key, cleared: true|false }. A cleared pair (or training receipt)
  // was looked at and is not a miss / needs nothing more; it leaves the queue
  // and stays cleared across pulls. Documenting a miss is the other way out.
  async set_review(msg = {}) {
    const store = await resolveStore(msg);
    if (!store.storeNbr) return { ok: false, error: "No store number." };
    const key = String(msg.key || "");
    if (!key) return { ok: false, error: "key required" };
    const doc = await loadReview(store.storeNbr);
    if (msg.cleared) {
      const who = await getIdentity().catch(() => ({}));
      doc.items[key] = { status: "cleared", at: new Date().toISOString(), by: who.win || "", byName: who.displayName || "" };
    } else {
      delete doc.items[key];
    }
    doc.updatedAt = new Date().toISOString();
    await set(KEYS.review(store.storeNbr), doc);
    broadcast("state_changed", { storeNbr: store.storeNbr });
    return { ok: true, review: doc.items };
  },

  // ── operator names from APPRISS ────────────────────────────────
  // Full name + WIN for every operator seen in the cached range (lib/
  // appriss_people.js). Route per operator: a register-day they worked →
  // Open Drawer (cached per register-day, like link_video) → any row with
  // their cashier number → journal event → employee block. Operators who
  // never opened a drawer on a cached day (card-only lanes) stay on the
  // banner name. msg: { storeNbr?, from?, to?, force?, op?, date?, reg? } —
  // with `op` only that operator is looked up (the miss form does this when
  // it opens without a name), `date`/`reg` being the register-day to try first.
  async lookup_names(msg = {}) {
    const store = await resolveStore(msg);
    if (!store.storeNbr) return { ok: false, error: "No store number." };
    const storeNbr = store.storeNbr;
    const range = await resolveRange(msg);
    const days = (await loadDays(storeNbr, datesBetween(range.from, range.to))).filter(({ day }) => day?.fetchedAt);
    const opsDoc = await loadOperators(storeNbr);
    // op → [{ date, reg }] register-days the operator worked, newest first (APPRISS keeps ~60 days).
    const where = new Map();
    const note = (op, date, reg) => { op = String(op || ""); if (!op || op === "?") return; if (!where.has(op)) where.set(op, []); where.get(op).push({ date, reg: String(reg) }); };
    const only = String(msg.op || "").trim();
    if (only && msg.date && msg.reg != null) note(only, String(msg.date).slice(0, 10), msg.reg);
    for (const { date, day } of days) {
      for (const p of day.pairs || []) { note(p.t1.op, date, p.t1.reg); note(p.t2.op, date, p.t2.reg); }
      for (const t of day.trainings || []) note(t.op, date, t.reg);
    }
    const todo = [...where.keys()].filter((op) => (!only || op === only) && (msg.force || !opsDoc.people[op]));
    if (!todo.length) return { ok: true, resolved: 0, unresolved: 0, checked: 0, ...(await stateFor(storeNbr, range)) };

    return withKeepAwake("boblisa.lookup_names", async () => {
      // One silent APPRISS reauth for the whole run (shared/appriss.js), no
      // matter how many drawer / journal-event calls it takes. The session is
      // cold on the first call after the browser starts; before this the
      // handler just reported "session expired" and the analyst opened Secure
      // by hand to warm it.
      const gate = apprissAuthGate({ moduleId: "boblisa" });
      const MAX_DRAWER_FETCHES = 80;   // ~5 s each; the button can be pressed again to continue
      const drawerByReg = new Map();   // "date|reg" → rows | null (fetch failed)
      const tidByCashier = new Map();  // every cashier seen in any fetched register-day → a transaction id
      const remember = (rows) => { for (const r of rows || []) if (r.transactionId && r.cashier && !tidByCashier.has(String(r.cashier))) tidByCashier.set(String(r.cashier), r.transactionId); };
      let drawerFetches = 0, resolved = 0, loginUrl = null, lastError = null;
      const tidFor = async (op) => {
        if (tidByCashier.has(op)) return { tid: tidByCashier.get(op) };
        // Newest register-days first (APPRISS keeps ~60 days); a card-only cashier
        // could otherwise cost a fetch for every day they worked.
        const spots = where.get(op).slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, only ? 6 : 12);
        const seen = new Set();
        for (const { date, reg } of spots) {
          const k = `${date}|${reg}`;
          if (seen.has(k)) continue; seen.add(k);
          if (!drawerByReg.has(k)) {
            const key = KEYS.drawer(storeNbr, date, reg);
            let cached = await get(key);
            if (!cached?.fetchedAt) {
              if (drawerFetches >= MAX_DRAWER_FETCHES) continue;
              drawerFetches += 1;
              const res = await gate.run(() => fetchOpenDrawer(storeNbr, reg, date));
              if (!res.ok) { lastError = res.error; if (res.loginUrl) loginUrl = res.loginUrl; drawerByReg.set(k, null); if (res.loginUrl) return { auth: true }; continue; }
              cached = { fetchedAt: res.fetchedAt, rows: res.rows, explorerUrl: res.explorerUrl };
              await set(key, cached);
            }
            drawerByReg.set(k, cached.rows);
            remember(cached.rows);
          }
          if (tidByCashier.has(op)) return { tid: tidByCashier.get(op) };
        }
        return {};
      };
      for (let i = 0; i < todo.length; i++) {
        const op = todo[i];
        broadcast("progress", { storeNbr, phase: "names", i, n: todo.length, op });
        const { tid, auth } = await tidFor(op);
        if (auth) break;
        if (!tid) continue;
        const res = await gate.run(() => fetchEmployee(tid));
        if (!res.ok) { lastError = res.error; if (res.errorClass === "AUTH") { loginUrl = res.loginUrl; break; } continue; }
        const e = res.employee;
        if (!e?.name) continue;
        opsDoc.people[op] = { ...e, op, at: new Date().toISOString() };
        opsDoc.names[op] = e.name;
        resolved += 1;
      }
      // Journal fallback: an operator APPRISS has no drawer open for (card-only
      // lane) still signed on somewhere in the journal. One operator-filtered
      // receipts call per cashier-day (~75 records, 2.5 s) carries the banner
      // (`****** 155  JANE DOE ******`), which is at least the name EJ prints.
      const MAX_EJ_LOOKUPS = only ? 3 : 30;
      const stillUnnamed = todo.filter((op) => !opsDoc.people[op] && (!opsDoc.names[op] || msg.force));
      let banners = 0, ejLookups = 0, ejError = null, ejLoginUrl = null;
      if (stillUnnamed.length) {
        let session = null;
        try { session = await openEjDayTab(); } catch (e) { ejError = `EJ tab not opened: ${e?.message || e}`; }
        try {
          for (const op of stillUnnamed) {
            if (ejLookups >= MAX_EJ_LOOKUPS || ejLoginUrl) break;
            const spots = where.get(op).slice().sort((a, b) => b.date.localeCompare(a.date));
            const seenDates = new Set();
            for (const { date } of spots) {
              if (seenDates.has(date) || seenDates.size >= (only ? 3 : 2)) continue;
              seenDates.add(date);
              if (ejLookups >= MAX_EJ_LOOKUPS) break;
              ejLookups += 1;
              broadcast("progress", { storeNbr, phase: "names", i: todo.indexOf(op), n: todo.length, op, source: "journal" });
              const res = await fetchReceipts(storeNbr, date, "", { session, operatorNumber: op, allowTabFallback: false });
              if (!res.ok) { ejError = res.error; if (res.errorClass === "AUTH") { ejLoginUrl = res.loginUrl; } break; }
              const name = operatorNames(res.records)[op];
              if (name) { opsDoc.names[op] = name; banners += 1; break; }
            }
          }
        } finally {
          await session?.close?.().catch?.(() => {});
        }
      }
      opsDoc.updatedAt = new Date().toISOString();
      await set(KEYS.operators(storeNbr), opsDoc);

      // Records that carried the banner (or no) name for a now-resolved op
      // take the full name; the ledger follows.
      const doc = await loadMisses(storeNbr);
      let upgraded = 0;
      for (const r of Object.values(doc.records)) {
        const p = opsDoc.people[String(r.cashier?.op)];
        if (!p?.name || r.cashier.name === p.name) continue;
        const cur = String(r.cashier.name || "").trim().toUpperCase();
        if (!cur || p.name.toUpperCase().startsWith(cur) || cur.startsWith(p.name.toUpperCase())) { r.cashier.name = p.name; upgraded += 1; }
      }
      await saveMissesAndLedger(storeNbr, doc);
      broadcast("state_changed", { storeNbr });
      const state = await stateFor(storeNbr, range);
      if (!resolved && !banners && loginUrl) return { ok: false, error: lastError || "APPRISS session expired.", loginUrl, ...state };
      return { ok: true, resolved, banners, upgraded, checked: todo.length, unresolved: todo.length - resolved - banners, drawerFetches, ejLookups, loginUrl, ejLoginUrl, error: lastError || ejError, ...state };
    });
  },

  // ── cashier ledger ─────────────────────────────────────────────
  // msg: { op, name } — the name applies to every record for that operator
  // and is remembered by the ledger for the next one.
  async set_cashier_name(msg = {}) {
    const store = await resolveStore(msg);
    if (!store.storeNbr) return { ok: false, error: "No store number." };
    const op = String(msg.op || "").trim(), name = String(msg.name || "").trim();
    if (!op) return { ok: false, error: "op required" };
    const doc = await loadMisses(store.storeNbr);
    const at = new Date().toISOString();
    for (const r of Object.values(doc.records)) {
      if (String(r.cashier?.op) === op) { r.cashier.name = name; r.updatedAt = at; }
    }
    const prior = (await loadCashiers(store.storeNbr)).ledger;
    if (prior[op]) prior[op].name = name;   // remembered even with no record left for the op
    const ledger = buildCashierLedger(doc.records, prior);
    if (!ledger[op] && prior[op]) ledger[op] = { ...prior[op], name };
    doc.updatedAt = at;
    await chrome.storage.local.set({ [KEYS.misses(store.storeNbr)]: doc, [KEYS.cashiers(store.storeNbr)]: { ledger, updatedAt: at } });
    broadcast("state_changed", { storeNbr: store.storeNbr });
    return { ok: true, misses: doc.records, cashiers: ledger };
  },

  // One CSV, a row per cashier, into Downloads/APAISuite/boblisa/<store>/.
  async export_cashiers(msg = {}) {
    const store = await resolveStore(msg);
    if (!store.storeNbr) return { ok: false, error: "No store number." };
    const { ledger } = await loadCashiers(store.storeNbr);
    const rows = Object.keys(ledger).length;
    if (!rows) return { ok: false, error: "No documented misses on manned lanes yet, so no cashier ledger to export." };
    const url = "data:text/csv;charset=utf-8," + encodeURIComponent("﻿" + cashiersCsv(ledger));
    const filename = `APAISuite/boblisa/${store.storeNbr}/cashier-ledger.csv`;
    try {
      await chrome.downloads.download({ url, filename, conflictAction: "overwrite", saveAs: false });
    } catch (e) {
      return { ok: false, error: `download failed: ${e?.message || e}` };
    }
    return { ok: true, filename, rows };
  },

  // One CSV for the store into Downloads/APAISuite/boblisa/<store>/ (overwrites
  // the previous export). msg.from / msg.to (ISO dates) limit the rows.
  async export_misses(msg = {}) {
    const store = await resolveStore(msg);
    if (!store.storeNbr) return { ok: false, error: "No store number." };
    const { records } = await loadMisses(store.storeNbr);
    const from = String(msg.from || ""), to = String(msg.to || "");
    const rows = Object.values(records).filter((r) => (!from || r.date >= from) && (!to || r.date <= to));
    if (!rows.length) return { ok: false, error: "No documented misses to export." };
    const csv = missesCsv(rows);
    const url = "data:text/csv;charset=utf-8," + encodeURIComponent("\ufeff" + csv);
    const filename = `APAISuite/boblisa/${store.storeNbr}/missed-items${from || to ? `_${from || "start"}_${to || "end"}` : ""}.csv`;
    try {
      await chrome.downloads.download({ url, filename, conflictAction: "overwrite", saveAs: false });
    } catch (e) {
      return { ok: false, error: `download failed: ${e?.message || e}` };
    }
    return { ok: true, filename, rows: rows.length };
  },

  // Journal + Open Drawer caches only; documented misses (boblisa.misses.*),
  // review state (boblisa.review.*) and the cashier ledger (boblisa.cashiers.*) are kept.
  async clear_cache(msg) {
    const store = await resolveStore(msg);
    const all = await chrome.storage.local.get(null);
    const suffix = store.storeNbr ? `${store.storeNbr}.` : "";
    const prefixes = [`boblisa.day.${suffix}`, `boblisa.drawer.${suffix}`];
    const keys = Object.keys(all).filter((k) => prefixes.some((p) => k.startsWith(p)));
    if (keys.length) await chrome.storage.local.remove(keys);
    return { ok: true, removed: keys.length };
  },
};
