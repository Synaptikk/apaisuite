// modules/compliance/service.js
//
// Compliance Tasks — service-worker handlers.
//
//   get_settings   facility number (defaults to the home store)
//   save_settings  { facility }
//   cached         the last pull (instant paint)
//   pull           { force } → tasks for the facility (6 months back, 2 ahead),
//                  each recurring type's learned form, recent answers
//   save_task      { id, values, complete, dryRun } → PATCH the task's current step
//                  (complete adds "End Workflow", the form's Complete and Close;
//                  dryRun returns the payload without sending it)
//
// See lib/enviance.js for the endpoints. Form definitions change rarely, so
// they are cached per type@version for a week; the task list and answers are
// re-read on every pull.

import { getUserHomeStore } from "../../shared/userStore.js";
import { withKeepAwake } from "../../shared/sw_keepalive.js";
import { withEnviance, eqlString, taskUrl, PORTAL_URL, onProgress } from "./lib/enviance.js";
import { learnForm, isChildType, FORM_APPS, buildStepInfo, completedBy } from "./lib/forms.js";

const KEY = {
  settings: "compliance.settings.v1",
  pull:     "compliance.pull.v1",
  forms:    "compliance.forms.v1",     // { "type@ver": { at, template, extra } }
};
const FORM_TTL_MS = 7 * 86_400_000;

// What the running pull/save is doing, for the page's status line: a stall
// then names its step instead of just "Loading…".
let progress = { stage: "", at: 0 };
export function setProgress(stage) { progress = { stage, at: Date.now() }; }
onProgress(setProgress);
const HISTORY = 6;                      // completions used to learn a form

async function settings() {
  const got = (await chrome.storage.local.get(KEY.settings))[KEY.settings] || {};
  const facility = got.facility || String((await getUserHomeStore().catch(() => null)) || "");
  return { facility };
}
const facilityName = (n) => `Facility ${String(n).replace(/\D/g, "").padStart(5, "0")}`;
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const INSTANCE_COLS = `wfi.ID as id, wfi.Name as name, wfi.UniqueID as uid, wft.Name as type, wft.Version as ver,
  localtime(wfi.DueDate,4) as due, localtime(wfi.Created,4) as created, localtime(wfi.CloseDate,4) as closed,
  wfi.PrimaryStatus as isopen, wfs.Name as step`;
const INSTANCE_FROM = `FROM [WorkflowInstance] wfi JOIN WorkflowStep wfs ON wfi JOIN WorkflowType wft ON wfi`;

const CF_DEFS = (where) => `SET CULTURE='en-US'
SELECT DISTINCT cf.ID AS id, cf.Name AS name, cf.Caption.Invariant AS caption, cf.Label.Invariant AS label,
  cf.Description.Invariant AS description, cf.DataType AS dataType, cf.ValueEntryMethod AS entry
FROM CustomField cf WHERE ${where}`;
const CF_ITEMS = (ids) => `SET CULTURE='en-US'
SELECT DISTINCT cf.ID AS id, cf.TrueValue.Invariant as trueValue, cf.FalseValue.Invariant as falseValue,
  cf.ListItemOrder as itemOrder, cf.ListItem.Text.Invariant as itemText, cf.ListItem.Number as itemNumber
FROM CustomField cf WHERE cf.ID IN (${ids}) ORDER BY cf.ID, cf.ListItemOrder`;

function shapeFields(fields, defs, items) {
  const defById = new Map(defs.map((d) => [d.id, d]));
  return fields.map((f) => {
    const d = defById.get(f.id) || {};
    const its = items.filter((i) => i.id === f.id);
    let options = [...new Set(its.map((i) => i.itemText ?? (i.itemNumber != null ? String(i.itemNumber) : null)).filter((x) => x != null))];
    const tf = its.find((i) => i.trueValue != null);
    if (!options.length && tf && /true\/false/i.test(d.dataType || "")) options = [];
    return {
      name: f.name || d.name, caption: d.caption || d.label || d.description || f.name || d.name,
      dataType: d.dataType, entry: d.entry, options, reqDone: !!f.reqDone,
    };
  });
}

