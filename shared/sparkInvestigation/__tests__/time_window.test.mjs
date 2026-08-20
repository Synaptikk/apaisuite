// shared/sparkInvestigation/__tests__/time_window.test.mjs
//
// Run: node --test shared/sparkInvestigation/__tests__/

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { offsetStringFor, tzAbbrFor, makeStoreDate } from "../time_window.js";

describe("offsetStringFor", () => {
  it("returns well-formed offset string", () => {
    // Any zone at any moment should give ±HH:MM
    const s = offsetStringFor(new Date("2026-07-31T12:00:00Z"), "America/New_York");
    assert.match(s, /^[+-]\d{2}:\d{2}$/, `got ${s}`);
  });

  it("handles UTC zone", () => {
    const s = offsetStringFor(new Date("2026-07-31T12:00:00Z"), "UTC");
    assert.equal(s, "+00:00");
  });

  it("returns different offsets across DST boundary in America/New_York", () => {
    // January = EST (-05:00), July = EDT (-04:00)
    const winter = offsetStringFor(new Date("2026-01-15T12:00:00Z"), "America/New_York");
    const summer = offsetStringFor(new Date("2026-07-15T12:00:00Z"), "America/New_York");
    assert.equal(winter, "-05:00");
    assert.equal(summer, "-04:00");
  });
});

describe("tzAbbrFor", () => {
  it("returns known abbreviation for common zone", () => {
    // EDT (summer) or EST (winter) — both valid
    const s = tzAbbrFor(new Date("2026-07-15T12:00:00Z"), "America/New_York");
    assert.ok(/^(EDT|EST|GMT[+-]\d+)$/.test(s), `got ${s}`);
  });
});

describe("makeStoreDate", () => {
  it("interprets input as store-local, returns correct UTC moment", () => {
    // 2:30 PM in New York on 2026-07-15 (EDT, -04:00) === 18:30 UTC
    const d = makeStoreDate("2026-07-15", "14:30", "America/New_York");
    assert.equal(d.toISOString(), "2026-07-15T18:30:00.000Z");
  });

  it("handles winter DST correctly", () => {
    // 2:30 PM in New York on 2026-01-15 (EST, -05:00) === 19:30 UTC
    const d = makeStoreDate("2026-01-15", "14:30", "America/New_York");
    assert.equal(d.toISOString(), "2026-01-15T19:30:00.000Z");
  });

  it("handles UTC zone as identity", () => {
    const d = makeStoreDate("2026-07-15", "14:30", "UTC");
    assert.equal(d.toISOString(), "2026-07-15T14:30:00.000Z");
  });
});
