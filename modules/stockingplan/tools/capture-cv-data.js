// tools/capture-cv-data.js
// One-shot Playwright capture of EVERYTHING needed to rebuild the freight math.
//
// Run:  node tools/capture-cv-data.js <storeNbr> [YYYY-MM-DD]
// A browser opens; sign in via SSO if prompted. It auto-searches, then dumps:
//   - captured/aisle-location.json   (AisleLocation.ashx response — aisle shape)
//   - captured/psn-api.json          (decompressed fpt_psnAPIJson — per-dept detail)
//   - captured/main-json.json        (decompressed fpt_mainJson — live cph, flags)
//   - captured/summary.txt           (human-readable reconciliation vs known totals)
//
// Nothing here ships in the extension — pure dev tooling.

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "captured");

const CV_URL = "https://radapps3.wal-mart.com/Protected/CaseVisibility/html/main.html";
const STORE_NBR = process.argv[2] || "1458";
const BIZ_DATE  = process.argv[3] || new Date().toISOString().split("T")[0];

const log = (...a) => console.log("🐶", ...a);

(async () => {
  mkdirSync(OUT, { recursive: true });
  log(`Store ${STORE_NBR} · Date ${BIZ_DATE}`);
  log("Launching browser (sign in via SSO if prompted)…");

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  // Passively catch the aisle API response the moment CV fires it.
  let aisleResponse = null;
  page.on("response", async (resp) => {
    if (resp.url().includes("AisleLocation.ashx") && resp.url().includes("getUniqueAislesAndLocations")) {
      log("📡 Caught AisleLocation.ashx");
      try { aisleResponse = await resp.json(); } catch (e) { log("  (json parse failed:", e.message, ")"); }
    }
  });

  await page.goto(CV_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

  log("🔐 Waiting for authentication (do the SSO dance if needed)…");
  await page.waitForURL(/radapps3\.wal-mart\.com\/Protected\/CaseVisibility/, { timeout: 180_000 });
  await page.waitForSelector("#inpStoreNbr", { timeout: 30_000 });
  log("✅ Authenticated & page loaded.");

  // Fire the search.
  await page.fill("#inpStoreNbr", STORE_NBR);
  const di = await page.$("#inpDate");
  if (di) await page.fill("#inpDate", BIZ_DATE);
  await page.waitForFunction(() => typeof window.main_search === "function", { timeout: 15_000 });
  await page.evaluate(() => window.main_search());
  log("🔍 Search fired, waiting for spinner…");

  await page.waitForFunction(() => {
    const s = document.querySelector("#divImgProcessing");
    return !s || getComputedStyle(s).display === "none";
  }, { timeout: 40_000 }).catch(() => log("  (spinner wait timed out, continuing)"));
  await page.waitForTimeout(4000);

  // Pull + decompress the sessionStorage blobs using the page's own LZString.
  log("📦 Reading sessionStorage (psn_apiJson, main_json)…");
  const blobs = await page.evaluate(() => {
    const dec = (k) => {
      const raw = sessionStorage.getItem(k);
      if (!raw) return { key: k, present: false };
      try {
        // Mirror CV's own decode: ajax3_toJson(LZString144.decompress(raw))
        const json = ajax3_toJson(LZString144.decompress(raw));
        return { key: k, present: true, json };
      } catch (e) {
        return { key: k, present: true, error: String(e) };
      }
    };
    return {
      psn:  dec("fpt_psnAPIJson"),
      main: dec("fpt_mainJson"),
      businessDate: sessionStorage.getItem("fpt_businessDate"),
      storeNbr: (document.getElementById("inpStoreNbr") || {}).value,
    };
  });

  // If the aisle page hasn't been opened, hit the aisle API directly in-page.
  if (!aisleResponse) {
    log("🔁 Aisle API not seen passively — fetching directly…");
    aisleResponse = await page.evaluate(async (storeNbr) => {
      const r = await fetch(
        `../ashx/AisleLocation.ashx?func=getUniqueAislesAndLocationsFromSqlSvr&storeNbr=${storeNbr}`,
        { credentials: "include", headers: { Accept: "application/json" } }
      );
      return r.json();
    }, STORE_NBR).catch((e) => ({ error: String(e) }));
  }

  // Write everything out.
  writeFileSync(join(OUT, "aisle-location.json"), JSON.stringify(aisleResponse ?? null, null, 2));
  writeFileSync(join(OUT, "psn-api.json"),  JSON.stringify(blobs.psn?.json ?? blobs.psn ?? null, null, 2));
  writeFileSync(join(OUT, "main-json.json"), JSON.stringify(blobs.main?.json ?? blobs.main ?? null, null, 2));

  // Quick reconciliation summary.
  const lines = [];
  lines.push(`Store ${STORE_NBR} · ${BIZ_DATE}`);
  lines.push("");
  const psn = blobs.psn?.json;
  if (Array.isArray(psn)) {
    lines.push(`psn_apiJson loads: ${psn.length}`);
    // Roll up cases + bkpk by dept across all loads.
    const byDept = {};
    let totCases = 0, totBkpk = 0;
    for (const load of psn) {
      for (const d of (load.shipment_details || [])) {
        byDept[d.dept_nbr] = byDept[d.dept_nbr] || { cases: 0, bkpk: 0 };
        byDept[d.dept_nbr].cases += d.full_cases || 0;
        byDept[d.dept_nbr].bkpk  += d.bkpk_units || 0;
        totCases += d.full_cases || 0;
        totBkpk  += d.bkpk_units || 0;
      }
      lines.push(`  load ${load.load_id} · type ${load.shipment_type} · details ${(load.shipment_details||[]).length}`);
    }
    lines.push("");
    lines.push(`TOTAL full_cases: ${totCases}`);
    lines.push(`TOTAL bkpk_units: ${totBkpk}`);
    lines.push("");
    lines.push("By dept (dept: cases / bkpk):");
    Object.keys(byDept).sort((a,b)=>a-b).forEach((d) => {
      lines.push(`  D${d}: ${byDept[d].cases} / ${byDept[d].bkpk}`);
    });
  } else {
    lines.push("psn_apiJson: NOT an array — check psn-api.json");
  }
  lines.push("");
  lines.push(`main_json.cph present: ${!!(blobs.main?.json?.cph?.length)} (${blobs.main?.json?.cph?.length || 0} depts)`);
  lines.push(`aisle response keys: ${aisleResponse ? Object.keys(aisleResponse).join(", ") : "none"}`);
  if (aisleResponse?.aisles) lines.push(`  aisles: ${aisleResponse.aisles.length}, locations: ${aisleResponse.locations?.length}`);
  const summary = lines.join("\n");
  writeFileSync(join(OUT, "summary.txt"), summary);

  log("✅ Saved to " + OUT);
  console.log("\n" + summary + "\n");
  log("Browser stays open 2 min for inspection. Ctrl+C to quit early.");
  await page.waitForTimeout(120_000);
  await browser.close();
})();
