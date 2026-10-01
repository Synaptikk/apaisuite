import puppeteer from "puppeteer-core";
const APP = "chrome-extension://fchnolphfaklbpdgnofhblfhcailkpdb/app.html";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null, protocolTimeout: 300000 });
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 1000 });
await page.goto(`${APP}#/cx`, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 6000));
// Open the top negative theme so the drill-down is in the shot.
const first = await page.$("[data-bad-themes] .cx-theme-head");
if (first) { await first.click(); await new Promise(r => setTimeout(r, 800)); }
await page.screenshot({ path: process.env.SHOT || "cx-final.png", fullPage: true });
const check = await page.evaluate(() => {
  const styled = getComputedStyle(document.querySelector(".module-cx .cx-panel") || document.body);
  return {
    stylesheetApplied: styled.borderRadius !== "0px",
    themes: document.querySelectorAll(".cx-theme").length,
    tiles: document.querySelectorAll(".cx-tile").length,
    mtdChips: document.querySelectorAll(".cx-delta.is-period").length,
    bars: document.querySelectorAll(".cx-bar-col").length,
    comments: document.querySelectorAll(".cx-comment").length,
    narrative: (document.querySelector("[data-narrative-body]")?.textContent || "").slice(0, 60),
  };
});
console.log(JSON.stringify(check, null, 1));
// Remove the token this test harness injected — it is the user's to paste.
await page.evaluate(() => new Promise((res) => chrome.runtime.sendMessage(
  { module: "cx", type: "setSettings", patch: { gatewayToken: "" } }, res)));
console.log("gateway token cleared from module settings");
await browser.disconnect();