// Form template fields (+ captions, options) for one type version. Cached.
async function loadForm(envianceRun, type, ver, keyedNames, force) {
  const cache = (await chrome.storage.local.get(KEY.forms))[KEY.forms] || {};
  const ck = `${type}@${ver}`;
  const hit = cache[ck];
  const missing = hit ? keyedNames.filter((n) => !hit.template.some((f) => f.name === n) && !hit.extra.some((f) => f.name === n)) : keyedNames;
  if (hit && !force && Date.now() - hit.at < FORM_TTL_MS && !missing.length) return hit;

  setProgress(`learning the ${type} form`);
  const [def] = await envianceRun([{ api: `ver2/WorkflowTypeService.svc/workflowtype/${encodeURIComponent(type)}/version/${ver}` }]);
  const steps = (def?.workflowSteps || []).filter((s) => s.formTemplate);
  const template = [];
  for (const s of steps) {
    const [fields] = await envianceRun([{ eql: `SELECT ft.CustomField.ID AS id, ft.CustomField.Name AS name, ft.CustomField.[Order] AS [order],
      ft.CustomField.Validation.RequiredOnTransition AS reqDone
      FROM FormTemplate ft WHERE (ft.Name = '${eqlString(s.formTemplate.name)}' AND ft.Version = ${Number(s.formTemplate.version) || 1})
      ORDER BY ft.CustomField.[Order]` }]);
    const ids = fields.map((f) => `'${f.id}'`).join(",");
    const [defs, items] = ids ? await envianceRun([{ eql: CF_DEFS(`cf.ID IN (${ids})`) }, { eql: CF_ITEMS(ids) }]) : [[], []];
    for (const f of shapeFields(fields, defs, items)) template.push({ ...f, step: s.name });
  }
  // Keyed fields the form app writes that are not on the template.
  const onTpl = new Set(template.map((f) => f.name));
  const offNames = keyedNames.filter((n) => !onTpl.has(n));
  let extra = [];
  if (offNames.length) {
    const [defs] = await envianceRun([{ eql: CF_DEFS(`cf.Name IN (${offNames.map((n) => `'${eqlString(n)}'`).join(",")})`) }]);
    const ids = defs.map((d) => `'${d.id}'`).join(",");
    const [items] = ids ? await envianceRun([{ eql: CF_ITEMS(ids) }]) : [[]];
    extra = shapeFields(defs.map((d) => ({ id: d.id, name: d.name })), defs, items);
  }
  const entry = { at: Date.now(), steps: steps.map((s) => s.name), template, extra };
  cache[ck] = entry;
  await chrome.storage.local.set({ [KEY.forms]: cache });
  return entry;
}

async function pull({ force } = {}) {
  const s = await settings();
  if (!s.facility) return { ok: false, error: "Set the facility (store number) first." };
  return withEnviance((envianceRun) => pullWith(envianceRun, s, force));
}

