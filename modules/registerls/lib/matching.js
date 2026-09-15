// modules/registerls/lib/matching.js
//
// Tiered offset matching over the Live Dashboard register engine.
//
// Tier 1 runs the engine with the strict tolerance (±$5 under $100, ±5%
// over). Every pair it finds is claimed: both register-days leave the pool.
// Tier 2 runs again, only over what is left, with the looser tolerance (±$10
// / ±10%). Its findings are marked `tier: 2` and evidence.js never auto-files
// them — they surface as "weak offset" for the analyst with the gap shown.
//
// So an exact same-day pair is always paired with itself, and a near-miss
// can only be offered where nothing exact exists. Adding a tier is one more
// entry in TIERS.

import { runMatching } from "../../livedashboard/lib/sources/register.js";
import { NEARBY_REGISTER_DELTA } from "./match_opts.js";

export const TIERS = [
  { tier: 1, label: "exact",     opts: { nearbyRegisterRangeDelta: NEARBY_REGISTER_DELTA, toleranceSmallCents: 500,  tolerancePct: 0.05 } },
  { tier: 2, label: "near-miss", opts: { nearbyRegisterRangeDelta: NEARBY_REGISTER_DELTA, toleranceSmallCents: 1000, tolerancePct: 0.10 } },
];

const key = (d) => `${d.registerNbr}|${d.date}`;

export function tieredMatching(discrepancies, tiers = TIERS) {
  let pool = [...(discrepancies || [])];
  const findings = [];
  for (const t of tiers) {
    if (!pool.length) break;
    const found = runMatching(pool, t.opts);
    const claimed = new Set();
    for (const f of found) {
      if (f.matchType === "none") continue;
      f.tier = t.tier;
      findings.push(f);
      claimed.add(`${f.primaryRegister}|${f.primaryDate}`);
      for (const m of f.matchedAgainst || []) claimed.add(`${m.registerNbr}|${m.date}`);
    }
    pool = pool.filter((d) => !claimed.has(key(d)));
  }
  // Whatever is still a shortage after the last tier is genuinely unmatched.
  for (const d of pool) if (d.type === "short") findings.push({ primaryRegister: d.registerNbr, primaryDate: d.date, primaryAmountCents: d.amountCents, matchType: "none", flipConfidence: 0, matchedAgainst: [], severity: Math.abs(d.amountCents) >= 10000 ? "high" : Math.abs(d.amountCents) >= 2500 ? "medium" : "low", tier: null });
  return findings;
}

// ── Multi-entry offsets ────────────────────────────────────────────
//
// The tiers pair one entry against one other entry, on neighbouring
// registers. A cash-office event can land as two or three entries instead —
// reg 18 +$38,812 on 07-23 against reg 18 -$26,016.82 (07-21) + reg 11
// -$13,023 (07-22), $227.82 apart — and the tiers report all three as
// unmatched. For every large entry still unmatched after the tiers, look
// store-wide within a few days for the set of two or three opposite-sign
// unmatched entries whose sum lands within the strict tolerance of it.
// Review-only: evidence.js never auto-files a combination.
export const COMBO_CFG = {
  minCents:      100000,  // only entries of $1,000 or more get a combination search
  days:          3,       // parts within ±3 days of the entry
  maxParts:      3,
  partMinShare:  0.10,    // each part at least 10% of the entry (no padding with small change)
  toleranceSmallCents: 500, toleranceSmallMaxAmt: 10000, tolerancePct: 0.05,
};

const tolC = (abs, cfg) => (abs <= cfg.toleranceSmallMaxAmt ? cfg.toleranceSmallCents : Math.round(abs * cfg.tolerancePct));
const daysBetween = (a, b) => Math.abs(Math.round((new Date(a) - new Date(b)) / 86_400_000));

export function comboOffsets(discrepancies, findings, cfg = COMBO_CFG) {
  const claimed = new Set();
  for (const f of findings || []) {
    if (f.matchType === "none") continue;
    claimed.add(`${f.primaryRegister}|${f.primaryDate}`);
    for (const m of f.matchedAgainst || []) claimed.add(`${m.registerNbr}|${m.date}`);
  }
  const pool = (discrepancies || []).filter((d) => d.amountCents && !claimed.has(key(d)));
  const part = (d) => ({ registerNbr: String(d.registerNbr), date: d.date, amountCents: d.amountCents });
  const combos = [];
  for (const p of pool) {
    const abs = Math.abs(p.amountCents);
    if (abs < cfg.minCents) continue;
    const tol = tolC(abs, cfg);
    const cands = pool.filter((d) => d !== p && Math.sign(d.amountCents) === -Math.sign(p.amountCents) && daysBetween(d.date, p.date) <= cfg.days && Math.abs(d.amountCents) >= abs * cfg.partMinShare && Math.abs(d.amountCents) < abs + tol)
      .sort((a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents));
    let best = null;
    // Rank: parts on the SAME register first (a two-day count corrected on
    // the third is the common shape: reg 23 -$2,167 (07-21) -$1,096 (07-22)
    // +$3,261 (07-23)), then fewest parts, then smallest residual. Without
    // this a store-wide lag day pairs every register with every other.
    const score = (parts, residual) => [parts.filter((d) => String(d.registerNbr) === String(p.registerNbr)).length, -parts.length, -residual];
    const better = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };
    const consider = (parts) => {
      const sum = parts.reduce((s, d) => s + d.amountCents, 0);
      const residual = Math.abs(Math.abs(sum) - abs);
      if (residual > tol) return;
      const sc = score(parts, residual);
      if (!best || better(sc, best.score)) best = { parts, sumCents: sum, residualCents: residual, score: sc };
    };
    for (let i = 0; i < cands.length; i++) {
      for (let j = i + 1; j < cands.length; j++) {
        consider([cands[i], cands[j]]);
        if (cfg.maxParts >= 3) for (let k = j + 1; k < cands.length; k++) consider([cands[i], cands[j], cands[k]]);
      }
    }
    if (best) combos.push({ primaryRegister: String(p.registerNbr), primaryDate: p.date, primaryAmountCents: p.amountCents, parts: best.parts.map(part), sumCents: best.sumCents, residualCents: best.residualCents, sameRegister: best.parts.every((d) => String(d.registerNbr) === String(p.registerNbr)) });
  }
  return combos;
}

// The combination an item belongs to: as the entry the parts add up to
// ("primary") or as one of the parts.
export function findComboFor(combos, item) {
  const reg = String(item.register ?? item.registerNbr), date = item.date;
  const asPrimary = (combos || []).find((c) => c.primaryRegister === reg && c.primaryDate === date);
  if (asPrimary) return { role: "primary", combo: asPrimary };
  // As a part, prefer the combination whose primary is on this register
  // (its own later correction) over one on another register.
  const asParts = (combos || []).filter((c) => c.parts.some((x) => x.registerNbr === reg && x.date === date));
  const asPart = asParts.find((c) => c.primaryRegister === reg) || asParts[0];
  return asPart ? { role: "part", combo: asPart } : null;
}
