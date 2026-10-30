// modules/workvivo/lib/qrcallbox.js
//
// HTTP client for the QRCallBox token-heartbeat endpoint.
//
// Contract (mirrored in QRCallBox repo: functions/src/http/workvivo/token-heartbeat.js):
//   POST <endpointUrl>
//   Headers:
//     Content-Type: application/json
//     X-API-Key: <user's heartbeat API key from QRCallBox UI>
//   Body:
//     { accessToken, workvivoUserId, appId, timeZone, installationId, source: "apai-suite" }
//   200 OK:
//     { ok: true, storeNumber, channelName, channelUrl, channels: [{url,name}],
//       health: { status, lastServerPostAtMs, tokenAgeMs, pushLinked, ... }, validatedAt }
//   401: bad/missing API key
//   400: missing accessToken / workvivoUserId
//   (a token Sendbird rejects is still stored; the server answers 200 with
//    health.status "validation_warn" and the scan bridge is the real test)
//   5xx: server error — caller retries on next alarm tick
//
// No retry inside this client — the heartbeat alarm fires hourly, so a single
// failure self-heals on the next tick. Adding retry here would mask real
// outages and double-bill Sendbird's validation rate limit.

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * POST a fresh Workvivo/Sendbird token bundle to the QRCallBox endpoint.
 *
 * @param {object} args
 * @param {string} args.endpointUrl   Fully-qualified URL of the heartbeat function
 * @param {string} args.apiKey        User's heartbeat API key
 * @param {string} args.accessToken   Sendbird access_token from window.v2.chatConfig
 * @param {string} args.workvivoUserId  Numeric user id (window.v2.id, stringified)
 * @param {string|null} args.appId    Sendbird app id (or null — server falls back to constant)
 * @param {string|null} [args.installationId]  shell.installationId, so the server can
 *                                   Web-Push a "refresh now" to this browser
 *
 * @returns {Promise<{ok:boolean, status:number, body:object|string,
 *                    errorClass?: "AUTH"|"VALIDATION"|"SERVER"|"NETWORK"|"TIMEOUT"}>}
 */
