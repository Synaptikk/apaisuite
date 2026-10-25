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
import { withMeals, watchWithMeals, needsLunchCheck, clockToMs, episodeMinutes, LUNCH_CHECK_MIN } from "./lib/break_log.js";
import { handlers as metricsHandlers } from "../digitalmetrics/service.js";
import { openOutlookDraft } from "../../shared/outlook_send.js";
import { PICK_DAYS_KEY, upsertDay } from "./lib/pick_days.js";
import { rosterRows, rosterTotals } from "./lib/store_roster.js";
import { staffingPlan, staffingLine, staffingText, slotPace, paceLine, activePickers, outputPickers } from "./lib/staffing.js";
import { parseCommand, formatPph, formatExpress, formatSummary, formatBreaks, formatStore, formatHelp, formatBreakLog } from "./lib/commands.js";
import { readChannelMessages, postTextToWorkvivo } from "../metricshot/lib/sendbird.js";
import { isTrueAbsence, parseIvrName } from "../closinglist/lib/parse.js";
import { qrcallboxApiKey } from "../workvivo/service.js";
import { MAX_PAUSE_MIN } from "./lib/phone_control.js";
import { hashMeals } from "./lib/meal_hash.js";
import { claimPostSlot, completePostSlot, failPostSlot } from "../../shared/post_claims.js";
import { getUserHomeStore } from "../../shared/userStore.js";
import { isSelfChannel } from "../metricshot/lib/post_guard.js";
import { postOutcomeUnknown } from "../metricshot/lib/retry_policy.js";

const K = {
  settings: "digitaldashboard.gif.settings",
  summary:  "digitaldashboard.gif.summary",
  watch:    "digitaldashboard.gif.watch",
  store:    "digitaldashboard.gif.store",
  listen:   "digitaldashboard.gif.listenState",
  alerted:  "digitaldashboard.gif.alerted",
  punchReads: "digitaldashboard.gif.punchReads",   // { "day|NAME": ms } — when this module last read their punches
  punchTry:   "digitaldashboard.gif.punchTry",     // { "day|NAME": ms } — last attempt (throttle)
  autoPunchAt: "digitaldashboard.gif.autoPunchAt", // { day: ms } — Digital Metrics' hourly pull covered that day
};

// Digital Metrics classifications that count as "digital team" (vs Store Help).
const DIGITAL_CLASSES = new Set(["Digital", "Exceptions"]);

export const ALARM_NAMES = {
  sample: "digitaldashboard.sample",
  listen: "digitaldashboard.listen",
  absences: "digitaldashboard.absences",
};

export const DEFAULTS = {
  daemonUrl: "http://127.0.0.1:8770",
  source: "cloud",          // "cloud" = qrcallbox.com/api/gif; "pc" = the daemon above (being retired)
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

// The cloud twin of each daemon route (QRCallBox functions/src/http/gif/api.js).
// Cloud reads are cache-only, so maxAge/wait/pass/names are dropped: the
// cloud runs the break watch and roster steps itself from the board. Routes
// with no cloud twin answer as a no-op.
const CLOUD_ROUTES = {
  "/summary":     (p) => [`/summary?window=${encodeURIComponent(p.window ?? 60)}`],
  "/breaks":      () => ["/breaks"],
  "/breaklog":    (p) => [p.day ? `/breaklog?day=${encodeURIComponent(p.day)}` : "/breaklog"],
  "/store":       () => ["/store"],
  "/health":      () => [`/health?store=${HOME_STORE}`],
  "/phone/pause": (p) => ["/pause", { method: "POST", body: { minutes: Number(p.min) || 0 } }],
  "/punches":     () => null,   // pushMeals sends the hashed copy instead
  "/stop":        () => null,
};

async function cloudDaemon(path, params, timeoutMs) {
  const route = CLOUD_ROUTES[path]?.(params);
  if (route === undefined) throw Object.assign(new Error(`no cloud route for ${path}`), { kind: "DAEMON" });
  if (route === null) return { ok: true, skipped: "cloud" };
  const stop = keepAlive();
  try {
    const r = await Promise.race([
      gifCloud(...route),
      new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("Live pick data took too long — try again."), { kind: "TIMEOUT" })), timeoutMs)),
    ]);
    if (r?.ok === false) throw Object.assign(new Error(r.error || "Live pick data returned an error — try again."), { kind: "DAEMON" });
    return path === "/health" ? { ...r, source: "phone" } : r;   // the view's status pill keys on source
  } catch (e) {
    if (e.kind) throw e;
    throw Object.assign(new Error("Live pick data is offline."), { kind: "OFFLINE" });
  } finally { stop(); }
}

