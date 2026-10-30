import test from "node:test";
import assert from "node:assert/strict";
import { parseUsers, withService, versionCodeOf, installProblem, A11Y_SERVICE, STEPS } from "../setup.js";

test("pm list users", () => {
  const t = "Users:\n\tUserInfo{0:Owner:c13} running\n\tUserInfo{10:Work profile:1030} running\n";
  assert.deepEqual(parseUsers(t), [{ id: 0, name: "Owner" }, { id: 10, name: "Work profile" }]);
});

test("accessibility list keeps other services and never duplicates ours", () => {
  assert.equal(withService("null"), A11Y_SERVICE);
  assert.equal(withService(""), A11Y_SERVICE);
  assert.equal(withService("com.x/.Svc"), `com.x/.Svc:${A11Y_SERVICE}`);
  assert.equal(withService(`com.x/.Svc:${A11Y_SERVICE}`), `com.x/.Svc:${A11Y_SERVICE}`);
  assert.equal(withService("com.apaisuite.gifcompanion/.GifService"), "com.apaisuite.gifcompanion/.GifService");
});

test("version code + install answers", () => {
  assert.equal(versionCodeOf("    versionCode=13 minSdk=30 targetSdk=35"), 13);
  assert.equal(versionCodeOf(""), 0);
  assert.equal(installProblem("Success"), "");
  assert.equal(installProblem("Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: …]"), "incompatible");
  assert.equal(installProblem("Failure [INSTALL_FAILED_VERIFICATION_FAILURE]"), "verification");
  assert.match(installProblem("Failure [INSTALL_FAILED_USER_RESTRICTED]"), /work policy/);
});

test("a full run against a scripted phone issues the expected commands", async () => {
  const ran = [];
  const answers = [
    [/version.sdk/, "36"], [/version.release/, "16"], [/product.model/, "SM-S928U"],
    [/pm list users/, "UserInfo{0:Owner:c13} running\nUserInfo{10:Work profile:1030} running"],
    [/pm path --user 10/, "package:/data/app/gif2/base.apk"], [/pm path/, ""],
    [/get global stay_on/, "15"], [/pm list packages/, ""],
    [/get secure enabled_accessibility/, "null"], [/grep -c GifService/, "2"],
  ];
  const adb = {
    async shell(c) { ran.push(c); return (answers.find(([re]) => re.test(c)) || [, ""])[1]; },
    async install(apk) { ran.push(`install ${apk.length}`); return "Success"; },
  };
  const ctx = {
    apk: new Uint8Array(5), apkInfo: { versionCode: 13, versionName: "0.1.12" },
    log() {}, progress() {},
    pairCode: async () => "ABCD-EFGH",
    waitPaired: async () => ({ store: "1458", keyId: "k1" }),
    waitReporting: async () => ({ phone: { status: { step: "OPD pass" } } }),
  };
  const results = [];
  for (const s of STEPS) results.push([s.id, await s.run(adb, ctx)]);
  assert.ok(results.every(([, r]) => r.ok), JSON.stringify(results));
  assert.ok(ran.includes("install 5"));
  assert.ok(ran.some((c) => c.includes("enabled_accessibility_services 'com.apaisuite.gifcompanion/com.apaisuite.gifcompanion.GifService'")));
  assert.ok(ran.some((c) => c.includes("gifcompanion://pair?code=ABCD-EFGH")));
  assert.ok(ran.some((c) => c.includes("--es endpoint https://qrcallbox.com/api/gif --ez enable true")));
  assert.match(results[1][1].detail, /work profile/);
});
