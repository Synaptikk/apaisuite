import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 180000 });
const page = (await browser.pages()).find(p => /uat\.riskonnectclearsight\.com.*intakenotice\/\d+/.test(p.url()));
const base = "https://uat.riskonnectclearsight.com/Enterprise/Orion.Interview/Orion.InterviewAnswers.mvc/MetaData/Lookup?fieldname=STARS_464&templateId=2383&SessionMode=ReadOnly&appName=Intake&clearsight=true";
for (const extra of ["&pageNumber=1", "&currentPage=1", "&rowsPerPage=100", "&RowsPerPage=100", "&pageSize=100", "&searchText=3:", "&search=3:", "&filter=3:", "&EnablePaging=false", "&maxrec=2000"]) {
  const r = await page.evaluate(async (u) => { const r = await fetch(u, { credentials: "include", headers: { "X-Requested-With": "XMLHttpRequest", Accept: "application/json" } }); const j = await r.json(); return { s: r.status, n: (j.ItemsList||[]).length, total: j.TotalRecords, page: j.CurrentPage, rpp: j.RowsPerPage, first: (j.ItemsList||[])[0]?.Description, last: (j.ItemsList||[]).slice(-1)[0]?.Description }; }, base + extra);
  console.log(extra.padEnd(22), JSON.stringify(r));
}
await browser.disconnect();
