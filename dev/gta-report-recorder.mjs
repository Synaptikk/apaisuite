// Record every GTA/Cognos request (URL, POST body, response snippet) from the
// debug Edge's timesheet tab to a JSONL file, so a manually-run Punch Detail
// Report can be replayed programmatically afterwards.
// Usage: node dev/gta-report-recorder.mjs [outFile]   (Ctrl-C to stop)
import fs from "node:fs";
import puppeteer from "puppeteer-core";

const out = process.argv[2] || new URL("./.gta-report-capture.jsonl", import.meta.url).pathname;
const b = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", protocolTimeout: 0 });
const pages = await b.pages();
const pg = pages.find((x) => x.url().includes("timesheet.cloud"));
if (!pg) { console.error("no timesheet tab open"); process.exit(1); }

const log = (o) => fs.appendFileSync(out, JSON.stringify(o) + "\n");
const seen = new Set();
const attach = (page) => {
  if (seen.has(page)) return;
  seen.add(page);
  page.on("requestfinished", async (r) => {
    const u = r.url();
    if (!/gtaapp|cognos/i.test(u) || /\.(png|gif|jpg|css|woff|ico)/.test(u)) return;
    let body = "";
    try { body = (await (await r.response()).text()).slice(0, 4000); } catch {}
    log({ t: new Date().toISOString(), m: r.method(), u, post: (r.postData() || "").slice(0, 3000),
          status: (await r.response())?.status(), resp: body });
    console.log(r.method(), u.slice(30, 130));
  });
};
attach(pg);
b.on("targetcreated", async (t) => { const p2 = await t.page().catch(() => null); if (p2) attach(p2); });
console.log(`recording to ${out} — run the report now; Ctrl-C when the output is on screen`);
await new Promise(() => {});
