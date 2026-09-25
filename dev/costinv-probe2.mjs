import puppeteer from "puppeteer-core";
const URL = "https://one.walmart.com/content/uswire/en_us/work1/process-documentation/supercenters/Food-Fresh-and-Consumables/Fresh.html";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();
await page.goto(URL, { waitUntil: "networkidle2", timeout: 90000 });
await new Promise(r => setTimeout(r, 5000));
const info = await page.evaluate(() => {
  const txt = document.body.innerText || "";
  const idx = [];
  const re = /inventor/gi; let m;
  while ((m = re.exec(txt))) idx.push(txt.slice(Math.max(0, m.index - 120), m.index + 200).replace(/\s+/g, " "));
  const links = [...document.querySelectorAll("a")].filter(a => /inventor|cost|calculat|lookup/i.test(a.textContent + " " + a.href))
      .map(a => `${(a.textContent||"").trim().slice(0,70)} -> ${a.href}`);
  return { title: document.title, len: txt.length, head: txt.slice(0, 600).replace(/\s+/g," "), hits: idx.slice(0, 12), links: links.slice(0, 30) };
});
console.log(JSON.stringify(info, null, 1));
await page.close(); await browser.disconnect();
