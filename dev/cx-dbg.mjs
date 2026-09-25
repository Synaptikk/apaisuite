import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const pages = await browser.pages();
const page = pages.find(p => /medallia/.test(p.url())) || pages[pages.length-1];
console.log("using", page.url().slice(0,80));
const res = await page.evaluate(async () => {
  const out = {};
  for (const [name, url] of [["query","/api-comp/reporting/query?view_as_role=251254"], ["graphql","/api-comp/reporting/graphql"]]) {
    const r = await fetch(url, {
      method: "POST", credentials: "include", headers: { "content-type": "application/json" },
      body: JSON.stringify({ operationName: "ping", variables: {}, query: "query ping { __typename }" }),
    });
    out[name] = { status: r.status, ct: r.headers.get("content-type"), body: (await r.text()).slice(0, 1200) };
  }
  return out;
});
console.log(JSON.stringify(res, null, 1));
await browser.disconnect();