async function daemon(path, params = {}, { timeoutMs = 120_000 } = {}) {
  const { daemonUrl, source } = await getSettings();
  if (source === "cloud") return cloudDaemon(path, params, Math.min(timeoutMs, 30_000));
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
  // Board pickers vs picks still in GIF, hour by hour (lib/staffing.js).
  try {
    s.staffing = staffingPlan({ open: s.open, upcoming: s.upcoming, roster: await todaysRoster(), rate: s.storeKpis?.avgPickRate,
      pickingNow: s.storeKpis?.picking, active: activePickers({ picking: s.storeKpis?.picking, watch: s.watch, now: new Date() }),
      output: outputPickers(s.pph?.perHour, s.storeKpis?.avgPickRate), expressPerHour: s.express?.avgItemsPerHour, now: new Date() });
    // live pace per open due hour (due 30 min before the slot): need vs. picking now
    s.pace = slotPace({ open: s.open, rate: s.pph?.perHour, perPicker: s.staffing?.perPicker, now: new Date() });
  } catch (e) { console.warn("[digitaldashboard] staffing:", e?.message ?? e); }
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
  // Nobody over LUNCH_CHECK_MIN is reported until a punch read rules out lunch.
  const now = new Date(), day = isoDay(now);
  const punches = await lunchChecked(day, r?.suspects || [], {
    startOf: (x) => (x.over && x.lastSeen != null ? clockToMs(x.lastSeen, now) : null), outOf: (x) => x.idleMin });
  pushPunches(day, punches);
  const watch = { ...watchWithMeals(r, punches, day, { limitMin, now }), checkedAt: now.toISOString() };
  await lset(K.watch, watch);
  return watch;
}

export async function cachedWatch() { return lget(K.watch, null); }

// GTA punches Digital Metrics pulls hourly (PII, this browser only).
const CLOCK_KEY = "digitalmetrics.clockIns";
const CLOCK_STATE_KEY = "digitalmetrics.clockPullState";
const PUNCH_RETRY_MS = 5 * 60_000;

/** The day's punches, each with `_at` = when they were read (hourly pull or our own). */
async function punchesFor(day) {
  const got = await chrome.storage.local.get([CLOCK_KEY, CLOCK_STATE_KEY, K.punchReads, K.autoPunchAt]);
  const st = got[CLOCK_STATE_KEY], autoAt = { ...(got[K.autoPunchAt] || {}) };
  if (st?.auto && !st.error && st.from <= day && day <= st.to && st.store === HOME_STORE) {
    const at = Date.parse(st.at) - (st.ms || 0);   // reads happened during the pull
    if (at > (autoAt[day] || 0)) { autoAt[day] = at; await lset(K.autoPunchAt, autoAt); }
  }
  const reads = got[K.punchReads] || {};
  const out = {};
  for (const [name, p] of Object.entries(got[CLOCK_KEY]?.[HOME_STORE]?.[day] || {})) {
    out[name] = { ...p, _at: Math.max(autoAt[day] || 0, reads[`${day}|${name}`] || 0) };
  }
  return out;
}

/**
 * Read the timesheet now for anyone out over LUNCH_CHECK_MIN whose punches
 * were last read too early to show a lunch (Digital Metrics' clock-in pull,
 * a few seconds). Returns the day's punches afterwards. A failed read leaves
 * them unverified — held back, not reported.
 */
async function lunchChecked(day, items, { startOf, outOf }) {
  let punches = await punchesFor(day);
  const need = needsLunchCheck(items, punches, { checkOverMin: LUNCH_CHECK_MIN, startOf, outOf });
  if (!need.length) return punches;
  const tries = await lget(K.punchTry, {});
  const now = Date.now();
  // the timesheet name: the one already on file, else the grid's spelling
  const roster = (await assignments.get(HOME_STORE, day).catch(() => null))?.associates || [];
  const people = [...new Set(need.map((x) => Object.keys(punches).find((n) => sameName(n, x.name))
    || roster.find((r) => sameName(r.name, x.name))?.name || String(x.name).toUpperCase()))]
    .filter((n) => now - (tries[`${day}|${n}`] || 0) > PUNCH_RETRY_MS);
  if (!people.length) return punches;
  for (const n of people) tries[`${day}|${n}`] = now;
  await lset(K.punchTry, tries);
  const res = await metricsHandlers.pull_clockins({ store: HOME_STORE, from: day, to: day, people }).catch((e) => ({ error: e?.message }));
  if (res?.error) { console.warn("[digitaldashboard] lunch punch check:", res.error); return punches; }
  const reads = await lget(K.punchReads, {});
  for (const n of people) reads[`${day}|${n}`] = now;
  for (const k of Object.keys(reads)) if (k.slice(0, 10) < isoDay(new Date(now - 3 * 86_400_000))) delete reads[k];
  await lset(K.punchReads, reads);
  return punchesFor(day);
}

