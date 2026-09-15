// modules/safetyagent/lib/aggregate.js
//
// Pure roll-ups over compact hazard rows (see lib/sql.js::compactRow).
// Runs in the shell page; nothing here touches chrome.* APIs.

export const COL = Object.freeze({
  ts: 0, camera: 1, dept: 2, reason: 3, assoc: 4, ack: 5, action: 6, type: 7, ttc: 8, date: 9, aisle: 10, id: 12,
});

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

export function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Group rows by one column. Each group carries per-tag and per-family counts,
// the no_hazard_found share, and median ack / done minutes.
export function groupBy(rows, col) {
  const m = new Map();
  for (const r of rows) {
    const key = r[col] || "(none)";
    let g = m.get(key);
    if (!g) {
      g = { key, dept: r[COL.dept], total: 0, tag: {}, fam: { nhf: 0, clr: 0, haz: 0, none: 0 }, acks: [], ttcs: [], rows: [] };
      m.set(key, g);
    }
    g.total++;
    const t = r[COL.reason] || "(none)";
    g.tag[t] = (g.tag[t] || 0) + 1;
    g.fam[familyOf(r[COL.reason])]++;
    if (r[COL.ack] != null) g.acks.push(r[COL.ack]);
    if (r[COL.ttc] != null) g.ttcs.push(r[COL.ttc]);
    g.rows.push(r);
  }
  for (const g of m.values()) {
    // "Non-issue" = the nothing-there family: no_hazard_found + no_spill + no_object.
    g.nhf = g.fam.nhf;
    g.nhfPct = g.total ? g.nhf / g.total : 0;
    g.nhfTag = g.tag.no_hazard_found || 0;
    g.medAck = median(g.acks);
    g.medTtc = median(g.ttcs);
  }
  return [...m.values()];
}

export function summarize(rows) {
  const total = rows.length;
  const byTag = {};
  const byFam = { nhf: 0, clr: 0, haz: 0, none: 0 };
  const acks = [];
  let gt10 = 0;
  let last = "";
  let minDate = "", maxDate = "";
  for (const r of rows) {
    const t = r[COL.reason] || "(none)";
    byTag[t] = (byTag[t] || 0) + 1;
    byFam[familyOf(r[COL.reason])]++;
    if (r[COL.ack] != null) { acks.push(r[COL.ack]); if (r[COL.ack] > 10) gt10++; }
    if (r[COL.ts] > last) last = r[COL.ts];
    const d = r[COL.date];
    if (d) { if (!minDate || d < minDate) minDate = d; if (!maxDate || d > maxDate) maxDate = d; }
  }
  const nhf = byFam.nhf;   // non-issue closures (nothing there on arrival)
  const cameras = new Set(rows.map((r) => r[COL.camera])).size;
  const associates = new Set(rows.map((r) => r[COL.assoc]).filter(Boolean)).size;
  const days = new Set(rows.map((r) => r[COL.date]).filter(Boolean)).size;
  return { total, nhf, byTag, byFam, medAck: median(acks), gt10, last, minDate, maxDate, days, cameras, associates };
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
