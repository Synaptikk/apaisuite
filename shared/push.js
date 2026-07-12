// shared/push.js
//
// Web Push subscription + delivery for the APAISuite SW.
//
// Architecture
// ────────────
//   Server (QRCallBox)            Extension SW
//   ─────────────────             ────────────
//   web-push.sendNotification → FCM → push event → showNotification + checkForUpdate
//                                     ↑
//   /api/extension/register    ← POST(subscription) on SW boot
//
// VAPID public key is baked in here; the server holds the matching
// private key as Firebase secret VAPID_PRIVATE_KEY. The pair was
// generated 2026-06-01 (see QRCallBox functions:secrets:set log).
// If we ever rotate the keypair we have to deploy a coordinated update
// (server-side at the same time as a forced extension reload), so don't
// rotate unless there's a leak.
//
// Why not Firebase Messaging SDK
// ──────────────────────────────
// FCM JS SDK requires bundling (~50KB minified + a bundler pipeline the
// extension doesn't have). Vanilla Push API + VAPID gives us the same
// FCM endpoint with zero bundling — server uses standard web-push npm
// package, extension uses self.registration.pushManager.subscribe().
//
// Fallback
// ────────
// If push delivery fails (corp firewall blocks fcm.googleapis.com,
// subscription revoked, etc.), the existing 6-hour polling alarm in
// shared/updater.js still runs. Push is an optimization, not a
// requirement — losing it just regresses to the pre-push behaviour.

const VAPID_PUBLIC_KEY = "BOHSfMWhfD-MJmVQYf2mVDKmGPDN_iWZdt-Jt2tJy5sEzCwk_7QVTwQIVfoY5nIyk08P7nI04XlDPoUdVQ0SnrE";

const REGISTER_URL    = "https://qrcallbox.com/api/extension/register";
const INSTALL_ID_KEY  = "shell.installationId";
const LAST_REGISTERED_KEY = "shell.push.lastRegisteredAt";

// Re-register at most every 7 days. Server writes serverTimestamp on
// every POST, and we want a `lastSeen` heartbeat for pruning stale
// subscriptions — but firing once per SW wake is overkill (the SW
// wakes constantly on alarms, messages, etc.).
const REREGISTER_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Get-or-create the persistent installation id. crypto.randomUUID()
 * generated once per profile, stored in chrome.storage.local so it
 * survives SW restarts. NOT chrome.runtime.id (that's per-extension,
 * shared across all installs — wrong granularity).
 */
async function getInstallationId() {
  const got = await chrome.storage.local.get(INSTALL_ID_KEY);
  if (typeof got?.[INSTALL_ID_KEY] === "string" && got[INSTALL_ID_KEY].length >= 32) {
    return got[INSTALL_ID_KEY];
  }
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [INSTALL_ID_KEY]: id });
  return id;
}

/**
 * Idempotent: get the existing PushSubscription or create one. Returns
 * the subscription (already a PushSubscription, has toJSON()).
 */
async function getOrCreateSubscription() {
  let sub = await self.registration.pushManager.getSubscription();
  if (sub) return sub;
  sub = await self.registration.pushManager.subscribe({
    userVisibleOnly: true,    // Chrome enforces this for Web Push.
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  });
  return sub;
}

/**
 * Ensure the SW has a push subscription AND that QRCallBox knows about
 * it. Cheap to call repeatedly: the actual register POST is throttled
 * to once per REREGISTER_INTERVAL_MS via a stored timestamp.
 *
 * Call this from SW top-level (every wake) — but the register POST
 * itself only fires on the throttle interval, so we don't hammer the
 * server. Idempotent on the server side either way.
 */
export async function ensurePushSubscription() {
  let sub;
  try {
    sub = await getOrCreateSubscription();
  } catch (err) {
    // pushManager.subscribe() throws on: notifications permission
    // denied (we have it though), corp policy block, etc. Bail; the
    // polling alarm is the fallback.
    console.warn("[push] subscribe failed:", err?.message);
    return { ok: false, error: err?.message };
  }

  const got = await chrome.storage.local.get(LAST_REGISTERED_KEY);
  const lastAt = got?.[LAST_REGISTERED_KEY] ?? 0;
  if (Date.now() - lastAt < REREGISTER_INTERVAL_MS) {
    return { ok: true, skipped: "fresh" };
  }

  const installationId = await getInstallationId();
  try {
    const resp = await fetch(REGISTER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        installationId,
        subscription: sub.toJSON(),
        extensionVersion: chrome.runtime.getManifest().version,
        userAgent: self.navigator?.userAgent ?? "",
      }),
    });
    if (!resp.ok) {
      console.warn("[push] register POST failed:", resp.status);
      return { ok: false, status: resp.status };
    }
    await chrome.storage.local.set({ [LAST_REGISTERED_KEY]: Date.now() });
    console.log(`[push] registered ${installationId} with server (v${chrome.runtime.getManifest().version})`);
    return { ok: true, installationId };
  } catch (err) {
    console.warn("[push] register POST threw:", err?.message);
    return { ok: false, error: err?.message };
  }
}

/**
 * Decode a base64url-encoded VAPID public key into the Uint8Array
 * shape pushManager.subscribe() expects.
 */
function urlBase64ToUint8Array(b64) {
  const padding = "=".repeat((4 - (b64.length % 4)) % 4);
  const base64  = (b64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw     = atob(base64);
  const out     = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
