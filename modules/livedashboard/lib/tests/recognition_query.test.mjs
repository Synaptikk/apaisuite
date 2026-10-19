// modules/livedashboard/lib/tests/recognition_query.test.mjs
// node --test modules/livedashboard/lib/tests/recognition_query.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

globalThis.chrome = globalThis.chrome || {};
const { buildObservationQuery, expandObservations, padStore, rollup7d } = await import("../sources/recognition.js");

const cmdOf = (body) => body.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand;

test("query filters only on store, type and date floor", () => {
  const body = buildObservationQuery({ modelId: 3360717, store: "01458", type: "Engagement", since: "2026-09-01" });
  const q = cmdOf(body).Query;
  const where = JSON.stringify(q.Where);
  assert.equal(body.modelId, 3360717);
  assert.equal(q.Where.length, 3);
  assert.match(where, /"Property":"fascility_nbr_padded".*"Value":"'01458'"/);
  assert.match(where, /"Value":"'Engagement'"/);
  assert.match(where, /datetime'2026-09-01T00:00:00'/);
  // The report's saved slicers must not appear.
  assert.doesNotMatch(where, /tier_status|IsValidDate/);
});

test("query asks for the max window and counts a never-empty column", () => {
  const cmd = cmdOf(buildObservationQuery({ modelId: 1, store: "01215", type: "Recognition", since: "2026-09-01" }));
  assert.equal(cmd.Binding.DataReduction.Primary.Window.Count, 30000);
  const count = cmd.Query.Select.find((s) => s.Name === "Count");
  assert.equal(count.Aggregation.Function, 5);
  assert.equal(count.Aggregation.Expression.Column.Property, "Is_this_safety_observation_engagement_or_recognition");
  assert.deepEqual(cmd.Query.From.map((f) => f.Entity), ["Stores Master", "Calendar", "High Accidents Survey"]);
});

test("merged groups expand back to one row per observation", () => {
  const day = Date.parse("2026-09-12T00:00:00Z");
  const rows = expandObservations([
    { Store: "01458", Date: day, Description: null, Count: 4 },
    { Store: "01458", Date: day, Description: "Picked up cardboard", Count: 1 },
    { Store: "01458", Date: null, Description: "no date", Count: 2 },
  ]);
  assert.equal(rows.length, 5);
  assert.equal(rows.filter((r) => r.description === "").length, 4);
  assert.equal(rows[0].dateIso, "2026-09-12");
  assert.equal(rollup7d(rows, "2026-09-15").find((d) => d.dateIso === "2026-09-12").count, 5);
});

test("store numbers are padded to five digits", () => {
  assert.equal(padStore(1458), "01458");
  assert.equal(padStore("#1215"), "01215");
});

// Real Ids from 2026-10-17: first Id per UTC date, and the suite's own
// submissions with their PC times (CDT, UTC-5).
test("localDayOf puts a UTC-dated evening response back on its local day", async () => {
  const { localDayOf } = await import("../sources/recognition.js");
  const starts = { "2026-10-15": 4901646, "2026-10-16": 4924140, "2026-10-17": 4952641 };
  const cdt = 5;
  assert.equal(localDayOf("2026-10-15", 4922689, starts, cdt), "2026-10-15");   // 6:42 PM 10/15
  assert.equal(localDayOf("2026-10-16", 4924730, starts, cdt), "2026-10-15");   // 8:33 PM 10/15, dated 10/16
  assert.equal(localDayOf("2026-10-16", 4934549, starts, cdt), "2026-10-16");   // 11:03 AM 10/16
  assert.equal(localDayOf("2026-10-17", 4957158, starts, cdt), "2026-10-17");   // today, sized from 10/16
  assert.equal(localDayOf("2026-10-16", 4924730, starts, 0), "2026-10-16");
  assert.equal(localDayOf("2026-10-16", 0, starts, cdt), "2026-10-16");          // no Id: UTC date kept
});
