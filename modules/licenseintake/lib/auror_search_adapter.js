// modules/licenseintake/lib/auror_search_adapter.js
//
// Search Auror for a person record matching a scanned license. GLOBAL by
// name — not store-scoped (homeStore is APPRISS's concern, not ours).
//
// Strategy: hit Auror's `SearchApi/searchPeople` directly with the
// `searchString` URL param populated and NO `siteTraits` filter. This is
// the same endpoint AurorBuddy uses for its store-scan flow, but
// AurorBuddy always sends searchString="" and a store filter. Populating
// searchString + omitting siteTraits gives a name-based global search.
//
// We also strip AurorBuddy's "actionable" filter (≥2 events, ≥$100,
// ≤$10k) — for license intake we want to find the person even if they
// have a single low-value event. The operator decides relevance.
//
// PII rules:
//   - Console logs report counts + masked queryFingerprint only — never
//     names, never DOB. Reasons strings ARE safe (describe what
//     matched, not the values).
//   - The raw response is normalized and discarded.

import { createAuth } from "../../../shared/auth.js";
import { MATCH_CLASS } from "./intake_models.js";
// Direct in-SW import so we can invoke aurorbuddy.preflight() as a
// fallback when our cold-path JWT read returns empty.
import { handlers as _aurorbuddy } from "../../aurorbuddy/service.js";

const AUROR_BASE = "https://app.us.auror.co";
const SEARCH_PEOPLE_URL = `${AUROR_BASE}/api/spa/SearchApi/searchPeople`;
const AUROR_JWT_TTL_MS = 20 * 60 * 1000;
const AUROR_JWT_STORAGE_KEY = "aurorbuddy.auror.jwt";
const REQUEST_TIMEOUT_MS = 15_000;

// Share AurorBuddy's JWT capture (it's the only owner of the
// webRequestFilter for auror.co; we just read).
const _aurorAuth = createAuth("aurorbuddy");
const _jwtReader = _aurorAuth.getCapturedHeader("auror.jwt", AUROR_JWT_TTL_MS);

/**
 * Resolve the Auror JWT through a fallback chain that survives cold SW
 * wakes.
 *
 * The shell SW pre-warms the in-memory map from chrome.storage.session
 * asynchronously. If a module reads the JWT BEFORE that IIFE finishes,
 * `_jwtReader.get()` returns empty even though the cached value exists.
 * Fallbacks below close the gap:
 *
 *   1. In-memory map (hot path — instant)
 *   2. chrome.storage.session.get (cold path — sub-millisecond)
 *   3. aurorbuddy.preflight() (opens an Auror tab if both above fail)
 *
 * @param {{ skipPreflight?: boolean }} [opts]
 * @returns {Promise<string>}
 */
async function resolveAurorToken(opts = {}) {
  // Path 1: in-memory map (synchronous, fastest)
  let token = _jwtReader.get();
  if (token) return token;

  // Path 2: chrome.storage.session (covers the pre-warm race after SW wake)
  try {
    const got = await chrome.storage.session.get(AUROR_JWT_STORAGE_KEY);
    const saved = got?.[AUROR_JWT_STORAGE_KEY];
    if (saved?.value && Date.now() - (saved.at ?? 0) < AUROR_JWT_TTL_MS) {
      return saved.value;
    }
  } catch { /* fall through */ }

  if (opts.skipPreflight) return "";

  // Path 3: ask AurorBuddy's preflight to ensure auth (may open Auror tab).
  // Same chain AurorBuddy itself walks for its own handlers.
  try {
    const pre = await _aurorbuddy?.preflight?.({}, null);
    const ok = pre && (pre.ok === true || pre.data?.auror);
    if (ok) {
      // Re-read after preflight populates the map / storage.
      token = _jwtReader.get();
      if (token) return token;
      const got = await chrome.storage.session.get(AUROR_JWT_STORAGE_KEY);
      const saved = got?.[AUROR_JWT_STORAGE_KEY];
      if (saved?.value) return saved.value;
    }
  } catch (err) {
    console.warn("[licenseintake/search] preflight fallback failed:", err?.message || err);
  }
  return "";
}

