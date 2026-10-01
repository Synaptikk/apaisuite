// With no Medallia history but a stored Ops Portal stopgap, the Comments panel
// should show those rows, labelled, and the theme/trend panels should stay down.
import puppeteer from "puppeteer-core";
const APP = "chrome-extension://fchnolphfaklbpdgnofhblfhcailkpdb/app.html";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null, protocolTimeout: 300000 });
const page = (await browser.pages()).find(p => p.url().includes("app.html")) || await browser.newPage();
await page.goto(`${APP}#/cx`, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 3000));

// Stash the real history, then stand up the failure state.
const saved = await page.evaluate(async () => {
  const g = await chrome.storage.local.get("cx.comments.v1");
  await chrome.storage.local.remove("cx.comments.v1");
  await chrome.storage.local.set({ "cx.fallback.v1": {
    storeNbr: "1458", pulledAt: Date.now(),
    rows: [
      { date: "2026-09-18", journey: "Store", rating: 5, text: "Cheryl S was absolutely wonderful." },
      { date: "2026-09-17", journey: "Store", rating: 2, text: "Staff did not seem concerned with customers." },
      { date: "2026-09-14", journey: "Scheduled Pickup & Delivery", rating: 1, text: "Never received order." },
    ] } });
  return g["cx.comments.v1"] ?? null;
});
console.log("history stashed:", saved ? saved.records.length + " records" : "none");

await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 5000));

const check = await page.evaluate(() => ({
  commentsPanelShown: !document.querySelector("[data-comments-panel]")?.hidden,
  columnsHidden: !!document.querySelector("[data-columns]")?.hidden,
  trendHidden: !!document.querySelector("[data-trend-panel]")?.hidden,
  movementHidden: !!document.querySelector("[data-movement-panel]")?.hidden,
  sub: document.querySelector("[data-comments-sub]")?.textContent?.trim(),
  note: document.querySelector("[data-comment-list] .cx-note")?.textContent?.replace(/\s+/g, " ").trim().slice(0, 160),
  rows: document.querySelectorAll(".cx-comment").length,
  searchHidden: !!document.querySelector("[data-comment-search]")?.hidden,
  exportHidden: !!document.querySelector("[data-action='export-comments']")?.hidden,
}));
console.log(JSON.stringify(check, null, 1));

// Put it back exactly as it was.
await page.evaluate(async (box) => {
  await chrome.storage.local.remove("cx.fallback.v1");
  if (box) await chrome.storage.local.set({ "cx.comments.v1": box });
}, saved);
console.log("history restored");
await browser.disconnect();
