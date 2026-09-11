import test from "node:test";
import assert from "node:assert/strict";
import { configureKey } from "../crypto.js";
import { encodeEditor, decodeEditor, editorText } from "../audit.js";

configureKey(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"));
test("editor identity is encrypted and recovered for display", async () => {
  globalThis.chrome = { storage: { local: { get: async () => ({
    "apai.identity": { displayName: "Test Analyst" },
  }) } } };
  const encoded = await encodeEditor();
  assert.ok(!JSON.stringify(encoded).includes("Test Analyst"));
  const decoded = await decodeEditor(encoded);
  assert.equal(decoded.label, "Test Analyst");
  assert.match(editorText(decoded), /Last saved by Test Analyst/);
  assert.equal(await decodeEditor(null), null);
  assert.match(editorText(null), /unavailable/);
});
