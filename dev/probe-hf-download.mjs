// Download TrOCR weight files through the debug Edge (user-approved), straight into dev/.models.
import puppeteer from "puppeteer-core";
import { resolve } from "node:path";
import { statSync, existsSync, renameSync, readdirSync } from "node:fs";
const dir = resolve("./.models/Xenova/trocr-base-handwritten/onnx");
const files = ["encoder_model_quantized.onnx", "decoder_model_merged_quantized.onnx"];
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 120000 });
const page = await browser.newPage();
const cdp = await page.createCDPSession();
await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir, eventsEnabled: true });
const progress = new Map();
cdp.on("Browser.downloadWillBegin", e => { progress.set(e.guid, { name: e.suggestedFilename, state: "begin" }); console.log("download begins:", e.suggestedFilename); });
cdp.on("Browser.downloadProgress", e => { const p = progress.get(e.guid) || {}; p.state = e.state; p.received = e.receivedBytes; p.total = e.totalBytes; progress.set(e.guid, p); });
for (const f of files) {
  const url = `https://huggingface.co/Xenova/trocr-base-handwritten/resolve/main/onnx/${f}?download=true`;
  console.log("navigating:", url);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(e => console.log("goto:", e.message.slice(0, 80)));
  const t0 = Date.now();
  let done = false;
  while (Date.now() - t0 < 600000) {
    await new Promise(r => setTimeout(r, 3000));
    const p = [...progress.values()].find(x => x.name === f);
    if (p) { process.stdout.write(`\r  ${f}: ${p.state} ${((p.received || 0) / 1e6).toFixed(1)} / ${((p.total || 0) / 1e6).toFixed(1)} MB   `); if (p.state === "completed" || p.state === "canceled") { done = true; console.log(); break; } }
    else { const t = await page.evaluate(() => document.body?.innerText?.slice(0, 200) || "").catch(() => ""); if (/407|authentication|blocked|denied/i.test(t)) { console.log("\n  page says:", t.replace(/\n+/g, " | ")); break; } }
  }
  if (!done) console.log("  not completed for", f);
}
console.log("files on disk:", readdirSync(dir).map(n => `${n} ${statSync(resolve(dir, n)).size} bytes`));
await page.close(); await browser.disconnect();
