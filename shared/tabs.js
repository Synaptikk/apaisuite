// shared/tabs.js
//
// Tab helpers union'd from the three donors' implementations.
//   findOrOpen(url, {active}) — find existing tab matching origin or open new
//   waitForLoad(tabId, ms)    — poll until tab status === "complete"
//   waitForUrl(tabId, substr, ms) — poll until tab.url contains substr AND status === "complete"
//   focus(tab)                — bring tab + its window to front
//   execute(tabId, fn, args, opts) — chrome.scripting.executeScript wrapper

export function createTabs(/* moduleId — currently unused; reserved */) {
  return {
    findOrOpen, waitForLoad, waitForUrl, focus, execute,
    query: (q) => chrome.tabs.query(q),
    create: (opts) => chrome.tabs.create(opts),
    get: (id) => chrome.tabs.get(id),
    update: (id, opts) => chrome.tabs.update(id, opts),
    remove: (id) => chrome.tabs.remove(id),
  };
}

async function findOrOpen(url, { active = false } = {}) {
  const origin = new URL(url).origin + "/*";
  const existing = await chrome.tabs.query({ url: origin });
  if (existing.length) {
    if (active) await chrome.tabs.update(existing[0].id, { active: true });
    return existing[0];
  }
  return chrome.tabs.create({ url, active });
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
