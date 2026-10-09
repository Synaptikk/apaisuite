// modules/gnfr/service.js
//
// Supply Orders — service-worker half.
//   get   { }                 → { ok, data }   cached store doc (no network)
//   pull  { days, full }      → { ok, data, warnings }
//
// Pull = MyGNFR store carts for the range (month windows, lines expanded),
// merged into the cached doc; orderer names (user search, cached for good),
// approval steps for lines waiting on / rejected by an approver, the month's
// operational-expenditure table, and job titles from the store's WFM
// schedule (Digital Metrics' Firestore, read-only, refreshed daily).
//
// Stored in chrome.storage.local under gnfr.data.<store> (+ gnfr.users).
// Holds associate names and WINs: local to this browser only.

import { withGnfr } from "./lib/transport.js";
import { compactCart, compactApprovals, lineStage, isStale, nameKey, sapDay } from "./lib/model.js";
import { withKeepAwake } from "../../shared/sw_keepalive.js";
import { singleFlight } from "../safetyagent/lib/single_flight.js";
import { schedules } from "../digitalmetrics/lib/firestore.js";

const MODULE_ID = "gnfr";
const DATA_KEY = (store) => `${MODULE_ID}.data.${store}`;
const LAST_STORE_KEY = `${MODULE_ID}.lastStore`;
const USERS_KEY = `${MODULE_ID}.users`;
const KEEP_DAYS = 400;          // carts older than this are dropped
const REFRESH_DAYS = 45;        // always re-read this much (statuses move)
const CHASE_DAYS = 120;         // ...and back to the oldest still-moving cart, no further
const SWEEP_MS = 7 * 86_400_000;       // full re-read of the range once a week
const ROSTER_DAYS = 21;         // schedule days read for job titles
const ROSTER_TTL = 20 * 3600_000;
const DAY = 86_400_000;

const pullFlight = singleFlight();
const fail = (e) => ({ ok: false, error: String(e?.message || e) });
const iso = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

function broadcast(type, payload) {
  chrome.runtime.sendMessage({ module: MODULE_ID, type, payload }).catch(() => {});
}

async function readDoc(store) {
  const key = store ? DATA_KEY(store) : null;
  const got = await chrome.storage.local.get([LAST_STORE_KEY, USERS_KEY, ...(key ? [key] : [])]);
  const s = store || got[LAST_STORE_KEY];
  const doc = s ? (key ? got[key] : (await chrome.storage.local.get(DATA_KEY(s)))[DATA_KEY(s)]) : null;
  return doc ? { ...doc, users: { ...(got[USERS_KEY] || {}), ...(doc.users || {}) } } : null;
}

/** [from, to] (YYYY-MM-DD, inclusive) → calendar-month windows. */
function monthWindows(from, to) {
  const out = [];
  let cur = from;
  while (cur <= to) {
    const [y, m] = cur.split("-").map(Number);
    const end = iso(new Date(y, m, 0).getTime());      // last day of that month
    out.push([cur, end < to ? end : to]);
    cur = iso(new Date(y, m, 1).getTime());
  }
  return out;
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}

async function readRoster(store) {
  const map = {};
  const days = Array.from({ length: ROSTER_DAYS }, (_, k) => iso(Date.now() - k * DAY)).reverse();
  const docs = [];
  await pool(days, 5, async (d, k) => { docs[k] = await schedules.get(String(Number(store)), d).catch(() => null); });
  let read = 0;
  for (const doc of docs) {           // oldest → newest, so the latest title wins
    if (!doc?.associates?.length) continue;
    read++;
    for (const a of doc.associates) if (a?.jobName) { const k = nameKey(a.name); if (k) map[k] = a.jobName; }
  }
  return { at: Date.now(), days: read, map };
}

