// Close the extra tabs this session's probes left behind: duplicate shell tabs
// and any Medallia anchor. The module reopens its own anchor when it needs one.
import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const pages = await browser.pages();
let closed = 0;
const shells = pages.filter(p => p.url().includes("app.html"));
for (const p of shells.slice(1)) { await p.close().catch(() => {}); closed++; }
for (const p of pages.filter(p => /walmart\.medallia\.com/.test(p.url()))) { await p.close().catch(() => {}); closed++; }
console.log(`closed ${closed} tab(s)`);
for (const p of await browser.pages()) console.log("  ", p.url().slice(0, 80));
await browser.disconnect();
