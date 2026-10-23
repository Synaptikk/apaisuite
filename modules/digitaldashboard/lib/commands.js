// modules/digitaldashboard/lib/commands.js
//
// The Workvivo !command vocabulary and the reply text for each. Pure, so the
// words people type and the replies they get are pinned by tests.
//
// A message is a command only when it STARTS with "!" — the listener sees every
// message in the channel and must ignore ordinary chat, including its own
// replies (none of which start with "!").

import { clockText, BREAK_LIMIT_MIN, minutesOfDay, sameName, SLOT_START_HOUR } from "./gif_metrics.js";
import { episodeMinutes, LUNCH_TRAVEL_MIN } from "./break_log.js";
import { mixText } from "./walk_log.js";

const ALIASES = [
  ["pph", ["pph", "picks per hour", "picks/hr", "picks", "rate", "pick rate"]],
  ["breaks", ["breaks", "break", "missing", "out"]],
  ["breaklog", ["breaklog", "break log", "breaks log", "long breaks", "breaks today"]],
  ["express", ["express", "exp", "express per hour"]],
  ["store", ["store", "roster", "associates", "who", "all", "store help", "help list"]],
  ["performance", ["performance", "perf", "rates", "leaderboard", "walks", "pick walks"]],
  ["staffing", ["staffing", "staff", "pickers", "coverage", "enough", "need"]],
  ["summary", ["summary", "dash", "dashboard", "status"]],
  ["help", ["help", "commands", "?"]],
];

/** "!Picks per hour" → "pph"; anything else (or no "!") → null. */
export function parseCommand(text) {
  const m = /^\s*!\s*(.+?)\s*$/s.exec(String(text ?? ""));
  if (!m) return null;
  const said = m[1].toLowerCase().replace(/\s+/g, " ");
  for (const [cmd, words] of ALIASES) if (words.includes(said)) return cmd;
  return "unknown";
}

const n = (x) => (x == null ? "—" : Number(x).toLocaleString("en-US"));
const stamp = (now) => clockText(now.getHours() * 60 + now.getMinutes());

export function formatPph(s, now = new Date()) {
  if (!s) return "Store 1458 picks: no reading yet.";
  // the daemon drops a reading from before today's 5 AM rollover (asOf null)
  if (!s.asOf && s.dayPicked == null) return "Store 1458 picks: no GIF reading yet today.";
  const parts = [`Store 1458 picks @ ${stamp(now)}`];
  if (s.pph) {
    parts.push(s.pph.full
      ? `last hour ${n(s.pph.perHour)}/hr`
      : `${n(s.pph.perHour)}/hr pace (last ${s.pph.spanMin} min)`);
  }
  if (s.completed?.avgPerHour != null) parts.push(`today avg ${n(s.completed.avgPerHour)}/hr over ${s.completed.hours} closed hours`);
  if (s.completed?.peak) parts.push(`peak ${s.completed.peak.slot} ${n(s.completed.peak.qtyPicked)}`);
  if (s.dayPicked != null) parts.push(`${n(s.dayPicked)} picked`);
  return parts.join(" · ");
}

export function formatExpress(s, now = new Date()) {
  const e = s?.express;
  if (!e || !e.slots.length) return "Express: no open slots read yet.";
  const lines = [`Store 1458 express @ ${stamp(now)} (estimates — orders keep dropping in until :15 past)`];
  for (const x of e.slots) {
    lines.push(`${x.slot}: ≥${n(x.items)} items / ≥${n(x.orders)} orders${x.final ? "" : ` · ${n(x.remaining)} left · open`}`);
  }
  if (e.avgItemsPerHour != null) lines.push(`Avg per closed hour: ${n(e.avgItemsPerHour)} items / ${n(e.avgOrdersPerHour)} orders (${e.closedCount} hr)`);
  return lines.join("\n");
}

/**
 * Who is scheduled to pick this hour but has not picked for longer than the
 * break allowance. Names only for people OVER the limit; a short gap is a
 * break, not news.
 */
