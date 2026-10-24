// modules/compshop/service.js
//
// Comp Shop Prep — service-worker half.
//   get  { store? }  → { ok, data }              cached doc (no network)
//   pull { store? }  → { ok, data, warnings }    Flipp ads + our walmart.com match + Power BI scans
//   upc  { id }      → { ok, upc }               UPC for a walmart.com item the user picked
//   ai_status        → { ok, status }            AI gateway sign-in state (shared with Cx)
//   ai_sign_in       → { ok, status }            run the gateway sign-in (same token Cx uses)
//
// The ads drive the list: every produce item in a competitor ad running
// within a week of today is searched on walmart.com (in-store results), the
// best match picked (lib/model.js::pickCandidate) and its UPC read off the
// product page. The Power BI comp-shop scans only add context — the
// competitor list, and 1458's shelf price at the last comp scan.
//
// Doc (chrome.storage.local compshop.data.<store>):
//   { store, pulledAt, comps: [{name, address, zip}], scans: [...],
//     ads: [...], flyers: [...], adWindow: {from, to},
//     matches: {query → walmart.com candidates}, upcs: {walmart.com id → upc} }
// Photos for scanned items (compshop.images) and UPCs (compshop.upcs) are
// cached across pulls.
// Nothing here writes to Comp Shop, Power BI or any pricing system.

import { fetchScans, fetchAds, lookupItem, searchOurs, fetchUpc } from "./lib/sources.js";
import { parseGtin } from "./lib/barcode.js";
import { photoQuery, isProduceName, splitAdName, adQuery, pickCandidate, linkKey, unitPrice } from "./lib/model.js";
import { aiMatch, gatewayStatus, PROMPT_VERSION } from "./lib/ai_match.js";
import { runPuppyAuth } from "../cx/lib/puppy_auth.js";
import { writeSettings } from "../cx/lib/store.js";
import { tokenStatus } from "../cx/lib/narrative.js";
import { getUserHomeStore } from "../../shared/userStore.js";
import { withKeepAwake } from "../../shared/sw_keepalive.js";
import { singleFlight } from "../safetyagent/lib/single_flight.js";

const MODULE_ID = "compshop";
const DATA_KEY = (store) => `${MODULE_ID}.data.${store}`;
const LAST_STORE_KEY = `${MODULE_ID}.lastStore`;
const IMAGES_KEY = `${MODULE_ID}.images`;
const UPCS_KEY = `${MODULE_ID}.upcs`;
const AI_KEY = `${MODULE_ID}.aiPicks`;          // row key → { id, confidence, sameSize, note, retryQuery, sig }
const LINKS_KEY = `${MODULE_ID}.adLinks`;       // written by the view (host.storage, same namespace)
const DAY = 86_400_000;
const AD_SPAN_DAYS = 7;            // ads that run within a week either side of today
const PHOTO_DAYS = 365;            // look up photos for items scanned this recently
const PHOTO_RETRY_MS = 7 * DAY;    // a miss is retried after a week
const PHOTO_BATCH = 200;           // per pull, so a first pull stays a few minutes
const PHOTO_VERSION = 2;           // bump to re-look-up every cached photo
const PHOTO_WORKERS = 4;

const pullFlight = singleFlight();
const fail = (e) => ({ ok: false, error: String(e?.message || e) });

function progress(text) {
  chrome.runtime.sendMessage({ module: MODULE_ID, type: "progress", payload: { text } }).catch(() => {});
}

async function resolveStore(store) {
  const s = String(store || (await chrome.storage.local.get(LAST_STORE_KEY))[LAST_STORE_KEY] || await getUserHomeStore() || "").trim();
  return /^\d{1,5}$/.test(s) ? s : null;
}

