// dev/gif-daemon.mjs
//
// Local data source for the Digital Dashboard (store 1458). Drives the GIF app
// in the headless `gif` emulator through dev/gif-reader.mjs and serves JSON on
// 127.0.0.1 only. The extension's service worker reads it (manifest already
// grants http://127.0.0.1/*), and so does the Workvivo !command listener.
//
// Why a daemon: an MV3 service worker cannot run adb, and GIF's backend is
// app-gated (see MEMORY.md::managed-phone-screen-access), so the real app in
// an emulator is the only source and something outside the browser has to
// drive it.
//
// Footprint: the emulator costs ~2 GB private / ~3.6 GB working set however
// small its guest RAM is, so it is NOT kept running. The daemon resumes it on
// the first request (snapshot `gifready`, a few seconds), unlocks it with the
// saved PIN, re-signs GIF in if its session lapsed, and stops it again after
// GIF_IDLE_MIN quiet minutes (default 10; 0 keeps it up).
//
// Run:   node dev/gif-daemon.mjs          (port 8770, or GIF_PORT)
// State: ~/tools/android-sdk/gif-state.json — local only, never the repo
//        (associate names live in it, and the repo is public).
//
// GET /health                         emulator + cache state
// GET /summary?maxAge=120&window=60   OPD reading folded into the day: picks
//                                     running total + last-hour rate, closed-
//                                     hour average/peak, express by slot
// GET /opd?maxAge=120                 the raw OPD Hourly reading
// GET /notactive?maxAge=90            on the clock but not active
// GET /assoc?name=First%20Last        one associate's detail
// GET /breaks?names=A|B&limit=18      scheduled pickers (names from the
//                                     assignment grid) who are not active,
//                                     with minutes since last seen
// GET /breaklog?day=YYYY-MM-DD        the day's long-break log (cache only;
//                                     default today, ~60 days kept)
// GET /punches?day=YYYY-MM-DD&set={}  the extension hands over that day's GTA
//                                     clock/meal minutes so !breaks/!breaklog
//                                     can leave lunches out and hold anything
//                                     over 45 min until one rules lunch out.
//                                     set = { NAME: [in, out, mealOut, mealIn, readAt] }.
//                                     WRITE-ONLY (responses carry CORS *),
//                                     memory only, today + yesterday.
// GET /stop                           stop the emulator now
// GET /phone/pause?min=30[&by=…]      pause the phone's GIF passes (min=0 resumes); handed
//                                     to the phone as `control` in its next ingest reply
//
// SOURCE (GIF_SOURCE, default "phone"): since 2026-10-09 the readings come
// from the GIF Companion app on a spare enrolled phone (APAISuite/gif-companion)
// instead of the emulator. The phone POSTs each reading to /api/gif/ingest over
// USB (`adb reverse tcp:8770 tcp:8770`, kept up by this daemon); reads the
// routes need on demand are queued and handed to the phone in the reply to its
// next check-in. The emulator is never started in phone mode. GIF_SOURCE=emulator
// restores the old path.
//
// POST /api/gif/ingest               phone uploads: { kind, status, data }
//                                     -> { ok, requests:[{id,kind,names}] }
//
// Also answers Workvivo !commands (dev/gif-chat.mjs) through QRCallBox's chat
// relay, so no browser tab has to stay open; /health reports it under "chat".

import http from "node:http";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ensureHome, readOpdHourly, readNotActive, readAssociateDetail, readAssociateDetails, readAllAssociates, setProgressHook } from "./gif-reader.mjs";
import { emptyRoster, mergeSnapshot, needsCheck, applyDetails, noteActivity, stopReadNames } from "../modules/digitaldashboard/lib/store_roster.js";
import { noteWalks, walkMixByName } from "../modules/digitaldashboard/lib/walk_log.js";
import {
  HOME_STORE, BREAK_LIMIT_MIN, recordReading, expressSummary, completedSummary,
  dayPicked, breakWatch, trackGaps, boardDayStart, boardDay, sameName,
} from "../modules/digitaldashboard/lib/gif_metrics.js";
import { rollingWindow, HOUR_MS } from "../modules/digitaldashboard/lib/pick_history.js";
import { mergeBreakLog, breakLogDay, breakLogDays } from "../modules/digitaldashboard/lib/break_log.js";
import { createChat } from "./gif-chat.mjs";
import { setPause, controlReply } from "../modules/digitaldashboard/lib/phone_control.js";

