// modules/boblisa/lib/misses.js
//
// Documented misses: the analyst's record that a cashier on a manned lane
// let an item leave the register unpaid, what it was, how it was caught, and
// the coaching note. A record is a snapshot of the pair it was built from
// (the journal cache is per store-day and gets re-pulled / cleared; the
// record must survive that) plus the analyst's fields.
//
//   buildRecord(pair, store, fields, by)  → record (pure; caller persists)
//   pairFromTraining(training, paid, opts) → pair-shaped input for buildRecord from a paid training receipt
//   draftNote(pair)                        → plain-English description to edit
//   rollupByCashier(records)               → [{ op, name, count, cents, first, last, causes }]
//   missesCsv(records)                     → CSV text (one row per record)
//   buildCashierLedger(records, prior)     → { [op]: { count, cents, events, … } } persisted per store
//   cashiersCsv(ledger)                    → CSV text (one row per cashier)
//
// Pure — no DOM, no chrome.*, safe in the SW, the shell and node.

import { DEFAULT_REGISTERS, isManned, isVision, registerType } from "./registers.js";

export const CAUSES = Object.freeze({
  bottom_of_basket: "Bottom of basket not checked",
  inside_item:      "Item inside another item or bag",
  skipped_scan:     "Item on the belt not scanned",
  quantity_short:   "Quantity keyed short",
  other:            "Other",
});

export const VIDEO_REVIEW = Object.freeze({
  not_reviewed: "Video not reviewed",
  confirmed:    "Video reviewed: confirms the miss",
  not_miss:     "Video reviewed: not a miss",
  inconclusive: "Video reviewed: inconclusive",
});

export const OUTCOMES = Object.freeze({
  door_paid:        "Caught at the door, customer paid",
  training_receipt: "Training receipt printed, customer paid",
  customer_return:  "Customer came back and paid on their own",
  not_recovered:    "Not recovered",
});

const cents = (v) => Number(v) || 0;
const money = (c) => "$" + (cents(c) / 100).toFixed(2);
const hm = (t) => String(t || "").slice(0, 5);
const mdy = (iso) => { const [y, m, d] = String(iso || "").split("-"); return m && d ? `${m}/${d}/${y.slice(2)}` : String(iso || ""); };

/** The second transaction's merchandise lines — money services (bill pay, card loads) are never a missed item. */
export function missedItems(pair) {
  const items = pair?.t2?.items || [];
  const merch = items.filter((it) => !it.service);
  return merch.length ? merch : items;
}

/** Total of the second transaction's merchandise — what the register missed. */
export function missedCents(pair) {
  return missedItems(pair).reduce((s, it) => s + cents(it.cents), 0) || cents(pair?.t2?.total);
}

// How the note names the cause: BoB = bottom of basket, Lisa = look inside always.
export const CAUSE_SHORT = Object.freeze({
  bottom_of_basket: "BoB",
  inside_item:      "Lisa",
  skipped_scan:     "an item not scanned",
  quantity_short:   "quantity keyed short",
  other:            "",
});

/**
 * Suggested note — one line, what the coaching file needs (user, 2026-09-16:
 * "on date cashier x op# missed AS 4M $21.27 from BoB, or Lisa whichever is
 * checked"). The form redraws it when the cause or the name changes until
 * the analyst edits the text.
 */
export function draftNote(pair, { cause = "bottom_of_basket", name = "" } = {}) {
  if (!pair) return "";
  const t1 = pair.t1 || {};
  const items = missedItems(pair).map((it) => `${it.desc} ${money(it.cents)}`).join(", ") || money(pair.t2?.total);
  const who = `cashier ${name ? `${String(name).trim()} ` : ""}op ${t1.op}`;
  const how = CAUSE_SHORT[cause] ?? "";
  return `${mdy(pair.date)} ${who} missed ${items}${how ? ` from ${how}` : ""}.`;
}

/**
 * Build the stored record. `fields` = { cause, outcome, video, cashierName, note, videoIds };
 * `by` = { win, displayName } of the analyst. `prior` keeps createdAt/createdBy
 * on edit.
 */
