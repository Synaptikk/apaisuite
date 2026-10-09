// dev/env-probe1.mjs <outDir> — open the Enviance compliance page, log every XHR + body.
import puppeteer from "puppeteer-core";
import { writeFileSync, mkdirSync } from "node:fs";
const out = process.argv[2]; mkdirSync(out, { recursive: true });
const URL = "https://go.enviance.com/CustomApp/ddde6520-3955-4d83-b0ab-78f6e5cbaf10/index.html?SystemID=774d2e17-a8fc-409f-9480-e3fa9310c1c5#/page/9108fa2b-5826-48eb-ac95-f5385de025a6";
const b = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", defaultViewport: null, protocolTimeout: 180000 });
const p = await b.newPage();
const log = []; let n = 0;
p.on("response", async (r) => {
  const rt = r.request().resourceType(); if (!["xhr", "fetch", "document"].includes(rt)) return;
  const i = n++; let body = ""; try { body = await r.text(); } catch {}
  log.push({ i, status: r.status(), method: r.request().method(), url: r.url(), post: r.request().postData()?.slice(0, 3000), len: body.length });
  writeFileSync(`${out}/r${String(i).padStart(3, "0")}.txt`, r.url() + "\n" + (r.request().postData() || "") + "\n----\n" + body);
});
await p.goto(URL, { waitUntil: "networkidle2", timeout: 90000 }).catch((e) => console.log("goto", e.message));
await new Promise((r) => setTimeout(r, 8000));
writeFileSync(`${out}/log.json`, JSON.stringify(log, null, 1));
writeFileSync(`${out}/page.txt`, await p.evaluate(() => document.body.innerText));
await p.screenshot({ path: `${out}/shot.png` });
console.log(p.url(), log.length);
await b.disconnect();
