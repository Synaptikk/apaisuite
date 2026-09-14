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
export const MATCH_OPTS = Object.freeze({
  nearbyRegisterRangeDelta: NEARBY_REGISTER_DELTA,
});
