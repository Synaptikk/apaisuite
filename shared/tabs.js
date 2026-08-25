// shared/tabs.js
//
// Tab helpers union'd from the three donors' implementations.
//   findOrOpenTracked(url, opts) — find-or-open, reporting WHICH of the two happened
//   closeIfOpened(state)      — close a tab only if we were the ones who opened it
//   withTempTab(url, fn, opts)— run fn against a tab, closing it on the way out
//   findOrOpen(url, {active}) — legacy: returns the tab, drops `opened`
//   waitForLoad(tabId, ms)    — poll until tab status === "complete"
//   waitForUrl(tabId, substr, ms) — poll until tab.url contains substr AND status === "complete"
//   focus(tab)                — bring tab + its window to front
//   execute(tabId, fn, args, opts) — chrome.scripting.executeScript wrapper
//
// ── Why `opened` is part of the contract ────────────────────────────────────
// A background job that needs a page has exactly two cases, and they have
// opposite cleanup rules:
//
//   • the user already had that site open → it is THEIR tab. Never close it,
//     never navigate it out from under them.
//   • no such tab existed, so we made one → it is OURS. Close it when the job
//     ends, or it becomes litter the user has to sweep up by hand.
//
// The old `findOrOpen` returned a tab and threw that distinction away, so
// every caller that wanted to clean up had to re-derive it. They each invented
// their own flag for it — `weOpened`, `opened`, `openedFresh`, `didOpen` — and
// the ones that skipped it leaked a tab per run (AUTH_AUDIT.md, "(a) Auth tabs
// left open after success"). One site even tracked `openedFresh` correctly and
// then only logged it.
//
// So: the fact is now carried by the return value and cannot be dropped by
// accident. `findOrOpen` stays as a wrapper because `host.tabs` exposes it,
// but new code should use `findOrOpenTracked` or `withTempTab`.

export function createTabs(/* moduleId — currently unused; reserved */) {
  return {
    findOrOpen, findOrOpenTracked, closeIfOpened, withTempTab,
    waitForLoad, waitForUrl, focus, execute,
    query: (q) => chrome.tabs.query(q),
    create: (opts) => chrome.tabs.create(opts),
    get: (id) => chrome.tabs.get(id),
    update: (id, opts) => chrome.tabs.update(id, opts),
    remove: (id) => chrome.tabs.remove(id),
  };
}

// Returns { tab, opened }. `opened` is true only when this call created the tab.
//
// `match` overrides the tab-query pattern for sites where origin alone is too
// coarse (a hash-routed SPA where several of our modules use the same host, or
// a report where adopting the wrong view silently captures the wrong data).
// `accept` is a second, JS-side filter for what a query pattern cannot express
// — notably Tableau, whose view lives in the URL *fragment*, which match
// patterns do not see.
export async function findOrOpenTracked(url, { active = false, match, accept } = {}) {
  const pattern = match ?? new URL(url).origin + "/*";
  const existing = await chrome.tabs.query({ url: pattern });
  const usable = accept ? existing.filter(accept) : existing;
  if (usable.length) {
    if (active) await chrome.tabs.update(usable[0].id, { active: true });
    return { tab: usable[0], opened: false };
  }
  return { tab: await chrome.tabs.create({ url, active }), opened: true };
}

// Close a tab only if we opened it. Takes the whole { tab, opened } state so a
// caller cannot pass the tab and forget the flag. Never throws: the tab may
// already be gone (user closed it, window closed, crash), and that is success.
export async function closeIfOpened(state) {
  if (!state?.opened || state.tab?.id == null) return false;
  try {
    await chrome.tabs.remove(state.tab.id);
    return true;
  } catch {
    return false;
  }
}

// Run `fn(tab)` against a found-or-opened tab, then clean up. The close is in a
// `finally`, so it happens on the throw path too — which is the path that
// actually leaked in practice, since the happy path is the one people remember
// to write cleanup for.
export async function withTempTab(url, fn, opts = {}) {
  const state = await findOrOpenTracked(url, opts);
  try {
    return await fn(state.tab, state);
  } finally {
    await closeIfOpened(state);
  }
}

// Legacy shape — returns the tab and discards `opened`. Kept because
// `host.tabs.findOrOpen` is part of the documented module API.
async function findOrOpen(url, { active = false } = {}) {
  const { tab } = await findOrOpenTracked(url, { active });
  return tab;
}

async function waitForLoad(tabId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return false;
    if (t.status === "complete") return true;
    await delay(200);
  }
  return false;
}

async function waitForUrl(tabId, substr, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) throw new Error(`tab ${tabId} disappeared`);
    if (t.url?.includes(substr) && t.status === "complete") return t;
    await delay(400);
  }
  throw new Error(`tab ${tabId} did not navigate to URL containing "${substr}" within ${timeoutMs}ms`);
}

async function focus(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId != null) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
}

async function execute(tabId, func, args = [], { allFrames = false, world = "ISOLATED" } = {}) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames },
    func,
    args,
    world,
  });
  return results;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