/**
 * @typedef {import("./license_parser.js").LicensePerson} LicensePerson
 * @typedef {import("./intake_models.js").AurorPersonCandidate} AurorPersonCandidate
 */

function queryFingerprint(person) {
  const lastLen = (person?.lastName || "").length;
  return `lastLen=${lastLen} hasFirst=${!!person?.firstName} hasDob=${!!person?.dob}`;
}

/**
 * Search Auror for a person by name. Primary path drives Auror's own UI
 * search bar (via the auror_inline.js content script) — the SearchApi
 * endpoint we used to hit tokenizes literally and misses typo'd records,
 * but the UI's autocomplete does fuzzy matching server-side. We fall
 * back to the API if no Auror tab is available.
 *
 * @param {LicensePerson} person
 * @param {{
 *   dryRun?: boolean,
 *   days?: string,
 *   signal?: AbortSignal,
 * }} [opts]
 * @returns {Promise<{
 *   status: "ok" | "error" | "dry_run",
 *   candidates: AurorPersonCandidate[],
 *   matchClass: string,
 *   error?: string,
 *   notes: string[],
 * }>}
 */
export async function searchPersonByName(person, opts = {}) {
  const dryRun = !!opts.dryRun;
  const notes = [];

  if (!person?.lastName) {
    return {
      status: "error",
      candidates: [],
      matchClass: MATCH_CLASS.Error,
      error: "no last name on parsed person",
      notes,
    };
  }

  console.info(`[licenseintake/search] start (${queryFingerprint(person)}) dryRun=${dryRun}`);

  if (dryRun) {
    const candidates = synthesizeDryRunCandidates(person);
    const scored = candidates.map((c) => scoreAurorPersonMatch(person, c));
    notes.push("dry_run: returning synthetic candidate list");
    return { status: "dry_run", candidates: scored, matchClass: classifyByDisplayOrder(scored), notes };
  }

  // ── PRIMARY: drive Auror's own UI search bar ─────────────────────
  // Uses the same React component the operator uses manually. The
  // dropdown returns fuzzy / partial / alias matches that the JSON
  // searchPeople API misses entirely.
  const query = person.firstName
    ? `${person.firstName} ${person.lastName}`.trim()
    : person.lastName;

  try {
    const uiCandidates = await searchPersonViaUI(query, notes);
    if (uiCandidates && uiCandidates.length > 0) {
      const scored = uiCandidates.map((c) => scoreAurorPersonMatch(person, c));
      scored.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));
      const top5 = scored.slice(0, 5);
      const matchClass = classifyByDisplayOrder(top5);
      notes.push(`UI search returned ${uiCandidates.length} candidate(s)`);
      console.info(`[licenseintake/search] done via UI: ${top5.length} of ${uiCandidates.length}, class=${matchClass}`);
      return { status: "ok", candidates: top5, matchClass, notes };
    }
    notes.push("UI search returned 0 candidates — falling back to SearchApi");
  } catch (err) {
    const msg = err?.message || String(err);
    // Common cause: content script not loaded into the existing Auror
    // tab (extension reload doesn't re-inject into already-open tabs).
    // Surface that hint front-and-center.
    const hint = /receiving end|no response/i.test(msg)
      ? " — RELOAD the Auror tab (F5) to inject the latest content script, then retry."
      : "";
    notes.push(`UI search unavailable: ${msg}${hint}`);
    console.warn(`[licenseintake/search] UI search failed:`, msg, hint);
  }

  // ── FALLBACK: SearchApi/searchPeople ─────────────────────────────
  const token = await resolveAurorToken();
  if (!token) {
    return {
      status: "error",
      candidates: [],
      matchClass: MATCH_CLASS.Error,
      error: "no Auror JWT — open Auror in a tab and sign in, then retry",
      notes,
    };
  }

  const queries = [
    { str: query, maxPages: 1 },
    { str: person.firstName || null, maxPages: 3 },
  ].filter((q, i, arr) => q.str && arr.findIndex((x) => x.str === q.str) === i);

  const seen = new Map();
  let lastErr = null;
  const PAGE_SIZE = 20;
  const STOP_AFTER = 80;

  for (const q of queries) {
    if (seen.size >= STOP_AFTER) break;
    for (let page = 0; page < q.maxPages; page++) {
      try {
        const rows = await fetchSearchPeopleByName({
          token,
          searchString: q.str,
          // Omit time filter — Auror rejects most enum values with 400;
          // server default returns a wider window than Last30days.
          days: opts.days || null,
          skip: page * PAGE_SIZE,
          signal: opts.signal,
        });
        notes.push(`fallback "${maskQuery(q.str)}" page=${page} returned ${rows.length} row(s)`);
        if (rows.length === 0) break;
        for (const row of rows) {
          const cand = normalizeFromSearchApi(row);
          const key = cand.pNumber || cand.identityGroupId || cand.displayName;
          if (key && !seen.has(key)) seen.set(key, cand);
        }
        if (rows.length < PAGE_SIZE) break;
        if (seen.size >= STOP_AFTER) break;
      } catch (err) {
        lastErr = err;
        notes.push(`fallback "${maskQuery(q.str)}" page=${page} failed: ${err?.message || String(err)}`);
        break;
      }
    }
  }

  if (seen.size === 0 && lastErr) {
    return {
      status: "error",
      candidates: [],
      matchClass: MATCH_CLASS.Error,
      error: lastErr?.message || String(lastErr),
      notes,
    };
  }

  let scored = [...seen.values()].map((c) => scoreAurorPersonMatch(person, c));
  if (person.firstName && person.lastName) {
    scored = scored.filter((c) => {
      const r = c.matchReasons || [];
      const hasFirst = r.some((x) => /^first/.test(x) && !/no last name link/.test(x));
      const hasLast = r.some((x) => /^last/.test(x));
      return hasFirst && hasLast;
    });
  }
  scored.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));
  const top5 = scored.slice(0, 5);
  const matchClass = classifyByDisplayOrder(top5);
  console.info(`[licenseintake/search] done via fallback: ${top5.length} of ${seen.size}, class=${matchClass}`);
  return { status: "ok", candidates: top5, matchClass, notes };
}

