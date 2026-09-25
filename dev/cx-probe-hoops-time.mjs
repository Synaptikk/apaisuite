import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();
await page.goto("https://hoops.wal-mart.com/ops-portal/metrics/overview?bu=1458&buType=6&timeType=202", { waitUntil: "domcontentloaded", timeout: 120000 });
await new Promise(r => setTimeout(r, 12000));

const res = await page.evaluate(async () => {
  const out = {};
  const call = async (proc, json) => {
    const u = `/ops-portal/v1/trpc/${proc}?input=${encodeURIComponent(JSON.stringify({ json }))}`;
    try { const r = await fetch(u, { credentials: "include", headers: { accept: "application/json" } });
      const t = await r.text(); return { status: r.status, body: t.slice(0, 2600) }; }
    catch (e) { return { err: String(e) }; }
  };
  for (const tt of [100, 202, 302, 402, 502, 201, 203]) {
    out[`nps_tt${tt}`] = await call("metric.cx.megaCard.nps", { buId: 1458, buType: 6, timeType: tt });
  }
  out.inStore_tt100 = await call("metric.cx.megaCard.inStore", { buId: 1458, buType: 6, timeType: 100 });
  // Guess at sibling cx procs
  for (const p of ["metric.cx.megaCard.digital","metric.cx.megaCard.pickupDelivery","metric.cx.megaCard.overall",
                   "metric.cx.topics","metric.cx.comments","metric.cx.megaCard.cx","metric.cx.summary"]) {
    out["probe_"+p] = await call(p, { buId: 1458, buType: 6, timeType: 202 });
  }
  return out;
});
for (const [k, v] of Object.entries(res)) {
  const short = v.body ? v.body.slice(0, 900) : JSON.stringify(v);
  console.log(`\n### ${k} [${v.status}]\n${short}`);
}
await page.close(); await browser.disconnect();
