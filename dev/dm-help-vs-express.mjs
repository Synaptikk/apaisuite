// Does more Express work mean more Store Help? Pull every stored week for a
// store out of the running extension (debug Edge, 9222) and run the day-level
// numbers: help hours vs express hours, plus express vs non-express pick rate.
// Usage: node dev/dm-help-vs-express.mjs [store]
import puppeteer from "puppeteer-core";
import { dailyPicks, helpVsExpress } from "../modules/digitalmetrics/lib/data/insights.js";

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

const storeArg = process.argv[2];
const store = storeArg || (await call("get_home_store"))?.store || (await call("list_stores"))?.[0];
console.log(`store ${store}`);

const weekKeys = await call("list_weeks", { store });
const classifications = (await call("get_classifications", { store })) || {};

const allDays = [];
for (const weekKey of weekKeys || []) {
  const doc = await call("get_week", { store, weekKey });
  if (!doc?.rawData?.length) continue;
  const daily = dailyPicks(doc.rawData, classifications, doc.express || null, doc.expressRate || null);

  // Total pick hours per day (everyone), to derive the non-express rate.
  const hoursByDate = new Map();
  let last = null;
  for (const row of doc.rawData) {
    if (row["Pick Date"]) last = row["Pick Date"];
    if (!last) continue;
    const h = typeof row["Pick Hours"] === "number" ? row["Pick Hours"] : 0;
    hoursByDate.set(last, (hoursByDate.get(last) || 0) + h);
  }
  for (const d of daily) allDays.push({ ...d, weekKey, totalHours: hoursByDate.get(d.date) || 0 });
}

const r1 = (v) => Math.round(v * 10) / 10;
console.log(`\n${allDays.length} days loaded across ${weekKeys?.length ?? 0} weeks`);
console.log("date        helpHrs  expHrs  expPicks  helpPicks  expRate  nonExpRate  allRate");
for (const d of allDays) {
  const hasExp = d.expressRateHours != null;
  const nonExpUnits = hasExp ? d.total - d.expressRateUnits : null;
  const nonExpHours = hasExp ? d.totalHours - d.expressRateHours : null;
  const nonExpRate = hasExp && nonExpHours > 0 ? r1(nonExpUnits / nonExpHours) : null;
  const allRate = d.totalHours > 0 ? r1(d.total / d.totalHours) : null;
  console.log([
    d.date.padEnd(11),
    String(d.storeHelpHours).padStart(7),
    String(hasExp ? d.expressRateHours : "—").padStart(7),
    String(hasExp ? d.expressRateUnits : "—").padStart(9),
    String(d.storeHelp).padStart(10),
    String(d.expressRate ?? "—").padStart(8),
    String(nonExpRate ?? "—").padStart(11),
    String(allRate ?? "—").padStart(8),
  ].join(" "));
}

const hve = helpVsExpress(allDays);
console.log(`\ncompared days: ${hve.days.length}  helpHours: ${hve.helpHours}  expressHours: ${hve.expressHours}`);
console.log(`Pearson r (help hours vs express hours): ${hve.r}`);

// Also correlate help hours against express UNITS and against total volume,
// to separate "express causes help" from "busy days cause help".
const pear = (xs, ys) => {
  const n = xs.length; if (n < 3) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i]-mx)*(ys[i]-my); sxx += (xs[i]-mx)**2; syy += (ys[i]-my)**2; }
  return sxx && syy ? Math.round(sxy / Math.sqrt(sxx*syy) * 100) / 100 : null;
};
const cd = hve.days;
console.log(`Pearson r (help hours vs express units): ${pear(cd.map(d=>d.storeHelpHours), cd.map(d=>d.expressRateUnits))}`);
console.log(`Pearson r (help hours vs TOTAL picks):   ${pear(cd.map(d=>d.storeHelpHours), cd.map(d=>d.total))}`);
console.log(`Pearson r (help hours vs digital picks): ${pear(cd.map(d=>d.storeHelpHours), cd.map(d=>d.digitalTotal))}`);

b.disconnect();
