// modules/claimsdisposition/lib/userDirectory.js
//
// Username → real-name resolver with a chrome.storage.local cache.
//
// Why: claims-disposition records carry a `userId` like "ses008s" but every
// downstream consumer (drawer, outlier panel, PDF export) wants the human
// name. Hitting one.walmart.com's directory in real time on every render
// would be slow + noisy; this module is the single chokepoint.
//
// Cache layout
// ────────────
//   chrome.storage.local["claimsdisposition.directory.<username>"]
//     = { name: "Shane Smith" | null, fetchedAt: <ms-epoch> }
//   `name: null` is a NEGATIVE cache — directory returned no match. We keep
//   it around for 24 h so the same look-up doesn't re-fire on every render.
//
// In-memory caches on top of storage:
//   _mem      Map<username, {name, fetchedAt}|null>   — fast sync read
//   _inflight Map<username, Promise<string|null>>     — dedupe concurrent lookups
//
// API
// ───
//   getNameSync(u)           → string|null|undefined   (undefined = not loaded yet)
//   lookupName(u)            → Promise<string|null>    (cache → storage → network)
//   warmCache(usernames)     → Promise<void>           (bulk hydrate, drawer calls on open)
//   subscribe(fn)            → unsubscribe fn          (fn called on any resolve)
//
// Network lookup
// ──────────────
//   _fetchFromDirectory is a STUB that returns null. To turn it on, find
//   the directory's XHR in DevTools (open
//   https://one.walmart.com/content/uswire/en_us/directory.html, F12 →
//   Network, search a username, copy the request) and fill in the fetch
//   call below. The cache layer + UI work without it — usernames just
//   never resolve to names.

const PREFIX     = "userdir.";
const HIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;  // 30 d for resolved names
// Negative results from Workvivo (definitive "no match" / ambiguous) get
// short-cached so the UI doesn't re-fire on every render but recovers fast
// if the person is added to the directory. Transient errors (tab/auth/
// network) are NOT cached at all — see lookupName + _fetchFromDirectory.
const MISS_TTL_MS = 60 * 60 * 1000;            // 1 h for "no match" results

const _mem      = new Map();   // username → {name, fetchedAt} | null (negative)
const _inflight = new Map();   // username → Promise<string|null>
const _listeners = new Set();  // change subscribers

function _now() { return Date.now(); }
function _key(username) { return PREFIX + String(username).toLowerCase(); }
function _isFresh(entry) {
  if (!entry) return false;
  const age = _now() - entry.fetchedAt;
  return entry.name != null ? age < HIT_TTL_MS : age < MISS_TTL_MS;
}

function _notify(username, name) {
  for (const fn of _listeners) {
    try { fn(username, name); }
    catch (e) { console.warn("[userDirectory] listener threw", e); }
  }
}

/**
 * Synchronous lookup — returns the resolved name if it's in memory.
 * Returns `null` if we know the lookup failed; `undefined` if we haven't
 * tried yet. Components use this for the initial render, then re-render
 * via subscribe() as async lookups complete.
 */
export function getNameSync(username) {
  if (!username) return null;
  const entry = _mem.get(String(username).toLowerCase());
  if (entry === undefined) return undefined;        // never tried
  return entry?.name ?? null;
}

/**
 * Async lookup. Tries memory → chrome.storage.local → network.
 * De-dupes concurrent calls for the same username.
 */
