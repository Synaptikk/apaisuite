// UAT notice 19060: replay the recorded InterviewUpdate + SaveInterview payloads via fetch (API route, no DOM),
// correcting the answers, then open the notice tab and see what the wizard shows.
import puppeteer from "puppeteer-core";
import { readFileSync, writeFileSync } from "node:fs";
const OUT = "C:/Users/SES008~1.S01/AppData/Local/Temp/claude/C--Users-ses008s-s01458-Desktop-APAISuite/040c3438-1536-48d3-9351-7c26de274ae3/scratchpad";
const NOTICE = 19060, ANSWER = 19134;
const rec = JSON.parse(readFileSync(`${OUT}/step1-xhr.json`, "utf8"));
const upd = JSON.parse(rec.find(r => r.u.includes("InterviewUpdate")).body);
const sav = JSON.parse(rec.find(r => r.u.includes("SaveInterview")).body);
const patch = (fv) => {
  Object.assign(fv, { STARS_458: "9/16/2026", STARS_464: "1130", STARS_792: "2645", STARS_56: "2645", STARS_560: "2645", STARS_184: "9/16/2026", STARS_454: "CUST", STARS_7: "GL", STARS_312: "N", STARS_10: "N", STARS_322: "", STARS_11: "5555550100", STARS_26: "SHANE SMITH - SES008S.S01458" });
  fv.STARS_464Lookup = { Fieldname: null, Code: "1130", Description: "11:30 AM", Value: "1130", SortId: 0, Selected: false };
  fv.STARS_792Lookup = { Fieldname: null, Code: "1458", Description: "1458 - FORT OGLETHORPE BATTLEFIELD PARKWAY", Value: "2645", SortId: 0, Selected: false };
  return fv;
};
upd.AnswersId = ANSWER; patch(upd.DataDictionary);
sav.AnswersId = ANSWER; sav.NoticeId = NOTICE; patch(sav.FieldValues); sav.VisitedPages = ["STARS_0", "STARS_1"]; sav.PageId = "Page_STARS_1"; sav.InvalidQuestions = JSON.stringify({ PSTARS_0: [] });
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 180000 });
const list = (await browser.pages()).find(p => p.url().includes("uat.riskonnectclearsight.com"));
const post = (u, body) => list.evaluate(async (u, body) => { const tok = (await (await fetch("https://uat.riskonnectclearsight.com/Enterprise/StarsOne.mvc/StormsIntake?shellApp=rk-clearsight&appName=Intake&clearsight=true", { credentials: "include" })).json()).Token; const r = await fetch(u, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json", custheader: tok, Accept: "application/json, text/plain, */*" }, body }); return { s: r.status, t: (await r.text()).slice(0, 600) }; }, u, JSON.stringify(body));
const base = "https://uat.riskonnectclearsight.com/Enterprise/Orion.Application/Orion.InterviewAnswers.mvc/MetaData";
console.log("InterviewUpdate:", JSON.stringify(await post(`${base}/InterviewUpdate?appName=Intake&clearsight=true`, upd)));
console.log("SaveInterview:", JSON.stringify(await post(`${base}/SaveInterview?appName=Intake&clearsight=true`, sav)));
const chk = await list.evaluate(async () => { const r = await fetch("https://uat.riskonnectclearsight.com/Enterprise/Orion.Interview/Orion.InterviewAnswers.mvc/MetaData/NoticeData2?templateId=2383&noticeId=19060&answerId=19134&SessionMode=ReadOnly&appName=Intake&clearsight=true", { credentials: "include", headers: { "X-Requested-With": "XMLHttpRequest", Accept: "application/json" } }); const j = await r.json(); return { noticeStatus: j.NoticeStatus, visited: j.VisitedPages, answers: Object.fromEntries(["STARS_458","STARS_464","STARS_792","STARS_184","STARS_454","STARS_7","STARS_312","STARS_10","STARS_322","STARS_11"].map(k => [k, j.Answers?.[k]?.Value])) }; });
console.log("NoticeData2 after:", JSON.stringify(chk));
const page = await browser.newPage();
await page.goto(`https://uat.riskonnectclearsight.com/Enterprise/app/Clearsight/#/intake/stars.intakenotice/${NOTICE}?isNew=true&groupKeys=&templateId=2383&answerId=${ANSWER}`, { waitUntil: "domcontentloaded" });
await page.bringToFront();
await new Promise(r => setTimeout(r, 12000));
const txt = await page.evaluate(() => document.body.innerText);
console.log("WIZARD:", txt.replace(/\n+/g, " | ").slice(0, 1200));
await page.screenshot({ path: `${OUT}/uat-19060-after-replay.png`, fullPage: true });
await browser.disconnect();
