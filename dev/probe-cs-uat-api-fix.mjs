// UAT notice 19060: re-post the recorded per-page SaveInterview bodies with the missing lookup answers filled, then submit from the UI.
import puppeteer from "puppeteer-core";
import { readFileSync, writeFileSync } from "node:fs";
const OUT = "C:/Users/SES008~1.S01/AppData/Local/Temp/claude/C--Users-ses008s-s01458-Desktop-APAISuite/040c3438-1536-48d3-9351-7c26de274ae3/scratchpad";
const NOTICE = 19060;
const walk = JSON.parse(readFileSync(`${OUT}/walk-${NOTICE}-xhr.json`, "utf8")).filter(r => /SaveInterview/.test(r.u)).map(r => JSON.parse(r.body));
const lk = JSON.parse(readFileSync(`${OUT}/lookups.json`, "utf8"));
const setLookup = (fv, field, code) => { const it = (lk[field]?.items || []).find(x => x[0] === code) || [code, code, code]; fv[field] = it[2]; fv[`${field}Lookup`] = { Fieldname: field, Code: it[0], Description: it[1], Value: it[2], SortId: 0 }; };
const fixes = {
  Page_STARS_4:  { STARS_44: "2", STARS_125: "HEAD", STARS_45: "61" },                                   // leaving GL_Customer Statement
  Page_STARS_7:  { STARS_34: "ACT ALLEY", STARS_35: "289", STARS_32: "GA", STARS_1152: "7", STARS_40: "101", STARS_41: "1", STARS_42: "1" }, // leaving GL_Incident Summary
  Page_STARS_36: { STARS_561: "ASSOC-FACT", STARS_119: "N" },                                            // leaving Witness Statements
};
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 300000 });
const page = (await browser.pages()).find(p => new RegExp("intakenotice/" + NOTICE).test(p.url()));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const post = (u, body) => page.evaluate(async (u, body) => { const tok = (await (await fetch("https://uat.riskonnectclearsight.com/Enterprise/StarsOne.mvc/StormsIntake?shellApp=rk-clearsight&appName=Intake&clearsight=true", { credentials: "include" })).json()).Token; const r = await fetch(u, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json", custheader: tok, Accept: "application/json, text/plain, */*" }, body }); return { s: r.status, t: (await r.text()).slice(0, 200) }; }, u, JSON.stringify(body));
const base = "https://uat.riskonnectclearsight.com/Enterprise/Orion.Application/Orion.InterviewAnswers.mvc/MetaData";
const invalid = { PSTARS_0: [], PSTARS_1: [], PSTARS_2: [], PSTARS_4: [], PSTARS_7: [] };
for (const body of walk) {
  const fx = fixes[body.PageId]; if (!fx) continue;
  for (const [f, code] of Object.entries(fx)) setLookup(body.FieldValues, f, code);
  body.InvalidQuestions = JSON.stringify(invalid);
  const r = await post(`${base}/SaveInterview?appName=Intake&clearsight=true`, body);
  console.log(body.PageId, "→", r.s, r.t.slice(0, 120));
}
const chk = await page.evaluate(async () => { const r = await fetch("https://uat.riskonnectclearsight.com/Enterprise/Orion.Interview/Orion.InterviewAnswers.mvc/MetaData/NoticeData2?templateId=2383&noticeId=19060&answerId=19134&SessionMode=ReadOnly&appName=Intake&clearsight=true", { credentials: "include", headers: { Accept: "application/json" } }); const j = await r.json(); return { visited: j.VisitedPages, status: j.NoticeStatus, vals: Object.fromEntries(["STARS_44","STARS_125","STARS_45","STARS_34","STARS_35","STARS_32","STARS_1152","STARS_40","STARS_41","STARS_42","STARS_561","STARS_119"].map(k => [k, j.Answers?.[k]?.Value])), multi: j.MultiValueSelectedLookupData?.STARS_561, nv: j.NoticeFieldValues }; });
console.log("NoticeData2:", JSON.stringify(chk));
// reload the tab, navigate to GL_Summary, submit
await page.reload({ waitUntil: "domcontentloaded" }); await sleep(12000);
const hs = await page.$$("li, a, span, div"); let nav = false;
for (const h of hs) { const t = ((await (await h.getProperty("innerText")).jsonValue()) || "").trim(); if (t === "GL_Summary") { const box = await h.boundingBox(); if (box && box.width < 400) { await h.click(); nav = true; break; } } }
console.log("nav GL_Summary:", nav); await sleep(8000);
const reqs = [];
page.on("request", r => { if (r.method() === "POST" && /SaveInterview/.test(r.url())) reqs.push({ u: r.url().slice(0, 120), body: r.postData() || "" }); });
page.on("response", async r => { if (/SaveInterview/.test(r.url())) { const i = reqs.findIndex(x => x.resp === undefined); if (i >= 0) { try { reqs[i].resp = (await r.text()).slice(0, 1500); } catch {} } } });
const sub = await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find(b => /^submit$/i.test((b.innerText || "").trim()) && b.getBoundingClientRect().width > 0); if (b) { b.click(); return true; } return false; });
console.log("Submit:", sub); await sleep(4000);
console.log("confirm:", await page.evaluate(() => { const m = [...document.querySelectorAll(".slds-modal.slds-fade-in-open, [role=dialog]")].pop(); if (!m) return null; const b = [...m.querySelectorAll("button")].find(b => /^ok$/i.test((b.innerText || "").trim())); b && b.click(); return (m.innerText || "").replace(/\n+/g, " | ").slice(0, 200); }));
await sleep(15000);
const txt = await page.evaluate(() => document.body.innerText);
console.log("URL:", page.url());
console.log("RESULT:", txt.replace(/\n+/g, " | ").slice(0, 2500));
await page.screenshot({ path: `${OUT}/submit3-${NOTICE}-result.png`, fullPage: true });
writeFileSync(`${OUT}/submit3-${NOTICE}-xhr.json`, JSON.stringify(reqs, null, 1));
for (const r of reqs) { try { const b = JSON.parse(r.body); console.log("SAVE:", JSON.stringify({ Command: b.Command, PageId: b.PageId, NoticeStatus: b.NoticeStatus, IsClosing: b.IsClosing, EntityNumber: b.EntityNumber, Invalid: b.InvalidQuestions?.slice(0, 200) })); console.log("RESP:", (r.resp || "").slice(0, 300)); } catch {} }
await browser.disconnect();
