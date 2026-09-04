// node --test modules/sparkfraud/lib/tests/gscope_urls.test.mjs
//
// Pins the gscope SSO readiness test. The bug these exist for: the pfedprod
// start URL carries `PartnerSpId=https://gscope.walmartlabs.com/sp` in its
// query string, so a substring test says "already on gscope" while the tab is
// still on the FIRST hop of the chain.

import test from "node:test";
import assert from "node:assert/strict";

import {
  GSCOPE_HOST,
  isGscopeHost,
  isStuckGscopeUrl,
  isUsableGscopeUrl,
} from "../gscope_urls.js";

// Copied verbatim from service.js::SSO_START_URL. If that constant changes,
// change it here too — the whole point is that this exact string must not
// read as "arrived".
const SSO_START_URL =
  "https://pfedprod.wal-mart.com/idp/startSSO.ping?PartnerSpId=https://gscope.walmartlabs.com/sp";

test("the pfedprod start URL is NOT on the gscope host", () => {
  // The regression. `SSO_START_URL.includes(GSCOPE_HOST)` is true...
  assert.equal(SSO_START_URL.includes(GSCOPE_HOST), true);
  // ...and that is exactly why the readiness test may not be a substring one.
  assert.equal(isGscopeHost(SSO_START_URL), false);
  assert.equal(isUsableGscopeUrl(SSO_START_URL), false);
});

test("a real gscope content page is usable", () => {
  for (const url of [
    "https://gscope.walmartlabs.com/apphome",
    "https://gscope.walmartlabs.com/mfe/spark/dashboard",
    "https://gscope.walmartlabs.com/mfe/ordermanagement/orderresolution?id=1",
  ]) {
    assert.equal(isUsableGscopeUrl(url), true, url);
  }
});

test("intermediate SSO endpoints on gscope are not usable", () => {
  for (const url of [
    "https://gscope.walmartlabs.com/api/wmstoresso",
    "https://gscope.walmartlabs.com/api/sso",
    "https://gscope.walmartlabs.com/api/ssoCallback",
    "https://gscope.walmartlabs.com/login",
  ]) {
    assert.equal(isGscopeHost(url), true, url);
    assert.equal(isStuckGscopeUrl(url), true, url);
    assert.equal(isUsableGscopeUrl(url), false, url);
  }
});

test("other hosts that merely mention gscope are rejected", () => {
  for (const url of [
    "https://login.microsoftonline.com/x?RelayState=https://gscope.walmartlabs.com/",
    "https://evil.example.com/#gscope.walmartlabs.com/apphome",
    // Suffix attack: a substring test on the bare host passes this too.
    "https://gscope.walmartlabs.com.example.com/apphome",
  ]) {
    assert.equal(isGscopeHost(url), false, url);
    assert.equal(isUsableGscopeUrl(url), false, url);
  }
});

test("empty / malformed input is never usable", () => {
  for (const url of ["", null, undefined, "about:blank", "not a url"]) {
    assert.equal(isUsableGscopeUrl(url), false, String(url));
  }
  // about:blank is the tab's starting state in openAndDriveOwnAuthTab.
  assert.equal(isGscopeHost("about:blank"), false);
});
