// modules/safetyagent/lib/aggregate.js
//
// Pure roll-ups over compact hazard rows (see lib/sql.js::compactRow).
// Runs in the shell page; nothing here touches chrome.* APIs.

export const COL = Object.freeze({
  ts: 0, camera: 1, dept: 2, reason: 3, assoc: 4, ack: 5, action: 6, type: 7, ttc: 8, date: 9, aisle: 10, id: 12, hold: 13,
});

// An accepted alert open longer than this is "held": nobody else can complete
// it while it sits on the accepter's queue.
export const HOLD_LONG_MIN = 10;

// Per-alert working allowance for the EXCESS hold roll-up. Raw hold totals
// skew toward whoever answers the most alerts — 47 quick closes outrank one
// alert parked for 108 minutes. The store's measured accept→complete median
// is 0.6–0.7 min on every disposition, so 3 minutes is already ~4× the norm
// and covers travel plus cleanup; only minutes past it count as "sat on it".
export const HOLD_GRACE_MIN = 3;

// Volume-noise floor for the top-holds ranking. Someone answering 27–47
// alerts collects a little excess by sheer volume (the odd big spill); that
// is not the same behavior as parking alerts. Only associates whose excess
// averages at least this many minutes per worked alert make the list.
export const HOLD_NOISE_PER_ALERT_MIN = 1;

// The 12 quick-select tags SafeIQ lets an associate close an alert with.
// Confirmed as a closed set by the dashboard's own notes — never free text.
export const TAGS = Object.freeze([
  "no_hazard_found", "no_spill", "no_object",
  "cleaned_object", "cleaned_spill",
  "trash_debris", "product_off_shelf", "wet_spill", "dry_spill", "food_debris", "spill_found", "object_found",
]);

// Reviewer grouping of the tags — not a SafeIQ field.
export const FAMILY = Object.freeze({
  no_hazard_found: "nhf", no_spill: "nhf", no_object: "nhf",
  cleaned_object: "clr", cleaned_spill: "clr",
  trash_debris: "haz", product_off_shelf: "haz", wet_spill: "haz", dry_spill: "haz",
  food_debris: "haz", spill_found: "haz", object_found: "haz",
});
export const FAMILY_ORDER = Object.freeze(["nhf", "clr", "haz", "none"]);
export const FAMILY_NAME = Object.freeze({
  nhf: "Nothing there on arrival", clr: "Cleared before arrival", haz: "Hazard confirmed", none: "No tag",
});

export const familyOf = (tag) => FAMILY[tag] || "none";

// action_category — how the alert was answered at the device, as distinct from
// the tag it was closed with. Verified against store 1458's whole history
// (2,227 alerts): ACCEPTED 2,209, NOT AVAILABLE 14, NO ACTION 4 — and every
// non-ACCEPTED row has an EMPTY associate_name. SafeIQ does not record who
// declined an alert, so a per-associate "rejected" count is not derivable;
// the attributable refusal is accepting and then closing it as nothing there.
export const ACTION_ORDER = Object.freeze(["acc", "na", "noact"]);
export const ACTION_NAME = Object.freeze({
  acc: "Accepted", na: "Not available", noact: "No action", other: "Other",
});
export function actionKey(action) {
  const a = String(action || "").toUpperCase();
  if (a === "ACCEPTED") return "acc";
  if (a === "NOT AVAILABLE") return "na";
  if (a === "NO ACTION") return "noact";
  return "other";
}

// Measured and rejected as a refusal signal (store 1458, 2,228 alerts): response
// time does not discriminate. Detection→accept is a 1.5 min median on
// nothing-there closes and 1.4 min on confirmed hazards; accept→task-complete is
// a 0.6-0.7 min median on EVERY disposition family, including 731 of the 1,079
// confirmed hazards. Associates accept on the handheld once they are already at
// the spot, so a fast close is the house norm, not evidence nobody looked.
// Closing several alerts on different aisles inside 60 s was rejected too: 8% of
// all closes, concentrated in supervisors clearing a queued backlog, and mostly
// on confirmed hazards. The one attributable signal that survives is the
// per-camera baseline comparison below.

// Store-wide share of each camera's alerts closed as nothing-there. Used as the
// baseline an associate's own rate is measured against, so working an area whose
// camera genuinely over-fires does not read as waving alerts away.
export function cameraNhfRate(rows) {
  const tot = new Map(), nhf = new Map();
  for (const r of rows) {
    const c = r[COL.camera] || "(none)";
    tot.set(c, (tot.get(c) || 0) + 1);
    if (familyOf(r[COL.reason]) === "nhf") nhf.set(c, (nhf.get(c) || 0) + 1);
  }
  const rate = new Map();
  for (const [c, n] of tot) rate.set(c, (nhf.get(c) || 0) / n);
  return rate;
}

