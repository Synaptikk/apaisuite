// modules/registerls/lib/workview.js
//
// APPRISS WorkView — the queue of register long/short work items that must
// be dispositioned. Wire shape recorded in dev/REGISTER_LS_FINDINGS.md §1.
//
// Two long/short producers exist in WorkView:
//   sourceAppId "mel"       — "Action Required: Long/Short Item" (Master
//                             Exception List). Unique id = store|reg|date|abs.
//   sourceAppId "overshort" — "Long/Short - Cash" rules such as "SCO Cash
//                             Advance within Cash Shortage Amt". Register and
//                             finalized amount live in cardSections.
// Everything else in the queue (refunds, missed scans, WIN match) is listed
// as a generic card (normalizeOtherItem) so the store's whole open queue is
// visible; only register items get the long/short analysis.

import { APPRISS_BASE, APPRISS_HOME, apprissReauthInBackground } from "../../../shared/appriss.js";
import { classifyAuthResponse, isAuthFailureStatus } from "../../../shared/auth.js";

export const LIST_URL   = `${APPRISS_BASE}/platform/workview/api/v2/workviewItems`;
export const DETAIL_URL = (id) => `${APPRISS_BASE}/platform/workview#/detail/${id}?id=${id}`;
export const LIST_PAGE_URL = (storeNbr, fromIso, toIso) =>
  `${APPRISS_BASE}/platform/workview#/list?viewType=unassigned&sorting=priority:desc` +
  `&fromDate=${fromIso}T00:00:00&toDate=${toIso}T23:59:59&hierarchyId=1&hierarchyLevel=0&hierarchyLocation=${storeNbr}`;

export const LS_SOURCE_APPS = new Set(["mel", "overshort"]);

// ── Pure: normalize the list payload ───────────────────────────────

export function isLongShortItem(raw) {
  return LS_SOURCE_APPS.has(String(raw?.sourceAppId || "").toLowerCase());
}

