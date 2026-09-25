// Who drives the under-picked-while-present bucket, and why: per associate,
// week under-pick hours vs the work that explains it — exception items (not
// timed in Pick Hours), other board tasks beside Pick, and their pick rate.
// Usage: node dev/dm-underpick.mjs [store] [fromISO] [toISO]
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

const metric = new Map();   // "NAME|iso" -> row
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

const people = new Map();
for (const iso of dates) {
  const board = await call("get_assignments", { store, date: iso }).catch(() => null);
  const roster = board?.associates || [];
  for (const row of roster) {
    const slots = row.slots || {};
    const pickSlots = Object.entries(slots).filter(([, t]) => String(t).toLowerCase() === "pick").map(([k]) => +k);
    if (!pickSlots.length || row.status === "absent") continue;
    const plan = r1(effectiveAssignedHours({ ...row, status: null }, roster));
    if (!plan) continue;

    let met = metric.get(`${row.name}|${iso}`);
    if (!met) for (const [k, v] of metric) {
      const [mn, md] = k.split("|");
      if (md === iso && findAssignmentMatch(mn, [row])) { met = v; break; }
    }
    const actual = r1(met?.["Pick Hours"] || 0);
    if (actual === 0) continue;   // call-in / reassigned, not under-pick

    const g = gta.byName?.[row.name]?.days?.[iso];
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
    const gap = Math.max(0, plan - missed - actual);
    if (gap < 0.1) continue;

    const p = people.get(row.name) || people.set(row.name, {
      name: row.name, days: 0, plan: 0, actual: 0, gap: 0,
      excItems: 0, otherSlots: 0, rateSum: 0, rateDays: 0, picked: 0,
    }).get(row.name);
    p.days++; p.plan += plan - missed; p.actual += actual; p.gap += gap;
    p.excItems += (met?.["Exception Qty Req to Pick"] || 0);
    p.otherSlots += Object.values(slots).filter((t) => !["pick", "l", "b"].includes(String(t).toLowerCase())).length;
    if (met?.["Pick Rate"]) { p.rateSum += met["Pick Rate"]; p.rateDays++; }
    p.picked += (met?.["Picked As Req Qty"] || 0) + (met?.["Exception Picked As Req Qty"] || 0);
  }
}

const list = [...people.values()].map((p) => ({
  ...p, plan: r1(p.plan), actual: r1(p.actual), gap: r1(p.gap),
  adh: Math.round((p.actual / p.plan) * 100),
  rate: p.rateDays ? Math.round(p.rateSum / p.rateDays) : null,
})).sort((a, b2) => b2.gap - a.gap);

const teamRate = Math.round(list.reduce((s, p) => s + (p.rate || 0), 0) / list.filter((p) => p.rate).length);

// Fast pickers bag their own items after each walk (the user, 2026-09-23):
// that off-scanner time is acceptable, and it only shows up in the top ~20%
// by rate. Tag them so their gap reads as bagging, not leakage.
const rates = list.map((p) => p.rate).filter((r) => r != null).sort((a, b2) => b2 - a);
const fastCut = rates[Math.max(0, Math.ceil(rates.length * 0.2) - 1)] ?? Infinity;
const tag = (p) =>
  p.rate != null && p.rate >= fastCut ? "FAST (bagging ok)"
  : p.otherSlots >= 4 ? "multi-task bleed"
  : p.rate != null && p.rate < teamRate * 0.85 ? "SLOW + missing"
  : "";

console.log(`store ${store} · ${from}..${to} · under-pick per associate (present days only, misses excluded)`);
console.log(`team avg pick rate ${teamRate}/hr · top-20% (bagging-exempt) cutoff ${fastCut}/hr\n`);
console.log("associate                 days  planNet  picked  UNDER  adh%  excItems  otherHrs  rate  read");
for (const p of list) {
  console.log([
    p.name.padEnd(25),
    String(p.days).padStart(4),
    String(p.plan).padStart(7) + "h",
    String(p.actual).padStart(6) + "h",
    String(p.gap).padStart(5) + "h",
    String(p.adh).padStart(4) + "%",
    String(p.excItems).padStart(8),
    String(p.otherSlots).padStart(8) + "h",
    String(p.rate ?? "—").padStart(5),
    ` ${tag(p)}`,
  ].join(" "));
}
const sum = (f) => r1(list.filter(f).reduce((s, p) => s + p.gap, 0));
console.log(`\ntotal under-pick ${sum(() => true)}h`);
console.log(`  bagging-exempt (top 20% rate): ${sum((p) => tag(p) === "FAST (bagging ok)")}h`);
console.log(`  multi-task bleed (4h+ other board tasks): ${sum((p) => tag(p) === "multi-task bleed")}h`);
console.log(`  slow + missing time (<85% of team rate): ${sum((p) => tag(p) === "SLOW + missing")}h`);
console.log(`  unexplained mid-rate leakage: ${sum((p) => tag(p) === "")}h`);
b.disconnect();
