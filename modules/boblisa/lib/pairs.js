// modules/boblisa/lib/pairs.js
//
// BoB and Lisa — the missed-item search over one Electronic Journal
// store-day. Reuses registerls' receipt parser; adds the two facts that make
// the search work (found 2026-09-14 on store 1458, see dev/BOBLISA_FINDINGS.md):
//
//   * Card receipts carry `TOKEN: <44 hex>`. Same token = same customer.
//   * Money Center / Vision Center registers (92-94, 98) print `**** INVALID RECEIPT - TRAINING ****`
//     receipts ($0.00) for the items a customer walked out without paying
//     for. Do NOT match on the word TRAINING alone — puppy "TRAINING PAD"
//     items produce ~100 false hits a week.
//
// The pattern: T1 = any sale; T2 = the same token's next sale 1–15 minutes
// later with fewer than 5 items and at least $3. T1 on a manned lane means
// the cashier missed the item; T1 anywhere else (self-checkout) can be theft.
// A T2 UPC that is also on T1 stays a hit (one of two waters missed).
// Back-to-back sales on the SAME register under 2 minutes apart are one
// customer ringing twice, not a miss — skipped (user rule, 2026-09-15).
// Money services are not merchandise: bill pay, debit/credit card loads,
// money orders, gift-card activations ("ARBYS DEBIT", "VISA", "DEBIT LOAD")
// cannot be a missed item. A transaction made only of them never pairs, and
// on a mixed receipt only the merchandise lines count (user rule, 2026-09-15).
//
// Pure — no DOM, no chrome.*, safe in the SW, the shell and node.

import { parseReceipt, operatorNames } from "../../registerls/lib/ej_parse.js";
import { DEFAULT_REGISTERS, registerType, isManned, isVision } from "./registers.js";

export const DEFAULT_OPTS = Object.freeze({
  minGapSec: 60,
  maxGapSec: 15 * 60,
  maxT2Items: 4,          // "fewer than 5"
  minT2Cents: 300,        // gum and drinks get rung separately
  trainingWindowSec: 15 * 60,
  // A sale pays for a training receipt only when every merchandise line on
  // it is on the receipt AND those lines cover at least this share of the
  // receipt's lines or dollars (user, 2026-09-17: one shared UPC is not paid).
  trainingMinCoverage: 0.5,
  // Same register, second sale under 2 minutes later: one customer paying in
  // two rings (split tender, forgot an item at the belt), not a door catch.
  sameRegisterMinGapSec: 2 * 60,
  // Ignore money-service lines (bill pay, card loads, money orders, gift
  // cards) — they are services, not merchandise a door host could catch.
  skipServices: true,
});

// EJ prints money-service lines with sale-type flag `K` (DEBIT LOAD, WMMC
// RELOAD, AMOUNT, ONE SECURED); bill-pay and money-order lines come through
// as `S` with 12-char descriptors (VNLLADPAYAMT, CFPRENBILFEE, WU MONEY ORD,
// RIA RCV AMT) and gift cards as `<BRAND> GC` / `<BRAND> DEBIT` / `VISA`.
const SERVICE_DESC_RE = /\bLOAD\b|RELOAD|BILL ?PAY|BIL(?:FEE|PT|PAY)|PAY(?:AMT|FEE)\b|MONEY ?ORD|\bMO FEE|\bWU\b|\bRIA\b|MONEYGRAM|GIFT ?CARD|\bGC\b|\bVISA\b|MASTERCARD|\bAMEX\b|\bDEBIT\b|PREPAID|PHONE CARD|ACTIVAT|CHECK CASH|NETSPEND|GREEN ?DOT|BLUEBIRD|MONEYCARD|WMMC|ONE SECURED|^AMOUNT$/i;
export function isServiceItem(item) {
  if (!item) return false;
  if (item.flag === "K") return true;
  return SERVICE_DESC_RE.test(String(item.desc || "").trim());
}

const TOKEN_RE = /TOKEN:\s*([0-9A-F]{20,})/;
const TRAINING_RE = /INVALID RECEIPT - TRAINING|TRAINING MODE/;

