// shared/associateLookup.js
//
// WIN → real-name resolver, shared across the suite.
//
// Promoted here from modules/claimsdisposition/lib/userDirectory.js on
// 2026-08-22, at its THIRD consumer. A near-identical Workvivo resolver had
// already been copied into modules/assocpurchases/lib/userDirectory.js (both
// hitting the same quick-search API and both writing through
// associateDirectory.merge), and vizpick's Associates view needed a fourth.
// Two copies is a smell; three is a maintenance bill. The assocpurchases copy
// is deleted and its `lookupNames` API is preserved below.
//
// DIVISION OF LABOUR, so the next person does not add a fifth:
//   shared/associateDirectory.js — the permanent STORE (get/getMany/merge).
//                                  Knows nothing about how a name is found.
//   shared/associateLookup.js    — this file. RESOLVES an unknown WIN to a
//                                  name via Workvivo, then merges it in.
//   digitallocks lookupAssociate — resolves tenure AND title via Workday.
//                                  Not promoted yet; see the note at the end.
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
//   Resolved names live in shared/associateDirectory.js — the suite-wide,
//   PERMANENT store keyed by WIN. A name we have resolved once is never
//   looked up again, and a WIN that digitallocks resolved via Workday is
//   already answered here for free (and vice versa). This module used to
//   keep its own `userdir.<username>` cache with a 30-day TTL, which meant
//   re-resolving the same people every month, per module.
//
//   Misses stay short-lived (see associateDirectory's header): a "no match"
//   is usually a failure, not a fact.
//
// In-memory caches on top of storage:
//   _mem      Map<username, {name}|null>          — fast sync read
//   _inflight Map<username, Promise<string|null>> — dedupe concurrent lookups
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
//   _fetchFromDirectory resolves names through Workvivo's quick-search API,
//   executed inside a Workvivo tab (the three required auth headers are only
//   reachable from page context — see its own comment block below). It is a
//   working implementation; an older header here described it as a stub long
//   after it was filled in.

import * as Directory from "./associateDirectory.js";
import { registerSessionTab, touchSessionTab } from "./tabSessions.js";

const _mem      = new Map();   // username → {name} | null (negative)
const _inflight = new Map();   // username → Promise<string|null>
const _listeners = new Set();  // change subscribers

function _notify(username, name) {
  for (const fn of _listeners) {
    try { fn(username, name); }
    catch (e) { console.warn("[userDirectory] listener threw", e); }
  }
}

// ── Resolution diagnostics ────────────────────────────────────────────────
//
// Callers render a bare WIN when resolution fails, which is honest but
// indistinguishable — on screen, "Workvivo was unreachable", "Workvivo has no
// such person" and "we already failed on this WIN within the hour, so we did
// not even ask" all look like the same column of ids. These counters let a
// caller say WHICH, instead of the user having to guess.
//
// Process-lifetime totals, not a window: read the delta across a call rather
// than the absolute, and note that the shell page and the service worker each
// keep their own (separate JS realms).
const _diag = {
  attempts:       0,   // went to the network
  resolved:       0,   // …and got a name back
  definitiveMiss: 0,   // …and Workvivo confirmed no unique match (miss recorded, 1 h)
  transient:      0,   // …and the attempt itself failed (no tab / auth / executeScript)
  cachedMiss:     0,   // never asked: a miss from the last hour is still standing
  lastError:      null,
  lastErrorAt:    null,
};

/** Snapshot of the counters above. See `_diag` for what each one means. */
export function lookupDiagnostics() { return { ..._diag }; }

/**
 * Difference between two snapshots, so a caller can report on just its own
 * pass without owning a global reset that would race every other caller.
 */
