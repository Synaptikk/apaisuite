// modules/digitallocks/lib/powerBiQuery.js
//
// Builds the Power BI semantic query for the digital-lock event grid, and
// reads the completeness signal back out of the response.
//
// ── Why we BUILD the query instead of replaying the captured one ───────────
//
// The previous implementation took the data-grid query the report itself had
// fired and patched exactly one thing — `Where[0].Condition.In` — assuming
// that condition was the store slicer. Two things were wrong with that, both
// measured live 2026-08-29 (see dev/DIGITALLOCKS_PULL_FINDINGS.md):
//
//   1. The report persists per-user slicer state, so the captured Where held
//      THREE conditions: store, `Lock Name = 'G7-2'`, and
//      `Zone Name = '46-COSMETICS & SKINCARE-TIER 1'`. Conditions 1 and 2 were
//      replayed verbatim on every pull for every store. Store 1458 returned
//      191 rows in 1 zone where the store actually had 5,338 rows across 11.
//      Whatever the analyst last clicked in Power BI silently became a filter
//      on the review data, and nothing on screen said so.
//
//   2. `Binding.DataReduction.Primary.Window.Count` in the captured body is
//      500 — the grid VISUAL's paging window. It was replayed too, so even
//      with the slicers cleared any store busier than 500 events was cut off.
//
// Building the query removes both by construction: there is nothing to
// inherit, and no positional assumption about a Where clause we did not write.
// The capture is still needed, but only for TRANSPORT — the tenant's QES url,
// the self-contained MWCToken, and the modelId. See service.js::readTransport.
//
// The one thing the response can still hide is truncation, so `IC`
// (IsComplete) is checked on every read; see readQueryResult.

// The nine grid columns. Their decoded names resolve through
// parseLockEvents.js::HEADER_ALIASES unchanged, which is why the DAX path and
// the manual XLSX import share one parser.
//
// DO NOT trim this list to save bandwidth. DSR groups rows by the projection
// tuple, so dropping a column merges rows that differed only in it — measured:
// cutting nine columns to four took store 1458 from 5,338 rows to 5,336. The
// column set is load-bearing for the row COUNT, not just the content.
export const SELECT_COLUMNS = [
  ["Lock Name",      "Query1.lock_name"],
  ["store",          "Query1.store"],
  ["Unlock Source",  "Query1.unlock_source"],
  ["USER ID",        "Query1.user_id"],
  ["Zone Name",      "Query1.zone_name"],
  ["datetime_local", "Query1.datetime_local"],
  ["Position",       "Query1.Position"],
  ["FIRST NAME",     "Query1.FIRST NAME"],
  ["LAST NAME",      "Query1.LAST NAME"],
];

// Server-enforced ceiling. Asking for more is not an error — the service
// clamps and returns a `SpecifiedLimitExceedsMaxIntersections` warning — but
// asking for LESS truncates silently apart from the IC flag, which is exactly
// how the 500-row cap went unnoticed. Always ask for the max.
export const MAX_WINDOW = 30_000;

// Paging fallback, used only when a single unbounded pull comes back
// incomplete. The dataset held ~60 days at the time of probing; 70 gives
// margin without inventing history that does not exist.
export const LOOKBACK_DAYS = 70;
export const PAGE_DAYS = 7;

const SOURCE = { SourceRef: { Source: "q" } };

const col = (property) => ({ Column: { Expression: SOURCE, Property: property } });

// Power BI literals are single-quoted. Store numbers are digits in practice,
// but a value that reached the query with a quote in it would produce a
// malformed filter rather than an error, so it is rejected at the boundary.
function literal(value) {
  const s = String(value);
  if (s.includes("'")) throw new Error(`Invalid literal (contains a quote): ${s}`);
  return { Literal: { Value: `'${s}'` } };
}

/**
 * Build the request body for one store, optionally bounded to a date window.
 *
 * `datetime_local` is a TEXT column, not a datetime — a `datetime'...'`
 * literal is rejected by the server. Its stored format is
 * `YYYY-MM-DD HH:MM:SS.mmm`, so lexicographic ordering is chronological and a
 * plain string comparison is a correct date filter. `from` is inclusive, `to`
 * is exclusive.
 *
 * @param {object}  opts
 * @param {string}  opts.store    store number, e.g. "1458"
 * @param {number}  opts.modelId  from the captured transport
 * @param {string} [opts.from]    inclusive lower bound, "YYYY-MM-DD"
 * @param {string} [opts.to]      exclusive upper bound, "YYYY-MM-DD"
 * @param {number} [opts.window]  row window; defaults to MAX_WINDOW
 */