// Outbound HTTPS (QRCallBox chat relay, Firestore) has to go through the corp
// proxy, which re-signs TLS with an internal root CA. Node's fetch ignores
// HTTPS_PROXY and the Windows cert store unless told at startup, so re-launch
// once with both switched on. 127.0.0.1 (this daemon) stays direct.
if (!process.env.GIF_NET_READY) {
  const env = {
    ...process.env, GIF_NET_READY: "1", NODE_USE_ENV_PROXY: "1",
    HTTPS_PROXY: process.env.HTTPS_PROXY || "http://proxy.wal-mart.com:8075",
    NO_PROXY: [process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(","),
  };
  const child = spawn(process.execPath, ["--use-system-ca", ...process.argv.slice(1)], { env, stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 1));
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
  await new Promise(() => {});   // the child is the daemon from here on
}

const HOMEDIR = process.env.USERPROFILE || process.env.HOME;
const SDK = join(HOMEDIR, "tools", "android-sdk");
const ADB = join(SDK, "platform-tools", "adb.exe");
const START_CMD = join(SDK, "start-gif.cmd");
const PIN_FILE = join(SDK, ".emu-pin");
const STATE_FILE = join(SDK, "gif-state.json");
const PORT = Number(process.env.GIF_PORT || 8770);
const IDLE_MIN = Number(process.env.GIF_IDLE_MIN ?? 10);
const VERSION = "2";
const SOURCE = (process.env.GIF_SOURCE || "phone").toLowerCase();
const PHONE = SOURCE === "phone";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
// Leave a reason in the log when the daemon dies (the loop launcher restarts it).
process.on("uncaughtException", (e) => { log("CRASH:", e?.stack || e); process.exit(70); });
process.on("unhandledRejection", (e) => log("unhandled rejection:", e?.stack || e));
process.on("exit", (code) => log(`daemon exiting (code ${code})`));
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) process.on(sig, () => { log(`daemon stopped by ${sig}`); process.exit(0); });

// ── State ────────────────────────────────────────────────────────
let state = { history: null, gaps: {}, opd: null, opdAt: 0, notActive: null, notActiveAt: 0, watch: null, watchAt: 0, roster: null, rosterAt: 0, rosterUpdated: null };
try { if (existsSync(STATE_FILE)) state = { ...state, ...JSON.parse(readFileSync(STATE_FILE, "utf8")) }; } catch (e) { log("state load failed:", e.message); }
// GTA punches from the extension (/punches): PII, so memory only — never gif-state.json.
const punches = {};
function save() { try { writeFileSync(STATE_FILE, JSON.stringify(state)); } catch (e) { log("state save failed:", e.message); } }

// Per-day archive (gif-archive/<board day>.json): the walk cards, pick series and
// leaderboard are one day deep in state and reset when the board day changes. The
// Express pick-path study needs walk timing across days, so each day's copy is kept.
// Written at most every 5 min, and once more for the old day just before it rolls.
const ARCHIVE_DIR = join(SDK, "gif-archive");
const ARCHIVE_EVERY_MS = 5 * 60 * 1000;
let archivedAt = 0;
function archiveDay(force = false) {
  const day = state.walkLog?.day || state.history?.day;
  if (!day || (!force && Date.now() - archivedAt < ARCHIVE_EVERY_MS)) return;
  try {
    mkdirSync(ARCHIVE_DIR, { recursive: true });
    writeFileSync(join(ARCHIVE_DIR, `${day}.json`), JSON.stringify({
      v: 1, day, savedAt: Date.now(),
      walkLog: state.walkLog?.day === day ? state.walkLog : null,
      history: state.history?.day === day ? state.history : null,
      leaderboard: state.leaderboard?.day === day ? state.leaderboard : null,
      completed: state.opd?.completed ?? null,
    }));
    archivedAt = Date.now();
  } catch (e) { log("archive failed:", e.message); }
}
/** Call before folding a reading in: flushes the old day's archive when the board day changes. */
function archiveBeforeRoll(now) {
  const day = boardDay(new Date(now));
  if ((state.walkLog?.day && state.walkLog.day !== day) || (state.history?.day && state.history.day !== day)) archiveDay(true);
}

// ── Emulator ─────────────────────────────────────────────────────
function adb(args, timeout = 15000) {
  return execFileSync(ADB, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] });
}
function tryAdb(args, timeout) { try { return adb(args, timeout); } catch { return ""; } }

function emulatorBooted() {
  return tryAdb(["get-state"], 5000).trim() === "device" &&
         tryAdb(["shell", "getprop", "sys.boot_completed"], 5000).trim() === "1";
}

function userLocked() {
  return /RUNNING_LOCKED/.test(tryAdb(["shell", "dumpsys", "user"], 10000).split(/\r?\n/).find((l) => /State:/.test(l)) || "");
}

async function unlock() {
  const pin = existsSync(PIN_FILE) ? readFileSync(PIN_FILE, "utf8").trim() : "";
  for (let i = 0; i < 4 && userLocked(); i++) {
    if (!pin) throw new Error("emulator is locked and no PIN file");
    tryAdb(["shell", "input", "keyevent", "KEYCODE_WAKEUP"]);
    tryAdb(["shell", "input", "swipe", "540", "1700", "540", "400", "200"]);
    await sleep(1500);
    tryAdb(["shell", "input", "text", pin]);
    tryAdb(["shell", "input", "keyevent", "KEYCODE_ENTER"]);
    await sleep(2500);
  }
  if (userLocked()) throw new Error("could not unlock the emulator");
}

// Current step, for /health. setProgressHook lets the reader push its own
// fine-grained steps ("reading hour 7pm - 8pm") through the same field.
let phase = "idle";
function setPhase(p) { phase = p; if (p !== "idle") log("phase:", p); }
setProgressHook(setPhase);

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    const done = (v) => { s.destroy(); resolve(v); };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.setTimeout(1500, () => done(false));
  });
}