export function formatBreaks(w, now = new Date()) {
  if (!w) return "Breaks: no check has run yet.";
  const limit = w.limitMin ?? BREAK_LIMIT_MIN;
  const over = (w.suspects || []).filter((s) => s.over);
  // held (break_log.watchWithMeals): on a punched lunch, or over 45 min with no punch read yet
  const atLunch = (w.suspects || []).filter((s) => s.held === "lunch").length;
  const pending = (w.suspects || []).filter((s) => s.held === "unverified").length;
  const tail = [atLunch ? `${atLunch} on a punched lunch` : "", pending ? `${pending} over 45 min held until their lunch punch is checked` : ""].filter(Boolean).join(" · ");
  if (!w.scheduledCount) return `No one is on the grid to pick this hour (${stamp(now)}).`;
  if (!over.length) return `All ${w.scheduledCount} scheduled pickers are within ${limit} min (${stamp(now)}).${tail ? ` (${tail})` : ""}`;
  const lines = [`Out of pick walks > ${limit} min (${stamp(now)}):`];
  for (const s of over) lines.push(`• ${s.name} — last pick ${clockText(s.lastSeen)}${s.location ? ` at ${s.location}` : ""} (${s.mealMin ? `${s.netMin} min not counting ${s.mealMin} min lunch` : `${s.idleMin} min`})`);
  if (tail) lines.push(`(${tail})`);
  return lines.join("\n");
}

/** "7 min from last pick to punching out, 10 from punching back in to picking — 6 min past the 4-min walk each way" */
export function lunchTravel(e) {
  return `${e.beforeMin} min from last pick to punching out, ${e.afterMin} from punching back in to picking — ${e.lunchOverMin} min past the ${LUNCH_TRAVEL_MIN}-min walk each way`;
}

/** "11:42am" for a ms timestamp. */
const shortClock = (ms) => (ms == null ? "?" : clockText(minutesOfDay(new Date(ms))).replace(" ", "").toLowerCase());

/**
 * The day's long-break log (lib/break_log.js breakLogDay): one line per
 * episode, oldest first. `asOf` = when the watch last ran (the reply's stamp).
 */
export function formatBreakLog(episodes, day, asOf = new Date(), { limitMin = BREAK_LIMIT_MIN, max = 60 } = {}) {
  const [y, m, d] = String(day).split("-").map(Number);
  const date = y ? new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" }) : day;
  // Punched lunches (break_log.withMeals) are not long breaks unless the time
  // around them is past the walk allowance ("lunch-over"); over 45 min with no
  // punch read yet ("unverified") is held back.
  const all = episodes || [];
  const eps = all.filter((e) => e.kind !== "lunch" && e.kind !== "clocked-out" && e.kind !== "unverified");
  const lunches = all.filter((e) => e.kind === "lunch" || e.kind === "clocked-out").length;
  const held = all.filter((e) => e.kind === "unverified").length;
  if (!eps.length) return `Long breaks ${date}: none logged over ${limitMin} min${lunches ? ` (${lunches} punched lunch${lunches === 1 ? "" : "es"} left out)` : ""} (as of ${stamp(asOf)}).`;
  const open = eps.filter((e) => e.status === "open").length;
  const lines = [`Long breaks ${date} — ${eps.length} logged over ${limitMin} min${open ? `, ${open} still out` : ""} (as of ${stamp(asOf)}):`];
  for (const e of eps.slice(0, max)) {
    const min = e.netMin ?? episodeMinutes(e);
    const mins = min == null ? "" : ` (${min} min${e.mealMin ? `, not counting ${e.mealMin} min lunch` : ""})`;
    const out = e.lastSeenActiveAt ?? e.firstFlaggedAt;
    if (e.kind === "lunch-over") { lines.push(`• ${e.name} · lunch ${shortClock(out)} → ${shortClock(e.cleared)}: ${lunchTravel(e)}`); continue; }
    lines.push(e.status === "open"
      ? `• ${e.name} · still out since ${shortClock(out)}${mins}`
      : `• ${e.name} · out ${shortClock(out)} → back ${shortClock(e.cleared)}${mins}`);
  }
  if (eps.length > max) lines.push(`…and ${eps.length - max} more (full list on the dashboard)`);
  if (lunches) lines.push(`(${lunches} punched lunch${lunches === 1 ? "" : "es"} left out)`);
  if (held) lines.push(`(${held} over 45 min held until their lunch punch is checked)`);
  return lines.join("\n");
}

