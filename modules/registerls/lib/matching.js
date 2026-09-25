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
import { NEARBY_REGISTER_DELTA, SERVICE_DESK_REGISTERS } from "./match_opts.js";

// Tier 3 runs last, over what the neighbour tiers left: same day only, any
// register, near-miss tolerance. Review-only like tier 2 — a far pair is
// "probably a flip", never a filed one. The service desk (92/93/94) pairs
// store-wide in every tier because it is used to fix other registers.
export const TIERS = [
  { tier: 1, label: "exact",        opts: { nearbyRegisterRangeDelta: NEARBY_REGISTER_DELTA, wideRegisters: SERVICE_DESK_REGISTERS, toleranceSmallCents: 500,  tolerancePct: 0.05 } },
  { tier: 2, label: "near-miss",    opts: { nearbyRegisterRangeDelta: NEARBY_REGISTER_DELTA, wideRegisters: SERVICE_DESK_REGISTERS, toleranceSmallCents: 1000, tolerancePct: 0.10 } },
  { tier: 3, label: "same-day-far", opts: { nearbyRegisterRangeDelta: 9999, timeWindowDays: 0, wideRegisters: SERVICE_DESK_REGISTERS, toleranceSmallCents: 1000, tolerancePct: 0.10 } },
];

const key = (d) => `${d.registerNbr}|${d.date}`;

// How the two halves of a pair were allowed to meet: on the same register,
// as neighbours, through the service desk, or far apart on the same day.
export function pairingOf(finding, wide = SERVICE_DESK_REGISTERS) {
  const m = finding?.matchedAgainst?.[0];
  if (!m || finding.matchType === "none") return null;
  if (String(m.registerNbr) === String(finding.primaryRegister)) return "same_register";
  const isWide = (r) => (wide || []).some((w) => String(w) === String(r));
  if (isWide(finding.primaryRegister) || isWide(m.registerNbr)) return "service_desk";
  const delta = Math.abs(Number(m.registerNbr) - Number(finding.primaryRegister));
  return Number.isFinite(delta) && delta > NEARBY_REGISTER_DELTA ? "same_day_far" : "neighbour";
}

const pk = (f) => `${f.primaryRegister}|${f.primaryDate}`;
const mk = (f) => `${f.matchedAgainst[0].registerNbr}|${f.matchedAgainst[0].date}`;

// Which shortage keeps a contested overage: the nearer register, then the
// closer amount, then the earlier day, then the lower register number so the
// answer is stable. Returns 0 for a dead heat — the pair is then flagged
// `tie` and never auto-filed.
function rankClaim(a, b) {
  const delta = (f) => Math.abs(Number(f.matchedAgainst[0].registerNbr) - Number(f.primaryRegister)) || 0;
  const gap = (f) => Math.abs(f.matchedAgainst[0].deltaCents ?? (f.primaryAmountCents + f.matchedAgainst[0].amountCents));
  return delta(a) - delta(b) || gap(a) - gap(b) || (a.primaryDate < b.primaryDate ? -1 : a.primaryDate > b.primaryDate ? 1 : 0);
}
const byRegister = (a, b) => (Number(a.primaryRegister) || 0) - (Number(b.primaryRegister) || 0);

