// modules/digitaldashboard/service.js
//
// SW side of the Digital Dashboard — store 1458 only, fed by the GIF app.
//
// GIF shows the signed-in associate's home store and nothing else, so there is
// no market and no store picker: single store throughout.
//
// Data comes from dev/gif-daemon.mjs on http://127.0.0.1:8770, which drives GIF
// in a headless emulator (an MV3 worker cannot run adb, and GIF's backend is
// app-gated). This file is a thin client of that daemon plus three browser-only
// jobs:
//   1. Pick Hours archive — every summary becomes per-clock-hour bars
//      (pick_history.js) upserted under PICK_DAYS_KEY, the same feed Digital
//      Metrics' "Pick Hours" tab reads. The old AI Launchpad source went dark
//      when that access was revoked (2026-10-03).
//   2. Break check — "who should be picking now" is the assignment grid
//      (Firestore, browser-only); the daemon is handed those names and says who
//      is not active and for how long. Duration only; no location.
//   3. Workvivo !command listener — reads/answers the "Daily Board" chat using
//      the user's own Workvivo tab.
//
// The previous web-API market rollup is preserved in
// docs/_archive/legacy-digitalrollup/.
//
// No host.storage here (host exists only in the view), so raw chrome.storage
// with explicitly prefixed keys. Chrome may stop a worker that sits on one
// request for minutes, so daemon calls pass a bounded `wait`, accept a stale
// answer, and ping to stay alive.

import { ensureAlarm } from "../../shared/alarms.js";
import { assignments, classifications } from "../digitalmetrics/lib/firestore.js";
import { isoDay } from "../digitalmetrics/lib/pull_schedule.js";
import { HOME_STORE, BREAK_LIMIT_MIN, pickersNow, normName, sameName } from "./lib/gif_metrics.js";
import { hourlyBars } from "./lib/pick_history.js";
import { PICK_DAYS_KEY, upsertDay } from "./lib/pick_days.js";
import { rosterRows, rosterTotals } from "./lib/store_roster.js";
import { parseCommand, formatPph, formatExpress, formatSummary, formatBreaks, formatStore, formatHelp } from "./lib/commands.js";
import { readChannelMessages, postTextToWorkvivo } from "../metricshot/lib/sendbird.js";

const K = {
  settings: "digitaldashboard.gif.settings",
  summary:  "digitaldashboard.gif.summary",
  watch:    "digitaldashboard.gif.watch",
  store:    "digitaldashboard.gif.store",
  listen:   "digitaldashboard.gif.listenState",
  alerted:  "digitaldashboard.gif.alerted",
};

// Digital Metrics classifications that count as "digital team" (vs Store Help).
const DIGITAL_CLASSES = new Set(["Digital", "Exceptions"]);

export const ALARM_NAMES = {
  sample: "digitaldashboard.sample",
  listen: "digitaldashboard.listen",
};

export const DEFAULTS = {
  daemonUrl: "http://127.0.0.1:8770",
  channel: "Daily Board",   // Workvivo chat for !commands and alerts
  listen: false,            // answer !commands in that chat
  autoSample: false,        // read GIF on a timer (keeps the emulator up during store hours)
  sampleMin: 10,
  autoBreakAlert: false,    // post "out of a pick walk > N min" without being asked
  reAlertMin: 20,           // minimum gap before the same person is alerted again
  limitMin: BREAK_LIMIT_MIN,
};

const STORE_OPEN_MIN = 5 * 60;    // 5 AM
const STORE_CLOSE_MIN = 22 * 60;  // 10 PM
const nowMinOfDay = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const inStoreHours = () => { const m = nowMinOfDay(); return m >= STORE_OPEN_MIN && m < STORE_CLOSE_MIN; };

async function lget(key, fallback) { return (await chrome.storage.local.get(key))[key] ?? fallback; }
async function lset(key, value) { await chrome.storage.local.set({ [key]: value }); }
export async function getSettings() { return { ...DEFAULTS, ...(await lget(K.settings, {})) }; }
export async function setSettings(patch) {
  const next = { ...(await lget(K.settings, {})), ...patch };
  await lset(K.settings, next);
  await installAlarms();
  return { ...DEFAULTS, ...next };
}

// ── Daemon client ────────────────────────────────────────────────

/** Keep the worker alive while a long daemon request is pending. */
function keepAlive() {
  const t = setInterval(() => { try { chrome.runtime.getPlatformInfo(() => {}); } catch { /* ignore */ } }, 20_000);
  return () => clearInterval(t);
}

