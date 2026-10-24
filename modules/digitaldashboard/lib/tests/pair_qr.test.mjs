import test from "node:test";
import assert from "node:assert/strict";
import { pairLink, qrSvg } from "../pair_qr.js";

test("pair link carries the code; svg is a square QR with a quiet zone", () => {
  assert.equal(pairLink("ABCD-EFGH"), "gifcompanion://pair?code=ABCD-EFGH");
  const svg = qrSvg(pairLink("ABCD-EFGH"), { px: 2 });
  const [, w] = svg.match(/width="(\d+)"/);
  assert.equal(Number(w), (29 + 8) * 2);        // version 3 = 29 modules
  assert.match(svg, /<path d="M8 8h2v2h-2z/);    // finder pattern's top-left module sits at the quiet-zone edge
});
