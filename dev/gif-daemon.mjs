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
// GET /stop                           stop the emulator now
//
// Also answers Workvivo !commands (dev/gif-chat.mjs) through QRCallBox's chat
// relay, so no browser tab has to stay open; /health reports it under "chat".

import http from "node:http";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ensureHome, readOpdHourly, readNotActive, readAssociateDetail, readAssociateDetails, readAllAssociates, setProgressHook } from "./gif-reader.mjs";
import { emptyRoster, mergeSnapshot, needsCheck, applyDetails } from "../modules/digitaldashboard/lib/store_roster.js";
import {
  HOME_STORE, BREAK_LIMIT_MIN, recordReading, expressSummary, completedSummary,
  dayPicked, breakWatch, trackGaps, boardDayStart, boardDay, sameName,
} from "../modules/digitaldashboard/lib/gif_metrics.js";
import { rollingWindow, HOUR_MS } from "../modules/digitaldashboard/lib/pick_history.js";
import { createChat } from "./gif-chat.mjs";

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
const VERSION = "1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

// ── State ────────────────────────────────────────────────────────
let state = { history: null, gaps: {}, opd: null, opdAt: 0, notActive: null, notActiveAt: 0, watch: null, watchAt: 0, roster: null, rosterAt: 0, rosterUpdated: null };
try { if (existsSync(STATE_FILE)) state = { ...state, ...JSON.parse(readFileSync(STATE_FILE, "utf8")) }; } catch (e) { log("state load failed:", e.message); }
function save() { try { writeFileSync(STATE_FILE, JSON.stringify(state)); } catch (e) { log("state save failed:", e.message); } }

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
  if (idleTimer) clearTimeout(idleTimer);
  if (!IDLE_MIN) return;
  idleTimer = setTimeout(() => { if (!busy) stopEmulator("idle"); }, IDLE_MIN * 60_000);
}
function stopEmulator(why) {
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
async function cachedOrFresh({ at, value, maxAge, waitSec, kind, fn }) {
  if (value != null && fresh(at, maxAge)) return { value, stale: false, refreshing: !!jobs[kind] };
  const p = refresh(kind, fn).then((v) => ({ v }), (e) => ({ e }));
  const limit = value == null ? 600 : waitSec;
  const done = await Promise.race([p, sleep(limit * 1000).then(() => null)]);
  if (done?.v !== undefined) return { value: done.v, stale: false, refreshing: false };
  if (done?.e && value == null) throw done.e;
  return { value, stale: true, refreshing: !done, error: done?.e?.message };
}

const readOpd = async () => {
  const opd = await readOpdHourly();
  state.opd = opd; state.opdAt = Date.now();
  state.history = recordReading(state.history, opd, new Date());
  save();
  return opd;
};
const getOpd = (maxAge, waitSec = 600) =>
  cachedOrFresh({ at: state.opdAt, value: state.opd, maxAge, waitSec, kind: "opd", fn: readOpd });

const readNA = async () => {
  const r = await readNotActive();
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
async function storePass(budget = 5) {
  const all = await readAllAssociates();
  const day = boardDay(new Date());
  let roster = state.roster && state.roster.day === day ? state.roster : emptyRoster(day);
  roster = mergeSnapshot(roster, { day, seen: all.seen }, Date.now());
  const names = needsCheck(roster, { budget, now: Date.now() });
  const details = names.length ? await readAssociateDetails(names) : {};
  const picks = {};
  for (const [n, d] of Object.entries(details)) picks[n] = d?.error ? { error: d.error } : { picks: d?.qtyPicked };
  roster = applyDetails(roster, picks, Date.now());
  state.roster = roster; state.rosterAt = Date.now();
  state.rosterUpdated = all.lastUpdated ?? state.rosterUpdated ?? null;
  save();
  return roster;
}

/** Not-active list, then one batched detail trip for the scheduled ones in it. */
async function breaksPass(names, limit) {
  const na = await readNotActive();
  state.notActive = na; state.notActiveAt = Date.now();
  const suspects = (na?.notActive || []).filter((g) => names.some((s) => sameName(s, g)));
  const details = suspects.length ? await readAssociateDetails(suspects) : {};
  const now = new Date();
  const watch = breakWatch({ scheduled: names, notActive: na?.notActive || [], details, now, limitMin: limit });
  state.gaps = trackGaps(state.gaps, watch, now);
  state.watch = { ...watch, names, notActiveUpdated: na?.lastUpdated ?? null };
  state.watchAt = Date.now(); save();
  return state.watch;
}

function summarize(windowMin) {
  const now = new Date();
  const series = state.history?.series || [];
  const rate = series.length >= 2 ? rollingWindow(series, windowMin * 60_000) : null;
  return {
    store: HOME_STORE,
    asOf: state.opdAt ? new Date(state.opdAt).toISOString() : null,
    readyToPick: state.opd?.readyToPick ?? null,
    dayPicked: dayPicked(state.opd),
    open: state.opd?.hours || [],
    completed: completedSummary(state.opd),
    completedHours: state.opd?.completed || [],
    pph: rate && {
      perHour: Math.round(rate.perHour), picked: rate.picked,
      spanMin: Math.round(rate.spanMs / 60000), full: rate.full, windowMin,
    },
    express: expressSummary(state.history, now),
    // for the dashboard's per-clock-hour chart and the Pick Hours archive
    series, dayStart: boardDayStart(now), hourMs: HOUR_MS,
  };
}

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
            "/breaks?names=First Last|First Last": "scheduled pickers not active, minutes since last seen (?limit=18)",
            "/store": "day roster: every active associate + picks (accumulated; ?pass=1 to advance, ?budget=N)",
            "/stop": "stop the emulator now",
          },
        });
      case "/health":
        return send(res, 200, {
          ok: true, version: VERSION, store: HOME_STORE, busy, phase, idleMin: IDLE_MIN,
          emulator: emulatorBooted() ? "up" : "down",
          needsSignin: Date.now() < signinBlockedUntil ? signinBlockedUntil : null,
          chat: chat ? chat.status() : { state: "off" },
          opdAt: state.opdAt || null, notActiveAt: state.notActiveAt || null, watchAt: state.watchAt || null,
        });
      case "/opd": {
        const r = await getOpd(Number(q("maxAge", 120)), Number(q("wait", 600)));
        return send(res, 200, { ...r.value, stale: r.stale, refreshing: r.refreshing });
      }
      case "/summary": {
        const r = await getOpd(Number(q("maxAge", 120)), Number(q("wait", 600)));
        return send(res, 200, { ...summarize(Number(q("window", 60))), stale: r.stale, refreshing: r.refreshing, error: r.error });
      }
      case "/notactive": {
        const r = await getNotActive(Number(q("maxAge", 90)), Number(q("wait", 600)));
        return send(res, 200, { ...r.value, stale: r.stale, refreshing: r.refreshing });
      }
      case "/assoc": {
        const name = q("name", "");
        if (!name) return send(res, 400, { error: "name required" });
        return send(res, 200, await run(`assoc ${name}`, () => readAssociateDetail(name)));
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
      case "/store": {
        // ?pass=1 runs one accumulation pass (reads the All list + a few
        // details); otherwise returns the roster built up so far. The SW adds
        // the digital/store-help coding (classifications are browser-only).
        if (q("pass")) await run("store", () => storePass(Number(q("budget", 5))));
        const roster = state.roster || emptyRoster(boardDay(new Date()));
        return send(res, 200, {
          day: roster.day, roster,
          storeTotal: dayPicked(state.opd),
          lastUpdated: state.rosterUpdated ?? null,
          asOf: state.rosterAt || null,
        });
      }
      case "/stop":
        return send(res, 200, { stopped: stopEmulator("requested") });
      default:
        return send(res, 404, { error: "unknown path" });
    }
  } catch (e) {
    log(`${u.pathname} failed:`, e.message);
    return send(res, 500, { error: e.message, path: u.pathname });
  }
});

let chat = null;
server.listen(PORT, "127.0.0.1", () => {
  log(`gif-daemon on http://127.0.0.1:${PORT} (store ${HOME_STORE}, idle stop ${IDLE_MIN || "off"} min)`);
  // Workvivo !commands through QRCallBox's chat relay (dev/gif-chat.mjs);
  // GIF_CHAT=0 turns it off.
  if (process.env.GIF_CHAT !== "0") { chat = createChat({ port: PORT, log }); chat.start(); }
});
