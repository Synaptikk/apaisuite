// Live check of digitalmetrics' GTA timesheet reader against the debug Edge.
//   node dev/gta-clockins-check.mjs "SHANE SMITH" "STEYSHAWN ABRAHAM" [from] [to]
import puppeteer from "puppeteer-core";
import { gtaInPage } from "../modules/digitalmetrics/lib/sources/gta_timesheet.js";
import { parseLookupRows, matchLookup, parseTimesheetRows } from "../modules/digitalmetrics/lib/data/gta_parse.js";
const args = process.argv.slice(2);
const dates = args.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const names = args.filter((a) => !dates.includes(a));
const [from = "2026-09-19", to = "2026-09-23"] = dates;
const b = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", defaultViewport: null, protocolTimeout: 120000 });
let p = (await b.pages()).find((x) => x.url().startsWith("https://timesheet.cloud.wal-mart.com"));
if (!p) { p = await b.newPage(); await p.goto("https://timesheet.cloud.wal-mart.com/gtaapp/menu.jsp", { waitUntil: "networkidle2" }); }
const tokens = await p.evaluate(gtaInPage, { op: "init" });
console.log("init", tokens.error || "ok");
for (const name of names) {
  const res = await p.evaluate(gtaInPage, { op: "lookup", tokens, last: name.split(/\s+/).at(-1) });
  const rows = parseLookupRows(res.text);
  const hit = matchLookup(name, rows);
  console.log(`\n${name}: lookup ${res.status}, ${rows.length} rows → ${hit ? hit.gtaName + " emp " + hit.empId : "NO MATCH"}`);
  if (!hit) { console.log("  candidates:", rows.map((r) => r.gtaName).join(" | ") || "none"); continue; }
  const ld = await p.evaluate(gtaInPage, { op: "load", tokens, empId: hit.empId, from, to });
  for (const r of parseTimesheetRows(ld.html))
    console.log(" ", r.date, "in", r.clockIn, "out", r.clockOut, r.punches.map((x) => `${x.kind}${x.code ? "/" + x.code : ""}@${x.at}`).join(" "));
}
b.disconnect();