export function buildRecord(pair, storeNbr, fields = {}, by = {}, prior = null, now = new Date()) {
  if (!pair?.key) throw new Error("buildRecord: pair.key required");
  const t1 = pair.t1 || {}, t2 = pair.t2 || {};
  const at = now.toISOString();
  const cause = CAUSES[fields.cause] ? fields.cause : "other";
  const outcome = OUTCOMES[fields.outcome] ? fields.outcome : (pair.training ? "training_receipt" : "door_paid");
  return {
    key: pair.key,
    storeNbr: String(storeNbr || ""),
    date: pair.date,
    category: pair.category || "manned",
    cashier: { op: String(t1.op || ""), name: String(fields.cashierName || prior?.cashier?.name || "").trim() },
    t1: { time: t1.time, reg: t1.reg, type: t1.type, op: t1.op, tr: t1.tr, items: t1.items, total: cents(t1.total), tender: t1.tender },
    t2: { time: t2.time, reg: t2.reg, type: t2.type, op: t2.op, tr: t2.tr, total: cents(t2.total), tender: t2.tender,
          items: (t2.items || []).map((it) => ({ desc: it.desc, code: it.code, cents: cents(it.cents), onT1: !!it.onT1, ...(it.service ? { service: true } : {}) })) },
    gapMin: pair.gapMin,
    missedCents: missedCents(pair),
    flags: { training: !!pair.training, vision: !!pair.vision, repeat: !!pair.repeat },
    trainingRef: pair.trainingRef || null,
    cause, outcome,
    video: VIDEO_REVIEW[fields.video] ? fields.video : (prior?.video || "not_reviewed"),
    // APPRISS transaction-id links found through Open Drawer (link_video), kept
    // so the Documented tab can open the exact clip without another lookup.
    videoIds: fields.videoIds || prior?.videoIds || null,
    note: String(fields.note ?? "").trim(),
    createdAt: prior?.createdAt || at,
    createdBy: prior?.createdBy || by.win || "",
    createdByName: prior?.createdByName || by.displayName || "",
    updatedAt: at,
    updatedBy: by.win || "",
  };
}

const hmsToSec = (t) => { const [h, m, s] = String(t || "").split(":").map(Number); return Number.isFinite(h) ? h * 3600 + (m || 0) * 60 + (s || 0) : null; };

/**
 * A paid training receipt as a documentable miss (user, 2026-09-17: "assign a
 * paid training receipt to the first transaction's operator/cashier"). The
 * door host printed the training receipt, the customer paid those lines at
 * `paid`, and the cashier to charge is the operator of the customer's FIRST
 * transaction: the same-card sale before the paid one when the journal has it
 * (`paid.prev`), otherwise the op and register the analyst types
 * (`manualCashier`). The training lines are what was missed. With a known
 * first transaction the key is findPairs' key, so the pair row and the card
 * share one record.
 */
export function pairFromTraining(training, paid, { op = "", reg = "", registers = DEFAULT_REGISTERS } = {}) {
  if (!training?.key || !paid) return null;
  const { prev = null, hasToken, ...sale } = paid;
  const regNum = reg === "" || reg == null ? "" : Number(reg);
  const t1 = prev
    ? { ...prev }
    : { time: "", reg: regNum, type: regNum === "" ? "" : registerType(regNum, registers), op: String(op || "").trim(), tr: "", items: null, total: 0, tender: "" };
  const items = (training.items || []).map((it) => ({ desc: it.desc, code: it.code, cents: cents(it.cents), onT1: false }));
  const a = prev ? hmsToSec(prev.time) : null, b = hmsToSec(sale.time);
  const gapSec = a != null && b != null ? b - a : null;
  return {
    key: prev ? `${training.date}|${prev.reg}|${prev.tr}|${sale.reg}|${sale.tr}` : `${training.date}|train|${training.reg}|${training.tr}|${sale.reg}|${sale.tr}`,
    date: training.date,
    category: t1.reg === "" || isManned(t1.reg, registers) ? "manned" : "unmanned",
    t1, t2: { ...sale, items },
    gapSec, gapMin: gapSec == null ? null : Math.round(gapSec / 60),
    repeat: 0, training: true, vision: isVision(sale.reg, registers),
    trainingRef: { time: training.time, reg: training.reg, op: training.op, tr: training.tr },
    fromTraining: true, manualCashier: !prev,
  };
}

/** The pair shape buildRecord needs, rebuilt from a stored record (edits from the Documented tab). */
export function pairFromRecord(r) {
  if (!r?.key) return null;
  return { key: r.key, date: r.date, category: r.category, t1: r.t1, t2: r.t2, gapMin: r.gapMin,
           training: !!r.flags?.training, vision: !!r.flags?.vision, repeat: !!r.flags?.repeat, trainingRef: r.trainingRef || null };
}

/** Per-cashier totals across records, most misses first. */
export function rollupByCashier(records = []) {
  const map = new Map();
  for (const r of Object.values(records)) {
    const op = r?.cashier?.op || "?";
    const c = map.get(op) || { op, name: "", count: 0, cents: 0, first: r.date, last: r.date, causes: {}, registers: new Set() };
    if (!c.name && r.cashier?.name) c.name = r.cashier.name;
    c.count += 1; c.cents += cents(r.missedCents);
    if (r.date < c.first) c.first = r.date;
    if (r.date > c.last) c.last = r.date;
    c.causes[r.cause] = (c.causes[r.cause] || 0) + 1;
    c.registers.add(r.t1?.reg);
    map.set(op, c);
  }
  return [...map.values()]
    .map((c) => ({ ...c, registers: [...c.registers].filter(Boolean).sort((a, b) => a - b) }))
    .sort((a, b) => b.count - a.count || b.cents - a.cents || a.op.localeCompare(b.op));
}

