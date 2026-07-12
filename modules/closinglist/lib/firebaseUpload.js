// modules/closinglist/lib/firebaseUpload.js
//
// Uploads the parsed associate list to the Closing Manager Checklist
// Firestore project ("managerchecklist") so the webapp on any device — for
// the same store-date — picks it up live via onSnapshot.
//
// Design notes:
//   - No Firebase SDK bundle. Pure fetch + REST so the extension stays light.
//   - Anonymous auth. ID token cached in chrome.storage.local + refreshed when
//     it nears expiry. Refresh token also cached so we don't sign up new
//     anonymous identities on every reload.
//   - Hardcoded to store 1458 — security rules in the webapp reject anything
//     else, and the extension shouldn't write data it can't observe.
//   - Idempotent / bandwidth-aware: PATCH only if the associate fingerprint
//     changed since the last successful push. Fingerprint = sha-256 of the
//     normalized associate JSON, stored alongside the cached token.

// Firebase Web API key for project "managerchecklist". This is a public
// identifier, not a secret — Firebase security rules enforce auth + path.
const FB_API_KEY        = "AIzaSyAcPgKnHNBJJYkI4OVJASzHUwaKj2qCxdU";
const FB_PROJECT_ID     = "managerchecklist";
const FB_FIXED_STORE    = "1458";

const TOKEN_KEY         = "closinglist.fbToken";        // { idToken, refreshToken, expiresAt, localId }
const FINGERPRINT_KEY   = "closinglist.fbFingerprint";  // { sessionId, hash, at }

// ---------------- public API ----------------

// model: APAISuite parse.build() output
//   { associates: [{ name, start, end, jobLabel, calledOff }], businessDate, ... }
// opts:  { storeNbr (string), businessDate ("YYYY-MM-DD"), uploadedBy ("extension") }
//
// Resolves to { ok: true, skipped?: true, sessionId } or { ok: false, error }.
// Never throws — UI calls this in a fire-and-forget pattern.
export async function uploadAssociatesToFirestore(model, opts) {
  try {
    if (!FB_API_KEY || FB_API_KEY === "PASTE_FIREBASE_API_KEY_HERE") {
      return { ok: false, error: "Firebase API key not configured in firebaseUpload.js" };
    }
    const storeNbr = String(opts.storeNbr || FB_FIXED_STORE);
    if (storeNbr !== FB_FIXED_STORE) {
      return { ok: false, error: `Upload only enabled for store ${FB_FIXED_STORE} (got ${storeNbr}).` };
    }
    const businessDate = opts.businessDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate || "")) {
      return { ok: false, error: `Invalid businessDate "${businessDate}", expected YYYY-MM-DD` };
    }
    const sessionId = `${storeNbr}-${businessDate}`;

    // Normalize the associates payload the webapp expects.
    const associates = (model.associates || []).map((a, i) => ({
      id:             `ext-${i}-${slug(a.name)}`,
      name:           String(a.name || ""),
      shift:          formatShiftRange(a.start, a.end),
      area:           String(a.jobLabel || ""),
      accomplishment: "",
      notes:          a.calledOff ? formatCalledOffNote(a.calledOff) : "",
      manager:        "",
    }));

    // Bandwidth-aware: skip the write if associate set hasn't changed since
    // the last successful push for this same session.
    const hash = await sha256Hex(JSON.stringify(associates));
    const fpStored = await getCached(FINGERPRINT_KEY);
    if (fpStored && fpStored.sessionId === sessionId && fpStored.hash === hash) {
      return { ok: true, skipped: true, sessionId };
    }

    const token = await ensureIdToken();

    // PATCH with updateMask so we only touch these specific fields. Anything
    // else in the doc (tasks, manager names, etc.) stays untouched.
    const fieldsToWrite = {
      storeNumber:     fbValue(storeNbr),
      storeNbr:        fbValue(storeNbr),
      date:            fbValue(businessDate),
      associates:      fbValue(associates),
      extensionUpdatedAt: fbValue(new Date().toISOString()),
      extensionUpdatedBy: fbValue(opts.uploadedBy || "extension"),
    };
    const updateMaskParams = Object.keys(fieldsToWrite)
      .map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
      .join("&");

    const url =
      `https://firestore.googleapis.com/v1/projects/${FB_PROJECT_ID}` +
      `/databases/(default)/documents/sessions/${encodeURIComponent(sessionId)}` +
      `?${updateMaskParams}&currentDocument.exists=false`;

    // Try create first (exists:false). If doc already exists, retry without
    // the exists guard (a normal merge update).
    let res = await fetch(url, {
      method:  "PATCH",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body:    JSON.stringify({ fields: fieldsToWrite }),
    });
    if (res.status === 409 || res.status === 412) {
      const updateUrl =
        `https://firestore.googleapis.com/v1/projects/${FB_PROJECT_ID}` +
        `/databases/(default)/documents/sessions/${encodeURIComponent(sessionId)}` +
        `?${updateMaskParams}`;
      res = await fetch(updateUrl, {
        method:  "PATCH",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body:    JSON.stringify({ fields: fieldsToWrite }),
      });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `Firestore PATCH ${res.status}: ${text.slice(0, 200)}` };
    }

    await setCached(FINGERPRINT_KEY, { sessionId, hash, at: Date.now() });
    return { ok: true, sessionId };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// ---------------- auth ----------------

