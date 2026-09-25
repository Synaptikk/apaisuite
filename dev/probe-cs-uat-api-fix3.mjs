// UAT notice 19060: fix STARS_42 with the cascade (STARS_41 + STARS_713), open the Attach modal on the Photo page so the client counts the photos, then Submit.
import puppeteer from "puppeteer-core";
import { readFileSync, writeFileSync } from "node:fs";
const OUT = "C:/Users/SES008~1.S01/AppData/Local/Temp/claude/C--Users-ses008s-s01458-Desktop-APAISuite/040c3438-1536-48d3-9351-7c26de274ae3/scratchpad";
const NOTICE = 19060;
const walk = JSON.parse(readFileSync(`${OUT}/walk-${NOTICE}-xhr.json`, "utf8")).filter(r => /SaveInterview/.test(r.u)).map(r => JSON.parse(r.body));
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 300000 });
const page = (await browser.pages()).find(p => new RegExp("intakenotice/" + NOTICE).test(p.url()));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const inpage = (fn, ...args) => page.evaluate(fn, ...args);
const ND = "https://uat.riskonnectclearsight.com/Enterprise/Orion.Interview/Orion.InterviewAnswers.mvc/MetaData/NoticeData2?templateId=2383&noticeId=19060&answerId=19134&SessionMode=ReadOnly&appName=Intake&clearsight=true";
const { tok, answers, parents } = await inpage(async (ND) => {
  const g = async (u) => (await fetch(u, { credentials: "include", headers: { Accept: "application/json" } })).json();
  const s = await g("https://uat.riskonnectclearsight.com/Enterprise/StarsOne.mvc/StormsIntake?shellApp=rk-clearsight&appName=Intake&clearsight=true");
  const nd = await g(ND);
  return { tok: s.Token, parents: nd.ParentFieldnames, answers: Object.fromEntries(Object.entries(nd.Answers).map(([k, v]) => [k, v.Value])) };
}, ND);
console.log("STARS_41 =", answers.STARS_41, "STARS_713 =", answers.STARS_713, "parents(42) =", parents.STARS_42);
const opts42 = await inpage(async (ps, vals) => {
  const u = `https://uat.riskonnectclearsight.com/Enterprise/Orion.Interview/Orion.InterviewAnswers.mvc/MetaData/InterviewLookup?filter=&fieldName=STARS_42&groupKey=1&parentFieldNames=${ps.join(",")}&parentValues=${vals.map(encodeURIComponent).join(",")}&answersId=19134&templateId=2383&pageSize=200&pageIndex=0&sortOrder=ASC&sortColumn=DESCRIPTION&SessionMode=ReadOnly&setId=1&appName=Intake&clearsight=true`;
  const j = await (await fetch(u, { credentials: "include", headers: { Accept: "application/json" } })).json();
  return { total: j.LookupMessage?.TotalRecords, items: (j.LookupMessage?.ItemsList || []).slice(0, 5).map(x => [x.Code, x.Description, x.Value]) };
}, parents.STARS_42, parents.STARS_42.map(p => (p === "STARS_713" ? answers.STARS_41 : answers[p]) ?? ""));
console.log("STARS_42 options given 41/713 =", answers.STARS_41, "→", JSON.stringify(opts42));
const it = opts42.items[0];
const post = (u, body) => inpage(async (u, body, tok) => { const r = await fetch(u, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json", custheader: tok, Accept: "application/json, text/plain, */*" }, body }); return { s: r.status, t: (await r.text()).slice(0, 80) }; }, u, JSON.stringify(body), tok);
const base = "https://uat.riskonnectclearsight.com/Enterprise/Orion.Application/Orion.InterviewAnswers.mvc/MetaData";
const body = walk.find(b => b.PageId === "Page_STARS_7");
const fv = body.FieldValues;
// carry every current answer for that page's keys so we do not regress the earlier fixes
for (const k of Object.keys(fv)) { if (/^STARS_\d+$/.test(k) && answers[k] != null) fv[k] = answers[k]; }
for (const f of ["STARS_34", "STARS_1152", "STARS_32", "STARS_35", "STARS_40", "STARS_41"]) { const v = answers[f]; fv[f] = v; fv[`${f}Lookup`] = { Fieldname: f, Code: v, Description: v, Value: v, SortId: 0 }; }
fv.STARS_42 = it[2]; fv.STARS_42Lookup = { Fieldname: "STARS_42", Code: it[0], Description: it[1], Value: it[2], SortId: 0 };
fv.STARS_713 = answers.STARS_41; fv.STARS_714 = it[2];
body.InvalidQuestions = JSON.stringify({ PSTARS_0: [], PSTARS_1: [], PSTARS_2: [], PSTARS_4: [], PSTARS_7: [] });
console.log("save page STARS_4 →", JSON.stringify(await post(`${base}/SaveInterview?appName=Intake&clearsight=true`, body)));
console.log("after:", JSON.stringify(await inpage(async (ND) => { const j = await (await fetch(ND, { credentials: "include", headers: { Accept: "application/json" } })).json(); return { invalid: j.NoticeFieldValues?.[0]?.[15], v42: j.Answers?.STARS_42?.Value, v41: j.Answers?.STARS_41?.Value }; }, ND)));
await page.reload({ waitUntil: "domcontentloaded" }); await sleep(12000);
const steps = () => inpage(() => [...new Set([...document.querySelectorAll("nav li, [class*='sub-menu'] li, aside li")].map(e => (e.innerText || "").trim()).filter(Boolean))]);
const reqs = [];
page.on("request", r => { if (/AttachmentList|SaveInterview|ManagerTotalItemCount/.test(r.url())) reqs.push({ m: r.method(), u: r.url().replace("https://uat.riskonnectclearsight.com/Enterprise/", "").slice(0, 160), body: r.postData() || "" }); });
page.on("response", async r => { if (/AttachmentList|SaveInterview|ManagerTotalItemCount/.test(r.url())) { const i = reqs.findIndex(x => r.url().includes(x.u.slice(0, 60)) && x.resp === undefined); if (i >= 0) { try { reqs[i].resp = (await r.text()).slice(0, 1500); } catch {} } } });
for (let i = 0; i < 8; i++) {
  const st = await steps(); const cur = st[st.length - 1];
  if (cur === "Photo Evidence") {
    await inpage(() => { const a = [...document.querySelectorAll("a, button")].find(x => /attach photos/i.test(x.innerText || "")); a && a.click(); }); await sleep(5000);
    const modal = await inpage(() => { const m = document.querySelector(".slds-modal.slds-fade-in-open"); return (m?.innerText || "").replace(/\n+/g, " | ").slice(0, 400); });
    console.log("attach modal:", modal);
    await inpage(() => { const m = document.querySelector(".slds-modal.slds-fade-in-open"); const b = m && [...m.querySelectorAll("button")].find(b => /^(done|cancel|close)$/i.test((b.innerText || "").trim())); b && b.click(); }); await sleep(2000);
    console.log("photo page after modal:", (await inpage(() => document.body.innerText)).replace(/\n+/g, " | ").slice(1000, 1500));
  }
  const hasSubmit = await inpage(() => !![...document.querySelectorAll("button")].find(b => /^submit$/i.test((b.innerText || "").trim()) && b.getBoundingClientRect().width > 0));
  if (hasSubmit) { console.log("Submit visible at", cur); break; }
  const c = await inpage(() => { const b = [...document.querySelectorAll("button")].find(b => (b.innerText || "").trim() === "Next" && b.getBoundingClientRect().width > 0); if (b) { b.click(); return true; } return false; });
  console.log(`Next from ${cur}:`, c); if (!c) break; await sleep(9000);
}
console.log("Submit:", await inpage(() => { const b = [...document.querySelectorAll("button")].find(b => /^submit$/i.test((b.innerText || "").trim()) && b.getBoundingClientRect().width > 0); if (b) { b.click(); return true; } return false; })); await sleep(4000);
console.log("confirm:", await inpage(() => { const m = [...document.querySelectorAll(".slds-modal.slds-fade-in-open, [role=dialog]")].pop(); if (!m) return null; const b = [...m.querySelectorAll("button")].find(b => /^ok$/i.test((b.innerText || "").trim())); b && b.click(); return (m.innerText || "").replace(/\n+/g, " | ").slice(0, 120); }));
await sleep(15000);
const txt = await inpage(() => document.body.innerText);
console.log("URL:", page.url()); console.log("RESULT:", txt.replace(/\n+/g, " | ").slice(0, 3000));
await page.screenshot({ path: `${OUT}/submit6-${NOTICE}-result.png`, fullPage: true });
writeFileSync(`${OUT}/submit6-${NOTICE}-xhr.json`, JSON.stringify(reqs, null, 1));
for (const r of reqs) { let meta = ""; try { const b = JSON.parse(r.body); meta = JSON.stringify({ Command: b.Command, PageId: b.PageId, NoticeStatus: b.NoticeStatus, IsClosing: b.IsClosing, EntityNumber: b.EntityNumber, Invalid: b.InvalidQuestions }); } catch {} console.log(r.m, r.u.slice(0, 100), meta, "RESP:", (r.resp || "").slice(0, 300).replace(/\s+/g, " ")); }
await browser.disconnect();