export function formatSummary(s, w, now = new Date()) {
  return [formatPph(s, now), s?.readyToPick != null ? `Ready to pick: ${n(s.readyToPick)}` : null, w ? formatBreaks(w, now) : null]
    .filter(Boolean).join("\n");
}

/**
 * The day's picking roster: every associate active today, their picks, and the
 * digital/store-help split. `s` is the SW getStore() result (rows already coded
 * + sorted by picks desc). `max` caps the per-associate list so a huge roster
 * does not exceed Workvivo's message size; the totals are always shown.
 */
export const FULL_LIST_MIN_PICKS = 50;

export function formatStore(s, now = new Date(), { max = 60 } = {}) {
  if (!s || !(s.rows || []).length) return "Store 1458: no roster built yet — give it a minute.";
  const t = s.totals || {};
  const lines = [`Store 1458 pickers @ ${stamp(now)} — ${t.associates ?? s.rows.length} associates today`];
  if (s.storeTotal != null) lines.push(`Store total: ${n(s.storeTotal)} picks`);
  if (t.storeHelpAssociates) lines.push(`Store help: ${t.storeHelpAssociates} assoc · ${n(t.storeHelpPicks)} picks${t.storeHelpPending ? ` (${t.storeHelpPending} still to count)` : ""}`);
  if (t.digitalPicks != null) lines.push(`Digital: ${n(t.digitalPicks)} picks`);
  lines.push("—");
  // everyone at FULL_LIST_MIN_PICKS+ always listed (user, 2026-10-09); the rest fill up to `max`
  const big = s.rows.filter((r) => r.picks >= FULL_LIST_MIN_PICKS);
  const rest = s.rows.filter((r) => !(r.picks >= FULL_LIST_MIN_PICKS)).slice(0, Math.max(0, max - big.length));
  const shown = [...big, ...rest];
  for (const r of shown) {
    const tag = r.code && r.code !== "Digital" && r.code !== "Exceptions" ? ` (${r.code})` : "";
    const mark = r.status === "picking" ? " ▸" : "";          // ▸ = picking right now
    lines.push(`• ${r.name}${tag}: ${r.picks == null ? "…" : n(r.picks)}${mark}`);
  }
  if (s.rows.length > shown.length) lines.push(`…and ${s.rows.length - shown.length} more under ${FULL_LIST_MIN_PICKS} picks (full list on the dashboard)`);
  if (shown.some((r) => r.picks == null)) lines.push("(… = count still being read)");
  return lines.join("\n");
}

/**
 * !performance — who is behind, most behind first (user, 2026-10-19): every
 * associate with PICK hours on the Daily Board whose picks trail the board's
 * PICK hours × PERF_PICK_RATE (the store's usual 90-95/hr; the low end is used).
 *
 * Picks come from an associate-detail read, taken when they stop picking, and
 * are compared with the PICK hours on the board that had passed by that read,
 * so a mid-shift read isn't held against hours still to come; leaving early
 * counts against them (those hours had passed). Time picking (picks ÷ their
 * GIF rate, which covers all walks so far) is shown alongside as context.
 */
export const PERF_MIN_PICK_HOURS = 1;   // any PICK hours on the board
export const PERF_PICK_RATE = 90;       // expected picks per scheduled PICK hour
const PERF_MIN_ELAPSED_MIN = 60;   // too early in the shift to judge

