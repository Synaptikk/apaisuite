// UAT: re-fetch the interview metadata endpoints from page context and save them.
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
const OUT = "C:/Users/SES008~1.S01/AppData/Local/Temp/claude/C--Users-ses008s-s01458-Desktop-APAISuite/040c3438-1536-48d3-9351-7c26de274ae3/scratchpad";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 180000 });
const page = (await browser.pages()).find(p => /uat\.riskonnectclearsight\.com.*intakenotice\/\d+/.test(p.url()));
const m = page.url().match(/intakenotice\/(\d+).*templateId=(\d+)&answerId=(\d+)/);
const [noticeId, templateId, answerId] = [m[1], m[2], m[3]];
const base = "https://uat.riskonnectclearsight.com/Enterprise";
const urls = {
  csNoticeView: `${base}/Orion.Interview/Orion.InterviewAnswers.mvc/MetaData/CsNoticeView?templateId=${templateId}&SessionMode=ReadOnly&appName=Intake&clearsight=true`,
  noticeData2:  `${base}/Orion.Interview/Orion.InterviewAnswers.mvc/MetaData/NoticeData2?templateId=${templateId}&noticeId=${noticeId}&answerId=${answerId}&SessionMode=ReadOnly&appName=Intake&clearsight=true`,
  managerConfig:`${base}/RMIS/STARS.IntakeNotice.mvc/MetaData/ManagerConfig?hostdomain=STARS.IntakeNotice&hostpackage=RMIS&groupKeys=&parentKey=&SessionMode=ReadOnly&appName=Intake&clearsight=true`,
  searchFields: `${base}/RMIS/STARS.IntakeNotice.mvc/SearchFields?domainName=STARS.IntakeNotice&packageName=RMIS&SessionMode=ReadOnly&appName=Intake&clearsight=true`,
  stormsIntake: `${base}/StarsOne.mvc/StormsIntake?shellApp=rk-clearsight&appName=Intake&clearsight=true`,
};
for (const [k, u] of Object.entries(urls)) {
  const r = await page.evaluate(async (u) => { const r = await fetch(u, { credentials: "include", headers: { "X-Requested-With": "XMLHttpRequest", "Accept": "application/json, text/plain, */*" } }); return { s: r.status, ct: r.headers.get("content-type"), t: await r.text() }; }, u);
  writeFileSync(`${OUT}/meta-${k}.txt`, r.t);
  let keys = "";
  try { const j = JSON.parse(r.t); keys = Array.isArray(j) ? `array[${j.length}] first keys: ${Object.keys(j[0] || {}).join(",")}` : Object.keys(j).join(","); } catch { keys = "(not json)"; }
  console.log(k, r.s, r.ct, r.t.length, "bytes ::", keys.slice(0, 400));
}
await browser.disconnect();
