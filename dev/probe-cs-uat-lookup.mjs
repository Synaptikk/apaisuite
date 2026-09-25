// UAT: test the Lookup endpoint shape for a few interview lookup fields.
import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 180000 });
const page = (await browser.pages()).find(p => /uat\.riskonnectclearsight\.com.*intakenotice\/\d+/.test(p.url()));
const base = "https://uat.riskonnectclearsight.com/Enterprise/Orion.Interview/Orion.InterviewAnswers.mvc/MetaData";
const tests = [
  `${base}/Lookup?fieldname=STARS_464&SessionMode=ReadOnly&appName=Intake&clearsight=true`,
  `${base}/Lookup?fieldname=STARS_464&templateId=2383&SessionMode=ReadOnly&appName=Intake&clearsight=true`,
  `${base}/Lookup?fieldname=STARS_464&templateId=2383&noticeId=19059&answerId=19133&SessionMode=ReadOnly&appName=Intake&clearsight=true`,
  `${base}/Lookup?fieldname=STARS_792&templateId=2383&noticeId=19059&answerId=19133&SessionMode=ReadOnly&appName=Intake&clearsight=true`,
  `${base}/Lookup?fieldname=STARS_462&templateId=2383&noticeId=19059&answerId=19133&SessionMode=ReadOnly&appName=Intake&clearsight=true`,
];
for (const u of tests) {
  const r = await page.evaluate(async (u) => { try { const r = await fetch(u, { credentials: "include", headers: { "X-Requested-With": "XMLHttpRequest", Accept: "application/json" } }); return { s: r.status, t: (await r.text()).slice(0, 700) }; } catch (e) { return { s: -1, t: String(e) }; } }, u);
  console.log("\n>>", u.replace(base, ""), "\n", r.s, r.t);
}
await browser.disconnect();