async function daemon(path, params = {}, { timeoutMs = 120_000 } = {}) {
  const { daemonUrl } = await getSettings();
  const u = new URL(path, daemonUrl);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, String(v));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const stop = keepAlive();
  try {
    const r = await fetch(u, { signal: ctl.signal, cache: "no-store" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok && !j.error) console.warn("[digitaldashboard] daemon HTTP", r.status, path);
    if (!r.ok) throw Object.assign(new Error(j.error || "Live pick data returned an error — try again."), { kind: "DAEMON" });
    return j;
  } catch (e) {
    if (e.name === "AbortError") { console.warn("[digitaldashboard] GIF daemon timed out", path); throw Object.assign(new Error("Live pick data took too long — try again."), { kind: "TIMEOUT" }); }
    if (e.kind) throw e;
    console.warn("[digitaldashboard] GIF daemon not running — start it with: node dev/gif-daemon.mjs", e);
    throw Object.assign(new Error("Live pick data is offline."), { kind: "OFFLINE" });
  } finally { clearTimeout(timer); stop(); }
}

// ── Pick Hours archive (feeds Digital Metrics' Pick Hours tab) ────

/**
 * Fold one summary's running-total series into per-clock-hour bars and upsert
 * today's record under PICK_DAYS_KEY — the exact shape and key the old rollup
 * used, so Digital Metrics keeps reading it with no change there.
 */
async function feedPickDays(summary) {
  const series = summary?.series;
  if (!Array.isArray(series) || series.length < 2 || !summary.dayStart) return { skipped: "need two readings" };
  const day = hourlyBars(series, summary.dayStart);
  if (!day) return { skipped: "no bars yet" };
  const archive = await lget(PICK_DAYS_KEY, null);
  const next = upsertDay(archive, { store: HOME_STORE, day, samples: series.length });
  await lset(PICK_DAYS_KEY, next);
  return { ok: true, hours: day.hours.length };
}

/** Fetch a fresh-enough summary, cache it, and feed the archive. */
export async function refreshSummary({ maxAge = 120, wait = 90 } = {}) {
  const s = await daemon("/summary", { maxAge, wait, window: 60 }, { timeoutMs: (wait + 45) * 1000 });
  await lset(K.summary, { at: Date.now(), data: s });
  try { await feedPickDays(s); } catch (e) { console.warn("[digitaldashboard] feedPickDays:", e?.message ?? e); }
  return s;
}

/** The last summary we stored, for the view's first paint (no daemon call). */
export async function cachedSummary() { return lget(K.summary, null); }

// ── Break check ──────────────────────────────────────────────────

/** Today's grid roster for store 1458 from Digital Metrics' Firestore. */
async function todaysRoster() {
  const doc = await assignments.get(HOME_STORE, isoDay(new Date())).catch(() => null);
  return doc?.associates || [];
}

/**
 * Who is scheduled to pick this hour (from the grid) and, per the daemon, is on
 * the clock but not active — with minutes since last seen. Duration only; the
 * daemon is handed names and returns idle minutes, no location kept here.
 */
export async function checkBreaks({ wait = 90, maxAge = 120 } = {}) {
  const roster = await todaysRoster();
  const scheduled = pickersNow(roster, new Date());
  if (!scheduled.length) {
    const watch = { checkedAt: new Date().toISOString(), scheduledCount: 0, suspects: [], note: "no one on the grid to pick this hour" };
    await lset(K.watch, watch);
    return watch;
  }
  const { limitMin } = await getSettings();
  const r = await daemon("/breaks", { names: scheduled.join("|"), limit: limitMin, maxAge, wait }, { timeoutMs: (wait + 60) * 1000 });
  const watch = { ...r, checkedAt: new Date().toISOString() };
  await lset(K.watch, watch);
  return watch;
}

export async function cachedWatch() { return lget(K.watch, null); }

// ── Store roster (!store): who picked today, coded digital vs store help ──

/**
 * A name → classification lookup built from Digital Metrics' store-1458
 * classifications (Digital / Exceptions / Store Help). GIF names are "First
 * Last"; classification keys may differ in spelling, so fall back to a fuzzy
 * same-name match. Unknown names come back "Unclassified" and are treated as
 * store help (not digital) — honest: an unrecognised picker is not on the team.
 */
