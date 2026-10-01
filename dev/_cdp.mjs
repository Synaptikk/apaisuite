// dev/_cdp.mjs — scratch CDP helper (raw WebSocket, single target).
export async function targets() {
  return (await fetch("http://127.0.0.1:9222/json/list")).json();
}

export async function connect(tabId) {
  const tab = (await targets()).find(t => t.id === tabId);
  if (!tab) throw new Error("tab gone: " + tabId);
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    else if (m.method) listeners.forEach(fn => fn(m));
  };
  const send = (method, params = {}, timeout = 120000) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(method + " timed out")); } }, timeout);
  });
  const evalJs = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("eval: " + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return r.result.value;
  };
  return { ws, send, evalJs, on: fn => listeners.push(fn), close: () => ws.close() };
}

export async function openTab(url) {
  const r = await fetch("http://127.0.0.1:9222/json/new?url=about:blank", { method: "PUT" });
  const tab = await r.json();
  const c = await connect(tab.id);
  await c.send("Page.enable");
  await c.send("Runtime.enable");
  await c.send("Network.enable");
  await c.send("Page.navigate", { url });
  return { tabId: tab.id, ...c };
}

export const closeTab = id => fetch(`http://127.0.0.1:9222/json/close/${id}`);
export const sleep = ms => new Promise(r => setTimeout(r, ms));