// The PC daemon answers most !commands; hand it the day's punches (minutes
// only, localhost, write-only route, memory only there) when they change.
let pushedPunches = "";
async function pushPunches(day, punches) {
  const set = {};
  // NAME: [clockIn, clockOut, mealOut, mealIn, readAt] — compact, it rides in the query string
  for (const [n, p] of Object.entries(punches)) if (p.clockIn != null) set[n] = [p.clockIn, p.clockOut, p.mealOut, p.mealIn, p._at];
  const sig = `${day}:${JSON.stringify(set)}`;
  if (sig === pushedPunches || !Object.keys(set).length) return;
  await daemon("/punches", { day, set: JSON.stringify(set) }, { timeoutMs: 8000 })
    .then(() => { pushedPunches = sig; }, (e) => console.warn("[digitaldashboard] punches → daemon:", e?.message ?? e));
  await pushMeals(day, punches);
}

// The cloud answerer (QRCallBox gif/meals.js) gets the same punches, but only
// the meal minutes and keyed by an HMAC of the name (lib/meal_hash.js).
let pushedMeals = "";
async function pushMeals(day, punches) {
  const set = {};
  for (const [n, p] of Object.entries(punches)) if (p.clockIn != null) set[n] = p;
  const sig = `${day}:${JSON.stringify(set)}`;
  if (sig === pushedMeals || !Object.keys(set).length) return;
  const k = await gifCloud("/meals/key");
  if (!k?.key) return console.warn("[digitaldashboard] meals → cloud: no key:", k?.error);
  const r = await gifCloud("/meals", { method: "POST", body: { store: HOME_STORE, day, meals: await hashMeals(k.key, set) } });
  if (r?.ok) pushedMeals = sig; else console.warn("[digitaldashboard] meals → cloud:", r?.error);
}

/**
 * The daemon's long-break log for one board day (default today). Cache only —
 * no GIF read. Punched meals are taken out (break_log.withMeals) so a lunch is
 * never reported as a long break, and nothing over LUNCH_CHECK_MIN is reported
 * before a punch read rules lunch out; `punches` says whether that day had any.
 */
export async function getBreakLog(day) {
  const r = await daemon("/breaklog", { day: /^\d{4}-\d{2}-\d{2}$/.test(day || "") ? day : null }, { timeoutMs: 10_000 });
  if (!r?.day || !Array.isArray(r.episodes)) return r;
  const now = Date.now();
  const punches = await lunchChecked(r.day, r.episodes, {
    startOf: (e) => e.lastSeenActiveAt ?? e.firstFlaggedAt,
    outOf: (e) => (e.status === "open" ? Math.round((now - (e.lastSeenActiveAt ?? e.firstFlaggedAt)) / 60_000) : episodeMinutes(e)) });
  pushPunches(r.day, punches);
  const limitMin = r.limitMin ?? (await getSettings()).limitMin;
  return { ...r, punches: Object.keys(punches).length > 0, episodes: withMeals(r.episodes, punches, r.day, { limitMin, now: r.lastAt || now }) };
}

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
  return `${s.name} has been out of a pick walk for ${s.mealMin ? `${s.netMin} minutes, not counting lunch` : `${s.idleMin} minutes`}.`;
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

  // One alert per person per reAlertMin window across every browser at the
  // store (the local `alerted` map only throttles THIS browser). Self-chats
  // ("@me") are per user, so they keep the local throttle only.
  const claimed = [];   // claimIds we hold for this batch
  let send = due;
  if (!isSelfChannel(channel)) {
    const store = await claimStore();
    const day = isoDay(new Date(now));
    const bucket = Math.floor(now / (Math.max(1, reAlertMin) * 60_000));
    send = [];
    for (const s of due) {
      // The slot is a hash, never the name: postClaims is plaintext Firestore.
      const c = await claimPostSlot({ store, kind: "dd:breakalert", slot: `${day}:${await nameHash(s.name)}:${bucket}`, channel });
      if (c.ok && (c.state === "held" || c.state === "sent")) { alerted[s.name] = now; continue; }   // another browser has it
      if (c.ok) claimed.push(c.claimId);
      // ok:false → FAIL OPEN (post as before): a missed alert about someone
      // long off the floor is worse than a duplicate line in the chat.
      send.push(s);
    }
    if (!send.length) { await lset(K.alerted, alerted); return { posted: 0, heldBack: over.length, claimedElsewhere: due.length }; }
  }

  const text = send.map(alertLine).join("\n");
  const res = await postTextToWorkvivo({ channelName: channel, text, reuseOnly: true });
  for (const id of claimed) {
    if (res.ok) await completePostSlot(id, { messageId: res.messageId });
    else await failPostSlot(id, { error: res.error, releaseLease: !postOutcomeUnknown(res) });
  }
  if (res.ok) for (const s of send) alerted[s.name] = now;
  if (res.ok || send.length < due.length) await lset(K.alerted, alerted);
  return { posted: res.ok ? send.length : 0, result: res };
}

