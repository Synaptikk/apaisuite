// shared/tabSessions.js
//
// Idle reaper for background tabs that a module opened and must KEEP open for
// a while. This is the "Pass-2 sessionManager" that claimsdisposition's
// ensureEmbedTab and livedashboard's cvp.js both point at in their comments.
//
// ── Why a reaper instead of a `finally` close ────────────────────────────────
// Most background tabs are scratch space: open it, do the job, close it. Those
// belong in `shared/tabs.js::withTempTab` and never come here.
//
// A few are not, and closing them eagerly is a real regression rather than a
// tidy-up:
//   • claimsdisposition's Looker embed — Looker's anti-CSRF cookie chain is
//     anchored to the tab. Close it and every subsequent pull re-pays a ~30s
//     reauth.
//   • livedashboard's Hoops ops-portal tab — same shape, a SAML round-trip per
//     poll instead of per session.
//   • sparkfraud's gscope auth tab — it BECOMES the working gscope tab once the
//     SSO chain lands; closing it throws away the session it just established.
//   • shared/associateLookup's Workvivo + Workday tabs — one lookup pass can be
//     300-500 names against a single tab.
//
// So the rule for these is not "close when the call ends", it is "close when
// nobody has needed you for a while". Register the tab, touch it on every use,
// and let the alarm sweep whatever went quiet.
//
// ── Why chrome.storage.session ───────────────────────────────────────────────
// A module-scope `let _tabId` is discarded when the MV3 worker idles out after
// ~30s. The TAB is not. That mismatch is precisely how these became leaks: the
// pointer vanished, the window stayed, and the next wake opened another one
// with no idea the first existed. Session storage outlives worker restarts and
// dies with the browser session, which is exactly the lifetime we want.

const KEY = "_suite_tabSessions";

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
export async function registerSessionTab(moduleId, tabId, { idleMs = DEFAULT_IDLE_MS } = {}) {
  if (tabId == null) return;
  const map = await readAll();
  map[String(tabId)] = { moduleId, idleMs, lastUsedAt: Date.now() };
  await writeAll(map);
}

// Mark a registered tab as still in use. Cheap and safe to call on every
// operation that touches the tab — an unregistered tab is silently ignored, so
// callers don't need to know whether they opened it or adopted it.
export async function touchSessionTab(tabId) {
  if (tabId == null) return;
  const map = await readAll();
  const entry = map[String(tabId)];
  if (!entry) return;
  entry.lastUsedAt = Date.now();
  await writeAll(map);
}

// Forget a tab without closing it — e.g. we detected the user navigated it
// somewhere else, so it stopped being ours.
export async function forgetSessionTab(tabId) {
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
export async function reapIdleTabs(now = Date.now()) {
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

    if (idle < (entry?.idleMs ?? DEFAULT_IDLE_MS)) {
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
