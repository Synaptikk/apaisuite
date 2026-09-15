// modules/registerls/lib/pantry.js
//
// The associate pantry: items the store keeps stocked in the break room.
// Process: ring them up, cash the ticket out, and complete a CFT to the
// register for that amount. When the CFT is skipped the register is short
// exactly the ticket. A cash ticket made mostly of these UPCs is therefore
// the first thing to check on an unmatched shortage.
//
// UPCs are compared as digit strings with leading zeros stripped, so the
// receipt's 007874208830 and the user's 7874208830 are the same item.
// PLU produce (bananas 4011) also appears as the long 064312604011 code.

export const DEFAULT_PANTRY = [
  { upc: "4011",         desc: "BANANAS" },
  { upc: "64312604011",  desc: "BANANAS" },
  { upc: "7874208830",   desc: "FOAM PLATES" },
  { upc: "7874200871",   desc: "VARIETY PAC" },
  { upc: "7874234937",   desc: "GV 20OZ BWL" },
  { upc: "7978310128",   desc: "AST CH-CH 20" },
  { upc: "7874213641",   desc: "GV OATMEAL" },
  { upc: "7066203003",   desc: "NISSIN CUP" },
  { upc: "60538818792",  desc: "GV SPAG RING" },
  { upc: "7874202459",   desc: "GV CHWY 48" },
];

export const normUpc = (v) => String(v ?? "").replace(/\D/g, "").replace(/^0+/, "");

// The analyst's own additions, one item per line: the UPC first, then the
// description as the receipt prints it ("7874208830 FOAM PLATES",
// "007874208830, FOAM PLATES", tab-separated, or a bare UPC). Blank lines
// and "#" comments are skipped; a line with no UPC of at least four digits
// is reported back so a typo does not vanish silently.
export function parsePantryText(text) {
  const items = [], rejected = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^0*(\d{4,})\s*[,;\t]?\s*(.*)$/);
    if (!m) { rejected.push(line); continue; }
    items.push({ upc: m[1], desc: m[2].trim().toUpperCase() || `UPC ${m[1]}` });
  }
  return { items, rejected };
}

// Every distinct item on a raw EJ receipt ("NISSIN CUP   007066203003  SF      0.50 BD"),
// as add-to-list text: one "UPC DESCRIPTION" line per product. Lets the
// analyst put a pantry receipt they already have on the list in one click.
export function receiptUpcs(raw) {
  const seen = new Map();
  for (const line of String(raw || "").split(/\r?\n/)) {
    const m = line.match(/^(.{1,13}?)\s+0*(\d{4,12})\s+[A-Z]{1,3}\s+\d/);
    if (m && !seen.has(m[2])) seen.set(m[2], m[1].trim().toUpperCase());
  }
  return [...seen.entries()].map(([upc, desc]) => ({ upc, desc }));
}
export const receiptPantryText = (raw) => receiptUpcs(raw).map((p) => `${p.upc} ${p.desc}`).join("\n");

// The list the analysis runs on: the built-in items plus the analyst's,
// keyed by normalized UPC (the analyst's description wins on a clash).
export function mergePantry(custom, defaults = DEFAULT_PANTRY) {
  const out = new Map();
  for (const p of defaults) out.set(normUpc(p.upc), { upc: p.upc, desc: p.desc, source: "default" });
  for (const p of custom || []) if (normUpc(p.upc)) out.set(normUpc(p.upc), { upc: String(p.upc), desc: String(p.desc || "").toUpperCase(), source: "custom" });
  return [...out.values()];
}

// items: ej_parse item lines [{ desc, code, cents, voided }].
// A pantry run is a significant basket: at least `minLines` pantry lines
// spread over at least `minProducts` different pantry items. One or two
// pantry items on a ticket is a customer buying bananas and cup noodles.
export function pantryMatch(items, pantry = DEFAULT_PANTRY, { minLines = 10, minProducts = 3 } = {}) {
  const byUpc = new Map(pantry.map((p) => [normUpc(p.upc), p.desc]));
  const byDesc = new Set(pantry.map((p) => p.desc.toUpperCase()));
  const live = (items || []).filter((i) => !i.voided);
  const hits = live.filter((i) => byUpc.has(normUpc(i.code)) || byDesc.has(String(i.desc || "").trim().toUpperCase()));
  if (hits.length < minLines) return null;
  const counts = new Map();
  for (const h of hits) { const k = (byUpc.get(normUpc(h.code)) || h.desc || "").trim().toUpperCase(); counts.set(k, (counts.get(k) || 0) + 1); }
  if (counts.size < minProducts) return null;
  const cents = hits.reduce((n, i) => n + (Number.isFinite(i.cents) ? i.cents : 0), 0);
  return {
    lines: hits.length, total: live.length, share: live.length ? hits.length / live.length : 0, cents,
    products: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ×${n}`),
  };
}
