// modules/costinventory/lib/onewalmart.js
//
// Beginning Inventory (worksheet row 14) from the OneWalmart "Beginning
// Inventory Store Lookup Tool".
//
// Two things about this source are load-bearing:
//
//  1. The POST is rejected with a bare 403 unless it carries a `CSRF-Token`
//     header fetched from AEM's own token endpoint. No cookie, referer or
//     X-Requested-With substitutes for it.
//  2. The tool is re-published every month under a NEW toolId (its heading
//     reads "... - Sept"). Hard-coding the id works until the month turns and
//     then silently serves last month's numbers, so the id is discovered from
//     the page by matching the lookup table's column headers instead.
//
// The tool lives on /merchandise/fresh.html — NOT the Food-Fresh-and-
// Consumables process page, which only links to it.

const PAGE_URL   = "https://one.walmart.com/content/uswire/en_us/work1/merchandise/fresh.html";
const TOKEN_URL  = "https://one.walmart.com/libs/granite/csrf/token.json";
const LOOKUP_URL = "https://one.walmart.com/content/api/adp/lookuptools.json";

// The lookup table we want, identified by what it shows rather than by id.
const WANTED_HEADERS = ["store number", "dept", "inventory dollars", "format"];

export class OneWalmartError extends Error {}

/**
 * Beginning inventory at cost, keyed by department number.
 * @returns {Promise<{ byDept: Record<number, number>, toolId: string,
 *                     heading: string|null, lastUpdated: string|null, format: string|null }>}
 */
export async function fetchBeginningInventory(storeNbr) {
  const { toolId, heading } = await discoverToolId();
  const token = await fetchCsrfToken();

  const res = await fetch(LOOKUP_URL, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "CSRF-Token": token,
    },
    body: "toolId=" + encodeURIComponent(toolId) + "&primaryId=" + encodeURIComponent(storeNbr),
  });
  if (!res.ok) {
    throw new OneWalmartError("lookuptools " + res.status + " (SSO expired? open one.walmart.com and retry)");
  }

  const json = await res.json();
  const rows = json?.data ?? [];
  if (!rows.length) throw new OneWalmartError("no beginning-inventory rows for store " + storeNbr);

  const byDept = {};
  let format = null;
  for (const r of rows) {
    const dept = parseInt(r.column1, 10);
    if (!Number.isFinite(dept)) continue;
    byDept[dept] = money(r.column2);
    format = format ?? r.column3 ?? null;
  }
  return { byDept, toolId, heading, lastUpdated: json?.metadata?.lastUpdated ?? null, format };
}

/**
 * Find the current month's tool id by parsing the page. Regex rather than
 * DOMParser because this runs in the service worker, where DOMParser does not
 * exist.
 */
export async function discoverToolId() {
  const res = await fetch(PAGE_URL, { credentials: "include" });
  if (!res.ok) throw new OneWalmartError("fresh.html " + res.status);
  const html = await res.text();

  const candidates = [];
  for (const m of html.matchAll(/<table[^>]*id="([0-9a-f]{32})"[^>]*>([\s\S]{0,1500}?)<\/thead>/g)) {
    const headers = [...m[2].matchAll(/<th>([\s\S]*?)<\/th>/g)]
      .map((h) => h[1].replace(/<[^>]*>/g, "").trim().toLowerCase());
    candidates.push({ id: m[1], headers });
  }

  const hit = candidates.find((c) =>
    c.headers.length === WANTED_HEADERS.length &&
    WANTED_HEADERS.every((w) => c.headers.includes(w)));

  if (!hit) {
    const seen = candidates.map((c) => c.headers.join("/")).join(" | ") || "none";
    throw new OneWalmartError(
      "beginning-inventory lookup tool not found on fresh.html — its columns may have been " +
      "renamed, or the tool was pulled for the month. Tables seen: " + seen);
  }

  // The heading carries the month the tool was published for ("... - Sept"),
  // which is worth showing in the UI so a stale tool is visible rather than
  // silently trusted.
  const heading = /Beginning Inventory Store Lookup Tool[^<]{0,40}/.exec(html)?.[0]?.trim() ?? null;
  return { toolId: hit.id, heading };
}

async function fetchCsrfToken() {
  const res = await fetch(TOKEN_URL, { credentials: "include" });
  if (!res.ok) throw new OneWalmartError("csrf token " + res.status);
  const t = (await res.json())?.token;
  if (!t) throw new OneWalmartError("csrf token endpoint returned no token");
  return t;
}

/** "$14,929.09" -> 14929.09 */
function money(s) {
  const n = Number(String(s ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}
