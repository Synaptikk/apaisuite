// modules/qrcallbox/lib/api.js
//
// QRCallBox (Firebase project qrwebaccdb) from the service worker: email +
// password sign-in, Firestore REST reads under the user's own ID token, and
// the qrcallbox.com /api endpoints the web app calls. Same identity, same
// Firestore rules and same endpoints as qrcallbox.com — nothing here gets
// more access than the website gives that account.
//
// REST only, no Firebase SDK: the SDK keeps WebSocket/IndexedDB state an MV3
// service worker cannot hold across its idle sleep (same reason as
// shared/suiteBackend.js).
//
// Session: the refresh token lives in chrome.storage.local so a browser
// restart keeps the user signed in; the ID token (1 h) is cached in
// chrome.storage.session. The password is never stored.

// Public web API key from the qrcallbox.com bundle
// (QRCallBox/src/firebaseClient.js). Identifies the project only.
const WEB_API_KEY = "AIzaSyCbpXuSt3UHAWtAfiKbVx621vwpL5cKnkA";
// X-API-Key the web app sends to /api/mint (VITE_API_KEY). It already ships
// in the public qrcallbox.com bundle; the mint function also requires the
// user's ID token.
const MINT_API_KEY = "cB6KPJ59OKhAG_GAGVdZczTiVECP9pa41slYVziXc1q-Plgav5bEidzirRz0Hm9E";

export const SITE = "https://qrcallbox.com";
const SIGN_IN_URL = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${WEB_API_KEY}`;
const REFRESH_URL = `https://securetoken.googleapis.com/v1/token?key=${WEB_API_KEY}`;
const FS = "https://firestore.googleapis.com/v1/projects/qrwebaccdb/databases/(default)/documents";

const KEY_SESSION = "qrcallbox.session";   // local: { refreshToken, uid, email }
const KEY_ID      = "qrcallbox.idToken";   // session: { token, exp }
const TIMEOUT_MS  = 20_000;

export class ApiError extends Error {
  constructor(errorClass, message, status = 0) {
    super(message);
    this.errorClass = errorClass;
    this.status = status;
  }
}

async function request(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    const text = await resp.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { ok: resp.ok, status: resp.status, body };
  } catch (err) {
    if (err?.name === "AbortError") throw new ApiError("TIMEOUT", "No answer in time.");
    throw new ApiError("NETWORK", String(err?.message ?? err));
  } finally {
    clearTimeout(timer);
  }
}

// ── Session ──────────────────────────────────────────────────────────

/** JWT payload, unverified — only used to read our own claims for display. */
export function jwtClaims(token) {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part + "=".repeat((4 - (part.length % 4)) % 4)));
  } catch {
    return {};
  }
}

async function cacheIdToken(token, expiresInSec) {
  const exp = Date.now() + (Number(expiresInSec) || 3600) * 1000;
  await chrome.storage.session.set({ [KEY_ID]: { token, exp } }).catch(() => {});
}

