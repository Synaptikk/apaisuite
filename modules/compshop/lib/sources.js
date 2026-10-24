// modules/compshop/lib/sources.js
//
// Three reads, all from the service worker:
//
// 1. Comp Shop scans — Power BI "Comp Shop App - WIP" (Ops Portal → Comp
//    Shopper → wmlink.wal-mart.com/compshopper redirects here). Entity
//    "Scan Data", one row per competitor scan: WM Store, Comp Store, Comp
//    Store Address, Scan Date, WM GTIN, Comp Item Desc, Comp Retail, WM Rtl
//    at Scan, TPA Actioned, Category, Subcategory. We build the query
//    ourselves (shared/pbi_query.js) filtered to one store: the report keeps
//    each user's slicers, so its own visuals can't be trusted for scope.
//    Transport comes from digitallocks's Power BI capture ring (it records
//    every QES request; market120's only keeps ISA ones) in a background
//    tab we open and close.
//
// 2. Weekly ads — Flipp (backflipp.wishabi.com), by the competitor store's
//    zip. Items carry name, price, image and valid dates; no UPC and no size.
//    Both 1458 competitors are listed (merchants "ALDI" and "FoodCity").
//
// 3. Product photo + walmart.com name — walmart.com search by the GTIN
//    without its check digit returns exactly that item; cached for good.

import {
  MAX_WINDOW, buildQuery, column, decodeRows, pickTransport, readResult, whereIn,
} from "../../../shared/pbi_query.js";
import { execScript, waitForTabLoad } from "../../market120/lib/sources/clearance_stores_tableau.js";
import { isProduceName } from "./model.js";

const REPORT_URL = "https://app.powerbi.com/groups/me/reports/cbcff18a-97ef-432f-85d9-ad0f4399e5e8/ce2bea466f93a46f0a2d?ctid=3cbcc3d3-094d-4006-9849-0d11d61f484d&experience=power-bi";
const ENTITY = "Scan Data";
const FROM = [{ Name: "s", Entity: ENTITY }];

const TRANSPORT_KEY        = "compshop.pbiTransport";
const TRANSPORT_MAX_AGE_MS = 45 * 60_000;
const TRANSPORT_WAIT_MS    = 60_000;
const LOAD_TIMEOUT_MS      = 30_000;
const QUERY_TIMEOUT_MS     = 60_000;
const FETCH_TIMEOUT_MS     = 20_000;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };
const toMs = (v) => (typeof v === "number" ? v : Date.parse(v)) || 0;
// Scan Date is a calendar date stored as UTC midnight; read in Eastern time
// it lands on the evening before (Oct 21 showed as Oct 20). Re-anchor it to
// local noon on the same calendar day.
const scanDay = (v) => {
  const ms = toMs(v);
  if (!ms) return 0;
  const d = new Date(ms);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12).getTime();
};

// ── 1. Comp Shop scans ─────────────────────────────────────────────
export async function fetchScans(store) {
  const res = await runQuery({
    select: [
      ["comp", column("s", "Comp Store")], ["address", column("s", "Comp Store Address")],
      ["date", column("s", "Scan Date")], ["gtin", column("s", "WM GTIN")],
      ["desc", column("s", "Comp Item Desc")], ["price", column("s", "Comp Retail")],
      ["wm", column("s", "WM Rtl at Scan")], ["tpa", column("s", "TPA Actioned")],
      ["cat", column("s", "Category")], ["sub", column("s", "Subcategory")],
    ],
    where: [whereIn(column("s", "WM Store"), [String(store)])],
  });
  if (!res.ok) return res;
  const scans = res.rows.map((r) => ({
    comp: String(r.comp || "").trim(), address: String(r.address || "").trim(),
    date: scanDay(r.date), gtin: String(r.gtin ?? "").replace(/\D/g, ""),
    desc: String(r.desc || "").trim(), price: num(r.price), wm: num(r.wm),
    tpa: Number(r.tpa) || 0, cat: r.cat || "", sub: r.sub || "",
  })).filter((s) => s.comp && s.gtin);
  return { ok: true, scans };
}

async function runQuery({ select, where }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = await getTransport({ fresh: attempt > 0 });
    if (!t.ok) return t;
    const res = await postQuery(t.transport, buildQuery({ modelId: t.transport.modelId, from: FROM, select, where }));
    if (res.auth && attempt === 0) { await chrome.storage.session.remove(TRANSPORT_KEY).catch(() => {}); continue; }
    if (!res.ok) return res;
    if (!res.complete) {
      return { ok: false, errorClass: "TRUNCATED", error: `The Comp Shop query hit Power BI's ${MAX_WINDOW.toLocaleString("en-US")}-row limit.` };
    }
    return res;
  }
  return { ok: false, errorClass: "AUTH", error: "Power BI rejected the session token twice. Open Power BI once to sign in, then Refresh." };
}

