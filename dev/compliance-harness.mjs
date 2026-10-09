// dev/compliance-harness.mjs <handler> [jsonMsg] [outJson]
// Runs modules/compliance/service.js handlers in Node against the debug Edge's open
// Enviance portal tab: chrome.tabs/scripting are stubbed so executeScript evaluates the
// page function in that tab over CDP; chrome.storage.local is a JSON file in dev/.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const [handler, msgJson = "{}", out] = process.argv.slice(2);
const STORE = new URL("./.compliance-harness-storage.json", import.meta.url);
const mem = existsSync(STORE) ? JSON.parse(readFileSync(STORE, "utf8")) : { "compliance.settings.v1": { facility: "1458" } };
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const target = list.find((x) => x.type === "page" && x.url.startsWith("https://go.enviance.com/CustomApp/"));
if (!target) { console.log("open the Enviance portal in debug Edge"); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl); let id = 0; const pend = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise((r) => (ws.onopen = r));
const deny = (what) => () => { throw new Error(`harness: ${what} not stubbed`); };
globalThis.chrome = {
  storage: {
    local: { get: async (k) => ({ [k]: mem[k] }), set: async (o) => { Object.assign(mem, o); writeFileSync(STORE, JSON.stringify(mem)); } },
    session: { get: async () => ({}), set: async () => {} },
  },
  tabs: {
    query: async () => [{ id: 1, url: target.url, status: "complete" }],
    get: async () => ({ id: 1, url: target.url, status: "complete" }),
    // create() hands back the existing Enviance tab (target) as "tab 1"; remove() leaves it open.
    update: async () => ({}), create: async () => ({ id: 1 }), remove: async () => {},
  },
  scripting: {
    executeScript: async ({ func, args }) => {
      const r = await send("Runtime.evaluate", { expression: `(${func})(...${JSON.stringify(args || [])})`, returnByValue: true, awaitPromise: true, timeout: 290000 });
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "page error");
      return [{ result: r.result?.result?.value }];
    },
  },
  runtime: { id: "harness", getURL: (p) => p },
};
const { handlers } = await import("../modules/compliance/service.js");
const t0 = Date.now();
const res = await handlers[handler](JSON.parse(msgJson));
console.log(`${handler} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (out) writeFileSync(out, JSON.stringify(res, null, 1));
if (!res?.ok) console.log(JSON.stringify(res).slice(0, 1500));
else if (res.tasks) {
  console.log("tasks", res.tasks.length, "stale open", res.staleOpen.length);
  for (const t of Object.values(res.types)) console.log(" ", t.type, "v" + t.ver, "| hist", t.historyCount, "| form", t.form?.length ?? t.formError);
} else console.log(JSON.stringify(res).slice(0, 1500));
ws.close(); process.exit(0);
