// modules/compshop/lib/model.js
//
// Turns the stored doc (service.js) into what the view draws:
//   - one row per item scanned at a competitor (latest scan per competitor),
//     with our price, each competitor's price, the active/upcoming ad price
//     when an ad item is linked to it, and a gap tier (red / yellow / none)
//   - the produce ad items in the ±7-day window, with a suggested link to a
//     scanned item
//
// Links (ad item → our GTIN) are confirmed by the user once and reused every
// week; suggestions are never applied silently.
//
// Pure: no DOM, no chrome.*.

import { parseGtin } from "./barcode.js";

const DAY = 86_400_000;

export const DEFAULT_RULES = Object.freeze({ redPct: 15, redDollar: 1, minGap: 0.01 });

// Ad items: keep fresh produce, drop the snack/frozen/prepared things whose
// names happen to contain a fruit or vegetable.
const PRODUCE_RE = /\b(apples?|bananas?|oranges?|mandarins?|clementines?|cuties|halos|grapes?|\w*berr(y|ies)|lettuce|romaine|salads?|spinach|kale|tomato(es)?|potato(es)?|onions?|peppers?|avocados?|lemons?|limes?|pears?|melons?|cantaloupe|honeydew|watermelon|squash|zucchini|carrots?|broccoli|cauliflower|cucumbers?|cukes?|celery|mushrooms?|pineapples?|mangos?|mangoes|kiwi|cabbage|corn on the cob|sweet corn|pumpkins?|garlic|ginger|peaches|nectarines?|plums?|cherries|pomegranates?|asparagus|green beans|brussels|sweet potato(es)?|yams?|herbs?|cilantro|parsley|produce)\b/i;
// Second half added from Food City's 10/21 ad: chicken salad, Feastables
// pumpkins, Food Club (store-brand pantry) pumpkin/potatoes, Red Gold canned
// tomatoes, tomato paste, spinach dip, a carving kit.
const NOT_PRODUCE_RE = /\b(rings?|puffed|chips?|crisps?|juice|sauce|pie|frozen|canned|dried|candy|soup|salsa|dressing|bread|cake|muffins?|snacks?|bars?|jam|jelly|preserves|seasoning|cereal|yogurt|ice cream|pizza|fries|tots|hash browns?|mix(es)?|tea|soda|water|vodka|wine|beer|lotion|candle|scent|spray|chicken|tenders|instant|paste|dips?|kit|carving|feastables|cheese|pasta|skillet|food club|red gold|stuffed)\b/i;

export const isProduceName = (name) => PRODUCE_RE.test(name || "") && !NOT_PRODUCE_RE.test(name || "");

const singular = (w) => w.replace(/ies$/, "y").replace(/(oes|ches|shes)$/, (m) => m.slice(0, -2)).replace(/s$/, "");
/** The produce words in a name, singular: "Organic Avocados" → ["avocado"]. */
export function produceNouns(name) {
  const re = new RegExp(PRODUCE_RE.source, "gi");
  return [...String(name || "").matchAll(re)].map((m) => singular(m[0].toLowerCase()));
}

/**
 * Flipp deal text → per-unit price. "12 FOR" $10.00 → 12 units, $0.83 each.
 * @param {{price, pre?, post?}} ad
 */
export function unitPrice(ad) {
  const m = String(ad.pre || "").match(/(\d+)\s*(?:for|\/)/i);
  const qty = m ? Number(m[1]) : 1;
  return { qty, unit: qty > 1 ? Math.round(ad.price / qty * 100) / 100 : ad.price };
}