/**
 * Send the auror_inline.js content script a "li_drive_search" message,
 * which types the query into Auror's UI search bar and reads the
 * autocomplete dropdown results. Returns AurorPersonCandidate[] or
 * throws if no Auror tab is available.
 *
 * @param {string} query
 * @param {string[]} notes  diagnostic notes (mutated)
 */
async function searchPersonViaUI(query, notes) {
  const tabs = await chrome.tabs.query({ url: ["https://app.us.auror.co/*", "https://*.auror.co/*"] });
  if (!tabs || tabs.length === 0) {
    throw new Error("no Auror tab open — open https://app.us.auror.co/ first");
  }
  // Pick the most-recently-active Auror tab.
  const tab = tabs.find((t) => t.active) || tabs[0];
  notes.push(`UI search via tab ${tab.id}`);
  return await new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(
      tab.id,
      { module: "licenseintake", type: "li_drive_search", query, timeoutMs: 5000 },
      (resp) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (!resp) return reject(new Error("no response from Auror tab content script"));
        if (!resp.ok) return reject(new Error(resp.error || "UI search failed"));
        resolve(resp.candidates || []);
      },
    );
  });
}

/**
 * Classify based on the Auror-returned top-5 set: if the #1 result has
 * a strong fuzzy/exact last+first match, call it STRONG; if multiple
 * candidates have reasonable signals, MULTIPLE_POSSIBLE; if at least
 * one cleared a low bar, POSSIBLE_MATCH; else NO_MATCH.
 *
 * @param {Array<AurorPersonCandidate>} scored
 */
