// modules/metricshot/lib/tests/metrics.test.mjs
//
// Pure-function tests for the metric config CRUD + validation.
// Run with: node --test modules/metricshot/lib/tests/metrics.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeMetric,
  validateMetric,
  slugifyName,
  uniqueId,
  readyForSave,
  shortScheduleSummary,
  metricNeedsStore,
  migrationMatches,
  applyCaptureMigration,
  DEFAULT_CAPTURE,
} from "../metrics.js";

test("slugifyName: lowercases, replaces punctuation", () => {
  assert.equal(slugifyName("VizPick Score"), "vizpick-score");
  assert.equal(slugifyName("  Store 1458 — CVP  "), "store-1458-cvp");
  // Empty input falls back to "metric-<timestamp>" — assert shape, not exact value.
  assert.match(slugifyName(""), /^metric-[a-z0-9]+$/);
});

test("uniqueId: appends -2, -3 if base is taken", () => {
  assert.equal(uniqueId("foo", [{ id: "bar" }]), "foo");
  assert.equal(uniqueId("foo", [{ id: "foo" }]), "foo-2");
  assert.equal(uniqueId("foo", [{ id: "foo" }, { id: "foo-2" }]), "foo-3");
});

test("normalizeMetric: fills defaults", () => {
  const n = normalizeMetric({
    name: "x",
    url: "https://x/",
    schedules: [{ days: ["mon", "tue"], time: "10:00" }],
    destination: { channelName: "Foo" },
  });
  assert.equal(n.timezone, "local");
  assert.equal(n.enabled, true);
  assert.deepEqual(n.capture, { ...DEFAULT_CAPTURE });
  assert.deepEqual(n.schedules[0].days, ["MON", "TUE"]);
  assert.equal(n.destination.type, "workvivo-sendbird");
});

test("validateMetric: requires name, url, schedules, destination.channelName", () => {
  const v = validateMetric({});
  assert.equal(v.ok, false);
  const joined = v.errors.join(" | ");
  for (const w of ["name is required", "url is required", "at least one schedule", "destination.channelName is required"]) {
    assert.ok(joined.includes(w), `missing "${w}" in errors: ${joined}`);
  }
});

test("validateMetric: rejects invalid url + time format", () => {
  const v = validateMetric({
    name: "n",
    url: "http://not-https",
    schedules: [{ days: ["MON"], time: "25:00" }],
    destination: { channelName: "c" },
  });
  assert.equal(v.ok, false);
  const j = v.errors.join(" | ");
  assert.ok(j.includes("url must be https"));
  assert.ok(j.includes("time must be HH:MM"));
});

test("validateMetric: rejects duplicate id", () => {
  const existing = [{ id: "foo" }];
  const v = validateMetric({
    id: "foo",
    name: "n",
    url: "https://x/",
    schedules: [{ days: ["MON"], time: "10:00" }],
    destination: { channelName: "c" },
  }, { existing });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /already used/.test(e)));
});

test("validateMetric: accepts a well-formed metric", () => {
  const v = validateMetric({
    name: "VizPick",
    url: "https://stores.tableau.wal-mart.com/#/site/OnlineGrocery/views/VizPick/VizPickDetails",
    schedules: [{ days: ["MON","TUE","WED","THU","FRI","SAT","SUN"], time: "10:00" }],
    destination: { channelName: "1458 Leadership" },
  });
  assert.equal(v.ok, true, `errors: ${JSON.stringify(v.errors)}`);
});

test("readyForSave: assigns id derived from name if missing", () => {
  const n = readyForSave({
    name: "VizPick Score",
    url: "https://x/",
    schedules: [{ days: ["MON"], time: "10:00" }],
    destination: { channelName: "c" },
  }, []);
  assert.equal(n.id, "vizpick-score");
});

test("shortScheduleSummary: recognizes Daily and Weekdays", () => {
  const daily = {
    schedules: [
      { days: ["MON","TUE","WED","THU","FRI","SAT","SUN"], time: "10:00" },
      { days: ["MON","TUE","WED","THU","FRI","SAT","SUN"], time: "14:00" },
    ],
  };
  const wk = { schedules: [{ days: ["MON","TUE","WED","THU","FRI"], time: "09:00" }] };
  assert.equal(shortScheduleSummary(daily), "Daily 10:00 / 14:00");
  assert.equal(shortScheduleSummary(wk),    "Weekdays 09:00");
});

test("metricNeedsStore: true when a parameter value has a {{TOKEN}}", () => {
  assert.equal(
    metricNeedsStore({ capture: { parameterValues: { Store: "{{HOME_STORE}}" } } }),
    true,
  );
  // Multiple params — needs a store if ANY is templated.
  assert.equal(
    metricNeedsStore({ capture: { parameterValues: { Region: "West", Store: "{{HOME_STORE}}" } } }),
    true,
  );
});

test("metricNeedsStore: false for static or absent parameter values", () => {
  assert.equal(metricNeedsStore({ capture: { parameterValues: { Store: "1458" } } }), false);
  assert.equal(metricNeedsStore({ capture: { parameterValues: {} } }), false);
  assert.equal(metricNeedsStore({ capture: {} }), false);
  assert.equal(metricNeedsStore({}), false);
  assert.equal(metricNeedsStore(null), false);
  assert.equal(metricNeedsStore(undefined), false);
});