// Comp-shop descriptions are register shorthand ("APPLE FUJI 3# HM",
// "MSH SL WHT 8OZ HM"). Spelled out, they make a walmart.com keyword search
// that finds a photo of the same kind of produce when the UPC itself isn't
// listed online.
const ABBREV = {
  apl: "apple", tom: "tomatoes", msh: "mushrooms", cuke: "cucumber", swtpot: "sweet potatoes", avo: "avocado",
  org: "organic", btrnut: "butternut", sdls: "seedless", wht: "white", whl: "whole", sl: "sliced", crml: "caramel",
  petyel: "petite yellow", petmix: "petite medley", rus: "russet", swt: "sweet", tov: "on the vine", hh: "", hm: "",
  dsd: "", rpc: "", ea: "", bulk: "", prem: "", pk: "pack", "3pk": "3 pack", mini: "mini",
};
export function photoQuery(desc) {
  const words = String(desc || "").toLowerCase().replace(/(\d+)\s*#/g, "$1 lb").replace(/(\d+)oz\b/g, "$1 oz")
    .replace(/(\d+)z\b/g, "$1 oz").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean)
    .map((w) => (w in ABBREV ? ABBREV[w] : w)).filter(Boolean);
  return words.length ? `fresh ${words.join(" ")}` : "";
}

/** Readable item name from the shorthand: "APPLE FUJI 3# HM" → "Apple Fuji 3 lb". */
export function prettyDesc(desc) {
  return photoQuery(desc).replace(/^fresh /, "")
    .replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\b(Lb|Oz)\b/g, (u) => u.toLowerCase());
}

// A competitor more than this far under us is usually a different size or a
// mis-keyed price (cherries: ALDI $0.55 vs our $6.97 on 2026-10-14).
export const SUSPECT_PCT = 60;

export const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const linkKey = (comp, adName) => `${normName(comp)}|${normName(adName)}`;

const dayStart = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** Gap tier for our price vs a competitor price. */
export function tierOf(ours, theirs, rules = DEFAULT_RULES) {
  if (!(ours > 0) || !(theirs > 0)) return { tier: "none", gap: null, pct: null };
  const gap = Math.round((ours - theirs) * 100) / 100;
  const pct = gap / ours * 100;
  if (gap < (rules.minGap ?? 0.01)) return { tier: "none", gap, pct };
  const red = pct >= rules.redPct || gap >= rules.redDollar;
  return { tier: red ? "red" : "yellow", gap, pct };
}

/** Is an ad running on `now`, upcoming (starts within 7 days), or just ended? */
export function adPhase(ad, now = Date.now()) {
  if (ad.from <= now && now <= ad.to) return "active";
  if (ad.from > now) return "upcoming";
  return "ended";
}

export const SUGGEST_MIN = 0.6;

/**
 * Suggest which scanned item an ad item is: the item must share a produce
 * word with the ad ("avocado"), agree on organic, and then score by overlap
 * of the remaining words against our walmart.com name and the spelled-out
 * comp-shop description. ("Organic Avocados" once matched "Organic Cherubs"
 * on the word "organic" alone.)
 * @returns {{ gtin, score }|null}  score 0..1; the view preselects ≥ SUGGEST_MIN
 */
export function suggestLink(adName, items) {
  const stop = new Set(["fresh", "the", "and", "with", "of", "a", "lb", "oz", "ct", "bag", "pack", "pk", "hm", "each", "ea", "whole", "new", "california", "york", "tote", "bulk", "organic", "org"]);
  const words = (s) => normName(s).split(" ").filter((w) => w.length > 2 && !stop.has(w)).map(singular);
  const nouns = new Set(produceNouns(adName));
  const ad = new Set(words(adName));
  if (!nouns.size || !ad.size) return null;
  const organic = /\borganic\b|\borg\b/i.test(adName);
  let best = null;
  for (const it of items) {
    const text = `${it.name} ${prettyDesc(it.desc)}`;
    if (organic !== /\borganic\b/i.test(text)) continue;
    const w = new Set(words(text));
    if (![...nouns].some((n) => w.has(n))) continue;
    let hit = 0;
    for (const x of ad) if (w.has(x)) hit++;
    const score = hit / ad.size;
    // Ties go to the most recently scanned item: 1458 has three blackberry
    // UPCs, and the one last scanned in August carries a stale price.
    if (!best || score > best.score || (score === best.score && (it.oursDate || 0) > best.date)) {
      best = { gtin: it.gtin, score, date: it.oursDate || 0 };
    }
  }
  return best;
}

/**
 * Build the view model.
 * @param {object} doc      service.js doc: { scans, comps, ads, images }
 * @param {object} opts
 *   days      only items scanned in the last `days` (0 = all)
 *   links     { linkKey → gtin | "none" }
 *   rules     tier thresholds
 *   now       clock
 */
