/**
 * ej_parse.js — pure parser for Walmart "EJ Viewer" (electronic journal) records.
 *
 * Input shape (one store + business day, optionally one register):
 *   { records: [ { transTime: 112707, opNum: 5638, transNum: 9973, tcNum: "…",
 *                  termNum: 63, index: 7, is16?: true, isEOD?: true,
 *                  record: "<printed receipt text>" } ] }
 *
 * `transTime` is HHMMSS as an integer (21144 === 02:11:44). `is16` marks
 * sign-on / sign-off banners. Receipt text is fixed-width and may carry
 * \u0000 padding after tax flags — every entry point strips it.
 *
 * All money is integer cents; all ids are strings with leading zeros removed.
 * No DOM, no imports — safe in the service worker, the shell page, and node.
 */

const NUL_RE = /\u0000/g;
const MONEY_RE = /(-)?\s*\$?([\d,]+)(?:\.(\d{1,2}))?\s*(-)?/;

const HEADER_RE = /ST#\s*(\d+)\s+OP#\s*(\d+)\s+TE#\s*(\d+)\s+TR#\s*(\d+)/;
// Horizontal whitespace only — `\s` would run onto the date line below.
const TC_RE = /TC#[ \t]*((?:\d+[ \t]*)+)/;
const STAMP_RE = /(\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/g;

// `<DESC> <code>  <S|K|…>    150.00-H` — the sale-type flag is required so
// informational trailer lines (e.g. a gift card's second "46.35" line) are
// not counted as items.
const ITEM_RE = /^(.+?)\s+(\d{6,14})\s+([A-Z]{1,2})\s+(-?[\d,]+\.\d{2})\s*(-)?\s*[A-Z]*\s*$/;
const VOID_MARK_RE = /^\s*\*+\s*VOIDED ENTRY\s*\*+\s*$/;
const TENDER_RE = /^\s*(.+?)\s+TEND\s+(-?[\d,]+\.\d\d-?)/;
const SUBTOTAL_RE = /^\s*SUBTOTAL\s+(-?[\d,]+\.\d\d-?)/;
const TOTAL_RE = /^\s*TOTAL\s+(-?[\d,]+\.\d\d-?)/;
const CHANGE_RE = /^\s*CHANGE DUE\s+(-?[\d,]+\.\d\d-?)/;

// `****** 5638    MALEIGHA CLO******` — operator number then name.
const BANNER_OP_RE = /\*{2,}\s*(\d+)\s+([^*\n]+?)\s*\*{2,}/;

const NO_SALE_RE = /NO SALE|DRAWER OPEN/;
const POST_VOID_RE = /POST VOID/;
const CANCELED_RE = /TRANSACTION CANCELED/;

function clean(text) {
  return typeof text === "string" ? text.replace(NUL_RE, "") : "";
}

function stripZeros(v) {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v).trim().replace(/^0+(?=\d)/, "");
  return s === "" ? null : s;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * 112707 → "11:27:07"; 21144 → "02:11:44". Returns null for non-numeric input.
 */
export function timeIntToHms(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return null;
  const s = String(Math.trunc(v)).padStart(6, "0");
  if (s.length !== 6) return null;
  return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`;
}

/**
 * "150.00-" → -15000, "1,234.56" → 123456, "-4.00" → -400, "766.00" → 76600.
 * A trailing or leading minus makes the value negative. Returns null when the
 * string carries no recognizable amount.
 */
export function centsFromMoney(str) {
  if (typeof str === "number") return Number.isFinite(str) ? Math.round(str * 100) : null;
  const s = clean(str).trim();
  const m = MONEY_RE.exec(s);
  if (!m) return null;
  const whole = m[2].replace(/,/g, "");
  if (!/^\d+$/.test(whole)) return null;
  const frac = (m[3] || "").padEnd(2, "0");
  const cents = Number(whole) * 100 + Number(frac);
  const negative = Boolean(m[1] || m[4]);
  return negative ? -cents : cents;
}

function lastStamp(text) {
  let last = null;
  let m;
  STAMP_RE.lastIndex = 0;
  while ((m = STAMP_RE.exec(text)) !== null) last = m;
  if (!last) return { time: null, timeInt: null };
  const time = `${last[4]}:${last[5]}:${last[6]}`;
  return { time, timeInt: Number(last[4] + last[5] + last[6]) };
}

function tenderKind(label) {
  const u = label.toUpperCase();
  if (/\bCASH\b/.test(u) && !/\bEBT\b/.test(u)) return "cash";
  if (/\bEBT\b/.test(u)) return "ebt";
  if (/\bCHECK\b/.test(u)) return "check";
  if (/\bGIFT\b/.test(u)) return "gift";
  if (/\b(VISA|MASTERCARD|MC|AMEX|DISCOVER|DEBIT|CREDIT|WMPAY|PAY)\b/.test(u)) return "card";
  return "other";
}

/**
 * Parse one printed receipt into a transaction-ish object. Returns null when
 * the text has no `ST# … TR#` header (banners, idle notices, EOD, etc.).
 */
export function parseReceipt(text) {
  const raw = clean(text);
  const header = HEADER_RE.exec(raw);
  if (!header) return null;

  const tcMatch = TC_RE.exec(raw);
  const tcNum = tcMatch ? tcMatch[1].replace(/\s+/g, "") : null;
  const stamp = lastStamp(raw);

  const items = [];
  const tenders = [];
  let subtotalCents = null;
  let totalCents = null;
  let changeDueCents = null;
  let voidedLineCount = 0;
  let pendingVoid = false;

  for (const line of raw.split(/\r?\n/)) {
    if (VOID_MARK_RE.test(line)) {
      voidedLineCount += 1;
      pendingVoid = true;
      continue;
    }
    let m;
    if ((m = TENDER_RE.exec(line))) {
      const label = m[1].trim();
      tenders.push({ kind: tenderKind(label), label, cents: centsFromMoney(m[2]) });
      continue;
    }
    if ((m = SUBTOTAL_RE.exec(line))) { subtotalCents = centsFromMoney(m[1]); continue; }
    if ((m = TOTAL_RE.exec(line))) { totalCents = centsFromMoney(m[1]); continue; }
    if ((m = CHANGE_RE.exec(line))) { changeDueCents = centsFromMoney(m[1]); continue; }
    if ((m = ITEM_RE.exec(line))) {
      if (HEADER_RE.test(line)) continue;
      const amount = centsFromMoney(m[4]);
      const cents = m[5] && amount > 0 ? -amount : amount;
      items.push({ desc: m[1].trim(), code: m[2], cents, voided: pendingVoid });
      pendingVoid = false;
    }
  }

  const cashTendCents = tenders
    .filter((t) => t.kind === "cash" && Number.isFinite(t.cents))
    .reduce((sum, t) => sum + t.cents, 0);

  return {
    index: null,
    transNum: stripZeros(header[4]),
    tcNum,
    opNum: stripZeros(header[2]),
    opName: null,
    termNum: stripZeros(header[3]),
    storeNum: stripZeros(header[1]),
    time: stamp.time,
    timeInt: stamp.timeInt,
    totalCents,
    subtotalCents,
    cashTendCents,
    changeDueCents,
    tenders,
    items,
    voidedLineCount,
    isRefund: Number.isFinite(totalCents) && totalCents < 0,
    isPostVoid: POST_VOID_RE.test(raw),
    isNoSale: NO_SALE_RE.test(raw),
    isCanceled: CANCELED_RE.test(raw),
    raw,
  };
}

function signonKind(text) {
  if (/AUTOMATIC\s+SIGN\s*OFF/.test(text)) return "auto_signoff";
  if (/SIGN\s*OFF/.test(text)) return "signoff";
  if (/SIGN\s*ON/.test(text)) return "signon";
  return null;
}

function eventKind(text, record) {
  if (NO_SALE_RE.test(text)) return "nosale";
  if (POST_VOID_RE.test(text)) return "postvoid";
  if (/TERMINAL IDLE/.test(text)) return "idle";
  if (record?.isEOD || /END OF DAY/.test(text)) return "eod";
  if (/REFRESH TERM CONFIGURATION/.test(text)) return "config";
  return "other";
}

/**
 * Parse a day's worth of EJ records.
 * Returns { transactions, signons, events, dayStats }.
 */
export function parseRecords(records) {
  const list = Array.isArray(records) ? records : Array.isArray(records?.records) ? records.records : [];

  const transactions = [];
  const signons = [];
  const events = [];
  const operators = new Map();

  const touch = (opNum, time, timeInt) => {
    if (!opNum) return null;
    let op = operators.get(opNum);
    if (!op) {
      op = { opNum, name: null, firstSeen: null, lastSeen: null, transactionCount: 0, _first: Infinity, _last: -Infinity };
      operators.set(opNum, op);
    }
    if (Number.isFinite(timeInt)) {
      if (timeInt < op._first) { op._first = timeInt; op.firstSeen = time; }
      if (timeInt > op._last) { op._last = timeInt; op.lastSeen = time; }
    }
    return op;
  };

  list.forEach((rec, i) => {
    const r = rec && typeof rec === "object" ? rec : {};
    const text = clean(r.record);
    const index = Number.isFinite(Number(r.index)) ? Number(r.index) : i;
    const stamp = lastStamp(text);
    const timeInt = Number.isFinite(Number(r.transTime)) ? Number(r.transTime) : stamp.timeInt;
    const time = timeIntToHms(timeInt) ?? stamp.time;
    const recOp = stripZeros(r.opNum);

    const tx = parseReceipt(text);
    if (tx) {
      tx.index = index;
      tx.transNum = stripZeros(r.transNum) ?? tx.transNum;
      tx.tcNum = typeof r.tcNum === "string" && r.tcNum ? r.tcNum : tx.tcNum;
      tx.opNum = recOp ?? tx.opNum;
      tx.termNum = stripZeros(r.termNum) ?? tx.termNum;
      tx.timeInt = timeInt;
      tx.time = time;
      const op = touch(tx.opNum, time, timeInt);
      if (op) op.transactionCount += 1;
      transactions.push(tx);
      return;
    }

    const sKind = signonKind(text);
    if (sKind) {
      const b = BANNER_OP_RE.exec(text);
      const opNum = (b && stripZeros(b[1])) ?? recOp;
      const name = b ? b[2].trim() : null;
      signons.push({ opNum, name, time, timeInt, kind: sKind, index, raw: text });
      const op = touch(opNum, time, timeInt);
      if (op && name && !op.name) op.name = name;
      return;
    }

    const ev = { kind: eventKind(text, r), time, timeInt, index, raw: text };
    if (recOp) ev.opNum = recOp;
    events.push(ev);
    touch(recOp, time, timeInt);
  });

  transactions.sort((a, b) => (a.timeInt ?? 0) - (b.timeInt ?? 0) || a.index - b.index);
  signons.sort((a, b) => (a.timeInt ?? 0) - (b.timeInt ?? 0) || a.index - b.index);
  events.sort((a, b) => (a.timeInt ?? 0) - (b.timeInt ?? 0) || a.index - b.index);

  for (const tx of transactions) {
    const op = tx.opNum ? operators.get(tx.opNum) : null;
    tx.opName = op?.name ?? null;
  }

  const operatorList = [...operators.values()]
    .map(({ _first, _last, ...op }) => op)
    .sort((a, b) => a.opNum.localeCompare(b.opNum, undefined, { numeric: true }));

  const dayStats = {
    recordCount: list.length,
    transactionCount: transactions.length,
    cashTransactionCount: transactions.filter((t) => t.cashTendCents > 0).length,
    refundCount: transactions.filter((t) => t.isRefund).length,
    voidedLineCount: transactions.reduce((n, t) => n + t.voidedLineCount, 0),
    noSaleCount:
      transactions.filter((t) => t.isNoSale).length + events.filter((e) => e.kind === "nosale").length,
    postVoidCount:
      transactions.filter((t) => t.isPostVoid).length + events.filter((e) => e.kind === "postvoid").length,
    operators: operatorList,
  };

  return { transactions, signons, events, dayStats };
}
