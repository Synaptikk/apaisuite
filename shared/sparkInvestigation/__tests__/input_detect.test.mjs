// shared/sparkInvestigation/__tests__/input_detect.test.mjs
//
// Run: node --test shared/sparkInvestigation/__tests__/
// These are pure functions — no chrome APIs or DOM needed.

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { detectQueryType } from "../input_detect.js";

describe("detectQueryType", () => {
  it("returns 'empty' for empty / whitespace input", () => {
    assert.equal(detectQueryType(""), "empty");
    assert.equal(detectQueryType("   "), "empty");
    assert.equal(detectQueryType("\t\n"), "empty");
    assert.equal(detectQueryType(null), "empty");
    assert.equal(detectQueryType(undefined), "empty");
  });

  it("returns 'orders' for single order ID", () => {
    assert.equal(detectQueryType("12345"), "orders");
    assert.equal(detectQueryType("  12345  "), "orders");
    assert.equal(detectQueryType("200014453289548"), "orders");
  });

  it("returns 'orders' for space- or comma-separated order IDs", () => {
    assert.equal(detectQueryType("12345 67890"), "orders");
    assert.equal(detectQueryType("12345, 67890"), "orders");
    assert.equal(detectQueryType("12345,67890,54321"), "orders");
    assert.equal(detectQueryType("12345\n67890"), "orders");
  });

  it("returns 'driver' for any non-numeric input", () => {
    assert.equal(detectQueryType("John Smith"), "driver");
    assert.equal(detectQueryType("Smith"), "driver");
    assert.equal(detectQueryType("DRIVER-123"), "driver");
    assert.equal(detectQueryType("Jane"), "driver");
  });

  it("returns 'driver' when digits are mixed with names", () => {
    // Even one non-digit token forces 'driver' — mixed input is a driver query.
    assert.equal(detectQueryType("12345 Smith"), "driver");
    assert.equal(detectQueryType("John 12345"), "driver");
  });
});
