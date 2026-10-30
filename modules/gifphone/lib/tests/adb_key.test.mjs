import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { generateAdbKey, signToken, adbPublicKey } from "../adb_key.js";

test("signature is PKCS#1 v1.5 over the raw token with the SHA-1 DigestInfo", async () => {
  const key = await generateAdbKey();
  const token = crypto.randomBytes(20);
  const sig = signToken(key, new Uint8Array(token));
  const pub = crypto.createPublicKey({ key: { kty: "RSA", n: key.n, e: key.e }, format: "jwk" });
  // RSA_verify(NID_sha1, token) == verify of a SHA-1 digest equal to the token
  const recovered = crypto.publicDecrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(sig));
  assert.equal(recovered.toString("hex"), "3021300906052b0e03021a05000414" + token.toString("hex"));
});

test("public key matches adb's own adbkey.pub encoding", { skip: !process.env.ADBKEY_DIR }, async () => {
  const fs = await import("node:fs");
  const dir = process.env.ADBKEY_DIR;
  const jwk = crypto.createPrivateKey(fs.readFileSync(dir + "/adbkey", "utf8")).export({ format: "jwk" });
  const want = fs.readFileSync(dir + "/adbkey.pub", "utf8").trim().split(" ")[0];
  assert.equal(adbPublicKey(jwk).split(" ")[0], want);
});
