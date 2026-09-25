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

import { withSessionTabs, registerSessionTab } from "../../../shared/tabSessions.js";
import { COMMENTS_QUERY, commentsVariables, DATA_VIEW } from "./medallia_query.js";

const ROOT_URL    = "https://walmart.medallia.com/sso/walmart/";
const TAB_PATTERN = "https://walmart.medallia.com/*";
// The SSO hand-off pages. A fetch from one of these has no reporting session
// yet, so they are not usable as an anchor tab.
const SSO_HOP_RE  = /\/(ssoLoginRequest|samlRequest|logonSubmit)\.do/i;
// An anchor tab must be inside the reporting app, which is where the csrfToken
// is rendered.
const APP_URL_RE  = /walmart\.medallia\.com\/sso\/walmart\/applications\//i;

/**
 * Records per request. 1000 measured at 714 KB / 14 s against a 52-week window;
 * 2000 also works but a single failure then costs 24 s of re-fetch, and the
 * whole-pull saving is under 20%.
 */
export const PAGE_SIZE = 1000;

/** Guard against an unbounded loop if the cursor ever stops advancing. */
const MAX_PAGES = 60;

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
    const { tabId, roleId } = await anchorTab();

    const records = [];
    let cursor = null, total = null, pages = 0, stoppedEarly = false;

    do {
      const vars = commentsVariables({ from, to, limit: PAGE_SIZE, cursor });
      const page = await postInTab(tabId, roleId, COMMENTS_QUERY, vars, "cxComments");
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

    return { records, total: total ?? records.length, pages, stoppedEarly, roleId };
  });
}

// ── Anchor tab ──────────────────────────────────────────────────────────

async function anchorTab() {
  // Reuse a reporting-app tab the user already has open before opening one.
  const existing = (await chrome.tabs.query({ url: TAB_PATTERN }))
    .filter((t) => APP_URL_RE.test(t.url || "") && !SSO_HOP_RE.test(t.url || ""));

  if (existing.length) {
    const tab = existing[0];
    await waitForComplete(tab.id, 15_000);
    const roleId = roleIdFromUrl(tab.url);
    if (roleId) return { tabId: tab.id, roleId };
    // An app tab with no roleId is unusual; fall through and open our own
    // rather than guessing one.
  }

  let opened;
  try {
    opened = await chrome.tabs.create({ url: ROOT_URL, active: false });
  } catch (e) {
    throw new MedalliaError(`Could not open a Medallia tab: ${e?.message ?? e}`, "TAB");
  }
  // Registered so the shared reaper closes it if anything below throws.
  await registerSessionTab("cx", opened.id);

  // The root URL walks the SAML hand-off and lands on the user's own default
  // page with the roleId filled in. Wait for that landing, not just for load.
  const landed = await waitForAppLanding(opened.id, 45_000);
  if (!landed) {
    throw new MedalliaError(
      "Medallia session is not active. Open walmart.medallia.com in a tab, sign in, then refresh.",
      "AUTH",
    );
  }
  return { tabId: opened.id, roleId: landed };
}

async function waitForAppLanding(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(700);
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { return null; }
    const url = tab.url || "";
    if (SSO_HOP_RE.test(url)) continue;
    if (!APP_URL_RE.test(url)) continue;
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

async function postInTab(tabId, roleId, query, variables, operationName) {
  let results;
  try {
    results = await chrome.scripting.executeScript({
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
