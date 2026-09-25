import puppeteer from "puppeteer-core";
import { buildListBody } from "../modules/registerls/lib/workview.js";
const TARGET = process.argv[2] || "14663686";
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", protocolTimeout: 180000 });
const page = await browser.newPage();
await page.goto("https://apps.apprissretail.com/walmart-usa/secure/sso/saml2?RelayState=/platform/portal", { waitUntil: "domcontentloaded", timeout: 90000 }).catch((e) => console.log("goto:", e.message));
await new Promise((r) => setTimeout(r, 4000));
console.log("landed on:", page.url());
const bodies = ["unassigned", "assigned"].map((status) => buildListBody("1458", { days: 730, status }));
const out = await page.evaluate(async (bodies, target) => {
  const base = "https://apps.apprissretail.com/walmart-usa/platform/workview/api";
  const res = { lists: {}, detail: null };
  for (const body of bodies) {
    const found = []; const statusCounts = {}; let start = 0, fetched = 0, total = null;
    for (let p = 0; p < 25; p++) {
      const r = await fetch(`${base}/v2/workviewItems`, { method: "POST", credentials: "include", headers: { "content-type": "application/json", accept: "application/json", "x-requested-with": "XMLHttpRequest" }, body: JSON.stringify({ ...body, startIndex: start }) });
      const t = await r.text(); if (!r.ok || t.trimStart().startsWith("<")) { res.lists[body.status] = { status: r.status, preview: t.slice(0, 200) }; break; }
      const d = JSON.parse(t).data || {}; const items = d.items || [];
      if (p === 0) total = d.totalResults;
      for (const it of items) { const k = `${it.statusID}/${it.statusType}`; statusCounts[k] = (statusCounts[k] || 0) + 1; if (String(it.id) === target) found.push(it); }
      fetched += items.length; if (items.length < 20) break; start = d.endIndex ?? fetched;
    }
    res.lists[body.status] = { total, fetched, statusCounts, found };
  }
  const r = await fetch(`${base}/v1/workviewItem?workItemId=${target}`, { credentials: "include", headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest" } });
  const t = await r.text(); try { res.detail = JSON.parse(t); } catch { res.detail = { status: r.status, preview: t.slice(0, 300) }; }
  return res;
}, bodies, TARGET);
await page.close(); browser.disconnect();
for (const [k, v] of Object.entries(out.lists)) { console.log(`\n== ${k}: total=${v.total} fetched=${v.fetched} statusCounts=${JSON.stringify(v.statusCounts)}`); for (const f of v.found || []) console.log(JSON.stringify(f, null, 1).slice(0, 2500)); }
const wi = out.detail?.data?.workViewItem || out.detail?.data || out.detail;
console.log("\n== detail keys:", wi && typeof wi === "object" ? Object.keys(wi).join(",") : wi);
if (wi && typeof wi === "object") { const pick = {}; for (const k of Object.keys(wi)) if (/status|dispos|resolu|assign|complet|close|outcome|reason|modif|updat/i.test(k)) pick[k] = wi[k]; console.log(JSON.stringify(pick, null, 1).slice(0, 3000)); }