// "8/16/2026" | "2026-08-16" | "2026-08-16T00:00:00" → "2026-08-16"
export function toIsoDate(v) {
  const s = String(v ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}

export function moneyToCents(v) {
  const s = String(v ?? "").replace(/[$,\s]/g, "");
  if (!s) return null;
  const neg = /^-|-$|^\(.*\)$/.test(s);
  const n = parseFloat(s.replace(/[-()]/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) * (neg ? -1 : 1);
}

function section(raw, re) {
  const hit = (raw?.cardSections || []).find((c) => re.test(String(c?.label || "")));
  return hit ? String(hit.value ?? "") : null;
}

function subject(raw, key) {
  const hit = (raw?.subjects || []).find((s) => s?.key === key);
  return hit ? String(hit.value ?? "") : null;
}

// One WorkView item → QueueItem (or null when it is not a register L/S item).
export function normalizeWorkItem(raw) {
  if (!isLongShortItem(raw)) return null;
  const sourceAppId = String(raw.sourceAppId).toLowerCase();

  let store = null, register = null, date = null, amountCents = null;
  const uid = subject(raw, "vision_mel_master_unique_id");
  if (uid && uid.includes("|")) {
    const [s, r, d, a] = uid.split("|");
    store = s?.trim() || null;
    register = r?.trim() || null;
    date = toIsoDate(d);
    const abs = moneyToCents(a);
    if (abs != null) amountCents = -Math.abs(abs); // MEL only raises shortages; sign fixed below if the card says otherwise
  }
  const cardAmt = moneyToCents(section(raw, /item amount|l\/s amt|long\/short amount|amount/i));
  if (cardAmt != null) amountCents = cardAmt;
  store    = store    || section(raw, /^store/i) || (raw.locationID != null ? String(raw.locationID) : null);
  register = register || section(raw, /register|pos ?#|pos no/i);
  date     = date     || toIsoDate(section(raw, /^date$/i)) || toIsoDate(raw.periodFromDateTime);
  if (amountCents == null) amountCents = moneyToCents(raw.potentialValue) != null ? -Math.abs(moneyToCents(raw.potentialValue)) : null;

  const type = amountCents == null ? "unknown" : amountCents < 0 ? "short" : amountCents > 0 ? "over" : "zero";
  return {
    id:             String(raw.id),
    store:          store ? String(store) : null,
    register:       register ? String(register).replace(/^0+(?=\d)/, "") : null,
    date,
    amountCents,
    amountAbsCents: amountCents == null ? null : Math.abs(amountCents),
    type,
    sourceAppId,
    category:       String(raw.category || ""),
    headLine:       String(raw.headLine || ""),
    priorityId:     raw.priorityID ?? null,
    highPriority:   !!raw.highPriority,
    statusId:       raw.statusID ?? null,
    isOverDue:      !!raw.isOverDue,
    targetResolutionAt: raw.targetResolutionDateTime || null,
    createdAt:      raw.createdDateTime || null,
    periodFrom:     toIsoDate(raw.periodFromDateTime),
    potentialValueCents: moneyToCents(raw.potentialValue),
    uniqueId:       uid,
    detailUrl:      DETAIL_URL(raw.id),
  };
}

// Any other open work item (refunds, missed scans, WIN match, ...): kept as a
// generic card so the queue shows everything the store has to clear, even
// though only register items get the long/short analysis.
export function normalizeOtherItem(raw) {
  const cards = (raw?.cardSections || []).filter((c) => c && c.enabled !== false).map((c) => ({ label: String(c.label ?? ""), value: String(c.value ?? "") }));
  const tags = (raw?.subjects || []).map((s) => ({ label: String(s?.label ?? s?.key ?? ""), value: String(s?.value ?? "") })).filter((t) => t.value);
  return {
    id:           String(raw.id),
    kind:         "other",
    sourceAppId:  String(raw.sourceAppId || "").toLowerCase(),
    sourceApp:    String(raw.sourceApp || ""),
    category:     String(raw.category || ""),
    headLine:     String(raw.headLine || ""),
    description:  String(raw.description || ""),
    store:        cards.find((c) => /^store/i.test(c.label))?.value || (raw.locationID != null ? String(raw.locationID) : null),
    date:         toIsoDate(raw.periodFromDateTime),
    periodTo:     toIsoDate(raw.periodToDateTime),
    potentialValueCents: moneyToCents(raw.potentialValue),
    priorityId:   raw.priorityID ?? null,
    highPriority: !!raw.highPriority,
    isOverDue:    !!raw.isOverDue,
    targetResolutionAt: raw.targetResolutionDateTime || null,
    createdAt:    raw.createdDateTime || null,
    countOfEvents: raw.countOfEvents ?? null,
    cards, tags,
    detailUrl:    DETAIL_URL(raw.id),
  };
}

export function normalizeWorkItems(json) {
  const list = json?.data?.items || json?.items || [];
  const items = [];
  const others = [];
  for (const raw of list) {
    const q = normalizeWorkItem(raw);
    if (q) items.push(q); else others.push(normalizeOtherItem(raw));
  }
  items.sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.amountAbsCents || 0) - (a.amountAbsCents || 0));
  others.sort((a, b) => (b.potentialValueCents || 0) - (a.potentialValueCents || 0) || (b.date || "").localeCompare(a.date || ""));
  return { items, others, otherCount: others.length, total: list.length };
}

// ── Network (service worker) ───────────────────────────────────────

// The list is paged 20 at a time. The first page carries `totalResults`;
// every page carries `endIndex`, which is the next page's `startIndex`
// (verified 2026-09-12: pages at 0 and 19 returned 40 distinct ids).
export const PAGE_SIZE = 20;

export function buildListBody(storeNbr, { days = 30, status = "unassigned", now = new Date(), startIndex = 0 } = {}) {
  const to = now;
  const from = new Date(now.getTime() - days * 86_400_000);
  const iso = (d) => d.toISOString().slice(0, 10);
  return {
    status,
    fromDate: `${iso(from)}T00:00:00`,
    toDate:   `${iso(to)}T23:59:59`,
    include: [], filterTerms: [], subjects: [],
    locationHierarchy: { hierarchyId: 1, level: 0, levelCode: String(storeNbr) },
    sortField: "priority", sortDirection: "descending",
    sourceApp: null, category: null, startIndex,
  };
}

// Pure: given a page's data block, where does the next page start (or null)?
export function nextStartIndex(data, fetchedSoFar) {
  const n = (data?.items || []).length;
  const total = Number(data?.totalResults);
  if (!n || n < PAGE_SIZE) return null;
  if (Number.isFinite(total) && total > 0 && fetchedSoFar >= total) return null;
  return Number.isFinite(data?.endIndex) ? data.endIndex : fetchedSoFar;
}

async function postList(body) {
  let r, text;
  try {
    r = await fetch(LIST_URL, {
      method: "POST", credentials: "include",
      headers: { "content-type": "application/json", accept: "application/json, text/plain, */*", "x-requested-with": "XMLHttpRequest" },
      body: JSON.stringify(body),
    });
    text = await r.text();
  } catch (e) {
    return { ok: false, errorClass: "NETWORK", error: `WorkView fetch failed: ${e?.message || e}` };
  }
  const auth = classifyAuthResponse({ status: r.status, contentType: r.headers.get("content-type") || "", body: text });
  if (isAuthFailureStatus(auth)) {
    return { ok: false, errorClass: "AUTH", authStatus: auth, error: "APPRISS session expired — sign in to Secure, then refresh.", loginUrl: APPRISS_HOME };
  }
  if (!r.ok) return { ok: false, errorClass: "HTTP", error: `WorkView HTTP ${r.status}` };
  let json;
  try { json = JSON.parse(text); } catch { return { ok: false, errorClass: "PARSE", error: "WorkView returned non-JSON" }; }
  if (json?.success === false) return { ok: false, errorClass: "API", error: "WorkView success=false" };
  return { ok: true, data: json.data || {} };
}

// Silent reauth. The SW's WorkView call comes back as the sign-in page once
// the APPRISS session has expired (daily in practice). The mechanics now live
// in shared/appriss.js (`apprissReauthInBackground`) — this file was the third
// copy of them, and boblisa became a fourth caller that shipped without any,
// so the analyst had to open Secure by hand. WorkView's own list call is the
// readiness probe. Kept as a named export because it reads as part of this
// module's API.
export const reauthInBackground = (probe, opts = {}) =>
  apprissReauthInBackground(probe, { moduleId: "registerls", ...opts });

// One list page, with one silent reauth when the session has expired.
async function postListWithReauth(body, state) {
  let res = await postList(body);
  if (res.ok || res.errorClass !== "AUTH" || state.reauthTried) return res;
  state.reauthTried = true;
  const again = await reauthInBackground(() => postList(body));
  if (again.ok) return again.res;
  console.warn("[registerls.workview] silent reauth failed:", again.reason);
  return res;
}

// Every open work item for the store: all pages of the "unassigned" (New)
// view plus the "assigned" (in progress) view. Items are tagged with which
// view they came from. `days` is the date-range filter WorkView applies
// (open items go back months; the default reaches back two years).
export async function fetchWorkItems(storeNbr, { days = 730, statuses = ["unassigned", "assigned"], maxPages = 25, onProgress } = {}) {
  const raw = new Map();
  const totals = {};
  let window = null;
  const authState = { reauthTried: false };
  for (const status of statuses) {
    let startIndex = 0, fetched = 0;
    for (let page = 0; page < maxPages; page++) {
      const body = buildListBody(storeNbr, { days, status, startIndex });
      window = window || { fromDate: body.fromDate, toDate: body.toDate };
      const res = await postListWithReauth(body, authState);
      if (!res.ok) return res;
      const items = res.data.items || [];
      if (page === 0) totals[status] = Number(res.data.totalResults) || items.length;
      for (const it of items) if (!raw.has(it.id)) raw.set(it.id, { ...it, _view: status });
      fetched += items.length;
      onProgress?.({ status, fetched, total: totals[status] });
      const next = nextStartIndex(res.data, fetched);
      if (next == null) break;
      startIndex = next;
    }
  }
  const norm = normalizeWorkItems({ data: { items: [...raw.values()] } });
  for (const list of [norm.items, norm.others]) for (const q of list) q.view = raw.get(Number(q.id))?._view || raw.get(q.id)?._view || "unassigned";
  return { ok: true, ...norm, totals, fetchedAt: new Date().toISOString(), window };
}

// ── Disposition seam (NOT captured yet) ────────────────────────────
//
// WorkView dispositions are done by hand in APPRISS for now. The request
// (Start Work → Disposition → outcome + reason) has not been recorded; once
// it is, implement it here and wire the view's "Disposition" button to it.
export async function dispositionWorkItem(/* id, outcome, reason */) {
  return { ok: false, errorClass: "NOT_IMPLEMENTED", error: "WorkView disposition endpoint not captured yet — disposition in APPRISS." };
}
