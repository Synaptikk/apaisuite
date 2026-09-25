import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();
await page.goto("https://one.walmart.com/content/uswire/en_us/work1/merchandise/fresh.html", { waitUntil: "domcontentloaded", timeout: 90000 });
await new Promise(r => setTimeout(r, 2500));
const out = await page.evaluate(async () => {
  const body = "toolId=6cfabc601432d31fd0998a65d6c717b0&primaryId=1458";
  const tok = await (await fetch("/libs/granite/csrf/token.json", { credentials: "include" })).json().catch(() => ({}));
  const tries = {
    xrw: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
    csrf: { "Content-Type": "application/x-www-form-urlencoded", "CSRF-Token": tok.token || "" },
    both: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest", "CSRF-Token": tok.token || "" },
  };
  const res = {};
  for (const [k, headers] of Object.entries(tries)) {
    try {
      const r = await fetch("/content/api/adp/lookuptools.json", { method: "POST", headers, body, credentials: "include" });
      const t = await r.text();
      res[k] = { status: r.status, body: t.slice(0, 260).replace(/\s+/g, " ") };
    } catch (e) { res[k] = { err: String(e) }; }
  }
  return { token: (tok.token||"").slice(0, 20) + "...", res };
});
console.log(JSON.stringify(out, null, 1));
await page.close(); await browser.disconnect();
