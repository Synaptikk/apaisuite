// dev/gnfr-cache-check.mjs [--reload] — Supply Orders: a second refresh must read recent weeks only.
import { openTab, closeTab, sleep } from "./_cdp.mjs";
const APP = "chrome-extension://fchnolphfaklbpdgnofhblfhcailkpdb/app.html";
if (process.argv.includes("--reload")) {
  const r = await openTab(`${APP}#/home`); await sleep(3000);
  r.evalJs("chrome.runtime.reload()").catch(() => {}); await sleep(5000); closeTab(r.tabId);
}
const t = await openTab(`${APP}#/home`);
await sleep(4000);
const pull = () => t.evalJs(`(async () => { const t0 = Date.now();
  const r = await chrome.runtime.sendMessage({ module: "gnfr", type: "pull", days: 365 });
  const x = r?.ok !== undefined ? r : r?.result ?? r;
  return { ms: Date.now() - t0, ok: x?.ok, full: x?.full, months: x?.months, read: x?.read, carts: x?.data ? Object.keys(x.data.carts).length : null, err: x?.error, keys: Object.keys(r || {}) };
})()`);
for (let i = 1; i <= 2; i++) console.log(`pull ${i}:`, JSON.stringify(await pull()));
t.close(); process.exit(0);
