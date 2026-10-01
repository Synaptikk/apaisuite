import puppeteer from "puppeteer-core";
const APP = "chrome-extension://fchnolphfaklbpdgnofhblfhcailkpdb/app.html";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const pages = await browser.pages();
console.log("open tabs:");
for (const p of pages) console.log("  ", p.url().slice(0, 110));
const shell = pages.find(p => p.url().includes("app.html"));
if (shell) {
  const st = await shell.evaluate(async () => {
    const got = await chrome.storage.local.get(null);
    const keys = Object.keys(got).filter(k => k.startsWith("cx."));
    const out = {};
    for (const k of keys) {
      const v = got[k];
      out[k] = k === "cx.comments.v1"
        ? { records: v.records?.length, from: v.from, to: v.to, total: v.total, pulledAt: v.pulledAt }
        : k === "cx.scores.v1"
          ? { npsWeeks: v.nps?.periods?.length, subWeeks: v.subscores?.periods?.length, genAi: v.genAi?.generatedAt, pulledAt: v.pulledAt }
          : v;
    }
    return out;
  });
  console.log("\ncx.* storage:", JSON.stringify(st, null, 1));
}
await browser.disconnect();