export async function signIn(email, password) {
  const r = await request(SIGN_IN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  if (!r.ok || !r.body?.idToken) {
    const code = String(r.body?.error?.message ?? r.status);
    if (/TOO_MANY_ATTEMPTS|USER_DISABLED/.test(code)) throw new ApiError("LOCKED", code, r.status);
    if (r.status === 400) throw new ApiError("LOGIN", code, r.status);
    throw new ApiError("SERVER", code, r.status);
  }
  await chrome.storage.local.set({
    [KEY_SESSION]: { refreshToken: r.body.refreshToken, uid: r.body.localId, email: r.body.email },
  });
  await cacheIdToken(r.body.idToken, r.body.expiresIn);
  return { uid: r.body.localId, email: r.body.email };
}

export async function signOut() {
  await chrome.storage.local.remove(KEY_SESSION);
  await chrome.storage.session.remove(KEY_ID).catch(() => {});
}

export async function getSession() {
  const got = await chrome.storage.local.get(KEY_SESSION);
  return got[KEY_SESSION] ?? null;
}

/** A valid ID token, refreshed when under a minute is left. */
export async function getIdToken() {
  const session = await getSession();
  if (!session?.refreshToken) throw new ApiError("SIGNED_OUT", "Not signed in.");
  const cached = (await chrome.storage.session.get(KEY_ID).catch(() => ({})))[KEY_ID];
  if (cached?.token && cached.exp - Date.now() > 60_000) return cached.token;

  const r = await request(REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(session.refreshToken)}`,
  });
  if (!r.ok || !r.body?.id_token) {
    // A revoked or disabled account: drop the session so the panel asks again.
    if (r.status === 400 || r.status === 403) await signOut();
    throw new ApiError("SIGNED_OUT", "Sign in again.", r.status);
  }
  if (r.body.refresh_token && r.body.refresh_token !== session.refreshToken) {
    await chrome.storage.local.set({ [KEY_SESSION]: { ...session, refreshToken: r.body.refresh_token } });
  }
  await cacheIdToken(r.body.id_token, r.body.expires_in);
  return r.body.id_token;
}

// ── Firestore REST ───────────────────────────────────────────────────

export function decodeValue(v) {
  if (!v || typeof v !== "object") return null;
  if ("stringValue" in v)    return v.stringValue;
  if ("integerValue" in v)   return Number(v.integerValue);
  if ("doubleValue" in v)    return v.doubleValue;
  if ("booleanValue" in v)   return v.booleanValue;
  if ("timestampValue" in v) return Date.parse(v.timestampValue);
  if ("nullValue" in v)      return null;
  if ("mapValue" in v)       return decodeFields(v.mapValue.fields ?? {});
  if ("arrayValue" in v)     return (v.arrayValue.values ?? []).map(decodeValue);
  if ("referenceValue" in v) return v.referenceValue;
  return null;
}

export function decodeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields ?? {})) out[k] = decodeValue(v);
  return out;
}

function fsError(r) {
  const msg = String(r.body?.error?.message ?? r.body?.[0]?.error?.message ?? r.status);
  if (r.status === 401) return new ApiError("SIGNED_OUT", msg, r.status);
  if (r.status === 403) return new ApiError("FORBIDDEN", msg, r.status);
  if (r.status === 400 && /index/i.test(msg)) return new ApiError("INDEX", msg, r.status);
  return new ApiError("SERVER", msg, r.status);
}

export async function fsGet(path) {
  const token = await getIdToken();
  const r = await request(`${FS}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw fsError(r);
  return { id: r.body.name.split("/").pop(), ...decodeFields(r.body.fields) };
}

export async function fsQuery(structuredQuery) {
  const token = await getIdToken();
  const r = await request(`${FS}:runQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery }),
  });
  if (!r.ok || !Array.isArray(r.body)) throw fsError(r);
  return r.body
    .filter((x) => x.document)
    .map((x) => ({ id: x.document.name.split("/").pop(), ...decodeFields(x.document.fields) }));
}

// ── qrcallbox.com /api ───────────────────────────────────────────────

export async function callApi(path, { method = "GET", body, headers = {} } = {}) {
  const token = await getIdToken();
  const r = await request(`${SITE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const msg = String(r.body?.error ?? r.body ?? r.status).slice(0, 300);
    if (r.status === 401) throw new ApiError("SIGNED_OUT", msg, r.status);
    if (r.status === 403) throw new ApiError("FORBIDDEN", msg, r.status);
    throw new ApiError("SERVER", msg, r.status);
  }
  return r.body;
}

/** POST /api/mint — same call GenerateQR.jsx makes. Returns { token }. */
export async function mintPoster({ store, area, areaDescription }) {
  const body = { store: String(store), area };
  if (areaDescription) body.areaDescription = areaDescription;
  const data = await callApi("/api/mint", { method: "POST", body, headers: { "X-API-Key": MINT_API_KEY } });
  if (!data?.token) throw new ApiError("SERVER", data?.error || "Mint failed");
  return data;
}

export const scanUrl = (token) => `${SITE}/s?t=${encodeURIComponent(token)}`;
