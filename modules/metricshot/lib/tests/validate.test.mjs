// modules/metricshot/lib/tests/validate.test.mjs
//
// Pure-function tests for PNG + auth-wall validation.
// Run with: node --test modules/metricshot/lib/tests/validate.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validatePngBytes,
  looksLikeAuthWall,
  base64ToBytes,
} from "../validate.js";

// A 1×1 valid PNG (opaque white). Base64 courtesy of the format spec.
const WHITE_1x1_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVQI12NgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC";

// Build a synthetic PNG of arbitrary size by emitting a minimal PNG stream
// with the given dimensions. Not a real image — just IHDR + IEND — but the
// validator only checks signature + IHDR + byte count.
function buildFakePng(width, height, padding = 0) {
  const sig = Uint8Array.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);
  const ihdr = new Uint8Array(25);
  // Length prefix (13 = IHDR data length): 4 bytes big-endian
  ihdr[0] = 0; ihdr[1] = 0; ihdr[2] = 0; ihdr[3] = 13;
  // "IHDR"
  ihdr[4] = 0x49; ihdr[5] = 0x48; ihdr[6] = 0x44; ihdr[7] = 0x52;
  // width
  ihdr[8]  = (width  >>> 24) & 0xff;
  ihdr[9]  = (width  >>> 16) & 0xff;
  ihdr[10] = (width  >>> 8)  & 0xff;
  ihdr[11] = (width) & 0xff;
  // height
  ihdr[12] = (height >>> 24) & 0xff;
  ihdr[13] = (height >>> 16) & 0xff;
  ihdr[14] = (height >>> 8)  & 0xff;
  ihdr[15] = (height) & 0xff;
  // rest of IHDR + CRC placeholder (validator doesn't check CRC)
  const tail = new Uint8Array(padding);
  const out = new Uint8Array(sig.length + ihdr.length + tail.length);
  out.set(sig, 0);
  out.set(ihdr, sig.length);
  out.set(tail, sig.length + ihdr.length);
  return out;
}

test("validatePngBytes: rejects empty", () => {
  assert.equal(validatePngBytes(new Uint8Array()).ok, false);
});

test("validatePngBytes: rejects non-PNG", () => {
  const notPng = new Uint8Array(10_000).fill(0x20);
  const v = validatePngBytes(notPng);
  assert.equal(v.ok, false);
  assert.match(v.reason, /not a PNG/);
});

test("validatePngBytes: rejects too small", () => {
  const tiny = buildFakePng(200, 200, 100);   // huge dims but <5KB
  const v = validatePngBytes(tiny);
  assert.equal(v.ok, false);
  assert.match(v.reason, /too small/);
});

test("validatePngBytes: rejects too narrow / too short", () => {
  const narrow = buildFakePng(50, 200, 6000);
  const shortP = buildFakePng(200, 50, 6000);
  assert.match(validatePngBytes(narrow).reason, /too narrow/);
  assert.match(validatePngBytes(shortP).reason, /too short/);
});

test("validatePngBytes: accepts a well-formed PNG of adequate size + dims", () => {
  const ok = buildFakePng(300, 300, 6000);
  const v = validatePngBytes(ok);
  assert.equal(v.ok, true, `unexpected error: ${v.reason}`);
  assert.equal(v.width, 300);
  assert.equal(v.height, 300);
});

test("looksLikeAuthWall: title match", () => {
  assert.equal(looksLikeAuthWall({ title: "Sign In — Walmart Stores" }), true);
  assert.equal(looksLikeAuthWall({ title: "Access Denied" }), true);
  assert.equal(looksLikeAuthWall({ title: "PingFederate SSO" }), true);
  assert.equal(looksLikeAuthWall({ title: "VizPick Score" }), false);
});

test("looksLikeAuthWall: heading match", () => {
  assert.equal(looksLikeAuthWall({ title: "", headings: ["", "Session Expired"] }), true);
  assert.equal(looksLikeAuthWall({ title: "VizPick", headings: ["Login to continue"] }), true);
});

test("base64ToBytes: round-trips a small PNG", () => {
  const bytes = base64ToBytes(WHITE_1x1_B64);
  assert.equal(bytes[0], 0x89);
  assert.equal(bytes[1], 0x50);
  assert.equal(bytes[2], 0x4E);
  assert.equal(bytes[3], 0x47);
});

test("base64ToBytes: strips data URL prefix", () => {
  const bytes = base64ToBytes(`data:image/png;base64,${WHITE_1x1_B64}`);
  assert.equal(bytes[0], 0x89);
});
