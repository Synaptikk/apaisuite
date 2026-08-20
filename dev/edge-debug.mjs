// dev/edge-debug.mjs
//
// Attach to a running Edge instance (launched with --remote-debugging-port=9222),
// find APAISuite's service worker (waking it if necessary), capture all of its
// console output, and run debug scenarios on it.
//
// Setup (one-time):
//   cd dev && npm install
//
// Launch Edge with the debug port first (use .\launch-edge-debug.ps1).
// Then: npm run debug:aurorbuddy

import puppeteer from "puppeteer-core";

const BROWSER_URL = process.env.EDGE_CDP_URL || "http://localhost:9222";
const SCENARIO    = process.argv[2] || "aurorbuddy-preflight";
const EXT_NAME    = "APAISuite";

// ── Connect ────────────────────────────────────────────────────────────────
let browser;
try {
  browser = await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null });
} catch (e) {
  console.error(`✗ Could not connect to ${BROWSER_URL}.`);
  console.error(`  Did you launch Edge with --remote-debugging-port=9222 ?`);
  console.error(`  Error: ${e.message}`);
  process.exit(1);
}
console.log(`✓ Connected to ${BROWSER_URL}`);

// ── Discover APAISuite extension ID via chrome://extensions ───────────────
// MV3 service workers don't appear as CDP targets when idle; we can't find the
// extension by scanning targets alone. The chrome://extensions WebUI page has
// access to chrome.developerPrivate which lists every installed extension by
// name, id, and version — including ones whose SW is currently asleep.
console.log(`→ scanning chrome://extensions for "${EXT_NAME}"…`);
const extPage = await browser.newPage();
await extPage.goto("chrome://extensions/", { waitUntil: "domcontentloaded", timeout: 10000 });
// developerPrivate.getExtensionsInfo is callback-style; wrap in a promise.
const allExtensions = await extPage.evaluate(async () => {
  return await new Promise((resolve) => {
    chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true }, (info) => resolve(info));
  });
});
await extPage.close().catch(() => {});

const suiteInfo = allExtensions.find((x) => x.name === EXT_NAME);
if (!suiteInfo) {
  console.error(`✗ Extension "${EXT_NAME}" not found in this Edge profile.`);
  console.error(`  Installed extensions:`);
  for (const x of allExtensions) {
    console.error(`    ${x.id}  ${x.name}  v${x.version}  (${x.state})`);
  }
  browser.disconnect();
  process.exit(1);
}
const extensionId = suiteInfo.id;
console.log(`✓ Found ${EXT_NAME}: id=${extensionId} v${suiteInfo.version} state=${suiteInfo.state}`);

