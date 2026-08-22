// modules/vizpick/lib/tests/export_replay.test.mjs
//
// Run with: node --test modules/vizpick/lib/tests/export_replay.test.mjs
//
// Covers the pure half of the export replay — body construction, response
// parsing, and the one genuinely fiddly bit: learning sheetdocId by pairing an
// export REQUEST (which carries the GUID) with its RESPONSE (which names the
// file). Fixtures are the real captured bodies from 2026-08-21, so the
// multipart shape and Tableau's response envelope are pinned to what the
// server actually sent, not to what the docs imply.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildExportBody, parseExportResponse, learnSheetIds, normaliseSheetName,
} from "../sources/tableau_export_replay.js";

// Verbatim from the capture ring.
const REAL_REQ =
  '------apaisuiteq6k54g42fkj\r\nContent-Disposition: form-data; name="sheetdocId"\r\n\r\n' +
  '{95A7AC48-BC4F-432B-9590-5A424FF72939}\r\n' +
  '------apaisuiteq6k54g42fkj\r\nContent-Disposition: form-data; name="sendNotifications"\r\n\r\ntrue\r\n' +
  '------apaisuiteq6k54g42fkj\r\nContent-Disposition: form-data; name="telemetryCommandId"\r\n\r\nittnwlwl9v$apai\r\n' +
  '------apaisuiteq6k54g42fkj--\r\n';

const REAL_RESP = JSON.stringify({
  vqlCmdResponse: {
    layoutStatus: {
      applicationPresModel: {
        presentationLayerNotification: [{
          keyId: "doc:export-file-notification-event",
          presModelHolder: {
            genExportFilePresModel: {
              resultKey: "3227845031",
              fileName: "Download Department Breakout (Current Day).xlsx",
              mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            },
          },
        }],
      },
    },
  },
});

test("the body matches the multipart shape Tableau's own UI sends", () => {
  const body = buildExportBody("{ABC}", "----b", "tid");
  assert.match(body, /Content-Disposition: form-data; name="sheetdocId"\r\n\r\n\{ABC\}\r\n/);
  assert.match(body, /name="sendNotifications"\r\n\r\ntrue\r\n/);
  assert.match(body, /name="telemetryCommandId"\r\n\r\ntid\r\n/);
  assert.ok(body.endsWith("------b--\r\n"), "must be terminated with the closing boundary");
  // CRLF, not LF — a multipart body with bare newlines is not parsed.
  assert.ok(!/[^\r]\n/.test(body), "every line break must be CRLF");
});

test("resultKey and fileName come out of the real response envelope", () => {
  const r = parseExportResponse(REAL_RESP);
  assert.equal(r.ok, true);
  assert.equal(r.resultKey, "3227845031");
  assert.equal(r.fileName, "Download Department Breakout (Current Day).xlsx");
});

test("a rejected command is a failure even though Tableau answers HTTP 200", () => {
  // The dialog command returned exactly this shape when sent arguments it did
  // not accept. Keying off the status code would have read it as success.
  const rejected = '{"commandValidationPresModel":{"valid": false,"errorMessage": "Error in parameters"}}';
  const r = parseExportResponse(rejected);
  assert.equal(r.ok, false);
  assert.match(r.reason, /command rejected: Error in parameters/);
});

test("an empty or junk body fails cleanly", () => {
  for (const bad of ["", null, undefined, "not json", "{}"]) {
    assert.equal(parseExportResponse(bad).ok, false);
  }
});

test("learns sheetdocId by pairing the request GUID with the response filename", () => {
  const ring = [
    { url: "https://x/commands/tabsrv/export-crosstab-to-excel-server", reqBody: REAL_REQ, respBody: REAL_RESP },
  ];
  const map = learnSheetIds(ring);
  assert.deepEqual(map, {
    "download department breakout (current day)": "{95A7AC48-BC4F-432B-9590-5A424FF72939}",
  });
});

test("the learned key matches the sheet matcher the crawl uses", () => {
  // DEPT_SHEET.match in vizpick_today_tableau.js. If these ever diverge the
  // lookup silently misses and every store pays the DOM route.
  const map = learnSheetIds([
    { url: "/commands/tabsrv/export-crosstab-to-excel-server", reqBody: REAL_REQ, respBody: REAL_RESP },
  ]);
  assert.ok(map[normaliseSheetName("download department breakout (current day)")]);
});

