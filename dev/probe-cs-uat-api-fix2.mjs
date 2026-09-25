// UAT notice 19060: set valid child-lookup answers (respecting parent cascades) via API, then Next through to Submit.
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
const { tok, parents, answers } = await inpage(async (ND) => {
  const g = async (u) => (await fetch(u, { credentials: "include", headers: { Accept: "application/json" } })).json();
  const s = await g("https://uat.riskonnectclearsight.com/Enterprise/StarsOne.mvc/StormsIntake?shellApp=rk-clearsight&appName=Intake&clearsight=true");
  const nd = await g(ND);
  return { tok: s.Token, parents: nd.ParentFieldnames, answers: Object.fromEntries(Object.entries(nd.Answers).map(([k, v]) => [k, v.Value])) };
}, ND);
const firstChild = (field, over) => inpage(async (field, ps, vals) => {
  const u = `https://uat.riskonnectclearsight.com/Enterprise/Orion.Interview/Orion.InterviewAnswers.mvc/MetaData/InterviewLookup?filter=&fieldName=${field}&groupKey=1&parentFieldNames=${ps.join(",")}&parentValues=${vals.map(encodeURIComponent).join(",")}&answersId=19134&templateId=2383&pageSize=200&pageIndex=0&sortOrder=ASC&sortColumn=DESCRIPTION&SessionMode=ReadOnly&setId=1&appName=Intake&clearsight=true`;
  const j = await (await fetch(u, { credentials: "include", headers: { Accept: "application/json" } })).json();
  const it = (j.LookupMessage?.ItemsList || [])[0];
  return it ? [it.Code, it.Description, it.Value, j.LookupMessage.TotalRecords] : null;
}, field, parents[field], parents[field].map(p => over[p] ?? answers[p] ?? ""));
const chosen = {};
const overrides = () => Object.fromEntries(Object.entries(chosen).map(([k, v]) => [k, v[2]]));
for (const f of ["STARS_45", "STARS_35", "STARS_40", "STARS_41"]) { chosen[f] = await firstChild(f, overrides()); console.log(f, "→", JSON.stringify(chosen[f])); }
chosen.STARS_42 = await firstChild("STARS_42", overrides()); console.log("STARS_42 →", JSON.stringify(chosen.STARS_42));
const lk = (f, code, desc, val) => ({ Fieldname: f, Code: code, Description: desc, Value: val ?? code, SortId: 0 });
const setChosen = (fv, f) => { const it = chosen[f]; fv[f] = it[2]; fv[`${f}Lookup`] = lk(f, it[0], it[1], it[2]); };
const post = (u, body) => inpage(async (u, body, tok) => { const r = await fetch(u, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json", custheader: tok, Accept: "application/json, text/plain, */*" }, body }); return { s: r.status, t: (await r.text()).slice(0, 100) }; }, u, JSON.stringify(body), tok);
const base = "https://uat.riskonnectclearsight.com/Enterprise/Orion.Application/Orion.InterviewAnswers.mvc/MetaData";
const invalid = JSON.stringify({ PSTARS_0: [], PSTARS_1: [], PSTARS_2: [], PSTARS_4: [], PSTARS_7: [] });
for (const body of walk) {
  const fv = body.FieldValues;
  if (body.PageId === "Page_STARS_4") {
    fv.STARS_44 = "2"; fv.STARS_44Lookup = lk("STARS_44", "2", "Adverse reaction to a vaccination or inoculation (38)");
    fv.STARS_125 = "HEAD"; fv.STARS_125Lookup = lk("STARS_125", "HEAD", "Head");
    setChosen(fv, "STARS_45");
  } else if (body.PageId === "Page_STARS_7") {
    fv.STARS_34 = "ACT ALLEY"; fv.STARS_34Lookup = lk("STARS_34", "ACT ALLEY", "Action Alley");
    fv.STARS_1152 = "7"; fv.STARS_1152Lookup = lk("STARS_1152", "7", "A. Slip, Trip, or Fall");
    fv.STARS_32 = "GA"; fv.STARS_32Lookup = lk("STARS_32", "GA", "Georgia");
    for (const f of ["STARS_35", "STARS_40", "STARS_41", "STARS_42"]) setChosen(fv, f);
  } else continue;
  body.InvalidQuestions = invalid;
  console.log(body.PageId, "→", JSON.stringify(await post(`${base}/SaveInterview?appName=Intake&clearsight=true`, body)));
}
const chk = await inpage(async (ND) => { const j = await (await fetch(ND, { credentials: "include", headers: { Accept: "application/json" } })).json(); return { invalid: j.NoticeFieldValues?.[0]?.[15], vals: Object.fromEntries(["STARS_45", "STARS_35", "STARS_40", "STARS_41", "STARS_42"].map(k => [k, j.Answers?.[k]?.Value])) }; }, ND);
console.log("after:", JSON.stringify(chk));
// reload and walk Next → Summary, pausing on Photo Evidence until the attachments are listed
await page.reload({ waitUntil: "domcontentloaded" }); await sleep(12000);
const steps = () => inpage(() => [...new Set([...document.querySelectorAll("nav li, [class*='sub-menu'] li, aside li")].map(e => (e.innerText || "").trim()).filter(Boolean))]);
for (let i = 0; i < 8; i++) {
  const st = await steps(); const cur = st[st.length - 1];
  if (cur === "Photo Evidence") {
    for (let w = 0; w < 10; w++) { const t = await inpage(() => document.body.innerText); if (/TEST_photo/.test(t)) break; await sleep(2000); }
    console.log("photo page text:", (await inpage(() => document.body.innerText)).replace(/\n+/g, " | ").slice(900, 1400));
  }
  const hasSubmit = await inpage(() => !![...document.querySelectorAll("button")].find(b => /^submit$/i.test((b.innerText || "").trim()) && b.getBoundingClientRect().width > 0));
  if (hasSubmit) { console.log("Submit visible at", cur); break; }
  const c = await inpage(() => { const b = [...document.querySelectorAll("button")].find(b => (b.innerText || "").trim() === "Next" && b.getBoundingClientRect().width > 0); if (b) { b.click(); return true; } return false; });
  console.log(`Next from ${cur}:`, c); if (!c) break; await sleep(9000);
}
const reqs = [];
page.on("request", r => { if (r.method() === "POST" && /SaveInterview/.test(r.url())) reqs.push({ u: r.url().slice(0, 120), body: r.postData() || "" }); });
page.on("response", async r => { if (/SaveInterview/.test(r.url())) { const i = reqs.findIndex(x => x.resp === undefined); if (i >= 0) { try { reqs[i].resp = (await r.text()).slice(0, 2000); } catch {} } } });
console.log("Submit:", await inpage(() => { const b = [...document.querySelectorAll("button")].find(b => /^submit$/i.test((b.innerText || "").trim()) && b.getBoundingClientRect().width > 0); if (b) { b.click(); return true; } return false; })); await sleep(4000);
console.log("confirm:", await inpage(() => { const m = [...document.querySelectorAll(".slds-modal.slds-fade-in-open, [role=dialog]")].pop(); if (!m) return null; const b = [...m.querySelectorAll("button")].find(b => /^ok$/i.test((b.innerText || "").trim())); b && b.click(); return (m.innerText || "").replace(/\n+/g, " | ").slice(0, 120); }));
await sleep(15000);
const txt = await inpage(() => document.body.innerText);
console.log("URL:", page.url()); console.log("RESULT:", txt.replace(/\n+/g, " | ").slice(0, 3000));
await page.screenshot({ path: `${OUT}/submit5-${NOTICE}-result.png`, fullPage: true });
writeFileSync(`${OUT}/submit5-${NOTICE}-xhr.json`, JSON.stringify(reqs, null, 1));
for (const r of reqs) { try { const b = JSON.parse(r.body); console.log("SAVE:", JSON.stringify({ Command: b.Command, PageId: b.PageId, NoticeStatus: b.NoticeStatus, IsClosing: b.IsClosing, EntityNumber: b.EntityNumber, Invalid: b.InvalidQuestions })); console.log("RESP:", (r.resp || "").slice(0, 400).replace(/\s+/g, " ")); } catch {} }
await browser.disconnect();
