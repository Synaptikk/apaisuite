// dev/vizpick-daydetails-check.mjs
//
// Live check of lib/day_details.js against the debug Edge (port 9222):
// reloads the dev-mirror extension, opens the VizPick module, and reports what
// get_state.dayDetails holds and what a closed-day card renders.
//
//   node dev/vizpick-daydetails-check.mjs            # reload, then check
//   node dev/vizpick-daydetails-check.mjs --no-reload
//
// Raw CDP over Node's WebSocket: puppeteer.connect hangs against Edge 153.
const EXT = "fchnolphfaklbpdgnofhblfhcailkpdb";
const APP = `chrome-extension://${EXT}/app.html#/vizpick`;
const RELOAD = !process.argv.includes("--no-reload");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const ver = await (await fetch("http://127.0.0.1:9222/json/version")).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const send = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  return { ws, send };
}

async function openApp(send) {
  const { result: { targetId } } = await send("Target.createTarget", { url: APP, background: true });
  const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, sessionId);
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  return { targetId, evaluate };
}

let { ws, send } = await connect();
if (RELOAD) {
  const page = await openApp(send);
  await sleep(1500);
  await page.evaluate("chrome.runtime.reload()").catch(() => {});
  ws.close();
  await sleep(4000);
  ({ ws, send } = await connect());
}

const page = await openApp(send);
await sleep(4000);

const state = await page.evaluate(`new Promise((res) => chrome.runtime.sendMessage({ module: "vizpick", type: "get_state" }, (r) => res({
  err: chrome.runtime.lastError?.message ?? null,
  days: (r?.days || []).map((d) => d.dataDate),
  todayStamp: r?.today?.sourceUpdate?.raw ?? null,
  todayStores: (r?.today?.rows || []).length,
  dayDetails: Object.fromEntries(Object.entries(r?.dayDetails || {}).map(([day, stores]) => [day, Object.values(stores).map((d) => ({
    store: d.store, asOf: d.sourceUpdate?.raw ?? d.capturedAt, depts: d.depts?.length ?? null,
    gaps: d.locations?.gaps?.length ?? null, fromHistory: !!d.fromHistory,
  }))])),
})))`);
console.log(JSON.stringify(state, null, 1));

const archive = await page.evaluate(`chrome.storage.local.get("vizpick.dayDetails.v1.index")`);
console.log("archive index:", JSON.stringify(archive));

// Render each closed-day tab that has detail and read one expanded card back.
const days = Object.keys(state.dayDetails || {});
for (const day of days) {
  const out = await page.evaluate(`(async () => {
    const root = document.querySelector(".module-vizpick");
    const tab = [...root.querySelectorAll("[data-tab]")].find((b) => b.dataset.tab === "day:${day}");
    if (!tab) return { day: "${day}", error: "no tab", tabs: [...root.querySelectorAll("[data-tab]")].map((b) => b.dataset.tab) };
    tab.click();
    await new Promise((r) => setTimeout(r, 600));
    const store = ${JSON.stringify(state.dayDetails[day][0].store)};
    const card = () => root.querySelector('[data-store="' + store + '"]');
    if (!card()) return { day: "${day}", error: "no card for " + store };
    if (card().querySelector("[data-toggle-store]").getAttribute("aria-expanded") !== "true") card().querySelector("[data-toggle-store]").click();
    await new Promise((r) => setTimeout(r, 400));
    const dept = { note: card().querySelector(".vizpick-daydetail-note")?.textContent ?? null,
      deptRows: card().querySelectorAll(".vizpick-dept-table tbody tr").length,
      firstDept: card().querySelector(".vizpick-dept-table tbody tr")?.innerText.replace(/\\s+/g, " ") ?? null };
    card().querySelector('[data-detail-tab="assoc"]')?.click();
    await new Promise((r) => setTimeout(r, 400));
    const assoc = { rows: card().querySelectorAll(".vizpick-assoc-row").length,
      first: card().querySelector(".vizpick-assoc-row")?.innerText.replace(/\\s+/g, " ") ?? null,
      empty: card().querySelector(".vizpick-store-card-details .vizpick-dept-none:not(.vizpick-daydetail-note)")?.textContent ?? null };
    card().querySelector('[data-detail-tab="dept"]')?.click();
    return { day: "${day}", store, dept, assoc };
  })()`);
  console.log(JSON.stringify(out, null, 1));
}

await send("Target.closeTarget", { targetId: page.targetId });
ws.close();
