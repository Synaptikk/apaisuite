// modules/cx/lib/medallia.js
//
// Paged pull of the store's customer comments out of Medallia.
//
// Why this runs inside a tab rather than straight from the service worker:
// the reporting API needs an `x-csrf-token` that is only ever served in the
// page HTML (it is not a cookie and not on `window`), and the SAML session
// cookies are SameSite-scoped to the site. Both are satisfied by executing the
// POST in a walmart.medallia.com tab, which is the same arrangement
// livedashboard's cvp.js uses for Hoops.
//
// The role is discovered, not configured: GET /sso/walmart/ redirects a
// signed-in user to their own default page with ?roleId=... already on it.
//
// Full contract, headers and paging costs: dev/CX_FINDINGS.md section 2.

import { withSessionTabs, registerSessionTab, forgetSessionTab } from "../../../shared/tabSessions.js";
import { COMMENTS_QUERY, commentsVariables, DATA_VIEW } from "./medallia_query.js";

const ROOT_URL    = "https://walmart.medallia.com/sso/walmart/";
const TAB_PATTERN = "https://walmart.medallia.com/*";
// The SSO hand-off pages. A fetch from one of these has no reporting session
// yet, so they are not usable as an anchor tab.
const SSO_HOP_RE  = /\/(ssoLoginRequest|samlRequest|logonSubmit)\.do/i;
// Any page under the SSO app. Deliberately broad — which page a session lands
// on varies by the user's default view, and whether it is usable is decided by
// pingTab (does it hand us a CSRF token?), not by its path.
const MEDALLIA_URL_RE = /walmart\.medallia\.com\/sso\/walmart\//i;

/**
 * Records per request. 1000 measured at 714 KB / 14 s against a 52-week window;
 * 2000 also works but a single failure then costs 24 s of re-fetch, and the
 * whole-pull saving is under 20%.
 */
export const PAGE_SIZE = 1000;

/** Guard against an unbounded loop if the cursor ever stops advancing. */
const MAX_PAGES = 60;

/**
 * How many times one pull may throw away a dead anchor and open a fresh one.
 * Two covers "the borrowed tab was frozen" plus "our replacement froze as well";
 * a third would mean something other than freezing is wrong.
 */
const MAX_REANCHORS = 2;

/**
 * Deadline on every executeScript.
 *
 * Chrome freezes a background tab that has been idle, and a frozen tab NEVER
 * SETTLES an executeScript — it does not reject, it hangs, so a loop around it
 * never gets to re-check its own deadline. That is exactly how VizPick's crawl
 * hung overnight and leaked 46 tabs on 2026-09-15
 * (modules/vizpick/lib/sources/vizpick_stores_tableau.js carries the same
 * guard). A timeout turns the hang into an ordinary failed attempt.
 *
 * 45 s: a legitimate 1000-record page measured 14 s and the slowest observed was
 * under 25 s, so this cannot cut a real request short — and since a stall is now
 * recoverable (the pull re-anchors and retries the same cursor) rather than
 * fatal, waiting any longer to notice only adds dead time. It was 90 s, which
 * cost a user a minute and a half before the fallback kicked in.
 */
const EXEC_TIMEOUT_MS = 45_000;

/**
 * Deadline on the liveness probe. It reads one regex out of the DOM, so an awake
 * tab answers in well under a second; anything slower than this is frozen, and
 * waiting the full EXEC_TIMEOUT_MS to find that out would waste a minute and a
 * half at the start of every pull.
 */
const PING_TIMEOUT_MS = 8_000;

