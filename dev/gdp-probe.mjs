import puppeteer from "puppeteer-core";
const URL = "https://gdp-connect.walmart.com/user/projects/20/dashboards/351";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();
const net = [];
page.on("response", async r => {
  if (!["xhr","fetch"].includes(r.request().resourceType())) return;
  if (/google-analytics|omtrdc|adobedtm/.test(r.url())) return;
  let body=""; try { body = (await r.text()).slice(0,900); } catch {}
  net.push(`${r.status()} ${r.request().method()} ${r.url()}\n   POST: ${(r.request().postData()||"").slice(0,700).replace(/\s+/g," ")}\n   BODY: ${body.replace(/\s+/g," ")}`);
});
await page.goto(URL, { waitUntil: "networkidle2", timeout: 150000 });
await new Promise(r => setTimeout(r, 10000));
console.log("=== FINAL URL ===", page.url());
console.log("=== XHR ===\n" + net.join("\n\n"));
const dom = await page.evaluate(() => ({
  text: (document.body.innerText||"").replace(/\n{2,}/g,"\n").slice(0, 2000),
  inputs: [...document.querySelectorAll("input,select,button")].slice(0,40)
    .map(e=>`${e.tagName} type=${e.type||""} id=${e.id||""} name=${e.name||""} ph=${e.placeholder||""} aria=${e.getAttribute("aria-label")||""} txt=${(e.textContent||"").trim().slice(0,30)}`),
}));
console.log("=== TEXT ===\n" + dom.text);
console.log("=== CONTROLS ===\n" + dom.inputs.join("\n"));
await page.close(); await browser.disconnect();