// ── Shared post claims (shared/post_claims.js) ───────────────────
// Two browsers with the listener / auto-alert on used to both answer every
// !command and both post every break alert. Claims are per home store.
async function claimStore() {
  const s = await getUserHomeStore().catch(() => null);
  return s ? String(s) : "unknown";
}
/** 12 hex chars of SHA-256 — a stable, non-reversible-at-a-glance slot key. */
async function nameHash(name) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(name).trim().toUpperCase()));
  return [...new Uint8Array(buf)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
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
  if (cmd === "breaklog") {
    const r = await getBreakLog().catch((e) => ({ error: e.message }));
    return r.error ? `Couldn't read the break log: ${r.error}` : formatBreakLog(r.episodes, r.day, r.lastAt ? new Date(r.lastAt) : new Date(), { limitMin: r.limitMin });
  }
  if (cmd === "store") {
    const st = await getStore({ pass: true, wait: 150 }).catch((e) => ({ error: e.message }));
    return st.error ? `Couldn't read the roster: ${st.error}` : formatStore(st, new Date());
  }
  // pph / express / summary all need a summary
  const s = await refreshSummary({ maxAge: 120, wait: 90 }).catch((e) => ({ error: e.message }));
  if (s.error) return `Couldn't read GIF: ${s.error}`;
  if (cmd === "express") return formatExpress(s, new Date());
  if (cmd === "staffing") return staffingText(s.staffing, new Date(), s.pace);
  if (cmd === "summary") {
    const w = await cachedWatch();
    return [formatSummary(s, w, new Date()), s.pace?.[0] ? paceLine(s.pace[0]) : null, staffingLine(s.staffing)].filter(Boolean).join("\n");
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
  // Stand down whenever the daemon runs its chat at all — including while it is
  // backing off a relay 401 — because it answers the backlog itself once the
  // relay is back. Taking over in that window answered every command twice
  // (and re-answered the last 5 minutes) on 2026-10-09. Only a daemon that is
  // unreachable or has its chat switched off leaves the chat to this browser.
  // Cloud source: QRCallBox's gifChatAnswerer owns the chat once its mode is
  // "cloud" (and chat-fallback covers it when that answerer is down).
  if ((await getSettings()).source === "cloud") {
    if (h?.chat?.mode === "cloud" || !h) return { skipped: `cloud owns the chat (${h?.chat?.mode ?? "unreachable"})` };
  } else {
    const chatState = String(h?.chat?.state ?? "off");
    if (h && !/^off|stopped/.test(chatState)) return { skipped: `daemon owns the chat (${chatState})` };
  }

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
    // One reply per command across browsers: claim the command's message id
    // before doing the (slow) work. Held/sent → another browser answers.
    // ok:false (claim service unreachable) → FAIL OPEN and answer anyway: for
    // an interactive command a missed reply is worse than a duplicate.
    let claimId = null;
    if (m.messageId != null) {
      const c = await claimPostSlot({ store: await claimStore(), kind: "dd:reply", slot: String(m.messageId), channel });
      if (c.ok && (c.state === "held" || c.state === "sent")) continue;
      if (c.ok) claimId = c.claimId;
    }
    const reply = await answerCommand(cmd).catch((e) => `Error: ${e.message}`);
    const res = await postTextToWorkvivo({ channelName: channel, text: reply, reuseOnly: true });
    if (claimId) {
      if (res.ok) await completePostSlot(claimId, { messageId: res.messageId });
      else await failPostSlot(claimId, { error: res.error, releaseLease: !postOutcomeUnknown(res) });
    }
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
  await ensureAlarm(ALARM_NAMES.absences, { periodInMinutes: 10, delayInMinutes: 1 });
}

/**
 * Hand today's IVR call-ins to the GIF daemon for !performance (user,
 * 2026-10-09: "we can see real absences, the apaisuite already pulls it for
 * the closing list"). Reads closinglist's cached pull only — Live Dashboard
 * refreshes it hourly; nothing here opens IVR. Names + absence type only.
 */
const IVR_RESULT_KEY = "closinglist.ivrLastResult";   // closinglist/service.js RESULT_KEY
export async function pushAbsences() {
  const last = (await chrome.storage.local.get(IVR_RESULT_KEY))[IVR_RESULT_KEY];
  if (!last?.rows?.length) return { pushed: 0 };
  const day = isoDay(new Date(Date.now() - 5 * 3600_000));   // board day (5 AM rollover)
  const rows = [];
  for (const r of last.rows) {
    if (r.absence_date !== day || !isTrueAbsence(r.absence_type)) continue;
    const { first, last: lname } = parseIvrName(r.associate);
    if (first && lname) rows.push({ name: `${first} ${lname}`, type: r.absence_type });
  }
  const payload = { day, fetchedAt: last.fetchedAt ?? null, rows };
  const cloud = await gifCloud("/absences", { method: "POST", body: { store: HOME_STORE, ...payload } })
    .catch((e) => ({ ok: false, error: e?.message }));
  const { daemonUrl } = await getSettings();
  const res = await fetch(new URL("/absences", daemonUrl), { method: "POST", headers: { "content-type": "text/plain" },
    body: JSON.stringify(payload) }).catch(() => null);
  return { pushed: rows.length, ok: !!res?.ok, cloud: !!cloud?.ok };
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
  } else if (alarm.name === ALARM_NAMES.absences) {
    await pushAbsences().catch(() => {});   // daemon offline → next tick
  } else if (alarm.name === ALARM_NAMES.listen) {
    await pollListener().catch((e) => console.warn("[digitaldashboard] listener:", e?.message ?? e));
  }
}

