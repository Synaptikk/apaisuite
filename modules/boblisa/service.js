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
//
// EJ access: lib/ej_day.js opens a fresh ej.walmart.com tab for the range,
// then fetches AND analyzes each whole store-day
// (~8k records) inside that tab and returns only the ~40 KB result. Raw
// records are never stored.

import { getUserHomeStore } from "../../shared/userStore.js";
import { withKeepAwake } from "../../shared/sw_keepalive.js";
import { EJ_HOME } from "../registerls/lib/ej.js";
import { fetchDayAnalysis, openEjDayTab } from "./lib/ej_day.js";
import { DEFAULT_OPTS } from "./lib/pairs.js";
import { DEFAULT_REGISTERS } from "./lib/registers.js";
import { buildRecord, missesCsv, pairFromRecord } from "./lib/misses.js";
import { getIdentity } from "../../shared/identity.js";
import { fetchOpenDrawer, linkVideo } from "../registerls/lib/open_drawer.js";

const TAG = "[boblisa]";
const KEYS = {
  store: "boblisa.storeOverride",
  range: "boblisa.range",
  day: (store, date) => `boblisa.day.${store}.${date}`,
  misses: (store) => `boblisa.misses.${store}`,   // { records: { [pairKey]: record }, updatedAt }
  drawer: (store, date, reg) => `boblisa.drawer.${store}.${date}.${reg}`,   // Open Drawer rows, one register-day
};
// Bump when lib/pairs.js changes what a stored day contains.
const ANALYSIS_SCHEMA = 5;   // 3: 92-94 = Money Center, 95 = Automotive, 98 = Vision; 4: same-register <2 min excluded; 5: money-service lines (bill pay, card loads, gift cards) ignored
const MAX_RANGE_DAYS = 31;

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
  const misses = (await loadMisses(storeNbr)).records;
  return {
    store: storeNbr, range, days, pairs, trainings, misses,
    missing: days.filter((d) => !d.fetchedAt || d.stale).map((d) => d.date),
    opts: DEFAULT_OPTS, registers: DEFAULT_REGISTERS, ejHome: EJ_HOME,
  };
}

export const handlers = {
  async get_state(msg) {
    const store = await resolveStore(msg);
    const range = await resolveRange(msg);
    if (!store.storeNbr) return { ok: true, store: null, storeSource: store.source, range, days: [], pairs: [], trainings: [], misses: {}, missing: [], opts: DEFAULT_OPTS, registers: DEFAULT_REGISTERS, ejHome: EJ_HOME };
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
    for (const reg of [...new Set(tx.filter(Boolean).map((t) => String(t.reg)))]) {
      const key = KEYS.drawer(store.storeNbr, date, reg);
      let cached = await get(key);
      if (!cached?.fetchedAt) {
        const res = await fetchOpenDrawer(store.storeNbr, reg, date);
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
    const record = buildRecord(pair, store.storeNbr, fields, { win: who.win || "", displayName: who.displayName || "" }, prior);
    doc.records[record.key] = record;
    doc.updatedAt = new Date().toISOString();
    await set(KEYS.misses(store.storeNbr), doc);
    broadcast("state_changed", { storeNbr: store.storeNbr });
    return { ok: true, record, misses: doc.records };
  },

  async delete_miss(msg = {}) {
    const store = await resolveStore(msg);
    if (!store.storeNbr) return { ok: false, error: "No store number." };
    const doc = await loadMisses(store.storeNbr);
    const key = String(msg.key || "");
    const existed = !!doc.records[key];
    delete doc.records[key];
    doc.updatedAt = new Date().toISOString();
    await set(KEYS.misses(store.storeNbr), doc);
    broadcast("state_changed", { storeNbr: store.storeNbr });
    return { ok: true, removed: existed, misses: doc.records };
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

  // Journal + Open Drawer caches only; documented misses (boblisa.misses.*) are kept.
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