export function diffLookupDiagnostics(before, after = lookupDiagnostics()) {
  const b = before || {};
  const d = {};
  for (const k of ["attempts", "resolved", "definitiveMiss", "transient", "cachedMiss"]) {
    d[k] = (after[k] || 0) - (b[k] || 0);
  }
  d.lastError = after.lastError;
  return d;
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

  // Memory hit? A resolved name is permanent, so any non-null memory entry
  // is authoritative. A null entry only means "the last attempt failed" —
  // fall through to the shared miss window rather than trusting it forever.
  const mem = _mem.get(u);
  if (mem?.name) return mem.name;

  // Already in-flight?
  if (_inflight.has(u)) return _inflight.get(u);

  const p = (async () => {
    // Shared directory hit — permanent, and possibly written by another
    // module (digitallocks resolves names from Workday, for instance).
    const known = await Directory.get(u);
    if (known?.name) {
      _mem.set(u, { name: known.name });
      return known.name;
    }

    // A lookup that just failed backs off instead of re-firing per render.
    if (await Directory.isRecentMiss(u)) {
      _diag.cachedMiss++;
      _mem.set(u, null);
      return null;
    }
    _diag.attempts++;

    // Network fetch. Distinguish two failure modes:
    //   - Workvivo responded definitively (no match / ambiguous) → name=null,
    //     record a short-lived MISS so the same render doesn't re-fire.
    //   - Transient error (tab not ready, auth expired, executeScript blew
    //     up) → DON'T record anything; return null for this call but let the
    //     next caller retry. Critical: a brief Workvivo outage used to poison
    //     the cache, so even after recovery the UI kept showing raw IDs.
    let name = null;
    let transient = false;
    try {
      name = await _fetchFromDirectory(u);
    } catch (e) {
      transient = true;
      _diag.transient++;
      _diag.lastError = String(e?.message ?? e);
      _diag.lastErrorAt = Date.now();
      console.debug("[userDirectory] transient lookup failure for", u, ":", e?.message);
    }

    if (transient) {
      _notify(u, null);
      return null;
    }

    if (name) {
      // Permanent — merge() preserves any tenure/title another module already
      // resolved for this WIN rather than replacing the record.
      _diag.resolved++;
      _mem.set(u, { name });
      await Directory.merge(u, { name, sources: { name: "workvivo" } });
    } else {
      _diag.definitiveMiss++;
      _mem.set(u, null);
      await Directory.markMiss(u);
    }
    _notify(u, name ?? null);
    return name ?? null;
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
      if (t && /^https:\/\/workvivo\.walmart\.com\//.test(t.url || "")) {
        await touchSessionTab(_workvivoTabId);
        return _workvivoTabId;
      }
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
    // Ours. Kept between lookups on purpose — one pass resolves 300-500 names
    // through this single tab, so closing per name would be absurd — but it
    // now expires instead of living until the browser does.
    await registerSessionTab("associateLookup", tab.id);
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
      // Bounded on purpose. Without this the fetch can hang indefinitely (a
      // stalled request, a tab mid-SSO-redirect, a throttled background tab),
      // and because executeScript awaits whatever this function returns, the
      // hang propagates all the way up: lookupName never settles, so
      // lookupNames' allSettled never settles, so every caller waits forever.
      // That is what left VizPick's print window on "Preparing the report…".
      signal: AbortSignal.timeout(8000),
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
    // Belt and braces over the in-page timeout above: a discarded or frozen
    // tab can leave executeScript itself pending, which the injected fetch's
    // AbortSignal cannot rescue because the injected code never runs.
    // Rejecting here is correct rather than resolving empty — the caller
    // treats a throw as TRANSIENT and will retry, where a definitive "no
    // match" would poison the cache for an hour.
    results = await Promise.race([
      chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: _workvivoSearchInTab,
        args: [username],
      }),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("executeScript timed out after 12s")), 12000)),
    ]);
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

/**
 * Resolve many WINs at once, returning Map(win → name|null).
 *
 * Kept from the assocpurchases copy this file replaced, whose service.js does
 * `Object.fromEntries(await lookupNames(wins))`. warmCache() does the same work
 * but returns nothing, so both shapes are offered rather than forcing every
 * caller into one.
 */
export async function lookupNames(wins) {
  const uniq = [...new Set((wins || []).filter(Boolean).map((w) => String(w).toLowerCase()))];
  const out = new Map();
  await Promise.allSettled(uniq.map(async (w) => { out.set(w, await lookupName(w)); }));
  return out;
}

