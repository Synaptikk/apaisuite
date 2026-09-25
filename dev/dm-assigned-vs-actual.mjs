// Assigned vs actual pick hours from the Daily Board assignments, per day and
// per associate, for the most recent stored week(s).
// Usage: node dev/dm-assigned-vs-actual.mjs [store] [weeksBack=2]
import puppeteer from "puppeteer-core";
import { weekPickBreakdown, actualPickHoursByName } from "../modules/digitalmetrics/lib/data/adherence.js";
import { distinctDates } from "../modules/digitalmetrics/lib/data/metrics.js";

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
const weeksBack = Number(process.argv[3] || 2);
const weekKeys = (await call("list_weeks", { store })).slice(-weeksBack);
const classifications = (await call("get_classifications", { store })) || {};
console.log(`store ${store} · weeks ${weekKeys.join(", ")}`);

const h = (n) => `${n.toFixed(1)}h`;
for (const weekKey of weekKeys) {
  const doc = await call("get_week", { store, weekKey });
  if (!doc?.rawData?.length) continue;
  const dates = distinctDates(doc.rawData);

  const entries = await Promise.all(dates.map(async (iso) => {
    const a = await call("get_assignments", { store, date: iso });
    return a ? [iso, a] : null;
  }));
  const byDate = Object.fromEntries(entries.filter(Boolean));
  if (!Object.keys(byDate).length) { console.log(`\n${weekKey}: no assignments saved`); continue; }

  const { days, people } = weekPickBreakdown(byDate, actualPickHoursByName(doc.rawData), classifications);
  console.log(`\n=== week ${weekKey} ===`);
  console.log("date        assigned   actual    short      %  people");
  let ta = 0, tc = 0;
  for (const d of days) {
    ta += d.assigned; tc += d.actual;
    const p = d.assigned > 0 ? Math.round((d.actual / d.assigned) * 100) + "%" : "—";
    console.log(`${d.date}  ${h(d.assigned).padStart(8)} ${h(d.actual).padStart(8)} ${h(Math.max(0, d.assigned - d.actual)).padStart(8)} ${String(p).padStart(6)} ${String(d.people).padStart(7)}`);
  }
  const tp = ta > 0 ? Math.round((tc / ta) * 100) + "%" : "—";
  console.log(`TOTAL       ${h(ta).padStart(7)} ${h(tc).padStart(8)} ${h(Math.max(0, ta - tc)).padStart(8)} ${String(tp).padStart(6)}`);

  const ranked = [...people].sort((a, b2) => (b2.assigned - b2.actual) - (a.assigned - a.actual));
  console.log("\nassociate                  assigned   actual    diff      %");
  for (const p of ranked) {
    const q = p.assigned > 0 ? Math.round((p.actual / p.assigned) * 100) + "%" : "—";
    console.log(`${p.name.padEnd(26)} ${h(p.assigned).padStart(8)} ${h(p.actual).padStart(8)} ${h(p.actual - p.assigned).padStart(8)} ${String(q).padStart(6)}`);
  }
}
b.disconnect();
