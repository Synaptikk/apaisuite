// Plan vs volume vs delivery, per day: were the board's pick hours enough for
// the day's units at a realistic rate, and did the team deliver the plan?
// Usage: node dev/dm-capacity.mjs [store] [fromISO] [toISO]
import puppeteer from "puppeteer-core";
import { dailyPicks } from "../modules/digitalmetrics/lib/data/insights.js";
import { effectiveAssignedHours, dateKey } from "../modules/digitalmetrics/lib/data/adherence.js";
import { classificationOf } from "../modules/digitalmetrics/lib/data/classify.js";

const b = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", protocolTimeout: 300000 });
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
const classifications = (await call("get_classifications", { store })) || {};

// Per-day units + hours by group, from the week docs.
const days = new Map();  // iso -> { units, expUnits, expHours, digHours, helpHours, allHours }
for (const wk of (await call("list_weeks", { store })).slice(-3)) {
  const doc = await call("get_week", { store, weekKey: wk });
  if (!doc?.rawData?.length) continue;
  for (const d of dailyPicks(doc.rawData, classifications, doc.express || null, doc.expressRate || null)) {
    const iso = dateKey(d.date);
    if (iso < from || iso > to) continue;
    days.set(iso, {
      units: d.total, expUnits: d.expressRateUnits ?? null, expHours: d.expressRateHours ?? null,
      helpHours: d.storeHelpHours, digHours: 0, allHours: 0,
    });
  }
  let last = null;
  for (const row of doc.rawData) {
    if (row["Pick Date"]) last = dateKey(row["Pick Date"]);
    if (!last || !days.has(last)) continue;
    const h = typeof row["Pick Hours"] === "number" ? row["Pick Hours"] : 0;
    const day = days.get(last);
    day.allHours += h;
    const cls = classificationOf(row.Associate, classifications);
    if (cls === "Digital" || cls === "Exceptions") day.digHours += h;
  }
}

const r1 = (v) => Math.round(v * 10) / 10;
const NON_EXP_RATE = 93;   // this week's demonstrated non-express units/hr
const EXP_RATE     = 60;   // …and express
console.log(`store ${store} · required hours = non-express units ÷ ${NON_EXP_RATE} + express units ÷ ${EXP_RATE}`);
console.log("\nday         units  reqHrs  boardPlan  digDelivered  helpHrs  allHrs  plan-req  delivered-req");
for (const iso of [...days.keys()].sort()) {
  const d = days.get(iso);
  const board = await call("get_assignments", { store, date: iso }).catch(() => null);
  let planned = 0;
  for (const row of board?.associates || []) {
    if (Object.values(row.slots || {}).some((t) => String(t).toLowerCase() === "pick"))
      planned += effectiveAssignedHours({ ...row, status: null }, board.associates);
  }
  const req = d.expUnits != null
    ? (d.units - d.expUnits) / NON_EXP_RATE + d.expUnits / EXP_RATE
    : d.units / NON_EXP_RATE;
  console.log([
    `${iso} ${new Date(`${iso}T12:00:00`).toLocaleDateString([], { weekday: "short" })}`,
    String(d.units).padStart(6),
    String(r1(req)).padStart(6),
    String(r1(planned)).padStart(9),
    String(r1(d.digHours)).padStart(12),
    String(r1(d.helpHours)).padStart(8),
    String(r1(d.allHours)).padStart(7),
    String(r1(planned - req)).padStart(8),
    String(r1(d.allHours - req)).padStart(10),
  ].join(" "));
}
b.disconnect();
