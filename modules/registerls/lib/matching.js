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