async function ensureIdToken() {
  const cached = await getCached(TOKEN_KEY);
  const now = Date.now();
  if (cached && cached.idToken && cached.expiresAt && cached.expiresAt - now > 60_000) {
    return cached.idToken;
  }
  if (cached && cached.refreshToken) {
    try {
      return await refreshIdToken(cached.refreshToken);
    } catch (e) {
      console.warn("[closinglist firebase] token refresh failed, re-signing in anonymously", e);
    }
  }
  return await signInAnonymously();
}

async function signInAnonymously() {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FB_API_KEY}`;
  const res = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ returnSecureToken: true }),
  });
  if (!res.ok) throw new Error(`signInAnonymously ${res.status}: ${await res.text()}`);
  const j = await res.json();
  await setCached(TOKEN_KEY, {
    idToken:      j.idToken,
    refreshToken: j.refreshToken,
    expiresAt:    Date.now() + (Number(j.expiresIn) - 60) * 1000,
    localId:      j.localId,
  });
  return j.idToken;
}

async function refreshIdToken(refreshToken) {
  const url = `https://securetoken.googleapis.com/v1/token?key=${FB_API_KEY}`;
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
  const res = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    body.toString(),
  });
  if (!res.ok) throw new Error(`refreshIdToken ${res.status}: ${await res.text()}`);
  const j = await res.json();
  await setCached(TOKEN_KEY, {
    idToken:      j.id_token,
    refreshToken: j.refresh_token,
    expiresAt:    Date.now() + (Number(j.expires_in) - 60) * 1000,
    localId:      j.user_id,
  });
  return j.id_token;
}

// ---------------- helpers ----------------

function fbValue(v) {
  // Translate JS values into Firestore REST "Value" objects.
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map(fbValue) } };
  }
  if (typeof v === "object") {
    const fields = {};
    for (const [k, val] of Object.entries(v)) fields[k] = fbValue(val);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function slug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "x";
}

function formatShiftRange(start, end) {
  const s = part(start);
  const e = part(end);
  if (!s && !e) return "";
  if (!s || !e) return [s?.label, e?.label].filter(Boolean).join("-");
  if (s.ampm === e.ampm) return `${s.hm}-${e.hm}${e.ampm}`;
  return `${s.hm}${s.ampm}-${e.hm}${e.ampm}`;
}
function part(d) {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return null;
  const h = date.getHours();
  const m = date.getMinutes();
  const ampm = h >= 12 ? "pm" : "am";
  const h12 = h % 12 || 12;
  const minutes = m === 0 ? "" : ":" + String(m).padStart(2, "0");
  return { hm: `${h12}${minutes}`, ampm, label: `${h12}${minutes}${ampm}` };
}
function formatCalledOffNote(co) {
  const reason = co.reason && co.reason !== "None" ? ` (${co.reason})` : "";
  return `CALLED OFF${reason}`;
}

async function sha256Hex(str) {
  const buf = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function getCached(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (r) => resolve(r[key] || null));
  });
}
async function setCached(key, val) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: val }, resolve);
  });
}
