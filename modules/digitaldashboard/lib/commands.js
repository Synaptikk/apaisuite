// modules/digitaldashboard/lib/commands.js
//
// The Workvivo !command vocabulary and the reply text for each. Pure, so the
// words people type and the replies they get are pinned by tests.
//
// A message is a command only when it STARTS with "!" — the listener sees every
// message in the channel and must ignore ordinary chat, including its own
// replies (none of which start with "!").

import { clockText, BREAK_LIMIT_MIN } from "./gif_metrics.js";

const ALIASES = [
  ["pph", ["pph", "picks per hour", "picks/hr", "picks", "rate", "pick rate"]],
  ["breaks", ["breaks", "break", "missing", "out"]],
  ["express", ["express", "exp", "express per hour"]],
  ["store", ["store", "roster", "associates", "who", "all", "store help", "help list"]],
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
  if (!w.scheduledCount) return `No one is on the grid to pick this hour (${stamp(now)}).`;
  if (!over.length) return `All ${w.scheduledCount} scheduled pickers are within ${limit} min (${stamp(now)}).`;
  const lines = [`Out of pick walks > ${limit} min (${stamp(now)}):`];
  for (const s of over) lines.push(`• ${s.name} — last pick ${clockText(s.lastSeen)}${s.location ? ` at ${s.location}` : ""} (${s.idleMin} min)`);
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
export function formatStore(s, now = new Date(), { max = 60 } = {}) {
  if (!s || !(s.rows || []).length) return "Store 1458: no roster built yet — give it a minute.";
  const t = s.totals || {};
  const lines = [`Store 1458 pickers @ ${stamp(now)} — ${t.associates ?? s.rows.length} associates today`];
  if (s.storeTotal != null) lines.push(`Store total: ${n(s.storeTotal)} picks`);
  if (t.storeHelpAssociates) lines.push(`Store help: ${t.storeHelpAssociates} assoc · ${n(t.storeHelpPicks)} picks${t.storeHelpPending ? ` (${t.storeHelpPending} still to count)` : ""}`);
  if (t.digitalPicks != null) lines.push(`Digital: ${n(t.digitalPicks)} picks`);
  lines.push("—");
  const shown = s.rows.slice(0, max);
  for (const r of shown) {
    const tag = r.code && r.code !== "Digital" && r.code !== "Exceptions" ? ` (${r.code})` : "";
    const mark = r.status === "picking" ? " ▸" : "";          // ▸ = picking right now
    lines.push(`• ${r.name}${tag}: ${r.picks == null ? "…" : n(r.picks)}${mark}`);
  }
  if (s.rows.length > max) lines.push(`…and ${s.rows.length - max} more (full list on the dashboard)`);
  if (shown.some((r) => r.picks == null)) lines.push("(… = count still being read)");
  return lines.join("\n");
}

export function formatHelp() {
  return "Digital Dashboard commands: !pph (picks per hour) · !express · !breaks · !store (roster + store help) · !summary · !help";
}
