// Unit tests for the pure helpers in lib/workvivo_upload.js.
// The CDP-driven flow itself can't be unit-tested without a browser, so we
// test the deterministic bits: the Sendbird channel_url → web route mapping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { channelWebPath, channelWebUrl } from "../workvivo_upload.js";

test("channelWebPath: maps sendbird_group_channel_<id> → /chat/channels/gc_<id>", () => {
  assert.equal(
    channelWebPath("sendbird_group_channel_449680541_0a3dc240a9ceda97d461496be0098b274ce18e93"),
    "/chat/channels/gc_449680541_0a3dc240a9ceda97d461496be0098b274ce18e93",
  );
});

test("channelWebPath: handles a second real channel id", () => {
  assert.equal(
    channelWebPath("sendbird_group_channel_449935089_034d2c4a51e1127144b98428e565ebb6ee2a2828"),
    "/chat/channels/gc_449935089_034d2c4a51e1127144b98428e565ebb6ee2a2828",
  );
});

test("channelWebPath: returns null for unrecognized input", () => {
  assert.equal(channelWebPath("open_channel_123"), null);
  assert.equal(channelWebPath(""), null);
  assert.equal(channelWebPath(null), null);
  assert.equal(channelWebPath(undefined), null);
  assert.equal(channelWebPath(12345), null);
});

test("channelWebUrl: prefixes the workvivo origin", () => {
  assert.equal(
    channelWebUrl("sendbird_group_channel_1_abc"),
    "https://workvivo.walmart.com/chat/channels/gc_1_abc",
  );
});

test("channelWebUrl: falls back to /chat when unmappable", () => {
  assert.equal(channelWebUrl("nope"), "https://workvivo.walmart.com/chat");
});
