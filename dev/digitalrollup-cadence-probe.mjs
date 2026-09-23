// dev/digitalrollup-cadence-probe.mjs
//
// How often does the GIF Market Dashboard's data actually move? Polls
// /api/dashboard from a tab on the app's origin in the debug Edge and logs,
// per poll, the source's refreshed_at_iso and one store's picking.total_picks.
//
//   node dev/digitalrollup-cadence-probe.mjs [market=29] [store=1458] [minutes=20] [everySec=30]
//
// Output: one JSON line per poll to stdout, and a summary of the gaps between
// stamp changes / pick changes at the end.
import puppeteer from "puppeteer-core";

const [market = "29", store = "1458", minutes = "20", everySec = "30"] = process.argv.slice(2);
const ORIGIN = "https://ai-innovation-lab-app-bebdeibbicjffabd.walmart.com";

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", defaultViewport: null, protocolTimeout: 120_000 });
const page = await browser.newPage();
try {
  await page.goto(`${ORIGIN}/ping`, { waitUntil: "load", timeout: 60_000 });
  const end = Date.now() + Number(minutes) * 60_000;
  const rows = [];
  while (Date.now() < end) {
    const r = await page.evaluate(async (m, s) => {
      const res = await fetch(`/api/dashboard?market=${m}`, { credentials: "include", headers: { accept: "application/json" } });
      const ct = res.headers.get("content-type") || "";
      if (!/json/.test(ct)) return { status: res.status, ct, err: (await res.text()).slice(0, 200) };
      const j = await res.json();
      const card = (j.cards || []).find((c) => String(c.store_nbr) === String(s));
      return {
        status: res.status,
        refreshed: j.refreshed_at_iso, dataAge: j.data_age, gran: j.data_granularity,
        picks: card?.picking?.total_picks ?? null, rate: card?.picking?.pick_rate ?? null,
        open: card?.picking?.open_orders ?? null,
        marketPicks: j.summary?.total_items_picked ?? null,
        stores: (j.cards || []).map((c) => c.store_nbr).join(","),
      };
    }, market, store);
    const row = { t: new Date().toISOString(), ...r };
    rows.push(row);
    console.log(JSON.stringify(row));
    if (r.err) break;
    await new Promise((res) => setTimeout(res, Number(everySec) * 1000));
  }
  const changes = (key) => {
    const out = [];
    for (let i = 1; i < rows.length; i++) if (rows[i][key] !== rows[i - 1][key]) out.push(rows[i].t);
    return out;
  };
  console.log("SUMMARY", JSON.stringify({ polls: rows.length, stampChanges: changes("refreshed"), pickChanges: changes("picks") }, null, 1));
} finally {
  await page.close().catch(() => {});
  browser.disconnect();
}
