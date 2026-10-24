import test from "node:test";
import assert from "node:assert/strict";
import { emptyControl, setPause, controlReply, phonePause, MAX_PAUSE_MIN } from "../phone_control.js";

const T = Date.UTC(2026, 9, 23, 23, 30);

test("pause, resume and cap; seq always moves so the phone re-applies", () => {
  assert.equal(controlReply(emptyControl()), null);
  const p = setPause(null, 30, "dashboard", T);
  assert.deepEqual(controlReply(p), { seq: 1, pauseUntil: T + 30 * 60_000, by: "dashboard" });
  const r = setPause(p, 0, "dashboard", T + 60_000);
  assert.equal(r.seq, 2);
  assert.equal(r.pauseUntil, 0);
  assert.equal(setPause(r, 9999, "x", T).pauseUntil, T + MAX_PAUSE_MIN * 60_000);
  assert.equal(setPause(r, "junk", "x", T).pauseUntil, 0);
});

test("phonePause reads the phone's reported hold, expired = running", () => {
  assert.deepEqual(phonePause({ pausedUntil: T + 5000, pauseReason: "tile" }, T), { until: T + 5000, reason: "tile" });
  assert.equal(phonePause({ pausedUntil: T - 1 }, T), null);
  assert.equal(phonePause(null, T), null);
});
