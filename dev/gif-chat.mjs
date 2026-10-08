// dev/gif-chat.mjs
//
// Workvivo !command listener, run inside dev/gif-daemon.mjs. Replaces the
// extension's per-minute listener (digitaldashboard/service.js::pollListener),
// which only worked while a Workvivo tab sat open in the browser.
//
// Transport is QRCallBox's /api/workvivo/chat-relay: the couriered Sendbird
// token stays on the server, which reads and posts on our behalf. "wait" is a
// long poll — the server holds one Sendbird connection for up to ~45 s and
// returns within ~2 s of a "!" message — so replies start almost at once with
// one held call per ~45 s instead of a call per tick.
//
// Answers come from the daemon's own HTTP endpoints (same caching as the
// dashboard) plus Digital Metrics' Firestore for the assignment grid and the
// digital/store-help classifications (anonymous REST auth, as the extension does).
//
// Local files (never the repo):
//   ~/tools/android-sdk/.qrcallbox-key     the user's X-API-Key (wvk_…)
//   ~/tools/android-sdk/gif-chat-state.json   last answered message timestamp

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseCommand, formatPph, formatExpress, formatSummary, formatBreaks, formatStore, formatHelp } from "../modules/digitaldashboard/lib/commands.js";
import { HOME_STORE, BREAK_LIMIT_MIN, pickersNow, normName, sameName } from "../modules/digitaldashboard/lib/gif_metrics.js";
import { rosterRows, rosterTotals } from "../modules/digitaldashboard/lib/store_roster.js";
import { decodeAssignments, decodeClassifications } from "../modules/digitalmetrics/lib/codec.js";
import { BACKEND } from "../modules/digitalmetrics/lib/config.js";
import { isoDay } from "../modules/digitalmetrics/lib/pull_schedule.js";