async function ensureEmulator() {
  if (!emulatorBooted()) {
    setPhase("waking emulator (snapshot resume)");
    log("starting emulator (snapshot resume)");
    // The PAC proxy server (port 8766) outlives the emulator; tell the start
    // script not to open another one when it is already answering.
    const pacUp = await portOpen(8766);
    spawn("cmd.exe", ["/c", START_CMD], {
      detached: true, stdio: "ignore", windowsHide: true,
      env: pacUp ? { ...process.env, GIF_PAC_UP: "1" } : process.env,
    }).unref();
    const until = Date.now() + 180_000;
    while (!emulatorBooted()) {
      if (Date.now() > until) throw new Error("emulator did not boot within 3 minutes");
      await sleep(3000);
    }
    await sleep(3000);
  }
  // keep the screen on while we drive it
  tryAdb(["shell", "svc", "power", "stayon", "true"]);
  setPhase("unlocking emulator");
  await unlock();
}

let idleTimer = null;
function armIdle() {
  if (PHONE) return;
  if (idleTimer) clearTimeout(idleTimer);
  if (!IDLE_MIN) return;
  idleTimer = setTimeout(() => { if (!busy) stopEmulator("idle"); }, IDLE_MIN * 60_000);
}
function stopEmulator(why) {
  if (PHONE) return false;   // plain adb would target the phone, not an emulator
  if (!emulatorBooted()) return false;
  log(`stopping emulator (${why})`);
  tryAdb(["emu", "kill"], 10000);
  return true;
}

// ── One GIF pass at a time ───────────────────────────────────────
let queue = Promise.resolve();
let busy = null;
// GIF's SSO landed on the password form: no pass can succeed until someone
// signs in by hand, so stop the emulator and refuse passes for a while rather
// than hold ~2 GB tapping "Sign in" all afternoon.
const SIGNIN_RETRY_MIN = 30;
let signinBlockedUntil = 0;
function run(what, fn) {
  if (PHONE) {
    // The phone serialises its own reads; here a request only waits for its answer.
    return (async () => { busy = what; try { return await fn(); } finally { busy = null; } })();
  }
  const p = queue.then(async () => {
    if (Date.now() < signinBlockedUntil) {
      throw new Error(`GIF needs a manual sign-in — next try ${new Date(signinBlockedUntil).toLocaleTimeString()}`);
    }
    busy = what;
    try {
      await ensureEmulator();
      await ensureHome();
      return await fn();
    } catch (e) {
      if (e.code === "NEEDS_SIGNIN") {
        signinBlockedUntil = Date.now() + SIGNIN_RETRY_MIN * 60_000;
        stopEmulator("needs sign-in");
      }
      throw e;
    } finally { busy = null; setPhase("idle"); armIdle(); }
  });
  queue = p.catch(() => {});
  return p;
}

const fresh = (at, maxAgeSec) => at && Date.now() - at < maxAgeSec * 1000;

// One in-flight refresh per kind; callers share it.
const jobs = {};
function refresh(kind, fn) {
  if (!jobs[kind]) jobs[kind] = run(kind, fn).finally(() => { delete jobs[kind]; });
  return jobs[kind];
}

/**
 * Stale-while-revalidate. Fresh cache → return it. Otherwise start (or join)
 * the refresh and wait up to `waitSec` for it; past that, hand back the cached
 * value marked stale while the refresh carries on. The extension's service
 * worker passes a short wait because Chrome may stop a worker that sits on one
 * request for minutes. With nothing cached at all there is nothing to hand
 * back, so the caller waits for the read regardless.
 */
async function cachedOrFresh({ at, value, maxAge, waitSec, kind, fn, cacheOnly }) {
  if (value != null && fresh(at, maxAge)) return { value, stale: false, refreshing: !!jobs[kind] };
  // ?cached=1 (chat commands): answer from the phone's last reading, never start a read
  if (cacheOnly) {
    if (value == null) throw new Error("no GIF reading yet — the phone hasn't reported since the daemon started");
    return { value, stale: true, refreshing: !!jobs[kind] };
  }
  const p = refresh(kind, fn).then((v) => ({ v }), (e) => ({ e }));
  const limit = value == null ? 600 : waitSec;
  const done = await Promise.race([p, sleep(limit * 1000).then(() => null)]);
  if (done?.v !== undefined) return { value: done.v, stale: false, refreshing: false };
  if (done?.e && value == null) throw done.e;
  return { value, stale: true, refreshing: !done, error: done?.e?.message };
}

const readOpd = async () => {
  const opd = await R.readOpdHourly();
  archiveBeforeRoll(Date.now());
  state.opd = opd; state.opdAt = Date.now();
  state.history = recordReading(state.history, opd, new Date());
  save();
  archiveDay();
  return opd;
};
const getOpd = (maxAge, waitSec = 600, cacheOnly = false) =>
  cachedOrFresh({ at: state.opdAt, value: state.opd, maxAge, waitSec, kind: "opd", fn: readOpd, cacheOnly });

const readNA = async () => {
  const r = await R.readNotActive();
  state.notActive = r; state.notActiveAt = Date.now(); save();
  return r;
};
const getNotActive = (maxAge, waitSec = 600) =>
  cachedOrFresh({ at: state.notActiveAt, value: state.notActive, maxAge, waitSec, kind: "notactive", fn: readNA });