/**
 * The cashier ledger: for every operator on a MANNED lane, how many times a
 * miss was documented against them and the second-transaction dollars those
 * misses add up to — the numbers the coaching conversation needs. Persisted
 * per store (boblisa.cashiers.<store>) and rebuilt from the records on every
 * save / remove, so the records stay the source of truth. `prior` is the
 * previous ledger: a name typed for an op once is remembered even when a
 * later record leaves it blank. Unmanned first transactions have no cashier
 * to charge and are left out.
 *
 * → { [op]: { op, name, count, cents, first, last, registers, causes,
 *             events: [{ key, date, time, reg, tr, cents, cause, outcome, training, items }], updatedAt } }
 */
export function buildCashierLedger(records = {}, prior = {}, now = new Date()) {
  const out = {};
  const nameAt = {};
  for (const r of Object.values(records || {})) {
    const op = String(r?.cashier?.op || "");
    if (!op || (r.category || "manned") !== "manned") continue;
    const c = out[op] || (out[op] = { op, name: "", count: 0, cents: 0, first: r.date, last: r.date, registers: new Set(), causes: {}, events: [] });
    const name = String(r.cashier?.name || "").trim();
    if (name && (!c.name || String(r.updatedAt || "") > String(nameAt[op] || ""))) { c.name = name; nameAt[op] = r.updatedAt || ""; }
    c.count += 1; c.cents += cents(r.missedCents);
    if (r.date < c.first) c.first = r.date;
    if (r.date > c.last) c.last = r.date;
    c.causes[r.cause] = (c.causes[r.cause] || 0) + 1;
    c.registers.add(r.t1?.reg);
    c.events.push({
      key: r.key, date: r.date, time: r.t1?.time || "", reg: r.t1?.reg, tr: r.t1?.tr, cents: cents(r.missedCents),
      cause: r.cause, outcome: r.outcome, training: !!r.flags?.training,
      items: missedItems(r).map((it) => `${it.desc} ${money(it.cents)}`).join("; "),
    });
  }
  const at = now.toISOString();
  for (const c of Object.values(out)) {
    if (!c.name && prior?.[c.op]?.name) c.name = prior[c.op].name;
    c.registers = [...c.registers].filter((v) => v != null && v !== "").sort((a, b) => a - b);
    c.events.sort((a, b) => a.date.localeCompare(b.date) || String(a.time).localeCompare(String(b.time)));
    c.updatedAt = at;
  }
  return out;
}

/** Ledger entries most misses first (ties: most dollars, then op). */
export function ledgerRows(ledger = {}) {
  return Object.values(ledger || {}).sort((a, b) => b.count - a.count || b.cents - a.cents || String(a.op).localeCompare(String(b.op)));
}

export const CASHIER_CSV_COLUMNS = Object.freeze([
  "Cashier op", "Cashier name", "WIN", "Misses", "Missed $", "First", "Last", "Registers", "Causes", "Events",
]);

/** One row per cashier: the ledger as a spreadsheet for the coaching file. */
export function cashiersCsv(ledger = {}) {
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [CASHIER_CSV_COLUMNS.map(q).join(",")];
  for (const c of ledgerRows(ledger)) {
    lines.push([
      c.op, c.name, c.win || "", c.count, (cents(c.cents) / 100).toFixed(2), c.first, c.last,
      (c.registers || []).join(" "),
      Object.entries(c.causes || {}).map(([k, n]) => `${n}x ${CAUSES[k] || k}`).join("; "),
      (c.events || []).map((e) => `${e.date} reg ${e.reg} TR ${e.tr} ${money(e.cents)}${e.items ? ` (${e.items})` : ""}`).join(" | "),
    ].map(q).join(","));
  }
  return lines.join("\r\n");
}

export const CSV_COLUMNS = Object.freeze([
  "Date", "Time", "Register", "Cashier op", "Cashier name", "First items", "First total",
  "Second time", "Second register", "Gap min", "Missed items", "Missed $",
  "Training receipt", "Vision", "Cause", "Outcome", "Video review", "Video link", "Note", "Documented by", "Documented at",
]);

export function missesCsv(records = []) {
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = Object.values(records).slice().sort((a, b) => a.date.localeCompare(b.date) || String(a.t1?.time || "").localeCompare(String(b.t1?.time || "")));
  const lines = [CSV_COLUMNS.map(q).join(",")];
  for (const r of rows) {
    lines.push([
      r.date, r.t1?.time, `${r.t1?.reg} ${r.t1?.type || ""}`.trim(), r.cashier?.op, r.cashier?.name,
      r.t1?.items, (cents(r.t1?.total) / 100).toFixed(2),
      r.t2?.time, `${r.t2?.reg} ${r.t2?.type || ""}`.trim(), r.gapMin,
      missedItems(r).map((it) => `${it.desc} ${(cents(it.cents) / 100).toFixed(2)}`).join("; "),
      (cents(r.missedCents) / 100).toFixed(2),
      r.flags?.training ? "yes" : "", r.flags?.vision ? "yes" : "",
      CAUSES[r.cause] || r.cause, OUTCOMES[r.outcome] || r.outcome,
      VIDEO_REVIEW[r.video] || r.video || "", r.videoIds?.t1?.cctvUrl || r.videoIds?.t2?.cctvUrl || "", r.note,
      r.createdByName || r.createdBy, r.createdAt,
    ].map(q).join(","));
  }
  return lines.join("\r\n");
}
