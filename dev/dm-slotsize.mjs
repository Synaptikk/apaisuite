// Do short pick assignments deliver a lower fraction than long ones?
// Buckets every present person-day by assigned pick hours (net of punches
// misses) and reports delivered %. Tests "1–2h pickers only pick 30 min".
// Usage: node dev/dm-slotsize.mjs [store] [fromISO] [toISO]
import fs from "node:fs";
import puppeteer from "puppeteer-core";
import { effectiveAssignedHours, findAssignmentMatch, dateKey } from "../modules/digitalmetrics/lib/data/adherence.js";

const b = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", protocolTimeout: 570000 });
let page = (await b.pages()).find((p) => /\/app\.html/.test(p.url()) && p.url().startsWith("chrome-extension://fchn"));
if (!page) {
  page = await b.newPage();
  await page.goto("chrome-extension://fchnolphfaklbpdgnofhblfhcailkpdb/app.html#/digitalmetrics");
  await new Promise((r) => setTimeout(r, 1500));
}
const call = async (type, payload = {}) => {
  const r = await page.evaluate(
    (type, payload) => chrome.runtime.sendMessage({ module: "digitalmetrics", type, ...payload }),
    type, payload);
  if (!r?.ok) throw new Error(`${type}: ${r?.error || "failed"}`);
  return r.data;
};

const store = process.argv[2] || (await call("get_home_store"))?.store;
const from = process.argv[3] || "2026-09-19";
const to   = process.argv[4] || "2026-09-22";

const metric = new Map();
for (const wk of (await call("list_weeks", { store })).slice(-3)) {
  const doc = await call("get_week", { store, weekKey: wk });
  let last = null;
  for (const row of doc?.rawData || []) {
    if (row["Pick Date"]) last = dateKey(row["Pick Date"]);
    if (!last || !row.Associate) continue;
    metric.set(`${row.Associate}|${last}`, row);
  }
}
const cacheFile = new URL(`./.gta-cache-${store}-${from}-${to}.json`, import.meta.url);
const gta = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")) : { byName: {} };

const SLOT0 = 5 * 60;
const r1 = (v) => Math.round(v * 10) / 10;
const mins = (a) => { const m = /^(\d{2}):(\d{2})$/.exec(a || ""); return m ? +m[1] * 60 + +m[2] : null; };
const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const dates = [];
for (let d = new Date(`${from}T12:00:00`); ; d.setDate(d.getDate() + 1)) {
  const iso = d.toISOString().slice(0, 10);
  if (iso > to) break;
  dates.push(iso);
}

const BUCKETS = [[0, 2, "≤2h"], [2, 4, "2–4h"], [4, 6, "4–6h"], [6, 99, "6h+"]];
const agg = BUCKETS.map(([lo, hi, label]) => ({ lo, hi, label, days: 0, plan: 0, actual: 0, zero: 0, alsoOther: 0 }));

for (const iso of dates) {
  const board = await call("get_assignments", { store, date: iso }).catch(() => null);
  const roster = board?.associates || [];
  for (const row of roster) {
    const slots = row.slots || {};
    const pickSlots = Object.entries(slots).filter(([, t]) => String(t).toLowerCase() === "pick").map(([k]) => +k);
    if (!pickSlots.length || row.status === "absent") continue;
    const plan = effectiveAssignedHours({ ...row, status: null }, roster);
    if (!plan) continue;

    let met = metric.get(`${row.name}|${iso}`);
    if (!met) for (const [k, v] of metric) {
      const [mn, md] = k.split("|");
      if (md === iso && findAssignmentMatch(mn, [row])) { met = v; break; }
    }
    const actual = met?.["Pick Hours"] || 0;

    const g = gta.byName?.[row.name]?.days?.[iso];
    if (!g?.punches?.length && actual === 0) continue;   // call-in, not delivery
    const punches = g?.punches || [];
    const mi = punches.findIndex((p) => p.code === "MEAL");
    const meal0 = mi >= 0 ? mins(punches[mi].at) : null;
    const meal1 = mi >= 0 && punches[mi + 1] ? mins(punches[mi + 1].at) : null;
    let missed = 0;
    if (g?.clockIn != null && g?.clockOut != null) {
      for (const k of pickSlots) {
        const s0 = SLOT0 + k * 60, s1 = s0 + 60;
        missed += Math.max(0, Math.min(g.clockIn, s1) - s0) + Math.max(0, s1 - Math.max(g.clockOut, s0));
        if (meal0 != null && meal1 != null) missed += overlap(s0, s1, meal0, meal1);
      }
      missed /= 60;
    }
    const planNet = Math.max(0, plan - missed);
    if (planNet < 0.25) continue;

    const bucket = agg.find((x) => planNet > x.lo && planNet <= x.hi);
    if (!bucket) continue;
    bucket.days++; bucket.plan += planNet; bucket.actual += Math.min(actual, planNet + 2);
    if (actual === 0) bucket.zero++;
    if (Object.values(slots).some((t) => !["pick", "l", "b", ""].includes(String(t).toLowerCase()))) bucket.alsoOther++;
  }
}

console.log(`store ${store} · ${from}..${to} · delivery by assigned-pick size (present person-days)`);
console.log("\nbucket  person-days  planned  picked  delivered%  zero-pick days  had other tasks");
for (const x of agg) {
  if (!x.days) continue;
  console.log([
    x.label.padEnd(6),
    String(x.days).padStart(11),
    (r1(x.plan) + "h").padStart(8),
    (r1(x.actual) + "h").padStart(7),
    (Math.round((x.actual / x.plan) * 100) + "%").padStart(10),
    String(x.zero).padStart(14),
    String(x.alsoOther).padStart(15),
  ].join(" "));
}
b.disconnect();
