// modules/registerls/lib/cashiers.js
//
// Per-associate error ledger: who was involved in what, how much, and what
// kind — built from the same evidence the board already has, so it stays in
// step with the verdicts. Pure; the service worker persists the coaching
// notes and hands the built ledger to the view / exporter.
//
//   buildLedger({ items, verdicts, tillRows, cfg }) →
//     { cashiers: [{ id, name, totalCents, count, byType: {type: {count, cents}},
//                    first, last, events: [{ date, register, type, cents, workItemId, detail }] }],
//       types: { key: label } }
//
// Error types (an event is attributed to the associate the till log names):
//   till_moved         checked a till in to a register it was not checked out to
//   advance_wrong_till carried a cash advance to the wrong register (flip)
//   advance_missing    advanced cash that never surfaced anywhere
//   quick_recheck      checked a till out and back in minutes later with less cash
//   override           used a till check-in override on a register-day with a discrepancy
//   flip_checkin       checked in BOTH tills of a flipped pair (one person, so the swap is theirs)
//
// Every type names the one person the till log records doing the action.
// Nothing is charged for merely having handled a till on a bad day — being
// on a short register is not an error. Amounts are integer cents.

import { wrongRegisterMoves, tillsFor, flipCheckins } from "./till_events.js";

export const ERROR_TYPES = {
  till_moved:         "Till moved between registers",
  advance_wrong_till: "Cash advance to the wrong register",
  advance_missing:    "Cash advance never surfaced",
  quick_recheck:      "Till re-checked in with less cash",
  override:           "Check-in override on a discrepancy day",
  flip_checkin:       "Checked tills in to the wrong registers",
};

