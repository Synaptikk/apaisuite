// modules/compliance/lib/forms.js
//
// Pure helpers: what a compliance form asks, what this store usually keys
// in, and the Enviance step payload for a filled-in copy.
//
// Enviance forms carry far more fields than anyone fills (the eyewash form
// has 397: six station blocks, corrective-action boxes, work-order pickers).
// "Keyed" fields are the ones that hold a value in at least one recent
// completion; those, plus anything required to close, make up the form shown
// here. A keyed field nobody ever changes is "standard" and pre-filled; one
// that changes from week to week (who walked it, the date, bucket counts,
// which station is where) is something to enter off the paper copy.

// Workflow types that are children of a task (corrective actions, feedback,
// per-item CA records), not tasks in their own right.
export function isChildType(typeName) {
  return /corrective|feedback|\bCA(-v\d+)?$|FEXCA|-CA-|\bCA\b/i.test(String(typeName || ""));
}

// Portal link routes (PortalService dashboard, customTypeKey → form app).
export const FORM_APPS = {
  "EWI-EyeWashInspection": "EyeWashInspectionApp",
  "EWI-EyeWashInspection-v2": "EyeWashInspectionV2App",
  "FEX-Fire Extinguisher": "FireExtinguisherApp",
  "FEX-Fire Extinguisher-v2": "FireExtinguisherV2App",
  "ERL-EmergencyLights_Signs": "EmergencyLights_SignsApp",
  "ERL-EmergencyLights_Signs-v2": "EmergencyLightsSignsV2App",
  "FLA-InspectionChecklist-HazWaste": "HazWasteInspectionApp",
  "FLA-MST-Security Tour": "SecurityTourApp",
  "FLA-MST-Security Tour-v2": "SecurityTourV2App",
  "SPC-SPCCInspection": "SPCCInspectionApp",
  "WSA-WMSafetyAssessment": "WMSafetyAssessmentApp",
  "WSA-WMSafetyAssessment-v2": "WMSafetyAssessmentV2App",
  "FuelABOp-MonthlyABOperatorAssessment": "ABOperatorAssessmentApp",
  "HMBP": "HMBPApp",
  "SER-Sams Export Review": "SamsExportReviewApp",
  "ENG-EngineLog": "EngineLogApp",
};

export function fieldKind(dataType, entry) {
  const d = String(dataType || ""), e = String(entry || "");
  if (/date/i.test(d)) return /time/i.test(e) && !/date/i.test(e) ? "time" : "date";
  if (/true\/false/i.test(d)) return "bool";
  if (/multi/i.test(e)) return "multi";
  if (/dropdown|list|radio/i.test(e)) return "select";
  if (/number/i.test(d)) return "number";
  return "text";
}

// SPCC captions repeat the field name in front of the question.
export function cleanCaption(caption, name) {
  let c = String(caption || "").replace(/\s+/g, " ").trim();
  if (name && c.startsWith(name)) c = c.slice(name.length).trim();
  return c || name;
}

const nonEmpty = (v) => Array.isArray(v) && v.some((x) => x !== null && x !== "");
const key = (v) => (v || []).filter((x) => x !== null && x !== "").join(" / ");

// fields:   template fields in form order [{ name, caption, dataType, entry, options, reqDone }]
//           plus definitions for keyed fields that are not on the template.
// history:  recent completions, newest first, each { fields: { name: values[] } }
// Returns the learned form: [{ name, caption, kind, options, reqDone, onTemplate,
//   standard (values[] | null), varies, last, mirrorOf, values seen }]
export function learnForm(templateFields, extraFields, history) {
  const hist = history.filter((h) => h && h.fields);
  const seen = new Map();          // name → [key per completion]
  for (const h of hist) for (const [n, v] of Object.entries(h.fields)) if (nonEmpty(v)) {
    if (!seen.has(n)) seen.set(n, []);
    seen.get(n).push(key(v));
  }
  const onTpl = new Set(templateFields.map((f) => f.name));
  const out = [];
  const add = (f, onTemplate) => {
    const keyed = seen.has(f.name);
    if (!keyed && !f.reqDone) return;
    const vals = seen.get(f.name) || [];
    const counts = new Map(); for (const v of vals) counts.set(v, (counts.get(v) || 0) + 1);
    const mode = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const lastFull = hist.map((h) => h.fields[f.name]).find(nonEmpty) || null;
    const modeFull = mode ? hist.map((h) => h.fields[f.name]).find((v) => nonEmpty(v) && key(v) === mode[0]) : null;
    const kind = fieldKind(f.dataType, f.entry);
    const dated = kind === "date" || kind === "time";
    out.push({
      name: f.name,
      caption: cleanCaption(f.caption, f.name),
      kind,
      options: f.options && f.options.length ? f.options : undefined,
      reqDone: !!f.reqDone,
      onTemplate,
      keyed,
      // Same answer in every completion that answered it.
      // Dates and times are never standard: they are always today's.
      standard: !dated && counts.size === 1 && vals.length === hist.length ? modeFull : null,
      varies: dated || counts.size > 1 || (vals.length > 0 && vals.length < hist.length),
      // Filled in under half the completions: a corrective-action note or
      // similar that only applies when an answer fails.
      conditional: keyed && !f.reqDone && vals.length * 2 < hist.length,
      // Answered in every completion: required before Complete here too.
      always: hist.length > 0 && vals.length === hist.length,
      mode: modeFull,
      last: lastFull,
      seen: [...counts.entries()].map(([v, n]) => ({ v, n })),
    });
  };
  for (const f of templateFields) add(f, true);
  for (const f of extraFields) if (!onTpl.has(f.name)) add(f, false);
  // A shared/off-template field that always equals another answer is a copy the
  // form app writes (FLA-Common.Associate mirrors the inspector's name).
  for (const f of out) {
    if (!f.keyed || !f.varies || !(/common/i.test(f.name) || !f.onTemplate)) continue;
    const src = out.find((g) => g !== f && g.keyed && g.varies && !g.mirrorOf && !/common/i.test(g.name)
      && hist.every((h) => key(h.fields[g.name]) === key(h.fields[f.name])));
    if (src) f.mirrorOf = src.name;
  }
  return out;
}

