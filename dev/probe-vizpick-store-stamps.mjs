// dev/probe-vizpick-store-stamps.mjs — usage: node dev/probe-vizpick-store-stamps.mjs [store ...]
// Needs the debug Edge on 9222, signed in to Tableau. Opens a background tab on
// VizPickDetails, sets the Store parameter to each store in turn and prints the
// labelled "Updated" text the dashboard shows for it — the check behind the
// per-store stamp logic in modules/vizpick/lib/sources/vizpick_today_tableau.js
// (stores update at different times, 2026-09-15). Raw CDP over the built-in
// WebSocket: puppeteer.connect hung against this Edge build.
const URL = "https://stores.tableau.wal-mart.com/#/site/OnlineGrocery/views/VizPick/VizPickDetails?:iid=1&:linktarget=_self";
const STORES = process.argv.slice(2).length ? process.argv.slice(2) : ["1458", "3660", "669", "5151", "1089"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ver = await (await fetch("http://127.0.0.1:9222/json/version")).json();
const bws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r, j) => { bws.onopen = r; bws.onerror = j; });
let id = 0; const pending = new Map(); const events = [];
bws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else events.push(d); };
const send = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pending.set(i, r); bws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const { result: { targetId } } = await send("Target.createTarget", { url: "about:blank", background: true });
const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Runtime.enable", {}, sessionId);
await send("Page.enable", {}, sessionId);
await send("Page.navigate", { url: URL }, sessionId);
const ctxs = () => events.filter((e) => e.sessionId === sessionId && e.method === "Runtime.executionContextCreated").map((e) => e.params.context);
const evalAll = async (expr, awaitPromise = false) => {
  const out = [];
  for (const c of ctxs()) {
    const r = await send("Runtime.evaluate", { expression: expr, contextId: c.id, returnByValue: true, awaitPromise }, sessionId);
    if (r.result?.exceptionDetails) console.error("eval error:", r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
    if (r.result?.result?.value != null) out.push(r.result.result.value);
  }
  return out;
};
const READ = String.raw`(() => { const el = document.querySelector('textarea[aria-label="Store"], input[aria-label="Store"]'); if (!el) return null;
  const RE = /(\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(?::\d{2})?|\d{1,2}\/\d{1,2}\/\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)?)/i; const hits = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) { const t = (n.nodeValue || "").trim(); if (!t) continue; const m = RE.exec(t); if (!m) continue;
    let ctx = ""; try { ctx = n.parentElement?.closest("div,span,td,th")?.innerText || ""; } catch {}
    hits.push({ date: m[1], labelled: /updated|last\s*update/i.test(ctx), ctx: ctx.replace(/\s+/g, " ").slice(0, 60) }); }
  return { box: String(el.value ?? "").trim(), hits }; })()`;
const SET = (v) => `(() => { const el = document.querySelector('textarea[aria-label="Store"], input[aria-label="Store"]'); if (!el) return false;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const s = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  el.focus(); if (s) s.call(el, ${JSON.stringify(v)}); else el.value = ${JSON.stringify(v)};
  el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
  for (const t of ["keydown","keypress","keyup"]) el.dispatchEvent(new KeyboardEvent(t, { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 }));
  el.blur(); return true; })()`;
// The dashboard draws its "Updated" stamp on canvas, so it is not in the DOM
// (2026-09-15 probe: no date text node in any frame). The extension's real
// path is the Last-update sheet through Tableau's worksheet-summary command,
// against the session's CURRENT parameter state — the same call as
// lib/sources/tableau_export_replay.js::directSummaryExport.
const SUMMARY = `(async () => { const c = window.tsConfig; if (!c?.sessionid || !c.repositoryUrl || !c.site_root) return null;
  const [wb, view] = String(c.repositoryUrl).split("/"); const base = location.origin + "/vizql" + c.site_root + "/w/" + wb + "/v/" + view + "/sessions/" + c.sessionid;
  const form = new FormData(); const args = { visualIdPresModel: JSON.stringify({ worksheet: "Last update", dashboard: "VizPick Details" }), versionName: "1.0", maxRows: "0", ignoreAliases: "false", ignoreSelection: "true" };
  for (const [k, v] of Object.entries(args)) form.append(k, v);
  const r = await fetch(base + "/commands/tabdoc/api-get-worksheet-summary-logical-table-data", { method: "POST", body: form, credentials: "include", signal: AbortSignal.timeout(15000) });
  if (!r.ok) return { ok: false, reason: "HTTP " + r.status };
  const body = await r.json(); const model = body?.vqlCmdResponse?.cmdResultList?.[0]?.commandReturn?.dataTablePresModel;
  if (!model?.showDataFormattedTable) return { ok: false, reason: "no table" };
  const table = JSON.parse(model.showDataFormattedTable).table;
  return { ok: true, columns: table.schema, rows: (table.tuples || []).slice(0, 3) }; })()`;
const lastUpdate = async () => (await evalAll(SUMMARY, true)).find((x) => x?.ok) ?? (await evalAll(SUMMARY, true))[0] ?? null;
// A cold session (SSO redirect chain + viz render) can take well over a
// minute; the crawl itself allows 120s. On timeout say WHAT the page shows,
// so a sign-in prompt and a slow render are distinguishable.
const WAIT_S = Number(process.env.PROBE_WAIT_S) || 180;
const DIAG = `(() => ({ url: location.href.slice(0, 100), title: document.title, iframes: document.querySelectorAll("iframe").length,
  inputs: [...document.querySelectorAll("textarea,input")].map((n) => n.getAttribute("aria-label") || n.placeholder || n.name || n.type).slice(0, 10),
  toolbar: !!document.querySelector('[data-tb-test-id="viz-viewer-toolbar-button-download"]'),
  text: (document.body?.innerText || "").replace(/\\s+/g, " ").slice(0, 160) }))()`;
let first = null;
for (let i = 0; i < WAIT_S && !first; i++) {
  await sleep(1000);
  first = (await evalAll(READ))[0] || null;
  if (!first && i % 30 === 29) console.log(`${i + 1}s: still waiting for the Store parameter`, JSON.stringify(await evalAll(DIAG)));
}
if (!first) { console.log(`no Store parameter after ${WAIT_S}s:`, JSON.stringify(await evalAll(DIAG), null, 1)); await send("Target.closeTarget", { targetId }); process.exit(1); }
console.log("initial:", JSON.stringify(first), "lastUpdate:", JSON.stringify(await lastUpdate()));
for (const st of STORES) {
  const ok = (await evalAll(SET(st))).some(Boolean);
  if (!ok) { console.log(st, "set failed"); continue; }
  // Wait for the box to show the store, then a few seconds for the re-query
  // the parameter change triggers, before asking the session for the sheet.
  let r = null;
  for (let i = 0; i < 25; i++) { await sleep(1000); r = (await evalAll(READ))[0]; if (r?.box === st && i >= 5) break; }
  const lu = await lastUpdate();
  const dom = r?.hits.filter((h) => h.labelled).map((h) => h.date);
  console.log(`store ${st}: box=${r?.box} lastUpdateSheet=${JSON.stringify(lu?.ok ? lu.rows : lu)} domUpdated=${JSON.stringify(dom)}`);
}
await send("Target.closeTarget", { targetId }); bws.close();
