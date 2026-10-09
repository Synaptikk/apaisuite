// dev/env-eql.mjs <queryFile> [outJson] [pageSize] — run a read-only EQL query through the open Enviance
// CustomApp tab (debug Edge 9222). Prints row count + first rows; writes all rows as objects to outJson.
import { readFileSync, writeFileSync } from "node:fs";
const [qf, out, pageSize = "1000"] = process.argv.slice(2);
const q = readFileSync(qf, "utf8");
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const t = list.find((x) => x.type === "page" && x.url.includes("go.enviance.com/CustomApp") && !x.url.endsWith("sw.js"));
const ws = new WebSocket(t.webSocketDebuggerUrl); let id = 0; const pend = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise((r) => (ws.onopen = r));
const expr = `(async () => {
  const url = location.origin + "/CustomApp/ddde6520-3955-4d83-b0ab-78f6e5cbaf10/app/core/query-builder/query-template.eqlx?name=cd2f57ae-5625-4762-8f88-1d47d915cc54__WfAdapt.getWfs";
  const all = [];
  for (let page = 1; page < 50; page++) {
    const r = await fetch(url, { method: "POST", credentials: "include", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "eqlQueryParam=" + encodeURIComponent(JSON.stringify({ parameters: { eqlQuery: ${JSON.stringify(q)} }, page, pageSize: ${+pageSize} })) });
    const t = await r.text(); if (!r.ok) return { error: r.status + " " + t.slice(0, 1500) };
    const j = JSON.parse(t)[0]; const cols = j.columns.map(c => c.name);
    for (const x of j.rows) all.push(Object.fromEntries(cols.map((c, i) => [c, x.values[i]])));
    if (j.rows.length < ${+pageSize}) break;
  }
  return all;
})()`;
const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, timeout: 170000 });
const v = r.result?.result?.value ?? r.result?.exceptionDetails ?? r.error;
if (out) writeFileSync(out, JSON.stringify(v, null, 1));
if (Array.isArray(v)) { console.log("rows", v.length); console.log(JSON.stringify(v.slice(0, 3), null, 1).slice(0, 2500)); } else console.log(JSON.stringify(v).slice(0, 2500));
ws.close(); process.exit(0);