/**
 * One accumulation pass over the day's roster: refresh everyone's status from
 * the cheap All list, then drill details for only the few who still need a
 * count (active, newly seen, or just reactivated — store_roster.needsCheck).
 * Over many passes the whole table fills in a few reads at a time; settled
 * (inactive, confirmed) associates are never re-read. budget caps reads/pass.
 */
/** One associate-detail read → the facts the roster keeps (picks + performance). */
const num = (v) => { const x = Number(String(v ?? "").replace(/,/g, "")); return v == null || v === "" || !Number.isFinite(x) ? undefined : x; };
function detailFacts(d) {
  if (!d || d.error) return { error: d?.error || "no reading" };
  return { picks: num(d.qtyPicked), rate: num(d.avgPickRate), walks: num(d.pickwalksCompleted), orders: num(d.ordersPicked) };
}

async function storePass(budget = 5) {
  const all = await R.readAllAssociates();
  const day = boardDay(new Date());
  let roster = state.roster && state.roster.day === day ? state.roster : emptyRoster(day);
  roster = mergeSnapshot(roster, { day, seen: all.seen }, Date.now());
  const names = needsCheck(roster, { budget, now: Date.now() });
  const details = names.length ? await R.readAssociateDetails(names) : {};
  const picks = {};
  for (const [n, d] of Object.entries(details)) picks[n] = detailFacts(d);
  roster = applyDetails(roster, picks, Date.now());
  state.roster = roster; state.rosterAt = Date.now();
  state.rosterUpdated = all.lastUpdated ?? state.rosterUpdated ?? null;
  save();
  return roster;
}

/**
 * Totals on stop (user, 2026-10-09): once a minute, read the pick total of up to
 * STOP_READS_PER_MIN people who have stopped picking (10+ min on Not active, or
 * off GIF's list) since their last read — scheduled pickers + store help only
 * (gif-chat sends that scope). No hourly burst; commands never start a read.
 */
const STOP_READS_PER_MIN = 2;
let stopReading = false;
async function stopReads() {
  if (stopReading || !state.roster || !state.scope?.length) return;
  const scope = state.scope;
  const names = stopReadNames(state.roster, { allowed: (n) => scope.some((o) => sameName(o, n)) }).slice(0, STOP_READS_PER_MIN);
  if (!names.length) return;
  stopReading = true;
  try {
    const details = await R.readAssociateDetails(names);
    const picks = {};
    for (const [n, d] of Object.entries(details)) picks[n] = detailFacts(d);
    state.roster = applyDetails(state.roster, picks, Date.now());
    state.rosterAt = Date.now(); save();
    log(`store: totals read on stop — ${Object.values(picks).filter((p) => !p.error).length}/${names.length}`);
  } catch (e) { log("store: stop read failed:", e.message); }
  finally { stopReading = false; }
}

/** Not-active list, then one batched detail trip for the scheduled ones in it. */
async function breaksPass(names, limit) {
  const na = await R.readNotActive();
  // Phone mode: R returns the phone's own (timestamped) reading — re-stamping
  // it here would make an old list look fresh. The emulator reader is a live read.
  if (!PHONE) { state.notActive = na; state.notActiveAt = Date.now(); }
  const notActive = na?.notActive || [];
  const suspects = notActive.filter((g) => names.some((s) => sameName(s, g)));
  // Someone's last scan can't change while they stay not active, so read it
  // once per inactive stretch: keep cached details for names still on the
  // list, drop the rest (they picked again — the next stretch needs a new
  // read), and read only the new suspects.
  const cache = {};
  for (const [n, d] of Object.entries(state.breakDetails || {})) if (notActive.includes(n) && !d?.error) cache[n] = d;
  const fresh = suspects.filter((n) => !cache[n]);
  if (fresh.length) {
    const got = await R.readAssociateDetails(fresh);
    Object.assign(cache, got);
    if (state.roster) state.roster = applyDetails(state.roster, Object.fromEntries(Object.entries(got).map(([n, d]) => [n, detailFacts(d)])), Date.now());
  }
  state.breakDetails = cache;
  const details = Object.fromEntries(suspects.map((n) => [n, cache[n]]));
  const now = new Date();
  const watch = breakWatch({ scheduled: names, notActive: na?.notActive || [], details, now, limitMin: limit });
  state.gaps = trackGaps(state.gaps, watch, now);
  state.watch = { ...watch, names, notActiveUpdated: na?.lastUpdated ?? null };
  // every watch run (background or asked) feeds the day's long-break log
  state.breakLog = mergeBreakLog(state.breakLog, state.watch, now);
  state.watchAt = Date.now(); save();
  return state.watch;
}

