// node --test modules/compshop/lib/model.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { parseGtin, checkDigit, barcodeSvg } from "./barcode.js";
import { tierOf, buildModel, buildAdModel, isProduceName, linkKey, suggestLink } from "./model.js";

const D = (day) => Date.parse(`${day}T12:00:00`);

test("report GTINs normalise to scannable codes", () => {
  assert.deepEqual(parseGtin("33383530505"), { gtin: "33383530505", kind: "upc", code: "033383530505", plu: null, searchKey: "3338353050" });
  assert.equal(parseGtin("40112").plu, "4011");
  assert.equal(parseGtin("40112").code, "000000040112");
  assert.equal(parseGtin("940115").plu, "94011");
  assert.equal(parseGtin("651511009").code, "000651511009");
  assert.equal(parseGtin("5397005022034").kind, "ean");
  assert.equal(parseGtin("899783002024").kind, "upc");
  assert.equal(parseGtin("12345").kind, "bad");
  assert.equal(checkDigit("89978300202"), "4");
});

test("barcode SVG has 95 modules worth of width plus quiet zones", () => {
  const svg = barcodeSvg(parseGtin("899783002024"), { module: 1 });
  assert.match(svg, /viewBox="0 0 115 /);
  assert.equal(barcodeSvg(parseGtin("12345")), "");
});

test("tiers: yellow for a slight gap, red at 15% or $1", () => {
  assert.equal(tierOf(1.99, 1.98).tier, "yellow");
  assert.equal(tierOf(5.58, 2.69).tier, "red");
  assert.equal(tierOf(2.04, 0.95).tier, "red");
  assert.equal(tierOf(3.48, 3.15).tier, "yellow");
  assert.equal(tierOf(1.98, 2.65).tier, "none");
  assert.equal(tierOf(2.19, 2.19).tier, "none");
});

test("produce filter keeps fruit and veg, drops snacks", () => {
  assert.ok(isProduceName("Blackberries"));
  assert.ok(isProduceName("Organic Baby Peeled Carrots"));
  assert.ok(isProduceName("Bite-Size Yellow Potatoes"));
  assert.ok(!isProduceName("Season's Choice Whole Onion Rings"));
  assert.ok(!isProduceName("Clancy's Puffed Corn"));
  assert.ok(!isProduceName("Merry Moments LED Snowman"));
});

test("model: latest scan per competitor, linked active ad lowers the price", () => {
  const doc = {
    scans: [
      { comp: "ALDI", gtin: "860007279645", desc: "blackberries", price: 1.99, wm: 1.79, date: D("2026-10-08") },
      { comp: "ALDI", gtin: "860007279645", desc: "blackberries", price: 1.69, wm: 1.79, date: D("2026-10-21") },
      { comp: "ALDI", gtin: "33383087139", desc: "APPLE FUJI 3# HM", price: 2.69, wm: 5.58, date: D("2026-10-21") },
    ],
    ads: [
      { comp: "ALDI", name: "Blackberries", price: 1.29, from: D("2026-10-21"), to: D("2026-10-27"), img: "" },
      { comp: "ALDI", name: "Organic Baby Peeled Carrots", price: 1.39, from: D("2026-10-21"), to: D("2026-10-27"), img: "" },
      { comp: "ALDI", name: "LED Snowman", price: 14.99, from: D("2026-10-21"), to: D("2026-10-27"), img: "" },
    ],
  };
  const links = { [linkKey("ALDI", "Blackberries")]: "860007279645" };
  const m = buildModel(doc, { links, now: D("2026-10-23") });
  assert.equal(m.items[0].gtin, "33383087139");           // red sorts first
  const bb = m.items.find((i) => i.gtin === "860007279645");
  assert.equal(bb.comps.ALDI.price, 1.69);
  assert.equal(bb.best.price, 1.29);
  assert.equal(bb.best.from, "ad");
  assert.equal(bb.tier, "red");
  assert.equal(m.ads.length, 2);                           // snowman dropped
  assert.equal(m.counts.unlinked, 1);
});

test("suggestions respect organic", () => {
  const items = [
    { gtin: "1", name: "Fresh Avocados, 4 ct Bag", desc: "AVO SMALL BAG HM" },
    { gtin: "2", name: "Organic Hass Avocados, 4 ct", desc: "ORG AVOCADO BAG HM" },
  ];
  assert.equal(suggestLink("Organic Avocados", items).gtin, "2");
  assert.equal(suggestLink("Avocados", items).gtin, "1");
});

test("multi-buy ads compare per unit", async () => {
  const { unitPrice } = await import("./model.js");
  assert.deepEqual(unitPrice({ price: 10, pre: "12 FOR" }), { qty: 12, unit: 0.83 });
  assert.deepEqual(unitPrice({ price: 1.69, pre: "PRICE DROPS" }), { qty: 1, unit: 1.69 });
});

test("suggestions need a shared produce word, not just 'organic'", () => {
  const items = [
    { gtin: "3", name: "", desc: "organic cherubs" },
    { gtin: "4", name: "", desc: "APL CRML W/NUTS 3PK" },
    { gtin: "6", name: "", desc: "spinach & artichoke stuffed mushroom" },
    { gtin: "7", name: "", desc: "MSH SL WHT 8OZ HM" },
  ];
  assert.equal(suggestLink("Organic Avocados", items), null);
  assert.equal(suggestLink("Caramel Apples", items).gtin, "4");
  assert.equal(suggestLink("Whole or Sliced Mushrooms", items).gtin, "7");
  assert.ok(!isProduceName("Chicken Salad or Chicken Tenders"));
  assert.ok(!isProduceName("Food Club Pumpkin"));
  assert.ok(isProduceName("Bright Farms Crunch Salads"));
});

test("equal matches go to the most recently scanned item", () => {
  const items = [
    { gtin: "a", name: "", desc: "BLACKBERRY 6OZ HM", oursDate: D("2026-08-26") },
    { gtin: "b", name: "", desc: "BLACKBERRY 6OZ HM", oursDate: D("2026-10-15") },
  ];
  assert.equal(suggestLink("Blackberries", items).gtin, "b");
});

test("ad matching: rejects processed products, prefers same size and each-vs-bag", async () => {
  const { pickCandidate, sizeKey, splitAdName } = await import("./model.js");
  const c = (id, name) => ({ id, name });
  assert.equal(pickCandidate("Fresh Avocados", [c("1", "AVOFRESCO Avocado & Sea Salt 14 oz Squeeze"), c("2", "Fresh Hass Avocados, Each")], { qty: 12 }), "2");
  assert.equal(pickCandidate("Raspberries", [c("1", "SUNNYD Blue Raspberry Shelf Stable Juice Drink"), c("2", "Fresh Raspberries, 6 oz Container")]), "2");
  assert.equal(pickCandidate("Navel Oranges", [c("1", "Fresh Navel Oranges, 4 lb Bag"), c("2", "Fresh Navel Orange, Each")], { qty: 12, size: "Each" }), "2");
  assert.equal(pickCandidate("Sweet Onions", [c("1", "Fresh Whole Sweet Onion, Each"), c("2", "Fresh Sweet Onions, 3 lb Bag")], { size: "Bland Farms, 3 Lb." }), "2");
  assert.equal(pickCandidate("Gourmet Colored Peppers", [c("1", "McCormick Kosher Crushed Red Pepper, 1.5 oz Bottle")]), "");
  assert.equal(sizeKey("9.8 Oz."), "9.8oz");
  assert.deepEqual(splitAdName("Strawberries, Raspberries or Blackberries"), ["Strawberries", "Raspberries", "Blackberries"]);
});

test("weights compare across lb and oz", async () => {
  const { ouncesIn } = await import("./model.js");
  assert.deepEqual(ouncesIn("Basket & Bushel, 16 Oz. or 6 Oz."), [16, 6]);
  assert.deepEqual(ouncesIn("Fresh Strawberries, 1 lb Container"), [16]);
  assert.deepEqual(ouncesIn("Blackberries"), []);
});

test("non-produce departments are never picked", async () => {
  const { pickCandidate, adQuery } = await import("./model.js");
  const bag = { id: "1", name: "Women's Quilted A Bitten Apple Tote Bag", dept: "Home Page/Clothing/Bags & Accessories/Handbags/Tote Bags" };
  const fruit = { id: "2", name: "Fresh SweeTango Apples, 2 lb Bag", dept: "Home Page/Food/Fresh Produce/Fresh Fruits/Apples" };
  assert.equal(pickCandidate("New York SweeTango Apple Tote", [bag]), "");
  assert.equal(pickCandidate("New York SweeTango Apple Tote", [bag, fruit]), "2");
  assert.equal(adQuery("New York SweeTango Apple Tote"), "sweetango apple");
});

test("ad weights override the AI: swap to our same-size item, else no colour", () => {
  const D0 = Date.parse("2026-10-23T12:00:00");
  const ad = { comp: "Food City", name: "Raspberries", price: 2.99, size: "Basket & Bushel, 16 Oz. or 6 Oz.", from: D0 - 86400000, to: D0 + 86400000 };
  const c12 = { id: "12", name: "Fresh Raspberries, 12 oz. Container", price: 5.44, dept: "Home Page/Food/Fresh Produce/Fresh Fruits/Berries" };
  const c6 = { id: "6", name: "Fresh Raspberries, 6 oz. Container", price: 2.77, dept: "Home Page/Food/Fresh Produce/Fresh Fruits/Berries" };
  const key = linkKey("Food City", "Raspberries");
  const doc = (cands) => ({ ads: [ad], matches: { raspberries: cands }, aiPicks: { [key]: { id: "12", confidence: "high", sameSize: true } }, upcs: {} });
  const swapped = buildAdModel(doc([c12, c6]), { now: D0 }).rows[0];
  assert.equal(swapped.ours.id, "6");
  assert.equal(swapped.matchedBy, "size");
  assert.equal(swapped.tier, "none");                       // $2.77 ours < $2.99 theirs
  const stuck = buildAdModel(doc([c12]), { now: D0 }).rows[0];
  assert.equal(stuck.ours.id, "12");
  assert.equal(stuck.tier, "none");                         // 12 oz vs 16/6 oz: not colour-coded
  assert.match(stuck.unitsNote, /Sizes differ/);
});
