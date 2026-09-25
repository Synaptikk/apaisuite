// modules/vizpick/lib/tests/case_report.test.mjs
//
// Run with: node --test modules/vizpick/lib/tests/case_report.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { caseAttachments, caseDocDefinition, textToBase64 } from "../case_report.js";
import { scanLedger } from "../home_history.js";

const entry = (iso, bins) => ({
  capturedAt: iso, sourceIso: iso, sourceKey: iso, store: "1458",
  bins: bins.map(([location, seen, done, win, lastSeenAt]) => ({ location, seen, done, win, lastSeenAt, seenToday: true })),
});
const ENTRIES = [
  entry("2026-09-15T15:03:00Z", [["040/005", 9, 9, "alyssa", "9/15/2026 10:28:00 AM"]]),
  entry("2026-09-15T22:03:00Z", [["040/005", 21, 9, "brendan", "9/15/2026 3:20:00 PM"]]),
];
const MODEL = {
  store: "1458", day: "2026-09-15", generatedAt: "Sep 16, 2026, 10:30 AM",
  verdict: "Digital associates' scans added 12 suggested picks to the store's pick total across 1 scan.",
  setAside: "",
  tallies: [{ value: "+12", label: "picks added on 1 digital scan" }],
  groupRows: [
    { group: "Digital", rescans: 1, rescansGained: 1, rescanRate: 100, rescanPicks: 12, firstScans: 0, firstScanPicks: 0 },
    { group: "Other jobs", rescans: 3, rescansGained: 3, rescanRate: 100, rescanPicks: 19, firstScans: 0, firstScanPicks: 0 },
  ],
  otherJobs: [{ group: "GM Coach", people: ["Brandon Phillips"], rescans: 3, rescansGained: 3, rescanRate: 100, rescanPicks: 19, firstScans: 0, firstScanPicks: 0 }],
  associates: [{ name: "Brendan Nicholson", job: "Digital Personal Shopper", scans: 1, bins: 1, picks: 12 }],
  digAdds: [{ update: "6:03 PM", location: "040/005", name: "Brendan Nicholson", job: "Digital Personal Shopper", scan: "3:20 PM", prevName: "Alyssa Kowalewski", prevJob: "Stocking 1 TA", dDue: 12, done: 9, due: 21 }],
  steps: ["Step one.", "Step two."],
  example: { location: "040/005", narrative: "At the 3:03 PM update…", rows: [{ update: "6:03 PM", scan: "3:20 PM", name: "Brendan Nicholson", job: "Digital Personal Shopper", done: 9, due: 21, change: "+12 due" }] },
  cannotShow: "What this can't show: …", limits: "Limits: …",
  summaryText: "VizPick, store 1458, 2026-09-15\n\nDigital associates' scans added 12 suggested picks — naïve café test",
  entries: ENTRIES,
  people: { alyssa: { name: "Alyssa Kowalewski", job: "Stocking 1 TA" }, brendan: { name: "Brendan Nicholson", job: "Digital Personal Shopper", shiftStart: "10:00", shiftEnd: "19:00" } },
};

test("attachments: every data file the numbers come from, named for the store and day", () => {
  const files = caseAttachments(MODEL);
  assert.deepEqual(files.map((f) => f.name), [
    "vizpick-1458-2026-09-15-summary.txt",
    "vizpick-1458-2026-09-15-digital-scans-that-added-picks.csv",
    "vizpick-1458-2026-09-15-scan-comparison-by-job.csv",
    "vizpick-1458-2026-09-15-bin-history.csv",
    "vizpick-1458-2026-09-15-tableau-updates-every-bin.csv",
    "vizpick-1458-2026-09-15-associates-and-jobs.csv",
    "vizpick-1458-2026-09-15-tableau-updates-raw.json",
  ]);
  assert.ok(files.every((f) => f.description && typeof f.text === "string" && f.type));
  const byName = (suffix) => files.find((f) => f.name.endsWith(suffix)).text.split("\r\n");

  const digital = byName("digital-scans-that-added-picks.csv");
  assert.equal(digital.length, 2);
  assert.equal(digital[1], "6:03 PM,040/005,Brendan Nicholson,Digital Personal Shopper,3:20 PM,Alyssa Kowalewski,Stocking 1 TA,12,9,21");

  const comparison = byName("scan-comparison-by-job.csv");
  assert.equal(comparison[1], "Digital,,,1,1,100,12,0,0");
  assert.equal(comparison[2], "Other jobs,,,3,3,100,19,0,0");
  assert.equal(comparison[3], "Other jobs,GM Coach,Brandon Phillips,3,3,100,19,0,0");

  const ledgerRows = scanLedger(ENTRIES).reduce((n, b) => n + b.rows.length, 0);
  assert.equal(byName("bin-history.csv").length, 1 + ledgerRows);
  assert.ok(byName("bin-history.csv").some((l) => l.startsWith("040/005,scan,") && l.includes("Brendan Nicholson")));
  assert.equal(byName("tableau-updates-every-bin.csv").length, 1 + 2, "one line per bin per update");

  const people = byName("associates-and-jobs.csv");
  assert.equal(people[1], "alyssa,Alyssa Kowalewski,Stocking 1 TA,,");
  assert.equal(people[2], "brendan,Brendan Nicholson,Digital Personal Shopper,10:00,19:00");

  const raw = JSON.parse(files.at(-1).text);
  assert.equal(raw.v, 1);
  assert.equal(raw.days["2026-09-15"].length, 2);
});

test("document: verdict, tables and the list of attached files, in the tab's words", () => {
  const files = caseAttachments(MODEL);
  const dd = caseDocDefinition(MODEL, files);
  const flat = JSON.stringify(dd.content);
  assert.ok(flat.includes(MODEL.verdict));
  assert.ok(flat.includes("Do picks go up when a bin is scanned, whoever scans it?"));
  assert.ok(flat.includes("New picks on rescans"));
  assert.ok(flat.includes("Brandon Phillips"), "other jobs are broken out with who held them");
  assert.ok(flat.includes("Every digital scan that added picks (1)"));
  assert.ok(flat.includes("Worked example, bin 040/005. "));
  const attachedTable = dd.content.find((c) => c.table && JSON.stringify(c.table.body[0]).includes("What it holds"));
  assert.equal(attachedTable.table.body.length, 1 + files.length);
  assert.equal(dd.info.title, "VizPick business case, store 1458, 2026-09-15");
  assert.equal(typeof dd.footer, "function");
  assert.equal(dd.footer(2, 3).columns[1].text, "Page 2 of 3");
  assert.equal(flat.includes("nobody rescanned"), false, "the baseline the analyst dropped stays out of the PDF");
});

test("textToBase64 round-trips UTF-8 text", () => {
  const text = "naïve café — 040/005 +12\r\n".repeat(5000);
  assert.equal(Buffer.from(textToBase64(text), "base64").toString("utf8"), text);
});
