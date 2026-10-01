// node modules/boblisa/lib/tests/video.test.mjs
//
// The ▶ Video links' pre-flight check. The cases that matter are the two that
// used to be indistinguishable to the analyst: Secure signed out (the CCTV app
// bounces to its blocked origin and the tab reads "Error 403 - Forbidden"),
// versus an account that really has no CCTV entitlement.
import assert from "node:assert/strict";
import { camerasUrl, probeCameras, videoUrl } from "../video.js";

const CAM = [{ sourceApp: "store", cameraId: "1458_POS_25-25", posNo: 25, name: "POS_25", description: "POS_25" }];

// A stand-in for the one real behaviour worth pinning: `res.url` after a
// followed redirect is what tells us where we ended up.
const fake = ({ status = 200, url = camerasUrl(1458, 25), json = CAM, text = null }) => async () => ({
  status, ok: status >= 200 && status < 300, url,
  json: async () => { if (text != null) throw new Error("not json"); return json; },
  text: async () => text ?? JSON.stringify(json),
});

const t = [];
const test = (name, fn) => t.push([name, fn]);

test("camerasUrl carries store and register", () => {
  assert.equal(camerasUrl(1458, 25), "https://apps.apprissretail.com/walmart-usa/video/api/Camera/getcameras?storeNo=1458&posNo=25");
  assert.equal(camerasUrl(null, 25), null);
  assert.equal(camerasUrl(1458, null), null);
});

test("a live session returns the register's cameras", async () => {
  const res = await probeCameras(1458, 25, { fetchImpl: fake({}) });
  assert.equal(res.ok, true);
  assert.deepEqual(res.cameras, [{ cameraId: "1458_POS_25-25", name: "POS_25" }]);
});

test("landing on the blocked CCTV origin is a dead session, not a permission", async () => {
  const res = await probeCameras(1458, 25, {
    fetchImpl: fake({ status: 403, url: "https://web-prd-wus2-arp-cctv.azurewebsites.net/walmart-usa/video/login?ReturnUrl=%2F", text: "<html>Error 403 - Forbidden" }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.errorClass, "AUTH");          // → the gate reauthenticates and retries
  assert.match(res.error, /wmlink\/securestore/);
  assert.ok(res.loginUrl);
});

test("the sign-in page served as HTML is also a dead session", async () => {
  const res = await probeCameras(1458, 25, {
    fetchImpl: fake({ url: "https://apps.apprissretail.com/walmart-usa/signin", text: "<!DOCTYPE html>" }),
  });
  assert.equal(res.errorClass, "AUTH");
});

test("403 from APPRISS itself is the entitlement, and must not trigger a reauth", async () => {
  const res = await probeCameras(1458, 25, { fetchImpl: fake({ status: 403, text: "forbidden" }) });
  assert.equal(res.errorClass, "FORBIDDEN");
  assert.equal(res.loginUrl, undefined);         // isApprissAuthFailure() must read false
  assert.match(res.error, /wmlink\/securestore/);
});

test("no camera mapped to the register is reported, not treated as an error", async () => {
  // The real shape: 400 text/plain, not an empty array (live 2026-09-27).
  const res = await probeCameras(1458, 47, { fetchImpl: fake({ status: 400, text: "No cameras found for the store 1458, POS 47." }) });
  assert.equal(res.errorClass, "NO_CAMERA");
  assert.match(res.error, /POS 47/);
  const empty = await probeCameras(1458, 47, { fetchImpl: fake({ json: [] }) });
  assert.equal(empty.errorClass, "NO_CAMERA");
});

test("a 400 that is not about cameras stays an HTTP error", async () => {
  const res = await probeCameras(1458, "abc", { fetchImpl: fake({ status: 400, text: '{"title":"One or more validation errors occurred."}' }) });
  assert.equal(res.errorClass, "HTTP");
});

test("an unreachable CCTV app is auth-suspect: one reauth, then fail", async () => {
  const res = await probeCameras(1458, 25, { fetchImpl: async () => { throw new Error("Failed to fetch"); } });
  assert.equal(res.errorClass, "AUTH_OR_HTTP");
  assert.ok(res.loginUrl);
});

test("videoUrl still pads the window two minutes before the receipt stamp", () => {
  assert.equal(videoUrl(1458, 25, "2026-09-26", "14:00:00"),
    "https://apps.apprissretail.com/walmart-usa/video/react#/cameras?storeNo=1458&posNo=25&startTime=2026-09-26T13%3A58%3A00&endTime=2026-09-26T14%3A00%3A15");
});

let failed = 0;
for (const [name, fn] of t) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
console.log(failed ? `${failed} failed` : `${t.length} passed`);
process.exit(failed ? 1 : 0);
