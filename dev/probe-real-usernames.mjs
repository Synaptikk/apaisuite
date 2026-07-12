// dev/probe-real-usernames.mjs
//
// Read usernames from the user's existing claimsdisposition IndexedDB
// pull (via the extension's shell tab), then test the Workvivo lookup
// endpoint with several non-self usernames to find out:
//   (a) does Workvivo redirect to /users/<id> for OTHER users?
//   (b) is the H2 regex extracting the right thing?
//   (c) what behaviour distinguishes valid-but-not-self from invalid?
//
// Output tells us whether the current lookup logic is right or needs
// switching to a different endpoint.

import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });

// Find the extension page
const targets = browser.targets();
const extPage = targets.find((t) =>
  t.type() === "page" && t.url().startsWith("chrome-extension://") && /\/app\.html/.test(t.url())
);

let usernames = [];
if (extPage) {
  console.log(`✓ Found shell tab: ${extPage.url()}`);
  const page = await extPage.page();
  usernames = await page.evaluate(async () => {
    // Open the claimsdisposition IndexedDB the same way lib/db.js does
    const dbName = "apaisuite-claimsdisposition";
    return await new Promise((resolve) => {
      const req = indexedDB.open(dbName);
      req.onerror = () => resolve({ error: req.error?.message || "open failed" });
      req.onsuccess = () => {
        const db = req.result;
        const storeNames = [...db.objectStoreNames];
        if (!storeNames.length) {
          db.close();
          resolve({ error: "no object stores", storeNames });
          return;
        }
        // Try "pulls" then any other store
        const target = storeNames.find((s) => /pull/i.test(s)) || storeNames[0];
        const tx = db.transaction(target, "readonly");
        const os = tx.objectStore(target);
        const all = os.getAll();
        all.onsuccess = () => {
          const records = all.result;
          // Pull record shape (per modules/claimsdisposition/lib/db.js):
          //   { pullId, pulledAt, storesByNumber: { "669": [rawRow,...] } }
          // rawRow is a CSV-header-keyed dict (uppercase keys from Looker).
          const flat = [];
          for (const r of records) {
            if (r.storesByNumber) {
              for (const rows of Object.values(r.storesByNumber)) {
                if (Array.isArray(rows)) flat.push(...rows);
              }
            }
          }
          // Username field — try several candidate keys
          const uniq = [...new Set(flat.map((r) =>
            r?.Userid || r?.User_id || r?.userId || r?.user_id || r?.USER_ID || r?.["User Id"] || r?.UserId
          ).filter(Boolean))];
          db.close();
          // Also dump the first row's keys so we can see what the actual schema is
          const sampleKeys = flat[0] ? Object.keys(flat[0]).slice(0, 20) : [];
          resolve({ storeNames, target, pullCount: records.length, totalRows: flat.length, sampleKeys, uniqueUsers: uniq.slice(0, 30) });
        };
        all.onerror = () => { db.close(); resolve({ error: all.error?.message }); };
      };
    });
  });
  console.log("IDB scan:", JSON.stringify(usernames, null, 2));
} else {
  console.log("✗ No APAISuite shell tab open. Open it and re-run.");
  browser.disconnect();
  process.exit(1);
}

const usersToTest = (usernames.uniqueUsers || []).filter((u) => u !== "ses008s").slice(0, 8);
if (usersToTest.length === 0) {
  console.log("✗ No non-self usernames found in IDB.");
  browser.disconnect();
  process.exit(1);
}

// Use a workvivo tab (open if needed) to run the fetches with real session cookies
let wvTarget = browser.targets().find((t) => t.type() === "page" && /workvivo\.walmart\.com/.test(t.url()));
let wvPage;
if (!wvTarget) {
  wvPage = await browser.newPage();
  await wvPage.goto("https://workvivo.walmart.com/", { waitUntil: "domcontentloaded", timeout: 20000 });
} else {
  wvPage = await wvTarget.page();
}

console.log(`\n→ Testing Workvivo lookup for ${usersToTest.length} non-self usernames…`);
for (const u of usersToTest) {
  const out = await wvPage.evaluate(async (username) => {
    try {
      const r = await fetch(`/users/lookup?username=${encodeURIComponent(username)}`, {
        credentials: "include", redirect: "follow", headers: { Accept: "text/html" },
      });
      const text = await r.text();
      const h2Match = text.match(/<h2[^>]*>\s*([^<]+?)\s*<\/h2>/i);
      const titleMatch = text.match(/<title[^>]*>([^<]+)<\/title>/i);
      const ogTitleMatch = text.match(/property="og:title"[^>]*content="([^"]+)"/i);
      // Also see if there's a meta name="user" or similar
      const allH2 = [...text.matchAll(/<h2[^>]*>\s*([^<]+?)\s*<\/h2>/gi)].map((m) => m[1].trim()).slice(0, 5);
      return {
        status: r.status,
        finalUrl: r.url,
        finalPath: new URL(r.url).pathname,
        h2First: h2Match?.[1]?.trim(),
        allH2,
        title: titleMatch?.[1]?.trim(),
        og: ogTitleMatch?.[1]?.trim(),
        bodyLen: text.length,
      };
    } catch (e) {
      return { error: e.message };
    }
  }, u);
  console.log(`\n  username=${u}`);
  console.log(`    status:    ${out.status}`);
  console.log(`    finalPath: ${out.finalPath}`);
  console.log(`    title:     ${out.title}`);
  console.log(`    og:title:  ${out.og}`);
  console.log(`    h2 first:  ${out.h2First}`);
  console.log(`    all h2s:   ${JSON.stringify(out.allH2)}`);
}

browser.disconnect();
process.exit(0);
