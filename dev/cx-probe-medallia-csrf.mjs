import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const pages = await browser.pages();
const page = pages.find(p => /walmart\.medallia\.com/.test(p.url()));
if (!page) { console.log("no medallia page open"); process.exit(1); }
console.log("page:", page.url().slice(0,90));
const found = await page.evaluate(() => {
  const out = { metas: [], cookies: document.cookie.split("; ").map(c=>c.split("=")[0]), globals: [], htmlHits: [] };
  document.querySelectorAll("meta").forEach(m => out.metas.push({ name: m.getAttribute("name")||m.getAttribute("property"), content: (m.content||"").slice(0,120) }));
  for (const k of Object.keys(window)) {
    if (/csrf|token|config|medallia/i.test(k)) out.globals.push(k);
  }
  const html = document.documentElement.outerHTML;
  const re = /csrf[^"'<>]{0,30}["'>: ]+([A-Za-z0-9+/=|_-]{30,})/gi;
  let m; while ((m = re.exec(html)) && out.htmlHits.length < 5) out.htmlHits.push(m[0].slice(0,220));
  return out;
});
console.log(JSON.stringify(found, null, 1).slice(0, 4000));
await browser.disconnect();