// NOT HANDLED HERE: job title and tenure. Workvivo's quick-search returns a
// name and nothing else; Workday returns both, and that path currently lives
// in modules/digitallocks/service.js::lookupAssociate. A caller that needs a
// title (vizpick's Associates view does) gets one only for WINs digitallocks
// has already resolved. Promoting the Workday path here is the obvious next
// step and deliberately not bundled into this move.

// ── Workday: job title + tenure ────────────────────────────────────────────
//
// Promoted from modules/digitallocks/service.js on 2026-08-22, alongside the
// Workvivo name resolver above, for the reason stated in this file's header:
// Workvivo returns a NAME ONLY. Title and tenure come from Workday, and while
// that path lived inside digitallocks every other module could show a job
// title only for WINs digitallocks happened to have resolved first.
//
// The two resolvers are deliberately separate calls, not one "resolve
// everything" helper: Workvivo is cheap (a quick-search in a tab the user
// likely already has) while Workday needs its own background tab and a DOM
// scrape. A caller that only needs a name should never pay for Workday.
//
// Both write through Directory.merge(), so whichever runs first, the other
// module gets the result for free.

const WORKDAY_ORIGIN = "https://wd504.myworkday.com";
const WORKDAY_SEARCH = `${WORKDAY_ORIGIN}/walmart/d/search.htmld?q=`;
const WORKDAY_TAB_KEY = "shared.workdayTabId";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureWorkdayTab() {
  const stored = await chrome.storage.session.get(WORKDAY_TAB_KEY).catch(() => ({}));
  const knownId = stored?.[WORKDAY_TAB_KEY] ?? null;

  if (knownId != null) {
    // Still open, and still ours (the user may have reused the tab for
    // something else, in which case we leave it alone and open a new one).
    const tab = await chrome.tabs.get(knownId).catch(() => null);
    if (tab && String(tab.url ?? tab.pendingUrl ?? "").startsWith(WORKDAY_ORIGIN)) {
      await touchSessionTab(knownId);
      return tab;
    }
    await chrome.storage.session.remove(WORKDAY_TAB_KEY).catch(() => {});
  }

  const tab = await chrome.tabs.create({ url: `${WORKDAY_ORIGIN}/walmart/d/home.htmld`, active: false });
  await chrome.storage.session.set({ [WORKDAY_TAB_KEY]: tab.id }).catch(() => {});
  // Same deal as the Workvivo tab: reused across a run of title lookups, so
  // the reaper owns its end-of-life rather than a per-call finally.
  await registerSessionTab("associateLookup", tab.id);
  await sleep(2000);
  return tab;
}

async function scrapeDirectoryForUser(tabId, userId) {
  try {
    const searchUrl = `${WORKDAY_SEARCH}${encodeURIComponent(userId)}`;
    await chrome.tabs.update(tabId, { url: searchUrl });

    // Poll until the SPA renders search results or timeout (12 s).
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      await sleep(1200);
      let result = null;
      try {
        const exec = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const body = document.body?.innerText ?? "";
            if (!body.match(/length of service/i)) {
              if (body.match(/People\s*\n\s*0\b/)) return { noResults: true };
              return { notReady: true, bodySnippet: body.slice(0, 300) };
            }

            const losIdx = body.search(/length of service/i);
            const losSnippet = body.slice(losIdx, losIdx + 200);

            // Match any leading time unit: "2 years 3 months", "7 months", "14 days", etc.
            const losMatch = body.match(/Length of Service\s+([\d]+\s+(?:year|month|day)[^\n]*)/i);
            if (!losMatch) return { noMatch: true, losSnippet };
            const lengthOfSvc = losMatch[1].trim();

            const y = Number(lengthOfSvc.match(/(\d+)\s*year/i)?.[1] ?? 0);
            const m = Number(lengthOfSvc.match(/(\d+)\s*month/i)?.[1] ?? 0);
            const d = Number(lengthOfSvc.match(/(\d+)\s*day/i)?.[1] ?? 0);
            const tenureDays = Math.round(y * 365.25 + m * 30.44 + d);

            // Name — line immediately after "Result link and actions" in Workday
            const nameMatch = body.match(/Result link and actions\n([^\n]+)/);
            const name = nameMatch ? nameMatch[1].trim() : null;

            // Title — Workday puts a blank line between "Associate" role label and the title
            const titleMatch = body.match(/\bAssociate\n\n([^\n]+)/);
            const title = titleMatch ? titleMatch[1].trim() : null;

            return { name, title, lengthOfSvc, tenureDays };
          },
        });
        result = exec?.[0]?.result ?? null;
      } catch {
        // Tab still loading — keep polling
        continue;
      }
      if (!result) return null;
      if (result.noResults) return null;
      if (result.noMatch) {
        console.warn("[digitallocks] LOS text found but regex failed. Snippet:", result.losSnippet);
        return null;
      }
      if (!result.notReady) return result;
      // Log notReady body snippet only on first poll (avoids spam)
      if (Date.now() < deadline - 10_800) {
        console.warn("[digitallocks] waiting for LOS — page so far:", result.bodySnippet);
      }
    }
    console.warn("[digitallocks] scrapeDirectoryForUser timed out for", userId);
    return null;
  } catch (e) {
    console.warn("[digitallocks] scrapeDirectoryForUser failed:", e?.message);
    return null;
  }
}