test("learns from a body captured off Tableau's OWN export, not just ours", () => {
  // The regression that made the whole fast path dead code. Tableau's export
  // posts multipart FormData; content/tableau_capture.js recorded only string
  // and URLSearchParams bodies, so that request landed in the ring with
  // reqBody: null and nothing was ever learned from it. The only bodies that
  // DID get captured were the ones the replay itself sent — which it could
  // not send until it had learned a GUID. Closed loop, `sheetsLearned: 0`,
  // and every store paying the 12s DOM route with no error to show for it.
  //
  // This is the shape serializeBody() now emits for a FormData body. The two
  // must agree; this test is the only place they meet.
  const fromFormData =
    `------capture\r\nContent-Disposition: form-data; name="sheetdocId"\r\n\r\n` +
    `{95A7AC48-BC4F-432B-9590-5A424FF72939}\r\n` +
    `------capture\r\nContent-Disposition: form-data; name="sendNotifications"\r\n\r\ntrue\r\n` +
    `------capture\r\nContent-Disposition: form-data; name="telemetryCommandId"\r\n\r\nabc123\r\n`;

  const map = learnSheetIds([
    { url: "/commands/tabsrv/export-crosstab-to-excel-server", reqBody: fromFormData, respBody: REAL_RESP },
  ]);
  assert.equal(
    map[normaliseSheetName("download department breakout (current day)")],
    "{95A7AC48-BC4F-432B-9590-5A424FF72939}",
  );
});

test("a null body — an unserialisable request — is skipped, not half-learned", () => {
  // Blob/stream bodies still record null. Better no entry than an entry
  // mapping a real sheet name to undefined, which would look learned.
  const map = learnSheetIds([
    { url: "/commands/tabsrv/export-crosstab-to-excel-server", reqBody: null, respBody: REAL_RESP },
  ]);
  assert.deepEqual(map, {});
});

test("ignores ring entries that are not export commands", () => {
  const ring = [
    { url: "https://x/vizql/bootstrapSession", reqBody: REAL_REQ, respBody: REAL_RESP },
    { url: "https://x/commands/tabsrv/set-port-size", reqBody: REAL_REQ, respBody: REAL_RESP },
  ];
  assert.deepEqual(learnSheetIds(ring), {});
});

test("a request without a paired response teaches nothing", () => {
  // Half a pair is worse than none: a GUID with no filename cannot be keyed.
  const ring = [{ url: "/commands/tabsrv/export-crosstab-to-excel-server", reqBody: REAL_REQ, respBody: "" }];
  assert.deepEqual(learnSheetIds(ring), {});
});

test("learns several sheets from one ring", () => {
  const otherReq = REAL_REQ.replace("{95A7AC48-BC4F-432B-9590-5A424FF72939}", "{DE528639-7176-4925-BBC6-CD07ECC646F1}");
  const otherResp = REAL_RESP.replace("Download Department Breakout (Current Day).xlsx", "Download Location Details.xlsx");
  const map = learnSheetIds([
    { url: "/commands/tabsrv/export-crosstab-to-excel-server", reqBody: REAL_REQ, respBody: REAL_RESP },
    { url: "/commands/tabsrv/export-crosstab-to-excel-server", reqBody: otherReq, respBody: otherResp },
  ]);
  assert.equal(Object.keys(map).length, 2);
  assert.equal(map["download location details"], "{DE528639-7176-4925-BBC6-CD07ECC646F1}");
});

test("normaliseSheetName strips the extension and case", () => {
  assert.equal(normaliseSheetName("VizPick Donut Health.xlsx"), "vizpick donut health");
  assert.equal(normaliseSheetName(" Thing.csv "), "thing");
  assert.equal(normaliseSheetName(undefined), "");
});

test("tolerates a malformed ring", () => {
  for (const bad of [null, undefined, [], [null], [{}]]) {
    assert.deepEqual(learnSheetIds(bad), {});
  }
});

// ── Verified against a live replay, 2026-08-22 ───────────────────────────
//
// Both of these were found by diffing a real replayed export against the
// dialog route. Neither was visible in unit tests written from the captured
// traffic alone, which is why the live run mattered.

