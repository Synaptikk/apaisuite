// modules/boblisa/lib/misses.js
//
// Documented misses: the analyst's record that a cashier on a manned lane
// let an item leave the register unpaid, what it was, how it was caught, and
// the coaching note. A record is a snapshot of the pair it was built from
// (the journal cache is per store-day and gets re-pulled / cleared; the
// record must survive that) plus the analyst's fields.
//
//   buildRecord(pair, store, fields, by)  → record (pure; caller persists)
//   draftNote(pair)                        → plain-English description to edit
//   rollupByCashier(records)               → [{ op, name, count, cents, first, last, causes }]
//   missesCsv(records)                     → CSV text (one row per record)
//
// Pure — no DOM, no chrome.*, safe in the SW, the shell and node.

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

/** Total of the second transaction's items — what the register missed. */
export function missedCents(pair) {
  return (pair?.t2?.items || []).reduce((s, it) => s + cents(it.cents), 0) || cents(pair?.t2?.total);
}

/** Suggested note; the analyst edits it before saving. */
export function draftNote(pair) {
  if (!pair) return "";
  const t1 = pair.t1 || {}, t2 = pair.t2 || {};
  const items = (t2.items || []).map((it) => `${it.desc} ${money(it.cents)}`).join(", ");
  const parts = [
    `${mdy(pair.date)} ${hm(t1.time)}: reg ${t1.reg} (${t1.type || "manned"}), op ${t1.op}, TR ${t1.tr}, ${t1.items} items ${money(t1.total)}.`,
    `Same card back ${pair.gapMin} min later at reg ${t2.reg} (${t2.type || ""}) TR ${t2.tr} for ${items || money(t2.total)}.`,
  ];
  if (pair.trainingRef) parts.push(`Training receipt printed ${hm(pair.trainingRef.time)} at reg ${pair.trainingRef.reg} by op ${pair.trainingRef.op}.`);
  return parts.join(" ");
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
          items: (t2.items || []).map((it) => ({ desc: it.desc, code: it.code, cents: cents(it.cents), onT1: !!it.onT1 })) },
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
      (r.t2?.items || []).map((it) => `${it.desc} ${(cents(it.cents) / 100).toFixed(2)}`).join("; "),
      (cents(r.missedCents) / 100).toFixed(2),
      r.flags?.training ? "yes" : "", r.flags?.vision ? "yes" : "",
      CAUSES[r.cause] || r.cause, OUTCOMES[r.outcome] || r.outcome,
      VIDEO_REVIEW[r.video] || r.video || "", r.videoIds?.t1?.cctvUrl || r.videoIds?.t2?.cctvUrl || "", r.note,
      r.createdByName || r.createdBy, r.createdAt,
    ].map(q).join(","));
  }
  return lines.join("\r\n");
}