/**
 * Have we already been to Workday for this WIN?
 *
 * Gating on "does the record have a title" is WRONG and was the first version
 * of this. Workday does not return a title for everyone — and merge() clears
 * the miss key whenever it stores anything, so the negative cache cannot catch
 * it either. The result was that every titleless associate got re-scraped on
 * every repaint, forever: a background tab and a DOM scrape per render, for a
 * field that was never going to appear.
 *
 * Gate on evidence of the VISIT instead. A Workday merge always leaves either
 * `sources.tenure === "workday"` or a derived `hireDateApprox`, so their
 * presence means the question has been asked and answered — even if the answer
 * was "no title". `forget(win)` is the way to ask again.
 */
export function needsWorkdayLookup(record) {
  if (!record) return true;
  if (record.title) return false;
  if (record.hireDateApprox) return false;
  return record.sources?.tenure !== "workday" && record.sources?.name !== "workday";
}

/**
 * Resolve a WIN's job title and tenure via Workday.
 *
 * Permanent-cache first: a WIN resolved before never hits Workday again.
 * Returns null rather than throwing when the host permission is missing or the
 * scrape fails — a missing title must degrade to "no title", never to a broken
 * view.
 *
 * @returns {Promise<{name?:string, title?:string, tenureDays?:number}|null>}
 */
export async function lookupTitle(win) {
  const u = Directory.normalizeWin(win);
  if (!u) return null;

  const known = await Directory.get(u);
  if (!needsWorkdayLookup(known)) return known ?? null;
  if (await Directory.isRecentMiss(u)) return known ?? null;

  // Hard gate before any tab is opened. Workday is a separate host grant and
  // its absence is a configuration fact, not an error worth retrying.
  try {
    const ok = await chrome.permissions.contains({ origins: [`${WORKDAY_ORIGIN}/*`] });
    if (!ok) return known ?? null;
  } catch { return known ?? null; }

  try {
    const tab = await ensureWorkdayTab();
    if (!tab?.id) return known ?? null;
    const result = await scrapeDirectoryForUser(tab.id, u);
    if (!result?.name && !result?.title) {
      await Directory.markMiss(u);
      return known ?? null;
    }
    return await Directory.merge(u, {
      name:       result.name,
      title:      result.title,
      tenureDays: result.tenureDays,
      sources:    { name: "workday", tenure: "workday" },
    });
  } catch {
    return known ?? null;
  }
}

/** Titles for many WINs. Serial on purpose — each one may drive the same
 *  single Workday tab, and running them concurrently makes them fight over it
 *  the way the vizpick lanes once fought over one Tableau tab. */
export async function lookupTitles(wins) {
  const uniq = [...new Set((wins || []).map(Directory.normalizeWin).filter(Boolean))];
  const out = new Map();
  for (const w of uniq) out.set(w, await lookupTitle(w));
  return out;
}