async function readDoc(store) {
  const s = await resolveStore(store);
  if (!s) return null;
  const got = await chrome.storage.local.get([DATA_KEY(s), IMAGES_KEY, UPCS_KEY, AI_KEY]);
  const doc = got[DATA_KEY(s)];
  return doc ? { ...doc, images: got[IMAGES_KEY] || {}, upcs: got[UPCS_KEY] || {}, aiPicks: got[AI_KEY] || {} } : null;
}

const zipOf = (address) => (String(address).match(/\b(\d{5})(?:-\d{4})?\s*$/) || [])[1] || "";

async function pull(msg) {
  const store = await resolveStore(msg?.store);
  if (!store) return { ok: false, error: "No store number. Set your home store in the suite settings." };
  const warnings = [];

  // Scans are context only: when Power BI is down, keep the last ones.
  const prev = (await chrome.storage.local.get(DATA_KEY(store)))[DATA_KEY(store)] || null;
  progress(`Reading store ${store}'s comp shop scans from Power BI…`);
  let scans = await fetchScans(store);
  if (!scans.ok || !scans.scans.length) {
    if (!prev?.scans?.length) return scans.ok ? { ok: false, error: `Power BI has no comp shop scans for store ${store}, so the competitor list is unknown.` } : scans;
    warnings.push(`Power BI scans not refreshed (${scans.error || "no rows"}); using the ones from ${new Date(prev.pulledAt).toLocaleDateString("en-US")}.`);
    scans = { ok: true, scans: prev.scans };
  }

  const comps = [];
  for (const s of scans.scans) {
    if (!comps.some((c) => c.name === s.comp)) comps.push({ name: s.comp, address: s.address, zip: zipOf(s.address) });
  }

  progress(`Reading weekly ads for ${comps.map((c) => c.name).join(" and ")}…`);
  const now = Date.now();
  const adWindow = { from: now - AD_SPAN_DAYS * DAY, to: now + AD_SPAN_DAYS * DAY };
  const ads = await fetchAds(comps, adWindow).catch((e) => ({ ads: [], flyers: [], missing: [], errors: [String(e?.message || e)] }));
  if (ads.missing.length) warnings.push(`No weekly ad found online for ${ads.missing.join(", ")}: only scanned prices are shown for them.`);
  warnings.push(...ads.errors);

  // Our item for each produce ad row: walmart.com in-store search, then the
  // UPC of the picked (or user-linked) result.
  const links = (await chrome.storage.local.get(LINKS_KEY))[LINKS_KEY] || {};
  const upcs = (await chrome.storage.local.get(UPCS_KEY))[UPCS_KEY] || {};
  const rows = [];
  const seenRow = new Set();
  for (const a of ads.ads) {
    if (!isProduceName(a.name) || a.to < adWindow.from || a.from > adWindow.to) continue;
    const deal = unitPrice(a);
    for (const part of splitAdName(a.name)) {
      const key = linkKey(a.comp, part);
      if (seenRow.has(key)) continue;
      seenRow.add(key);
      rows.push({
        part, key, ad: { size: a.size, qty: deal.qty },
        ai: { key, comp: a.comp, name: part, price: deal.unit, deal: [deal.qty > 1 ? `${deal.qty} for ${a.price.toFixed(2)}` : "", a.post, a.sale].filter(Boolean).join(" "), size: a.size || "" },
      });
    }
  }
  const queries = [...new Set(rows.map((r) => adQuery(r.part)).filter(Boolean))];
  const matches = {};
  let searchErrors = 0, qi = 0;
  const searchWorker = async () => {
    while (qi < queries.length && searchErrors < 5) {
      const q = queries[qi++];
      try { matches[q] = await searchOurs(q); } catch { searchErrors++; }
      if (qi % 5 === 0) progress(`Finding our items for the ads (${qi} of ${queries.length})…`);
    }
  };
  await Promise.all(Array.from({ length: PHOTO_WORKERS }, searchWorker));
  if (searchErrors >= 5) warnings.push("walmart.com stopped answering searches; some ad items have no match yet.");

  // AI pick of the comparable item (lib/ai_match.js). Cached per row against
  // the candidate list it saw, so a refresh only asks about new or changed
  // ads. A row with no comparable candidate gets one retry search.
  const aiPicks = { ...((await chrome.storage.local.get(AI_KEY))[AI_KEY] || {}) };
  const candsFor = (r) => {
    const extra = aiPicks[r.key]?.retryQuery;
    const list = [...(matches[adQuery(r.part)] || []), ...(extra ? matches[extra] || [] : [])];
    return list.filter((c, i) => list.findIndex((x) => x.id === c.id) === i);
  };
  const gw = await gatewayStatus().catch(() => ({ ok: false }));
  if (!gw.ok) {
    warnings.push("AI matching is off: press “Sign in to AI matching” (top right) so Claude can pick the comparable items. Using the keyword match for now.");
  } else {
    const ask = async (list) => aiMatch(list.map((r) => ({ ...r.ai, cands: candsFor(r) })));
    try {
      const sigFirst = new Map(rows.map((r) => [r.key, `v${PROMPT_VERSION}|` + (matches[adQuery(r.part)] || []).map((c) => c.id).join(",") + `|${r.ai.price}`]));
      // Rows with no candidates go too: the AI answers with a better search.
      let todo = rows.filter((r) => !links[r.key] && aiPicks[r.key]?.sig !== sigFirst.get(r.key));
      if (todo.length) {
        progress(`AI is matching ${todo.length} ad item${todo.length === 1 ? "" : "s"} to our items…`);
        for (const [k, v] of await ask(todo)) aiPicks[k] = { ...v, retryQuery: "" };
      }
      // Nothing fit: search what the AI suggested, then ask again for those rows.
      const retry = rows.filter((r) => aiPicks[r.key] && aiPicks[r.key].retry && !aiPicks[r.key].retried);
      if (retry.length) {
        progress(`Searching again for ${retry.length} item${retry.length === 1 ? "" : "s"} the AI couldn't match…`);
        for (const r of retry) {
          const q = aiPicks[r.key].retry.toLowerCase();
          if (!matches[q]) { try { matches[q] = await searchOurs(q); } catch { matches[q] = []; } }
          aiPicks[r.key].retryQuery = q;
        }
        for (const [k, v] of await ask(retry)) aiPicks[k] = { ...v, retryQuery: aiPicks[k].retryQuery, retried: true };
      }
      // The signature is of the first-pass candidates, so a retried row isn't redone next time.
      for (const r of todo) if (aiPicks[r.key]) aiPicks[r.key].sig = sigFirst.get(r.key);
    } catch (e) {
      warnings.push(`AI matching failed (${e?.message || e}); using the keyword match.`);
    }
    await chrome.storage.local.set({ [AI_KEY]: aiPicks });
  }
  // Retry searches the doc must keep so the view can show those candidates.
  for (const r of rows) {
    const q = aiPicks[r.key]?.retryQuery;
    if (q && !matches[q]) { try { matches[q] = await searchOurs(q); } catch { /* shown without them */ } }
  }

  const wantUpc = new Set();
  for (const r of rows) {
    const ai = aiPicks[r.key]?.id;
    const id = links[r.key] && links[r.key] !== "none" ? links[r.key] : (ai || pickCandidate(r.part, candsFor(r), r.ad));
    if (id && !upcs[id]) wantUpc.add(id);
  }
  const ids = [...wantUpc];
  let ui = 0;
  const upcWorker = async () => {
    while (ui < ids.length) {
      const id = ids[ui++];
      try { const u = await fetchUpc(id); if (u) upcs[id] = u; } catch { /* barcode shows as missing */ }
    }
  };
  progress(`Reading barcodes for ${ids.length} item${ids.length === 1 ? "" : "s"}…`);
  await Promise.all(Array.from({ length: PHOTO_WORKERS }, upcWorker));
  await chrome.storage.local.set({ [UPCS_KEY]: upcs });

  // Photos for the scan-history tab: one walmart.com search per item not yet looked up.
  // Exact UPC first; most bagged produce isn't listed online by its UPC, so
  // fall back to a keyword search on the spelled-out description (a photo of
  // the same kind of produce, flagged `similar`).
  const images = (await chrome.storage.local.get(IMAGES_KEY))[IMAGES_KEY] || {};
  const descOf = new Map();
  for (const s of scans.scans) if (s.date >= now - PHOTO_DAYS * DAY && !descOf.has(s.gtin)) descOf.set(s.gtin, s.desc);
  const todo = [...descOf.keys()].filter((g) => {
    const c = images[g];
    return !c || c.v !== PHOTO_VERSION || (c.none && now - (c.at || 0) > PHOTO_RETRY_MS);
  }).slice(0, PHOTO_BATCH);
  // Sequential took ~2.5 s an item (8.5 min for 200, measured 2026-10-23).
  let photoErrors = 0, next = 0, done = 0;
  const worker = async () => {
    while (next < todo.length && photoErrors < 5) {
      const g = todo[next++];
      const key = parseGtin(g).searchKey;
      try {
        let hit = key && key.length >= 6 ? await lookupItem(key) : { none: true };   // PLUs: no exact search
        const text = photoQuery(descOf.get(g));
        if (hit.none && text) hit = await lookupItem(text, { exact: false });
        images[g] = { ...hit, v: PHOTO_VERSION, at: now };
      } catch { photoErrors++; }
      if (++done % 10 === 0) progress(`Looking up product photos (${done} of ${todo.length})…`);
    }
  };
  await Promise.all(Array.from({ length: PHOTO_WORKERS }, worker));
  if (photoErrors >= 5) warnings.push("walmart.com stopped answering photo lookups; the rest will be tried on the next Refresh.");
  await chrome.storage.local.set({ [IMAGES_KEY]: images });

  const doc = { store, pulledAt: now, comps, scans: scans.scans, ads: ads.ads, flyers: ads.flyers, adWindow, matches };
  await chrome.storage.local.set({ [DATA_KEY(store)]: doc, [LAST_STORE_KEY]: store });
  progress("");
  return { ok: true, data: { ...doc, images, upcs, aiPicks }, warnings };
}