export function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Group rows by one column. Each group carries per-tag, per-family and
// per-action counts, the no_hazard_found share, and median ack / done minutes.
//
// opts.camRate — cameraNhfRate() over the same window. When given, each group
//   also gets g.exp (nothing-there closes the store's own per-camera rates
//   predict for exactly the cameras this group answered) and g.idx = nhf / exp.
//   Pass it only for associate grouping; for camera grouping it is circular.
export function groupBy(rows, col, opts = {}) {
  const camRate = opts.camRate || null;
  const m = new Map();
  for (const r of rows) {
    const key = r[col] || "(none)";
    let g = m.get(key);
    if (!g) {
      g = { key, dept: r[COL.dept], total: 0, tag: {}, fam: { nhf: 0, clr: 0, haz: 0, none: 0 },
            act: { acc: 0, na: 0, noact: 0, other: 0 }, exp: camRate ? 0 : null,
            acks: [], ttcs: [], holds: [], holdLong: 0, rows: [] };
      m.set(key, g);
    }
    g.total++;
    const t = r[COL.reason] || "(none)";
    g.tag[t] = (g.tag[t] || 0) + 1;
    const fam = familyOf(r[COL.reason]);
    g.fam[fam]++;
    g.act[actionKey(r[COL.action])]++;
    if (camRate) g.exp += camRate.get(r[COL.camera] || "(none)") || 0;
    if (r[COL.ack] != null) g.acks.push(r[COL.ack]);
    if (r[COL.ttc] != null) g.ttcs.push(r[COL.ttc]);
    if (r[COL.hold] != null) { g.holds.push(r[COL.hold]); if (r[COL.hold] > HOLD_LONG_MIN) g.holdLong++; }
    g.rows.push(r);
  }
  for (const g of m.values()) {
    // "Non-issue" = the nothing-there family: no_hazard_found + no_spill + no_object.
    g.nhf = g.fam.nhf;
    g.nhfPct = g.total ? g.nhf / g.total : 0;
    g.nhfTag = g.tag.no_hazard_found || 0;
    g.idx = g.exp ? g.nhf / g.exp : null;
    g.medAck = median(g.acks);
    g.medTtc = median(g.ttcs);
    g.medHold = median(g.holds);
    g.maxHold = g.holds.length ? Math.max(...g.holds) : null;
    // Sum, not average: one alert held 40 minutes is significant even when
    // the median is seconds — it's 40 minutes nobody else could complete it.
    g.totHold = g.holds.length ? Math.round(g.holds.reduce((a, b) => a + b, 0) * 10) / 10 : null;
    g.excessHold = g.holds.length
      ? Math.round(g.holds.reduce((a, b) => a + Math.max(0, b - HOLD_GRACE_MIN), 0) * 10) / 10
      : null;
  }
  return [...m.values()];
}

export function summarize(rows) {
  const total = rows.length;
  const byTag = {};
  const byFam = { nhf: 0, clr: 0, haz: 0, none: 0 };
  const byAction = { acc: 0, na: 0, noact: 0, other: 0 };
  const acks = [];
  const holds = [];
  let gt10 = 0, holdLong = 0;
  let last = "";
  let minDate = "", maxDate = "";
  for (const r of rows) {
    const t = r[COL.reason] || "(none)";
    byTag[t] = (byTag[t] || 0) + 1;
    const fam = familyOf(r[COL.reason]);
    byFam[fam]++;
    byAction[actionKey(r[COL.action])]++;
    if (r[COL.ack] != null) { acks.push(r[COL.ack]); if (r[COL.ack] > 10) gt10++; }
    if (r[COL.hold] != null) { holds.push(r[COL.hold]); if (r[COL.hold] > HOLD_LONG_MIN) holdLong++; }
    if (r[COL.ts] > last) last = r[COL.ts];
    const d = r[COL.date];
    if (d) { if (!minDate || d < minDate) minDate = d; if (!maxDate || d > maxDate) maxDate = d; }
  }
  const nhf = byFam.nhf;   // non-issue closures (nothing there on arrival)
  const cameras = new Set(rows.map((r) => r[COL.camera])).size;
  const associates = new Set(rows.map((r) => r[COL.assoc]).filter(Boolean)).size;
  const days = new Set(rows.map((r) => r[COL.date]).filter(Boolean)).size;
  const totHold = Math.round(holds.reduce((a, b) => a + b, 0) * 10) / 10;
  const excessHold = Math.round(holds.reduce((a, b) => a + Math.max(0, b - HOLD_GRACE_MIN), 0) * 10) / 10;
  return { total, nhf, byTag, byFam, byAction, medAck: median(acks), gt10,
           medHold: median(holds), totHold, excessHold, holdLong, last, minDate, maxDate, days, cameras, associates };
}

export function byHour(rows) {
  const H = Array.from({ length: 24 }, (_, h) => ({ h, total: 0, nhf: 0 }));
  for (const r of rows) {
    const ts = r[COL.ts];
    if (!ts) continue;
    const h = Number(ts.slice(11, 13));
    if (!Number.isInteger(h)) continue;
    H[h].total++;
    if (familyOf(r[COL.reason]) === "nhf") H[h].nhf++;
  }
  return H.filter((x) => x.total > 0);
}
