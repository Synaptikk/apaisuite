// scripts/stubs/push.js — Chrome Web Store build stub for shared/push.js.
//
// The real module subscribes to Web Push and POSTs the installation id,
// subscription, extension version and user-agent to qrcallbox.com. Its only
// consumer is the "extension-update" push in background/service_worker.js,
// which shows a notification linking to https://qrcallbox.com/extension/ so
// the user can download a new ZIP by hand.
//
// In a store build that is worse than useless. Chrome updates a store install
// on its own, the self-updater is already stubbed out, and pushing a store
// user toward an off-store download is exactly the distribution the Web Store
// forbids. Leaving the subscription alive would also transmit an installation
// id and user-agent for a feature that no longer does anything — which is the
// kind of collection-without-purpose the Limited Use policy targets.
//
// Without a subscription there is no endpoint, so no push can ever be
// delivered and the listener in the service worker is dead code. That makes
// this stub sufficient on its own; the handler is left in place because it is
// harmless and keeps the store tree closer to the repo.
//
// Exports must match shared/push.js exactly — service_worker.js imports it
// unconditionally at top level, and a missing export is a module-load error
// that takes the whole worker down.

export async function ensurePushSubscription() {
  return { ok: true, skipped: "store-build" };
}
