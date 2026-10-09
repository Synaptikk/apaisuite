// dev/enviance-catalog.mjs <outJson> [facility] — over the debug Edge (9222), from an open Enviance CustomApp tab:
// every recurring compliance type at the facility → workflow definition (steps, form templates), form fields
// (order, required, caption, data type, list options) and the answers keyed into the last N completions.
// Read-only: EQL SELECTs + WorkflowService GETs / bulk step read.
import { readFileSync, writeFileSync } from "node:fs";
const [out, facility = "Facility 01458"] = process.argv.slice(2);
const TYPES = ["EWI-EyeWashInspection-v2", "FLA-InspectionChecklist-HazWaste", "SPC-SPCCInspection", "FEX-Fire Extinguisher-v2",
  "ERL-EmergencyLights_Signs-v2", "WSA-WMSafetyAssessment-v2", "FLA-MST-Security Tour-v2", "FLA-OSH-300Log"];
const HISTORY = 6;
const cfDefs = readFileSync(new URL("./enviance-cf-defs.eql", import.meta.url), "utf8");
const cfItems = readFileSync(new URL("./enviance-cf-items.eql", import.meta.url), "utf8");
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const t = list.find((x) => x.type === "page" && x.url.includes("go.enviance.com/CustomApp"));
if (!t) { console.log("open the Enviance compliance portal in debug Edge first"); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl); let id = 0; const pend = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise((r) => (ws.onopen = r));
await send("Page.setWebLifecycleState", { state: "active" });
const pageFn = async ({ TYPES, HISTORY, facility, cfDefs, cfItems }) => {
  const EQL = location.origin + "/CustomApp/ddde6520-3955-4d83-b0ab-78f6e5cbaf10/app/core/query-builder/query-template.eqlx?name=cd2f57ae-5625-4762-8f88-1d47d915cc54__WfAdapt.getWfs";
  const eql = async (q) => {
    const r = await fetch(EQL, { method: "POST", credentials: "include", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "eqlQueryParam=" + encodeURIComponent(JSON.stringify({ parameters: { eqlQuery: q }, page: 1, pageSize: 1000 })) });
    const txt = await r.text(); if (!r.ok) throw new Error("EQL " + r.status + " " + txt.slice(0, 200) + " :: " + q.slice(0, 200));
    const j = JSON.parse(txt)[0]; const cols = j.columns.map((c) => c.name);
    return j.rows.map((x) => Object.fromEntries(cols.map((c, i) => [c, x.values[i]])));
  };
  const bs = await (await fetch("/Packages/Api/BootStrap.svc/2?packageId=ddde6520-3955-4d83-b0ab-78f6e5cbaf10", { credentials: "include" })).json();
  const H = { Authorization: "Enviance " + bs.sessionId, "Content-Type": "application/json", "EnvApi-SystemId": bs.currentSystemId };
  const api = async (path, opt = {}) => { const r = await fetch(bs.apiUrl + "/" + path, { ...opt, headers: H }); const txt = await r.text(); if (!r.ok) return { error: r.status + " " + txt.slice(0, 200) }; return JSON.parse(txt); };
  const q = (s) => s.replace(/'/g, "''");
  const res = {};
  for (const type of TYPES) {
    const o = res[type] = {};
    try {
      const inst = await eql(`SET CULTURE='en-US'
SELECT wfi.ID as id, wfi.Name as name, wfi.UniqueID as uid, wft.Version as ver, localtime(wfi.DueDate,4) as due, localtime(wfi.Created,4) as created, localtime(wfi.CloseDate,4) as closed, wfi.PrimaryStatus as isopen, wfs.Name as step
FROM [WorkflowInstance] wfi JOIN WorkflowStep wfs ON wfi JOIN WorkflowType wft ON wfi
WHERE wfi.SinglePoi.Name = '${q(facility)}' AND wft.Name = '${q(type)}'
`);
      inst.sort((a, b) => (a.due < b.due ? 1 : -1));
      o.instanceCount = inst.length;
      o.recent = inst.slice(0, 40);
      const ver = Math.max(...inst.map((r) => r.ver || 1));
      o.def = await api(`ver2/WorkflowTypeService.svc/workflowtype/${encodeURIComponent(type)}/version/${ver}`);
      const templates = [...new Set((o.def.workflowSteps || []).map((s) => s.formTemplate && `${s.formTemplate.name}|${s.formTemplate.version}`).filter(Boolean))];
      o.templates = {};
      for (const tv of templates) {
        const [name, v] = tv.split("|");
        const fields = await eql(`SELECT ft.CustomField.ID AS id, ft.CustomField.Name AS name, ft.CustomField.[Order] AS [order], ft.CustomField.Validation.RequiredOnSave AS reqSave, ft.CustomField.Validation.RequiredOnTransition AS reqDone
FROM FormTemplate ft WHERE (ft.Name = '${q(name)}' AND ft.Version = ${+v}) ORDER BY ft.CustomField.[Order]`);
        const ids = fields.map((f) => `'${f.id}'`).join(",");
        const defs = ids ? await eql(cfDefs.replace("__IDS__", ids)) : [];
        const items = ids ? await eql(cfItems.replace("__IDS__", ids)) : [];
        const byId = Object.fromEntries(defs.map((d) => [d.key, d]));
        o.templates[name] = fields.map((f) => {
          const d = byId[f.id] || {};
          const its = items.filter((i) => i.id === f.id);
          const options = its.map((i) => i.listItemTextValueInvariant ?? i.listItemNumberValue).filter((x) => x != null);
          const tf = its.find((i) => i.trueValueInvariant != null);
          return { order: f.order, name: f.name, caption: d.captionInvariant || d.labelInvariant || d.descriptionInvariant || null, label: d.labelInvariant || null,
            dataType: d.dataType, entry: d.valueEntryMethod, reqDone: !!f.reqDone, reqSave: !!f.reqSave,
            options: options.length ? [...new Set(options)] : (tf ? [tf.trueValueInvariant, tf.falseValueInvariant] : undefined), formula: d.formula || undefined };
        });
      }
      const done = inst.filter((r) => !r.isopen && r.closed).slice(0, HISTORY);
      const open = inst.filter((r) => r.isopen);
      const ids = [...done, ...open].map((r) => ({ workflowIdOrUniqueId: r.id, stepIdsOrNames: null }));
      const steps = ids.length ? await api("ver2/WorkflowService.svc/workflows/steps", { method: "POST", body: JSON.stringify({ workflowStepMaps: ids }) }) : [];
      const answers = (r) => (Array.isArray(steps) ? steps.filter((s) => s.id === r.id) : []).map((s) => ({ step: s.name, fields: Object.fromEntries((s.fields || []).map((f) => [f.name, f.values])) }));
      o.history = done.map((r) => ({ ...r, answers: answers(r) }));
      o.open = open.map((r) => ({ ...r, answers: answers(r) }));
      if (!Array.isArray(steps)) o.stepsError = steps;
    } catch (e) { o.error = String(e.message || e); }
  }
  return res;
};
const expr = `(${pageFn})(${JSON.stringify({ TYPES, HISTORY, facility, cfDefs, cfItems })})`;
const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, timeout: 600000 });
const v = r.result?.result?.value ?? r.result?.exceptionDetails ?? r.error;
writeFileSync(out, JSON.stringify(v, null, 1));
for (const [k, o] of Object.entries(v || {})) console.log(k, "| inst", o.instanceCount, "| fields", Object.values(o.templates || {}).map((a) => a.length).join("+"), "| hist", o.history?.length, "| open", o.open?.length, o.error || o.stepsError?.error || "");
ws.close(); process.exit(0);
