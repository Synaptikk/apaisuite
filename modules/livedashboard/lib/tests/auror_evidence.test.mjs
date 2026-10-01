// modules/livedashboard/lib/tests/auror_evidence.test.mjs
// node --test modules/livedashboard/lib/tests/auror_evidence.test.mjs
//
// Guards the part of the exceptions report that makes a claim about the store's
// casework: which of the three required angles is absent. The rule the tests
// exist to hold is that the report never names an angle it cannot evidence.
import test from "node:test";
import assert from "node:assert/strict";

globalThis.chrome = globalThis.chrome || {};
const { classifyEvidence, missingFor, explainVideoGap } = await import("../sources/auror.js");
const { aurorExceptionsEmail } = await import("../auror_email.js");

const vid = (fileName) => ({ fileName, fileType: "Video", mimeType: "video/mp4" });
const img = (fileName) => ({ fileName, fileType: "Image", mimeType: "image/jpeg" });

test("counting contract is unchanged for existing callers", () => {
  const c = classifyEvidence([
    vid("a.mp4"), img("b.jpg"),
    { fileName: "x.pdf", fileType: "Pdf", evidenceType: "NarrativeStatement" },
  ]);
  assert.equal(c.videoCount, 1);
  assert.equal(c.photoCount, 1);
  assert.equal(c.statementCount, 1);
  assert.deepEqual(missingFor(c), ["video"]);
});

test("named clips are attributed to their angle", () => {
  const c = classifyEvidence([vid("SCO 12 theft.mp4"), vid("front door exit.mp4")]);
  assert.deepEqual(c.angles, { theft: 1, door: 1, office: 0 });
  assert.equal(c.videoUnattributed, 0);
  const g = explainVideoGap(c);
  assert.ok(g.certain);
  assert.deepEqual(g.lack, ["the office"]);
  assert.match(g.text, /Missing the office/);
});

test("a clip naming two angles proves neither", () => {
  const c = classifyEvidence([vid("front door register.mp4")]);
  assert.deepEqual(c.angles, { theft: 0, door: 0, office: 0 });
  assert.equal(c.videoUnattributed, 1);
  assert.equal(explainVideoGap(c).certain, false);
});

test("opaque camera-ID names never produce a named missing angle", () => {
  const c = classifyEvidence([vid("ACC_BAY_02_20260926.mp4"), vid("ACC_BAY_07_20260926.mp4")]);
  const g = explainVideoGap(c);
  assert.equal(g.certain, false);
  assert.match(g.text, /file names do not say which angles/);
  // The whole point: it must not assert an angle it cannot see.
  assert.doesNotMatch(g.text, /Missing the/);
  assert.match(g.short, /angles unclear/);
});

test("a record cached before angle classification is treated as unknown, not as zero", () => {
  // Regression: an older record has no `angles` key. Reading that as "no angle
  // matched" would confidently report all three missing for an event that
  // plainly has clips.
  const g = explainVideoGap({ videoCount: 2 });
  assert.equal(g.certain, false);
  assert.doesNotMatch(g.text, /Missing the theft/);
});

test("zero clips does name all three, since nothing is ambiguous", () => {
  const g = explainVideoGap({ videoCount: 0, angles: { theft: 0, door: 0, office: 0 }, videoUnattributed: 0 });
  assert.ok(g.certain);
  assert.equal(g.lack.length, 3);
});

test("three clips of the same angle is still short two angles", () => {
  const c = classifyEvidence([vid("theft1.mp4"), vid("theft2.mp4"), vid("theft3.mp4")]);
  assert.equal(c.videoCount, 3);
  assert.deepEqual(explainVideoGap(c).lack, ["exiting the building", "the office"]);
  // Note: missingFor is count-based, so the angle gap does NOT flag it as short
  // on video today. Flagging on angles would fire on every opaquely-named clip,
  // so that stays a deliberate decision rather than a side effect of this test.
  assert.ok(!missingFor(c).includes("video"));
});

test("email states the policy, one block per flagged event, and skips compliant ones", () => {
  const { subject, body } = aurorExceptionsEmail({
    storeNbr: "1458", days: 30,
    counts: { total: 3, flagged: 2, missingPhoto: 1, missingStatement: 0, missingVideo: 2 },
    records: [
      { eventId: "1", title: "Fraud e1", occurredAt: "2026-09-26", totalValue: 10, people: "",
        videoCount: 1, angles: { theft: 1, door: 0, office: 0 }, videoUnattributed: 0, missing: ["video"] },
      { eventId: "2", title: "Shoplifting e2", occurredAt: "2026-09-21", totalValue: 20, people: "A B",
        videoCount: 3, angles: { theft: 1, door: 1, office: 1 }, videoUnattributed: 0, missing: ["photo"] },
      { eventId: "3", title: "Compliant e3", occurredAt: "2026-09-20", totalValue: 30, people: "",
        videoCount: 3, angles: { theft: 1, door: 1, office: 1 }, videoUnattributed: 0, missing: [] },
    ],
  });
  assert.match(subject, /Store 1458/);
  assert.match(body, /the theft, the subject exiting the building, and the office/);
  assert.match(body, /event\/1/);
  assert.match(body, /event\/2/);
  assert.doesNotMatch(body, /event\/3/);          // compliant events are not listed
  assert.match(body, /Missing exiting the building and the office/);
});

test("no cache yields no email rather than a half-built one", () => {
  assert.deepEqual(aurorExceptionsEmail(null), { subject: "", body: "" });
  assert.deepEqual(aurorExceptionsEmail({ records: [] }), { subject: "", body: "" });
});