function summarize(windowMin) {
  const now = new Date();
  // A reading from before today's 5 AM rollover is yesterday's: answer with no
  // reading rather than serve its totals as today's (user, 2026-10-10: !pph
  // showed yesterday's metrics while the phone was stalled).
  const today = state.opdAt >= boardDayStart(now);
  const opd = today ? state.opd : null, hist = today ? state.history : null;
  const series = hist?.series || [];
  const rate = series.length >= 2 ? rollingWindow(series, windowMin * 60_000) : null;
  return {
    store: HOME_STORE,
    asOf: today ? new Date(state.opdAt).toISOString() : null,
    readyToPick: opd?.readyToPick ?? null,
    dayPicked: dayPicked(opd),
    open: opd?.hours || [],
    // later due-hours (OPD "Upcoming Picks") and My Store's dashboard figures
    // (phone mode only — the emulator reader never captured them)
    upcoming: opd?.upcoming || [],
    storeKpis: opd?.store || null,
    phone: PHONE ? { lastSeenSec: phone.lastSeenAt ? Math.round((Date.now() - phone.lastSeenAt) / 1000) : null, state: phone.status?.state ?? null, code: phone.status?.code ?? null, error: phone.status?.error ?? null } : null,
    completed: completedSummary(opd),
    completedHours: opd?.completed || [],
    pph: rate && {
      perHour: Math.round(rate.perHour), picked: rate.picked,
      spanMin: Math.round(rate.spanMs / 60000), full: rate.full, windowMin,
    },
    express: expressSummary(hist, now),
    // latest break watch: staffing counts scheduled pickers between walks (< 10 min idle) as active
    watch: state.watch ? { checkedAt: state.watch.checkedAt, suspects: (state.watch.suspects || []).map(({ name, idleMin, over }) => ({ name, idleMin, over })) } : null,
    // for the dashboard's per-clock-hour chart and the Pick Hours archive
    series, dayStart: boardDayStart(now), hourMs: HOUR_MS,
  };
}

// ── Phone link (GIF Companion) ───────────────────────────────────
// Readings arrive on the phone's own schedule (status ~1 min, OPD ~2 min,
// roster ~15 min). A route that needs something fresher queues a request; the
// phone collects it from the reply to its next upload/heartbeat (~15 s) and
// answers with a reading carrying data.requestId.
const phone = { lastSeenAt: 0, status: null, appVersion: null };
const pending = [];   // { id, kind, names, sentAt, resolve, reject, timer, promise }
let reqSeq = 0;

function askPhone(kind, names = [], timeoutSec = 120) {
  if (kind !== "assoc") {
    const same = pending.find((p) => p.kind === kind);
    if (same) return same.promise;
  }
  const r = { id: `r${++reqSeq}`, kind, names, sentAt: 0 };
  r.promise = new Promise((resolve, reject) => {
    r.resolve = resolve; r.reject = reject;
    r.timer = setTimeout(() => {
      const i = pending.indexOf(r);
      if (i >= 0) pending.splice(i, 1);
      reject(new Error(Date.now() - phone.lastSeenAt > 120_000
        ? "the GIF phone is not reporting (USB unplugged, app off, or GIF signed out)"
        : `the GIF phone did not answer the ${kind} read in ${timeoutSec}s`));
    }, timeoutSec * 1000);
  });
  pending.push(r);
  return r.promise;
}

// A cached phone reading is good enough while it is no older than the phone's
// own cadence for it; asking again would only queue a duplicate read.
const PHONE_FRESH_SEC = { opd: 180, notactive: 200, all: 20 * 60 };   // phone: status every 3 min, OPD 2, roster 15
async function cachedOrAsk(kind, value, at) {
  if (value && Date.now() - at < PHONE_FRESH_SEC[kind] * 1000) return value;
  return askPhone(kind, [], kind === "all" ? 150 : 120);
}

const phoneReader = {
  readOpdHourly: () => cachedOrAsk("opd", state.opd, state.opdAt),
  readNotActive: () => cachedOrAsk("notactive", state.notActive, state.notActiveAt),
  readAllAssociates: () => cachedOrAsk("all", state.all, state.allAt),
  readAssociateDetails: async (names) => (await askPhone("assoc", names, 60 + 15 * names.length))?.details || {},
  readAssociateDetail: async (name) => {
    const d = (await askPhone("assoc", [name], 75))?.details?.[name];
    if (!d || d.error) throw new Error(d?.error || `no detail for ${name}`);
    return d;
  },
};
const R = PHONE ? phoneReader
  : { readOpdHourly, readNotActive, readAllAssociates, readAssociateDetails, readAssociateDetail };

function ingest(msg) {
  const now = Date.now();
  phone.lastSeenAt = now;
  phone.status = msg.status || phone.status;
  phone.appVersion = msg.appVersion || phone.appVersion;
  const data = msg.data && typeof msg.data === "object" ? { ...msg.data } : null;
  const reqId = data?.requestId;
  if (data) delete data.requestId;
  if (data) {
    switch (msg.kind) {
      case "opd":
        archiveBeforeRoll(now);
        state.opd = data; state.opdAt = now;
        state.history = recordReading(state.history, data, new Date(now));
        state.walkLog = noteWalks(state.walkLog, data.hours, now, boardDay(new Date(now)));   // walk types per picker (!performance)
        break;
      case "notactive":
        state.notActive = data; state.notActiveAt = now;
        if (state.roster) state.roster = noteActivity(state.roster, data.notActive || [], now);
        break;
      case "all": {
        state.all = data; state.allAt = now;
        const day = boardDay(new Date(now));
        const roster = state.roster && state.roster.day === day ? state.roster : emptyRoster(day);
        state.roster = mergeSnapshot(roster, { day, seen: data.seen || [] }, now);
        state.rosterUpdated = data.lastUpdated ?? state.rosterUpdated ?? null;
        break;
      }
      case "leaderboard":   // My Associates → Leaderboard: everyone's pick rate today (!performance)
        state.leaderboard = { day: boardDay(new Date(now)), at: now, rows: data.rows || [], missing: data.missing ?? 0, storeTarget: data.storeTarget ?? null };
        break;
    }
    save();
    if (msg.kind === "opd" || msg.kind === "leaderboard") archiveDay();
    log(`phone: ${msg.kind}${reqId ? ` (${reqId})` : ""}`);
  }
  if (reqId) {
    const i = pending.findIndex((p) => p.id === reqId);
    if (i >= 0) { const [r] = pending.splice(i, 1); clearTimeout(r.timer); r.resolve(data); }
  } else if (data && msg.kind !== "assoc") {
    // A scheduled reading also satisfies a waiting request for the same kind.
    for (const r of pending.filter((p) => p.kind === msg.kind)) {
      pending.splice(pending.indexOf(r), 1); clearTimeout(r.timer); r.resolve(data);
    }
  }
  // Hand out requests not sent yet, or sent >90 s ago without an answer (the
  // phone may have dropped them in a failed pass).
  const out = [];
  for (const r of pending) {
    if (r.sentAt && now - r.sentAt < 90_000) continue;
    r.sentAt = now;
    out.push({ id: r.id, kind: r.kind, names: r.names });
  }
  return { ok: true, requests: out, control: controlReply(state.phoneControl) };
}