const pad = (n) => String(n).padStart(2, "0");
// Enviance's client sends dates as local time without a zone.
export function envDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

const YESNO = /^(yes|no|n\/a|na)$/i;

// Starting values for the fill-in form: what is already on the open task,
// else today/now for dates, the usual answer for yes/no questions, the most
// recent value for everything else (names, counts, station locations).
export function defaultValues(form, current = {}, now = new Date()) {
  const vals = {};
  for (const f of form) {
    if (f.mirrorOf) continue;
    const cur = current[f.name];
    if (f.conditional && !nonEmpty(cur)) { vals[f.name] = []; continue; }
    if (nonEmpty(cur)) { vals[f.name] = f.kind === "date" || f.kind === "time" ? [f.kind === "date" ? ymd(now) : hm(now)] : cur; continue; }
    if (f.kind === "date") { vals[f.name] = [ymd(now)]; continue; }
    if (f.kind === "time") { vals[f.name] = [hm(now)]; continue; }
    // Never carry the last inspector forward: it would file today's walk under their name.
    if (isNameField(f)) { vals[f.name] = []; continue; }
    if (f.standard) { vals[f.name] = f.standard; continue; }
    const usual = f.mode && YESNO.test(key(f.mode)) ? f.mode : f.last;
    vals[f.name] = usual || [];
  }
  return vals;
}

// Fields to read off the paper copy: everything that is not standard.
export const toEnter = (form) => form.filter((f) => !f.mirrorOf && !f.standard && !f.conditional);

// The conditional fields that belong to a question (FLA-EW-005-1 → FLA-EW-005-1CA).
export const followUps = (form, name) => form.filter((f) => f.conditional && f.name !== name && f.name.startsWith(name));

// Answers that differ from what this store always answers (a "No" where it
// is always "Yes"). Enviance opens corrective actions / work orders for
// those, so they are finished in Enviance itself, not submitted from here.
export function deviations(form, values) {
  const out = [];
  for (const f of form) {
    if (f.mirrorOf || f.kind !== "select") continue;
    const ref = f.standard || f.mode;
    const v = key(values[f.name]);
    if (ref && YESNO.test(key(ref)) && YESNO.test(v) && v !== key(ref) && !/^n\/?a$/i.test(v)) out.push({ name: f.name, caption: f.caption, usual: key(ref), now: v });
  }
  return out;
}

function toWire(f, values, now) {
  const v = (values || []).filter((x) => x !== null && x !== "");
  if (!v.length) return null;
  if (f.kind === "date") {
    const [y, m, d] = String(v[0]).split(/[-/T]/).map(Number);
    if (!y || !m || !d) return null;
    return [envDate(new Date(y, m - 1, d))];
  }
  if (f.kind === "time") {
    const [h, mi] = String(v[0]).split(":").map(Number);
    if (!Number.isFinite(h)) return null;
    const t = new Date(now); t.setHours(h, mi || 0, 0, 0);
    return [envDate(t)];
  }
  if (f.kind === "bool") return [/^(true|yes|1|on)$/i.test(String(v[0])) ? "True" : "False"];
  return v.map(String);
}

// stepInfo for PATCH …/workflows/{id}/steps/currentstep.
// complete=true adds the "End Workflow" transition (the form's "Complete and
// Close"). Returns { stepInfo, problems } — never submit with problems.
export function buildStepInfo(form, values, { complete = false, now = new Date() } = {}) {
  const fields = [], problems = [];
  const byName = Object.fromEntries(form.map((f) => [f.name, f]));
  for (const f of form) {
    const src = f.mirrorOf ? byName[f.mirrorOf] : f;
    const wire = toWire(src, values[src.name], now);
    if (!wire) {
      // A copy (mirrorOf) is reported through its source field, not twice.
      if (complete && !f.mirrorOf && (f.reqDone || f.always)) problems.push(`"${f.caption}" is empty.`);
      continue;
    }
    if (f.kind === "number" && wire.some((x) => !Number.isFinite(Number(x)))) { problems.push(`"${f.caption}" must be a number.`); continue; }
    if (f.options && (f.kind === "select" || f.kind === "multi") && wire.some((x) => !f.options.includes(x))) { problems.push(`"${f.caption}": "${wire.join(", ")}" is not one of its choices.`); continue; }
    fields.push({ name: f.name, values: wire });
  }
  if (complete) {
    for (const d of deviations(form, values)) problems.push(`"${d.caption}" is ${d.now} (usually ${d.usual}): finish this one in Enviance so the corrective action / work order gets opened.`);
  }
  const stepInfo = { fields };
  // Sent as its own request after the answers (service.js::writeStep), no close
  // date: Enviance stamps it, as with the form's own Complete and Close.
  if (complete) stepInfo.transition = { stepActionName: "End Workflow" };
  return { stepInfo, problems };
}

export const isNameField = (f) => f.kind === "text" && /name of associate|associate (completing|performing)/i.test(f.caption || "");

// The inspector named on a completion (for "who did it").
export function completedBy(form, fields) {
  const f = form.find((x) => !x.mirrorOf && isNameField(x));
  return f ? key(fields?.[f.name]) || null : null;
}