export async function bootstrapIfNeeded() { await installAlarms().catch(() => {}); }

// ── Message handlers (view ↔ SW) ─────────────────────────────────

// ── Phone pairing ──────────────────────────────────────────────────────────
// QRCallBox mints a one-time code against the Workvivo module's X-API-Key; the
// user types it into GIF Companion, which trades it for the phone's own key
// (QRCallBox functions/src/http/gif/pair.js). Pairing alone doesn't move the
// phone off the PC daemon — its endpoint stays as set.
const GIF_API = "https://qrcallbox.com/api/gif";

async function gifCloud(path, { method = "GET", body } = {}) {
  const key = await qrcallboxApiKey();
  if (!key) return { ok: false, error: "No QRCallBox API key — set it in the Workvivo module first." };
  const res = await fetch(GIF_API + path, {
    method,
    headers: { "X-API-Key": key, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: out.error || `QRCallBox answered ${res.status}` };
  return out;
}

export const handlers = {
  "get_settings":    () => getSettings(),
  "set_settings":    (m) => setSettings(m?.patch || {}),
  "summary":         (m) => refreshSummary({ maxAge: m?.maxAge ?? 120, wait: m?.wait ?? 90 }),
  "cached_summary":  () => cachedSummary(),
  "check_breaks":    (m) => checkBreaks({ maxAge: m?.maxAge ?? 120, wait: m?.wait ?? 90 }),
  "cached_watch":    () => cachedWatch(),
  "break_log":       (m) => getBreakLog(m?.day),
  // One associate's long breaks as an Outlook draft (opened, filled, never sent).
  "break_email":     (m) => openOutlookDraft({ subject: String(m?.subject || ""), html: String(m?.html || "") }),
  "store":           (m) => getStore({ pass: m?.pass ?? true, budget: m?.budget ?? 5, wait: m?.wait ?? 160 }),
  "cached_store":    () => cachedStore(),
  "health":          () => daemon("/health", {}, { timeoutMs: 8000 }).then((h) => ({ ok: true, ...h })).catch((e) => ({ ok: false, error: e.message, kind: e.kind })),
  "stop_emulator":   () => daemon("/stop", {}, { timeoutMs: 15000 }),
  "poll_listener":   () => pollListener(),
  // Pause / resume the phone's GIF passes (min 0 resumes); the phone picks it up on its next check-in (~15 s).
  "phone_pause":     (m) => daemon("/phone/pause", { min: Math.max(0, Math.min(MAX_PAUSE_MIN, Number(m?.minutes) || 0)), by: "dashboard" }, { timeoutMs: 8000 }),
  "pair_phone":      () => gifCloud("/pair", { method: "POST", body: { store: HOME_STORE } }),
  "pair_status":     () => gifCloud("/pair"),
};