async function buildClassifier() {
  const map = await classifications.get(HOME_STORE).catch(() => ({}));
  const norm = new Map();
  for (const [name, cls] of Object.entries(map || {})) norm.set(normName(name), cls);
  return (gifName) => {
    const k = normName(gifName);
    if (norm.has(k)) return norm.get(k);
    for (const [n, cls] of norm) if (sameName(n, k)) return cls;
    return "Store Help";
  };
}

/**
 * The day's roster from the daemon, coded and totalled. `pass` advances the
 * daemon's accumulation (reads the All list + a few details); the roster fills
 * in over repeated passes, so a single call is cheap and never drills everyone.
 */
export async function getStore({ pass = true, budget = 5, wait = 160 } = {}) {
  const r = await daemon("/store", { pass: pass ? 1 : undefined, budget, wait }, { timeoutMs: (wait + 60) * 1000 });
  const classify = await buildClassifier();
  const code = (name) => classify(name);
  const isDigital = (name) => DIGITAL_CLASSES.has(classify(name));
  const out = {
    day: r.day, asOf: r.asOf, lastUpdated: r.lastUpdated, storeTotal: r.storeTotal,
    rows: rosterRows(r.roster, code),
    totals: rosterTotals(r.roster, isDigital, r.storeTotal),
  };
  await lset(K.store, { at: Date.now(), data: out });
  return out;
}

export async function cachedStore() { return lget(K.store, null); }

/** "Associate X has been out of a pick walk for N minutes." Duration only. */
function alertLine(s) {
  return `${s.name} has been out of a pick walk for ${s.idleMin} minutes.`;
}

/**
 * Post break alerts to the leadership chat for anyone over the limit we have
 * not alerted on recently. Rate-limited per person by reAlertMin so the same
 * associate is not reposted every tick. Returns what it posted (or why not).
 */
async function postBreakAlerts(watch) {
  const { channel, reAlertMin, autoBreakAlert } = await getSettings();
  if (!autoBreakAlert) return { skipped: "auto-alert off" };
  if (!channel) return { skipped: "no channel set" };
  const over = (watch?.suspects || []).filter((s) => s.over);
  if (!over.length) return { posted: 0 };

  const alerted = await lget(K.alerted, {});
  const now = Date.now();
  const due = over.filter((s) => !alerted[s.name] || now - alerted[s.name] > reAlertMin * 60_000);
  if (!due.length) return { posted: 0, heldBack: over.length };

  const text = due.map(alertLine).join("\n");
  const res = await postTextToWorkvivo({ channelName: channel, text, reuseOnly: true });
  if (res.ok) { for (const s of due) alerted[s.name] = now; await lset(K.alerted, alerted); }
  return { posted: res.ok ? due.length : 0, result: res };
}

// ── Workvivo !command listener ───────────────────────────────────
//
// Reads the leadership chat for messages starting with "!", answers each once.
// Uses the user's own open Workvivo tab (reuseOnly) — never opens or
// foregrounds one; with no Workvivo tab open the tick is a no-op. State is the
// last message timestamp we have answered up to, so a message is answered once.

async function answerCommand(cmd) {
  if (cmd === "help") return formatHelp();
  if (cmd === "unknown") return `Unknown command. ${formatHelp()}`;
  if (cmd === "breaks") {
    const w = await checkBreaks({ wait: 90 }).catch((e) => ({ error: e.message }));
    return w.error ? `Couldn't check breaks: ${w.error}` : formatBreaks(w, new Date());
  }
  if (cmd === "store") {
    const st = await getStore({ pass: true, wait: 150 }).catch((e) => ({ error: e.message }));
    return st.error ? `Couldn't read the roster: ${st.error}` : formatStore(st, new Date());
  }
  // pph / express / summary all need a summary
  const s = await refreshSummary({ maxAge: 120, wait: 90 }).catch((e) => ({ error: e.message }));
  if (s.error) return `Couldn't read GIF: ${s.error}`;
  if (cmd === "express") return formatExpress(s, new Date());
  if (cmd === "summary") {
    const w = await cachedWatch();
    return formatSummary(s, w, new Date());
  }
  return formatPph(s, new Date());
}

// On the very first tick there is no watermark; look back this far so a
// command typed in the minute before the listener was switched on still gets
// answered, without re-answering a whole backlog.
const LISTEN_FIRST_LOOKBACK_MS = 5 * 60_000;