function phoneHealth() {
  return {
    lastSeenAt: phone.lastSeenAt || null,
    lastSeenSec: phone.lastSeenAt ? Math.round((Date.now() - phone.lastSeenAt) / 1000) : null,
    appVersion: phone.appVersion, status: phone.status, reverse: reverseOk,
    control: controlReply(state.phoneControl),
    pending: pending.map((p) => ({ id: p.id, kind: p.kind, names: p.names.length, sent: !!p.sentAt })),
    allAt: state.allAt || null,
  };
}

function body(req) {
  return new Promise((resolve, reject) => {
    let b = ""; req.setEncoding("utf8");
    req.on("data", (c) => { b += c; if (b.length > 2_000_000) { reject(new Error("body too large")); req.destroy(); } });
    req.on("end", () => resolve(b)); req.on("error", reject);
  });
}

// `adb reverse` lets the phone reach this daemon at 127.0.0.1:8770 over USB.
// It dies with every replug / adb restart, so re-assert it every 30 s.
function phoneSerial() {
  if (process.env.GIF_PHONE) return process.env.GIF_PHONE;
  const lines = tryAdb(["devices"], 5000).split(/\r?\n/).slice(1);
  const dev = lines.map((l) => l.trim().split(/\s+/)).find(([sn, st]) => sn && st === "device" && !sn.startsWith("emulator-"));
  return dev ? dev[0] : null;
}
function adbServerUp() {
  return new Promise((resolve) => {
    const s = net.connect(5037, "127.0.0.1");
    const done = (up) => { s.destroy(); resolve(up); };
    s.once("connect", () => done(true)); s.once("error", () => done(false));
    s.setTimeout(1500, () => done(false));
  });
}
let reverseOk = null;
async function keepReverse() {
  // No adb server (e.g. after a PC reboot): any adb call through execFileSync
  // forks one that inherits our stdout pipe, so the call times out and kills
  // it. Start one detached with no pipes and check again next tick.
  if (!process.env.GIF_PHONE && !(await adbServerUp())) {
    log("phone: adb server not running - starting it");
    try { spawn(ADB, ["start-server"], { stdio: "ignore", detached: true, windowsHide: true }).unref(); } catch {}
    reverseOk = false;
    return;
  }
  const sn = phoneSerial();
  if (!sn) { if (reverseOk !== false) log("phone: not connected over USB"); reverseOk = false; return; }
  try {
    adb(["-s", sn, "reverse", `tcp:${PORT}`, `tcp:${PORT}`], 8000);
    if (reverseOk !== true) log(`phone: adb reverse tcp:${PORT} -> ${sn}`);
    reverseOk = true;
  } catch (e) {
    if (reverseOk !== false) log("phone: adb reverse failed:", String(e.message).split("\n")[0]);
    reverseOk = false;
  }
}
if (PHONE) { keepReverse(); setInterval(keepReverse, 30_000); setInterval(() => stopReads(), 60_000); }

