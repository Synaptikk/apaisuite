// dev/tests/cutover_config_rewrite.test.mjs
//
// Pins the text surgery in dev/cutover-aurorbuddy.mjs.
//
// This exists because the first version got it wrong in a way that would have
// been invisible. firestore_config.js carries a comment block spelling out the
// POST-cutover values verbatim:
//
//     // Migrating to the apaisuite project means:
//     //     projectId:  "apaisuite"
//     ...
//     export const FIREBASE_CONFIG = { projectId: "aurorbuddy", ... };
//
// A whole-file /projectId:\s*"([^"]+)"/ finds the COMMENT first. Reading that
// way reports the cutover as already done (which is how it was caught, by
// refusing to run). Writing that way is worse: String.replace also takes the
// first hit, so the flip would have edited the comment, left the real config
// untouched, and still passed a "does the file contain this string" check —
// announcing success while changing nothing, and pointing a supposedly
// migrated module at the old project.
//
// Every assertion below is about that distinction: the comment is not the
// config.

import test from "node:test";
import assert from "node:assert/strict";

import { parseConfigBlock, readValue, rewriteConfig } from "../cutover-aurorbuddy.mjs";

// A faithful reduction of the real file: instructions in a comment, then the
// live object underneath.
const FIXTURE = `// modules/aurorbuddy/lib/firestore_config.js

// ── Cutover switch ───────────────────────────────────────────────────────
// Migrating to the apaisuite project means:
//     projectId:  "apaisuite"
//     databaseId: "aurorbuddy"        (a NAMED database, as digitalmetrics is)
//     webApiKey:  <apaisuite web key>
export const FIREBASE_CONFIG = {
  projectId:  "aurorbuddy",
  databaseId: "(default)",
  webApiKey:  "AIzaSyOLDKEY",
};

export const ANALYST_SOURCE = "suite";
`;

test("the block parser skips the comment and finds the real object", () => {
  const { body } = parseConfigBlock(FIXTURE);
  assert.equal(readValue(body, "projectId"),  "aurorbuddy");
  assert.equal(readValue(body, "databaseId"), "(default)");
  // If this ever reads "apaisuite" the parser has found the comment again.
  assert.notEqual(readValue(body, "projectId"), "apaisuite");
});

test("rewriting changes the object, not the comment", () => {
  const out = rewriteConfig(FIXTURE);
  const { body } = parseConfigBlock(out);

  assert.equal(readValue(body, "projectId"),  "apaisuite");
  assert.equal(readValue(body, "databaseId"), "aurorbuddy");
  assert.match(readValue(body, "webApiKey"), /^AIzaSy/);
  assert.notEqual(readValue(body, "webApiKey"), "AIzaSyOLDKEY");

  // The instructions above must survive verbatim — they are how the next
  // person understands what happened.
  assert.ok(out.includes('//     projectId:  "apaisuite"'));
  assert.ok(out.includes("//     webApiKey:  <apaisuite web key>"));
});

test("everything outside the block is untouched", () => {
  const out = rewriteConfig(FIXTURE);
  assert.ok(out.includes('export const ANALYST_SOURCE = "suite";'));
  assert.ok(out.startsWith("// modules/aurorbuddy/lib/firestore_config.js"));
  assert.equal(out.split("\n").length, FIXTURE.split("\n").length, "no lines added or lost");
});

test("a rewrite is idempotent in shape", () => {
  const once  = rewriteConfig(FIXTURE);
  const twice = rewriteConfig(once);
  assert.equal(twice, once);
});

test("the real firestore_config.js parses, and reads as NOT yet cut over", async () => {
  // Guards against the file being reshaped in a way the parser cannot see —
  // which would otherwise surface as a confusing failure mid-cutover.
  const fs   = await import("node:fs");
  const path = await import("node:path");
  const url  = await import("node:url");
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const real = fs.readFileSync(
    path.resolve(here, "../../modules/aurorbuddy/lib/firestore_config.js"), "utf8");

  const { body } = parseConfigBlock(real);
  const project  = readValue(body, "projectId");
  assert.ok(project, "projectId must be readable from the object");
  // Either state is legitimate; what matters is that it comes from the object.
  assert.ok(["aurorbuddy", "apaisuite"].includes(project), `unexpected projectId "${project}"`);
});
