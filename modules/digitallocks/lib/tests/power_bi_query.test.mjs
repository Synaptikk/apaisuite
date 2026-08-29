// modules/digitallocks/lib/tests/power_bi_query.test.mjs
//
// Pins the Power BI query builder (lib/powerBiQuery.js).
//
// Everything here failed in production at least once, in the shape of a pull
// that looked completely healthy and was missing 96% of the store's events:
//   · the Where clause must contain ONLY our store filter — the old code
//     replayed the report's captured query, inheriting the analyst's live
//     Lock Name / Zone Name slicers
//   · the row window must be the server maximum, not the grid visual's 500
//   · IsComplete must be read, because a truncated response is otherwise
//     byte-for-byte indistinguishable from a whole one
//   · the Select must keep all nine columns, because DSR groups by the
//     projection tuple and dropping one merges rows
//
// Live measurements behind these: dev/DIGITALLOCKS_PULL_FINDINGS.md.

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildStoreQuery, readQueryResult, pickTransport, dateWindows,
  SELECT_COLUMNS, MAX_WINDOW, LOOKBACK_DAYS, PAGE_DAYS,
} from "../powerBiQuery.js";

const cmdOf = (body) => body.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand;
const whereOf = (body) => cmdOf(body).Query.Where;

// ── The filter is ours alone ────────────────────────────────────────────────

test("the Where clause holds the store filter and nothing else", () => {
  const where = whereOf(buildStoreQuery({ store: "1458", modelId: 3120907 }));
  assert.equal(where.length, 1);
  assert.equal(where[0].Condition.In.Expressions[0].Column.Property, "store");
  assert.equal(where[0].Condition.In.Values[0][0].Literal.Value, "'1458'");
});

test("no zone or lock condition can survive into a built query", () => {
  // The regression this whole module exists to prevent: the report's own
  // query carried Zone Name = '46-COSMETICS & SKINCARE-TIER 1'.
  const json = JSON.stringify(buildStoreQuery({ store: "1458", modelId: 1 }));
  assert.ok(!json.includes("Zone Name") || !json.includes("COSMETICS"));
  for (const property of whereOf(buildStoreQuery({ store: "1458", modelId: 1 }))
    .map((w) => w.Condition?.In?.Expressions?.[0]?.Column?.Property)) {
    assert.equal(property, "store");
  }
});

test("two stores differ only in the literal", () => {
  const a = buildStoreQuery({ store: "1458", modelId: 7 });
  const b = buildStoreQuery({ store: "5260", modelId: 7 });
  assert.deepEqual(
    JSON.parse(JSON.stringify(a).replaceAll("'1458'", "'X'")),
    JSON.parse(JSON.stringify(b).replaceAll("'5260'", "'X'")),
  );
});

test("a store number containing a quote is refused, not interpolated", () => {
  assert.throws(() => buildStoreQuery({ store: "1458' OR '1'='1", modelId: 1 }), /quote/i);
});

test("store and modelId are both required", () => {
  assert.throws(() => buildStoreQuery({ modelId: 1 }), /store/);
  assert.throws(() => buildStoreQuery({ store: "1458" }), /modelId/);
});

// ── The row window ──────────────────────────────────────────────────────────

test("the row window defaults to the server maximum, not the visual's 500", () => {
  const cmd = cmdOf(buildStoreQuery({ store: "1458", modelId: 1 }));
  assert.equal(cmd.Binding.DataReduction.Primary.Window.Count, MAX_WINDOW);
  assert.equal(MAX_WINDOW, 30_000);
});

// ── The Select is load-bearing for row COUNT ────────────────────────────────