export function buildLedger({ items = [], verdicts = {}, tillRows = [], discrepancies = [], counterparts = {} } = {}) {
  const cashiers = new Map();
  const seen = new Set();
  const add = (id, name, ev) => {
    if (!id) return;
    const key = `${id}|${ev.type}|${ev.date}|${ev.register}|${ev.workItemId || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    const c = cashiers.get(id) || { id, name: name || "", totalCents: 0, count: 0, byType: {}, first: ev.date, last: ev.date, events: [] };
    if (!c.name && name) c.name = name;
    c.totalCents += Math.abs(ev.cents || 0); c.count++;
    c.byType[ev.type] = c.byType[ev.type] || { count: 0, cents: 0 };
    c.byType[ev.type].count++; c.byType[ev.type].cents += Math.abs(ev.cents || 0);
    if (ev.date < c.first) c.first = ev.date;
    if (ev.date > c.last) c.last = ev.date;
    c.events.push(ev);
    cashiers.set(id, c);
  };

  // Store-wide till moves are errors regardless of whether WorkView raised an item.
  for (const m of wrongRegisterMoves(tillRows)) {
    add(m.associateId, m.associate, { date: m.date, register: `${m.fromRegister}→${m.toRegister}`, type: "till_moved", cents: m.outCents, workItemId: null, detail: `checked in to reg ${m.toRegister} at ${m.inTime} a till checked out of reg ${m.fromRegister} at ${m.outTime}${m.checkoutBy && m.checkoutBy !== m.associateId ? ` by ${m.checkoutByName || m.checkoutBy}` : ""}${m.override ? " (override)" : ""}` });
  }

  const SAFE = new Set(["flip", "bounceback"]);
  for (const it of items) {
    if (!it.register || !it.date) continue;
    const t = tillRows.length ? tillsFor(tillRows, it, discrepancies) : null;
    if (!t) continue;
    const explained = SAFE.has(verdicts[it.id]?.verdict);   // the shortage already has its other half
    const cp = counterparts[it.id];
    if (cp && (it.amountCents ?? 0) < 0) {   // charge the pair once, from its shortage side
      const fc = flipCheckins(tillRows, it, cp);
      if (fc?.same) add(fc.associates[0].id, fc.associates[0].name, { date: it.date, register: `${it.register}↔${cp.register}`, type: "flip_checkin", cents: it.amountCents, workItemId: it.id, detail: `checked in both tills: ${[...fc.mine, ...fc.theirs].map((c) => `reg ${c.register} ${c.time}`).join(", ")}` });
    }
    for (const a of t.advances || []) {
      if (a.kind === "advance_missing" && explained) continue;
      if (a.kind === "advance_flip")    add(a.advance.associateId, a.advance.associate, { date: it.date, register: it.register, type: "advance_wrong_till", cents: a.advance.amountCents, workItemId: it.id, detail: `advanced ${money(a.advance.amountCents)} at ${a.advance.time}; landed on reg ${a.landedOn.registerNbr} (${a.landedOn.date})` });
      if (a.kind === "advance_missing") add(a.advance.associateId, a.advance.associate, { date: it.date, register: it.register, type: "advance_missing", cents: a.advance.amountCents, workItemId: it.id, detail: `advanced ${money(a.advance.amountCents)} at ${a.advance.time}; no overage anywhere` });
    }
    for (const f of t.flags || []) {
      if (f.kind === "quick_recheck") add(f.associateId, t.people.find((p) => p.id === f.associateId)?.name, { date: it.date, register: it.register, type: "quick_recheck", cents: f.deltaCents, workItemId: it.id, detail: f.text });
      if (f.kind === "override") for (const e of t.day.filter((e) => e.action === "TILLCHECKINOVERRIDE")) add(e.associateId, e.associate, { date: it.date, register: it.register, type: "override", cents: it.amountCents, workItemId: it.id, detail: `override at ${e.time}; register ${money(it.amountCents)}` });
    }
  }

  const list = [...cashiers.values()].map((c) => ({ ...c, events: c.events.sort((a, b) => b.date.localeCompare(a.date)) }))
    .sort((a, b) => b.totalCents - a.totalCents || b.count - a.count);
  return { cashiers: list, types: ERROR_TYPES, events: list.flatMap((c) => c.events.map((e) => ({ ...e, associateId: c.id, associate: c.name }))) };
}

// Stable identity for one attributed event, so a permanent store can merge
// repeated rebuilds without duplicating, and never loses an event once seen.
export function eventKey(e) {
  return `${e.associateId}|${e.type}|${e.date}|${e.register}|${e.workItemId || ""}`;
}

// Aggregate stored events (already attributed, optionally date-filtered)
// into the per-cashier shape the panel and the CSV use.
export function aggregateEvents(events) {
  const cashiers = new Map();
  for (const ev of events) {
    const c = cashiers.get(ev.associateId) || { id: ev.associateId, name: ev.associate || "", totalCents: 0, count: 0, byType: {}, first: ev.date, last: ev.date, events: [] };
    if (!c.name && ev.associate) c.name = ev.associate;
    c.totalCents += Math.abs(ev.cents || 0); c.count++;
    c.byType[ev.type] = c.byType[ev.type] || { count: 0, cents: 0 };
    c.byType[ev.type].count++; c.byType[ev.type].cents += Math.abs(ev.cents || 0);
    if (ev.date < c.first) c.first = ev.date;
    if (ev.date > c.last) c.last = ev.date;
    c.events.push(ev);
    cashiers.set(ev.associateId, c);
  }
  return [...cashiers.values()].map((c) => ({ ...c, events: c.events.sort((a, b) => b.date.localeCompare(a.date)) })).sort((a, b) => b.totalCents - a.totalCents || b.count - a.count);
}

export function money(cents) {
  return `${cents < 0 ? "-" : ""}$${(Math.abs(cents || 0) / 100).toFixed(2)}`;
}

// One CSV per cashier: their events, then their coaching notes.
export function cashierCsv(c, notes = []) {
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [
    ["Associate", "WIN", "Total $ involved", "Events"].map(q).join(","),
    [c.name, c.id, (c.totalCents / 100).toFixed(2), c.count].map(q).join(","),
    "",
    ["Date", "Register", "Error type", "Amount", "Work item", "Detail"].map(q).join(","),
    ...c.events.map((e) => [e.date, e.register, ERROR_TYPES[e.type] || e.type, (Math.abs(e.cents || 0) / 100).toFixed(2), e.workItemId || "", e.detail || ""].map(q).join(",")),
    "",
    ["Coaching date", "Action", "Note", "By"].map(q).join(","),
    ...notes.map((n) => [n.date, n.action, n.note, n.by || ""].map(q).join(",")),
  ];
  return lines.join("\r\n");
}

export function safeFileName(c) {
  return `${(c.id || "unknown").replace(/[^A-Za-z0-9]/g, "")}_${(c.name || "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "")}.csv`;
}
