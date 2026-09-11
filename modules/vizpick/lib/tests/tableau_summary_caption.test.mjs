import test from "node:test";
import assert from "node:assert/strict";
import { normaliseSummaryCaption } from "../sources/tableau_export_replay.js";

test("direct Tableau summary captions match crosstab captions", () => {
  assert.equal(normaliseSummaryCaption("AGG(New Location %)"), "New Location %");
  assert.equal(normaliseSummaryCaption("AGG(New Overstock %)"), "New Overstock %");
  assert.equal(normaliseSummaryCaption("AGG(New VizPick )"), "New VizPick");
  assert.equal(normaliseSummaryCaption("MAX(last_seen_timestamp)"), "last_seen_timestamp");
  assert.equal(normaliseSummaryCaption("Dept"), "Dept");
});
