// modules/registerls/lib/match_opts.js
//
// Overrides passed to the Live Dashboard register engine's runMatching().
// The engine's own default lets an offset sit up to 99 registers away (its
// comment argues 68/78 are keypad-adjacent). The analyst's rule is the
// opposite: tills get checked in as each other only on neighbouring
// registers — 62 and 63 flip, 63 and 12 do not. A far-away "match" is
// noise that hides a real shortage behind a "probable flip" label.
export const NEARBY_REGISTER_DELTA = 3;

// Strict (tier-1) options. Matching runs in tiers — see lib/matching.js —
// so a near-miss ($331 short vs $350 over) is only offered where nothing
// exact exists, and evidence.js never auto-files a pair whose amounts miss
// this tolerance.
// Two exceptions to the neighbour rule, both from the analyst (2026-09-16):
//
// 1. The service desk (registers 92/93/94) is used to fix errors keyed on
//    other manned registers, so its over/short offsets ANY register. The
//    engine treats these as `wideRegisters`: no distance limit, and distance
//    is not held against the pair when scoring.
// 2. Two far-apart registers with similar amounts on the SAME day are
//    probably a flip too (reg 21 -$158 / reg 95 +$145 on 07-24). That runs
//    as a last tier — only over what the neighbour tiers left — and is
//    always review-only.
export const SERVICE_DESK_REGISTERS = Object.freeze(["92", "93", "94"]);
export const isServiceDesk = (registerNbr) => SERVICE_DESK_REGISTERS.includes(String(registerNbr));

export const MATCH_OPTS = Object.freeze({
  nearbyRegisterRangeDelta: NEARBY_REGISTER_DELTA,
  wideRegisters: SERVICE_DESK_REGISTERS,
});