export function buildStoreQuery({ store, modelId, from, to, window = MAX_WINDOW }) {
  if (!store) throw new Error("store required");
  if (modelId == null) throw new Error("modelId required");

  // Filtering on `store` rather than the report's own `Column` slicer field:
  // both were verified to return identical results, and `store` is the name
  // that also appears in the Select and in HEADER_ALIASES. One fewer magic
  // name to keep in sync.
  const where = [{
    Condition: { In: { Expressions: [col("store")], Values: [[literal(store)]] } },
  }];

  if (from && to) {
    const compare = (kind, value) => ({
      Comparison: { ComparisonKind: kind, Left: col("datetime_local"), Right: literal(value) },
    });
    // 2 = GreaterThanOrEqual, 3 = LessThan.
    where.push({ Condition: { And: { Left: compare(2, from), Right: compare(3, to) } } });
  }

  return {
    version: "1.0.0",
    queries: [{
      Query: {
        Commands: [{
          SemanticQueryDataShapeCommand: {
            Query: {
              Version: 2,
              From: [{ Name: "q", Entity: "Query1", Type: 0 }],
              Select: SELECT_COLUMNS.map(([property, name]) => ({ ...col(property), Name: name })),
              Where: where,
            },
            Binding: {
              Primary: { Groupings: [{ Projections: SELECT_COLUMNS.map((_, i) => i), Subtotal: 1 }] },
              DataReduction: { DataVolume: 3, Primary: { Window: { Count: window } } },
              Version: 1,
            },
            ExecutionMetricsKind: 1,
          },
        }],
      },
      QueryId: "",
    }],
    cancelQueries: [],
    modelId,
    userPreferredLocale: "en-US",
    allowLongRunningQueries: true,
  };
}

/**
 * Pull the data block and the completeness flag out of a QES response.
 *
 * `DS[0].IC` is IsComplete. It is `false` whenever the row window truncated
 * the result — that is the ONLY difference between a truncated response and a
 * whole one, which is why the old 500-row cap looked healthy for so long.
 * A caller that ignores `complete` is reporting a partial store as a full one.
 *
 * @returns {{ data: object|null, complete: boolean, warnings: object[] }}
 */
export function readQueryResult(json) {
  const data = json?.results?.[0]?.result?.data ?? null;
  const ds = data?.dsr?.DS?.[0];
  return {
    data,
    // Absent IC on an empty result set means "nothing to truncate", not
    // "unknown" — a store with no events returns a well-formed response with
    // no DM0 at all.
    complete: ds ? ds.IC !== false : true,
    warnings: Array.isArray(ds?.Msg) ? ds.Msg : [],
  };
}

/**
 * Choose the transport facts from the capture ring: the tenant's QES url, the
 * MWCToken, and the modelId.
 *
 * ANY captured QES request will do — this deliberately does not care whether
 * the request came from the data grid or from a one-column slicer visual. The
 * old code waited specifically for the grid's query because it was going to
 * replay that body; we build our own, so the small slicer queries that land
 * early in a render are just as good and arrive sooner.
 *
 * Newest first, because the MWCToken is short-lived (~82 minutes observed).
 *
 * @param {Array<{url,auth,body,capturedAt}>} entries capture-ring descriptors
 * @returns {{url,auth,modelId,capturedAt}|null}
 */
export function pickTransport(entries) {
  if (!Array.isArray(entries)) return null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e?.url || !e?.auth || !e?.body) continue;
    let modelId = null;
    try { modelId = JSON.parse(e.body).modelId ?? null; } catch { continue; }
    if (modelId == null) continue;
    return { url: e.url, auth: e.auth, modelId, capturedAt: e.capturedAt ?? null };
  }
  return null;
}

/**
 * Consecutive date windows walking BACKWARD from `endDate`, newest first, as
 * `{ from, to }` string pairs where `from` is inclusive and `to` exclusive.
 *
 * Newest first so a paged pull that fails part way through has still fetched
 * the days a reviewer is most likely to be looking at.
 *
 * @param {Date}   endDate     exclusive upper bound of the newest window
 * @param {number} lookbackDays
 * @param {number} pageDays
 */
export function dateWindows(endDate, lookbackDays = LOOKBACK_DAYS, pageDays = PAGE_DAYS) {
  if (pageDays <= 0) throw new Error("pageDays must be positive");
  const day = (d) => {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  };
  // Normalise to a UTC midnight so the windows are whole days regardless of
  // what time of day the pull runs.
  const end = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate()));
  // The newest window must include today's events, so its exclusive upper
  // bound is tomorrow.
  end.setUTCDate(end.getUTCDate() + 1);

  const windows = [];
  let cursor = end;
  let remaining = lookbackDays;
  while (remaining > 0) {
    const span = Math.min(pageDays, remaining);
    const from = new Date(cursor);
    from.setUTCDate(from.getUTCDate() - span);
    windows.push({ from: day(from), to: day(cursor) });
    cursor = from;
    remaining -= span;
  }
  return windows;
}
