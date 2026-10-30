// modules/gifphone/lib/adb_key.js
//
// The browser's own adb key: an RSA-2048 pair kept as a JWK in this module's
// storage. The phone remembers the PUBLIC half once the user taps "Always allow
// from this computer"; after that each connect is answered by signing the
// phone's 20-byte token.
//
// adbd checks the signature with RSA_verify(NID_sha1, token, …): the token is
// treated as an already-computed SHA-1 digest. WebCrypto would hash it again,
// so the signature is raw RSA over PKCS#1 v1.5 padding, done with BigInt.

const SHA1_DIGEST_INFO = [0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a, 0x05, 0x00, 0x04, 0x14];
const KEY_BITS = 2048;
const KEY_BYTES = KEY_BITS / 8;
const KEY_WORDS = KEY_BITS / 32;

export async function generateAdbKey() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: KEY_BITS, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-1" },
    true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { n: jwk.n, e: jwk.e, d: jwk.d };
}

function b64urlToBig(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  let hex = "";
  for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, "0");
  return BigInt("0x" + (hex || "0"));
}

function modPow(base, exp, mod) {
  let r = 1n; base %= mod;
  while (exp > 0n) {
    if (exp & 1n) r = (r * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return r;
}

function bigToBytes(x, len) {
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
}

/** Signature for an AUTH TOKEN: PKCS#1 v1.5 (SHA-1 DigestInfo) over the token as-is. */
export function signToken(key, token) {
  const em = new Uint8Array(KEY_BYTES);
  em[0] = 0x00; em[1] = 0x01;
  const tail = SHA1_DIGEST_INFO.length + token.length;
  em.fill(0xff, 2, KEY_BYTES - tail - 1);
  em[KEY_BYTES - tail - 1] = 0x00;
  em.set(SHA1_DIGEST_INFO, KEY_BYTES - tail);
  em.set(token, KEY_BYTES - token.length);
  let m = 0n;
  for (const b of em) m = (m << 8n) | BigInt(b);
  return bigToBytes(modPow(m, b64urlToBig(key.d), b64urlToBig(key.n)), KEY_BYTES);
}

/**
 * adbkey.pub body: base64 of Android's RSAPublicKey struct (all little-endian
 * uint32: len in words, n0inv = -1/n mod 2^32, n, rr = 2^(2·bits) mod n, e),
 * then " <name>". AUTH RSAPUBLICKEY sends it NUL-terminated.
 */
export function adbPublicKey(key, name = "APAISuite@browser") {
  const n = b64urlToBig(key.n);
  const e = Number(b64urlToBig(key.e));
  const buf = new DataView(new ArrayBuffer(4 + 4 + KEY_BYTES * 2 + 4));
  const two32 = 1n << 32n;
  const n0 = n % two32;
  // inverse of n0 mod 2^32 by Newton iteration (n0 is odd)
  let inv = 1n;
  for (let i = 0; i < 5; i++) inv = (inv * (2n - n0 * inv)) % two32;
  const n0inv = (two32 - inv) % two32;
  const rr = modPow(2n, BigInt(KEY_BITS * 2), n);
  let off = 0;
  buf.setUint32(off, KEY_WORDS, true); off += 4;
  buf.setUint32(off, Number(n0inv), true); off += 4;
  for (let i = 0, x = n; i < KEY_WORDS; i++, x >>= 32n) { buf.setUint32(off, Number(x % two32), true); off += 4; }
  for (let i = 0, x = rr; i < KEY_WORDS; i++, x >>= 32n) { buf.setUint32(off, Number(x % two32), true); off += 4; }
  buf.setUint32(off, e, true);
  const bytes = new Uint8Array(buf.buffer);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `${btoa(bin)} ${name}`;
}
