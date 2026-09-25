// Can lookuptools.json be called directly (no page driving)? And how do we
// discover the CURRENT month's toolId instead of hard-coding it?
import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();
await page.goto("https://one.walmart.com/content/uswire/en_us/work1/merchandise/fresh.html", { waitUntil: "domcontentloaded", timeout: 90000 });
await new Promise(r => setTimeout(r, 3000));

// 1. map every lookup tool on the page -> heading text + toolId
const map = await page.evaluate(() => {
  return [...document.querySelectorAll(".lookup-tool-search-component")].map(c => {
    const id = c.id.replace("search-component-", "");
    let n = c, heading = "";
    for (let k = 0; k < 8 && n.parentElement; k++) {
      n = n.parentElement;
      const h = n.querySelector("h1,h2,h3,h4,strong,b");
      if (h && (h.textContent||"").trim().length > 4) { heading = h.textContent.trim(); break; }
    }
    const headers = [...(c.parentElement.querySelectorAll("th")||[])].map(t=>t.textContent.trim());
    return { id, heading, headers };
  });
});
console.log("=== TOOLS ON PAGE ===\n" + JSON.stringify(map, null, 1));

// 2. plain fetch, no extra headers, from the page origin
const direct = await page.evaluate(async () => {
  const r = await fetch("/content/api/adp/lookuptools.json", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "toolId=6cfabc601432d31fd0998a65d6c717b0&primaryId=1458",
    credentials: "include",
  });
  return { status: r.status, body: (await r.text()).slice(0, 700) };
});
console.log("=== DIRECT FETCH (no CSRF header) ===\n" + JSON.stringify(direct, null, 1));

// 3. does it work with no primaryId (all stores)?
const all = await page.evaluate(async () => {
  const r = await fetch("/content/api/adp/lookuptools.json", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "toolId=6cfabc601432d31fd0998a65d6c717b0", credentials: "include" });
  const t = await r.text();
  return { status: r.status, len: t.length, head: t.slice(0, 300) };
});
console.log("=== NO primaryId ===\n" + JSON.stringify(all, null, 1));
await page.close(); await browser.disconnect();
