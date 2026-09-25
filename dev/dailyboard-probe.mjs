// Probe: download the store's Daily Board workbook from the owner's OneDrive
// through the debug Edge session and save it for layout inspection.
import puppeteer from "puppeteer-core";
// Usage: node dailyboard-probe.mjs "<share link>" <out.xlsx>
import fs from "node:fs";
import { parseShareLink } from "../modules/digitalmetrics/lib/data/board_sync.js";
const [link, out] = process.argv.slice(2);
const src = parseShareLink(link);
if (!src || !out) throw new Error("usage: node dailyboard-probe.mjs \"<share link>\" <out.xlsx>");
const SITE = src.site, ID = src.uniqueId;
const b = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", protocolTimeout: 120000 });
const p = await b.newPage();
try {
  await p.goto(`${SITE}/_layouts/15/viewlsts.aspx`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(e => console.log("goto:", e.message));
  console.log("landed:", p.url().slice(0, 120));
  const r = await p.evaluate(async (site, id) => {
    const res = { };
    const meta = await fetch(`${site}/_api/web/GetFileById('${id}')?$select=Name,TimeLastModified,Length,ServerRelativeUrl`, { headers: { accept: "application/json;odata=nometadata" } });
    res.metaStatus = meta.status; res.meta = meta.ok ? await meta.json() : (await meta.text()).slice(0, 200);
    const f = await fetch(`${site}/_layouts/15/download.aspx?UniqueId=${id}`);
    res.status = f.status; res.type = f.headers.get("content-type");
    const buf = new Uint8Array(await f.arrayBuffer());
    let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    res.b64 = btoa(s); return res;
  }, SITE, ID);
  console.log(JSON.stringify({ metaStatus: r.metaStatus, meta: r.meta, status: r.status, type: r.type, bytes: r.b64.length * 3 / 4 }));
  if (r.status === 200) fs.writeFileSync(out, Buffer.from(r.b64, "base64"));
} finally { await p.close(); b.disconnect(); }
