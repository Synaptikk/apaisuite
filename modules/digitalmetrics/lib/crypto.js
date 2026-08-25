// modules/digitalmetrics/lib/crypto.js
//
// Two primitives, two different jobs. Keeping them separate is the whole
// design; collapsing them back into one field reintroduces the problem.
//
//   token(name)  — deterministic, irreversible, the JOIN KEY. Same associate
//                  always yields the same token, so a week of metrics can be
//                  joined to a schedule without either document holding a name.
//
//   seal(name)   — randomised, reversible, the DISPLAY VALUE. Different
//                  ciphertext every call, so it leaks nothing on its own and
//                  cannot be used as a key.
//
// Works unchanged in the view page and in the service worker; both have
// crypto.subtle.

import { MASTER_SECRET_B64, TOKEN_INFO, DISPLAY_INFO } from "./crypto_config.js";
import { resolve } from "./names.js";

const TOKEN_BYTES = 16;   // 128 bits — collision-free at roster scale
const IV_BYTES    = 12;   // AES-GCM standard nonce length

let keyPromise = null;
let masterSecretB64 = MASTER_SECRET_B64;

/**
 * Override the master secret at runtime and discard any derived keys.
 *
 * Two real callers, not just tests:
 *   • the build step, which should inject the production key at package time
 *     rather than leaving it committed in crypto_config.js
 *   • a future key-rotation path
 */
export function configureKey(b64) {
  masterSecretB64 = b64;
  keyPromise = null;
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return b64ToBytes(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

// Derive both keys once from the master secret. HKDF with distinct `info`
// labels means the token key and the display key are cryptographically
// unrelated: leaking one does not yield the other.
/**
 * Refuse to derive from a key that was never set.
 *
 * The entire privacy guarantee rests on this value being real and per-build.
 * Without a check the failure modes are both bad and both quiet:
 *
 *  - The shipped placeholder contains "_", which is not standard base64, so a
 *    browser's atob() throws — but deep inside crypto.subtle at the first
 *    token derivation, as an opaque InvalidCharacterError with nothing
 *    pointing at the real cause. (Node's Buffer is laxer and yields 34 bytes
 *    of junk, so tests would not have caught it either.)
 *  - Worse: swap the placeholder for anything that happens to BE valid base64
 *    and it derives silently. Every install then shares a key that is sitting
 *    in a public repo, and nothing anywhere says so.
 *
 * Fail at configuration time with a message naming the fix instead. See
 * docs/SCHEMA.md §1 step 3.
 */
function assertRealKey(b64) {
  if (!b64 || /^REPLACE_ME/.test(b64)) {
    throw new Error(
      "digitalmetrics: MASTER_SECRET_B64 is still the placeholder. Inject the " +
      "real key with crypto.configureKey(<32 bytes, base64>) at package time — " +
      "see docs/SCHEMA.md provisioning step 3. Never commit it.",
    );
  }
  let bytes;
  try {
    bytes = b64ToBytes(b64);
  } catch {
    throw new Error("digitalmetrics: MASTER_SECRET_B64 is not valid base64.");
  }
  if (bytes.length !== 32) {
    throw new Error(
      `digitalmetrics: MASTER_SECRET_B64 must decode to exactly 32 bytes, got ${bytes.length}.`,
    );
  }
  return bytes;
}

function keys() {
  if (keyPromise) return keyPromise;
  keyPromise = (async () => {
    const master = await crypto.subtle.importKey(
      "raw", assertRealKey(masterSecretB64), "HKDF", false, ["deriveKey"]
    );
    const enc = new TextEncoder();
    const derive = (info, algo, usages) => crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(info) },
      master, algo, false, usages
    );
    return {
      tokenKey:   await derive(TOKEN_INFO,   { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign"]),
      displayKey: await derive(DISPLAY_INFO, { name: "AES-GCM", length: 256 },               ["encrypt", "decrypt"]),
    };
  })();
  return keyPromise;
}

/**
 * Stable, irreversible identifier for an associate.
 * Runs the name through alias resolution + canonicalisation first, so every
 * spelling of the same person collapses to one token.
 */
export async function token(rawName) {
  const c = resolve(rawName);
  if (!c) return null;
  const { tokenKey } = await keys();
  const mac = await crypto.subtle.sign("HMAC", tokenKey, new TextEncoder().encode(c));
  return bytesToB64url(new Uint8Array(mac).slice(0, TOKEN_BYTES));
}

/** Encrypt a display name. Randomised: never use the output as a key. */
export async function seal(rawName) {
  if (rawName == null || rawName === "") return null;
  const { displayKey } = await keys();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, displayKey, new TextEncoder().encode(String(rawName))
  );
  const out = new Uint8Array(IV_BYTES + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), IV_BYTES);
  return bytesToB64url(out);
}

/** Decrypt a display name. Returns null on any tampering or key mismatch. */
export async function open(sealed) {
  if (!sealed) return null;
  try {
    const { displayKey } = await keys();
    const raw = b64urlToBytes(sealed);
    const pt  = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: raw.slice(0, IV_BYTES) }, displayKey, raw.slice(IV_BYTES)
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

/** Both halves at once — what every write path actually needs. */
export async function identify(rawName) {
  return { t: await token(rawName), n: await seal(rawName) };
}
