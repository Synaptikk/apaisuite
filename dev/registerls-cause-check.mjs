// dev/registerls-cause-check.mjs — reload the debug-Edge extension, open Register L/S Triage,
// select the first review-bucket shortage with a 🎥 and screenshot the detail pane. Usage: node dev/registerls-cause-check.mjs <out.png>
import puppeteer from "puppeteer-core";
const EXT = "fchnolphfaklbpdgnofhblfhcailkpdb";
const out = process.argv[2] || "registerls-cause.png";
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", protocolTimeout: 240000 });
let page = await browser.newPage();
await page.goto(`chrome-extension://${EXT}/app.html`, { waitUntil: "domcontentloaded" });
await page.evaluate(() => chrome.runtime.reload());
await new Promise((r) => setTimeout(r, 4000));
page = await browser.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`chrome-extension://${EXT}/app.html#/registerls`, { waitUntil: "domcontentloaded" });
await new Promise((r) => setTimeout(r, 9000));
const picked = await page.evaluate(() => {
  const rows = [...document.querySelectorAll(".rls-row.b-review")];
  const row = rows.find((r) => r.textContent.includes("🎥")) || rows[0];
  if (!row) return null;
  row.click();
  return row.textContent.replace(/\s+/g, " ").trim().slice(0, 120);
});
await new Promise((r) => setTimeout(r, 4000));
const info = await page.evaluate(() => ({
  buttons: document.querySelectorAll("[data-action='cause-tx']").length,
  chip: !!document.querySelector(".rls-cause-chip"),
  verdict: document.querySelector(".rls-verdict h2")?.textContent || "",
  textareaStart: (document.querySelector("[data-sug-text]")?.value || "").slice(0, 80),
}));
await page.setViewport({ width: 1400, height: 1000 });
await page.screenshot({ path: out, fullPage: false });
console.log(JSON.stringify({ picked, info, errors: errors.slice(0, 5) }, null, 1));
browser.disconnect();
