// dev/outlook-send-test.mjs <to> <subject> <textFile|-> [png...]
// Drives shared/outlook_send.js's in-page code in the debug Edge over raw CDP,
// so the Outlook auto-send can be tested without reloading the extension.
import { readFileSync } from "node:fs";
import { __inPage, parseRecipients, textToHtml } from "../shared/outlook_send.js";
const [to, subject, textFile, ...pngs] = process.argv.slice(2);
const text = textFile && textFile !== "-" ? readFileSync(textFile, "utf8") : "";
const images = pngs.map((p, i) => ({ base64: readFileSync(p).toString("base64"), name: `image${i + 1}.png` }));
const url = `https://outlook.office.com/mail/deeplink/compose?to=${encodeURIComponent(parseRecipients(to).join(";"))}&subject=${encodeURIComponent(subject)}`;

const ver = await (await fetch("http://127.0.0.1:9222/json/version")).json();
const cdp = async (wsUrl) => {
  const ws = new WebSocket(wsUrl); let id = 0; const pend = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  ws.onclose = () => { for (const r of pend.values()) r({ closed: true }); };
  await new Promise((r) => (ws.onopen = r));
  return { ws, send: (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); }) };
};
const b = await cdp(ver.webSocketDebuggerUrl);
const { result: { targetId } } = await b.send("Target.createTarget", { url, background: true });
await new Promise((r) => setTimeout(r, 1500));
const t = (await (await fetch("http://127.0.0.1:9222/json/list")).json()).find((x) => x.id === targetId);
const p = await cdp(t.webSocketDebuggerUrl);
const call = async (fn, arg) => {
  const r = await p.send("Runtime.evaluate", { expression: `(${fn.toString()})(${arg === undefined ? "" : JSON.stringify(arg)})`, awaitPromise: true, returnByValue: true, timeout: 120000 });
  return r.closed ? { closed: true } : (r.result?.result?.value ?? r.result?.exceptionDetails?.text ?? r.error);
};
const fill = await call(__inPage.IN_PAGE_FILL, { html: textToHtml(text), images, timeoutMs: 60000 });
console.log("fill:", JSON.stringify(fill));
if (!fill?.ok) process.exit(1);
await call(__inPage.IN_PAGE_CLICK_SEND);
for (let i = 0; i < 45; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const alive = (await (await fetch("http://127.0.0.1:9222/json/list")).json()).some((x) => x.id === targetId);
  if (!alive) { console.log("sent (window closed)"); process.exit(0); }
  const st = await call(__inPage.IN_PAGE_SEND_STATE);
  if (st?.closed || st?.sent) { console.log("sent", JSON.stringify(st)); process.exit(0); }
  if (st?.error) { console.log("error", st.error); process.exit(1); }
}
console.log("timeout"); process.exit(1);
