// modules/digitaldashboard/lib/gif_metrics.js
//
// Pure logic behind the GIF-fed Digital Dashboard. Store 1458 only: GIF shows
// the signed-in associate's home store and nothing else, so there is no
// market and no store picker anywhere in this module any more.
//
// The readings come from dev/gif-daemon.mjs, which drives the GIF app in a
// headless emulator and serves JSON on 127.0.0.1. Both the daemon (Node) and
// the service worker import this file, so it stays free of chrome.* and node:*
// and runs under node --test.
//
// What GIF can and cannot tell us, learned live 2026-10-03:
//   - OPD Hourly lists each open due-hour slot ("7pm - 8pm") with
//     "(picked / total picked)", and, once expanded, an Express row. That
//     Express number is express qty STILL TO PICK: it falls as it is picked
//     and rises as orders drop in (they can land until :15 past the hour).
//     So express volume per slot is only ever an estimate built from
//     successive reads — see recordReading.
//   - Closed slots ("Completed Hours") are not expandable: one Qtys Picked
//     figure each, no express split.
//   - Summing picked over every slot gives a running total for the day, the
//     same shape the old market rollup's `total_picks` had, so its
//     pick_history.js helpers (last-hour rate, per-clock-hour bars) apply
//     unchanged.

export const HOME_STORE = "1458";

/** A 15-minute break plus the user's 3 minutes of grace (2026-10-03). */
export const BREAK_LIMIT_MIN = 18;

/** Digital Metrics grid: slot 0 is 5–6 AM (modules/digitalmetrics/lib/data/grid.js). */
export const SLOT_START_HOUR = 5;

/** Readings kept in the running-total series. Six hours is plenty for a one-hour window. */
export const SERIES_KEEP_MS = 6 * 60 * 60 * 1000;

// ── Parsing ──────────────────────────────────────────────────────

const clockRe = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i;

/** "01:54pm" / "7pm" → minutes since midnight, or null. */
export function parseClockMin(s) {
  const m = clockRe.exec(String(s ?? "").trim());
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toLowerCase() === "pm") h += 12;
  return h * 60 + Number(m[2] ?? 0);
}

/** "7pm - 8pm" → { start: 1140, end: 1200 } in minutes since midnight, or null. */
export function parseSlot(label) {
  const parts = String(label ?? "").split("-").map((x) => x.trim());
  if (parts.length !== 2) return null;
  const start = parseClockMin(parts[0]);
  let end = parseClockMin(parts[1]);
  if (start == null || end == null) return null;
  if (end <= start) end += 24 * 60;   // "11pm - 12am"
  return { start, end };
}

/** "Last seen at A1-2-0013, 01:54pm" → { location: "A1-2-0013", min: 834 }, or null. */
export function parseLastSeen(text) {
  const m = /^Last seen at\s+(.+?),\s*([0-9:]+\s*[ap]m)\s*$/i.exec(String(text ?? "").trim());
  if (!m) return null;
  const min = parseClockMin(m[2]);
  return min == null ? null : { location: m[1].trim(), min };
}

