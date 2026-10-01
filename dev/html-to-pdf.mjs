// dev/html-to-pdf.mjs — print a local HTML file to PDF through the debug Edge
// (port 9222). No network: Page.printToPDF on a file:// target.
//   node dev/html-to-pdf.mjs <in.html> <out.pdf>
const [IN, OUT] = process.argv.slice(2);
const fs = await import("node:fs/promises");
const path = await import("node:path");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = "file:///" + path.resolve(IN).split(path.sep).join("/");

const ver = await (await fetch("http://127.0.0.1:9222/json/version")).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });

const { result: { targetId } } = await send("Target.createTarget", { url, background: true });
const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Page.enable", {}, sessionId);
await send("Runtime.enable", {}, sessionId);
await sleep(2500);
const ready = await send("Runtime.evaluate", { expression: "document.readyState + '|' + document.title + '|' + document.querySelectorAll('.case').length", returnByValue: true }, sessionId);
console.log("page:", ready.result?.result?.value);
const pdf = await send("Page.printToPDF", {
  printBackground: true, preferCSSPageSize: true,
  paperWidth: 8.5, paperHeight: 11,
  marginTop: 0.6, marginBottom: 0.6, marginLeft: 0.55, marginRight: 0.55,
  displayHeaderFooter: false, scale: 1,
}, sessionId);
if (!pdf.result?.data) { console.error("printToPDF failed:", JSON.stringify(pdf).slice(0, 400)); process.exit(1); }
await fs.writeFile(OUT, Buffer.from(pdf.result.data, "base64"));
console.log("wrote", OUT, (await fs.stat(OUT)).size, "bytes");
await send("Target.closeTarget", { targetId });
ws.close();
