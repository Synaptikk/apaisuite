// Generate with a narrative present, so the new leading section is exercised.
import puppeteer from "puppeteer-core";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const CFG = path.join(os.homedir(), ".code_puppy", "puppy.cfg");
const APP = "chrome-extension://fchnolphfaklbpdgnofhblfhcailkpdb/app.html";
const b = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null, protocolTimeout: 300000 });
const p = await b.newPage();
await p.goto(`${APP}#/cx`, { waitUntil: "domcontentloaded", timeout: 60000 });
await new Promise(r => setTimeout(r, 7000));
await p.click("[data-action='open-settings']");
await new Promise(r => setTimeout(r, 600));
await (await p.$("[data-setting-cfg]")).uploadFile(CFG);
await new Promise(r => setTimeout(r, 2000));
const n = await p.evaluate(() => new Promise(r => chrome.runtime.sendMessage({ module: "cx", type: "narrate", force: true }, r)));
console.log("narrate ok:", n?.ok, n?.error ?? "");
await p.evaluate(() => document.querySelector("[data-action='export-pdf']").click());
await new Promise(r => setTimeout(r, 8000));
await p.evaluate(() => new Promise(r => chrome.runtime.sendMessage({ module: "cx", type: "signOutGateway" }, r)));
await p.close(); await b.disconnect();