test("metricNeedsStore: ignores non-string parameter values", () => {
  assert.equal(metricNeedsStore({ capture: { parameterValues: { N: 42, B: true } } }), false);
});

test("normalizeMetric: keeps NEGATIVE padding (crop-inward from the crop tool)", () => {
  const n = normalizeMetric({
    name: "x",
    url: "https://x/",
    schedules: [{ days: ["MON"], time: "10:00" }],
    destination: { channelName: "c" },
    capture: { padding: { top: -3, right: -10, bottom: -5, left: -15 } },
  });
  // Must NOT be clamped to 0 — negatives crop inward.
  assert.deepEqual(n.capture.padding, { top: -3, right: -10, bottom: -5, left: -15 });
});

test("normalizeMetric: coerces non-finite padding sides to 0", () => {
  const n = normalizeMetric({
    name: "x",
    url: "https://x/",
    schedules: [{ days: ["MON"], time: "10:00" }],
    destination: { channelName: "c" },
    capture: { padding: { top: "nope", right: 12, bottom: undefined, left: null } },
  });
  assert.deepEqual(n.capture.padding, { top: 0, right: 12, bottom: 0, left: 0 });
});

test("migrationMatches: ALL specified keys must match (AND, not OR)", () => {
  const existing = {
    url: "https://old/",
    capture: { requiredSelector: "iframe", mode: "region" },
  };
  // Both keys match → true.
  assert.equal(migrationMatches({ fromUrl: "https://old/", fromRequiredSelector: "iframe" }, existing), true);
  // One key wrong → false (OR would have wrongly returned true).
  assert.equal(migrationMatches({ fromUrl: "https://old/", fromRequiredSelector: "canvas" }, existing), false);
});

test("migrationMatches: REGRESSION — current URL alone must not re-fire", () => {
  // The v0.1.2 entry lists the current seed URL as fromUrl but ALSO requires
  // capture mode 'viewport'. A metric already migrated to region mode must
  // NOT match, or the migration nukes the user's saved crop on every restart.
  const currentUrl = "https://stores.tableau.wal-mart.com/t/OnlineGrocery/views/VizPick/VizPickDetails?:embed=y&:toolbar=n";
  const migrated = { url: currentUrl, capture: { mode: "region", containText: ["x"] } };
  assert.equal(migrationMatches({ fromCaptureMode: "viewport", fromUrl: currentUrl }, migrated), false);
  // But a still-broken viewport-mode metric on that URL SHOULD match.
  const broken = { url: currentUrl, capture: { mode: "viewport" } };
  assert.equal(migrationMatches({ fromCaptureMode: "viewport", fromUrl: currentUrl }, broken), true);
});

test("migrationMatches: empty/degenerate inputs never match", () => {
  assert.equal(migrationMatches({}, { url: "x" }), false);
  assert.equal(migrationMatches(null, { url: "x" }), false);
  assert.equal(migrationMatches({ fromUrl: "x" }, null), false);
});

test("applyCaptureMigration: REGRESSION — user-customized padding survives a migration that bumps other fields", () => {
  // The fromZoom:1 migration used to do `existing.capture = {...seed.capture}`,
  // which silently wiped a hand-tuned crop the instant it fired. A stored
  // padding that does NOT match the migration's oldDefaultPadding fingerprint
  // means the user tuned it via the crop tool — it must survive.
  const migration = { fromZoom: 1, oldDefaultPadding: { top: 8, right: 16, bottom: 40, left: 8 } };
  const seedCapture = { ...DEFAULT_CAPTURE, zoom: 0.85, padding: { top: 12, right: 24, bottom: 48, left: 12 } };
  const existingCapture = { ...DEFAULT_CAPTURE, zoom: 1, padding: { top: -5, right: 30, bottom: 10, left: -2 } };
  const next = applyCaptureMigration(existingCapture, migration, seedCapture);
  assert.deepEqual(next.padding, existingCapture.padding, "user's tuned padding must not be overwritten");
  assert.equal(next.zoom, 0.85, "non-padding seed fields still apply");
});

test("applyCaptureMigration: untouched (still-default) padding IS replaced with the new seed default", () => {
  const migration = { fromZoom: 1, oldDefaultPadding: { top: 8, right: 16, bottom: 40, left: 8 } };
  const seedCapture = { ...DEFAULT_CAPTURE, zoom: 0.85, padding: { top: 12, right: 24, bottom: 48, left: 12 } };
  const existingCapture = { ...DEFAULT_CAPTURE, zoom: 1, padding: { top: 8, right: 16, bottom: 40, left: 8 } };
  const next = applyCaptureMigration(existingCapture, migration, seedCapture);
  assert.deepEqual(next.padding, seedCapture.padding);
});

test("applyCaptureMigration: migration without oldDefaultPadding keeps full-replace behavior", () => {
  const migration = { fromCaptureMode: "viewport" };
  const seedCapture = { ...DEFAULT_CAPTURE, mode: "region", padding: { top: 1, right: 2, bottom: 3, left: 4 } };
  const existingCapture = { ...DEFAULT_CAPTURE, mode: "viewport", padding: { top: 99, right: 99, bottom: 99, left: 99 } };
  const next = applyCaptureMigration(existingCapture, migration, seedCapture);
  assert.deepEqual(next, seedCapture);
});
