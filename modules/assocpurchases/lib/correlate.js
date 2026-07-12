// modules/assocpurchases/lib/correlate.js
//
// Cross-reference MUMD markdown rows against APPRISS markdown purchases.
//
// Two patterns flagged:
//   SELF    — the associate who did the markdown also appears in the APPRISS
//             discount-card purchase list (same person bought what they marked).
//   CROSS   — a different associate bought a non-food item using their discount
//             card within 1 hour of it being marked down (any-associate pattern).
//             Requires MUMD rows to have a timestamp column; skipped if absent.
//
// Name matching strategy:
//   MUMD wins resolve to "First Last" via Workvivo (e.g. "Shane Smith").
//   APPRISS returns cardholder names in various formats (e.g. "SMITH SHANE",
//   "SMITH, SHANE", "SHANE SMITH"). We check if both the first and last name
//   tokens from the resolved name appear in the APPRISS cardholder name string,
//   case-insensitive. Require both tokens to reduce false positives.

const CROSS_PURCHASE_WINDOW_MS = 60 * 60 * 1000;  // 1 hour

// ── Name matching ─────────────────────────────────────────────────────────────

// Split "Shane Smith" into ["Shane", "Smith"]. Drop short tokens (< 2 chars).
function nameTokens(name) {
  return (name || "")
    .toUpperCase()
    .split(/[\s,]+/)
    .map(t => t.replace(/[^A-Z]/g, ""))
    .filter(t => t.length >= 2);
}

// Returns true if ALL tokens from resolvedName appear in apprissCardholderName.
export function nameMatchesAppriss(resolvedName, apprissCardholderName) {
  if (!resolvedName || !apprissCardholderName) return false;
  const tokens = nameTokens(resolvedName);
  if (tokens.length < 2) return false;   // need at least first + last
  const target = apprissCardholderName.toUpperCase();
  return tokens.every(t => target.includes(t));
}

// ── Column discovery helpers ──────────────────────────────────────────────────

// Given MUMD headers, find the index for a column that matches any of the hints.
// Hints can be strings (converted to case-insensitive regex) or RegExp objects.
function findCol(headers, ...hints) {
  for (const hint of hints) {
    const re = hint instanceof RegExp ? hint : new RegExp(hint, "i");
    const i  = headers.findIndex(h => re.test(h));
    if (i !== -1) return i;
  }
  return -1;
}

// ── Main correlation ──────────────────────────────────────────────────────────

/**
 * correlate(mumdData, apprissRows, resolvedNames)
 *
 * @param mumdData        { headers: string[], rows: string[][] }
 * @param apprissRows     Array of { cardholderName, firstName, lastName, totalAmount, txnCount, ... }
 * @param resolvedNames   Map<win, string|null>  (WIN → "First Last" or null)
 *
 * @returns {
 *   selfPurchases: SelfPurchaseResult[],   // associate both marked down AND purchased
 *   crossPurchases: CrossPurchaseResult[], // different associate bought within 1h (if timestamps present)
 *   unmatchedMarkdowns: string[],          // WINs with no name resolution
 *   hasTimestamps: boolean,
 * }
 */
export function correlate(mumdData, apprissRows, resolvedNames) {
  const { headers, rows } = mumdData;

  // Discover MUMD column positions.
  // Probe confirmed column names: Dept, Event Description, UPC Nbr, Item Nbr,
  // Item Description, Old Sell, New Sell, QTY, DIFF, Net MUMD Amt, User ID,
  // Date Posted, Invoice Nbr
  const colWin    = findCol(headers, /^user.?id$/i, "user.?id", "win", "associate");
  const colItem   = findCol(headers, /^upc.?nbr$/i, /^item.?nbr$/i, /^item.?desc/i, "upc", "item");
  const colTs     = findCol(headers, /^date.?posted$/i, "date", "time", "timestamp");
  const colAmount = findCol(headers, /^net.?mumd/i, "amount", "diff", "price");
  const colDept   = findCol(headers, /^dept$/i, "dept", "department");
  const hasTimestamps = colTs !== -1;

  // Build a lookup: normalised cardholder name → appriss row.
  // One person may appear multiple times; keep all.
  const apprissMap = new Map();  // upperKey → row[]
  for (const row of apprissRows) {
    const rawName = row.cardholderName || [row.lastName, row.firstName].filter(Boolean).join(" ");
    if (!rawName) continue;
    const key = rawName.toUpperCase();
    if (!apprissMap.has(key)) apprissMap.set(key, []);
    apprissMap.get(key).push(row);
  }

  // Group MUMD rows by WIN.
  const mdByWin = new Map();
  for (const row of rows) {
    const win  = colWin !== -1 ? row[colWin]?.trim().toLowerCase() : null;
    if (!win) continue;
    if (!mdByWin.has(win)) mdByWin.set(win, []);
    mdByWin.get(win).push(row);
  }

  const selfPurchases     = [];
  const unmatchedMarkdowns = [];

  for (const [win, mdRows] of mdByWin) {
    const resolvedName = resolvedNames.get(win) ?? null;
    if (!resolvedName) {
      unmatchedMarkdowns.push(win);
      continue;
    }

    // Try to find a matching APPRISS cardholder for this associate.
    let matchedApprissRow = null;
    for (const [, apprissRowList] of apprissMap) {
      const candidate = apprissRowList[0];
      if (nameMatchesAppriss(resolvedName, candidate.cardholderName || `${candidate.lastName} ${candidate.firstName}`)) {
        matchedApprissRow = candidate;
        break;
      }
    }

    if (matchedApprissRow) {
      selfPurchases.push({
        win,
        resolvedName,
        markdownCount: mdRows.length,
        markdownItems: colItem !== -1
          ? [...new Set(mdRows.map(r => r[colItem]).filter(Boolean))]
          : [],
        markdownAmount: colAmount !== -1
          ? mdRows.reduce((s, r) => s + (parseFloat(r[colAmount]) || 0), 0).toFixed(2)
          : null,
        appriss: matchedApprissRow,
      });
    }
  }

  // Cross-purchase detection (needs timestamps).
  const crossPurchases = [];
  if (hasTimestamps) {
    // Build timeline of all MUMD markdown events: { win, item, ts }.
    const mdEvents = [];
    for (const row of rows) {
      const win  = colWin  !== -1 ? row[colWin]?.trim().toLowerCase() : null;
      const item = colItem !== -1 ? row[colItem]?.trim()              : null;
      const tsRaw= colTs   !== -1 ? row[colTs]?.trim()               : null;
      const ts   = tsRaw ? Date.parse(tsRaw) : NaN;
      if (!isNaN(ts) && item) mdEvents.push({ win, item, ts });
    }

    // Cross-purchase: for each APPRISS cardholder that DIDN'T do any markdowns
    // themselves, check if any of their purchases fall within 1h of a markdown
    // event on the same item.
    // (Phase 1: we don't have APPRISS transaction-level timestamps, only
    //  summary-level data. Mark this as "pending detail drill-down".)
    // TODO: once APPRISS detail drill-down is implemented, populate this.
  }

  return { selfPurchases, crossPurchases, unmatchedMarkdowns, hasTimestamps };
}