test("all nine columns are selected and projected", () => {
  const cmd = cmdOf(buildStoreQuery({ store: "1458", modelId: 1 }));
  assert.equal(SELECT_COLUMNS.length, 9);
  assert.equal(cmd.Query.Select.length, 9);
  // Projections must index every Select entry; a short list would drop columns
  // from the result and silently merge rows.
  assert.deepEqual(cmd.Binding.Primary.Groupings[0].Projections, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

test("the selected columns are the ones parseLockEvents can resolve", () => {
  // These exact strings come back as the decoded row keys. Renaming one here
  // without adding an alias in parseLockEvents.js breaks the import with
  // "missing required column".
  assert.deepEqual(SELECT_COLUMNS.map(([p]) => p), [
    "Lock Name", "store", "Unlock Source", "USER ID", "Zone Name",
    "datetime_local", "Position", "FIRST NAME", "LAST NAME",
  ]);
});

// ── Date bounding ───────────────────────────────────────────────────────────

test("a date window adds a string comparison, because datetime_local is text", () => {
  const where = whereOf(buildStoreQuery({ store: "1458", modelId: 1, from: "2026-08-01", to: "2026-08-08" }));
  assert.equal(where.length, 2);
  const { Left, Right } = where[1].Condition.And;
  // A datetime'...' literal is rejected by the server — these must stay plain
  // quoted strings, which sort correctly given the YYYY-MM-DD HH:MM:SS format.
  assert.equal(Left.Comparison.Right.Literal.Value, "'2026-08-01'");
  assert.equal(Right.Comparison.Right.Literal.Value, "'2026-08-08'");
  assert.equal(Left.Comparison.ComparisonKind, 2);   // >= from, inclusive
  assert.equal(Right.Comparison.ComparisonKind, 3);  // <  to,   exclusive
  assert.equal(Left.Comparison.Left.Column.Property, "datetime_local");
});

test("a half-specified range is ignored rather than half-applied", () => {
  assert.equal(whereOf(buildStoreQuery({ store: "1", modelId: 1, from: "2026-08-01" })).length, 1);
  assert.equal(whereOf(buildStoreQuery({ store: "1", modelId: 1, to: "2026-08-08" })).length, 1);
});

// ── IsComplete ──────────────────────────────────────────────────────────────

const responseWith = (ds) => ({ results: [{ result: { data: { dsr: { DS: [ds] } } } }] });

test("IC false is reported as incomplete", () => {
  // Measured live: window 1000 returned exactly 1000 rows with IC false.
  assert.equal(readQueryResult(responseWith({ IC: false })).complete, false);
});

test("IC true is reported as complete", () => {
  assert.equal(readQueryResult(responseWith({ IC: true })).complete, true);
});

test("an empty result set counts as complete, not unknown", () => {
  // A store with no events returns a well-formed response with no DM0 and no
  // IC. There is nothing to truncate, so treating it as incomplete would send
  // a bogus store number down the paging path forever.
  assert.equal(readQueryResult(responseWith({ N: "DS0" })).complete, true);
  assert.equal(readQueryResult({ results: [{ result: { data: {} } }] }).complete, true);
});

test("a response with no data block yields no data", () => {
  assert.equal(readQueryResult({ results: [] }).data, null);
  assert.equal(readQueryResult(undefined).data, null);
});

test("server warnings are surfaced", () => {
  const msg = [{ Code: "SpecifiedLimitExceedsMaxIntersections", Severity: "Warning" }];
  assert.deepEqual(readQueryResult(responseWith({ IC: true, Msg: msg })).warnings, msg);
  assert.deepEqual(readQueryResult(responseWith({ IC: true })).warnings, []);
});

// ── Transport selection ─────────────────────────────────────────────────────

const entry = (over = {}) => ({
  url: "https://x.pbidedicated.windows.net/webapi/.../query",
  auth: "MWCToken abc",
  body: JSON.stringify({ modelId: 3120907, queries: [] }),
  capturedAt: 1,
  ...over,
});

test("a slicer query is acceptable transport, not just the data grid's", () => {
  // The point of the rewrite: we need auth + modelId, not the grid's query.
  // A one-column slicer request carries both and arrives earlier in a render.
  const t = pickTransport([entry({ body: JSON.stringify({ modelId: 42, queries: ["Market"] }) })]);
  assert.equal(t.modelId, 42);
});

test("the newest usable capture wins, because the token is short-lived", () => {
  const t = pickTransport([
    entry({ auth: "MWCToken old", capturedAt: 1 }),
    entry({ auth: "MWCToken new", capturedAt: 2 }),
  ]);
  assert.equal(t.auth, "MWCToken new");
});

test("captures without auth, body or modelId are skipped, not returned empty", () => {
  const good = entry({ auth: "MWCToken good" });
  assert.equal(pickTransport([entry({ auth: null }), good]).auth, "MWCToken good");
  assert.equal(pickTransport([entry({ body: null }), good]).auth, "MWCToken good");
  assert.equal(pickTransport([entry({ body: "not json" }), good]).auth, "MWCToken good");
  assert.equal(pickTransport([entry({ body: "{}" }), good]).auth, "MWCToken good");
});

test("nothing usable yields null so the caller keeps waiting", () => {
  assert.equal(pickTransport([]), null);
  assert.equal(pickTransport([entry({ auth: null })]), null);
  assert.equal(pickTransport(undefined), null);
});

// ── Date paging ─────────────────────────────────────────────────────────────

test("windows are contiguous, non-overlapping and newest first", () => {
  const w = dateWindows(new Date(Date.UTC(2026, 7, 29)), 28, 7);
  assert.equal(w.length, 4);
  // Newest window's exclusive upper bound is TOMORROW, so today's events are in.
  assert.equal(w[0].to, "2026-08-30");
  assert.equal(w[0].from, "2026-08-23");
  for (let i = 1; i < w.length; i++) assert.equal(w[i].to, w[i - 1].from);
  assert.equal(w.at(-1).from, "2026-08-02");
});

test("the lookback is covered exactly, including a ragged last window", () => {
  const w = dateWindows(new Date(Date.UTC(2026, 7, 29)), 10, 7);
  assert.equal(w.length, 2);
  assert.equal(w[0].to, "2026-08-30");
  assert.equal(w[0].from, "2026-08-23");
  assert.equal(w[1].from, "2026-08-20");  // 3 remaining days, not a full 7
  assert.equal(w[1].to, "2026-08-23");
});

test("windows are whole days regardless of the time the pull runs", () => {
  const morning = dateWindows(new Date(Date.UTC(2026, 7, 29, 6, 12, 3)), 14, 7);
  const evening = dateWindows(new Date(Date.UTC(2026, 7, 29, 23, 59, 59)), 14, 7);
  assert.deepEqual(morning, evening);
});

test("the defaults cover the source's retention with margin", () => {
  // ~60 days observed live; the default lookback must not stop short of it.
  assert.ok(LOOKBACK_DAYS >= 60, `LOOKBACK_DAYS ${LOOKBACK_DAYS} is under the observed retention`);
  assert.equal(dateWindows(new Date(Date.UTC(2026, 7, 29))).length, Math.ceil(LOOKBACK_DAYS / PAGE_DAYS));
});

test("a non-positive page size is refused rather than looping forever", () => {
  assert.throws(() => dateWindows(new Date(), 70, 0), /positive/);
});