function execScriptWithTimeout(opts, ms = EXEC_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    chrome.scripting.executeScript(opts),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`executeScript timed out after ${Math.round(ms / 1000)}s (tab frozen or hung)`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

export class MedalliaError extends Error {
  constructor(message, errorClass = "HTTP") {
    super(message);
    this.name = "MedalliaError";
    this.errorClass = errorClass;   // AUTH | TAB | HTTP | SHAPE
  }
}

/**
 * Pull comments for a date window, newest first.
 *
 * @param {object}   opts
 * @param {string}   opts.from        inclusive ISO day, e.g. "2025-09-25"
 * @param {string}   opts.to          inclusive ISO day
 * @param {Set|null} opts.stopAtIds   stop as soon as a page is entirely made of
 *                                    ids already held — how an incremental
 *                                    refresh avoids re-reading the year
 * @param {number}   opts.maxRecords  hard ceiling on records fetched
 * @param {function} opts.onProgress  ({ fetched, total, page }) => void
 * @returns {Promise<{records: object[], total: number, pages: number, stoppedEarly: boolean, roleId: string}>}
 */
export async function fetchComments({
  from, to, stopAtIds = null, maxRecords = 40_000, onProgress = null,
} = {}) {
  if (!from || !to) throw new MedalliaError("fetchComments needs both from and to", "SHAPE");

  return withSessionTabs("cx", async () => {
    let anchor = await acquireAnchor();

    const records = [];
    let cursor = null, total = null, pages = 0, stoppedEarly = false, reanchors = 0;

    do {
      const vars = commentsVariables({ from, to, limit: PAGE_SIZE, cursor });

      let page;
      try {
        page = await postInTab(anchor, COMMENTS_QUERY, vars, "cxComments");
      } catch (e) {
        // A frozen or vanished anchor is recoverable, and recovering means
        // REPLACING it: a tab that froze once will freeze again, and a borrowed
        // tab is not ours to reload. The cursor is untouched, so the same page
        // is simply re-fetched against the new tab.
        if (!(e instanceof MedalliaError) || e.errorClass !== "TAB" || reanchors >= MAX_REANCHORS) throw e;
        reanchors++;
        anchor = await reanchor(anchor);
        continue;
      }

      const feedback = page?.data?.feedback;
      if (!feedback) throw new MedalliaError("Medallia returned no feedback connection", "SHAPE");

      total ??= feedback.totalCount ?? 0;
      const nodes = Array.isArray(feedback.nodes) ? feedback.nodes : [];
      pages++;

      const fresh = stopAtIds ? nodes.filter((n) => !stopAtIds.has(n.id)) : nodes;
      records.push(...fresh.map(normalizeRecord));

      // Newest-first ordering means the first page with nothing new is the
      // point where our stored history takes over. Keep going only if the page
      // was partly new, which happens on the boundary page.
      if (stopAtIds && fresh.length === 0 && nodes.length > 0) {
        stoppedEarly = true;
        break;
      }

      onProgress?.({ fetched: records.length, total, page: pages });

      const next = feedback.nextPages?.[0];
      cursor = next?.hasNextPage ? next.endCursor : null;
      if (records.length >= maxRecords) { stoppedEarly = true; break; }
    } while (cursor && pages < MAX_PAGES);

    // `reanchors` is surfaced so the panel's diagnostics can say a tab had to be
    // replaced mid-pull — a slow but successful pull should not look identical
    // to a clean one.
    return { records, total: total ?? records.length, pages, stoppedEarly, reanchors, roleId: anchor.roleId };
  });
}

// ── Anchor tab ──────────────────────────────────────────────────────────
//
// An anchor is `{ tabId, roleId, owned }`. `owned` decides what we are allowed
// to do to it: a tab we opened can be reloaded or closed freely, the user's own
// tab cannot.
//
// Readiness is NOT judged by the URL. The landing page differs per profile —
// this machine's debug profile lands on `/sso/walmart/applications/ex_WEB-5/
// pages/4899`, while a plain session lands on `/sso/walmart/pages/?roleId=…`
// (observed 2026-09-25). An earlier version required `/applications/` in the
// path and would simply never accept the second shape. The only thing that
// actually matters is whether the page hands us a CSRF token, so that is what
// is tested.

async function acquireAnchor() {
  return (await borrowAnchor()) ?? (await openAnchor());
}

/** A Medallia tab the user already has open, if it is usable. Never reloaded. */
async function borrowAnchor() {
  const candidates = (await chrome.tabs.query({ url: TAB_PATTERN }))
    .filter((t) => !SSO_HOP_RE.test(t.url || ""));

  for (const tab of candidates) {
    const roleId = roleIdFromUrl(tab.url);
    if (!roleId) continue;
    await waitForComplete(tab.id, 10_000);
    // Probe before trusting it. A tab that has sat in the background is very
    // likely frozen, and a frozen tab HANGS executeScript rather than failing
    // it — which is what made the first end-to-end run sit for seven minutes
    // with nothing to show (MEMORY.md::VizPick tab leak, same shape).
    if (!await pingTab(tab.id)) continue;
    // Discarding mid-pull would lose the session the pull rides on. Best
    // effort: not every Chromium honours it, which is why the per-call timeout
    // and the re-anchor path both stay.
    try { await chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch { /* fine */ }
    return { tabId: tab.id, roleId, owned: false };
  }
  // A frozen or role-less user tab is deliberately left alone rather than
  // reloaded: it is theirs, reloading discards whatever they had on screen, and
  // it was measured at 193 s to still fail. Opening our own is ~20 s.
  return null;
}

/** Our own background tab: walks the SAML hand-off and proves it has a token. */
async function openAnchor() {
  let opened;
  try {
    opened = await chrome.tabs.create({ url: ROOT_URL, active: false });
  } catch (e) {
    throw new MedalliaError(`Could not open a Medallia tab: ${e?.message ?? e}`, "TAB");
  }
  // Registered so the shared reaper closes it if anything below throws.
  await registerSessionTab("cx", opened.id);
  try { await chrome.tabs.update(opened.id, { autoDiscardable: false }); } catch { /* fine */ }

  const roleId = await waitForLanding(opened.id, 60_000);
  if (!roleId) {
    await closeTab(opened.id);
    throw new MedalliaError(
      "Medallia session is not active. Open walmart.medallia.com in a tab, sign in, then refresh.",
      "AUTH",
    );
  }

  // Landed is not the same as ready: the token has to actually be in the
  // document. Ours to reload, so give it one before giving up.
  if (!await pingTab(opened.id)) {
    try { await chrome.tabs.reload(opened.id); } catch { /* falls through */ }
    await waitForLanding(opened.id, 45_000);
    if (!await pingTab(opened.id)) {
      await closeTab(opened.id);
      throw new MedalliaError(
        "The Medallia tab loaded but never served a CSRF token. Open walmart.medallia.com, sign in, then refresh.",
        "AUTH",
      );
    }
  }
  return { tabId: opened.id, roleId, owned: true };
}

/**
 * Replace a dead anchor mid-pull.
 *
 * A tab that has frozen once will freeze again, and reloading a borrowed tab is
 * not ours to do — so the recovery is a fresh tab of our own, not a repair.
 */
async function reanchor(dead) {
  if (dead?.owned) await closeTab(dead.tabId);
  return openAnchor();
}

async function closeTab(tabId) {
  try { await chrome.tabs.remove(tabId); } catch { /* already gone */ }
  try { await forgetSessionTab(tabId); } catch { /* best effort */ }
}

/**
 * Is this tab awake and inside the reporting app?
 *
 * One regex against the DOM: an awake tab answers in well under a second, and a
 * frozen one never answers at all, so the short deadline is what actually
 * distinguishes them. Cheap enough to run before every pull, which is the point
 * — the pull's first real page should never be the thing that discovers the
 * anchor is dead.
 */
async function pingTab(tabId) {
  try {
    const r = await execScriptWithTimeout({
      target: { tabId },
      world: "MAIN",
      func: () => /csrfToken:\s*"([^"]+)"/.test(document.documentElement.outerHTML),
    }, PING_TIMEOUT_MS);
    return r?.[0]?.result === true;
  } catch {
    return false;
  }
}

