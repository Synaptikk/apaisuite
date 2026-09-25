import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
const OUT = "C:/Users/SES008~1.S01/AppData/Local/Temp/claude/C--Users-ses008s-s01458-Desktop-APAISuite/040c3438-1536-48d3-9351-7c26de274ae3/scratchpad";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 180000 });
const page = (await browser.pages()).find(p => /uat\.riskonnectclearsight\.com.*intakenotice\/\d+/.test(p.url()));
for (const id of [70, 72, 73]) {
  const u = `https://uat.riskonnectclearsight.com/Enterprise/RMIS/Stars.Claim.mvc/MetaData/GetTableBasedLookupMappingEntities?lookupId=${id}&SessionMode=ReadOnly&appName=Intake&clearsight=true`;
  const r = await page.evaluate(async (u) => { const r = await fetch(u, { credentials: "include", headers: { "X-Requested-With": "XMLHttpRequest", Accept: "application/json" } }); return { s: r.status, t: await r.text() }; }, u);
  writeFileSync(`${OUT}/tablelookup-${id}.json`, r.t);
  try { const j = JSON.parse(r.t); console.log(`\n== lookupId ${id}: ${r.s}, ${j.MappingEntities?.length} entities; other keys: ${Object.keys(j).filter(k => k !== "MappingEntities").join(",")}`);
    for (const e of j.MappingEntities || []) console.log(`  ${String(e.Source).padEnd(28)} "${e.SearchLabel}" search=${e.SearchType} req=${e.Required} vis=${e.Visible} → ${e.Destination} (${e.DestinationFieldName}) order=${e.SearchCriteriaOrder}/${e.DisplayColumnsOrder}`);
    console.log("  other:", JSON.stringify(Object.fromEntries(Object.entries(j).filter(([k]) => k !== "MappingEntities"))).slice(0, 600));
  } catch { console.log(id, r.s, r.t.slice(0, 300)); }
}
await browser.disconnect();
