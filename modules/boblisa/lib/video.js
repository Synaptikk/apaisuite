// modules/boblisa/lib/video.js
//
// APPRISS CCTV link for a register at a moment, with no transaction id.
// The viewer (/walmart-usa/video/react#/cameras) accepts either
// ?transactionId=<id> or ?storeNo=&posNo=&startTime=&endTime= (ISO local
// store time, no zone). Verified 2026-09-14 on store 1458 / register 25:
// the server pads the window 30 s before and 120 s after, then plays.
// An EJ receipt's timestamp is when the transaction ENDED, so the window
// starts two minutes earlier to cover the scanning.
//
// Pure — no chrome.*, safe in the shell and node.

import { APPRISS_BASE, APPRISS_HOME, APPRISS_WMLINK, isApprissSignInUrl } from "../../../shared/appriss.js";

export const BEFORE_SEC = 120;
export const AFTER_SEC = 15;

function shift(dateIso, hms, deltaSec) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateIso || ""));
  const t = /^(\d{2}):(\d{2}):(\d{2})/.exec(String(hms || ""));
  if (!m || !t) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +t[1], +t[2], +t[3]) + deltaSec * 1000);
  return d.toISOString().slice(0, 19);   // treated as store-local by the viewer
}

/** @returns {string|null} viewer URL, or null when the inputs are unusable */
export function videoUrl(storeNbr, register, dateIso, hms, { beforeSec = BEFORE_SEC, afterSec = AFTER_SEC } = {}) {
  const start = shift(dateIso, hms, -beforeSec), end = shift(dateIso, hms, afterSec);
  if (!start || !end || !storeNbr || register == null) return null;
  const q = new URLSearchParams({ storeNo: String(storeNbr), posNo: String(register), startTime: start, endTime: end });
  return `${APPRISS_BASE}/video/react#/cameras?${q}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Does the viewer actually answer for this register?  (2026-09-27)
// ─────────────────────────────────────────────────────────────────────────────
//
// A ▶ Video link used to be a plain anchor, and on a cold Secure session the
// CCTV app 302s the request to its OWN origin —
// `web-prd-wus2-arp-cctv.azurewebsites.net/walmart-usa/video/login` — which is
// blocked from the corp network and answers
//
//     Error 403 - Forbidden
//     The web app you have attempted to reach has blocked your access.
//
// So a signed-out click looked like a missing CCTV entitlement, in a tab with
// no way to sign in. Verified 2026-09-27 that the analyst's own account plays
// store 1458 / register 25 fine the moment the platform session exists: it was
// never a permissions problem.
//
// `getcameras` is the cheap, honest probe — same app, same cookie, JSON when
// the session is live. Two behaviours worth keeping in mind:
//   · `redirect: "follow"` is REQUIRED. With the platform session alive the
//     CCTV app's own login round-trip completes by itself and the JSON comes
//     back (verified by deleting only `.AspNetCore.Cookies`), so
//     `redirect: "manual"` would read a self-healing call as signed out.
//   · A response that is not JSON, or lands on a sign-in/azurewebsites URL, is
//     the sign-in page — the session is gone, not the entitlement.
//   · A 401/403 served by `apps.apprissretail.com` itself IS the entitlement:
//     that one needs an access request, not a reauth, so it must not make the
//     auth gate burn an SSO tab (no `loginUrl` on it — see
//     `shared/appriss.js::isApprissAuthFailure`).

export const CCTV_BLOCKED_HOST = "azurewebsites.net";

export function camerasUrl(storeNbr, register) {
  if (!storeNbr || register == null) return null;
  const q = new URLSearchParams({ storeNo: String(storeNbr), posNo: String(register) });
  return `${APPRISS_BASE}/video/api/Camera/getcameras?${q}`;
}

/**
 * @returns {Promise<{ok:true, cameras:Array<{cameraId:string,name:string}>}
 *   |{ok:false, errorClass:"AUTH"|"AUTH_OR_HTTP"|"FORBIDDEN"|"HTTP"|"NO_CAMERA",
 *      error:string, loginUrl?:string, accessUrl?:string}>}
 */
export async function probeCameras(storeNbr, register, { fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const url = camerasUrl(storeNbr, register);
  if (!url) return { ok: false, errorClass: "HTTP", error: "No store number or register." };
  const signedOut = {
    ok: false, errorClass: "AUTH", loginUrl: APPRISS_HOME,
    error: `Secure is signed out, so the CCTV viewer would just show "Error 403 - Forbidden". Sign in at ${APPRISS_WMLINK} and click ▶ Video again.`,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let r;
  try {
    r = await fetchImpl(url, {
      credentials: "include", redirect: "follow", signal: ctrl.signal,
      headers: { accept: "application/json, text/plain, */*" },
    });
  } catch (e) {
    // The CCTV app's own origin (`web-prd-wus2-arp-cctv.azurewebsites.net`) is
    // in `manifest.json::host_permissions` for one reason only: this call's
    // redirect passes through it. Without it the service worker cannot follow
    // the app's login round-trip and every cold click failed here with
    // "Failed to fetch" even after the reauth worked (measured 2026-09-27).
    // A throw that survives that is reported as AUTH_OR_HTTP so the gate still
    // gets its one reauth attempt, and a genuinely offline browser fails right
    // after it instead of hanging.
    return {
      ok: false, errorClass: "AUTH_OR_HTTP", loginUrl: APPRISS_HOME,
      error: `Secure did not answer for the CCTV camera list (${e?.name === "AbortError" ? "timed out" : e?.message || e}) — usually a signed-out session, because the redirect it sends leaves our origin. Sign in at ${APPRISS_WMLINK} and click ▶ Video again.`,
    };
  } finally {
    clearTimeout(timer);
  }
  const landed = String(r.url || "");
  if (isApprissSignInUrl(landed) || landed.includes(CCTV_BLOCKED_HOST)) return signedOut;
  if (r.status === 401) return signedOut;
  if (r.status === 403) {
    return {
      ok: false, errorClass: "FORBIDDEN", accessUrl: APPRISS_WMLINK,
      error: `Secure answered 403 for its own camera list: this account is signed in but not entitled to CCTV. Request Secure Store video access through ${APPRISS_WMLINK}.`,
    };
  }
  if (r.status === 400) {
    // A register with no camera mapped to it is a 400 text/plain
    // "No cameras found for the store 1458, POS 47." — not an empty array
    // (verified 2026-09-27 on store 1458: lanes 25/30, Money Center 63 and
    // office 9999 answer 200; 47 and 99 answer this). A malformed posNo answers
    // 400 application/problem+json instead, which is a bug in the caller.
    const raw = (await r.text().catch(() => "")).trim();
    if (/no cameras? found/i.test(raw)) {
      return { ok: false, errorClass: "NO_CAMERA", error: `Secure says: ${raw.replace(/\.$/, "")} — the viewer would open empty.` };
    }
    return { ok: false, errorClass: "HTTP", error: `Secure rejected the camera list request (400)${raw ? `: ${raw.slice(0, 140)}` : "."}` };
  }
  if (!r.ok) return { ok: false, errorClass: "HTTP", error: `Secure camera list HTTP ${r.status}.` };
  let body;
  try { body = await r.json(); }
  catch { return signedOut; }              // HTML where JSON belongs = the sign-in page
  if (!Array.isArray(body)) return signedOut;
  if (!body.length) {
    return {
      ok: false, errorClass: "NO_CAMERA",
      error: `Secure has no camera mapped to register ${register} at store ${storeNbr}, so the viewer will open empty.`,
    };
  }
  return { ok: true, cameras: body.map((c) => ({ cameraId: String(c?.cameraId || ""), name: String(c?.name || c?.description || "") })) };
}
