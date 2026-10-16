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
import { parseCommand, groupCommands, formatPph, formatExpress, formatSummary, formatBreaks, formatStore, formatHelp, formatBreakLog, formatPerformance } from "../modules/digitaldashboard/lib/commands.js";
import { HOME_STORE, BREAK_LIMIT_MIN, pickersNow, normName, sameName } from "../modules/digitaldashboard/lib/gif_metrics.js";
import { rosterRows, rosterTotals } from "../modules/digitaldashboard/lib/store_roster.js";
import { staffingPlan, staffingLine, staffingText, slotPace, paceLine, activePickers, outputPickers } from "../modules/digitaldashboard/lib/staffing.js";
import { decodeAssignments, decodeClassifications } from "../modules/digitalmetrics/lib/codec.js";
import { BACKEND } from "../modules/digitalmetrics/lib/config.js";
import { isoDay } from "../modules/digitalmetrics/lib/pull_schedule.js";

const SDK = join(process.env.USERPROFILE || process.env.HOME, "tools", "android-sdk");
const KEY_FILE = join(SDK, ".qrcallbox-key");
const STATE_FILE = join(SDK, "gif-chat-state.json");
const RELAY = process.env.GIF_CHAT_RELAY || "https://qrcallbox.com/api/workvivo/chat-relay";
// Chats to answer in, "|"-separated: "@me" = messages straight to the user
// (their self-DM), "Daily Board" = the digital leadership chat (2026-10-09).
const CHANNELS = (process.env.GIF_CHAT_CHANNEL || "@me|Daily Board").split("|").map((c) => c.trim()).filter(Boolean);
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
const post = (channel, text) => relay({ action: "post", channelName: channel, text }, 30_000);

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