export function timeIntToSec(t) {
  const v = Number(t);
  if (!Number.isFinite(v)) return null;
  return Math.floor(v / 10000) * 3600 + Math.floor((v % 10000) / 100) * 60 + (v % 100);
}
export function timeIntToHms(t) {
  const s = String(Number(t) || 0).padStart(6, "0");
  return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`;
}
function stripZeros(v) { return v == null ? null : String(v).replace(/^0+(?=\d)/, ""); }

/**
 * One EJ store-day → sorted compact transactions. Keeps only what the search
 * and the review table need; the raw receipt text is dropped.
 */
export function compactRecords(records) {
  const list = Array.isArray(records) ? records : Array.isArray(records?.records) ? records.records : [];
  const tx = [];
  for (const r of list) {
    const raw = String(r?.record || "").replace(/\u0000/g, "");
    const p = parseReceipt(raw);
    if (!p) continue;
    const items = p.items.filter((i) => !i.voided && i.cents > 0).map((i) => ({ desc: i.desc, code: i.code, cents: i.cents, ...(isServiceItem(i) ? { service: true } : {}) }));
    const t = timeIntToSec(r.transTime);
    tx.push({
      t, time: timeIntToHms(r.transTime),
      reg: Number(r.termNum ?? p.termNum), op: stripZeros(r.opNum ?? p.opNum) || "?", tr: stripZeros(r.transNum ?? p.transNum) || "?",
      token: (TOKEN_RE.exec(raw) || [])[1] || null,
      items, total: p.totalCents ?? 0,
      tender: p.tenders.map((x) => x.kind).join("+") || "none",
      isTraining: TRAINING_RE.test(raw),
      isSale: !p.isRefund && !p.isPostVoid && !p.isNoSale && !p.isCanceled && items.length > 0,
      // Every line is a money service (bill pay, card load, gift card): not a merchandise sale.
      isService: items.length > 0 && items.every((i) => i.service),
    });
  }
  return tx.filter((x) => x.t != null).sort((a, b) => a.t - b.t);
}

const money = (c) => Number(c) || 0;

/**
 * Does `sale` pay for `training`? Sharing one UPC is not enough: a 17-line
 * $130 training receipt was once "paid" by a stranger's $20 basket that
 * happened to hold the same pens. Every merchandise line on the sale must be
 * on the training receipt, and together they must cover at least
 * `trainingMinCoverage` of its lines or of its dollars. Money-service lines
 * on the sale are ignored like everywhere else.
 */
export function paysForTraining(sale, training, o = DEFAULT_OPTS) {
  const tItems = training?.items || [];
  const merch = (o.skipServices ?? true) ? (sale?.items || []).filter((it) => !it.service) : (sale?.items || []);
  if (!merch.length || !tItems.length) return false;
  const codes = new Set(tItems.map((it) => it.code));
  if (!merch.every((it) => codes.has(it.code))) return false;
  const trainCents = tItems.reduce((s, it) => s + money(it.cents), 0);
  const lines = merch.length / tItems.length;
  const dollars = trainCents ? merch.reduce((s, it) => s + money(it.cents), 0) / trainCents : 0;
  const min = o.trainingMinCoverage ?? 0.5;
  return lines >= min || dollars >= min;
}

function scorePair(t1, t2, { training, vision, repeat }, regCfg) {
  let s = 0;
  if (t2.reg === t1.reg) s += 2;
  if (t2.op === t1.op) s += 1;
  if (training) s += 3;
  if (vision) s += 3;
  if (registerType(t2.reg, regCfg) === "Self-checkout" && registerType(t1.reg, regCfg) !== "Self-checkout") s += 1;
  if (money(t2.total) >= 1500) s += 1;
  if (repeat) s += 1;
  if (t1.items.length >= 5) s += 1;
  return s;
}

const brief = (x, regCfg) => ({ time: x.time, reg: x.reg, type: registerType(x.reg, regCfg), op: x.op, tr: x.tr, items: x.items.length, total: x.total, tender: x.tender });

/**
 * Token pairs for one day. `tx` must be the output of compactRecords.
 */
export function findPairs(tx, dateIso, opts = DEFAULT_OPTS, regCfg = DEFAULT_REGISTERS) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const trainings = tx.filter((x) => x.isTraining && x.items.length);
  const byTok = new Map();
  for (const x of tx) {
    if (!x.token || !x.isSale || x.isTraining) continue;
    if (o.skipServices && x.isService) continue;
    if (!byTok.has(x.token)) byTok.set(x.token, []);
    byTok.get(x.token).push(x);
  }
  const pairs = [];
  for (const [tok, list] of byTok) {
    for (let i = 0; i < list.length - 1; i++) {
      const t1 = list[i], t2 = list[i + 1], gap = t2.t - t1.t;
      if (gap < o.minGapSec || gap > o.maxGapSec) continue;
      if (t1.reg === t2.reg && gap < o.sameRegisterMinGapSec) continue;
      // On a mixed receipt only the merchandise lines can be the missed item.
      const merch = o.skipServices ? t2.items.filter((it) => !it.service) : t2.items;
      if (!merch.length || merch.length > o.maxT2Items) continue;
      const t2Value = merch.length === t2.items.length ? money(t2.total) : merch.reduce((s, it) => s + money(it.cents), 0);
      if (t2Value < o.minT2Cents) continue;
      const t1codes = new Set(t1.items.map((x) => x.code));
      const repeat = t2.items.filter((x) => t1codes.has(x.code)).length;
      const train = trainings.find((x) => Math.abs(x.t - t2.t) <= o.trainingWindowSec && paysForTraining(t2, x, o));
      const vision = isVision(t2.reg, regCfg);
      const flags = { training: !!train, vision, repeat };
      pairs.push({
        key: `${dateIso}|${t1.reg}|${t1.tr}|${t2.reg}|${t2.tr}`,
        date: dateIso,
        category: isManned(t1.reg, regCfg) ? "manned" : "unmanned",
        t1: brief(t1, regCfg),
        t2: { ...brief(t2, regCfg), items: t2.items.map((it) => ({ ...it, onT1: t1codes.has(it.code) })) },
        gapSec: gap, gapMin: Math.round(gap / 60),
        repeat, training: !!train, vision,
        trainingRef: train ? { time: train.time, reg: train.reg, op: train.op, tr: train.tr } : null,
        sameCashier: t1.reg === t2.reg && t1.op === t2.op,
        token: tok.slice(-6),
        score: scorePair(t1, t2, flags, regCfg),
      });
    }
  }
  pairs.sort((a, b) => (b.training - a.training) || (money(b.t2.total) - money(a.t2.total)));
  return pairs;
}

/**
 * Training receipts for one day, each traced to the paid sale that carries
 * its lines (paysForTraining; any tender — this is how cash customers get in) and, when
 * that sale has a token, back to the customer's earlier transaction.
 */
export function findTrainings(tx, dateIso, opts = DEFAULT_OPTS, regCfg = DEFAULT_REGISTERS) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const out = [];
  for (const tr of tx) {
    if (!tr.isTraining || !tr.items.length) continue;
    const paid = tx.filter((x) => !x.isTraining && x.isSale && Math.abs(x.t - tr.t) <= o.trainingWindowSec && paysForTraining(x, tr, o));
    out.push({
      key: `${dateIso}|train|${tr.reg}|${tr.tr}`,
      date: dateIso, time: tr.time, reg: tr.reg, op: tr.op, tr: tr.tr,
      items: tr.items,
      paid: paid.map((s) => {
        const prev = s.token ? tx.filter((x) => x.token === s.token && x.isSale && !x.isTraining && x.t < s.t && s.t - x.t <= 2 * o.maxGapSec).pop() : null;
        return { ...brief(s, regCfg), hasToken: !!s.token, prev: prev ? brief(prev, regCfg) : null };
      }),
    });
  }
  return out;
}

/** Everything the module stores for one store-day. */
export function analyzeDay(records, dateIso, opts = DEFAULT_OPTS, regCfg = DEFAULT_REGISTERS) {
  const tx = compactRecords(records);
  const sales = tx.filter((x) => x.isSale && !x.isTraining);
  return {
    date: dateIso,
    stats: { records: Array.isArray(records) ? records.length : (records?.records?.length || 0), transactions: tx.length, sales: sales.length, tokenedSales: sales.filter((x) => x.token).length },
    pairs: findPairs(tx, dateIso, opts, regCfg),
    trainings: findTrainings(tx, dateIso, opts, regCfg),
    // op number → name from the day's sign-on banners (the register L/S triage
    // reads the same banners); the service worker merges these per store so
    // the cashier ledger and the miss form can name the operator.
    operators: operatorNames(records),
  };
}
