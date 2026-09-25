// Discover the Hoops ops-portal tRPC calls behind the NPS mega-card.
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const URL = "https://hoops.wal-mart.com/ops-portal/metrics/overview?bu=1458&buType=6&timeType=202";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();

const calls = [];
page.on("response", async (res) => {
  const u = res.url();
  if (!/\/v1\/trpc\/|\/api\//.test(u)) return;
  let body = null;
  try { body = await res.text(); } catch {}
  calls.push({ url: u, status: res.status(), len: body?.length ?? 0, body: body?.slice(0, 200000) });
});

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 120000 });
await new Promise(r => setTimeout(r, 20000));

console.log("FINAL URL:", page.url());
console.log("\n=== tRPC / api calls ===");
for (const c of calls) {
  const short = c.url.replace(/^https:\/\/hoops\.wal-mart\.com/, "").split("?")[0];
  const hasNps = /nps|Nps|NPS/.test(c.body || "");
  console.log(`${String(c.status).padEnd(4)} ${String(c.len).padEnd(8)} ${hasNps ? "[NPS] " : "      "}${short}`);
}

fs.writeFileSync(process.env.OUT || "cx-hoops-probe.json", JSON.stringify(calls, null, 1));
console.log("\nwrote", process.env.OUT || "cx-hoops-probe.json");

// Page text for the NPS card
const text = await page.evaluate(() => document.body.innerText.slice(0, 6000));
console.log("\n=== PAGE TEXT ===\n" + text);
await page.close(); await browser.disconnect();
