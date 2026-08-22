// shared/marketRoster.js
//
// Central mapping of Walmart market number → store roster. Sourced from
// what was previously duplicated as DEFAULT_STORES in claimsdisposition
// and STORE_COORDS keys in orcmonitor. New markets can be added here
// without touching consumer modules.
//
// Consumers pair it with getUserHomeMarket() from shared/userStore.js —
// the market comes from Settings > Defaults, the roster comes from here.
// Both claimsdisposition/service.js (pull fallback roster) and
// claimsdisposition/view.js (first-run store picker) go through that pair;
// neither holds a store list of its own any more.
//
// getMarketRoster() returns null for a market with no entry. That is a
// normal state, not an error — callers must ask the user for stores rather
// than substituting a market they happen to know.
//
// Roster values are integers so consumers can pass them straight into
// numeric filter APIs (Looker _STORE_ filter, Hoops POST bodies, etc.).

export const MARKET_ROSTERS = {
  "120": [658, 669, 756, 1089, 1215, 1458, 2988, 3660, 5151, 5173],
};

export function getMarketRoster(marketNbr) {
  return MARKET_ROSTERS[String(marketNbr)] ?? null;
}

export function listKnownMarkets() {
  return Object.keys(MARKET_ROSTERS);
}
