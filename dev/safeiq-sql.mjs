// dev/safeiq-sql.mjs — run SQL against SafeIQ Studio's search endpoint via the signed-in debug-Edge tab.
//   node dev/safeiq-sql.mjs "SELECT ..."                  # prints JSON rows
//   node dev/safeiq-sql.mjs --file=q.sql --out=rows.json
// Needs: debug Edge on :9222 with a signed-in safeiq.stage.walmart.net tab open.
// The X-SafePass-Token header is sniffed from the page's own requests (reload) and cached.
import puppeteer from "puppeteer-core";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith("--")).map(a => { const [k, ...v] = a.slice(2).split("="); return [k, v.join("=") || true]; }));
const positional = process.argv.slice(2).filter(a => !a.startsWith("--"));
const sql = args.file ? readFileSync(args.file, "utf8") : positional[0];
if (!sql) { console.error("need sql"); process.exit(1); }
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 300000 });
const page = (await browser.pages()).find(p => p.url().includes("safeiq.stage.walmart.net"));
if (!page) { console.error("no safeiq tab open in debug Edge"); process.exit(1); }
const TOK_FILE = homedir() + "/.apaisuite-safeiq-token";
let token = existsSync(TOK_FILE) ? readFileSync(TOK_FILE, "utf8").trim() : "";
async function sniffToken() {
  let t = null;
  const h = req => { const hh = req.headers(); const k = Object.keys(hh).find(x => x.toLowerCase() === "x-safepass-token"); if (k) t = hh[k]; };
  page.on("request", h);
  await page.reload({ waitUntil: "networkidle2", timeout: 90000 }).catch(() => {});
  for (let i = 0; i < 20 && !t; i++) await new Promise(r => setTimeout(r, 500));
  page.off("request", h);
  if (!t) { console.error("could not sniff X-SafePass-Token (is the tab signed in?)"); process.exit(3); }
  writeFileSync(TOK_FILE, t); token = t;
}
async function runPage(pg) {
  return page.evaluate(async (sql, pg, token, SIZE) => {
    const r = await fetch(`/api/studio/search/sql?page=${pg}&size=${SIZE}&count=false`, {
      method: "POST", credentials: "include",
      headers: { "content-type": "application/json", accept: "application/json", "x-safepass-token": token },
      body: JSON.stringify({ sql }),
    });
    return { status: r.status, text: await r.text() };
  }, sql, pg, token, SIZE);
}
if (!token) await sniffToken();
const SIZE = Number(args.size || 1000);
const all = [];
for (let pg = 0; pg < 100; pg++) {
  let res = await runPage(pg);
  if (res.status === 401) { await sniffToken(); res = await runPage(pg); }
  if (res.status !== 200) { console.error("HTTP", res.status, res.text.slice(0, 2000)); process.exit(2); }
  const j = JSON.parse(res.text);
  all.push(...(j.content || []));
  if (j.last || !j.content || j.content.length < SIZE) break;
}
browser.disconnect();
if (args.out) { writeFileSync(args.out, JSON.stringify(all, null, 1)); console.log("rows:", all.length, "->", args.out); }
else console.log(JSON.stringify(all, null, 1));
