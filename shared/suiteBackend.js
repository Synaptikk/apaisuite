// shared/suiteBackend.js
//
// The suite's own Firestore client: anonymous auth against the `apaisuite`
// project and one append-only write primitive against its (default) database.
//
// WHY THIS FILE EXISTS. Suite-wide telemetry used to write through
// `modules/aurorbuddy/lib/firestore.js`, which is hardcoded to the
// `aurorbuddy` project. But the rules governing these collections live in
// `backend/firestore.suite.rules`, which `firebase.json` deploys to
// `apaisuite`. Rules in one project, client in another: every write came back
// 403 PERMISSION_DENIED, silently, for as long as that arrangement stood. The
// queue in each writer absorbed the failures and retried them forever, so the
// only outward sign was a repeating 403 in the console.
//
// It also un-inverts the layering. `shared/` importing a primitive out of
// `modules/aurorbuddy/` meant suite-wide telemetry could not work unless that
// one module's Firestore client was present and healthy.
//
// SCOPE. This talks to the (default) database only, which by the rules holds
// suite-wide telemetry and nothing else. A module that needs its own backend
// gets its own NAMED database in the same project and its own client — see
// `backend/README.md` and `modules/digitalmetrics/lib/config.js` for that
// shape. Do not add module collections here.
//
// REST-only, no Firebase JS SDK: the SDK assumes long-lived WebSocket and
// IndexedDB state that an MV3 service worker cannot hold across its 30s
// idle-sleep. Same rationale as every other Firestore client in the suite.

// Public web API key. Not a secret — it identifies the project to Google's
// REST endpoints and ships in every Firebase client. Access is enforced
// server-side by backend/firestore.suite.rules.
//
// `modules/digitalmetrics/lib/config.js` holds the same key for the same
// project. That duplication is deliberate: the module contract keeps modules
// self-contained (that file calls itself "the ONLY place a backend identity is
// named" for that module), and a module reaching into shared/ for its identity
// is the same inversion this file exists to remove. If the key is ever
// rotated, both must change.
const PROJECT_ID = "apaisuite";
const API_KEY    = "AIzaSyAxRJ7qjWqm9XgGtNHr1hUyW8IJgcndj_s";

const IDENTITY_BASE  = "https://identitytoolkit.googleapis.com/v1";
const SECURETOKEN    = "https://securetoken.googleapis.com/v1/token";
const FIRESTORE_BASE =
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// idToken is session-scoped (dies with the browser, which is correct — it
// expires in an hour anyway). refreshToken is local so an install keeps ONE
// anonymous user instead of minting a fresh one every time the worker wakes
// with a cold session; those accumulate in the project forever.
const SESSION_KEYS = { idToken: "suite.fb_idToken", idTokenAt: "suite.fb_idTokenAt" };
const LOCAL_KEYS   = { refreshToken: "suite.fb_refreshToken" };

// Firebase ID tokens last 60 minutes; refresh at 55 so a write that starts
// just under the wire still has a valid token when it lands.
const ID_TOKEN_TTL_MS = 55 * 60 * 1000;

// ─── Auth ─────────────────────────────────────────────────────────────────

