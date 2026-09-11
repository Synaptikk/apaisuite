// shared/tabSessions.js
//
// Idle reaper for background tabs that a module opened and must KEEP open for
// a while. This is the "Pass-2 sessionManager" that claimsdisposition's
// ensureEmbedTab and livedashboard's cvp.js both point at in their comments.
//
// Requests use withSessionTabs to reuse helpers until their batch finishes.
// The idle reaper is a fallback for interrupted workers, not the normal
// completion path. Existing user tabs must never enter this registry.
//
// ── Why chrome.storage.session ───────────────────────────────────────────────
// A module-scope `let _tabId` is discarded when the MV3 worker idles out after
// ~30s. The TAB is not. That mismatch is precisely how these became leaks: the
// pointer vanished, the window stayed, and the next wake opened another one
// with no idea the first existed. Session storage outlives worker restarts and
// dies with the browser session, which is exactly the lifetime we want.

const KEY = "_suite_tabSessions";
let registryQueue = Promise.resolve();
function updateRegistry(operation) {
  const run = () => globalThis.navigator?.locks?.request
    ? navigator.locks.request("apaisuite.tabSessions.registry", operation)
    : operation();
  const result = registryQueue.then(run, run);
  registryQueue = result.catch(() => {});
  return result;
}
const activeOperations = new Map();
const ownedHere = new Set();
const pendingCleanup = new Set();
let closing = null;

// A module boundary is not a tab boundary: another module may be consuming
// the same registered helper. Wait until all scoped consumers finish, and
// close only tabs registered by this context (never another shell/worker).
export async function withSessionTabs(moduleId, operation) {
  while (closing) await closing;
  activeOperations.set(moduleId, (activeOperations.get(moduleId) || 0) + 1);
  try { return await operation(); }
  finally {
    activeOperations.set(moduleId, activeOperations.get(moduleId) - 1);
    pendingCleanup.add(moduleId);
    if (![...activeOperations.values()].some(Boolean)) {
      const cleanup = (async () => {
        for (const entry of await listSessionTabs()) {
          if (!pendingCleanup.has(entry.moduleId) || !ownedHere.has(entry.tabId)) continue;
          await chrome.tabs.remove(entry.tabId).catch(() => {});
          await forgetSessionTab(entry.tabId);
          ownedHere.delete(entry.tabId);
        }
        pendingCleanup.clear();
      })();
      closing = cleanup;
      try { await cleanup; } finally { closing = null; }
    }
  }
}

// Default grace period. Long enough that a user flipping between suite tabs
// doesn't pay a reauth, short enough that a tab left from this morning is gone
// by lunch.
export const DEFAULT_IDLE_MS = 15 * 60 * 1000;

async function readAll() {
  try {
    const got = await chrome.storage.session.get(KEY);
    return got?.[KEY] && typeof got[KEY] === "object" ? got[KEY] : {};
  } catch {
    return {};
  }
}

async function writeAll(map) {
  try { await chrome.storage.session.set({ [KEY]: map }); } catch { /* best effort */ }
}

// Record a tab WE opened and intend to reuse. Tabs the user already had open
// must never be registered — the reaper's whole contract is that everything it
// holds is ours to close.
export async function registerSessionTab(...args) {
  return updateRegistry(() => registerSessionTabImpl(...args));
}

async function registerSessionTabImpl(moduleId, tabId, { idleMs = DEFAULT_IDLE_MS } = {}) {
  if (tabId == null) return;
  ownedHere.add(tabId);
  const map = await readAll();
  map[String(tabId)] = { moduleId, idleMs, lastUsedAt: Date.now() };
  await writeAll(map);
}

// Mark a registered tab as still in use. Cheap and safe to call on every
// operation that touches the tab — an unregistered tab is silently ignored, so
// callers don't need to know whether they opened it or adopted it.
export async function touchSessionTab(...args) {
  return updateRegistry(() => touchSessionTabImpl(...args));
}

async function touchSessionTabImpl(tabId) {
  if (tabId == null) return;
  const map = await readAll();
  const entry = map[String(tabId)];
  if (!entry) return;
  entry.lastUsedAt = Date.now();
  await writeAll(map);
}

// Forget a tab without closing it — e.g. we detected the user navigated it
// somewhere else, so it stopped being ours.
export async function forgetSessionTab(...args) {
  return updateRegistry(() => forgetSessionTabImpl(...args));
}

async function forgetSessionTabImpl(tabId) {
  if (tabId == null) return;
  const map = await readAll();
  if (!(String(tabId) in map)) return;
  delete map[String(tabId)];
  await writeAll(map);
}

// Close everything that has gone quiet past its own idleMs. Returns what it
// did, so the caller can log it — a reaper that closes tabs silently is
// indistinguishable from a crash from the user's side.
//
// `now` is injectable for tests; production callers pass nothing.
export async function reapIdleTabs(...args) {
  return updateRegistry(() => reapIdleTabsImpl(...args));
}

async function reapIdleTabsImpl(now = Date.now()) {
  const map = await readAll();
  const ids = Object.keys(map);
  if (!ids.length) return { closed: [], kept: 0, dropped: [] };

  const closed = [];
  const dropped = [];   // registered but already gone — user closed it, or the window did
  let kept = 0;
  let changed = false;

  for (const id of ids) {
    const entry = map[id];
    const tabId = Number(id);
    const idle = now - (entry?.lastUsedAt ?? 0);

    const stillThere = await chrome.tabs.get(tabId).then(() => true).catch(() => false);
    if (!stillThere) {
      dropped.push({ tabId, moduleId: entry?.moduleId });
      delete map[id];
      changed = true;
      continue;
    }

    if ([...activeOperations.values()].some(Boolean) || idle < (entry?.idleMs ?? DEFAULT_IDLE_MS)) {
      kept++;
      continue;
    }

    try {
      await chrome.tabs.remove(tabId);
      closed.push({ tabId, moduleId: entry?.moduleId, idleMs: idle });
    } catch {
      // Couldn't close it — drop the registration anyway rather than retrying
      // forever against a tab we evidently cannot control.
      dropped.push({ tabId, moduleId: entry?.moduleId });
    }
    delete map[id];
    changed = true;
  }

  if (changed) await writeAll(map);
  return { closed, kept, dropped };
}

// Test/diagnostic view of the registry.
export async function listSessionTabs() {
  const map = await readAll();
  return Object.entries(map).map(([id, v]) => ({ tabId: Number(id), ...v }));
}
