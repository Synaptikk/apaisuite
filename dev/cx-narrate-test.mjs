// Exercise the AI-gateway narrative end to end through the real module:
// paste the Code Puppy token into the module's settings the way the user would,
// then ask the SW for the written read.
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tok = /^puppy_token\s*=\s*(.+)$/m
  .exec(fs.readFileSync(path.join(os.homedir(), ".code_puppy", "puppy.cfg"), "utf8"))?.[1]?.trim();
if (!tok) { console.log("no gateway token on this machine"); process.exit(1); }

const APP = "chrome-extension://fchnolphfaklbpdgnofhblfhcailkpdb/app.html";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null, protocolTimeout: 400000 });
const page = (await browser.pages()).find(p => p.url().includes("app.html")) || await browser.newPage();
if (!page.url().includes("app.html")) await page.goto(`${APP}#/cx`, { waitUntil: "domcontentloaded" });

const call = (type, payload = {}) => page.evaluate((t, p) => new Promise((res) => {
  chrome.runtime.sendMessage({ module: "cx", type: t, ...p }, (r) => res(r));
}), type, payload);

console.log("1. save token via setSettings:");
console.log(JSON.stringify(await call("setSettings", { patch: { gatewayToken: tok, gatewayModel: "claude-sonnet-5" } })).slice(0, 400));

console.log("\n2. tokenInfo:");
console.log(JSON.stringify(await call("tokenInfo")));

console.log("\n3. narrate (force):");
const t0 = Date.now();
const res = await call("narrate", { force: true });
console.log(`   ${Math.round((Date.now()-t0)/1000)}s  ok=${res?.ok} cached=${res?.cached} reason=${res?.reason ?? ""}`);
if (!res?.ok) { console.log("   error:", res?.error); }
else {
  console.log("   model:", res.narrative.model, "| usage:", JSON.stringify(res.narrative.usage));
  console.log("\n===== THE READ =====\n" + res.narrative.text);
  // Confirm the prompt carried only precomputed figures.
  const f = res.narrative.facts;
  console.log("\nfacts sent — coverage:", JSON.stringify(f.coverage));
  console.log("facts sent — npsLatest:", JSON.stringify(f.gradedScores.npsLatest));
  console.log("facts sent — goingWrong themes:", f.goingWrong.map(x => `${x.theme}(${x.negativeMentions})`).join(", "));
  console.log("facts sent — movers:", f.whatChanged.movers.slice(0,4).map(m => `${m.theme} ${m.priorRate}→${m.negPer100Recent}${m.thin?" [thin]":""}`).join(" | "));
}

// Put the token back to empty so a shared machine is not left holding it.
if (process.env.KEEP_TOKEN !== "1") {
  await call("setSettings", { patch: { gatewayToken: "" } });
  console.log("\n(token cleared from module settings; set KEEP_TOKEN=1 to leave it)");
}
await browser.disconnect();