export async function lookupName(username) {
  if (!username) return null;
  const u = String(username).toLowerCase();

  // Memory hit?
  const mem = _mem.get(u);
  if (mem !== undefined && _isFresh(mem)) return mem?.name ?? null;

  // Already in-flight?
  if (_inflight.has(u)) return _inflight.get(u);

  const p = (async () => {
    // Storage hit?
    try {
      const got = await chrome.storage.local.get(_key(u));
      const stored = got[_key(u)];
      if (stored && _isFresh(stored)) {
        _mem.set(u, stored);
        return stored.name ?? null;
      }
    } catch (e) {
      console.warn("[userDirectory] storage.get failed for", u, e);
    }

    // Network fetch. Distinguish two failure modes:
    //   - Workvivo responded definitively (no match / ambiguous) → name=null,
    //     cache the null for MISS_TTL_MS so the same render doesn't re-fire.
    //   - Transient error (tab not ready, auth expired, executeScript blew
    //     up) → DON'T cache; return null for this call but let the next
    //     caller retry. Critical: a brief Workvivo outage used to poison
    //     the cache for 24h, so even after recovery the UI kept showing
    //     raw IDs until TTL expired.
    let name = null;
    let transient = false;
    try {
      name = await _fetchFromDirectory(u);
    } catch (e) {
      transient = true;
      console.debug("[userDirectory] transient lookup failure for", u, ":", e?.message);
    }

    if (transient) {
      _notify(u, null);
      return null;
    }

    const entry = { name: name ?? null, fetchedAt: _now() };
    _mem.set(u, entry);
    try {
      await chrome.storage.local.set({ [_key(u)]: entry });
    } catch (e) {
      console.warn("[userDirectory] storage.set failed for", u, e);
    }
    _notify(u, entry.name);
    return entry.name;
  })();

  _inflight.set(u, p);
  try { return await p; }
  finally { _inflight.delete(u); }
}

/**
 * Bulk warm — fire lookupName() for each unique username in parallel.
 * Called by detailDrawer when it opens for a store. Returns when ALL
 * lookups have settled (resolved or failed); the drawer doesn't await it,
 * it just lets subscribe() drive re-renders as names trickle in.
 */
export async function warmCache(usernames) {
  const uniq = Array.from(new Set(
    (usernames || []).filter(Boolean).map((u) => String(u).toLowerCase())
  ));
  // Promise.allSettled so one failed lookup doesn't reject the batch.
  await Promise.allSettled(uniq.map((u) => lookupName(u)));
}

/**
 * Subscribe to resolution events. The callback fires every time a lookup
 * completes (hit OR miss). Returns an unsubscribe fn.
 */
export function subscribe(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/**
 * Resolve a username → display name via Workvivo's quick-search API.
 *
 * Workvivo isn't conceptually related to claims-disposition; it just
 * happens to be the easiest authenticated employee directory we can
 * reach from the extension. If you ever want to swap in Workday SCIM,
 * Microsoft Graph, or one.walmart.com's directory page, only this
 * function changes — the cache + UI layer is endpoint-agnostic.
 *
 * Mechanics
 * ─────────
 *   POST https://workvivo.walmart.com/api/quick-search
 *   body: { "term": "<username>", "page": 1, "limit": 2,
 *           "characters": { "excerpt": 70, "title": 30 } }
 *   → [ { items: [ { title: "Patricia Blanchard", type: "People", … } ] }, … ]
 *
 * Why we route through a Workvivo tab instead of fetching directly
 * ─────────────────────────────────────────────────────────────────
 * Workvivo's auth requires THREE headers on every API call:
 *   • X-Requested-With: XMLHttpRequest
 *   • X-CSRF-Token:    <value from `<meta name="csrf_token">`>
 *   • X-XSRF-TOKEN:    <URL-decoded value of the XSRF-TOKEN cookie>
 * Without all three, Laravel returns 401 "Unauthenticated" — even if
 * session cookies are perfectly valid. The CSRF token lives in a meta
 * tag on the page, so cross-origin extension fetches can never see it.
 *
 * Solution: chrome.scripting.executeScript into a workvivo.walmart.com
 * tab's MAIN world, where the meta tag + cookies are both accessible.
 * We auto-open a background workvivo tab if none is open; subsequent
 * lookups reuse the same tab. The tab stays open after the user closes
 * the dashboard — minor cost, but avoids a load-on-each-warm penalty.
 *
 * Verified via dev/probe-real-usernames.mjs.
 * Requires `https://*.walmart.com/*` in manifest host_permissions and
 * the `scripting` + `tabs` permissions (all present).
 */

// Module-local cache of the workvivo tab id we use for lookups.
// Reset when the tab closes; we re-find or re-open on the next call.
let _workvivoTabId = null;
// In-flight Promise for the open-or-find-tab dance. Without this,
// `warmCache(usernames)` fires N parallel `_ensureWorkvivoTab()` calls;
// they all observe `_workvivoTabId == null` AND `chrome.tabs.query` returns
// nothing yet (because the first-in-flight tabs.create hasn't resolved),
// so each one opens its own tab. Dedupe by waiting on the first call.
let _workvivoTabInFlight = null;

async function _ensureWorkvivoTab() {
  // Verify cached tabId still exists; if not, fall through to discovery.
  if (_workvivoTabId != null) {
    try {
      const t = await chrome.tabs.get(_workvivoTabId);
      if (t && /^https:\/\/workvivo\.walmart\.com\//.test(t.url || "")) return _workvivoTabId;
    } catch { /* tab closed */ }
    _workvivoTabId = null;
  }

  // Concurrent caller is already finding/opening a tab — share the result.
  if (_workvivoTabInFlight) return _workvivoTabInFlight;

  _workvivoTabInFlight = (async () => {
    // Look for any existing Workvivo tab.
    const existing = await chrome.tabs.query({ url: "https://workvivo.walmart.com/*" });
    if (existing.length) {
      _workvivoTabId = existing[0].id;
      return _workvivoTabId;
    }

    // None open — open a background tab and wait for it to finish loading.
    // `active: false` keeps the user's current tab focused.
    const tab = await chrome.tabs.create({ url: "https://workvivo.walmart.com/", active: false });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        reject(new Error("workvivo tab load timed out"));
      }, 20000);
      function onUpdated(updatedId, change) {
        if (updatedId === tab.id && change.status === "complete") {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(onUpdated);
          // Give the page a beat to render the csrf_token meta tag.
          setTimeout(resolve, 600);
        }
      }
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
    _workvivoTabId = tab.id;
    return _workvivoTabId;
  })().finally(() => { _workvivoTabInFlight = null; });

  return _workvivoTabInFlight;
}