const SDK = join(process.env.USERPROFILE || process.env.HOME, "tools", "android-sdk");
const KEY_FILE = join(SDK, ".qrcallbox-key");
const STATE_FILE = join(SDK, "gif-chat-state.json");
const RELAY = process.env.GIF_CHAT_RELAY || "https://qrcallbox.com/api/workvivo/chat-relay";
// "@me" = the user's own self-DM while this is under test; "Daily Board" later.
const CHANNEL = process.env.GIF_CHAT_CHANNEL || "@me";
const WAIT_SEC = 45;
const ACK_AFTER_MS = 8_000;          // slower than this → post "reading GIF…" first
const DIGITAL_CLASSES = new Set(["Digital", "Exceptions"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Relay ────────────────────────────────────────────────────────
async function relay(body, timeoutMs) {
  const key = readFileSync(KEY_FILE, "utf8").trim();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(RELAY, {
      method: "POST", signal: ctl.signal,
      headers: { "Content-Type": "application/json", "X-API-Key": key },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || `relay ${r.status}`), { status: r.status });
    // Without the hosting rewrite the path serves the site's HTML with a 200;
    // treat anything that is not the relay's own JSON as "not deployed".
    if (j.ok !== true) throw Object.assign(new Error("relay not reachable (is the /api/workvivo/chat-relay rewrite deployed?)"), { status: 404 });
    return j;
  } finally { clearTimeout(t); }
}
const post = (text) => relay({ action: "post", channelName: CHANNEL, text }, 30_000);

// ── Firestore (Digital Metrics, read-only) ───────────────────────
let fbToken = null, fbTokenAt = 0;
async function idToken() {
  if (fbToken && Date.now() - fbTokenAt < 50 * 60_000) return fbToken;
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${BACKEND.apiKey}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ returnSecureToken: true }),
  });
  if (!r.ok) throw new Error(`Firestore sign-in failed (${r.status})`);
  fbToken = (await r.json()).idToken; fbTokenAt = Date.now();
  return fbToken;
}
function fromValue(v) {
  if (!v || typeof v !== "object") return v;
  if (v.nullValue !== undefined) return null;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue !== undefined) return Number(v.doubleValue);
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.arrayValue !== undefined) return (v.arrayValue.values || []).map(fromValue);
  if (v.mapValue !== undefined) return fromFields(v.mapValue.fields || {});
  return null;
}
function fromFields(f) { const o = {}; for (const [k, v] of Object.entries(f || {})) o[k] = fromValue(v); return o; }
async function getDoc(path) {
  const r = await fetch(`${BACKEND.root}/${path}`, { headers: { Authorization: `Bearer ${await idToken()}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Firestore GET ${path} → ${r.status}`);
  return fromFields((await r.json()).fields);
}

async function todaysRoster() {
  const doc = await decodeAssignments(await getDoc(`stores/${HOME_STORE}/dailyAssignments/${isoDay(new Date())}`)).catch(() => null);
  return doc?.associates || [];
}
async function classifier() {
  const own = await getDoc(`stores/${HOME_STORE}/classifications/current`).catch(() => null);
  const map = await decodeClassifications(own || await getDoc("metrics/classifications").catch(() => null)).catch(() => ({}));
  const norm = new Map(Object.entries(map || {}).map(([n, c]) => [normName(n), c]));
  return (gifName) => {
    const k = normName(gifName);
    if (norm.has(k)) return norm.get(k);
    for (const [n, c] of norm) if (sameName(n, k)) return c;
    return "Store Help";
  };
}

// ── Answers (mirror digitaldashboard/service.js::answerCommand) ──
export function createChat({ port, log }) {
  const local = async (path, params, timeoutMs) => {
    const u = new URL(path, `http://127.0.0.1:${port}`);
    for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, String(v));
    const r = await fetch(u, { signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `daemon ${r.status}`);
    return j;
  };
  let lastWatch = null;

  async function checkBreaks() {
    const scheduled = pickersNow(await todaysRoster(), new Date());
    if (!scheduled.length) return (lastWatch = { checkedAt: new Date().toISOString(), scheduledCount: 0, suspects: [], note: "no one on the grid to pick this hour" });
    const r = await local("/breaks", { names: scheduled.join("|"), limit: BREAK_LIMIT_MIN, maxAge: 120, wait: 90 }, 150_000);
    return (lastWatch = { ...r, checkedAt: new Date().toISOString() });
  }
  async function getStore() {
    const r = await local("/store", { pass: 1, budget: 5, wait: 150 }, 210_000);
    const classify = await classifier();
    return {
      day: r.day, asOf: r.asOf, lastUpdated: r.lastUpdated, storeTotal: r.storeTotal,
      rows: rosterRows(r.roster, classify),
      totals: rosterTotals(r.roster, (n) => DIGITAL_CLASSES.has(classify(n)), r.storeTotal),
    };
  }
  async function answer(cmd) {
    const now = () => new Date();
    if (cmd === "help") return formatHelp();
    if (cmd === "unknown") return `Unknown command. ${formatHelp()}`;
    if (cmd === "breaks") return checkBreaks().then((w) => formatBreaks(w, now()), (e) => `Couldn't check breaks: ${e.message}`);
    if (cmd === "store") return getStore().then((s) => formatStore(s, now()), (e) => `Couldn't read the roster: ${e.message}`);
    const s = await local("/summary", { maxAge: 120, wait: 90, window: 60 }, 150_000).catch((e) => ({ error: e.message }));
    if (s.error && !s.series) return `Couldn't read GIF: ${s.error}`;
    if (cmd === "express") return formatExpress(s, now());
    if (cmd === "summary") return formatSummary(s, lastWatch, now());
    return formatPph(s, now());
  }

  async function handle(m) {
    const cmd = parseCommand(m.text);
    if (!cmd) return;
    log(`chat: ${cmd} from ${m.senderName || m.senderId}`);
    const reply = answer(cmd).catch((e) => `Error: ${e.message}`);
    const slow = await Promise.race([reply.then(() => false), sleep(ACK_AFTER_MS).then(() => true)]);
    if (slow) await post("⏳ Reading GIF, one moment…").catch((e) => log("chat ack failed:", e.message));
    await post(await reply).catch((e) => log("chat reply failed:", e.message));
  }

  // ── Loop ──
  let st = {};
  try { if (existsSync(STATE_FILE)) st = JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { /* fresh */ }
  let afterTs = st.afterTs || Date.now() - 5 * 60_000;
  const saveTs = () => { try { writeFileSync(STATE_FILE, JSON.stringify({ afterTs, channel: CHANNEL })); } catch { /* ignore */ } };

  let status = "starting";
  async function loop() {
    if (!existsSync(KEY_FILE)) { status = "off (no key file)"; log(`chat: listener off — no ${KEY_FILE}`); return; }
    log(`chat: listening to "${CHANNEL}" via ${new URL(RELAY).host}`);
    let backoff = 0;
    for (;;) {
      try {
        const r = await relay({ action: "wait", channelName: CHANNEL, afterTs, waitSec: WAIT_SEC }, (WAIT_SEC + 30) * 1000);
        backoff = 0; status = "listening";
        for (const m of (r.messages || []).sort((a, b) => a.createdAt - b.createdAt)) {
          afterTs = Math.max(afterTs, m.createdAt); saveTs();   // answered once, even if the reply fails
          await handle(m);
        }
      } catch (e) {
        // 401 = dead Workvivo token (the extension heartbeat refreshes it) or a
        // bad key; 404 = no such chat. Neither fixes itself in seconds.
        const slowDown = e.status === 401 || e.status === 404;
        status = `error: ${e.status || ""} ${e.message}`.trim();
        backoff = slowDown ? 5 * 60_000 : Math.min(60_000, (backoff || 5_000) * 2);
        log(`chat: ${e.status || ""} ${e.name === "AbortError" ? "relay timed out" : e.message} — retry in ${Math.round(backoff / 1000)} s`);
        await sleep(backoff);
      }
    }
  }
  return {
    start: () => { loop().catch((e) => { status = "stopped"; log("chat: loop died:", e.message); }); },
    status: () => ({ state: status, channel: CHANNEL }),
  };
}