async function pullWith(envianceRun, s, force) {
  const fac = eqlString(facilityName(s.facility));
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() - 6, 1);   // 6 monthly completions to learn from
  const to = new Date(now.getFullYear(), now.getMonth() + 3, 0);
  setProgress("reading the task list");
  const [rows, oldOpen] = await envianceRun([
    { eql: `SET CULTURE='en-US'\nSELECT ${INSTANCE_COLS} ${INSTANCE_FROM}
      WHERE wfi.SinglePoi.Name = '${fac}' AND wfi.DueDate >= toUtc('${ymd(from)} 00:00', 4) AND wfi.DueDate <= toUtc('${ymd(to)} 23:59', 4)` },
    { eql: `SET CULTURE='en-US'\nSELECT ${INSTANCE_COLS} ${INSTANCE_FROM}
      WHERE wfi.SinglePoi.Name = '${fac}' AND wfi.PrimaryStatus = 'true' AND wfi.DueDate < toUtc('${ymd(from)} 00:00', 4)` },
  ]);
  const tasks = rows.filter((r) => !isChildType(r.type));
  const children = rows.filter((r) => isChildType(r.type));

  // Answers: open tasks + the latest completions of each type.
  const byType = new Map();
  for (const t of tasks) { if (!byType.has(t.type)) byType.set(t.type, []); byType.get(t.type).push(t); }
  const want = [];
  for (const list of byType.values()) {
    list.sort((a, b) => (a.due < b.due ? 1 : -1));
    want.push(...list.filter((t) => !t.isopen).slice(0, HISTORY), ...list.filter((t) => t.isopen));
  }
  const answers = new Map();
  for (let i = 0; i < want.length; i += 40) {
    const chunk = want.slice(i, i + 40);
    setProgress(`reading past answers (${Math.min(i + 40, want.length)} of ${want.length} tasks)`);
    const [steps] = await envianceRun([{ api: "ver2/WorkflowService.svc/workflows/steps", method: "POST",
      body: { workflowStepMaps: chunk.map((t) => ({ workflowIdOrUniqueId: t.id, stepIdsOrNames: null })) } }]);
    for (const st of steps || []) {
      const cur = answers.get(st.id) || {};
      for (const f of st.fields || []) cur[f.name] = f.values;
      answers.set(st.id, cur);
    }
  }

  const types = {};
  for (const [type, list] of byType) {
    const ver = Math.max(...list.map((t) => t.ver || 1));
    const hist = list.filter((t) => !t.isopen && t.ver === ver).slice(0, HISTORY).map((t) => ({ id: t.id, fields: answers.get(t.id) || {} }));
    const keyed = [...new Set(hist.flatMap((h) => Object.entries(h.fields).filter(([, v]) => v && v.some((x) => x !== null && x !== "")).map(([n]) => n)))];
    let form = null, formError = null;
    try {
      const f = await loadForm(envianceRun, type, ver, keyed, force);
      form = learnForm(f.template, f.extra, hist);
    } catch (e) { formError = String(e.message || e); }
    types[type] = { type, ver, name: list[0].name, app: FORM_APPS[type] || null, historyCount: hist.length, form, formError };
  }

  const shaped = tasks.map((t) => {
    const fields = answers.get(t.id) || null;
    const form = types[t.type]?.form;
    return {
      ...t,
      url: taskUrl(FORM_APPS[t.type], t.uid, t.step),
      answers: fields,
      completedBy: !t.isopen && form && fields ? completedBy(form, fields) : null,
      correctiveActions: children.filter((c) => c.closed && t.closed && c.closed.slice(0, 10) === t.closed.slice(0, 10)).length || 0,
    };
  });
  const res = {
    ok: true, at: Date.now(), facility: s.facility, portalUrl: PORTAL_URL,
    tasks: shaped,
    staleOpen: oldOpen.filter((r) => !isChildType(r.type)).map((t) => ({ ...t, url: taskUrl(FORM_APPS[t.type], t.uid, t.step) })),
    types,
  };
  await chrome.storage.local.set({ [KEY.pull]: res });
  return res;
}

async function saveTask({ id, values, complete, dryRun }) {
  const last = (await chrome.storage.local.get(KEY.pull))[KEY.pull];
  const task = last?.tasks?.find((t) => t.id === id);
  if (!task) return { ok: false, error: "Task not found; refresh and try again." };
  if (!task.isopen) return { ok: false, error: "That task is already closed." };
  const form = last.types[task.type]?.form;
  if (!form) return { ok: false, error: "Fill this one in Enviance." };
  const { stepInfo, problems } = buildStepInfo(form, values || {}, { complete: !!complete });
  if (problems.length) return { ok: false, problems };
  if (dryRun) return { ok: true, dryRun: true, stepInfo };
  return withEnviance((envianceRun) => writeStep(envianceRun, last, task, stepInfo));
}