// This function gets serialized into the workvivo tab and executed there.
// IMPORTANT: cannot close over outer variables — only its arguments are
// available inside.
async function _workvivoSearchInTab(term) {
  const csrf = document.querySelector('meta[name="csrf_token"]')?.content || "";
  const xsrfRaw = document.cookie.split("; ").find((c) => c.startsWith("XSRF-TOKEN="))?.split("=")[1] || "";
  const xsrf = decodeURIComponent(xsrfRaw);
  if (!csrf || !xsrf) return { __err: "missing csrf/xsrf token on page" };
  try {
    const r = await fetch("/api/quick-search", {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        "accept": "application/json",
        "x-requested-with": "XMLHttpRequest",
        "x-csrf-token": csrf,
        "x-xsrf-token": xsrf,
      },
      body: JSON.stringify({ term, page: 1, limit: 2, characters: { excerpt: 70, title: 30 } }),
    });
    if (!r.ok) return { __err: `status ${r.status}` };
    return await r.json();
  } catch (e) {
    return { __err: e?.message ?? String(e) };
  }
}

async function _fetchFromDirectory(username) {
  // Throws on transient failures (tab not ready, auth expired, executeScript
  // blew up, response shape unparseable). Returns string|null only for
  // DEFINITIVE Workvivo responses — string = matched, null = confirmed no
  // unique match. The caller (lookupName) caches null but not throws.
  let tabId;
  try {
    tabId = await _ensureWorkvivoTab();
  } catch (e) {
    throw new Error(`tab unavailable: ${e?.message ?? e}`);
  }

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: _workvivoSearchInTab,
      args: [username],
    });
  } catch (e) {
    // Tab might have navigated away or been closed mid-query — drop the
    // cached id so the next attempt rediscovers/reopens.
    _workvivoTabId = null;
    throw new Error(`executeScript failed: ${e?.message ?? e}`);
  }

  const data = results?.[0]?.result;
  if (!data) throw new Error("workvivo: no result from MAIN-world fn");
  if (data.__err) throw new Error(`workvivo: ${data.__err}`);
  if (!Array.isArray(data)) throw new Error(`workvivo: unexpected response shape (${typeof data})`);

  // From here on, Workvivo gave us a definitive answer.
  const peopleItems = data
    .flatMap((g) => Array.isArray(g?.items) ? g.items : [])
    .filter((i) => i?.type === "People");
  if (peopleItems.length !== 1) return null;   // 0 = no match; >1 = ambiguous

  const name = String(peopleItems[0].title || "").trim();
  if (name.length < 2) return null;
  return name;
}
