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
// targetFilter matters: browser.pages() attaches to every target, and one frozen
// tab in the debug Edge makes that hang with "Network.enable timed out". Note
// puppeteer hands the filter an object whose url/type are FUNCTIONS.
const browser = await puppeteer.connect({
  browserURL: "http://localhost:9222",
  protocolTimeout: 300000,
  targetFilter: (t) => {
    const ty = typeof t.type === "function" ? t.type() : String(t.type || "");
    const u  = typeof t.url  === "function" ? t.url()  : String(t.url  || "");
    return ty === "browser" || String(u).includes("safeiq.stage.walmart.net");
  },
});
const page = (await browser.pages()).find(p => p.url().includes("safeiq.stage.walmart.net"));
if (!page) { console.error("no safeiq tab open in debug Edge"); process.exit(1); }
const TOK_FILE = homedir() + "/.apaisuite-safeiq-token";
let token = existsSync(TOK_FILE) ? readFileSync(TOK_FILE, "utf8").trim() : "";
// The Studio token is a static READ token minted into the dashboard's own HTML,
// which the page will hand us using its OIDC access token. Far more reliable than
// sniffing request headers — the dashboard only sends the header while it is
// actually running queries. Falls back to the header sniff.
async function sniffToken() {
  const fromHtml = await page.evaluate(async () => {
    const k = Object.keys(sessionStorage).find(x => x.startsWith("oidc.user:"));
    if (!k) return { err: "not signed in (no oidc.user in sessionStorage)" };
    const { access_token } = JSON.parse(sessionStorage.getItem(k));
    const id = (location.pathname.match(/dashboards\/([0-9a-f-]{36})/) || [])[1];
    if (!id) return { err: "open a /SafeIQStudio/dashboards/<id> page first" };
    const r = await fetch(`/api/studio/dashboards/${id}/html`, {
      credentials: "include", headers: { authorization: "Bearer " + access_token },
    });
    if (!r.ok) return { err: `dashboard html HTTP ${r.status}` };
    const m = (await r.text()).match(/SAFEIQ_STUDIO_TOKEN\s*=\s*"([^"]+)"/);
    return m ? { token: m[1] } : { err: "no SAFEIQ_STUDIO_TOKEN in dashboard html" };
  }).catch(e => ({ err: e.message }));
  if (fromHtml?.token) { writeFileSync(TOK_FILE, fromHtml.token); token = fromHtml.token; return; }
  console.error("token from dashboard html failed:", fromHtml?.err, "— falling back to header sniff");
  let t = null;
  const h = req => { const hh = req.headers(); const k = Object.keys(hh).find(x => x.toLowerCase() === "x-safepass-token"); if (k) t = hh[k]; };
  page.on("request", h);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  for (let i = 0; i < 40 && !t; i++) await new Promise(r => setTimeout(r, 500));
  page.off("request", h);
  if (!t) { console.error("could not get a Studio token (is the tab signed in?)"); process.exit(3); }
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