// The board changes a few times a day; the break watch asks every minute.
let rosterCache = { at: 0, day: "", associates: [] };
async function todaysRoster(maxAgeMs = 5 * 60_000) {
  const day = isoDay(new Date());
  if (rosterCache.day === day && Date.now() - rosterCache.at < maxAgeMs) return rosterCache.associates;
  const doc = await decodeAssignments(await getDoc(`stores/${HOME_STORE}/dailyAssignments/${day}`)).catch(() => null);
  if (doc) rosterCache = { at: Date.now(), day, associates: doc.associates || [] };
  return doc?.associates || rosterCache.associates;
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
    // maxAge under the 3-min cadence so each background run really recomputes;
    // the daemon reuses the phone's latest Not active list and cached last-seens.
    const r = await local("/breaks", { names: scheduled.join("|"), limit: BREAK_LIMIT_MIN, maxAge: 150, wait: 120 }, 180_000);
    return (lastWatch = { ...r, checkedAt: r.checkedAt || new Date().toISOString() });
  }

  // The break watch runs in the background every 3 minutes during store hours, so
  // !breaks answers from it at once instead of starting its own read.
  const WATCH_EVERY_MS = 3 * 60_000;  // every 3 min (user, 2026-10-09)
  let watchJob = null;
  const refreshWatch = () => (watchJob ||= checkBreaks().finally(() => { watchJob = null; }));
  const storeHours = () => { const h = new Date().getHours(); return h >= 5 && h < 22; };
  function startWatch() {
    const tick = () => { if (storeHours()) refreshWatch().catch((e) => log("chat: break watch failed:", e.message)); };
    tick();
    setInterval(tick, WATCH_EVERY_MS);
  }
  // Totals are read on stop (daemon stopReads); tell it who counts: today's board
  // PICK names + store help (anyone non-digital in GIF's roster picked to be there).
  async function pushScope() {
    try {
      const board = (await todaysRoster())
        .filter((r) => r?.name && r.status !== "absent" && Object.values(r.slots || {}).some((c) => String(c ?? "").trim().toUpperCase() === "PICK"))
        .map((r) => r.name);
      const classify = await classifier();
      const roster = (await local("/store", {}, 15_000)).roster?.associates || {};
      const help = Object.keys(roster).filter((n) => !DIGITAL_CLASSES.has(classify(n)));
      await local("/scope", { names: [...new Set([...board, ...help])].join("|") }, 15_000);
    } catch (e) { log("chat: totals scope failed:", e.message); }
  }
  function startScope() { pushScope(); setInterval(pushScope, 10 * 60_000); }

  async function currentWatch() {
    // never start a check for a command — answer from the last background run, whatever its age
    if (lastWatch) return lastWatch;
    throw new Error("the break watch hasn't finished its first check yet — try again in a few minutes");
  }
  async function getStore() {
    // the roster the phone's background passes have built (every 15 min) — no pass of its own
    const r = await local("/store", {}, 15_000);
    const classify = await classifier();
    return {
      day: r.day, asOf: r.asOf, lastUpdated: r.lastUpdated, storeTotal: r.storeTotal, leaderboard: r.leaderboard, absences: r.absences, walkMix: r.walkMix,
      rows: rosterRows(r.roster, classify),
      totals: rosterTotals(r.roster, (n) => DIGITAL_CLASSES.has(classify(n)), r.storeTotal),
    };
  }
  async function answer(cmd) {
    const now = () => new Date();
    if (cmd === "help") return formatHelp();
    if (cmd === "unknown") return `Unknown command. ${formatHelp()}`;
    // stamped with when the watch last ran, not when the question was asked
    if (cmd === "breaks") return currentWatch().then((w) => formatBreaks(w, new Date(w.checkedAt)), (e) => `Couldn't check breaks: ${e.message}`);
    // the day's long-break log, from the daemon's cache (fed by every watch run)
    if (cmd === "breaklog") return local("/breaklog", {}, 15_000).then(
      (r) => formatBreakLog(r.episodes, r.day, r.lastAt ? new Date(r.lastAt) : now(), { limitMin: r.limitMin }),
      (e) => `Couldn't read the break log: ${e.message}`);
    if (cmd === "store") return getStore().then((s) => formatStore(s, now()), (e) => `Couldn't read the roster: ${e.message}`);
    if (cmd === "performance") return Promise.all([getStore(), todaysRoster()]).then(([s, board]) => formatPerformance(s, board, now()), (e) => `Couldn't read the roster: ${e.message}`);
    // Commands never start a GIF read (user, 2026-10-09): answer from the phone's
    // latest OPD reading (it reads every 2 min); the reply shows its age.
    const s = await local("/summary", { cached: 1, window: 60 }, 15_000).catch((e) => ({ error: e.message }));
    if (s.error && !s.series) return `Couldn't read GIF: ${s.error}`;
    const readAt = () => (s.asOf ? new Date(s.asOf) : now());   // stamp replies with the reading's time
    if (cmd === "express") return formatExpress(s, readAt());
    if (cmd === "summary" || cmd === "staffing") {
      const active = activePickers({ picking: s.storeKpis?.picking, watch: lastWatch || s.watch, now: now() });
      const roster = await todaysRoster();
      const plan = staffingPlan({ open: s.open, upcoming: s.upcoming, roster, rate: s.storeKpis?.avgPickRate,
        pickingNow: s.storeKpis?.picking, active, output: outputPickers(s.pph?.perHour, s.storeKpis?.avgPickRate),
        expressPerHour: s.express?.avgItemsPerHour, now: now() });
      // live pace per open due hour first (due 30 min before the slot), then the board check
      const pace = slotPace({ open: s.open, rate: s.pph?.perHour, perPicker: plan?.perPicker, now: now() });
      if (cmd === "staffing") return staffingText(plan, now(), pace, roster);   // one line per due time, live pace folded in, then the board's pickers for every hour
      return [formatSummary(s, lastWatch, readAt()), pace[0] ? paceLine(pace[0]) : null, staffingLine(plan)].filter(Boolean).join("\n");
    }
    return formatPph(s, readAt());
  }

  /** Answer one group (same question, maybe several askers) with one reply. */
  async function handle(channel, { cmd, said, askers }) {
    log(`chat: ${cmd} from ${askers.join(", ")} in "${channel}"`);
    // Replies can land in a batch (several commands queued while the relay was
    // down), so each one names the command it answers — and who asked, when
    // more than one person did.
    said = askers.length > 1 ? `${said} · asked by ${askers.join(", ")}` : said;
    const reply = answer(cmd).catch((e) => `Error: ${e.message}`);
    const slow = await Promise.race([reply.then(() => false), sleep(ACK_AFTER_MS).then(() => true)]);
    if (slow) await post(channel, `⏳ ${said}: reading GIF, one moment…`).catch((e) => log("chat ack failed:", e.message));
    const text = `↳ ${said}\n${await reply}`;
    await post(channel, text).then(
      () => log(`chat: replied in "${channel}": ${text.replace(/\n/g, " ⏎ ").slice(0, 300)}`),
      (e) => log("chat reply failed:", e.message));
  }

  // ── Loop: one long-poll per chat, each with its own "answered up to" mark ──
  let st = {};
  try { if (existsSync(STATE_FILE)) st = JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { /* fresh */ }
  // older state files held a single { afterTs, channel }
  const marks = st.channels || (st.channel ? { [st.channel]: st.afterTs } : {});
  for (const c of CHANNELS) if (!marks[c]) marks[c] = Date.now() - 5 * 60_000;
  const saveTs = () => { try { writeFileSync(STATE_FILE, JSON.stringify({ channels: marks })); } catch { /* ignore */ } };

  const status = Object.fromEntries(CHANNELS.map((c) => [c, "starting"]));
  const recent = Object.fromEntries(CHANNELS.map((c) => [c, {}]));   // per chat: question → last reply time
  async function loop(channel) {
    log(`chat: listening to "${channel}" via ${new URL(RELAY).host}`);
    let backoff = 0;
    for (;;) {
      try {
        const r = await relay({ action: "wait", channelName: channel, afterTs: marks[channel], waitSec: WAIT_SEC }, (WAIT_SEC + 30) * 1000);
        backoff = 0; status[channel] = "listening";
        const msgs = (r.messages || []).sort((a, b) => a.createdAt - b.createdAt);
        // answered once, even if the reply fails
        for (const m of msgs) marks[channel] = Math.max(marks[channel], m.createdAt);
        if (msgs.length) saveTs();
        // One reply per question: same command from several people in this
        // poll → one reply naming them; asked again within a minute of its
        // reply in this chat → no reply (lib/commands.js::groupCommands).
        const { groups, duplicates } = groupCommands(msgs, recent[channel]);
        for (const d of duplicates) log(`chat: ${d.key} from ${d.askers.join(", ")} in "${channel}" — answered under a minute ago, not repeating`);
        for (const g of groups) {
          await handle(channel, g);
          recent[channel][g.key] = Date.now();
        }
      } catch (e) {
        // 401 = dead Workvivo token (the extension heartbeat refreshes it) or a
        // bad key; 404 = no such chat. Neither fixes itself in seconds.
        // A 401 is usually a Workvivo token that rotated (someone opened
        // Workvivo; the extension heartbeat couriers the new one within a minute
        // or two) — retry soon, or commands pile up and get answered in a batch.
        // 404 (no such chat) won't fix itself, so that one waits 5 min.
        status[channel] = `error: ${e.status || ""} ${e.message}`.trim();
        backoff = e.status === 404 ? 5 * 60_000
          : e.status === 401 ? Math.min(120_000, (backoff || 15_000) * 2)
          : Math.min(60_000, (backoff || 5_000) * 2);
        log(`chat: "${channel}" ${e.status || ""} ${e.name === "AbortError" ? "relay timed out" : e.message} — retry in ${Math.round(backoff / 1000)} s`);
        await sleep(backoff);
      }
    }
  }
  return {
    start: () => {
      if (!existsSync(KEY_FILE)) { for (const c of CHANNELS) status[c] = "off (no key file)"; log(`chat: listener off — no ${KEY_FILE}`); return; }
      for (const c of CHANNELS) loop(c).catch((e) => { status[c] = "stopped"; log(`chat: "${c}" loop died:`, e.message); });
      startWatch();
      startScope();
    },
    // "listening" only when every chat is; the extension's own listener stands down on it
    status: () => ({
      state: Object.values(status).every((x) => x === "listening") ? "listening" : Object.values(status).find((x) => x !== "listening"),
      channels: status,
    }),
    // the reply text for a command, without posting it (dev/gif-chat-try.mjs)
    answer,
  };
}
