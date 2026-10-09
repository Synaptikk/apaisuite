// Pure parts of the report jobs. email_jobs.js imports SW-only modules, so the
// helpers are exercised through the bits that do not touch chrome.*.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRecipients, textToHtml } from "../../../../shared/outlook_send.js";
import { partsInZone } from "../scheduler.js";

globalThis.chrome = { storage: { local: {} }, runtime: {}, tabs: {}, scripting: {} };
const { previousDay, reportDayFor, dayLabel } = await import("../email_jobs.js").catch(() => ({}));

test("parseRecipients splits, trims, dedupes and drops junk", () => {
  assert.deepEqual(parseRecipients("a@x.com; b@y.com,a@x.com  nope"), ["a@x.com", "b@y.com"]);
  assert.deepEqual(parseRecipients(["1458leadership@walmart.onmicrosoft.com"]), ["1458leadership@walmart.onmicrosoft.com"]);
  assert.deepEqual(parseRecipients(""), []);
});

test("textToHtml keeps blank lines and escapes markup", () => {
  assert.equal(textToHtml("a<b>\n\nc"), "<div>a&lt;b&gt;</div><div><br></div><div>c</div>");
});

test("previousDay is the calendar day before, in the zone", { skip: !previousDay }, () => {
  const at = Date.UTC(2026, 9, 8, 15, 0);   // 10:00 Central
  assert.equal(previousDay(at, "America/Chicago"), "2026-10-07");
  assert.equal(partsInZone(at, "America/Chicago").yyyyMMdd, "2026-10-08");
  // Just after midnight still means yesterday.
  assert.equal(previousDay(Date.UTC(2026, 9, 8, 5, 5), "America/Chicago"), "2026-10-07");
});

test("reportDayFor reads the slot's reportDay, defaulting to previous", { skip: !reportDayFor }, () => {
  const m = { schedules: [{ time: "10:00", reportDay: "previous" }, { time: "16:45", reportDay: "current" }, { time: "12:00" }] };
  assert.equal(reportDayFor(m, "10:00"), "previous");
  assert.equal(reportDayFor(m, "16:45"), "current");
  assert.equal(reportDayFor(m, "12:00"), "previous");
  assert.equal(dayLabel("2026-10-07"), "Wed 10/7");
});
