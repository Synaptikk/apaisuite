// dev/appriss-ledger-probe.mjs — usage: node dev/appriss-ledger-probe.mjs <store> <register> <days>  (needs the debug Edge on 9222, signed in to APPRISS)
// Probe: how far back does APPRISS Cash Research Search reach? Store 1458, reg 7, N days.
import puppeteer from "puppeteer-core";
import { buildCashResearchBody, decodeLedger } from "../modules/registerls/lib/cash_research.js";
const [store = "1458", reg = "7", days = "80"] = process.argv.slice(2);
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", protocolTimeout: 180000 });
const page = await browser.newPage();
await page.goto("https://apps.apprissretail.com/walmart-usa/secure/sso/saml2?RelayState=/platform/portal", { waitUntil: "domcontentloaded", timeout: 90000 }).catch((e) => console.log("goto:", e.message));
await new Promise((r) => setTimeout(r, 4000));
console.log("landed on:", page.url());
const body = buildCashResearchBody(store, reg, Number(days));
const out = await page.evaluate(async (body) => {
  const url = "https://apps.apprissretail.com/walmart-usa/platform/cpf/searchlite/getsearchresults";
  for (let i = 0; i < 8; i++) {
    const r = await fetch(url, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok || text.trimStart().startsWith("<")) return { status: r.status, preview: text.slice(0, 200), url: r.url };
    const p = JSON.parse(text);
    if (p?.data?.running || p?.running) { await new Promise((res) => setTimeout(res, 2500)); continue; }
    return { status: r.status, success: p.success, data: p.data };
  }
  return { status: 0, error: "still running" };
}, body);
await page.close();
browser.disconnect();
if (!out.data) { console.log("FAILED", JSON.stringify(out).slice(0, 400)); process.exit(1); }
const dec = decodeLedger(out.data);
const dates = dec.rows.map((r) => r.date).sort();
console.log(`days=${days} rows=${dec.rows.length} range=${dates[0]} → ${dates.at(-1)}`);
for (const r of dec.rows.sort((a, b) => a.date.localeCompare(b.date))) if (r.date <= "2026-07-20") console.log(` ${r.date} L/S ${(r.finalizedLsCents/100).toFixed(2)} adv ${(r.advancesCents/100).toFixed(2)} pick ${(r.pickupsCents/100).toFixed(2)} in/out ${r.tillCheckins}/${r.tillCheckouts}`);