async function signUpAnonymous() {
  const res = await fetch(`${IDENTITY_BASE}/accounts:signUp?key=${API_KEY}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ returnSecureToken: true }),
  });
  if (!res.ok) {
    // The most likely cause by far is Anonymous auth not being enabled on the
    // project (Authentication → Sign-in method), which is a manual console
    // step the CLI cannot do — see backend/README.md.
    throw new Error(`suiteBackend: anonymous sign-in failed (${res.status}) — is Anonymous auth enabled on ${PROJECT_ID}?`);
  }
  const data = await res.json();
  await chrome.storage.local.set({ [LOCAL_KEYS.refreshToken]: data.refreshToken });
  await chrome.storage.session.set({
    [SESSION_KEYS.idToken]:   data.idToken,
    [SESSION_KEYS.idTokenAt]: Date.now(),
  });
  return data.idToken;
}

async function refreshIdToken(refreshToken) {
  const res = await fetch(`${SECURETOKEN}?key=${API_KEY}`, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  if (!res.ok) throw new Error(`suiteBackend: token refresh failed (${res.status})`);
  const data = await res.json();
  await chrome.storage.local.set({ [LOCAL_KEYS.refreshToken]: data.refresh_token });
  await chrome.storage.session.set({
    [SESSION_KEYS.idToken]:   data.id_token,
    [SESSION_KEYS.idTokenAt]: Date.now(),
  });
  return data.id_token;
}

async function getIdToken() {
  const ses = await chrome.storage.session.get([SESSION_KEYS.idToken, SESSION_KEYS.idTokenAt]);
  if (ses[SESSION_KEYS.idToken] && (Date.now() - (ses[SESSION_KEYS.idTokenAt] || 0)) < ID_TOKEN_TTL_MS) {
    return ses[SESSION_KEYS.idToken];
  }
  const loc = await chrome.storage.local.get(LOCAL_KEYS.refreshToken);
  if (loc[LOCAL_KEYS.refreshToken]) {
    try {
      return await refreshIdToken(loc[LOCAL_KEYS.refreshToken]);
    } catch {
      // A revoked or corrupt refresh token is unrecoverable; drop it and start
      // a new anonymous user rather than wedging telemetry permanently.
      await chrome.storage.local.remove(LOCAL_KEYS.refreshToken);
    }
  }
  return await signUpAnonymous();
}

// ─── Typed-field encoder (the Firestore REST verbosity tax) ───────────────

function toFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean")        return { booleanValue: v };
  if (typeof v === "number") {
    if (!Number.isFinite(v))         return { nullValue: null };
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v))              return { arrayValue: { values: v.map(toFirestoreValue) } };
  if (typeof v === "object")         return { mapValue: { fields: toFirestoreFields(v) } };
  return { stringValue: String(v) };
}

/** Plain object → Firestore REST `fields`. Undefined values are dropped. */
export function toFirestoreFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = toFirestoreValue(v);
  }
  return out;
}

// ─── Write primitive ──────────────────────────────────────────────────────

/**
 * Create one document with a server-stamped timestamp field.
 *
 * Takes a PLAIN object — encoding happens in here. Callers must not pre-encode
 * with `toFirestoreFields`; doing so double-wraps every value into a nested
 * map, which Firestore accepts and stores as structurally wrong data rather
 * than rejecting.
 *
 * `currentDocument: { exists: false }` makes this create-only at the API
 * level, matching the append-only rules. A caller whose doc id is a
 * deterministic fingerprint (schema drift does this, so N installs reporting
 * the same drift converge on one row) will therefore see the second write
 * fail — that is the intended behaviour, not an error to retry.
 *
 * @param {string} collection
 * @param {string} docId
 * @param {object} fields         Plain JS object.
 * @param {string} timestampField Field set to the server's REQUEST_TIME.
 */
export async function commitCreateWithServerTimestamp(collection, docId, fields, timestampField) {
  const idToken = await getIdToken();
  const docName = `projects/${PROJECT_ID}/databases/(default)/documents/${collection}/${docId}`;
  const body = {
    writes: [{
      update: { name: docName, fields: toFirestoreFields(fields) },
      currentDocument: { exists: false },
      updateTransforms: [{ fieldPath: timestampField, setToServerValue: "REQUEST_TIME" }],
    }],
  };

  const res = await fetch(`${FIRESTORE_BASE}:commit`, {
    method:  "POST",
    headers: { "Authorization": `Bearer ${idToken}`, "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    // Surface the body. A bare 403 cannot distinguish "rules deny this shape"
    // from "rules were never deployed to this project" — which is exactly the
    // ambiguity that let the original bug sit unread in the console.
    let preview = "";
    try { preview = (await res.text()).slice(0, 240); } catch { /* empty body */ }
    throw new Error(`suiteBackend: commit failed (${res.status})${preview ? " — " + preview : ""}`);
  }
  return await res.json();
}

export const _internals = { PROJECT_ID, FIRESTORE_BASE, SESSION_KEYS, LOCAL_KEYS, toFirestoreValue };