export function buildModel(doc, { days = 120, links = {}, rules = DEFAULT_RULES, now = Date.now() } = {}) {
  const since = days > 0 ? dayStart(now) - days * DAY : 0;
  const images = doc?.images || {};
  const byGtin = new Map();

  for (const s of doc?.scans || []) {
    if (!s.gtin || s.date < since) continue;
    let it = byGtin.get(s.gtin);
    if (!it) {
      const p = parseGtin(s.gtin);
      const img = images[s.gtin];
      it = { gtin: s.gtin, barcode: p, desc: s.desc, name: img?.name || "", label: img?.name || prettyDesc(s.desc), img: img?.img || "", imgSimilar: !!img?.similar, cat: s.cat, sub: s.sub, ours: null, oursDate: 0, comps: {}, ads: [] };
      byGtin.set(s.gtin, it);
    }
    // Our price: the shelf price recorded on the newest scan of the item.
    if (s.date >= it.oursDate && s.wm > 0) { it.ours = s.wm; it.oursDate = s.date; }
    const c = it.comps[s.comp];
    if (!c || s.date >= c.date) it.comps[s.comp] = { price: s.price, date: s.date, desc: s.desc, tpa: s.tpa };
  }
  const items = [...byGtin.values()];
  for (const it of items) if (!it.desc) it.desc = Object.values(it.comps)[0]?.desc || "";

  // Ads in the ±7-day window, produce (or anything the user linked).
  const lo = dayStart(now) - 7 * DAY, hi = dayStart(now) + 8 * DAY;
  // Prices compare per unit: "12 for $10" is $0.83 against our each price.
  const ads = [];
  const seen = new Set();
  for (const a of doc?.ads || []) {
    if (a.to < lo || a.from >= hi) continue;
    const key = linkKey(a.comp, a.name);
    const dup = `${key}|${a.price}|${a.from}`;
    if (seen.has(dup)) continue;            // Flipp lists some items twice
    seen.add(dup);
    const linked = links[key];
    if (linked === "none") continue;
    if (!linked && !isProduceName(a.name)) continue;
    const phase = adPhase(a, now);
    const target = linked ? byGtin.get(linked) : null;
    const suggestion = linked ? null : suggestLink(a.name, items);
    const ad = { ...a, ...unitPrice(a), key, phase, linked: linked || "", suggestion };
    ads.push(ad);
    if (target && phase !== "ended") target.ads.push(ad);
  }

  // Effective competitor price per item: a running linked ad beats the last
  // scan; an upcoming ad is shown but does not set today's tier.
  for (const it of items) {
    let best = null;
    for (const [comp, c] of Object.entries(it.comps)) {
      const ad = it.ads.find((a) => a.comp === comp && a.phase === "active");
      const price = ad ? Math.min(ad.unit, c.price || Infinity) : c.price;
      if (price > 0 && (!best || price < best.price)) best = { comp, price, from: ad && ad.unit <= (c.price || Infinity) ? "ad" : "scan" };
    }
    for (const ad of it.ads) {
      if (ad.phase !== "active" || it.comps[ad.comp]) continue;
      if (!best || ad.unit < best.price) best = { comp: ad.comp, price: ad.unit, from: "ad" };
    }
    it.best = best;
    Object.assign(it, tierOf(it.ours, best?.price, rules));
    it.suspect = it.tier !== "none" && it.pct >= SUSPECT_PCT;
    const up = it.ads.filter((a) => a.phase === "upcoming").sort((a, b) => a.unit - b.unit)[0];
    it.upcoming = up ? { ...up, ...tierOf(it.ours, up.unit, rules) } : null;
  }

  const rank = { red: 0, yellow: 1, none: 2 };
  items.sort((a, b) => rank[a.tier] - rank[b.tier] || (b.pct ?? -1e9) - (a.pct ?? -1e9) || a.desc.localeCompare(b.desc));
  ads.sort((a, b) => a.comp.localeCompare(b.comp) || a.from - b.from || a.name.localeCompare(b.name));

  const lastTrip = {};
  for (const s of doc?.scans || []) if (!lastTrip[s.comp] || s.date > lastTrip[s.comp]) lastTrip[s.comp] = s.date;

  return {
    items, ads, lastTrip,
    counts: {
      red: items.filter((i) => i.tier === "red").length,
      yellow: items.filter((i) => i.tier === "yellow").length,
      ads: ads.length,
      unlinked: ads.filter((a) => !a.linked).length,
    },
  };
}