// ── HTTP ─────────────────────────────────────────────────────────
function send(res, code, body) {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const q = (k, d) => u.searchParams.get(k) ?? d;
  try {
    switch (u.pathname) {
      case "/":
        return send(res, 200, {
          service: "gif-daemon", store: HOME_STORE,
          routes: {
            "/health": "emulator + cache state",
            "/summary": "picks today, live picks/hr, closed-hour avg/peak, express by hour (?maxAge=120&window=60)",
            "/opd": "raw OPD Hourly reading (?maxAge=120)",
            "/notactive": "on the clock but not active (?maxAge=90)",
            "/assoc?name=First Last": "one associate's detail",
            "/leaderboard[?read=1]": "today's pick rate for everyone (cached; read=1 asks the phone)",
            "/breaks?names=First Last|First Last": "scheduled pickers not active, minutes since last seen (?limit=18)",
            "/store": "day roster: every active associate + picks (accumulated; ?pass=1 to advance, ?budget=N)",
            "/breaklog?day=YYYY-MM-DD": "the day's long-break log, one row per stretch (cache only; default today)",
            "/stop": "stop the emulator now",
            "/phone/pause?min=30": "pause the phone's GIF passes for N min (0 resumes)",
          },
        });
      case "/health":
        return send(res, 200, {
          ok: true, version: VERSION, store: HOME_STORE, busy, phase, idleMin: IDLE_MIN,
          source: SOURCE,
          emulator: PHONE ? "retired (phone mode)" : emulatorBooted() ? "up" : "down",
          phone: PHONE ? phoneHealth() : undefined,
          needsSignin: Date.now() < signinBlockedUntil ? signinBlockedUntil : null,
          chat: chat ? chat.status() : { state: "off" },
          cloudTee: { ...tee },
          opdAt: state.opdAt || null, notActiveAt: state.notActiveAt || null, watchAt: state.watchAt || null,
        });
      case "/opd": {
        const r = await getOpd(Number(q("maxAge", 120)), Number(q("wait", 600)));
        return send(res, 200, { ...r.value, stale: r.stale, refreshing: r.refreshing });
      }
      case "/summary": {
        const r = await getOpd(Number(q("maxAge", 120)), Number(q("wait", 600)), q("cached") === "1");
        return send(res, 200, { ...summarize(Number(q("window", 60))), stale: r.stale, refreshing: r.refreshing, error: r.error });
      }
      case "/notactive": {
        const r = await getNotActive(Number(q("maxAge", 90)), Number(q("wait", 600)));
        return send(res, 200, { ...r.value, stale: r.stale, refreshing: r.refreshing });
      }
      case "/assoc": {
        const name = q("name", "");
        if (!name) return send(res, 400, { error: "name required" });
        return send(res, 200, await run(`assoc ${name}`, () => R.readAssociateDetail(name)));
      }
      case "/details": {
        // manual only (user, 2026-10-19: "force a check on everyone assigned
        // to pick") — one batched phone trip; picks land on the roster that
        // !performance reads. Chat commands never call this.
        const names = q("names", "").split("|").map((s) => s.trim()).filter(Boolean);
        if (!names.length) return send(res, 400, { error: "names required" });
        return send(res, 200, await run(`details ${names.length}`, async () => {
          const got = await R.readAssociateDetails(names);
          const picks = Object.fromEntries(Object.entries(got).map(([n, d]) => [n, detailFacts(d)]));
          if (state.roster) { state.roster = applyDetails(state.roster, picks, Date.now()); state.rosterAt = Date.now(); save(); }
          log(`store: forced detail read — ${Object.values(picks).filter((p) => !p.error).length}/${names.length}`);
          return { read: Object.keys(got).length, details: got };
        }));
      }
      case "/breaks": {
        // names = who the assignment grid has on PICK this hour (the caller
        // knows the grid; the daemon only knows GIF).
        const names = q("names", "").split("|").map((s) => s.trim()).filter(Boolean);
        const limit = Number(q("limit", BREAK_LIMIT_MIN));
        const key = names.slice().sort().join("|");
        const cached = state.watch && state.watch.names?.slice().sort().join("|") === key ? state.watch : null;
        const r = await cachedOrFresh({
          at: cached ? state.watchAt : 0, value: cached, maxAge: Number(q("maxAge", 120)),
          waitSec: Number(q("wait", 600)), kind: `breaks:${key}`, fn: () => breaksPass(names, limit),
        });
        return send(res, 200, { ...r.value, gaps: state.gaps, stale: r.stale, refreshing: r.refreshing, error: r.error });
      }
      case "/breaklog": {
        // cache only — never starts a GIF read
        const now = new Date();
        const day = /^\d{4}-\d{2}-\d{2}$/.test(q("day", "")) ? q("day") : boardDay(now);
        return send(res, 200, {
          day, today: boardDay(now), limitMin: state.watch?.limitMin ?? BREAK_LIMIT_MIN,
          lastAt: state.breakLog?.lastAt || null, days: breakLogDays(state.breakLog),
          episodes: breakLogDay(state.breakLog, day, now),
        });
      }
      case "/punches": {
        const day = q("day", "");
        let set = null;
        try { set = JSON.parse(q("set", "")); } catch { /* bad payload */ }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !set || typeof set !== "object") return send(res, 400, { error: "day and set required" });
        // NAME: [clockIn, clockOut, mealOut, mealIn, readAt] (digitaldashboard/service.js pushPunches)
        punches[day] = Object.fromEntries(Object.entries(set).filter(([, v]) => Array.isArray(v)).map(([n, [clockIn, clockOut, mealOut, mealIn, _at]]) =>
          [n, { clockIn, clockOut, mealOut, mealIn, _at }]));
        for (const d of Object.keys(punches)) if (d < boardDay(new Date(Date.now() - 2 * 86_400_000))) delete punches[d];
        return send(res, 200, { ok: true, n: Object.keys(set).length });
      }
      case "/scope": {
        // who gets totals read on stop: today's board PICK names + store help (gif-chat, every 10 min)
        state.scope = q("names", "").split("|").map((x) => x.trim()).filter(Boolean);
        return send(res, 200, { scope: state.scope.length });
      }
      case "/store": {
        // ?pass=1 runs one accumulation pass (reads the All list + a few
        // details); otherwise returns the roster built up so far. The SW adds
        // the digital/store-help coding (classifications are browser-only).
        if (q("pass")) await run("store", () => storePass(Number(q("budget", 5))));
        const roster = state.roster || emptyRoster(boardDay(new Date()));
        return send(res, 200, {
          day: roster.day, roster,
          storeTotal: dayPicked(state.opd),
          leaderboard: state.leaderboard?.day === roster.day ? state.leaderboard : null,
          absences: state.absences?.day === roster.day ? state.absences : null,
          walkMix: state.walkLog?.day === roster.day ? walkMixByName(state.walkLog) : {},
          lastUpdated: state.rosterUpdated ?? null,
          asOf: state.rosterAt || null,
        });
      }
      case "/absences": {
        // POST from the Digital Dashboard SW: today's IVR call-ins (closinglist's
        // cached pull — no scrape here). Kept in memory/state only, names + type.
        if (req.method === "POST") {
          const j = JSON.parse(await body(req) || "{}");
          state.absences = { day: j.day || boardDay(new Date()), at: Date.now(), fetchedAt: j.fetchedAt ?? null, rows: Array.isArray(j.rows) ? j.rows.slice(0, 200) : [] };
          save();
          return send(res, 200, { ok: true, count: state.absences.rows.length });
        }
        return send(res, 200, state.absences || { rows: [] });
      }
      case "/leaderboard": {
        // cached by default (commands never read); ?read=1 asks the phone for one now (manual/testing)
        if (q("read") === "1" && PHONE) await askPhone("leaderboard", [], 150);
        return send(res, 200, state.leaderboard || { rows: [] });
      }
      case "/api/gif/ingest": {
        if (req.method !== "POST") return send(res, 405, { error: "POST only" });
        if (!PHONE) return send(res, 409, { error: "daemon is in emulator mode" });
        const msg = JSON.parse(await body(req));
        teeToCloud(msg);
        return send(res, 200, ingest(msg));
      }
      case "/stop":
        return send(res, 200, { stopped: stopEmulator("requested") });
      case "/phone/pause": {
        if (!PHONE) return send(res, 409, { error: "daemon is in emulator mode" });
        state.phoneControl = setPause(state.phoneControl, q("min", "0"), q("by", "dashboard"));
        save();
        log(`phone: ${state.phoneControl.pauseUntil ? `pause until ${new Date(state.phoneControl.pauseUntil).toLocaleTimeString()}` : "resume"} (${state.phoneControl.by})`);
        return send(res, 200, { ok: true, control: controlReply(state.phoneControl) });
      }
      default:
        return send(res, 404, { error: "unknown path" });
    }
  } catch (e) {
    log(`${u.pathname} failed:`, e.message);
    return send(res, 500, { error: e.message, path: u.pathname });
  }
});