async function postQuery(transport, body) {
  let resp;
  try {
    resp = await fetch(transport.url, {
      method: "POST",
      headers: {
        "Authorization": transport.auth,
        "Content-Type": "application/json;charset=UTF-8",
        "X-PowerBI-HostEnv": "Power BI Web App",
        "Accept": "application/json, text/plain, */*",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, errorClass: "NETWORK", error: `Power BI query failed: ${e?.message ?? e}` };
  }
  const text = await resp.text();
  if (resp.status === 401 || resp.status === 403 || /^\s*</.test(text)) {
    return { ok: false, auth: true, errorClass: "AUTH", error: `Power BI returned HTTP ${resp.status} (session token expired?).` };
  }
  if (!resp.ok) return { ok: false, errorClass: "HTTP", error: `Power BI HTTP ${resp.status}: ${text.slice(0, 200)}` };
  let json;
  try { json = JSON.parse(text); } catch { return { ok: false, errorClass: "PARSE", error: "Power BI response was not JSON." }; }
  const { complete, error } = readResult(json);
  if (error) return { ok: false, errorClass: "QUERY", error: `Power BI rejected the query: ${error}` };
  return { ok: true, rows: decodeRows(json), complete };
}

async function getTransport({ fresh = false } = {}) {
  if (!fresh) {
    try {
      const t = (await chrome.storage.session.get(TRANSPORT_KEY))[TRANSPORT_KEY];
      if (t?.auth && Date.now() - (t.cachedAt || 0) < TRANSPORT_MAX_AGE_MS) return { ok: true, transport: t };
    } catch {}
  }
  const captured = await captureTransport();
  if (!captured) {
    return {
      ok: false, errorClass: "NO_CAPTURE",
      error: `The Comp Shop report did not load within ${TRANSPORT_WAIT_MS / 1000}s. Open Ops Portal → Comp Shopper once to sign in to Power BI, then Refresh.`,
    };
  }
  await chrome.storage.session.set({ [TRANSPORT_KEY]: { ...captured, cachedAt: Date.now() } }).catch(() => {});
  return { ok: true, transport: captured };
}

// Open the report in our own background tab, take url + token + modelId from
// its first "Scan Data" query, close the tab.
async function captureTransport() {
  const tab = await chrome.tabs.create({ url: REPORT_URL, active: false }).catch(() => null);
  if (!tab) return null;
  try {
    await waitForTabLoad(tab.id, LOAD_TIMEOUT_MS);
    const deadline = Date.now() + TRANSPORT_WAIT_MS;
    while (Date.now() < deadline) {
      try {
        const results = await execScript({
          target: { tabId: tab.id, allFrames: true },
          world:  "MAIN",
          args:   [ENTITY],
          func:   (entity) => {
            const cap = window.__APAISUITE_DIGITALLOCKS_CAP;
            if (!cap) return null;
            const needle = new RegExp(`"Entity":\\s*"${entity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`);
            return cap.all()
              .filter((e) => e.url && e.reqBody && needle.test(e.reqBody) &&
                (e.reqHeaders?.Authorization || e.reqHeaders?.authorization))
              .slice(-3)
              .map((e) => ({ url: e.url, auth: e.reqHeaders.Authorization || e.reqHeaders.authorization, body: e.reqBody, capturedAt: e.capturedAt }));
          },
        }, 15_000);
        const entries = (results || []).flatMap((r) => (Array.isArray(r?.result) ? r.result : []));
        const transport = pickTransport(entries, { entity: ENTITY });
        if (transport) return transport;
      } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }
    return null;
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// ── 2. Weekly ads (Flipp) ──────────────────────────────────────────
const FLIPP = "https://backflipp.wishabi.com/flipp";
const merchantKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
  return r.json();
}

/**
 * Flyers for each competitor whose dates touch [from, to].
 * @param {Array<{name, zip}>} comps
 * @returns {{ ads: object[], flyers: object[], missing: string[], errors: string[] }}
 */
export async function fetchAds(comps, { from, to }) {
  const ads = [], flyers = [], missing = [], errors = [];
  const byZip = new Map();
  for (const c of comps) if (c.zip) (byZip.get(c.zip) || byZip.set(c.zip, []).get(c.zip)).push(c);
  for (const [zip, list] of byZip) {
    let all;
    try { all = await getJson(`${FLIPP}/flyers?locale=en-us&postal_code=${encodeURIComponent(zip)}`); }
    catch (e) { errors.push(`Flipp ${zip}: ${e.message}`); continue; }
    all = Array.isArray(all) ? all : (all?.flyers || []);
    for (const c of list) {
      const key = merchantKey(c.name);
      const mine = all.filter((f) => {
        const m = merchantKey(f.merchant);
        return m && (m === key || m.startsWith(key) || key.startsWith(m));
      }).filter((f) => Date.parse(f.valid_to) >= from && Date.parse(f.valid_from) <= to);
      if (!mine.length) { missing.push(c.name); continue; }
      for (const f of mine) {
        flyers.push({ comp: c.name, id: f.id, name: f.name || "", from: Date.parse(f.valid_from), to: Date.parse(f.valid_to) });
        let items;
        try { items = await getJson(`${FLIPP}/flyers/${f.id}?locale=en-us`); }
        catch (e) { errors.push(`Flipp flyer ${f.id}: ${e.message}`); continue; }
        const mineAds = [];
        for (const it of items?.items || []) {
          const price = num(it.price);
          if (!(price > 0) || !it.name) continue;
          mineAds.push({
            comp: c.name, flyerId: f.id, flyerName: f.name || "", id: it.id, name: String(it.name).trim(), price,
            from: Date.parse(it.valid_from || f.valid_from), to: Date.parse(it.valid_to || f.valid_to),
            img: String(it.cutout_image_url || "").replace(/^http:/, "https:"),
          });
        }
        await addDealText(mineAds.filter((a) => isProduceName(a.name)));
        ads.push(...mineAds);
      }
    }
  }
  return { ads, flyers, missing, errors };
}

// The flyer list has only name + price. The item detail carries the deal
// ("12 FOR" $10.00, "GET 2 FREE"), the unit ("/lb") and the size line
// ("Each", "6 oz") — what Comp Shop's units/weight fields ask for. Fetched
// for produce only (~30 a week).
async function addDealText(list) {
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const a = list[next++];
      try {
        const d = await getJson(`${FLIPP}/items/${a.id}`);
        const x = d?.item || d || {};
        a.pre = String(x.pre_price_text || "").trim();
        a.post = String(x.post_price_text || "").trim();
        a.sale = String(x.sale_story || "").trim();
        a.size = String(x.description || "").split("\n").map((s) => s.trim()).filter(Boolean)[0] || "";
      } catch { /* keep the bare price */ }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
}

// ── 3b. Our item for an ad: walmart.com in-store search ───────────
// Prices come from walmart.com's default store (assortmentStoreId 100,
// Bentonville): the store is held server-side per session, and neither a
// stores= parameter nor the assortmentStoreId cookie moved it to 1458
// (tested 2026-10-23). So "our price" here is walmart.com's, labelled so.
const priceLine = (it, type) => it?.priceInfo?.priceDetails?.priceLines?.find((l) => l.lineType === type)?.values?.[0]?.value || "";

// Fresh Produce department. Without it "apple tote" returned tote bags and
// the keyword fallback picked a $30.95 handbag for ALDI's SweeTango apples.
const PRODUCE_CAT = "976759_976793";
export const isProduceDept = (path) => /\/Fresh Produce\//i.test(path || "");

/** Top in-store walmart.com Fresh Produce results for a phrase. */
export async function searchOurs(query, { limit = 10 } = {}) {
  const url = `https://www.walmart.com/search?q=${encodeURIComponent(query)}&facet=fulfillment_method_in_store%3AIn-store&cat_id=${PRODUCE_CAT}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`walmart.com HTTP ${r.status}`);
  const m = (await r.text()).match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("walmart.com page had no data (blocked?)");
  const data = JSON.parse(m[1]);
  return (data?.props?.pageProps?.initialData?.searchResult?.itemStacks || [])
    .flatMap((s) => s.items || []).filter((i) => i.usItemId && i.name && Number(i.price) > 0)
    // The department filter is a request, not a guarantee: keep produce only.
    .filter((i) => !i.category?.categoryPath || isProduceDept(i.category.categoryPath))
    .slice(0, limit)
    .map((i) => ({
      id: String(i.usItemId), name: i.name, price: num(i.price),
      unitText: priceLine(i, "UNIT_PRICE"),            // "50.0 ¢/lb", "$0.48/oz"
      shown: priceLine(i, "DISPLAY_CONDITION"),        // "each (est.)"
      sold: i.salesUnitType || "",                     // EACH | EACH_WEIGHT | WEIGHT
      dept: i.category?.categoryPath || "",
      img: i.imageInfo?.thumbnailUrl || i.image || "",
    }));
}

/** The UPC on an item's walmart.com product page. */
export async function fetchUpc(usItemId) {
  const r = await fetch(`https://www.walmart.com/ip/${encodeURIComponent(usItemId)}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`walmart.com HTTP ${r.status}`);
  return ((await r.text()).match(/"upc":"(\d{6,14})"/) || [])[1] || "";
}

// ── 3. walmart.com photo + name ────────────────────────────────────
// `exact` (a GTIN search) only accepts a single hit; a keyword search takes
// the first result and is marked `similar` so the view can say so.
export async function lookupItem(query, { exact = true } = {}) {
  const r = await fetch(`https://www.walmart.com/search?q=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`walmart.com HTTP ${r.status}`);
  const html = await r.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("walmart.com page had no data (blocked?)");
  const data = JSON.parse(m[1]);
  const items = (data?.props?.pageProps?.initialData?.searchResult?.itemStacks || [])
    .flatMap((s) => s.items || []).filter((i) => i.usItemId);
  // A GTIN search that hits finds exactly one item; anything else is a
  // keyword search falling back to loose matches, which would show the
  // wrong photo.
  if (exact ? items.length !== 1 : !items.length) return { none: true };
  const it = items[0];
  const img = it.imageInfo?.thumbnailUrl || it.image || "";
  return exact
    ? { name: it.name || "", img, id: it.usItemId }
    : { name: "", img, id: it.usItemId, similar: true, similarTo: it.name || "" };
}
