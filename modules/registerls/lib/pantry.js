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

// items: ej_parse item lines [{ desc, code, cents, voided }].
// Returns null when fewer than `min` non-voided lines are pantry items.
export function pantryMatch(items, pantry = DEFAULT_PANTRY, { min = 3 } = {}) {
  const byUpc = new Map(pantry.map((p) => [normUpc(p.upc), p.desc]));
  const byDesc = new Set(pantry.map((p) => p.desc.toUpperCase()));
  const live = (items || []).filter((i) => !i.voided);
  const hits = live.filter((i) => byUpc.has(normUpc(i.code)) || byDesc.has(String(i.desc || "").trim().toUpperCase()));
  if (hits.length < min) return null;
  const counts = new Map();
  for (const h of hits) { const k = (byUpc.get(normUpc(h.code)) || h.desc || "").trim().toUpperCase(); counts.set(k, (counts.get(k) || 0) + 1); }
  const cents = hits.reduce((n, i) => n + (Number.isFinite(i.cents) ? i.cents : 0), 0);
  return {
    lines: hits.length, total: live.length, share: live.length ? hits.length / live.length : 0, cents,
    products: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ×${n}`),
  };
}