export function pickingMinutes(r) {
  return r.picks > 0 && r.rate > 0 ? Math.round((r.picks / r.rate) * 60) : null;
}
const dur = (min) => `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, "0")}m`;
const clockOf = (ms) => { const d = new Date(ms); return clockText(d.getHours() * 60 + d.getMinutes()); };
const titleName = (s) => String(s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
const isPickCell = (c) => String(c ?? "").trim().toUpperCase() === "PICK";

/** Board PICK hours (start hour of each) for one associate. */
function pickHours(b) {
  return Object.entries(b.slots || {}).filter(([, c]) => isPickCell(c)).map(([k]) => SLOT_START_HOUR + Number(k));
}
/** Minutes of those PICK hours that had passed by `at`. */
function pickMinutesElapsed(hours, at) {
  const d = new Date(at), m = d.getHours() * 60 + d.getMinutes();
  return hours.reduce((t, h) => t + Math.max(0, Math.min(60, m - h * 60)), 0);
}

/** Board × GIF roster → each 8h+ picker's picking share; `rows` are rosterRows(). */
/**
 * Possible absences: on the board to pick, but never on GIF's associates list
 * (which only shows people on the clock) and not on today's leaderboard (anyone
 * who picked) — once their first PICK hour is 30+ min old. The board's own
 * "absent" mark is skipped outright.
 */
const ABSENT_AFTER_MIN = 30;

export function performanceReview(rows, board, { minHours = PERF_MIN_PICK_HOURS, rate = PERF_PICK_RATE, leaderboard = null, absences = null, now = new Date() } = {}) {
  const out = { opportunities: [], onTrack: 0, notRead: [], tooEarly: 0, considered: 0, absent: [], calledOut: [], markedAbsent: 0 };
  const nowMin = now.getHours() * 60 + now.getMinutes();
  for (const b of board || []) {
    if (!b?.name) continue;
    const hours = pickHours(b);
    if (hours.length < minHours) continue;
    if (b.status === "absent") { out.markedAbsent++; continue; }
    // IVR call-in for today (closinglist's pull, via the dashboard SW)
    if ((absences?.rows || []).some((a) => sameName(a.name, b.name))) { out.calledOut.push({ name: b.name, shift: b.shiftLabel || null }); continue; }
    const r = (rows || []).find((x) => sameName(x.name, b.name));
    if (!r && !(leaderboard?.rows || []).some((x) => sameName(x.name, b.name))) {
      if (nowMin >= Math.min(...hours) * 60 + ABSENT_AFTER_MIN) { out.absent.push({ name: b.name, shift: b.shiftLabel || null }); continue; }
    }
    out.considered++;
    if (!r || r.picks == null || !r.checkedAt) { out.notRead.push(r?.name ?? b.name); continue; }
    const sched = pickMinutesElapsed(hours, r.checkedAt);
    if (sched < PERF_MIN_ELAPSED_MIN) { out.tooEarly++; continue; }
    const expected = Math.round((sched / 60) * rate);
    const behind = expected - r.picks;
    if (behind <= 0) { out.onTrack++; continue; }
    const picked = pickingMinutes(r);
    out.opportunities.push({ name: r.name, behind, expected, picked, sched, share: picked != null ? picked / sched : null,
      picks: r.picks, rate: r.rate, walks: r.walks, at: r.checkedAt, gone: r.status === "offclock", shift: b.shiftLabel || null });
  }
  out.opportunities.sort((a, b) => b.behind - a.behind);
  return out;
}

/**
 * Rows read before rates were kept have picks but no rate: the leaderboard's
 * rate fills in for anyone who hasn't picked since that read (nothing moved,
 * so picks and rate still belong together).
 */
export function withLeaderboardRates(rows, leaderboard) {
  const lb = leaderboard?.rows || [];
  return (rows || []).map((r) => {
    if (r.rate > 0 || !(r.picks > 0) || r.activeSince) return r;
    const hit = lb.find((x) => sameName(x.name, r.name));
    return hit?.rate > 0 ? { ...r, rate: hit.rate } : r;
  });
}

/**
 * " (last one 6:52 AM)" when the picker's last walk card left the OPD screens
 * an hour or more before the picks were read: the PICK hours after it still
 * count as expected (user, 2026-10-19), so say when picking actually stopped —
 * a moved-to-other-work or gone-early picker reads very different from a slow
 * one (2026-10-23, Deborah Greene: 1 walk ending 6:52, read at 10:50).
 */
const STALE_WALK_MIN = 60;
function staleWalk(mix, at) {
  return mix?.lastSeen && at && at - mix.lastSeen >= STALE_WALK_MIN * 60_000 ? ` (last one ${clockOf(mix.lastSeen)})` : "";
}

export function formatPerformance(s, board, now = new Date()) {
  const rv = performanceReview(withLeaderboardRates(s?.rows, s?.leaderboard), board, { leaderboard: s?.leaderboard, absences: s?.absences, now });
  const lines = [`Performance @ ${stamp(now)} - pickers behind ${PERF_PICK_RATE}/hr for their scheduled PICK hours, most behind first`];
  if (!rv.considered && !rv.absent.length && !rv.calledOut.length) return `${lines[0]}\n- nobody on today's board with PICK hours`;
  if (!rv.opportunities.length) lines.push("- nobody behind so far");
  for (const o of rv.opportunities) {
    const time = o.picked != null ? ` - ${dur(o.picked)} picking (${Math.round(o.share * 100)}%) @ ${Math.round(o.rate)}/hr` : "";
    const walks = o.walks > 0 ? ` - ${o.walks} walk${o.walks === 1 ? "" : "s"}${o.picked != null ? ` (avg ${Math.round(o.picked / o.walks)}m)` : ""}` : "";
    lines.push(`- ${o.name}: ${n(o.behind)} picks behind - ${n(o.picks)} of ${n(o.expected)} for ${dur(o.sched)} scheduled` +
      `${time}${walks}${o.gone ? " - gone for the day" : ` - as of ${clockOf(o.at)}`}` +
      (s?.walkMix?.[o.name] ? ` - walks seen: ${mixText(s.walkMix[o.name])}${staleWalk(s.walkMix[o.name], o.at)}` : ""));
  }
  const who = (list) => list.map((a) => `${titleName(a.name)}${a.shift ? ` (${a.shift})` : ""}`).join(", ");
  if (rv.calledOut.length) lines.push(`- Called out (IVR): ${who(rv.calledOut)}`);
  if (rv.absent.length) lines.push(`- Not in GIF today, no call-in${s?.absences ? "" : " (IVR not checked)"}: ${rv.absent.map((a) => `${titleName(a.name)}${a.shift ? ` (${a.shift})` : ""}`).join(", ")}`);
  const tail = [`${rv.onTrack} on pace`];
  if (rv.notRead.length) tail.push(`${rv.notRead.length} not read yet`);
  if (rv.tooEarly) tail.push(`${rv.tooEarly} too early to tell`);
  if (rv.calledOut.length) tail.push(`${rv.calledOut.length} called out`);
  if (rv.absent.length) tail.push(`${rv.absent.length} not in GIF`);
  if (rv.markedAbsent) tail.push(`${rv.markedAbsent} marked absent`);
  lines.push(`(${rv.considered + rv.absent.length + rv.calledOut.length} scheduled to pick: ${tail.join(", ")}. Expected = ${PERF_PICK_RATE} picks per PICK hour passed; picks read when they stop.)`);
  return lines.join("\n\n");   // blank line between associates (user, 2026-10-09: readability)
}

export function formatHelp() {
  return "Digital Dashboard commands: !pph (picks per hour) · !express · !breaks · !breaklog (today's long breaks) · !store (roster + store help) · !performance (pickers behind 90/hr, most behind first) · !staffing (pickers needed by hour) · !summary · !help";
}

/** Same question in the same chat within this long of its reply → no second reply. */
export const DEDUPE_MS = 60_000;

/**
 * One reply per question. Groups a poll's messages by what was asked (the
 * normalised text, so a future "!who Jane" and "!who Bob" stay separate) and
 * drops a question already answered in this chat within `windowMs`.
 *
 * @param {{text:string, senderName?:string, senderId?:string}[]} messages  oldest first
 * @param {Record<string, number>} recent  key → when its last reply was posted (this chat)
 * @returns {{ groups: {key:string, cmd:string, said:string, askers:string[]}[],
 *            duplicates: {key:string, askers:string[]}[] }}
 */
export function groupCommands(messages, recent = {}, now = Date.now(), windowMs = DEDUPE_MS) {
  const byKey = new Map();
  for (const m of messages || []) {
    const cmd = parseCommand(m.text);
    if (!cmd) continue;
    const key = String(m.text).trim().toLowerCase().replace(/\s+/g, " ");
    const who = m.senderName || m.senderId || "someone";
    if (!byKey.has(key)) byKey.set(key, { key, cmd, said: String(m.text).trim().split(/\s+/)[0], askers: [] });
    const g = byKey.get(key);
    if (!g.askers.includes(who)) g.askers.push(who);
  }
  const groups = [], duplicates = [];
  for (const g of byKey.values()) {
    if (recent[g.key] && now - recent[g.key] < windowMs) duplicates.push({ key: g.key, askers: g.askers });
    else groups.push(g);
  }
  return { groups, duplicates };
}
