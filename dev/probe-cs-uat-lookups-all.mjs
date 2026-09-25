// UAT: pull every lookup list referenced by the interview template (ItemType 2 fields).
import puppeteer from "puppeteer-core";
import { readFileSync, writeFileSync } from "node:fs";
const OUT = "C:/Users/SES008~1.S01/AppData/Local/Temp/claude/C--Users-ses008s-s01458-Desktop-APAISuite/040c3438-1536-48d3-9351-7c26de274ae3/scratchpad";
const tpl = JSON.parse(readFileSync(`${OUT}/meta-csNoticeView.txt`, "utf8"));
const names = new Set();
for (const p of tpl.WizardScreenConfig.Pages) for (const r of p.Rows || []) for (const c of r.Columns || []) for (const it of c.Items || []) if (it.ItemType === 2 && it.Fieldname) names.add(it.Fieldname);
console.log("lookup fields:", names.size);
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 600000 });
const page = (await browser.pages()).find(p => /uat\.riskonnectclearsight\.com.*intakenotice\/\d+/.test(p.url()));
const base = "https://uat.riskonnectclearsight.com/Enterprise/Orion.Interview/Orion.InterviewAnswers.mvc/MetaData";
const out = {};
let i = 0;
for (const fn of names) {
  const u = `${base}/Lookup?fieldname=${fn}&templateId=2383&noticeId=19059&answerId=19133&SessionMode=ReadOnly&pageSize=2000&appName=Intake&clearsight=true`;
  const r = await page.evaluate(async (u) => { try { const r = await fetch(u, { credentials: "include", headers: { "X-Requested-With": "XMLHttpRequest", Accept: "application/json" } }); return { s: r.status, t: await r.text() }; } catch (e) { return { s: -1, t: String(e) }; } }, u);
  try { const j = JSON.parse(r.t); out[fn] = { status: r.s, total: j.TotalRecords, groupKeys: j.GroupKeys, items: (j.ItemsList || []).map(x => [x.Code, x.Description, x.Value]) , err: j.ErrorDescription }; }
  catch { out[fn] = { status: r.s, raw: r.t.slice(0, 200) }; }
  if (++i % 20 === 0) console.log(i, "done");
}
writeFileSync(`${OUT}/lookups.json`, JSON.stringify(out));
const sizes = Object.entries(out).map(([k, v]) => [k, v.status, v.total ?? "?", (v.items || []).length]).sort((a, b) => b[3] - a[3]);
console.log(JSON.stringify(sizes));
await browser.disconnect();
