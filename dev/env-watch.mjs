// dev/env-watch.mjs <outDir> <seconds> [jsFileToRunFirst] — attach to the open Enviance tab, optionally run JS,
// log XHR responses for N seconds, then dump innerText + screenshot.
import puppeteer from "puppeteer-core";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
const [out, secs = "20", js] = process.argv.slice(2); mkdirSync(out, { recursive: true });
const b = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", defaultViewport: null, protocolTimeout: 180000 });
const p = (await b.pages()).find((x) => x.url().includes("go.enviance.com/CustomApp"));
if (!p) { console.log("no enviance tab"); process.exit(1); }
const cdp = await p.createCDPSession(); await cdp.send("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
const log = []; let n = 0;
p.on("response", async (r) => {
  const rt = r.request().resourceType(); if (!["xhr", "fetch", "document"].includes(rt)) return;
  const i = n++; let body = ""; try { body = await r.text(); } catch {}
  const name = (r.url().match(/name=([^&]+)/) || [, r.url().slice(0, 120)])[1];
  log.push({ i, status: r.status(), method: r.request().method(), name, len: body.length });
  writeFileSync(`${out}/r${String(i).padStart(3, "0")}.txt`, r.url() + "\n" + (r.request().postData() || "") + "\n----\n" + body);
});
if (js) { const v = await p.evaluate(readFileSync(js, "utf8")).catch((e) => "ERR " + e.message); console.log("js:", JSON.stringify(v)?.slice(0, 3000)); }
await new Promise((r) => setTimeout(r, +secs * 1000));
writeFileSync(`${out}/log.json`, JSON.stringify(log, null, 1));
writeFileSync(`${out}/page.txt`, await p.evaluate(() => document.body.innerText));
await p.screenshot({ path: `${out}/shot.png` });
for (const l of log) console.log(l.i, l.status, l.len, decodeURIComponent(l.name).slice(0, 140));
console.log(p.url());
await b.disconnect();
