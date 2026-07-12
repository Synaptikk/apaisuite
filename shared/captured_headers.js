// shared/captured_headers.js
//
// In-memory map of webRequest-captured header values, shared between the
// shell SW (which writes to it from the webRequest listener) and module
// service.js code (which reads from it via shared/auth.js::getCapturedHeader).
//
// Why it exists: chrome.storage.session.set() → storage.onChanged fires on
// a new microtask, which means there's a non-trivial window where the
// shell SW has captured a fresh token but a module reading via the
// onChanged-driven cache still sees "". That race caused ensureAurorAuth
// to fall through to the slow tab-reload + SSO path even when the JWT had
// just been captured — measurable user-facing latency on every scan.
//
// Module-level state in this file IS the cache. Both service_worker.js
// (writer) and shared/auth.js (reader) import the same module instance, so
// they share the same Map automatically.

// fullKey ("<moduleId>.<storageKey>") -> { value: string, at: number }
const map = new Map();

export function setCapturedHeader(fullKey, value, at) {
  map.set(fullKey, { value, at });
}

export function readCapturedHeader(fullKey) {
  return map.get(fullKey) ?? null;
}

export function clearCapturedHeader(fullKey) {
  map.delete(fullKey);
}