export async function postHeartbeat({
  endpointUrl,
  apiKey,
  accessToken,
  workvivoUserId,
  appId,
  installationId = null,
}) {
  if (!endpointUrl) {
    return { ok: false, status: 0, body: "missing endpoint URL", errorClass: "AUTH" };
  }
  if (!apiKey) {
    return { ok: false, status: 0, body: "missing API key", errorClass: "AUTH" };
  }
  if (!accessToken || !workvivoUserId) {
    return { ok: false, status: 0, body: "missing accessToken or workvivoUserId", errorClass: "VALIDATION" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const resp = await fetch(endpointUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({
        accessToken,
        workvivoUserId,
        appId: appId ?? null,
        // Browser's IANA TZ name — used server-side to format the scan
        // post's local time in the store's actual zone instead of always
        // CT. Read from the SW's Intl runtime, which reflects the user's
        // OS clock. Safe to send: it's not PII.
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        installationId: installationId || null,
        // Ask for the channel list (kept out of the response by default so
        // older clients' sync-storage writes stay under quota).
        wantChannels: true,
        source: "apai-suite",
      }),
    });

    const text = await resp.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }

    if (resp.ok) {
      return { ok: true, status: resp.status, body };
    }
    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, status: resp.status, body, errorClass: "AUTH" };
    }
    if (resp.status === 422 || resp.status === 400) {
      return { ok: false, status: resp.status, body, errorClass: "VALIDATION" };
    }
    return { ok: false, status: resp.status, body, errorClass: "SERVER" };
  } catch (err) {
    if (err?.name === "AbortError") {
      return { ok: false, status: 0, body: `timeout after ${DEFAULT_TIMEOUT_MS}ms`, errorClass: "TIMEOUT" };
    }
    return { ok: false, status: 0, body: String(err?.message ?? err), errorClass: "NETWORK" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Derive a sibling endpoint URL from the heartbeat endpoint URL. Every
 * extension-facing endpoint lives under /api/workvivo/, so an override the
 * user set for the heartbeat path (dev/staging host) carries to all of them
 * — one setting, not one per endpoint.
 */
function deriveSiblingUrl(heartbeatUrl, name) {
  return heartbeatUrl.replace(/\/api\/workvivo\/[^/]+$/, `/api/workvivo/${name}`);
}

function deriveConnectionInfoUrl(heartbeatUrl) {
  return deriveSiblingUrl(heartbeatUrl, "connection-info");
}

/**
 * Ask the QRCallBox SERVER to post a chat message, so the server-side Sendbird
 * path can be tested without waiting for a real customer scan.
 *
 * This is not the extension posting. It hands nothing but the API key to the
 * server, which opens its own Sendbird WebSocket with the access token this
 * module couriered to it earlier. That distinction is the whole point of the
 * test — a message that arrives proves the server can post on its own, which
 * is what actually happens at 3am when nobody's browser is open.
 *
 * Defaults to the caller's own Workvivo self-DM, server-side. Posting to the
 * real store channel needs `{ target: "store", confirm: true }`, which this
 * function deliberately does not expose — there is no UI reason to let a test
 * land in front of a store.
 *
 * @param {object} args
 * @param {string} args.endpointUrl  Heartbeat endpoint URL (the test path is derived).
 * @param {string} args.apiKey
 * @param {string} [args.note]       Free text appended to the posted message.
 *
 * @returns {Promise<{ok:boolean, status:number, body:object|string,
 *                    errorClass?: "AUTH"|"TOKEN_STALE"|"NOT_FOUND"|"SERVER"|"NETWORK"|"TIMEOUT"}>}
 */
export async function postServerTest({ endpointUrl, apiKey, note }) {
  if (!endpointUrl || !apiKey) {
    return { ok: false, status: 0, body: "missing endpoint or api key", errorClass: "AUTH" };
  }
  const url = deriveSiblingUrl(endpointUrl, "test-post");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({ note: note || "sent from the APAISuite Workvivo panel" }),
    });
    const text = await resp.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }

    if (resp.ok) return { ok: true, status: resp.status, body };

    // A 401 from this endpoint is ambiguous on its face and the two cases have
    // completely different fixes: a bad API key is a config problem, a rejected
    // access token means the courier needs to run again. The server says which
    // in its error text; surface that as distinct classes so view.js can give
    // the right instruction instead of a shrug.
    if (resp.status === 401) {
      const msg = String(body?.error ?? body ?? "");
      return {
        ok: false, status: 401, body,
        errorClass: /api key/i.test(msg) && !/access token/i.test(msg) ? "AUTH" : "TOKEN_STALE",
      };
    }
    if (resp.status === 404) return { ok: false, status: 404, body, errorClass: "NOT_FOUND" };
    return { ok: false, status: resp.status, body, errorClass: "SERVER" };
  } catch (err) {
    if (err?.name === "AbortError") {
      return { ok: false, status: 0, body: `timeout after ${DEFAULT_TIMEOUT_MS}ms`, errorClass: "TIMEOUT" };
    }
    return { ok: false, status: 0, body: String(err?.message ?? err), errorClass: "NETWORK" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET the "Your QRCallBox" panel data for the holder of this API key.
 * Mirrors postHeartbeat's error-classing so view.js handles failure modes
 * uniformly.
 *
 * @param {object} args
 * @param {string} args.endpointUrl  Heartbeat endpoint URL (used to derive
 *                                   the connection-info path automatically).
 * @param {string} args.apiKey       Same X-API-Key as the heartbeat uses.
 *
 * @returns {Promise<{ok:boolean, status:number, body:object|string,
 *                    errorClass?: "AUTH"|"NOT_FOUND"|"SERVER"|"NETWORK"|"TIMEOUT"}>}
 */
export async function fetchConnectionInfo({ endpointUrl, apiKey }) {
  if (!endpointUrl || !apiKey) {
    return { ok: false, status: 0, body: "missing endpoint or api key", errorClass: "AUTH" };
  }
  const url = deriveConnectionInfoUrl(endpointUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { "X-API-Key": apiKey },
    });
    const text = await resp.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }

    if (resp.ok) return { ok: true, status: resp.status, body };
    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, status: resp.status, body, errorClass: "AUTH" };
    }
    if (resp.status === 404) {
      return { ok: false, status: resp.status, body, errorClass: "NOT_FOUND" };
    }
    return { ok: false, status: resp.status, body, errorClass: "SERVER" };
  } catch (err) {
    if (err?.name === "AbortError") {
      return { ok: false, status: 0, body: `timeout after ${DEFAULT_TIMEOUT_MS}ms`, errorClass: "TIMEOUT" };
    }
    return { ok: false, status: 0, body: String(err?.message ?? err), errorClass: "NETWORK" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Save which Workvivo channel the server posts scans into. The server
 * verifies the url against a live channel list, so only a channel the user
 * belongs to can be chosen.
 *
 * @returns {Promise<{ok:boolean, status:number, body:object|string,
 *                    errorClass?: "AUTH"|"TOKEN_STALE"|"NOT_FOUND"|"VALIDATION"|"SERVER"|"NETWORK"|"TIMEOUT"}>}
 */
export async function postSetChannel({ endpointUrl, apiKey, channelUrl }) {
  if (!endpointUrl || !apiKey) {
    return { ok: false, status: 0, body: "missing endpoint or api key", errorClass: "AUTH" };
  }
  const url = deriveSiblingUrl(endpointUrl, "set-channel");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ channelUrl }),
    });
    const text = await resp.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    if (resp.ok) return { ok: true, status: resp.status, body };
    if (resp.status === 401) {
      const msg = String(body?.error ?? body ?? "");
      return { ok: false, status: 401, body, errorClass: /api key/i.test(msg) ? "AUTH" : "TOKEN_STALE" };
    }
    if (resp.status === 404) return { ok: false, status: 404, body, errorClass: "NOT_FOUND" };
    if (resp.status === 400) return { ok: false, status: 400, body, errorClass: "VALIDATION" };
    return { ok: false, status: resp.status, body, errorClass: "SERVER" };
  } catch (err) {
    if (err?.name === "AbortError") {
      return { ok: false, status: 0, body: `timeout after ${DEFAULT_TIMEOUT_MS}ms`, errorClass: "TIMEOUT" };
    }
    return { ok: false, status: 0, body: String(err?.message ?? err), errorClass: "NETWORK" };
  } finally {
    clearTimeout(timer);
  }
}