// Cloud migration (2026-10-24): copy every phone upload to QRCallBox's
// /api/gif/ingest so the cloud answerer can run in "dry" mode on the same
// readings. The cloud's queued requests in its reply are ignored: the phone
// takes requests from the daemon only, and the cloud still sees those reads
// arrive. GIF_CLOUD_TEE=0 turns it off.
const TEE_URL = "https://qrcallbox.com/api/gif/ingest";
const TEE_KEY_FILE = join(SDK, ".qrcallbox-key");
const tee = { on: process.env.GIF_CLOUD_TEE !== "0" && existsSync(TEE_KEY_FILE), sent: 0, failed: 0, lastOkAt: null, lastError: null };
let teeWarnedAt = 0;
function teeToCloud(msg) {
  if (!tee.on) return;
  const key = readFileSync(TEE_KEY_FILE, "utf8").trim();
  fetch(TEE_URL, {
    method: "POST", signal: AbortSignal.timeout(20_000),
    headers: { "Content-Type": "application/json", "X-API-Key": key },
    body: JSON.stringify({ store: HOME_STORE, ...msg }),
  }).then(async (r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text().catch(() => "")).slice(0, 120)}`);
    tee.sent++; tee.lastOkAt = Date.now(); tee.lastError = null;
  }).catch((e) => {
    tee.failed++; tee.lastError = e.message;
    if (Date.now() - teeWarnedAt > 10 * 60_000) { teeWarnedAt = Date.now(); log(`cloud tee: ${e.message}`); }
  });
}

let chat = null;
server.listen(PORT, "127.0.0.1", () => {
  log(`gif-daemon on http://127.0.0.1:${PORT} (store ${HOME_STORE}, source ${SOURCE}${PHONE ? "" : `, idle stop ${IDLE_MIN || "off"} min`})`);
  // Workvivo !commands through QRCallBox's chat relay (dev/gif-chat.mjs);
  // GIF_CHAT=0 turns it off. A .gif-chat-cloud marker in the SDK folder means
  // qrcallbox.com answers: report "standby" (not "off") so a browser on the
  // "This PC" source still stands down instead of answering a second time.
  if (existsSync(join(SDK, ".gif-chat-cloud"))) { chat = { status: () => ({ state: "standby", owner: "qrcallbox.com" }) }; log("chat: standby (qrcallbox.com answers)"); }
  else if (process.env.GIF_CHAT !== "0") { chat = createChat({ port: PORT, log, punchesFor: (day) => punches[day] || {} }); chat.start(); }
});