async function writeStep(envianceRun, last, task, stepInfo) {
  const id = task.id;
  // Confirm it is still open before writing (someone may have finished it on the floor).
  const [[live]] = await envianceRun([{ eql: `SELECT wfi.PrimaryStatus as isopen, wfs.Name as step FROM [WorkflowInstance] wfi JOIN WorkflowStep wfs ON wfi WHERE wfi.ID = '${eqlString(id)}'` }]);
  if (!live?.isopen) return { ok: false, error: "Enviance says this task was already completed. Refresh to see it." };
  const stepUrl = `ver2/WorkflowService.svc/workflows/${encodeURIComponent(id)}/steps/currentstep`;
  // Two requests, as the Enviance form does it ("Close Workflow" action):
  // save the answers, then a bare "End Workflow" transition (comment "", no
  // close date: these forms do not allow changing it, Enviance stamps now).
  await envianceRun([{ api: stepUrl, method: "PATCH", body: { stepInfo: { fields: stepInfo.fields } } }]);
  let closeError = null;
  if (stepInfo.transition) {
    try {
      await envianceRun([{ api: stepUrl, method: "PATCH", body: { stepInfo: { comment: "", transition: { stepActionName: stepInfo.transition.stepActionName } } } }]);
    } catch (e) { closeError = String(e.message || e); }
  }
  // Read back what Enviance now holds.
  const [[after], steps] = await envianceRun([
    { eql: `SELECT wfi.PrimaryStatus as isopen, localtime(wfi.CloseDate,4) as closed FROM [WorkflowInstance] wfi WHERE wfi.ID = '${eqlString(id)}'` },
    { api: "ver2/WorkflowService.svc/workflows/steps", method: "POST", body: { workflowStepMaps: [{ workflowIdOrUniqueId: id, stepIdsOrNames: null }] } },
  ]);
  const saved = {};
  for (const st of steps || []) for (const f of st.fields || []) saved[f.name] = f.values;
  const missing = stepInfo.fields.filter((f) => !(saved[f.name] || []).some((v) => v !== null && v !== "")).map((f) => f.name);
  // Keep the cached pull in step so the page shows the new state.
  task.answers = saved; task.isopen = !!after?.isopen; task.closed = after?.closed || task.closed;
  await chrome.storage.local.set({ [KEY.pull]: last });
  if (stepInfo.transition && after?.isopen) {
    return { ok: false, savedOnly: true, task, sent: stepInfo.fields.length, missing,
      error: `Your answers were saved to Enviance, but it did not close the task${closeError ? `: ${closeError}` : "."} Open it in Enviance and press Complete and Close there.` };
  }
  return { ok: true, completed: !after?.isopen, sent: stepInfo.fields.length, missing, task };
}

export const handlers = {
  async get_settings() { return { ok: true, ...(await settings()) }; },
  async save_settings(msg) {
    const facility = String(msg.facility || "").replace(/\D/g, "").replace(/^0+/, "");
    if (!facility) return { ok: false, error: "Enter a store number." };
    await chrome.storage.local.set({ [KEY.settings]: { facility } });
    return { ok: true, facility };
  },
  async progress() { return { ok: true, ...progress, ageMs: progress.at ? Date.now() - progress.at : null }; },
  async cached() {
    const s = await settings();
    const got = (await chrome.storage.local.get(KEY.pull))[KEY.pull];
    return got && got.facility === s.facility ? got : { ok: false };
  },
  async pull(msg) {
    // The work is mostly awaiting the Enviance tab; without the keep-alive Edge
    // collects the worker mid-pull and the page waits on an answer forever.
    setProgress("starting");
    try { return await withKeepAwake("compliance:pull", () => pull({ force: !!msg?.force })); }
    catch (e) { return { ok: false, error: String(e.message || e), code: e.code }; }
  },
  async save_task(msg) {
    try { return await withKeepAwake("compliance:save", () => saveTask(msg || {})); }
    catch (e) { return { ok: false, error: String(e.message || e), code: e.code }; }
  },
};