function classifyByDisplayOrder(scored) {
  if (scored.length === 0) return MATCH_CLASS.NoMatch;
  const top = scored[0];
  const tops = scored.filter((c) => c.matchScore >= 0.8);
  const poss = scored.filter((c) => c.matchScore >= 0.5 && c.matchScore < 0.8);
  if (tops.length === 1 && top.matchScore >= 0.8) return MATCH_CLASS.StrongMatch;
  if (tops.length > 1) return MATCH_CLASS.MultiplePossible;
  if (poss.length || top.matchScore >= 0.5) return MATCH_CLASS.PossibleMatch;
  // Auror returned rows but our scorer thinks none look like real matches.
  // Still surface them — Auror knows things we don't (recent activity, etc.).
  return MATCH_CLASS.PossibleMatch;
}

/**
 * Issue one searchPeople request with a name query. Returns raw rows.
 *
 * Endpoint shape mirrors AurorBuddy's lib/auror.js (verified live).
 * We just populate `searchString` and omit `siteTraits` for a global
 * search. Some param values are picky:
 *   - timeRangeFilter: "Last30days" / "Last90days" / "LastYear" are
 *     known-valid (per AurorBuddy). "AllTime" returns HTTP 400.
 *   - eventTypeFilters: leave OFF for global search across all event types.
 */
