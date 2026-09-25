// Does CaseVisibility's load_id == GDP's Trailer_Nbr, and trailer_id == DC_Nbr?
import puppeteer from "puppeteer-core";
const STORE = "1458";
const DATES = (process.argv[2] || "2026-09-21,2026-09-22").split(",");
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();
await page.goto("https://radapps3.wal-mart.com/Protected/CaseVisibility/html/main.html", { waitUntil: "domcontentloaded", timeout: 120000 });
await new Promise(r => setTimeout(r, 6000));

for (const date of DATES) {
  const res = await page.evaluate(async (storeNbr, businessDate) => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const si = document.querySelector("#inpStoreNbr");
    const di = document.querySelector("#inpDate");
    if (!si) return { error: "inpStoreNbr not found" };
    si.value = storeNbr;
    if (di) di.value = businessDate;
    const dl = Date.now() + 15000;
    while (typeof window.main_search !== "function" && Date.now() < dl) await sleep(200);
    if (typeof window.main_search !== "function") return { error: "main_search missing" };
    window.main_search();
    await sleep(500);
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) {
      await sleep(400);
      const el = document.querySelector("#divImgProcessing");
      if (!el || getComputedStyle(el).display === "none") break;
    }
    await sleep(1500);
    const sdl = (typeof main_json !== "undefined" && main_json?.sdl) || [];
    return {
      count: sdl.length,
      keys: sdl[0] ? Object.keys(sdl[0]) : [],
      loads: sdl.map(d => ({ type: d.shipment_type, load_id: d.load_id, trailer_id: d.trailer_id,
                             sched: d.sched_delivery_ts, est: d.est_delivery_ts, actual: d.actual_delivery_ts })),
    };
  }, STORE, date);
  console.log(`\n===== CV business date ${date} =====`);
  if (res.error) { console.log("  ERROR", res.error); continue; }
  console.log("  sdl rows:", res.count, "\n  keys:", res.keys.join(", "));
  for (const l of res.loads) console.log(`   ${String(l.type).padEnd(6)} load_id=${String(l.load_id).padEnd(9)} trailer_id=${String(l.trailer_id).padEnd(7)} sched=${l.sched||"-"} actual=${l.actual||"-"}`);
}
await page.close(); await browser.disconnect();
