# Enviance (Cority) compliance tasks — findings

Probed 2026-10-08 over the debug Edge. Used by `modules/compliance` (calendar,
paper copy, fill/submit) and `modules/livedashboard/lib/sources/compliance.js`
(task count widget).

## Where things are

- Portal: `https://go.enviance.com/CustomApp/ddde6520-3955-4d83-b0ab-78f6e5cbaf10/index.html?SystemID=774d2e17-a8fc-409f-9480-e3fa9310c1c5#/page/9108fa2b-…`
  ("All Open Facility Tasks" + one panel per assessment type). Its open-task
  panel **excludes overdue tasks** — 1458 had seven forgotten open tasks
  (three 2022 SPCCs, 2025 safety/security/lights, a Jan-2026 extinguisher).
- Each task opens its own Workflow App Builder form:
  `https://go.enviance.com/goto/<SystemID>/<App>/?hash=/search/<UniqueID>/<StepName>`.
  Type → app map comes from the PortalService dashboard's `linkRoutes`
  (`customTypeKey`); copied into `modules/compliance/lib/forms.js::FORM_APPS`.

## Read: EQL

`POST /CustomApp/<pkg>/app/core/query-builder/query-template.eqlx?name=<anything>`
body `eqlQueryParam={"parameters":{"eqlQuery":"…"},"page":1,"pageSize":1000}`
runs **any** EQL SELECT with the user's rights. `dev/env-eql.mjs <file>` runs one.

- `pageSize` > 1000 → bare `400 Internal error.` (cost an hour).
- Valid on `WorkflowInstance wfi`: `ID, Name, UniqueID, DueDate, Created,
  CloseDate, LastRun, PrimaryStatus` (true = open), `IsOverdue`,
  `SinglePoi.Name` (`'Facility 01458'`). **Not** valid: `Closed`, `ParentID`
  in the select list, `CurrentStep`. Joins: `JOIN WorkflowStep wfs ON wfi`,
  `JOIN WorkflowType wft ON wfi` (`wft.Name`, `wft.Version`).
- `localtime(x, 4)` / `toUtc('YYYY-MM-DD HH:mm', 4)` as the portal does.
- Form fields: `FormTemplate ft` → `ft.CustomField.ID/Name/[Order]`,
  `ft.CustomField.Validation.RequiredOnTransition`. Captions/options:
  `CustomField cf` → `Caption.Invariant`, `DataType`, `ValueEntryMethod`,
  `ListItem.Text.Invariant` (see `modules/compliance/service.js`).
  The REST FormTemplate/CustomField services answer 403 for store users.

## Read/write: REST ver2

Session: `GET /Packages/Api/BootStrap.svc/2?packageId=<pkg>` → `sessionId`,
`apiUrl` (`https://api.enviance.com`). Header `Authorization: Enviance <sessionId>`.

- `GET ver2/WorkflowTypeService.svc/workflowtype/{name}/version/{n}` → steps + form template.
- `POST ver2/WorkflowService.svc/workflows/steps` `{workflowStepMaps:[{workflowIdOrUniqueId, stepIdsOrNames:null}]}`
  → every keyed-in value per task (this is how past submissions are read).
- `PATCH ver2/WorkflowService.svc/workflows/{id}/steps/currentstep`
  `{stepInfo:{fields:[{name, values:[…]}], transition?:{stepActionName:"End Workflow", closeDate}}}`
  — the form's Save (no transition) / "Complete and Close" (End Workflow).
  PUT/POST → 405 (verb probed against a nonexistent id, nothing written).
  Dates go as local `YYYY-MM-DDTHH:mm:ss` (client's `IsoDate.toLocalString`).
  `Reopen Workflow` is the predefined undo transition.

## Gotchas

- Clicking the form's own Save with required fields empty raises a JS alert
  that hangs the tab for CDP (even `Page.enable`); close it via `/json/close/<id>`.
  Nothing was written (`lastRun` stays `1753-01-01`).
- `FLA-Common.Associate` is written by the form app as a copy of the
  inspector-name field; payloads must include it.
- Weekly eyewash / hazwaste are due Thursdays (22:45 / 23:45); monthly SPCC
  on the 10th, fire extinguisher + emergency lights on the 30th, safety
  assessment + AP security tour on the last day. OSHA 300 Log tasks stopped
  after Feb 2026. Enviance creates each task only days before it is due.
- Borrowing the session does not need the portal: a hidden tab on
  `/CustomApp/<pkg>/package.cfg` (1 KB JSON) runs BootStrap + EQL + REST fine.
  Cold pull via the extension: 6.4 s (portal tab: ~16 s, 60+ s in normal Edge).
  Signed out, BootStrap answers 200 with no `sessionId`; only then is the tab
  sent to the portal so its app runs the SSO bounce.
- Never borrow the user's Enviance tab: a background portal tab Edge has put
  to sleep (reproduced with `Page.setWebLifecycleState frozen`) makes
  executeScript hang until timeout — the "stuck loading" in the user's normal
  Edge. The module now always opens its own light tab. Measured 2026-10-08 in
  debug Edge: warm 5–7 s, first load (learning forms) 7.9 s, signed-out
  (cookies wiped → SSO) 16 s; status line names the current step.