async function fetchSearchPeopleByName({ token, searchString, days, skip = 0, signal }) {
  const params = new URLSearchParams();
  params.append("configCaptureApiCalls", "");
  params.append("configProfile", "");
  params.append("endDate", "");
  params.append("incidentCountMin", "0");
  params.append("includeTotalResultCount", "true");
  params.append("searchString", searchString);
  // No siteTraits = global search.
  params.append("skip", String(skip));
  params.append("sortBy", "");
  params.append("startDate", "");
  // Auror only accepts a narrow set of timeRangeFilter values
  // ("Last30days" / "Last90days" / "LastYear" — anything else → 400).
  // Omitting the param entirely makes the server fall back to its
  // default (which, in practice, returns more than Last30days does).
  if (days) params.append("timeRangeFilter", days);
  params.append("totalValueMin", "0");

  const url = `${SEARCH_PEOPLE_URL}?${params.toString()}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort("timeout"), REQUEST_TIMEOUT_MS);
  if (signal) signal.addEventListener("abort", () => ac.abort(signal.reason));

  try {
    const r = await fetch(url, {
      method: "GET",
      credentials: "include",
      signal: ac.signal,
      headers: {
        Authorization: token,
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json, text/plain, */*",
      },
    });
    if (r.status === 401 || r.status === 403) {
      throw new Error("Auror returned 401/403 — reload your Auror tab to refresh JWT and retry");
    }
    if (!r.ok) {
      // 4xx — capture a short snippet of the response so we can debug
      // what the server is complaining about. The body shouldn't contain
      // PII for a 4xx (it's our query that was bad), but truncate
      // defensively.
      let detail = "";
      try {
        const body = await r.text();
        detail = body ? ` body="${body.slice(0, 200)}"` : "";
      } catch { /* ignore */ }
      throw new Error(`Auror searchPeople failed: HTTP ${r.status}${detail}`);
    }
    const json = await r.json();
    return json?.searchResults ?? [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Normalize a single `searchResults` row into AurorPersonCandidate
 * shape. Row keys follow AurorBuddy's lib/auror.js::toSuspect contract
 * (verified live).
 *
 * @param {Object} row
 * @returns {AurorPersonCandidate}
 */
export function normalizeFromSearchApi(row) {
  if (!row || typeof row !== "object" || row.intelType !== "Person") {
    return emptyCandidate();
  }
  const rid = row.resourceLocator || "";
  const personId = /^p/i.test(rid) ? rid.slice(1) : rid;
  const name = row.primaryIdentifier || "";
  return {
    identityGroupId: null,
    pNumber: personId ? `P${personId}` : null,
    displayName: name || null,
    dob: null, // SearchApi/searchPeople does not surface DOB
    lastEventDate: null,
    aurorUrl: personId ? `${AUROR_BASE}/person/${encodeURIComponent(personId)}` : null,
    eventCount: Number(row.eventCount ?? 0),
    totalValue: Math.round(Number(row.totalValue ?? 0) * 100) / 100,
    threatening: !!row.hasThreateningBehaviors,
    isOrc: !!row.isOrganizedRetailCrime,
    photoUrl: row.image?.thumbnailMediumUrl || row.image?.thumbnailSmallUrl || null,
    matchScore: 0,
    matchReasons: [],
  };
}

/**
 * Backwards-compat alias kept for future callers (e.g. if a different
 * endpoint surfaces). Identical to normalizeFromSearchApi for now.
 */
export const normalizeAurorPersonResult = normalizeFromSearchApi;

function emptyCandidate() {
  return {
    identityGroupId: null, pNumber: null, displayName: null,
    dob: null, lastEventDate: null, aurorUrl: null,
    matchScore: 0, matchReasons: [],
  };
}

/**
 * Score a candidate against the scanned LicensePerson. 0..1.
 *
 * Scoring philosophy:
 *   - Last name is the dominant signal (people share first names; few
 *     share a surname AND first name AND DOB).
 *   - Fuzzy last name (≤2 edits) catches Auror typos like Duckworth→Duckwortth.
 *   - First name only (without a last name match) is heavily discounted:
 *     "Bryson Smith" should NOT match a scan of "Bryson Duckworth" just
 *     because the first name is the same.
 *   - DOB exact match is a strong tiebreaker when present on both sides.
 *
 * @param {LicensePerson} person
 * @param {AurorPersonCandidate} cand
 */
export function scoreAurorPersonMatch(person, cand) {
  const reasons = [];
  let score = 0;
  const candName = (cand.displayName || "").toLowerCase();
  const wantFirst = (person.firstName || "").toLowerCase();
  const wantLast = (person.lastName || "").toLowerCase();

  const tokens = candName.split(/[\s,.]+/).filter(Boolean);

  // ── Last name ────────────────────────────────────────────────
  let lastNameHit = "none";
  let lastNameScore = 0;
  if (wantLast) {
    if (tokens.some((t) => t === wantLast)) {
      lastNameHit = "exact";
      lastNameScore = 0.5;
      reasons.push("last name exact match");
    } else {
      // Fuzzy: any token within edit distance 2 of the wanted last name.
      let bestDist = Infinity;
      let bestToken = null;
      for (const t of tokens) {
        if (Math.abs(t.length - wantLast.length) > 2) continue;
        const d = levenshtein(t, wantLast);
        if (d < bestDist) { bestDist = d; bestToken = t; }
      }
      if (bestDist === 1) {
        lastNameHit = "fuzzy1";
        lastNameScore = 0.42;
        reasons.push(`last name near-match (1 edit: "${bestToken}")`);
      } else if (bestDist === 2 && wantLast.length >= 5) {
        lastNameHit = "fuzzy2";
        lastNameScore = 0.3;
        reasons.push(`last name near-match (2 edits: "${bestToken}")`);
      } else if (candName.includes(wantLast)) {
        lastNameHit = "substring";
        lastNameScore = 0.2;
        reasons.push("last name substring match");
      }
    }
  }
  score += lastNameScore;

  // ── First name ───────────────────────────────────────────────
  // Only worth meaningful points if the last name also matched —
  // otherwise common first names produce too many false positives.
  // Initial-only match is restricted to the FIRST token of the
  // candidate (where initials actually live in names); middle-name
  // letters like "Blake" in "Jammi Blake Duckworth" must NOT count
  // as a "B" initial match for a scanned "Bryson".
  if (wantFirst && candName) {
    const firstExact = tokens.some((t) => t === wantFirst);
    const lastMatched = lastNameHit !== "none";
    const firstToken = tokens[0] || "";
    const firstInitialOnly = firstToken && firstToken !== wantFirst && firstToken.charAt(0) === wantFirst.charAt(0);
    if (firstExact && lastMatched) {
      score += 0.25;
      reasons.push("first name exact match");
    } else if (firstExact) {
      // Standalone first-name match: very small bump only.
      score += 0.05;
      reasons.push("first name exact (no last name link)");
    } else if (firstInitialOnly && lastMatched) {
      score += 0.05;
      reasons.push("first initial match");
    }
  }

  // ── DOB ──────────────────────────────────────────────────────
  if (person.dob && cand.dob && person.dob === cand.dob) {
    score += 0.3;
    reasons.push("DOB exact match");
  }

  if (score > 1) score = 1;
  return { ...cand, matchScore: score, matchReasons: reasons };
}

/**
 * Iterative Levenshtein distance (edits required to turn a into b).
 * O(n*m) time, O(min(n,m)) space. Fine for short strings (last names).
 */
function levenshtein(a, b) {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  // Ensure b is the shorter to minimize the row buffer.
  if (lb > la) { const t = a; a = b; b = t; }
  const m = a.length, n = b.length;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,       // deletion
        curr[j - 1] + 1,   // insertion
        prev[j - 1] + cost // substitution
      );
    }
    const tmp = prev; prev = curr; curr = tmp;
  }
  return prev[n];
}

export function chooseBestMatch(candidates, threshold = 0.5) {
  if (!candidates?.length) return null;
  const sorted = [...candidates].sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));
  const top = sorted[0];
  if (!top || top.matchScore < threshold) return null;
  return top;
}

/**
 * Legacy helper kept for tests and the chooseBestMatch export — the
 * live search path now uses classifyByDisplayOrder instead.
 */
function scoreAndClassify(person, candidates) {
  const scored = candidates.map((c) => scoreAurorPersonMatch(person, c));
  if (scored.length === 0) return { candidates: scored, matchClass: MATCH_CLASS.NoMatch };
  const strong = scored.filter((c) => c.matchScore >= 0.8);
  const possible = scored.filter((c) => c.matchScore >= 0.5 && c.matchScore < 0.8);
  if (strong.length === 1) return { candidates: scored, matchClass: MATCH_CLASS.StrongMatch };
  if (strong.length > 1)   return { candidates: scored, matchClass: MATCH_CLASS.MultiplePossible };
  if (possible.length)     return { candidates: scored, matchClass: MATCH_CLASS.PossibleMatch };
  return { candidates: scored, matchClass: MATCH_CLASS.NoMatch };
}

export function createPersonDraft(person) {
  return {
    firstName: person?.firstName ?? null,
    middleName: person?.middleName ?? null,
    lastName: person?.lastName ?? null,
    dob: person?.dob ?? null,
    sex: person?.sex ?? null,
    heightInches: person?.heightInches ?? null,
    weightPounds: person?.weightPounds ?? null,
    licenseNumber: person?.licenseNumber ?? null,
    expirationDate: person?.expirationDate ?? null,
    address: {
      street: person?.address1 ?? null,
      city: person?.city ?? null,
      state: person?.state ?? null,
      postal: person?.postalCode ?? null,
    },
    source: "barcode_scanner",
    submitState: "draft_only",
    _confirmationRequired: true,
  };
}

function maskQuery(q) {
  // For logging: show length + first letter only.
  if (!q) return "(empty)";
  return `${q.charAt(0)}*** (len=${q.length})`;
}

function synthesizeDryRunCandidates(person) {
  const last = person.lastName || "Doe";
  const first = person.firstName || "Jane";
  return [
    {
      identityGroupId: "ig_dryrun_001",
      pNumber: "P0000001",
      displayName: `${first} ${last}`,
      dob: person.dob || null,
      lastEventDate: "2026-04-01",
      aurorUrl: null,
      matchScore: 0,
      matchReasons: [],
    },
    {
      identityGroupId: "ig_dryrun_002",
      pNumber: "P0000002",
      displayName: `${first.charAt(0)}. ${last}`,
      dob: null,
      lastEventDate: "2025-12-15",
      aurorUrl: null,
      matchScore: 0,
      matchReasons: [],
    },
  ];
}
