// Read the extension service worker's console over raw CDP (puppeteer's
// worker.evaluate hangs in this Edge — see MEMORY.md::suite-install-locations).
const EXT = "fchnolphfaklbpdgnofhblfhcailkpdb";
const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const sw = targets.find(t => t.type === "service_worker" && t.url.includes(EXT));
console.log("SW target:", sw ? sw.url : "NOT RUNNING (collected or never booted)");
if (!sw) process.exit(0);

const ws = new WebSocket(sw.webSocketDebuggerUrl);
let id = 0;
const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));
const lines = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === "Runtime.consoleAPICalled") {
    lines.push(`[${m.params.type}] ` + m.params.args.map(a => a.value ?? a.description ?? a.type).join(" "));
  }
  if (m.method === "Log.entryAdded") lines.push(`[log:${m.params.entry.level}] ${m.params.entry.text}`);
  if (m.method === "Runtime.exceptionThrown") lines.push(`[exception] ${m.params.exceptionDetails.text} ${m.params.exceptionDetails.exception?.description ?? ""}`);
};
await new Promise(r => { ws.onopen = r; });
send("Runtime.enable"); send("Log.enable");
await new Promise(r => setTimeout(r, 2500));
for (const l of lines.filter(l => /cx|error|fail|medallia/i.test(l))) console.log(l);
console.log(`(${lines.length} lines total)`);
ws.close();