// QRCallBox (qrwebaccdb) public web API key. Not a secret — it ships in the
// qrcallbox.com bundle (QRCallBox/src/firebaseClient.js) and only identifies
// the project to Firebase Auth. Must change if that key is ever rotated.
const QRCALLBOX_WEB_API_KEY = "AIzaSyCbpXuSt3UHAWtAfiKbVx621vwpL5cKnkA";
const SIGN_IN_URL =
  `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${QRCALLBOX_WEB_API_KEY}`;

/**
 * Sign in to QRCallBox with the user's email + password and mint a Workvivo
 * API key, so the panel can do in one step what used to need the
 * qrcallbox.com Settings page. Same server path that page uses:
 * POST /api/workvivo/generate-api-key with a Firebase ID token
 * (QRCallBox: functions/src/http/workvivo/generate-api-key.js).
 *
 * The password and ID token are used for these two requests only and never
 * stored; the caller keeps the returned apiKey (shown once by the server).
 *
 * @returns {Promise<{ok:boolean, status:number, body:object|string, apiKey?:string,
 *                    errorClass?: "LOGIN"|"LOCKED"|"AUTH"|"SERVER"|"NETWORK"|"TIMEOUT"}>}
 */
export async function generateApiKey({ endpointUrl, email, password, label }) {
  if (!endpointUrl) return { ok: false, status: 0, body: "missing endpoint URL", errorClass: "AUTH" };
  if (!email || !password) return { ok: false, status: 0, body: "missing email or password", errorClass: "LOGIN" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const signIn = await fetch(SIGN_IN_URL, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
    const signBody = await signIn.json().catch(() => ({}));
    if (!signIn.ok || !signBody.idToken) {
      // Firebase answers 400 with error.message such as INVALID_LOGIN_CREDENTIALS,
      // EMAIL_NOT_FOUND, INVALID_PASSWORD, USER_DISABLED, TOO_MANY_ATTEMPTS_TRY_LATER.
      const code = String(signBody?.error?.message ?? signIn.status);
      const errorClass = /TOO_MANY_ATTEMPTS|USER_DISABLED/.test(code) ? "LOCKED"
        : signIn.status === 400 ? "LOGIN" : "SERVER";
      return { ok: false, status: signIn.status, body: code, errorClass };
    }

    const resp = await fetch(deriveSiblingUrl(endpointUrl, "generate-api-key"), {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${signBody.idToken}` },
      body: JSON.stringify({ label }),
    });
    const text = await resp.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    if (resp.ok && body?.apiKey) return { ok: true, status: resp.status, body, apiKey: body.apiKey };
    if (resp.status === 401) return { ok: false, status: 401, body, errorClass: "AUTH" };
    return { ok: false, status: resp.status, body, errorClass: "SERVER" };
  } catch (err) {
    if (err?.name === "AbortError") {
      return { ok: false, status: 0, body: `timeout after ${DEFAULT_TIMEOUT_MS}ms`, errorClass: "TIMEOUT" };
    }
    return { ok: false, status: 0, body: String(err?.message ?? err), errorClass: "NETWORK" };
  } finally {
    clearTimeout(timer);
  }
}