async function pull(msg) {
  const days = Math.min(Math.max(Number(msg?.days) || 365, 30), KEEP_DAYS);
  const warnings = [];
  const say = (text) => broadcast("progress", { text });
  return withGnfr(async (call) => {
    say("Reading your MyGNFR profile…");
    const boot = await call({ op: "boot" });
    const store = boot.me?.store;
    if (!store) throw new Error("MyGNFR did not say which store you order for.");
    const prev = (await readDoc(store)) || {};
    const today = iso(Date.now());
    const wantFrom = iso(Date.now() - (days - 1) * DAY);

    // What to (re)read. The whole range when it isn't cached yet, when asked,
    // or once a week (SWEEP_MS) so lines that flip to delivered months late
    // are caught. Otherwise only the last REFRESH_DAYS, plus back to the
    // oldest cart that is genuinely still moving: awaiting approval, or open
    // with an expected date that hasn't gone stale — never further than
    // CHASE_DAYS. D-99 POs that never get a delivered flag (146 carts back to
    // 2025-10 at 1458) made every refresh re-read the whole year before this.
    const lastSweep = prev.sweptAt ?? prev.pulledAt ?? 0;
    const full = !!msg?.full || !prev.carts || !prev.coveredFrom || prev.coveredFrom > wantFrom
      || Date.now() - lastSweep > SWEEP_MS;
    let from = wantFrom;
    if (!full) {
      from = iso(Date.now() - REFRESH_DAYS * DAY);
      const floor = iso(Date.now() - CHASE_DAYS * DAY);
      for (const c of Object.values(prev.carts)) {
        const d = iso(c.at);
        if (d >= from || d < floor) continue;
        const moving = c.lines.some((l) => {
          const st = lineStage(l);
          return st === "approval" || (["submitted", "ordered", "shipped"].includes(st) && !isStale(l, today));
        });
        if (moving) from = d;
      }
    }
    const carts = { ...(prev.carts || {}) };
    const wins = monthWindows(from, today);
    let done = 0, got = 0;
    const what = full ? (prev.carts ? "weekly full check" : "first load") : "recent weeks";
    say(`Reading store carts (${what})… 0/${wins.length} months`);
    await pool(wins, 3, async ([a, b]) => {
      const res = await call({ op: "carts", store, from: a, to: b });
      for (const raw of res.carts || []) { const c = compactCart(raw); if (c.id) { carts[c.id] = c; got++; } }
      say(`Reading store carts (${what})… ${++done}/${wins.length} months`);
    });
    const cutoff = Date.now() - KEEP_DAYS * DAY;
    for (const [id, c] of Object.entries(carts)) if (c.at < cutoff) delete carts[id];

    // Who ordered: names for WINs not seen before (and retry unnamed ones).
    const { [USERS_KEY]: usersCache = {} } = await chrome.storage.local.get(USERS_KEY);
    const allWins = [...new Set(Object.values(carts).map((c) => c.win).filter(Boolean))];
    const needWins = allWins.filter((w) => !usersCache[w]?.name);
    if (needWins.length) {
      say(`Looking up ${needWins.length} associate name${needWins.length === 1 ? "" : "s"}…`);
      const r = await call({ op: "users", wins: needWins }).catch((e) => { warnings.push(`Names: ${e.message}`); return { users: {} }; });
      Object.assign(usersCache, r.users || {});
      await chrome.storage.local.set({ [USERS_KEY]: usersCache });
    }

    // Approvals: anything waiting on an approver (always re-read) or rejected
    // (read once; the comment says why).
    const approvals = { ...(prev.approvals || {}) };
    const prs = new Set();
    for (const c of Object.values(carts)) {
      for (const l of c.lines) {
        const st = lineStage(l);
        if (!l.pr) continue;
        if (st === "approval" || (st === "rejected" && !approvals[l.pr])) prs.add(l.pr);
      }
    }
    if (prs.size) {
      say(`Checking ${prs.size} approval${prs.size === 1 ? "" : "s"}…`);
      const r = await call({ op: "approvals", prs: [...prs].slice(0, 150) }).catch((e) => { warnings.push(`Approvals: ${e.message}`); return { approvals: {} }; });
      for (const [pr, rows] of Object.entries(r.approvals || {})) approvals[pr] = compactApprovals(rows);
    }
    const livePrs = new Set(Object.values(carts).flatMap((c) => c.lines.map((l) => l.pr)));
    for (const pr of Object.keys(approvals)) if (!livePrs.has(pr)) delete approvals[pr];

    // Job titles from the store's WFM schedule.
    let roster = prev.roster;
    if (!roster || Date.now() - roster.at > ROSTER_TTL || msg?.full) {
      say("Adding job titles…");
      try { roster = await readRoster(store); }
      catch (e) { console.warn("[gnfr] job titles:", e); warnings.push("Job titles unavailable. Sync Digital Metrics to add them."); }
      if (roster && !roster.days) warnings.push("Job titles unavailable. Sync Digital Metrics to add them.");
    }

    const doc = {
      store, me: boot.me, pulledAt: Date.now(),
      coveredFrom: prev.coveredFrom && prev.coveredFrom < from ? prev.coveredFrom : from,
      sweptAt: full ? Date.now() : lastSweep,
      carts, approvals, roster: roster || null,
      weeks: (boot.weeks || []).map((w) => ({ week: w.weekNumber, start: sapDay(w.weekStartDate), end: sapDay(w.weekEndDate), order: sapDay(w.orderDate), current: !!w.currentWeek })),
      budget: (boot.budget || []).map((b) => ({ gl: b.glaccnt, descr: b.descr, cat: b.category, ly: Number(b.invoice_ly) || 0, mtd: Number(b.invoice_mtd) || 0 })),
    };
    await chrome.storage.local.set({ [DATA_KEY(store)]: doc, [LAST_STORE_KEY]: store });
    say("");
    return { ok: true, data: { ...doc, users: usersCache }, read: got, months: wins.length, full, warnings };
  }, { say });
}

export const handlers = {
  async get(msg) {
    try { return { ok: true, data: await readDoc(msg?.store) }; }
    catch (e) { return fail(e); }
  },
  async pull(msg) {
    try {
      return await pullFlight("pull", () => withKeepAwake(`${MODULE_ID}.pull`, () => pull(msg)));
    } catch (e) { return fail(e); }
  },
};