test("the file download lives under /tempfile/sessions/, not /sessions/", () => {
  // The plain session path answers HTTP 404 with an HTML error body — which
  // would have been handed to the parser as if it were a sheet.
  const base = "https://h/vizql/t/S/w/W/v/V/sessions/ABC-1:0";
  const fileUrl = base.replace(/\/sessions\//, "/tempfile/sessions/") + "?key=1&keepfile=yes&attachment=yes";
  assert.equal(fileUrl, "https://h/vizql/t/S/w/W/v/V/tempfile/sessions/ABC-1:0?key=1&keepfile=yes&attachment=yes");
  assert.ok(!/\/v\/V\/sessions\//.test(fileUrl), "the plain /sessions/ form 404s");
});

test("sheetdocId survives across sessions", () => {
  // A GUID captured on 2026-08-21 was replayed successfully in a completely
  // new session on 2026-08-22, returning the right sheet
  // ("Download Department Breakout (Current Day).xlsx"). That is what makes
  // learning it ONCE per market — rather than per store or per session —
  // correct. If this ever stops holding, the symptom is every store falling
  // back to the DOM route with `replayed: 0` in the crawl debug.
  assert.equal(normaliseSheetName("Download Department Breakout (Current Day).xlsx"),
               "download department breakout (current day)");
});

// ── Why an export produced nothing ────────────────────────────────────────
//
// "no CSV captured" was the whole failure message, and it cost a live debug
// session because it cannot distinguish four situations whose fixes have
// nothing in common: the driver never posted the command, the server rejected
// it, the file never arrived, or a file arrived that simply did not contain
// what we were matching on. The ring holds all four; these pin the readout.

import { summariseExportAttempt } from "../sources/tableau_export_replay.js";

const CMD = "/commands/tabsrv/export-crosstab-to-excel-server";
const blob = (body) => ({ via: "blob", url: "blob:x", status: 200, respBody: body });

test("no export command means the DRIVER failed, not the server", () => {
  // exportDriverFn found no toolbar / no sheet / the click did nothing. A
  // longer timeout would never have helped here.
  const s = summariseExportAttempt([{ url: "/vizql/bootstrapSession", status: 200 }], "Suggested Picks");
  assert.match(s, /never sent/);
});

test("an HTTP error on the command is reported with its status", () => {
  const s = summariseExportAttempt([{ url: CMD, status: 500, reqBody: "x", respBody: "" }], "Suggested Picks");
  assert.match(s, /500/);
});

test("command accepted but no file is the slow-store case", () => {
  // This is the one where raising EXPORT_WAIT_MS is the right response.
  const s = summariseExportAttempt([{ url: CMD, status: 200, reqBody: "x", respBody: "{}" }], "Suggested Picks");
  assert.match(s, /no file arrived/);
});

test("a file that arrived is identified by its HEADER ROW", () => {
  // The header distinguishes "wrong sheet exported", "column got renamed"
  // (which has broken this crawl before) and "store has no rows" — all of
  // which previously looked identical.
  const s = summariseExportAttempt(
    [{ url: CMD, status: 200, reqBody: "x", respBody: "{}" },
     blob("Dept\tSuggested Picks Seen\r\n1\t5\r\n")],
    "last_seen_timestamp",
  );
  assert.match(s, /Suggested Picks Seen/);
  assert.match(s, /last_seen_timestamp/);
  assert.doesNotMatch(s, /\t1\t5/, "must report the header, not the data rows");
});

test("a long header is truncated rather than dumped whole", () => {
  const wide = Array.from({ length: 60 }, (_, i) => `Column ${i}`).join("\t");
  const s = summariseExportAttempt(
    [{ url: CMD, status: 200, reqBody: "x" }, blob(`${wide}\r\nrow`)], "nope");
  assert.ok(s.length < 400, `summary too long: ${s.length}`);
  assert.match(s, /…/);
});

test("never throws, whatever it is handed", () => {
  // It only ever runs on an already-failed path. Throwing here would replace
  // a real failure reason with this function's own stack trace.
  for (const bad of [null, undefined, "not a ring", 42, [null], [{ url: null }]]) {
    assert.equal(typeof summariseExportAttempt(bad, "x"), "string");
  }
  assert.equal(typeof summariseExportAttempt([blob(null)], null), "string");
});