export async function pollListener() {
  const { listen, channel } = await getSettings();
  if (!listen || !channel) return { skipped: "listener off" };
  // The GIF daemon answers the chat itself now (dev/gif-chat.mjs, via QRCallBox's
  // relay — no Workvivo tab needed). While it is listening, stand down so a
  // command is not answered twice.
  const h = await daemon("/health", {}, { timeoutMs: 5_000 }).catch(() => null);
  if (h?.chat?.state === "listening") return { skipped: "daemon is answering the chat" };

  const st = await lget(K.listen, null);
  const afterTs = st?.afterTs ?? (Date.now() - LISTEN_FIRST_LOOKBACK_MS);
  const read = await readChannelMessages({ channelName: channel, afterTs, limit: 50, reuseOnly: true });
  if (!read.ok) {
    // NO_TAB_OPEN is the normal "no Workvivo tab right now" case — quiet.
    if (read.errorClass !== "NO_TAB_OPEN") console.warn("[digitaldashboard] listener read:", read.error);
    return { skipped: read.errorClass || "read failed" };
  }

  const msgs = (read.messages || []).sort((a, b) => a.createdAt - b.createdAt);
  let answered = 0, lastTs = afterTs;
  for (const m of msgs) {
    lastTs = Math.max(lastTs, m.createdAt);
    // Loop guard is the "!" prefix, not the sender: only a command (starts with
    // "!") is answered, and a reply never starts with "!", so the listener can
    // never answer its own posts — and this still works in a self-chat, where
    // every message (command and reply) is from the same user id. Testing
    // against your own self-channel ("@me") therefore works.
    const cmd = parseCommand(m.text);
    if (!cmd) continue;
    const reply = await answerCommand(cmd).catch((e) => `Error: ${e.message}`);
    const res = await postTextToWorkvivo({ channelName: channel, text: reply, reuseOnly: true });
    if (res.ok) answered++;
  }
  await lset(K.listen, { afterTs: lastTs });
  return { answered, scanned: msgs.length };
}

// ── Alarms ───────────────────────────────────────────────────────

export async function installAlarms() {
  const { autoSample, sampleMin, listen } = await getSettings();
  if (autoSample) await ensureAlarm(ALARM_NAMES.sample, { periodInMinutes: Math.max(5, sampleMin), delayInMinutes: 1 });
  else await chrome.alarms.clear(ALARM_NAMES.sample).catch(() => {});
  if (listen) await ensureAlarm(ALARM_NAMES.listen, { periodInMinutes: 1, delayInMinutes: 1 });
  else await chrome.alarms.clear(ALARM_NAMES.listen).catch(() => {});
}

export async function onAlarm(alarm) {
  if (alarm.name === ALARM_NAMES.sample) {
    if (!inStoreHours()) return;
    const s = await refreshSummary({ maxAge: 0, wait: 180 }).catch((e) => ({ error: e.message }));
    if (s.error) return;
    const w = await checkBreaks({ maxAge: 0, wait: 180 }).catch(() => null);
    if (w) await postBreakAlerts(w).catch((e) => console.warn("[digitaldashboard] alerts:", e?.message ?? e));
    // Advance the day's roster a few associates at a time — it accumulates
    // across ticks, so no single pass drills everyone (store_roster.js).
    await getStore({ pass: true, budget: 5, wait: 180 }).catch((e) => console.warn("[digitaldashboard] roster:", e?.message ?? e));
  } else if (alarm.name === ALARM_NAMES.listen) {
    await pollListener().catch((e) => console.warn("[digitaldashboard] listener:", e?.message ?? e));
  }
}

export async function bootstrapIfNeeded() { await installAlarms().catch(() => {}); }

// ── Message handlers (view ↔ SW) ─────────────────────────────────

export const handlers = {
  "get_settings":    () => getSettings(),
  "set_settings":    (m) => setSettings(m?.patch || {}),
  "summary":         (m) => refreshSummary({ maxAge: m?.maxAge ?? 120, wait: m?.wait ?? 90 }),
  "cached_summary":  () => cachedSummary(),
  "check_breaks":    (m) => checkBreaks({ maxAge: m?.maxAge ?? 120, wait: m?.wait ?? 90 }),
  "cached_watch":    () => cachedWatch(),
  "store":           (m) => getStore({ pass: m?.pass ?? true, budget: m?.budget ?? 5, wait: m?.wait ?? 160 }),
  "cached_store":    () => cachedStore(),
  "health":          () => daemon("/health", {}, { timeoutMs: 8000 }).then((h) => ({ ok: true, ...h })).catch((e) => ({ ok: false, error: e.message, kind: e.kind })),
  "stop_emulator":   () => daemon("/stop", {}, { timeoutMs: 15000 }),
  "poll_listener":   () => pollListener(),
};
