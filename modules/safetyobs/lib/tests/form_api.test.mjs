// node --test modules/safetyobs/lib/tests/form_api.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { buildResponseBody, readPageTokens } from "../form_api.js";
import { QUESTIONS } from "../form_schema.js";

// The page's own (blocked) submit, captured 2026-10-08.
const CAPTURED_ANSWERS = '[{"questionId":"r671716f5a3de45d7bfbdddfd52a32410","answer1":"1458"},{"questionId":"r6eeb57010613448d99f92091c032406f","answer1":"Coach"},{"questionId":"re0b4a8163f104636addcd423cf3f2a05","answer1":"First"},{"questionId":"r181b93c8512f43cd81dfa96c559c3adb","answer1":"Recognition"},{"questionId":"r101726c00cbc4c7998424384b5657cac","answer1":"CAPTURE TEST - blocked, never sent"},{"questionId":"r8ffe7e3fe03146bea2388c49583cbcd7","answer1":"Fresh"},{"questionId":"rb670dc547a8a4bc6bae16fd9c8d4cee9","answer1":"Cleaning"},{"questionId":"ra2379a07a2e64b278efae4667942ed93","answer1":"Cleaning supplies"}]';

test("body answers match the page's own submit byte for byte", () => {
  const b = buildResponseBody(QUESTIONS, { store: "1458", role: "Coach", shift: "First", type: "Recognition", description: "CAPTURE TEST - blocked, never sent", location: "Fresh", process: "Cleaning", tool: "Cleaning supplies" });
  assert.equal(b.answers, CAPTURED_ANSWERS);
  assert.ok(Date.parse(b.startDate) < Date.parse(b.submitDate));
});

test("engagement leaves the description question out", () => {
  const b = buildResponseBody(QUESTIONS, { store: "1458", role: "Coach", shift: "First", type: "Engagement", description: "x", location: "Food", process: "Climbing", tool: "Merchandise" });
  const ids = JSON.parse(b.answers).map((a) => a.questionId);
  assert.equal(ids.length, 7);
  assert.ok(!ids.includes("r101726c00cbc4c7998424384b5657cac"));
});

test("tokens from page html", () => {
  assert.deepEqual(readPageTokens('x "antiForgeryToken":"abc","serverSessionId":"d4e3" y'), { antiForgeryToken: "abc", serverSessionId: "d4e3" });
  assert.equal(readPageTokens("<html>sign in</html>"), null);
});