export function minutesOfDay(d) {
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

/** Whole minutes from a same-day clock reading to `now`; null for a time in the future. */
export function idleMinutes(lastMin, now) {
  if (lastMin == null) return null;
  const diff = minutesOfDay(now) - lastMin;
  return diff < 0 ? null : Math.floor(diff);
}

// ── Running total, rate, express ─────────────────────────────────

/** Items picked today across every slot GIF lists, open and closed. */
export function dayPicked(opd) {
  if (!opd) return null;
  let total = 0, any = false;
  for (const h of opd.hours || []) if (Number.isFinite(h.picked)) { total += h.picked; any = true; }
  for (const c of opd.completed || []) if (Number.isFinite(c.qtyPicked)) { total += c.qtyPicked; any = true; }
  return any ? total : null;
}

/** Local "YYYY-MM-DD" of the 5 AM board day a moment belongs to. */
export function boardDay(now) {
  const d = new Date(now.getTime() - SLOT_START_HOUR * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 5 AM local on the board day of `now`, in ms. */
export function boardDayStart(now) {
  const [y, mo, d] = boardDay(now).split("-").map(Number);
  return new Date(y, mo - 1, d, SLOT_START_HOUR, 0, 0, 0).getTime();
}

/**
 * Fold one OPD reading into the day's history. Returns a NEW history.
 *
 * History: { v:1, day, series: [[tMs, dayPicked], …], express: { [slot]: rec } }
 *
 * The series restarts on a new board day and when the total goes DOWN (a
 * closed slot that vanished, a re-sign-in mid-read) — differencing across a
 * drop would produce a negative hour, the same rule pick_history.js applies.
 *
 * Express per slot: the first reading counts the express qty still to pick at
 * that moment, and every later rise counts as orders dropping in. Picks made
 * between two reads hide drop-ins made in the same gap, so `droppedIn` is a
 * floor, and the more often the daemon reads, the closer it gets.
 */
export function recordReading(history, opd, now = new Date()) {
  const day = boardDay(now);
  const t = now.getTime();
  let h = history && history.v === 1 && history.day === day
    ? { ...history, series: [...(history.series || [])], express: { ...(history.express || {}) } }
    : { v: 1, day, series: [], express: {} };

  // A read that saw fewer closed hours than the last one missed rows while
  // scrolling the list (they never un-close). Its total is short by whole
  // hours, and the next good read would jump back — a fake spike in the rate.
  // Keep it out of the series; express below is unaffected.
  const closedNow = (opd?.completed || []).length;
  const partial = closedNow < (h.closedCount ?? 0);
  if (!partial) h.closedCount = closedNow;

  const total = partial ? null : dayPicked(opd);
  if (total != null) {
    const last = h.series.at(-1);
    if (last && total < last[1]) h.series = [];
    h.series.push([t, total]);
    h.series = h.series.filter(([ts]) => ts >= t - SERIES_KEEP_MS);
  }
  h.skipped = (h.skipped ?? 0) + (partial ? 1 : 0);

  for (const hr of opd?.hours || []) {
    if (!Number.isFinite(hr.expressQty)) continue;
    const prev = h.express[hr.slot];
    const orders = Number.isFinite(hr.expressOrders) ? hr.expressOrders : null;
    if (!prev) {
      h.express[hr.slot] = {
        firstAt: t, lastAt: t, samples: 1,
        droppedIn: hr.expressQty, last: hr.expressQty,
        ordersSeen: orders ?? 0, lastOrders: orders,
        slotTotal: Number.isFinite(hr.total) ? hr.total : null,
      };
    } else {
      const rise = Math.max(0, hr.expressQty - prev.last);
      const orderRise = orders != null && prev.lastOrders != null ? Math.max(0, orders - prev.lastOrders) : 0;
      h.express[hr.slot] = {
        ...prev,
        lastAt: t, samples: prev.samples + 1,
        droppedIn: prev.droppedIn + rise, last: hr.expressQty,
        ordersSeen: prev.ordersSeen + orderRise, lastOrders: orders ?? prev.lastOrders,
        slotTotal: Math.max(prev.slotTotal ?? 0, Number.isFinite(hr.total) ? hr.total : 0) || prev.slotTotal,
      };
    }
  }
  return h;
}

/**
 * Express by slot, and the average over slots that are FINAL: the slot's due
 * hour has ended, so no more orders can join it. The current slot is shown as
 * provisional and never averaged — orders keep landing until :15 past.
 */
export function expressSummary(history, now = new Date()) {
  const nowMin = minutesOfDay(now);
  const slots = Object.entries(history?.express || {}).map(([slot, r]) => {
    const range = parseSlot(slot);
    const final = range ? nowMin >= range.end : false;
    return { slot, start: range?.start ?? null, final, items: r.droppedIn, orders: r.ordersSeen, samples: r.samples, remaining: r.last };
  }).sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  const closed = slots.filter((s) => s.final);
  const avg = (k) => closed.length ? Math.round(closed.reduce((a, s) => a + s[k], 0) / closed.length) : null;
  return { slots, closedCount: closed.length, avgItemsPerHour: avg("items"), avgOrdersPerHour: avg("orders") };
}

/** Average and peak of the closed slots' Qtys Picked (GIF's own final figures). */
export function completedSummary(opd) {
  const rows = (opd?.completed || []).filter((c) => Number.isFinite(c.qtyPicked));
  if (!rows.length) return { hours: 0, total: 0, avgPerHour: null, peak: null };
  const total = rows.reduce((a, c) => a + c.qtyPicked, 0);
  const peak = rows.reduce((b, c) => (!b || c.qtyPicked > b.qtyPicked ? c : b), null);
  return { hours: rows.length, total, avgPerHour: Math.round(total / rows.length), peak };
}

// ── Break watch ──────────────────────────────────────────────────

/** Lowercase, punctuation and doubled spaces stripped. */
export function normName(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z\s'-]/g, " ").replace(/\s+/g, " ").trim();
}

/** Same person: identical, or same first and last word (middle names, suffixes). */
export function sameName(a, b) {
  const x = normName(a), y = normName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const xs = x.split(" "), ys = y.split(" ");
  return xs[0] === ys[0] && xs.at(-1) === ys.at(-1);
}

/** Grid slot index for a moment (0 = 5–6 AM), or null outside the 17-slot day. */
export function gridSlotFor(now) {
  const k = now.getHours() - SLOT_START_HOUR;
  return k >= 0 && k <= 16 ? k : null;
}

const isPickCell = (t) => String(t ?? "").trim().toUpperCase() === "PICK";

/**
 * Names the assignment grid has on PICK in the current hour. Absent rows are
 * skipped; a lunch/break cell in this hour means they are SUPPOSED to be off,
 * so they are not candidates.
 */
export function pickersNow(roster, now = new Date()) {
  const k = gridSlotFor(now);
  if (k == null) return [];
  return (roster || [])
    .filter((r) => r?.name && r.status !== "absent" && isPickCell(r.slots?.[k]))
    .map((r) => r.name);
}

/**
 * Scheduled to pick now ∩ on the clock but not active in GIF, with how long
 * since each was last seen picking. `details` is { [gifName]: readAssociateDetail() }.
 */
export function breakWatch({ scheduled = [], notActive = [], details = {}, now = new Date(), limitMin = BREAK_LIMIT_MIN }) {
  const suspects = [];
  for (const gifName of notActive) {
    const rosterName = scheduled.find((s) => sameName(s, gifName));
    if (!rosterName) continue;
    const det = details[gifName] || null;
    const seen = parseLastSeen(det?.lastSeen);
    const idleMin = seen ? idleMinutes(seen.min, now) : null;
    suspects.push({
      name: gifName, rosterName,
      lastSeen: seen ? seen.min : null, location: seen?.location ?? null,
      idleMin,
      // No last-seen today is reported, not assumed: it can mean they have not
      // picked yet or that GIF did not show the field.
      over: idleMin != null && idleMin > limitMin,
      noPickToday: !seen,
    });
  }
  suspects.sort((a, b) => (b.idleMin ?? -1) - (a.idleMin ?? -1));
  return { checkedAt: now.toISOString(), limitMin, scheduledCount: scheduled.length, suspects };
}

/**
 * Carry gaps across passes. A gap opens when someone is flagged and closes the
 * first pass they are no longer a suspect (GIF shows them picking again);
 * the closed gap keeps how long they were out, measured from last seen.
 *
 * gaps: { [name]: { lastSeen, openedAt, closedAt?, outMin? } }
 */
export function trackGaps(prev, watch, now = new Date()) {
  const gaps = { ...(prev || {}) };
  const current = new Set();
  for (const s of watch?.suspects || []) {
    if (!s.over) continue;
    current.add(s.name);
    if (!gaps[s.name] || gaps[s.name].closedAt) {
      gaps[s.name] = { lastSeen: s.lastSeen, location: s.location, openedAt: now.toISOString(), closedAt: null, outMin: null };
    }
  }
  for (const [name, g] of Object.entries(gaps)) {
    if (g.closedAt || current.has(name)) continue;
    gaps[name] = { ...g, closedAt: now.toISOString(), outMin: g.lastSeen != null ? idleMinutes(g.lastSeen, now) : null };
  }
  return gaps;
}

/** "1:54 PM" for minutes since midnight. */
export function clockText(min) {
  if (min == null) return "—";
  const h = Math.floor(min / 60) % 24, m = Math.floor(min % 60);
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
