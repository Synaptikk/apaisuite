import puppeteer from "puppeteer-core";
const URL = "https://one.walmart.com/content/uswire/en_us/work1/merchandise/fresh.html";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();
await page.goto(URL, { waitUntil: "networkidle2", timeout: 90000 });
await new Promise(r => setTimeout(r, 3000));
const out = await page.evaluate(() => {
  const res = { headings: [], tools: [] };
  document.querySelectorAll("h1,h2,h3,h4,strong,b").forEach(h => {
    const t = (h.textContent||"").trim();
    if (/lookup|inventory/i.test(t) && t.length < 120) res.headings.push(t);
  });
  [...document.querySelectorAll("input.search-tool")].forEach((inp, i) => {
    // climb until we find a node whose text includes a heading-ish label
    let n = inp, label = "";
    for (let k = 0; k < 10 && n.parentElement; k++) {
      n = n.parentElement;
      const t = (n.innerText||"").trim().replace(/\s+/g," ");
      if (t.length > 20) { label = t.slice(0,150); break; }
    }
    res.tools.push({ i, label, parentHtml: inp.parentElement.outerHTML.slice(0, 800) });
  });
  return res;
});
console.log(JSON.stringify(out, null, 1).slice(0, 5000));
await page.close(); await browser.disconnect();
