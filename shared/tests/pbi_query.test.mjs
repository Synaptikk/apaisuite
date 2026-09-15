// shared/tests/pbi_query.test.mjs — node shared/tests/pbi_query.test.mjs
import {
  AGG, MAX_WINDOW, aggregate, buildQuery, column, decodeRows, hierarchyLevel,
  measure, pickTransport, readResult, whereDateRange, whereIn,
} from "../pbi_query.js";

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail !== undefined ? " — " + JSON.stringify(detail) : ""}`); }
}
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

console.log("buildQuery");
const body = buildQuery({
  modelId: 2196956,
  from: [{ Name: "i", Entity: "ISA" }, { Name: "a", Entity: "Alignment" }],
  select: [["Store", column("a", "Store")], ["Dollars", measure("i", "Adj $")], ["Qty", aggregate("i", "Adj Qty")]],
  where: [whereIn(column("a", "Market"), ["120"])],
});
const cmd = body.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand;
check("modelId carried", body.modelId === 2196956);
check("aliases become Select names", cmd.Query.Select.map((s) => s.Name).join() === "Store,Dollars,Qty");
check("every column projected", cmd.Binding.Primary.Groupings[0].Projections.join() === "0,1,2");
check("window defaults to max", cmd.Binding.DataReduction.Primary.Window.Count === MAX_WINDOW);
check("From normalised with Type 0", cmd.Query.From.every((f) => f.Type === 0));
check("aggregate defaults to SUM", cmd.Query.Select[2].Aggregation.Function === AGG.SUM);
check("requires modelId", throws(() => buildQuery({ from: [{ Name: "i", Entity: "ISA" }], select: [["x", column("i", "x")]] })));
check("requires select", throws(() => buildQuery({ modelId: 1, from: [{ Name: "i", Entity: "ISA" }], select: [] })));

console.log("expressions + filters");
const hl = hierarchyLevel("a", "BU Hierarchy", "Store");
check("hierarchy level shape", hl.HierarchyLevel.Level === "Store" && hl.HierarchyLevel.Expression.Hierarchy.Hierarchy === "BU Hierarchy");
const w = whereIn(column("a", "Store"), ["1458", "1215"]);
check("whereIn quotes text literals", JSON.stringify(w.Condition.In.Values) === JSON.stringify([[{ Literal: { Value: "'1458'" } }], [{ Literal: { Value: "'1215'" } }]]));
check("whereIn rejects quotes", throws(() => whereIn(column("a", "Store"), ["14'58"])));
check("whereIn rejects empty", throws(() => whereIn(column("a", "Store"), [])));
const dr = whereDateRange(column("i", "Adj Date"), "2026-08-22", "2026-09-06");
check("date range is And(>=, <)", dr.Condition.And.Left.Comparison.ComparisonKind === 2 && dr.Condition.And.Right.Comparison.ComparisonKind === 3);
check("datetime literal", dr.Condition.And.Left.Comparison.Right.Literal.Value === "datetime'2026-08-22T00:00:00'");
check("open-ended from", whereDateRange(column("b", "Date"), "2026-02-01").Condition.Comparison.ComparisonKind === 2);
check("bad date rejected", throws(() => whereDateRange(column("b", "Date"), "8/22/2026")));

console.log("readResult");
check("IC false → incomplete", readResult({ results: [{ result: { data: { dsr: { DS: [{ IC: false }] } } } }] }).complete === false);
check("missing DS → complete", readResult({ results: [{ result: { data: { dsr: {} } } }] }).complete === true);
const errJson = { results: [{ result: { data: { dsr: { DataShapes: [{ "odata.error": { code: "CouldNotResolveSemanticQueryDefinition", message: { value: "invalid Column reference 'Bus_Date'" } } }] } } } }] };
check("semantic error surfaced", /Bus_Date/.test(readResult(errJson).error || ""), readResult(errJson).error);
const warnJson = { results: [{ result: { data: { dsr: { DS: [{ Msg: [{ Code: "SpecifiedLimitExceedsMaxIntersections" }, { Code: "Other" }] }] } } } }] };
check("clamp warning filtered, others kept", readResult(warnJson).warnings.map((x) => x.Code).join() === "Other");

console.log("decodeRows");
const dsr = {
  results: [{ result: { data: {
    descriptor: { Select: [{ Kind: 1, Value: "G0", Name: "Store" }, { Kind: 2, Value: "M0", Name: "Dollars" }] },
    dsr: { DS: [{
      PH: [{ DM0: [
        { S: [{ N: "G0", T: 1, DN: "D0" }, { N: "M0", T: 3 }], C: [0, "-5"] },
        { C: [1, "-7"] },
        { C: ["-9"], R: 1 },
      ] }],
      ValueDicts: { D0: ["1458", "1215"] },
    }] },
  } } }],
};
const rows = decodeRows(dsr);
check("row count", rows.length === 3, rows);
check("dict + alias keys", rows[0].Store === "1458" && rows[1].Store === "1215", rows);
check("repeat bitmask carries store", rows[2].Store === "1215" && rows[2].Dollars === -9, rows[2]);

console.log("pickTransport");
const entries = [
  { url: "u1", auth: "MWCToken a", body: JSON.stringify({ modelId: 2192898, q: '"Entity":"BR Adjustments"' }), capturedAt: 1 },
  { url: "u2", auth: "MWCToken b", body: JSON.stringify({ modelId: 2196956, q: '"Entity":"ISA"' }), capturedAt: 2 },
  { url: "u3", auth: null, body: JSON.stringify({ modelId: 9 }), capturedAt: 3 },
];
// The entity needle is matched against the raw body, so embed it unescaped.
entries[0].body = `{"modelId":2192898,"queries":[{"From":[{"Entity":"BR Adjustments"}]}]}`;
entries[1].body = `{"modelId":2196956,"queries":[{"From":[{"Entity":"ISA"}]}]}`;
check("newest with auth wins", pickTransport(entries)?.modelId === 2196956);
check("entity pins the report", pickTransport(entries, { entity: "BR Adjustments" })?.modelId === 2192898);
check("no match → null", pickTransport(entries, { entity: "Nope" }) === null);

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed) process.exitCode = 1;
