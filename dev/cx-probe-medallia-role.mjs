import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });

// 1. Does the bare app URL (no roleId) land us somewhere that reveals the role?
const p1 = await browser.newPage();
await p1.goto("https://walmart.medallia.com/sso/walmart/", { waitUntil: "domcontentloaded", timeout: 180000 });
await new Promise(r => setTimeout(r, 14000));
console.log("bare landing URL:", p1.url());
const info = await p1.evaluate(async () => {
  const html = document.documentElement.outerHTML;
  const csrf = /csrfToken:\s*"([^"]+)"/.exec(html)?.[1];
  const roleHits = [...html.matchAll(/roleId["':\s=]+(\d{4,8})/g)].map(m => m[1]).slice(0, 6);
  const out = { url: location.href, hasCsrf: !!csrf, roleHits };
  if (!csrf) return out;
  const r = await fetch("/api-comp/reporting/graphql", { method: "POST", credentials: "include",
    headers: { "content-type": "application/json", accept: "application/json", "x-csrf-token": csrf },
    body: JSON.stringify({ operationName: "who", variables: {},
      query: `query who { me { id primaryRole { id name } roles(first: 20) { nodes { id name } } } }` }) });
  out.me = (await r.text()).slice(0, 1400);
  return out;
});
console.log(JSON.stringify(info, null, 1));
await p1.close();
await browser.disconnect();