export const handlers = {
  async get(msg) {
    try { return { ok: true, data: await readDoc(msg?.store) }; }
    catch (e) { return fail(e); }
  },
  async ai_status() {
    try { return { ok: true, status: await gatewayStatus() }; } catch (e) { return fail(e); }
  },
  // Same flow and storage as Cx's "Sign in": the token lands in cx.settings.v1
  // and never leaves the service worker.
  async ai_sign_in() {
    try {
      const { token } = await withKeepAwake(`${MODULE_ID}.signin`, () => runPuppyAuth({}));
      const status = tokenStatus(token);
      if (!status.ok) return { ok: false, error: "The sign-in returned a token that is already expired." };
      await writeSettings({ gatewayToken: token });
      return { ok: true, status };
    } catch (e) { return fail(e); }
  },
  // The view's item picker chose a walmart.com item we have no UPC for yet.
  async upc(msg) {
    try {
      const id = String(msg?.id || "");
      if (!/^\d+$/.test(id)) return { ok: false, error: "bad item id" };
      const upcs = (await chrome.storage.local.get(UPCS_KEY))[UPCS_KEY] || {};
      if (!upcs[id]) {
        upcs[id] = await fetchUpc(id);
        await chrome.storage.local.set({ [UPCS_KEY]: upcs });
      }
      return { ok: true, upc: upcs[id] };
    } catch (e) { return fail(e); }
  },
  async pull(msg) {
    try {
      return await pullFlight("pull", () => withKeepAwake(`${MODULE_ID}.pull`, () => pull(msg)));
    } catch (e) { return fail(e); }
  },
};
