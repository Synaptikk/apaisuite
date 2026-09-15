// shared/pbi_query.js
//
// Build Power BI semantic queries ourselves and read the results back, instead
// of replaying the query a report fired. Same method as
// modules/digitallocks/lib/powerBiQuery.js (measurements in
// dev/DIGITALLOCKS_PULL_FINDINGS.md): the captured request supplies TRANSPORT
// only — the tenant's QES url, the MWCToken, and the report's modelId.
//
// Why market120 needs it: both ISA reports persist the analyst's slicers, and
// the old capture read whatever those slicers produced. Measured 2026-09-15:
//   - ISA Detail's saved state was Market 120 + Store 1458 + reason ISA +
//     2026-08-22..09-06, so "Total Adjusted $" was one store's number.
//   - Backroom Adjustments' saved state was Market 29 + Stolen, so the
//     "Stolen Adj $" on the Market 120 page was Market 29's ($46,758); built
//     for Market 120 it is -$400,300 since 2026-02-01.
//
// Each report has its OWN semantic model (ISA Detail 2196956, Backroom
// Adjustments 2192898 at time of probing), so a transport is only valid for
// queries against the entities of the report it was captured from.
//
// Pure: no chrome, no DOM, no network.

import { decodeDaxGrids } from "./parse_dax_grid.js";

// Server-enforced row ceiling. Asking for more returns the max plus a
// SpecifiedLimitExceedsMaxIntersections warning; asking for less truncates
// with only IC=false to say so.
export const MAX_WINDOW = 30_000;

// Aggregation.Function codes used by Power BI's semantic query.
export const AGG = { SUM: 0, AVG: 1, COUNT: 2, MIN: 3, MAX: 4, COUNT_NON_NULL: 5 };

// Comparison.ComparisonKind codes.
const CMP = { EQ: 0, GT: 1, GTE: 2, LT: 3, LTE: 4 };

const source = (name) => ({ SourceRef: { Source: name } });

/** Plain model column, e.g. column("i", "Adj Reason"). */
export const column = (src, property) => ({ Column: { Expression: source(src), Property: property } });

/** Model measure (DAX), e.g. measure("i", "Adj $"). */
export const measure = (src, property) => ({ Measure: { Expression: source(src), Property: property } });

/** Aggregated column, e.g. aggregate("b", "Total Adj $", AGG.SUM). */
export const aggregate = (src, property, fn = AGG.SUM) =>
  ({ Aggregation: { Expression: column(src, property), Function: fn } });

/** Level of a model hierarchy, e.g. hierarchyLevel("a", "BU Hierarchy", "Store"). */
export const hierarchyLevel = (src, hierarchy, level) =>
  ({ HierarchyLevel: { Expression: { Hierarchy: { Expression: source(src), Hierarchy: hierarchy } }, Level: level } });

// Text literals are single-quoted. A value containing a quote would produce a
// malformed filter rather than an error, so it is rejected at the boundary.
function textLiteral(value) {
  const s = String(value);
  if (s.includes("'")) throw new Error(`Invalid literal (contains a quote): ${s}`);
  return { Literal: { Value: `'${s}'` } };
}

function dateLiteral(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd))) throw new Error(`Invalid date (want YYYY-MM-DD): ${ymd}`);
  return { Literal: { Value: `datetime'${ymd}T00:00:00'` } };
}

/** WHERE expr IN (values…) for text values. */
export function whereIn(expr, values) {
  const list = (Array.isArray(values) ? values : [values]).filter((v) => v != null && v !== "");
  if (!list.length) throw new Error("whereIn needs at least one value");
  return { Condition: { In: { Expressions: [expr], Values: list.map((v) => [textLiteral(v)]) } } };
}

/**
 * Date window on a datetime column: `from` inclusive, `to` exclusive,
 * both "YYYY-MM-DD". Either bound may be omitted.
 */