// ── Persist auror username from any active JWT BEFORE reloading ───────────
// chrome.storage.session is wiped by extension reload, so we extract the
// username from any cached JWT (sub claim) and write it to chrome.storage.sync
// (which survives reloads) so the slow-path identifier-page auto-fill has
// data to work with. No-op if already set or no JWT cached.
{
  console.log(`→ checking for cached Auror JWT to extract username…`);
  // Wake the (currently old) SW by opening app.html, then evaluate on it.
  const wakerPage = await browser.newPage();
  await wakerPage.goto(`chrome-extension://${extensionId}/app.html`, { waitUntil: "domcontentloaded", timeout: 10000 });
  // Find the SW target (it's now active since the page loaded).
  await new Promise((r) => setTimeout(r, 500));
  const oldSwTarget = browser.targets().find((t) =>
    t.type() === "service_worker" && new URL(t.url()).hostname === extensionId
  );
  if (oldSwTarget) {
    try {
      const oldCdp = await oldSwTarget.createCDPSession();
      await oldCdp.send("Runtime.enable");
      const res = await oldCdp.send("Runtime.evaluate", {
        expression: `(async () => {
          const existing = await chrome.storage.sync.get("aurorbuddy.aurorUsername");
          if (existing && existing["aurorbuddy.aurorUsername"]) {
            return { skipped: true, existing: existing["aurorbuddy.aurorUsername"] };
          }
          const all = await chrome.storage.session.get(null);
          for (const [k, v] of Object.entries(all)) {
            if (!k.endsWith("auror.jwt") || !v?.value) continue;
            const jwt = String(v.value).replace(/^Bearer\\s+/i, "");
            const payloadPart = jwt.split(".")[1];
            if (!payloadPart) continue;
            try {
              const json = atob(payloadPart.replace(/-/g, "+").replace(/_/g, "/"));
              const claims = JSON.parse(json);
              const sub = String(claims?.sub ?? "");
              const m = sub.match(/\\|([^|]+)$/);
              if (m) {
                const id = m[1].trim();
                const username = id.includes("@") ? id : (id + "@walmart.com");
                await chrome.storage.sync.set({ "aurorbuddy.aurorUsername": username });
                return { saved: username, fromSub: sub };
              }
            } catch (e) {}
          }
          return { skipped: true, reason: "no cached JWT" };
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      const out = res?.result?.value;
      console.log(`  username extract result:`, out);
      await oldCdp.detach().catch(() => {});
    } catch (e) {
      console.warn(`  username extract failed: ${e?.message}`);
    }
  } else {
    console.log(`  no SW target to read from`);
  }
  await wakerPage.close().catch(() => {});
}

// ── Force-reload the extension so source edits take effect ─────────────────
// MV3 service workers don't pick up file changes until the extension is
// reloaded. Without this, edits to shared/auth.js or modules/*/service.js
// won't apply and the debug run keeps testing stale code.
console.log(`→ reloading ${EXT_NAME} so source edits take effect…`);
{
  const reloadPage = await browser.newPage();
  await reloadPage.goto("chrome://extensions/", { waitUntil: "domcontentloaded", timeout: 10000 });
  await reloadPage.evaluate(async (id) => {
    await new Promise((resolve) => chrome.developerPrivate.reload(id, {}, resolve));
  }, extensionId);
  await reloadPage.close().catch(() => {});
  // Give the SW a moment to fully re-register handlers + webRequest listeners.
  await new Promise((r) => setTimeout(r, 1500));
  console.log(`  reloaded`);
}

// ── Wake the SW if asleep, by opening app.html ────────────────────────────
// MV3 SWs activate when any of their listeners fire OR when an extension page
// loads. Opening app.html does both (the page loads + sends messages).
let swTarget = browser.targets().find((t) =>
  t.type() === "service_worker" && new URL(t.url()).hostname === extensionId
);
let suitePage = null;
if (!swTarget) {
  console.log(`→ SW is idle — opening app.html to wake it…`);
  suitePage = await browser.newPage();
  await suitePage.goto(`chrome-extension://${extensionId}/app.html`, { waitUntil: "domcontentloaded", timeout: 15000 });
  // Poll for the SW target to appear (typically <1s after first message).
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    swTarget = browser.targets().find((t) =>
      t.type() === "service_worker" && new URL(t.url()).hostname === extensionId
    );
    if (swTarget) break;
    await new Promise((r) => setTimeout(r, 200));
  }
}
if (!swTarget) {
  console.error(`✗ SW for ${extensionId} did not appear within 5s of opening app.html.`);
  console.error(`  This might mean the SW is crashing on boot — check the browser DevTools.`);
  browser.disconnect();
  process.exit(1);
}
console.log(`✓ SW attached: ${swTarget.url()}`);

// ── Attach CDP session + console capture ───────────────────────────────────
const cdp = await swTarget.createCDPSession();
await cdp.send("Runtime.enable");

const logs = [];
function fmtArg(a) {
  if (a == null) return String(a);
  if (a.value !== undefined) return typeof a.value === "string" ? a.value : JSON.stringify(a.value);
  if (a.description) return a.description;
  if (a.unserializableValue) return a.unserializableValue;
  if (a.preview) {
    try { return JSON.stringify(a.preview); } catch { return "[unserializable preview]"; }
  }
  return JSON.stringify(a);
}
cdp.on("Runtime.consoleAPICalled", (msg) => {
  const text = (msg.args || []).map(fmtArg).join(" ");
  const line = `[${msg.type}] ${text}`;
  logs.push(line);
  console.log(`  SW> ${line}`);
});
cdp.on("Runtime.exceptionThrown", (e) => {
  const line = `[exception] ${e.exceptionDetails?.text || ""} ${e.exceptionDetails?.exception?.description || ""}`;
  logs.push(line);
  console.error(`  SW> ${line}`);
});

// ── Scenarios ──────────────────────────────────────────────────────────────
const scenarios = {
  "aurorbuddy-preflight": async () => {
    console.log("→ Step 1: clear cached JWT + cookies + Auror localStorage");
    // Find the Auror tab (if open) and wipe its localStorage so the SPA
    // genuinely signs out — Auror stores its session in localStorage, NOT
    // cookies, so clearing cookies alone doesn't trigger the slow path.
    const auroTabTarget = browser.targets().find((t) =>
      t.type() === "page" && /app\.us\.auror\.co/.test(t.url())
    );
    if (auroTabTarget) {
      try {
        const aPage = await auroTabTarget.page();
        if (aPage) {
          await aPage.evaluate(() => {
            try { localStorage.clear(); } catch {}
            try { sessionStorage.clear(); } catch {}
          });
          console.log("  cleared Auror tab localStorage + sessionStorage");
        }
      } catch (e) { console.warn("  Auror localStorage clear failed:", e?.message); }
    } else {
      console.log("  no existing Auror tab to clear");
    }

    const cleanupRes = await cdp.send("Runtime.evaluate", {
      expression: `(async () => {
        // BEFORE clearing the JWT cache, extract the username from any
        // cached JWT sub claim and persist it as aurorbuddy.aurorUsername
        // — this lets the slow-path identifier auto-fill watcher have
        // something to fill on the next run.
        try {
          const all = await chrome.storage.session.get(null);
          for (const [k, v] of Object.entries(all)) {
            if (!k.endsWith("auror.jwt") || !v?.value) continue;
            const jwt = String(v.value).replace(/^Bearer\\s+/i, "");
            const payloadPart = jwt.split(".")[1];
            if (!payloadPart) continue;
            const json = atob(payloadPart.replace(/-/g, "+").replace(/_/g, "/"));
            const claims = JSON.parse(json);
            const sub = String(claims?.sub ?? "");
            const m = sub.match(/\\|([^|]+)$/);
            if (m) {
              const id = m[1].trim();
              const username = id.includes("@") ? id : (id + "@walmart.com");
              await chrome.storage.sync.set({ "aurorbuddy.aurorUsername": username });
              console.log("[debug-script] extracted aurorUsername from JWT and stored:", username);
              break;
            }
          }
        } catch (e) { console.warn("[debug-script] JWT extract failed:", e?.message); }

        await chrome.storage.session.clear();
        console.log("[debug-script] session storage cleared");
        // Include auth0/login subdomains so Auror's IdP session also dies.
        const DOMAINS = [
          "app.us.auror.co", "auror.co",
          "auror-prod-us.auth0.com", "auth0.com",
          "login.us.auror.co",
          "apps.apprissretail.com",
        ];
        for (const domain of DOMAINS) {
          const cs = await chrome.cookies.getAll({ domain });
          for (const c of cs) {
            const proto = c.secure ? "https" : "http";
            const host = c.domain.replace(/^\\./, "");
            try { await chrome.cookies.remove({ url: proto + "://" + host + c.path, name: c.name }); }
            catch (e) { console.warn("[debug-script] cookie remove failed", c.name, e?.message); }
          }
          console.log("[debug-script] cleared " + cs.length + " cookies for " + domain);
        }
        return { ok: true };
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (cleanupRes.exceptionDetails) {
      console.error("✗ cleanup threw:", cleanupRes.exceptionDetails);
      return;
    }

    console.log("→ Step 2: open a fresh extension page to act as message sender");
    // Use the page we already opened to wake the SW if we have one;
    // otherwise open a fresh one.
    if (!suitePage) {
      suitePage = await browser.newPage();
      await suitePage.goto(`chrome-extension://${extensionId}/app.html`, { waitUntil: "domcontentloaded", timeout: 15000 });
    }
    await new Promise((r) => setTimeout(r, 500));

    console.log("→ Step 3: send preflight from the extension page → SW");
    const preflightPromise = suitePage.evaluate(async () => {
      return await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { module: "aurorbuddy", type: "preflight" },
          (response) => resolve(response)
        );
      });
    });

    // While preflight runs, take a screenshot of the Auror tab every few
    // seconds so we can SEE what state the SSO-click landed on.
    const auroDeadline = Date.now() + 30_000;
    let shotIdx = 0;
    const auroScreenshots = [];
    while (Date.now() < auroDeadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const auroTab = browser.targets().find((t) =>
        t.type() === "page" && /app\.us\.auror\.co/.test(t.url())
      );
      if (auroTab) {
        try {
          const page = await auroTab.page();
          if (page) {
            shotIdx++;
            const path = `auror-tab-${String(shotIdx).padStart(2, "0")}.png`;
            await page.screenshot({ path, fullPage: false }).catch(() => {});
            auroScreenshots.push({ idx: shotIdx, url: page.url(), path });
            console.log(`  📸 Auror tab @ shot ${shotIdx}: url=${page.url()}`);
          }
        } catch (e) {
          console.log(`  📸 screenshot failed: ${e?.message}`);
        }
      } else {
        console.log(`  📸 no Auror tab yet (shot ${shotIdx + 1})`);
      }
      // If preflight already resolved, take one more then bail
      const settled = await Promise.race([
        preflightPromise.then(() => true),
        new Promise((r) => setTimeout(() => r(false), 50)),
      ]);
      if (settled) break;
    }

    const result = await preflightPromise;

    // Drain trailing SW logs (handlers log as they run).
    await new Promise((r) => setTimeout(r, 1500));

    console.log("\n========== AUROR TAB SCREENSHOTS ==========");
    for (const s of auroScreenshots) console.log(`  ${s.path}  url=${s.url}`);
    console.log("===========================================\n");

    console.log("========== PREFLIGHT RESULT ==========");
    console.log(JSON.stringify(result, null, 2));
    console.log("======================================\n");

    await suitePage.close().catch(() => {});
  },
};

const scenario = scenarios[SCENARIO];
if (!scenario) {
  console.error(`✗ Unknown scenario: ${SCENARIO}`);
  console.error(`  Available: ${Object.keys(scenarios).join(", ")}`);
  cdp.detach().catch(() => {});
  browser.disconnect();
  process.exit(1);
}

try {
  await scenario();
} catch (e) {
  console.error(`✗ scenario threw: ${e.message}`);
  console.error(e.stack);
}

// ── Done ───────────────────────────────────────────────────────────────────
await cdp.detach().catch(() => {});
browser.disconnect();
console.log(`\n✓ Done. Captured ${logs.length} SW log line(s).`);
process.exit(0);
