// dev/probe-final-screenshots.mjs
//
// Quick wait-then-screenshot probe to capture the populated final state
// after bootstrap completes (the previous probe screenshotted too early).
import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });

const extPage = await browser.newPage();
await extPage.goto("edge://extensions/", { waitUntil: "domcontentloaded" });
const all = await extPage.evaluate(async () =>
  new Promise((r) => chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true }, r)));
const extensionId = all.find((x) => x.name === "APAISuite").id;
await extPage.close();

const appPage = await browser.newPage();
await appPage.setViewport({ width: 1700, height: 1050 });
await appPage.goto(`chrome-extension://${extensionId}/app.html#/home`, { waitUntil: "domcontentloaded" });
await new Promise((r) => setTimeout(r, 8_000));  // let in-flight pulls complete

// Force a state reload so view's lastState is fresh
await appPage.evaluate(async () => {
  // Send any message to wake SW and trigger view refresh
  await new Promise((resolve) => chrome.runtime.sendMessage({ module: "livedashboard", type: "get_dashboard_state" }, resolve));
});
await new Promise((r) => setTimeout(r, 1500));

// Click each drillable widget in turn, screenshot
async function clickDrill(widget, screenshotPath) {
  await appPage.evaluate((w) => document.querySelector("#"+w)?.click(), widget);
  await new Promise((r) => setTimeout(r, 800));
  await appPage.screenshot({ path: screenshotPath });
  // Close it
  await appPage.evaluate(() => document.querySelector("#ld-drill-close")?.click());
  await new Promise((r) => setTimeout(r, 400));
}

await appPage.screenshot({ path: "after-bootstrap-strip.png" });
await clickDrill("ld-w-accident",   "after-bootstrap-accident.png");
await clickDrill("ld-w-compliance", "after-bootstrap-compliance.png");

console.log("✓ screenshots taken");
browser.disconnect();
process.exit(0);