// `locked`: pairs the analyst already filed ({ short: {register, date},
// over: {register, date} }). They are paired first, before any tier, so a
// later pull can never hand the overage to a different shortage.
// `wideRegisters` overrides the built-in 92/93/94: the service worker passes
// the store's own service-desk registers from lib/registers.js.
export function tieredMatching(discrepancies, tiers = TIERS, { locked = [], wideRegisters = null } = {}) {
  const wide = wideRegisters || SERVICE_DESK_REGISTERS;
  if (wideRegisters) tiers = tiers.map((t) => ({ ...t, opts: { ...t.opts, wideRegisters } }));
  let pool = [...(discrepancies || [])];
  const findings = [];
  const lostTo = new Map();   // shortage key → the overage another shortage kept
  for (const L of locked || []) {
    const a = pool.find((d) => key(d) === `${L.short?.register}|${L.short?.date}`);
    const b = pool.find((d) => key(d) === `${L.over?.register}|${L.over?.date}`);
    if (!a || !b || a === b) continue;
    const same = String(a.registerNbr) === String(b.registerNbr);
    const f = { id: `${a.storeNbr}-${a.date}-${a.registerNbr}`, storeNbr: a.storeNbr, primaryRegister: a.registerNbr, primaryDate: a.date, primaryAmountCents: a.amountCents, primaryOperators: a.operators || [], matchType: same ? "same-register-bounceback" : "nearby-register-offset", flipConfidence: 1, matchedAgainst: [{ registerNbr: b.registerNbr, date: b.date, amountCents: b.amountCents, deltaCents: a.amountCents + b.amountCents, daysApart: daysBetween(a.date, b.date) }], severity: "low", tier: 1, locked: true, reason: "Filed as a pair by the analyst." };
    f.pairing = pairingOf(f, wide);
    findings.push(f);
    pool = pool.filter((d) => d !== a && d !== b);
  }
  for (const t of tiers) {
    // One overage closes ONE shortage. When two shortages pick the same
    // overage the better claim keeps it and the others run again without
    // it, so they can find their own partner in this tier.
    while (pool.length) {
      const found = runMatching(pool, t.opts).filter((f) => f.matchType !== "none" && f.matchedAgainst?.[0]);
      if (!found.length) break;
      const groups = new Map();
      for (const f of found) { const k = mk(f); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(f); }
      const claimed = new Set();
      let conflicts = false;
      for (const [k, group] of groups) {
        group.sort((a, b) => rankClaim(a, b) || byRegister(a, b));
        const w = group[0];
        w.tier = t.tier; w.pairing = pairingOf(w, wide);
        if (group.length > 1) {
          conflicts = true;
          w.tie = rankClaim(group[0], group[1]) === 0;
          w.alsoWanted = group.slice(1).map((l) => ({ registerNbr: l.primaryRegister, date: l.primaryDate, amountCents: l.primaryAmountCents, tie: rankClaim(w, l) === 0 }));
          for (const l of group.slice(1)) if (!lostTo.has(pk(l))) lostTo.set(pk(l), { ...w.matchedAgainst[0], wonBy: { registerNbr: w.primaryRegister, date: w.primaryDate, amountCents: w.primaryAmountCents }, tie: rankClaim(w, l) === 0 });
        }
        findings.push(w); claimed.add(pk(w)); claimed.add(k);
      }
      pool = pool.filter((d) => !claimed.has(key(d)));
      if (!conflicts) break;
    }
  }
  // Whatever is still a shortage after the last tier is genuinely unmatched.
  for (const d of pool) if (d.type === "short") findings.push({ primaryRegister: d.registerNbr, primaryDate: d.date, primaryAmountCents: d.amountCents, matchType: "none", flipConfidence: 0, matchedAgainst: [], severity: Math.abs(d.amountCents) >= 10000 ? "high" : Math.abs(d.amountCents) >= 2500 ? "medium" : "low", tier: null });
  // A shortage left unmatched because its only candidate was already taken
  // in an EARLIER tier (or by a filed pair) never lost a contest, but the
  // analyst still needs to know: re-run the loose tiers over the leftovers
  // plus the claimed overages, and name who holds each one.
  const paired = new Map(findings.filter((f) => f.matchType !== "none").map((f) => [pk(f), f]));
  const holder = new Map(findings.filter((f) => f.matchType !== "none").map((f) => [mk(f), f]));
  const leftovers = pool.filter((d) => d.type === "short" && !lostTo.has(key(d)));
  if (leftovers.length && holder.size) {
    const claimedOvers = (discrepancies || []).filter((d) => holder.has(key(d)));
    for (const t of tiers.filter((x) => x.tier >= 2)) {
      for (const f of runMatching([...leftovers, ...claimedOvers], t.opts)) {
        if (f.matchType === "none" || lostTo.has(pk(f))) continue;
        const h = holder.get(mk(f));
        if (h) lostTo.set(pk(f), { ...f.matchedAgainst[0], wonBy: { registerNbr: h.primaryRegister, date: h.primaryDate, amountCents: h.primaryAmountCents }, tie: false, earlier: true });
      }
    }
  }
  for (const f of findings) {
    if (lostTo.has(pk(f))) f.contested = lostTo.get(pk(f));
    if (f.alsoWanted) {
      for (const l of f.alsoWanted) { const p = paired.get(`${l.registerNbr}|${l.date}`); if (p) l.pairedWith = { registerNbr: p.matchedAgainst[0].registerNbr, date: p.matchedAgainst[0].date }; }
      if (f.alsoWanted.every((l) => l.pairedWith)) { f.tie = false; }
    }
  }
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

//
// An entry can close out at either of two figures: the Power BI finalized
// long/short (its `amountCents`) or the amount WorkView raised the item at
// (`raisedAmountCents`, set by unionDiscrepancies when they differ). Reg 11
// 07-22 was raised at -$13,023 and finalized at -$1,735; the reg 18 event
// closes against the raised figure, so every entry is tried at both. A part
// records which one it used (`basis: "grid" | "workview"`), and one entry
// never appears twice in the same set.
export function comboOffsets(discrepancies, findings, cfg = COMBO_CFG) {
  const claimed = new Set();
  for (const f of findings || []) {
    if (f.matchType === "none") continue;
    claimed.add(`${f.primaryRegister}|${f.primaryDate}`);
    for (const m of f.matchedAgainst || []) claimed.add(`${m.registerNbr}|${m.date}`);
  }
  const pool = (discrepancies || []).filter((d) => d.amountCents && !claimed.has(key(d)));
  // Every figure an entry can be matched at.
  const faces = [];
  for (const d of pool) {
    faces.push({ d, key: key(d), amountCents: d.amountCents, basis: "grid" });
    if (d.raisedAmountCents && d.raisedAmountCents !== d.amountCents) faces.push({ d, key: key(d), amountCents: d.raisedAmountCents, basis: "workview" });
  }
  const part = (f) => ({ registerNbr: String(f.d.registerNbr), date: f.d.date, amountCents: f.amountCents, basis: f.basis, gridAmountCents: f.d.amountCents });
  const combos = [];
  for (const p of faces) {
    const abs = Math.abs(p.amountCents);
    if (abs < cfg.minCents) continue;
    const tol = tolC(abs, cfg);
    const cands = faces.filter((f) => f.key !== p.key && Math.sign(f.amountCents) === -Math.sign(p.amountCents) && daysBetween(f.d.date, p.d.date) <= cfg.days && Math.abs(f.amountCents) >= abs * cfg.partMinShare && Math.abs(f.amountCents) < abs + tol)
      .sort((a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents));
    let best = null;
    // Rank: parts on the SAME register first (a two-day count corrected on
    // the third is the common shape: reg 23 -$2,167 (07-21) -$1,096 (07-22)
    // +$3,261 (07-23)), then fewest parts, then parts matched at the
    // finalized figure, then smallest residual. Without the register rule a
    // store-wide lag day pairs every register with every other.
    const score = (parts, residual) => [parts.filter((f) => String(f.d.registerNbr) === String(p.d.registerNbr)).length, -parts.length, parts.filter((f) => f.basis === "grid").length, -residual];
    const better = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };
    const consider = (parts) => {
      if (new Set(parts.map((f) => f.key)).size !== parts.length) return;   // one entry, one figure
      const sum = parts.reduce((s, f) => s + f.amountCents, 0);
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
    if (best) combos.push({ primaryRegister: String(p.d.registerNbr), primaryDate: p.d.date, primaryAmountCents: p.amountCents, primaryBasis: p.basis, primaryGridAmountCents: p.d.amountCents, parts: best.parts.map(part), sumCents: best.sumCents, residualCents: best.residualCents, sameRegister: best.parts.every((f) => String(f.d.registerNbr) === String(p.d.registerNbr)) });
  }
  return combos;
}

// The combination an item belongs to: as the entry the parts add up to
// ("primary") or as one of the parts. When an item sits in more than one
// (reg 11 07-22: primary of $1,735 = reg 13 + reg 68 at the finalized
// figure, part of reg 18's $38,812 at the raised $13,023) the one that
// explains the amount the analyst is looking at — the item's own — wins.
export function findComboFor(combos, item) {
  const reg = String(item.register ?? item.registerNbr), date = item.date;
  const amt = item.amountCents ?? null;
  const asPrimary = (combos || []).filter((c) => c.primaryRegister === reg && c.primaryDate === date).map((c) => ({ role: "primary", combo: c, figure: c.primaryAmountCents }));
  // As a part, prefer the combination whose primary is on this register
  // (its own later correction) over one on another register.
  const asParts = (combos || []).filter((c) => c.parts.some((x) => x.registerNbr === reg && x.date === date))
    .map((c) => ({ role: "part", combo: c, figure: c.parts.find((x) => x.registerNbr === reg && x.date === date).amountCents }))
    .sort((a, b) => (b.combo.primaryRegister === reg) - (a.combo.primaryRegister === reg));
  const all = [...asPrimary, ...asParts];
  if (!all.length) return null;
  if (amt != null) {
    const own = all.find((x) => x.figure === amt);
    if (own) return { role: own.role, combo: own.combo };
  }
  return { role: all[0].role, combo: all[0].combo };
}