/**
 * Wait for the SAML hand-off to settle somewhere that carries a roleId.
 *
 * Any loaded `/sso/walmart/` page that is not one of the hand-off endpoints
 * counts. Requiring `/applications/` here was a bug: the landing page depends on
 * the user's default view, and a session that lands on `/sso/walmart/pages/`
 * would have waited out the whole timeout and reported the session dead.
 */
async function waitForLanding(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(700);
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { return null; }
    const url = tab.url || "";
    if (SSO_HOP_RE.test(url)) continue;
    if (!MEDALLIA_URL_RE.test(url)) continue;
    if (tab.status !== "complete") continue;
    const roleId = roleIdFromUrl(url);
    if (roleId) return roleId;
  }
  return null;
}

function roleIdFromUrl(url) {
  try {
    return new URL(url).searchParams.get("roleId") || null;
  } catch {
    return null;
  }
}

async function waitForComplete(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { return; }
    if (tab.status === "complete") return;
    await sleep(400);
  }
}

// ── The POST, executed in the page ──────────────────────────────────────

async function postInTab(anchor, query, variables, operationName) {
  const { tabId, roleId } = anchor;
  let results;
  try {
    results = await execScriptWithTimeout({
      target: { tabId },
      world: "MAIN",
      // Must be pure — this function is serialized into the page and closes
      // over nothing.
      func: async (role, dataView, op, q, vars) => {
        // The CSRF token is rendered into the page HTML and nowhere else:
        // window.CONFIGURATION is empty by the time a script can read it, and
        // it is not a cookie.
        const csrf = /csrfToken:\s*"([^"]+)"/.exec(document.documentElement.outerHTML)?.[1];
        if (!csrf) return { __err: "NO_CSRF" };
        try {
          const res = await fetch(`/api-comp/reporting/query?view_as_role=${encodeURIComponent(role)}`, {
            method: "POST",
            credentials: "include",
            headers: {
              "content-type": "application/json",
              "accept": "application/json",
              "x-csrf-token": csrf,
              "x-medallia-active-role-id": role,
              "x-medallia-reporting-query-data-view": dataView,
            },
            body: JSON.stringify({ operationName: op, variables: vars, query: q }),
          });
          const text = await res.text();
          let json;
          try { json = JSON.parse(text); }
          catch { return { __err: `NON_JSON ${res.status}: ${text.slice(0, 200)}` }; }
          return { __status: res.status, json };
        } catch (e) {
          return { __err: String(e?.message ?? e) };
        }
      },
      args: [roleId, DATA_VIEW, operationName, query, variables],
    });
  } catch (e) {
    // TAB, not HTTP: a hang or a thrown executeScript means the tab is frozen,
    // discarded or gone — which the pull loop recovers from by re-anchoring.
    throw new MedalliaError(`Could not run the query in the Medallia tab: ${e?.message ?? e}`, "TAB");
  }

  const out = results?.[0]?.result;
  if (!out) throw new MedalliaError("The Medallia tab returned nothing.", "TAB");
  if (out.__err === "NO_CSRF") {
    throw new MedalliaError(
      "Medallia did not serve a CSRF token — the session is probably signed out. Open walmart.medallia.com, sign in, then refresh.",
      "AUTH",
    );
  }
  if (out.__err) throw new MedalliaError(`Medallia request failed: ${out.__err}`, "HTTP");

  const json = out.json;
  // Medallia answers an unauthenticated POST with HTTP 200 wrapping a 401
  // BODY, so the status alone never reveals it.
  if (json?.status === 401 || /unauthoriz/i.test(json?.error || "")) {
    throw new MedalliaError(
      "Medallia rejected the request as unauthorized. Open walmart.medallia.com, sign in, then refresh.",
      "AUTH",
    );
  }
  if (json?.errors?.length) {
    const msg = json.errors.map((e) => e.message).join("; ").slice(0, 400);
    throw new MedalliaError(`Medallia GraphQL error: ${msg}`, "HTTP");
  }
  return json;
}

