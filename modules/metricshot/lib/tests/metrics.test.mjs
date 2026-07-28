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