export function whereDateRange(expr, from, to) {
  const cmp = (kind, ymd) => ({ Comparison: { ComparisonKind: kind, Left: expr, Right: dateLiteral(ymd) } });
  if (from && to) return { Condition: { And: { Left: cmp(CMP.GTE, from), Right: cmp(CMP.LT, to) } } };
  if (from) return { Condition: cmp(CMP.GTE, from) };
  if (to) return { Condition: cmp(CMP.LT, to) };
  throw new Error("whereDateRange needs from and/or to");
}

/**
 * Build a QES request body.
 *
 * @param {object} opts
 * @param {number} opts.modelId  from the transport of the SAME report
 * @param {Array<{Name,Entity}>} opts.from  e.g. [{ Name: "i", Entity: "ISA" }]
 * @param {Array<[string, object]>} opts.select  [alias, expression] pairs. The
 *   alias becomes the decoded row key. Every column here is a grouping key —
 *   dropping one merges rows that differed only in it.
 * @param {object[]} [opts.where]
 * @param {number} [opts.window]  defaults to MAX_WINDOW
 */
export function buildQuery({ modelId, from, select, where = [], window = MAX_WINDOW }) {
  if (modelId == null) throw new Error("modelId required");
  if (!Array.isArray(from) || !from.length) throw new Error("from required");
  if (!Array.isArray(select) || !select.length) throw new Error("select required");
  return {
    version: "1.0.0",
    queries: [{
      Query: {
        Commands: [{
          SemanticQueryDataShapeCommand: {
            Query: {
              Version: 2,
              From: from.map((f) => ({ Name: f.Name, Entity: f.Entity, Type: 0 })),
              Select: select.map(([name, expr]) => ({ ...expr, Name: name })),
              Where: where,
            },
            Binding: {
              Primary: { Groupings: [{ Projections: select.map((_, i) => i) }] },
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
 * Read completeness, warnings and a semantic error out of a QES response.
 * IC (IsComplete) false = the row window truncated the result.
 */
export function readResult(json) {
  const data = json?.results?.[0]?.result?.data ?? null;
  const ds = data?.dsr?.DS?.[0];
  const odataError = data?.dsr?.DataShapes?.[0]?.["odata.error"] || json?.error || null;
  const error = odataError
    ? String(odataError.message?.value || odataError.message || odataError.code || JSON.stringify(odataError))
    : null;
  return {
    data,
    // An empty result has no DS rows to truncate: absent IC means complete.
    complete: ds ? ds.IC !== false : true,
    warnings: (Array.isArray(ds?.Msg) ? ds.Msg : []).filter((w) => w?.Code !== "SpecifiedLimitExceedsMaxIntersections"),
    error,
  };
}

/**
 * Decode the response into flat rows keyed by the select aliases. Takes the
 * largest data block (a query built by buildQuery yields exactly one).
 */
export function decodeRows(json) {
  const grids = decodeDaxGrids(typeof json === "string" ? json : JSON.stringify(json)).grids || [];
  const big = grids.sort((a, b) => b.rows.length - a.rows.length)[0];
  return (big?.rows || []).map((r) => ({ ...r.dims, ...r.measures }));
}

/**
 * Choose transport from capture-ring descriptors, newest first. `entity`
 * pins it to a report: only a request that queried that entity carries the
 * right modelId.
 *
 * @param {Array<{url, auth, body, capturedAt}>} entries
 * @param {{entity?: string}} [opts]
 * @returns {{url, auth, modelId, capturedAt}|null}
 */
export function pickTransport(entries, { entity } = {}) {
  if (!Array.isArray(entries)) return null;
  const needle = entity ? `"Entity":"${entity}"` : null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e?.url || !e?.auth || !e?.body) continue;
    if (needle && !String(e.body).replace(/\s+/g, "").includes(needle.replace(/\s+/g, ""))) continue;
    let modelId = null;
    try { modelId = JSON.parse(e.body).modelId ?? null; } catch { continue; }
    if (modelId == null) continue;
    return { url: e.url, auth: e.auth, modelId, capturedAt: e.capturedAt ?? null };
  }
  return null;
}
