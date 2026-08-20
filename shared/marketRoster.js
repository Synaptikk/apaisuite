// shared/marketRoster.js
//
// Central mapping of Walmart market number → store roster. Sourced from
// what was previously duplicated as DEFAULT_STORES in claimsdisposition
// and STORE_COORDS keys in orcmonitor. New markets can be added here
// without touching consumer modules.
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
