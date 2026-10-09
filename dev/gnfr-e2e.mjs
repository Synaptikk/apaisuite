// dev/gnfr-e2e.mjs [--reload] [shotPrefix] — Supply Orders live check in debug Edge (raw CDP).
// Reloads the extension (optional), opens #/gnfr, waits for the pull, then
// screenshots each tab and prints counts.
import { openTab, closeTab, sleep } from "./_cdp.mjs";
import { writeFileSync } from "node:fs";
const APP = "chrome-extension://fchnolphfaklbpdgnofhblfhcailkpdb/app.html";
const reload = process.argv.includes("--reload");
const prefix = process.argv.filter((a) => !a.startsWith("--"))[2] || "gnfr";
if (reload) {
  const r = await openTab(`${APP}#/home`);
  await sleep(3000);
  r.evalJs("chrome.runtime.reload()").catch(() => {});
  await sleep(4000);
  closeTab(r.tabId);
}
const t = await openTab(`${APP}#/gnfr`);
await t.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
const t0 = Date.now();
let st;
while (Date.now() - t0 < 300_000) {
  await sleep(4000);
  st = await t.evalJs(`({ msg: document.querySelector("#gnfr-msg")?.hidden ? "" : document.querySelector("#gnfr-msg")?.textContent,
    carts: document.querySelectorAll(".module-gnfr .gn-cart").length, busy: document.querySelector("#gnfr-refresh")?.disabled,
    sub: document.querySelector("#gnfr-sub")?.textContent })`).catch((e) => ({ err: e.message }));
  console.log(Math.round((Date.now() - t0) / 1000) + "s", JSON.stringify(st));
  if (st.carts && !st.busy) break;
  if (/error|fail|refused|not signed/i.test(st.msg || "") && !st.busy) break;
}
const shot = async (name) => {
  const { data } = await t.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(`dev/screenshots/${prefix}-${name}.png`, Buffer.from(data, "base64"));
};
await t.evalJs(`document.querySelector(".gn-cart-head")?.click()`);
await sleep(500);
await shot("orders");
for (const tab of ["items", "people", "regulars", "spend"]) {
  await t.evalJs(`document.querySelector('.gn-tabs [data-tab="${tab}"]').click()`);
  await sleep(800);
  console.log(tab, await t.evalJs(`document.querySelector("#gnfr-count").textContent + " | " + document.querySelector("#gnfr-pane").innerText.slice(0, 300).split(String.fromCharCode(10)).join(" ")`));
  await shot(tab);
}
console.log("attention:", await t.evalJs(`[...document.querySelectorAll(".gn-card")].map(c => c.innerText.split(String.fromCharCode(10)).join(" ")).join(" || ")`));
console.log("tab", t.tabId);
t.close(); process.exit(0);