// ── Ad-first view ──────────────────────────────────────────────────
// One row per produce item in a competitor ad running within a week of
// today, matched to our walmart.com item. Scan history only adds context
// (1458's shelf price and the competitor's price at the last comp scan).

/**
 * "Strawberries, Raspberries or Blackberries" → three names; anything whose
 * parts don't each name a produce item stays whole.
 */
export function splitAdName(name) {
  const clean = String(name || "").replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  const parts = clean.split(/\s*,\s*|\s+or\s+|\s*&\s*/i).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2 || parts.length > 4 || !parts.every((p) => produceNouns(p).length)) return [clean];
  // "Whole or Sliced Mushrooms": a part with no noun of its own borrows the last one's.
  return parts;
}

/** walmart.com search phrase for an ad item name. */
export const adQuery = (name) => String(name || "").replace(/\([^)]*\)/g, " ")
  .replace(/\b(selected varieties|new york|california|bite-size|gourmet|jumbo|fruitist|bright farms|tasteful selections|harvest character|tote|clamshell|basket)\b/gi, " ")
  .replace(/[^A-Za-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

// walmart.com results that name a fruit but aren't produce (10/23 run:
// avocado spread for avocados, SunnyD for raspberries, freeze-dried
// chocolate strawberries, crushed red pepper, boxed mashed potatoes,
// apple snack trays, canned pumpkin, pre-cut melon chunks).
const CAND_REJECT_RE = /\b(squeeze|spread|freeze[- ]dried|chocolate|drink|bottles?|crushed|kosher|mashed|servings|dipperz|snacker|tray|chunks|pre-cut|plants?|seeds?|bush|gallon pot|candles?|scented|flavou?red|powder|extract|puree|pure pumpkin|baby food|pouch(es)?)\b/i;

/** "3 Lb." / "9.8 oz" → "3lb" / "9.8oz"; "" when none. */
export function sizeKey(text) {
  const m = String(text || "").match(/(\d+(?:\.\d+)?)\s*(lb|lbs|oz|ounce|pound)s?\b/i);
  if (!m) return "";
  const unit = /^(lb|lbs|pound)$/i.test(m[2]) ? "lb" : "oz";
  return `${Number(m[1])}${unit}`;
}

/** Every weight in a text, in ounces: "16 Oz. or 6 Oz." → [16, 6]; "1 lb" → [16]. */
export function ouncesIn(text) {
  return [...String(text || "").matchAll(/(\d+(?:\.\d+)?)\s*(lb|lbs|oz|ounce|pound)s?\b/gi)]
    .map((m) => Math.round(Number(m[1]) * (/^(lb|lbs|pound)$/i.test(m[2]) ? 16 : 1) * 10) / 10);
}

/**
 * Best walmart.com candidate for an ad item: fresh produce naming the same
 * fruit/vegetable, organic agreeing; then the same pack size, and each-vs-bag
 * agreeing ("12 for $10 … Each" oranges are loose, not the 4 lb bag).
 * @param {object} [ad]  the Flipp ad (size, qty) when known
 */
export function pickCandidate(adName, cands, ad = {}) {
  const nouns = new Set(produceNouns(adName));
  const organic = /\borganic\b/i.test(adName);
  const stop = new Set(["fresh", "the", "and", "with", "each", "container", "bag", "pack", "count", "organic"]);
  const words = (s) => normName(s).split(" ").filter((w) => w.length > 2 && !stop.has(w)).map(singular);
  const want = new Set(words(adName));
  const size = sizeKey(ad.size) || sizeKey(adName);
  const each = (ad.qty > 1) || /^\s*each\b/i.test(ad.size || "");
  let best = null;
  for (const c of cands || []) {
    if (NOT_PRODUCE_RE.test(c.name) || CAND_REJECT_RE.test(c.name)) continue;
    // Anything outside Fresh Produce (a tote bag named "Apple") is never comparable.
    if (c.dept && !/\/Fresh Produce\//i.test(c.dept)) continue;
    if (organic !== /\borganic\b/i.test(c.name)) continue;
    const w = new Set(words(c.name));
    if (nouns.size && ![...nouns].some((n) => w.has(n))) continue;
    let score = 0;
    for (const x of want) if (w.has(x)) score++;
    if (/\bfresh\b|marketside|freshness guaranteed/i.test(c.name)) score += 0.5;
    if (size && sizeKey(c.name) === size) score += 2;
    if (each) score += /\beach\b/i.test(c.name) ? 1.5 : (/\bbag\b|\d\s*lb/i.test(c.name) ? -1 : 0);
    if (!best || score > best.score) best = { id: c.id, score };
  }
  return best?.id || "";
}

/** "50.0 ¢/lb" → 0.5, "$1.12/lb" → 1.12; null when not per lb. */
export function perLb(unitText) {
  const m = String(unitText || "").match(/([\d.]+)\s*(¢|\$)?\s*\/\s*lb/i) || String(unitText || "").match(/\$\s*([\d.]+)\s*\/\s*lb/i);
  if (!m) return null;
  const v = Number(m[1]);
  return /¢/.test(unitText) ? Math.round(v) / 100 : v;
}

const gtinKey = (g) => String(g || "").replace(/\D/g, "").replace(/^0+/, "");

/**
 * @param {object} doc  { ads, matches: {query → cands}, upcs: {id → upc}, scans }
 * @param {object} opts links { rowKey → walmart.com id | "none" }, rules, now
 */
export function buildAdModel(doc, { links = {}, rules = DEFAULT_RULES, now = Date.now() } = {}) {
  const lo = dayStart(now) - 7 * DAY, hi = dayStart(now) + 8 * DAY;
  // Latest scan per GTIN per competitor, and our shelf price at the latest scan.
  const scanBy = new Map();
  for (const s of doc?.scans || []) {
    const k = gtinKey(s.gtin);
    let e = scanBy.get(k);
    if (!e) scanBy.set(k, (e = { comps: {}, ours: null }));
    if (!e.ours || s.date >= e.ours.date) e.ours = { price: s.wm, date: s.date };
    if (!e.comps[s.comp] || s.date >= e.comps[s.comp].date) e.comps[s.comp] = { price: s.price, date: s.date };
  }

  const rows = [];
  const seen = new Set();
  for (const a of doc?.ads || []) {
    if (a.to < lo || a.from >= hi || !isProduceName(a.name)) continue;
    const deal = unitPrice(a);
    for (const part of splitAdName(a.name)) {
      const key = linkKey(a.comp, part);
      const dup = `${key}|${a.price}|${a.from}`;
      if (seen.has(dup)) continue;
      seen.add(dup);
      if (links[key] === "none") continue;
      const query = adQuery(part);
      const ai = doc?.aiPicks?.[key] || null;
      const merged = [...(doc?.matches?.[query] || []), ...(ai?.retryQuery ? doc?.matches?.[ai.retryQuery] || [] : [])];
      const cands = merged.filter((c, i) => merged.findIndex((x) => x.id === c.id) === i);
      const aiId = ai?.id && cands.some((c) => c.id === ai.id) ? ai.id : "";
      // The AI looked (and searched again) and found nothing comparable: say so
      // rather than fall back to a keyword guess.
      const aiNone = !!(ai && !ai.id && ai.retried);
      let id = links[key] || aiId || (aiNone ? "" : pickCandidate(part, cands, { size: a.size, qty: deal.qty }));
      let matchedBy = links[key] ? "you" : aiId ? "ai" : id ? "keywords" : "";
      // Weights the ad states beat the AI's reading of them: Food City's
      // "16 Oz. or 6 Oz." berries were matched to our 12 oz packs as "a listed
      // size". When we sell one of the ad's sizes, swap to it.
      const adOz = ouncesIn(`${a.size || ""} ${part}`);
      const sameOz = (c) => adOz.some((x) => ouncesIn(c.name).some((y) => Math.abs(x - y) <= x * 0.1));
      const picked = cands.find((c) => c.id === id);
      if (!links[key] && picked && adOz.length && ouncesIn(picked.name).length && !sameOz(picked)) {
        const alt = pickCandidate(part, cands.filter(sameOz), { size: a.size, qty: deal.qty });
        if (alt) { id = alt; matchedBy = "size"; }
      }
      const ours = cands.find((c) => c.id === id) || null;
      const upc = ours ? (doc?.upcs?.[ours.id] || "") : "";
      const hist = upc ? scanBy.get(gtinKey(upc)) : null;

      // Per-lb ads compare to our per-lb price; otherwise each to each.
      const adPerLb = /lb/i.test(a.post || "");
      const oursLb = ours ? perLb(ours.unitText) : null;
      let oursCmp = null, unitsNote = "";
      if (ours && adPerLb) {
        if (oursLb != null) oursCmp = oursLb;
        else unitsNote = "Their price is per lb, ours is not: compare by hand.";
      } else if (ours) {
        oursCmp = ours.price;
        if (ours.sold === "WEIGHT") unitsNote = "Ours is sold by weight.";
      }
      // Different pack sizes (per the AI) can't be colour-coded on price alone
      // — unless the weights provably agree (1 lb = "16 Oz.") or the ad gives
      // no size to differ from (ALDI's flyer text rarely does).
      // When both weights are known the code decides; otherwise the AI's
      // same_size stands. A low-confidence AI match isn't colour-coded either.
      const oursOz = ours ? ouncesIn(ours.name) : [];
      const bothKnown = adOz.length > 0 && oursOz.length > 0;
      const sizeDiffers = !links[key] && ours && (bothKnown ? !sameOz(ours)
        : (matchedBy === "ai" && ai.sameSize === false && adOz.length > 0));
      const lowConfidence = !links[key] && matchedBy === "ai" && ai.confidence === "low";
      if (sizeDiffers) unitsNote = unitsNote || `Sizes differ: theirs ${adOz.map((x) => `${x} oz`).join(" or ")}, ours ${oursOz.length ? `${oursOz[0]} oz` : "a different pack"}. Compare by hand.`;
      else if (lowConfidence) unitsNote = unitsNote || "Low-confidence match: check it's comparable.";
      const t = sizeDiffers || lowConfidence ? { ...tierOf(oursCmp, deal.unit, rules), tier: "none" } : tierOf(oursCmp, deal.unit, rules);
      rows.push({
        key, comp: a.comp, name: part, adName: a.name, img: a.img, price: a.price, ...deal,
        pre: a.pre || "", post: a.post || "", sale: a.sale || "", size: a.size || "",
        from: a.from, to: a.to, phase: adPhase(a, now), flyerName: a.flyerName,
        query, cands, ours, linked: !!links[key], matchedBy, ai: aiId ? ai : (ai && !ai.id ? { ...ai, none: true } : null), upc, barcode: upc ? parseGtin(upc) : null,
        oursCmp, oursPerLb: adPerLb && oursLb != null, unitsNote,
        lastScan: hist ? { ours: hist.ours, comp: hist.comps[a.comp] || null } : null,
        ...t, suspect: t.tier !== "none" && t.pct >= SUSPECT_PCT,
      });
    }
  }
  const rank = { red: 0, yellow: 1, none: 2 };
  rows.sort((x, y) => (x.ours ? 0 : 1) - (y.ours ? 0 : 1) || rank[x.tier] - rank[y.tier] ||
    (y.pct ?? -1e9) - (x.pct ?? -1e9) || x.comp.localeCompare(y.comp) || x.name.localeCompare(y.name));
  return {
    rows,
    counts: {
      red: rows.filter((r) => r.tier === "red").length,
      yellow: rows.filter((r) => r.tier === "yellow").length,
      total: rows.length,
      unmatched: rows.filter((r) => !r.ours).length,
    },
  };
}
