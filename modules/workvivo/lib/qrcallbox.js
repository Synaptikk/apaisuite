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
//     { accessToken, workvivoUserId, appId, source: "apai-suite" }
//   200 OK:
//     { ok: true, storeNumber, channelName, validatedAt }
//   401: bad/missing API key
//   422: token validation against Sendbird failed (returned token was no good)
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
