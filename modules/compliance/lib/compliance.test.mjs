// node --test modules/compliance/lib/compliance.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { learnForm, defaultValues, toEnter, buildStepInfo, deviations, isChildType, fieldKind } from "./forms.js";
import { buildCalendar, cadenceOf, monthlyDueRule, targetFor } from "./schedule.js";

const TPL = [
  { name: "EW-Associate", caption: "Name of Associate Completing Inspection", dataType: "Text", entry: "Text Box", reqDone: true },
  { name: "EW-Loc-1", caption: "Location of eyewash station", dataType: "Text", entry: "Dropdown List", options: ["ACC/TBC", "Maintenance Area"] },
  { name: "EW-005-1", caption: "Are the nozzle caps in place?", dataType: "Text", entry: "Dropdown List", options: ["Yes", "No"] },
  { name: "EW-005-1CA", caption: "Corrective Action", dataType: "Text", entry: "Text Box" },
  { name: "EW-Date", caption: "Date", dataType: "Date/Time", entry: "Date" },
  { name: "EW-Count", caption: "Number inspected", dataType: "Number", entry: "Text Box" },
  { name: "FLA-Common.Associate", caption: "FLA-Common.Associate", dataType: "Text", entry: "Text Box" },
  { name: "EW-Station-6", caption: "never used", dataType: "Text", entry: "Dropdown List", options: ["Yes", "No"] },
];
const h = (who, loc, caps, extra = {}) => ({ fields: { "EW-Associate": [who], "FLA-Common.Associate": [who], "EW-Loc-1": [loc], "EW-005-1": [caps], "EW-Date": ["9/1/2026"], "EW-Count": ["4"], ...extra } });
const HIST = [h("Jason", "ACC/TBC", "Yes"), h("Shane", "Maintenance Area", "Yes"), h("Jason", "ACC/TBC", "No", { "EW-005-1CA": ["work order in"] }), h("Jason", "ACC/TBC", "Yes")];

test("learnForm: keyed fields only, standard vs varies, mirror, conditional", () => {
  const form = learnForm(TPL, [], HIST);
  const by = Object.fromEntries(form.map((f) => [f.name, f]));
  assert.equal(by["EW-Station-6"], undefined);
  assert.deepEqual(by["EW-Count"].standard, ["4"]);
  assert.equal(by["EW-005-1"].varies, true);
  assert.equal(by["EW-005-1CA"].conditional, true);
  assert.equal(by["FLA-Common.Associate"].mirrorOf, "EW-Associate");
  assert.deepEqual(toEnter(form).map((f) => f.name), ["EW-Associate", "EW-Loc-1", "EW-005-1", "EW-Date"]);
});

test("defaultValues + buildStepInfo: dates in Enviance local format, mirror copied, End Workflow", () => {
  const form = learnForm(TPL, [], HIST);
  const now = new Date(2026, 9, 8, 14, 5);
  const vals = defaultValues(form, {}, now);
  assert.deepEqual(vals["EW-005-1"], ["Yes"]);
  assert.deepEqual(vals["EW-005-1CA"], []);
  assert.deepEqual(vals["EW-Associate"], []);            // never carried forward
  assert.match(buildStepInfo(form, vals, { complete: true, now }).problems[0], /Name of Associate.*empty/);
  vals["EW-Associate"] = ["Pat Lee"];
  const { stepInfo, problems } = buildStepInfo(form, vals, { complete: true, now });
  assert.deepEqual(problems, []);
  const f = Object.fromEntries(stepInfo.fields.map((x) => [x.name, x.values]));
  assert.deepEqual(f["EW-Date"], ["2026-10-08T00:00:00"]);
  assert.deepEqual(f["FLA-Common.Associate"], ["Pat Lee"]);
  assert.equal(f["EW-005-1CA"], undefined);
  assert.deepEqual(stepInfo.transition, { stepActionName: "End Workflow" });
});

test("a failing answer blocks Complete but not Save", () => {
  const form = learnForm(TPL, [], HIST);
  const vals = defaultValues(form, {}, new Date(2026, 9, 8));
  vals["EW-Associate"] = ["Pat Lee"];
  vals["EW-005-1"] = ["No"];
  assert.equal(deviations(form, vals).length, 1);
  assert.equal(buildStepInfo(form, vals, { complete: true }).problems.length, 1);
  assert.deepEqual(buildStepInfo(form, vals, { complete: false }).problems, []);
  vals["EW-Loc-1"] = ["Somewhere else"];
  assert.match(buildStepInfo(form, vals).problems[0], /not one of its choices/);
});

test("child types and field kinds", () => {
  assert.equal(isChildType("FLA-Corrective Action"), true);
  assert.equal(isChildType("FLA-MST-Security Tour CA-v2"), true);
  assert.equal(isChildType("FEXCA-FIreExtinguisherCA"), true);
  assert.equal(isChildType("FLA-MST-Security Tour-v2"), false);
  assert.equal(isChildType("SPC-SPCCInspection"), false);
  assert.equal(fieldKind("Date/Time", "Time"), "time");
  assert.equal(fieldKind("Text", "Multi- Selection List Box"), "multi");
  assert.equal(fieldKind("True/False", "Check Box"), "bool");
});

test("schedule: cadence, due rules, 10th-of-month target, projections across DST", () => {
  assert.equal(cadenceOf(["2026-09-24T22:45:00", "2026-10-01T22:45:00", "2026-10-08T22:45:00"]), "weekly");
  assert.deepEqual(monthlyDueRule(["2026-08-31T22:45:00", "2026-09-30T22:45:00", "2026-10-31T22:45:00"]), { last: true, h: 22, m: 45 });
  assert.deepEqual(monthlyDueRule(["2026-08-30T22:45:00", "2026-09-30T22:45:00", "2026-10-30T22:45:00"]), { day: 30, h: 22, m: 45 });
  assert.equal(targetFor("2026-10-30T22:45:00", "monthly").getDate(), 10);
  assert.equal(targetFor("2026-10-10T22:45:00", "monthly").getHours(), 22);
  const now = new Date(2026, 9, 8, 12);
  const tasks = [
    { id: "a", type: "EW", name: "Weekly Eyewash", due: "2026-10-01T22:45:00", closed: "2026-10-01T09:00:00", isopen: false },
    { id: "b", type: "EW", name: "Weekly Eyewash", due: "2026-10-08T22:45:00", isopen: true },
    { id: "c", type: "FX", name: "Monthly Fire Ext", due: "2026-09-30T22:45:00", closed: "2026-09-29T10:00:00", isopen: false },
    { id: "d", type: "FX", name: "Monthly Fire Ext", due: "2026-10-30T22:45:00", isopen: true },
  ];
  const cal = buildCalendar(tasks, { now, until: new Date(2026, 10, 30, 23, 59) });
  const d = cal.find((t) => t.id === "d");
  assert.equal(d.status, "open");
  assert.equal(d.target.slice(0, 10), "2026-10-10");
  assert.equal(cal.find((t) => t.id === "c").metTarget, false);
  const nov5 = cal.find((t) => t.projected && t.due.startsWith("2026-11-05"));
  assert.equal(nov5.due, "2026-11-05T22:45:00");
  assert.ok(cal.some((t) => t.projected && t.type === "FX" && t.due.startsWith("2026-11-30")));
  // after the 10th the open monthly task shows as past target
  const later = buildCalendar(tasks, { now: new Date(2026, 9, 12) });
  assert.equal(later.find((t) => t.id === "d").status, "pastTarget");
});
