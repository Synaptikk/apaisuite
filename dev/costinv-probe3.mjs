import puppeteer from "puppeteer-core";
const URL = "https://one.walmart.com/content/uswire/en_us/work1/merchandise/fresh.html";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();
const net = [];
page.on("response", async r => {
  const t = r.request().resourceType();
  if (t === "xhr" || t === "fetch") {
    let body = "";
    try { body = (await r.text()).slice(0, 500); } catch {}
    net.push(`${r.status()} ${r.request().method()} ${r.url()}\n     BODY: ${body.replace(/\s+/g," ")}`);
  }
});
await page.goto(URL, { waitUntil: "networkidle2", timeout: 90000 });
await new Promise(r => setTimeout(r, 4000));

const dom = await page.evaluate(() => {
  const near = [];
  const walker = document.evaluate("//*[contains(text(),'Beginning Inventory Store Lookup') or contains(text(),'Search Facility')]", document, null, 6, null);
  for (let i = 0; i < walker.snapshotLength && i < 4; i++) {
    let n = walker.snapshotItem(i);
    let box = n; for (let k = 0; k < 5 && box.parentElement; k++) box = box.parentElement;
    near.push(box.outerHTML.slice(0, 2500));
  }
  const inputs = [...document.querySelectorAll("input,select,button")].map(e => `${e.tagName} type=${e.type||""} id=${e.id||""} name=${e.name||""} cls=${(e.className||"").toString().slice(0,60)} ph=${e.placeholder||""} txt=${(e.textContent||"").trim().slice(0,40)}`);
  return { near, inputs: inputs.slice(0, 40), scripts: [...document.querySelectorAll("script[src]")].map(s=>s.src).filter(s=>/fresh|inventory|lookup|tool/i.test(s)) };
});
console.log("=== NETWORK xhr/fetch on load ===\n" + net.join("\n"));
console.log("=== INPUTS ===\n" + dom.inputs.join("\n"));
console.log("=== SCRIPTS ===\n" + dom.scripts.join("\n"));
console.log("=== NEAR TOOL ===\n" + dom.near.join("\n\n-----\n\n"));
await page.close(); await browser.disconnect();
