// modules/assocpurchases/lib/userDirectory.js
//
// WIN → display name resolver via Workvivo quick-search.
// Module-local copy of the claimsdisposition userDirectory pattern.
//
// Cache layout (module-prefixed to avoid collisions):
//   chrome.storage.local["assocpurchases.userdir.<win>"]
//     = { name: string|null, fetchedAt: number }
//   name===null is a negative cache (Workvivo returned no unique match).

const STORAGE_PREFIX = "assocpurchases.userdir.";
const HIT_TTL_MS     = 30 * 24 * 60 * 60 * 1000;   // 30 days for resolved names
const MISS_TTL_MS    =       60 * 60 * 1000;         // 1 hour for "no match"

const _mem      = new Map();   // win → {name, fetchedAt} | null
const _inflight = new Map();   // win → Promise<string|null>

function _key(win) { return STORAGE_PREFIX + win.toLowerCase(); }
function _isFresh(entry) {
  const age = Date.now() - entry.fetchedAt;
  return entry.name != null ? age < HIT_TTL_MS : age < MISS_TTL_MS;
}

export async function lookupName(win) {
  if (!win) return null;
  const u = win.toLowerCase();

  const mem = _mem.get(u);
  if (mem !== undefined && _isFresh(mem)) return mem?.name ?? null;

  if (_inflight.has(u)) return _inflight.get(u);

  const p = (async () => {
    try {
      const got = await chrome.storage.local.get(_key(u));
      const stored = got[_key(u)];
      if (stored && _isFresh(stored)) {
        _mem.set(u, stored);
        return stored.name ?? null;
      }
    } catch { /* storage unavailable */ }

    let name = null;
    let transient = false;
    try {
      name = await _fetchFromWorkvivo(u);
    } catch {
      transient = true;
    }

    if (transient) return null;

    const entry = { name: name ?? null, fetchedAt: Date.now() };
    _mem.set(u, entry);
    try { await chrome.storage.local.set({ [_key(u)]: entry }); } catch { /* ignore */ }
    return entry.name;
  })();

  _inflight.set(u, p);
  try { return await p; } finally { _inflight.delete(u); }
}

export async function lookupNames(wins) {
  const uniq = [...new Set((wins || []).filter(Boolean).map(w => w.toLowerCase()))];
  const results = new Map();
  await Promise.allSettled(
    uniq.map(async w => { results.set(w, await lookupName(w)); })
  );
  return results;   // Map<win, string|null>
}

// ── Workvivo MAIN-world search ────────────────────────────────────────────────

let _wvTabId = null;
let _wvTabInFlight = null;

async function _ensureWorkvivo() {
  if (_wvTabId != null) {
    try {
      const t = await chrome.tabs.get(_wvTabId);
      if (t && /workvivo\.walmart\.com/.test(t.url || "")) return _wvTabId;
    } catch { /* closed */ }
    _wvTabId = null;
  }
  if (_wvTabInFlight) return _wvTabInFlight;

  _wvTabInFlight = (async () => {
    const existing = await chrome.tabs.query({ url: "https://workvivo.walmart.com/*" });
    if (existing.length) { _wvTabId = existing[0].id; return _wvTabId; }
    const tab = await chrome.tabs.create({ url: "https://workvivo.walmart.com/", active: false });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        reject(new Error("Workvivo tab load timed out"));
      }, 20_000);
      function onUpdated(id, change) {
        if (id !== tab.id || change.status !== "complete") return;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        setTimeout(resolve, 600);
      }
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
    _wvTabId = tab.id;
    return _wvTabId;
  })().finally(() => { _wvTabInFlight = null; });

  return _wvTabInFlight;
}

// Serialised into the Workvivo tab (must be pure — no closure variables).
async function _wvSearch(term) {
  const csrf  = document.querySelector('meta[name="csrf_token"]')?.content || "";
  const xsrfR = document.cookie.split("; ").find(c => c.startsWith("XSRF-TOKEN="))?.split("=")[1] || "";
  const xsrf  = decodeURIComponent(xsrfR);
  if (!csrf || !xsrf) return { __err: "missing csrf/xsrf" };
  try {
    const r = await fetch("/api/quick-search", {
      method:      "POST",
      credentials: "include",
      headers: {
        "content-type":    "application/json",
        "accept":          "application/json",
        "x-requested-with":"XMLHttpRequest",
        "x-csrf-token":    csrf,
        "x-xsrf-token":    xsrf,
      },
      body: JSON.stringify({ term, page: 1, limit: 2, characters: { excerpt: 70, title: 30 } }),
    });
    if (!r.ok) return { __err: `status ${r.status}` };
    return await r.json();
  } catch (e) {
    return { __err: e?.message ?? String(e) };
  }
}

async function _fetchFromWorkvivo(win) {
  let tabId;
  try { tabId = await _ensureWorkvivo(); }
  catch (e) { throw new Error(`Workvivo tab unavailable: ${e?.message}`); }

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      world:  "MAIN",
      func:   _wvSearch,
      args:   [win],
    });
  } catch (e) {
    _wvTabId = null;
    throw new Error(`executeScript failed: ${e?.message}`);
  }

  const data = results?.[0]?.result;
  if (!data || data.__err) throw new Error(`Workvivo error: ${data?.__err ?? "no result"}`);
  if (!Array.isArray(data)) throw new Error("Workvivo: unexpected shape");

  const people = data
    .flatMap(g => Array.isArray(g?.items) ? g.items : [])
    .filter(i => i?.type === "People");
  if (people.length !== 1) return null;
  const name = String(people[0].title || "").trim();
  return name.length >= 2 ? name : null;
}
