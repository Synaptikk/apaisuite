// shared/updater.js — Chrome Web Store build stub.
//
// The real implementation polls qrcallbox.com for a newer version.json and the
// UI then downloads that build's ZIP. That is a distribution channel outside
// the Web Store, which store policy prohibits, and it is redundant for a store
// install: Chrome updates store items on its own.
//
// Swapped in by scripts/pack-cws.sh at package time. The unpacked and
// self-hosted builds ship the real file, where the self-updater is the only
// way users get new versions.
//
// Exports must match shared/updater.js exactly — background/service_worker.js
// imports checkForUpdate and the storage keys unconditionally.

export async function checkForUpdate() {
  return { ok: true, available: false, disabled: "store-build" };
}

// Key strings must stay identical to shared/updater.js — updater_ui and any
// storage.onChanged listener key off these exact strings.
export const UPDATER_STORAGE_KEYS = Object.freeze({
  available: "shell.updater.available",
  lastCheckedAt: "shell.updater.lastCheckedAt",
  lastError: "shell.updater.lastError",
});