// ── Normalisation ───────────────────────────────────────────────────────

/**
 * One Medallia record to the compact shape the rest of the module stores.
 *
 * Topic sentiment is resolved by span overlap: the sentiment region covering a
 * topic region wins, else the whole-comment sentiment, else UNSPECIFIED. The
 * raw region indices are dropped — nothing downstream highlights inside the
 * text, and keeping them roughly doubles the stored size of a year.
 */
export function normalizeRecord(node) {
  const comment = pickComment(node.commentData);
  return {
    id:        node.id,
    ts:        node.timestamp || null,                 // "YYYY-MM-DD HH:MM:SS"
    day:       (node.timestamp || "").slice(0, 10) || null,
    journey:   node.journey?.[0] ?? null,
    channel:   channelOf(node.subject?.[0]),
    score:     toScore(node.scoreFieldData?.[0]?.values?.[0]),
    field:     comment?.fieldName ?? null,
    text:      comment?.text ?? "",
    topics:    comment?.topics ?? [],                  // [{ name, sentiment }]
    sentiment: comment?.overall ?? null,
  };
}

// Records carry one populated comment field; prefer the longest text when more
// than one comes back so a one-word field never beats the real verbatim.
function pickComment(commentData) {
  if (!Array.isArray(commentData) || !commentData.length) return null;

  let best = null;
  for (const c of commentData) {
    const text = (c.textsWithLanguage?.[0]?.text ?? "").trim();
    if (!text) continue;
    if (!best || text.length > best.text.length) {
      best = { text, fieldName: c.field?.name ?? c.field?.id ?? null, raw: c };
    }
  }
  if (!best) return null;

  const raw = best.raw;
  const sentimentRegions = raw.matchingTaggings?.sentimentRegions ?? [];
  const topicRegions     = raw.matchingTaggings?.topicRegions ?? [];
  const overall          = raw.sentimentTaggings?.[0]?.sentiment ?? null;

  // Dedupe by topic name — Medallia often tags the same topic on several
  // spans of one comment, and counting each span would weight a long rambling
  // comment like several separate complaints.
  const byName = new Map();
  for (const tr of topicRegions) {
    const overlap = sentimentRegions.find(
      (s) => tr.startIndex < s.endIndex && s.startIndex < tr.endIndex,
    );
    const sentiment = overlap?.sentiment ?? overall ?? "UNSPECIFIED";
    for (const t of tr.topics ?? []) {
      if (!t?.name) continue;
      const prev = byName.get(t.name);
      // A negative reading of a topic outranks a neutral one on the same
      // comment: the complaint is the actionable half.
      if (!prev || rank(sentiment) > rank(prev.sentiment)) {
        byName.set(t.name, { name: t.name, sentiment });
      }
    }
  }

  return { text: best.text, fieldName: best.fieldName, overall, topics: [...byName.values()] };
}

// Only used to break ties when one comment tags a topic twice: prefer the
// reading that carries an opinion, negative first.
function rank(sentiment) {
  switch (sentiment) {
    case "STRONGLY_NEGATIVE": return 5;
    case "NEGATIVE":          return 4;
    case "MIXED_OPINION":     return 3;
    case "STRONGLY_POSITIVE": return 2;
    case "POSITIVE":          return 1;
    default:                  return 0;
  }
}

// subject is "1458 - FORT OGLETHORPE - GA | Surveys". Only the part after the
// pipe is useful (Surveys / Google Reviews / Store LTP / ...); the store half
// is the same on every row by construction.
function channelOf(subject) {
  if (!subject) return null;
  const i = subject.lastIndexOf("|");
  return (i === -1 ? subject : subject.slice(i + 1)).trim() || null;
}

function toScore(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
