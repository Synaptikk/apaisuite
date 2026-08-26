// dev/encode-check.mjs
//
// Reproduce the ENCODE half of the assignments write outside the browser, so
// "save failed" can be split in two without needing the extension attached.
//
//   node dev/encode-check.mjs <path-to-a-build-with-a-real-key>
//
// saveAssignments() only reports failure when the handler THREW. Three things
// on that path can throw: crypto (placeholder master key), the plaintext-name
// guard, and the Firestore request. This covers the first two. If both pass,
// the failure is the HTTP call and the status code is the next thing to get.
//
// Point it at a build whose key was injected (dev/dev-build.sh output, or the
// staged release) — the working tree carries the placeholder on purpose.

import { pathToFileURL } from "node:url";
import { join } from "node:path";

const base = process.argv[2];
if (!base) {
  console.error("usage: node dev/encode-check.mjs <build-dir>");
  process.exit(1);
}

const load = (rel) => import(pathToFileURL(join(base, rel)).href);

const codec = await load("modules/digitalmetrics/lib/codec.js");

// Shaped like what view.js actually hands over: an ARRAY of associates,
// carrying the extra fields the grid keeps on the row (shiftLabel, name) that
// the allowlist is supposed to strip.
const doc = {
  associates: [
    { name: "ISAIAH WEAVER", slots: { 0: "PICK", 3: "L" }, status: null,
      shiftStart: 0, shiftEnd: 8, shiftLabel: "5:00-1:00" },
    { name: "TEST TWO", slots: {}, status: "absent",
      shiftStart: 2, shiftEnd: 10, shiftLabel: "7:00-3:00" },
  ],
  date: "2026-08-27",
  day: "Thursday",
  updatedAt: new Date().toISOString(),
  store: "1458",
  finalized: false,
  finalizedAt: null,
};

try {
  const enc = await codec.encodeAssignments(doc);
  console.log("  encode                 : OK");
  console.log("  top-level fields       :", Object.keys(enc).join(", "));
  console.log("  roster entry fields    :", Object.keys(enc.associates[0]).join(", "));
  console.log("  plaintext name kept?   :",
    "name" in enc.associates[0] ? "YES - this alone would trip the guard" : "no");
  console.log("  token length           :", String(enc.associates[0].t ?? "").length);

  try {
    codec.assertNoPlaintextNames(enc);
    console.log("  assertNoPlaintextNames : PASSED");
  } catch (e) {
    console.log("  assertNoPlaintextNames : THREW ->", e.message);
  }
} catch (e) {
  console.log("  encode THREW ->", e.message);
  if (/placeholder|MASTER_SECRET/.test(e.message)) {
    console.log("  (that is the missing-key case: this build was not key-injected)");
  }
}
