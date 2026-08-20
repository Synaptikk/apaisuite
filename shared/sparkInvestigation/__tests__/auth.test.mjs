// shared/sparkInvestigation/__tests__/auth.test.mjs
//
// Run: node --test shared/sparkInvestigation/__tests__/

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { buildSwiftHeaders } from "../auth.js";

describe("buildSwiftHeaders", () => {
  it("returns ok:false without cookies", () => {
    const r = buildSwiftHeaders(null);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "no-cookies");
  });

  it("returns ok:false without authToken", () => {
    const r = buildSwiftHeaders({ displayName: "Alice", loginId: "alice" });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "auth-cookies-missing");
    assert.deepEqual(r.have, ["displayName", "loginId"]);
  });

  it("returns full headers with legacy displayName/loginId cookies", () => {
    const cookies = {
      authToken: "TOK-123",
      authHeader: "HDR-123",
      displayName: "Alice Doe",
      loginId: "adoe1",
      "store-no": "1458",
      loggedInDomain: "store",
      loggedInUsername: "adoe1",
    };
    const r = buildSwiftHeaders(cookies);
    assert.equal(r.ok, true);
    assert.equal(r.identity.display, "Alice Doe");
    assert.equal(r.identity.loginId, "adoe1");
    assert.equal(r.identity.firstName, "Alice");
    assert.equal(r.identity.lastName, "Doe");
    assert.equal(r.identity.storeId, "1458");
    assert.equal(r.headers["x-authtoken"], "TOK-123");
    assert.equal(r.headers["x-authheader"], "HDR-123");
    assert.equal(r.headers["x-userid"], "adoe1");
    assert.equal(r.headers["x-username"], "Alice Doe");
    assert.equal(r.headers["x-storeid"], "1458");
    assert.equal(r.headers["x-tenant"], "WALMART_US");
    assert.equal(r.headers["installed_app"], "spark-dispatcher.us");
  });

  it("falls back to wire-id when legacy cookies are empty", () => {
    // Walmart's gscope now ships displayName/loginId as empty strings.
    // Identity is parsed from wire-id: "Display Name - loginId".
    const cookies = {
      authToken: "TOK",
      displayName: "",
      loginId: "",
      "wire-id": "Bob Smith - bsmith2",
    };
    const r = buildSwiftHeaders(cookies);
    assert.equal(r.ok, true);
    assert.equal(r.identity.display, "Bob Smith");
    assert.equal(r.identity.loginId, "bsmith2");
    assert.equal(r.headers["x-username"], "Bob Smith");
    assert.equal(r.headers["x-userid"], "bsmith2");
  });

  it("uses wire-id as display when it doesn't match the split pattern", () => {
    const cookies = {
      authToken: "TOK",
      displayName: "",
      loginId: "",
      "wire-id": "MalformedIdentity",
    };
    const r = buildSwiftHeaders(cookies);
    assert.equal(r.ok, true);
    assert.equal(r.identity.display, "MalformedIdentity");
    assert.equal(r.identity.loginId, "");
  });

  it("treats cookie keys case-insensitively", () => {
    const cookies = { authtoken: "TOK", DisplayName: "Alice" };
    const r = buildSwiftHeaders(cookies);
    assert.equal(r.ok, true);
    assert.equal(r.headers["x-username"], "Alice");
  });
});
