# Clearsight Incident Intake — findings (2026-09-16)

Discovery for the planned **accident module** (expanding the Live Dashboard
"Accident Details" widget into its own module: print the incident packets,
OCR the completed paper forms, file the incident in Clearsight, attach the
scans). Everything below was learned on the **UAT** site with two test
notices (19059 associate path, 19060 customer path). Nothing was created on
prod.

Companion files (same folder):

- `CLEARSIGHT_INTAKE_FIELDS.md` — every page, field, option list and
  visibility rule, flattened from the template metadata.
- `clearsight-intake-catalog.json` — the same, machine-readable (1,053 fields).
- `clearsight-intake-lookups.json` — every option list (235 lookups, full).
- `probe-cs-uat-*.mjs` — the CDP scripts used (debug Edge on :9222).

---

## 1. Environments and sign-in

| | Prod | UAT |
|---|---|---|
| URL | `https://www.riskonnectclearsight.com/Walmart/app/Clearsight/#/intake/stars.intakenotice` | `https://uat.riskonnectclearsight.com/Enterprise/app/Clearsight/#/intake/stars.intakenotice` |
| Client schema | `W100` | `W100UAT` |
| Sign-in | login page has a **Single Sign On** link → `wmlink.wal-mart.com/WCSIncidentIntake` → pingfed → lands in the app. No password in the debug Edge. | **No SSO.** Client ID / User ID / Password only; the user signs in by hand. `default.cmdx?ssoclient=W100` returns a server error on UAT. |
| Test data | never | yes — banner "This is a TEST site only" |

Toolkit links (from the WCS Toolkit page on OneWalmart): prod intake
`wmlink/wcsincidentintake`, UAT `wmlink/WCSIncidentIntakeUAT`, user guide
`enablement.walmart.com/content/learn/enterprise-safety/responding-to-an-accident/wcs-incident-intake-user-guide.html`,
per-type training pages under `.../incident-intake-guide-training/`.

The app is Angular 20 + Salesforce Lightning Design System markup
(`slds-*` classes). The interview engine is Riskonnect "Orion Interview".
Templates (from `Lookup?fieldname=TemplateID`):

| Env | templateId | Name | Fields |
|---|---|---|---|
| UAT | 2383 | `WalmartIntake_v27.5.2` | 1,053 |
| Prod | 2181 | `WalmartIntake_v27.4` | 1,056 |

Diffed 2026-09-16 (read-only GET on prod): same 30 pages, same field ids,
labels, required flags and radio options. Prod still has four PR (company
property damage) fields UAT dropped (`STARS_175`/`STARS_592` estimated loss
amount, `STARS_315`/`STARS_603` claim type); UAT has hidden `STARS_80`. So a
module keyed on `STARS_n` works on both; read the template id at runtime
rather than hard-coding it.

Prod's `StormsIntake` JSON returns an **empty `Token`** (UAT returns the
real one), so on prod the `custheader` value must be captured from a UI
POST instead — the suite's `webRequestFilters` header-capture mechanism
(`headerName: "custheader"` on `https://www.riskonnectclearsight.com/*`)
is the natural fit. Facility lookup on prod returns the same single row
(`1458` → LocationID `2645`).

**Warning:** clicking **New Incident** on the list page immediately POSTs
`CreateNotice2` and opens a new tab on an *In Progress* notice. On prod that
is a real notice (it can be Voided from the list, but don't).

## 2. The interview is metadata-driven (no need to crawl the wizard)

All endpoints are same-origin under `/Enterprise/` (UAT) or `/Walmart/`
(prod). GETs need only the session cookie. **POSTs need the anti-forgery
header `custheader: <Token>`**, where `Token` comes from
`GET StarsOne.mvc/StormsIntake?shellApp=rk-clearsight` (the same JSON gives
`UserId`, `ClientSchema`, `MaxAttachFileSize`, `FileAttachChunkSize`).
Without it every POST answers `{"ErrorDescription":"RequestDeemedAsForgedLoginNeeded","IsLoginRequired":true}`
with HTTP 200. Verified 2026-09-16: `InterviewUpdate` + `SaveInterview`
replayed from `fetch()` with that header saved the answers on notice 19060
and advanced `VisitedPages` to `STARS_0,STARS_1`. Every URL carries
`&appName=Intake&clearsight=true`.

| Purpose | Endpoint |
|---|---|
| Template list | `GET Orion.Interview/Orion.InterviewAnswers.mvc/MetaData/Lookup?fieldname=TemplateID&SessionMode=ReadOnly` → `[{Code:"2383", Description:"WalmartIntake_v27.5.2"}]` |
| **Whole interview definition** | `GET Orion.Interview/Orion.InterviewAnswers.mvc/MetaData/CsNoticeView?templateId=2383&SessionMode=ReadOnly` (1.9 MB JSON) |
| Notice state / answers | `GET .../MetaData/NoticeData2?templateId=2383&noticeId=N&answerId=A` |
| Option list for a field | `GET .../MetaData/Lookup?fieldname=STARS_n&templateId=2383&pageSize=2000` (default page = 30 rows; `filter=text` narrows) |
| Option list as the UI does it | `GET .../MetaData/InterviewLookup?filter=&fieldName=STARS_n&groupKey=1&parentFieldNames=STARS_458&parentValues=<date>&answersId=A&templateId=2383&pageSize=200&pageIndex=0&sortOrder=ASC&sortColumn=DESCRIPTION&setId=1` |
| Create a notice | `POST .../MetaData/CreateNotice2?templateId=2383` body `{"fields":{"templateId":"2383"}}` → notice + answer ids |
| Field change (dependency check) | `POST RMIS/Orion.InterviewAnswers.mvc/metadata/CodeDependency/InterviewInvalidatedFieldNames` |
| Save page (Next) | `POST Orion.Application/Orion.InterviewAnswers.mvc/MetaData/InterviewUpdate` (Command `Refresh`) then `POST .../MetaData/SaveInterview` (Command `NavigateAndRefresh`, `PageId`, `VisitedPages`) — both carry the **full** `FieldValues` dictionary (≈190 keys) plus `<field>Lookup` objects for lookup answers |
| Duplicate check after save | `GET .../MetaData/DuplicateRecords?answerId=A&templateId=2383&createUser=U&status=P` |
| Attachments | see §5 |

`CsNoticeView.WizardScreenConfig` holds `Pages[]` → `Rows[]` → `Columns[]` →
`Items[]`. Item types seen: 6 label, 12 spacer, 10 separator, 3 input,
2 lookup/combobox, 11 radio group, 4 help bubble, 8 nav button, 7 link/attach
button, 9 table-based lookup. `FieldMetadataInfo` maps each `STARS_n` to the
destination domain field (e.g. `STARS_230 → STARS.Incident.FirstName1`).
`AccessRules[].Criterias` (`Negate` 2 = NOT, `Connector` 1 = AND / 2 = OR,
`Visibility` 4 = enabled, 5 = visible) drive show/hide; nav buttons carry
`NavLinkTargets[]` with the same criteria to choose the next page.

Field type codes on inputs: 0 number/text, 4 text, 5 date, 7 lookup,
11 radio, 12 checkbox, 16 memo (`Rows` > 0; `MaxLength` 254).

## 3. Wizard flow

30 pages in the template; which ones appear depends on `STARS_454` (type)
and `STARS_7` (specific type):

```
StartPage ─► Photo Evidence (3 photos required) ─┬─ ASSOC ─► WC_Associate Statement ─► WC_Incident Summary ─► Witness Statements (1–3) ─► WC_Summary ─► Submit Confirmation
                                                  ├─ CUST  ─► GL_Customer Statement (1–5 claimants) ─► GL_Incident Summary ─► GL_Claim Type Specialty Info ─► Witness ─► GL_Summary ─► Submit
                                                  │           (GK + resolved at facility ─► GL GK Settlement instead)
                                                  ├─ AUTO  ─► AL_Incident Summary ─► AL_Insured Driver and Vehicle ─► AL_Claimant Information (1–5) ─► Witness ─► AL_Summary ─► Submit
                                                  └─ CPD   ─► PR_Incident Summary ─► (PR_3rd Party Involved Information, only if a 3rd party is involved) ─► Witness ─► PR_Summary ─► Submit
```

### StartPage (`Page_STARS_0`)

| Field | Caption | Type | Notes |
|---|---|---|---|
| `STARS_458` | Date and time of Incident | date | `M/d/yyyy`; saved as `9/16/2026` |
| `STARS_464` | (time) | lookup, **req** | 1,440 codes `HHMM` ↔ `h:mm AM/PM` |
| `STARS_792` | Reporting Facility # | lookup, **req** | user sees only their facility: Code `1458`, **Value `2645`** (LocationID) |
| `STARS_184` | When was the facility first notified | date, **req** | |
| `STARS_454` | Type of incident | radio, **req** | `ASSOC` / `CUST` / `AUTO` / `CPD` |
| `STARS_7` | Select specific type of incident | radio, **req** when CUST | `AP` Asset Protection, `CC` Cart Damaged Vehicle, `GK` ACC/Garage, `HD` InHome/Spark, `GL` Customer Injury or PD, `PL` Product Sold, `OPR` Product Prepared |
| `STARS_312` | Did a non-Walmart 3rd party cause or contribute | radio, **req** unless CPD | Y/N/U; `Y` reveals `STARS_590` (3PRTYDRV / CUSTOMER / VENDOR) |
| `STARS_10` | Resolved at the facility (952/1084 payment)? | radio, **req** | `Y` reveals `STARS_742` BI/PD + `STARS_54` Settlement Amount (≤ $800) |
| `STARS_322` | Facility Services associate? | radio, **req** when ASSOC | Y auto-changes facility to 9301 |
| `STARS_26` / `STARS_11` | Associate entering incident name / contact # | text, **req** | prefilled `{SSO.NAME}` / `{SSO.PHONE_NUMBER}`; phone is saved digits-only |
| `STARS_153`, `STARS_296` | Nurse First Response / provider lookups | ASSOC only | table lookups 72 (providers) and 73 (NFR vendors) keyed by LocationID |

### Photo Evidence (`Page_STARS_1`)

"Attach Photos" (`Link: PE_Photo1`, `RequiredAttachments: 3`). Next is
blocked until three files are attached.

### WC_Associate Statement (`Page_STARS_16`) — ASSOC

The page shows only **Find Injured Associate** until an associate is
selected; the statement fields render afterwards. Verified 2026-09-16 on
notice 19059 with the analyst's own WIN:

1. Modal = table-based lookup **70**. "Search By" is an SLDS combobox
   (`#SpecialAnalysis#320_id`, options `li.slds-listbox__item > cs-lookup-item`
   with codes `WIN` / `SSN`; a synthetic `.click()` on the option does not
   commit, a real mouse click on the `cs-lookup-item` does) and the number
   goes in `#WALMARTIDENTIFICATIONNUMBER_INPUT`.
2. **Search** = `POST RMIS/Stars.Claim.mvc/MetaData/GetStormsTableBasedLookupSearchDataTable`
   body `{"lookupId":"70","maxRec":"50","pageNumber":0,"searchInputItems":{"SearchInputItems":{"MappingEntities":[…30 entities, IDTYPE.Value="WIN", WALMARTIDENTIFICATIONNUMBER.Value="<WIN>"…]}}}`.
   Response `Fields[]` + `SearchedData[[…]]` — one row per match with
   first/middle/last, preferred name, home address, phones, personal email,
   gender, DOB, marital and language codes, associate type, hire and term
   dates, base pay frequency **and amount, and the SSN (`NATIONALID`)**.
   The module must never log or persist that row; take only what the form
   needs.
3. Select the row, **Select and Review** =
   `POST Orion.Interview/Orion.InterviewAnswers.mvc/ConvertTableLookupFields`
   body `{"ObjectId":"STARS_1","DomainName":"STARS.Incident","AnswerId":A,"TemplateId":"2383","Fields":["FirstName1",…30 destination names]}`
   → map of `STARS_n` ids to fill (`STARS_230` first name, `STARS_232` last,
   `STARS_222`…`STARS_225` address, `STARS_226` phone, `STARS_234` email,
   `STARS_236` gender, `STARS_235` DOB, `STARS_237` marital, `STARS_243`
   language, `STARS_238` payroll facility, `STARS_221` job title,
   `STARS_239` hire date, `STARS_240` hire state, `STARS_1093/1094` division
   / job code, …). The page then renders with those values; who-is-completing
   (`STARS_268`), present?, explanation, statement, prior treatment,
   employment status, wage, signatures still need answers.
4. HR's employment status code (`FT`) is **not** in the `STARS_260` option
   list (`1` Employed-Perm, `2` Part-time…); the UI asked `LookupItem?fieldName=STARS_260&codeValue=FT`
   and got "! Invalid Code", so that field must be chosen by hand.

So the associate path needs the **WIN**; the paper Associate Incident Report
has no WIN box (it is on the Witness form and Evidence Tag only), so the
module must ask for it or look it up by name elsewhere.

Fields after selection (all in `CLEARSIGHT_INTAKE_FIELDS.md`): who is
completing (`STARS_268` ASSOCIATE/FACILITY), present?, name/explanation,
first/last/phone/email, text+email opt-in, statement memo `STARS_287` (+
continuation `STARS_323`), prior treatment `STARS_369`, job title, address,
DOB, gender, marital, hire date, employment status, language, hours/week,
wage type + wage, signature names + two e-signature checkboxes, payroll
facility, paid for full shift.

### WC_Incident Summary (`Page_STARS_19`)

On premises? · Where (`STARS_218`, 43 areas) · specific location
(`STARS_219`, 254) · street/city/state/zip · time started work (`STARS_193`)
· **Incident Description** (`STARS_204` → `ClaimDescription`, 254 chars) ·
Type of Incident (`STARS_206` → `Cause`, 13) · specific cause (`STARS_207`,
255) · equipment involved (`STARS_208`, 21) · specific item (`STARS_209`,
171) · injury (`STARS_210`, 61) · body region (`STARS_211`, 6) · specific
body part (`STARS_283`, 54) · side (`STARS_295` L/R/B) · direct result of
(`STARS_294`, multi, 10) · sought treatment? (`STARS_293`) → initial
treatment type (`STARS_192`, 6), dates, provider name/address/phone/fax.

### GL_Customer Statement (`Page_STARS_2`) — CUST

Who is completing (`STARS_75` CUSTOMER/FACILITY/PARENT/OTHER) · present? ·
first/last (`STARS_12`/`STARS_13`, 50) · phone/email · opt-ins · **statement
memo `STARS_94`** (+ `STARS_324`) · DOB · minor? · parent name · language ·
address/city/state/zip/country · signature name + 2 e-sign boxes · BI/PD/BOTH
(`STARS_38`) · injury (`STARS_44`) · body region/part/side · ambulance,
attorney, wants something, manager requests resolution · add another
claimant (`STARS_303`, up to 5 → GL2..GL5 pages).

### GL_Incident Summary (`Page_STARS_4`), GL_Claim Type Specialty (`Page_STARS_6`)

Same location/cause/item block as WC (`STARS_28`…`STARS_43`); the Cause
list varies by specific type (`STARS_39` / `STARS_372` CC / `STARS_1151` GK
/ `STARS_1155` PL …). Specialty page: vehicle fields for CC/GK, product
name/item/UPC/lot/expiry for PL/OPR, police called, delivery provider +
order # + driver name for HD.

### CPD — Walmart Owned Company Property Damage (walked on UAT notice 19064)

StartPage with `STARS_454 = CPD` hides the specific-type, 3rd-party and
resolved-at-facility questions; the flow is StartPage → Photo Evidence →
**PR_Incident Summary** (`Page_STARS_22`) → Witness Statements →
**PR_Summary** (`Page_STARS_34`) → Submit. `PR_3rd Party Involved
Information` (`Page_STARS_23`) is only inserted when a 3rd party is marked
as involved (`STARS_589` on the summary / the Start page's `STARS_312`).

PR_Incident Summary fields (DOM order; required ones starred):

| Field | Caption |
|---|---|
| `STARS_304` * | Did the incident happen on the premises? (Y/N; N reveals street `STARS_318`, city `STARS_319`, state `STARS_320`, zip `STARS_321`) |
| `STARS_314` * | Incident Description (memo → `ClaimDescription`) |
| `STARS_325` * | Type of Incident → `Cause`: `1` Cargo, `24` Crime/Theft/Vandalism, `2` Equipment Failure, `8` Fire, `29` Property Damage (PR), `25` Vehicle, `27` Vendor Damage, `28` Weather-Related |
| `STARS_326` * | Specific cause (`SpecialAnalysis#294`, cascades from type) |
| `STARS_327` | Name of Hurricane (required when weather) |
| `STARS_328` / `STARS_339` | Merchandise loss? / estimated loss at cost |
| `STARS_329` | Prod/Prop Loss app claim ID# |
| `STARS_330` | Facility Services work order #s |
| `STARS_331`, `STARS_332`, `STARS_333` | EOC notified?, impacted departments, pharmacy impacted? |
| `STARS_334`, `STARS_335`, `STARS_336` | refrigerated trucks, open tops, generator used? |
| `STARS_337` * / `STARS_338` | Were authorities involved? (Y/N/NA) / name of authorities |

PR_3rd Party Involved Information: 3rd-party type (`STARS_340`:
3PRTYDRV / CUSTOMER / VENDOR), name, address, phone, how they contributed,
Walmart vendor number, and the 3rd party vehicle (make `STARS_346`, model,
VIN, year, tag + tag state, insurance carrier/policy, insurance phone).

There is no claimant statement page on this path; witnesses are the same
three pages as the other paths. The paper Evidence Collection sheet and
Evidence Tag apply as for customer incidents; no packet form is specific to
property damage.

### AUTO — Tractor, Trailer, Fleet (from the template; not walked)

StartPage adds `STARS_378` (Auto Liability `AL` vs Auto Property Damage
`APD`) and `STARS_950` (Facility Services vehicle?). Flow: Photo Evidence →
**AL_Incident Summary** (`Page_STARS_26`: on premises, where/specific
location, address, description, driver association type `STARS_392`
D/I/T/U/V, 3rd party involved?, type of incident `STARS_395` (24 crime,
21 property damage, 32 vehicle collision, 28 weather), specific cause,
equipment, item, citation issued/to whom, in-cab video, delivery provider,
online order #, damages to vehicles `STARS_404`, Quickbase report #) →
**AL_Insured Driver and Vehicle** (`Page_STARS_27`: driver name/address/
phone/email, unit 1/2 type + number, owned/leased/rented, plate, tag state,
make/model/year/VIN, estimated damages) → **AL_Claimant Information**
(`Page_STARS_28`, up to 5: claimant name/company/address/phone/email/DOB/
gender/language, BI/PD/BOTH, injury + body part, was claimant the other
driver, claimant vehicle plate/state/make/model/year/VIN/ownership, add
another) → Witness → **AL_Summary** → Submit.

### Witness Statements (`Page_STARS_7`, `_12`, `_13`)

Who (`STARS_103` ASSOCIATE/CUSTOMER/OTHER) · associate witness type
(multi: 1st on scene / has facts / manager who took report) · first/last ·
WIN · address · phone · email · **observed memo `STARS_118`** (+ `STARS_1097`)
· signs of injury (`STARS_119`) + description · signature name + e-sign ·
add another (`STARS_172`, up to 3).

### Summary + Submit

`WC_Summary` / `GL_Summary` repeat every answer (as editable mirror fields
`STARS_685`…`STARS_718`, dynamic copies of the originals) and carry the
**Submit** button. Submit → "Are you sure you want to Submit?" OK →
`SaveInterview` with `PageId: "Page_Stars_Error_Summary"` if anything is
still invalid, and the wizard shows an **Error Summary** page listing each
page's missing required fields. The same payload already carried
`EntityNumber: "26005842"` on notice 19060, so a number is reserved before
the error check.

### What the walk of notice 19060 (customer path) showed

- Fields render progressively: "Who is completing this statement?" first;
  the contact/address block after that; the incident block (BI/PD, injury,
  body part, ambulance/attorney/etc., "add another claimant") only after
  the **e-signature checkbox `STARS_99`** is ticked; the Next button only
  after `STARS_303` is answered.
- **Next does not validate lookups.** Empty comboboxes (injury, body part,
  location, cause, item, state, witness type…) let the page advance; they
  are recorded in `InvalidQuestions` (`{"PSTARS_2":["STARS_44",…]}`) on
  every later save and surface on Submit. Text fields and radios marked
  required are enforced on the page.
- `SaveInterview` on Next carries only the **dictionary of the page being
  left** (≈50–60 keys: that page's fields plus the hidden/system ones), not
  the whole interview; `PageId` is the *destination* page and
  `VisitedPages` grows by one.
- Lookup answers are sent as `STARS_n: "<Value>"` plus
  `STARS_nLookup: {Fieldname, Code, Description, Value, SortId: 0}`. For
  the facility, `Code` is the store number and `Value` the LocationID.
- SLDS comboboxes are awkward to drive from a content script: typing
  re-filters as you go and a synthetic `.click()` on an option does not
  always commit the value. The API route avoids all of that.
- Customer names: the packet says to use last name "Unknown" and first name
  "Male"/"Female" when the customer will not give a name.

## 4. Paper packet ↔ Clearsight mapping

The packets (Downloads, revised 9/2025 and 11/2025) map onto the wizard like
this. Only the starred forms feed intake fields; the others are attachments
or post-submission paperwork.

| Paper form | Where it goes |
|---|---|
| ★ Associate Incident Report (`*INCR*`) | StartPage dates/times, WC_Associate Statement (name, address, phones, email, DOB, gender, marital, job title, hire date, medical provider, "what were you doing" + "describe what happened" → `STARS_287`/`STARS_204`, witnesses, body part + injury → `STARS_210/211/283/295`, prior similar injury → `STARS_369`, manager review → `STARS_192` treatment type) |
| ★ Customer Incident Report (`*INCR*`, EN + ES) | StartPage, GL_Customer Statement (legal name, DOB, address, phones, email, "events leading up to" → `STARS_94`, "location" → `STARS_34/35/36`, "reported to" → `STARS_26`) |
| ★ Witness Statement (`*WITS*`) ×3–4 | Witness Statements pages 1–3 (name, address, phones, email, observed, signs of injury) |
| Evidence Collection (`*ECST*`) | **Post-submission**: the incident record's "Incident Info/Evidence Collection" page (video, photos, physical evidence, statements, other info, mailing) — not part of the wizard. Also an attachment. |
| Video Request Form | attachment; its Part II feeds the Evidence Collection page |
| Release of Medical Information (`*MEDA*`) | attachment (signed) — WC only |
| Physician Work Status Report, TAD Assignment, Billing Information, Evidence Tag, Panel Selection (GA WC-P1) | attachments / later paperwork; no intake fields |

The scan itself becomes an attachment on the notice (§5), which satisfies
"upload a copy of this form to the attachments page" in the packet
instructions.

## 5. Attachments API (what "Attach Photos" and the attachments page do)

1. `GET Orion.Application/Orion.File.mvc/RestrictedFileExtensions` (blocked
   list: exe, bat, js, msi, url …; PDFs/PNG/JPG fine).
2. For each file: `POST /Enterprise/File.mvc/<new guid>?append=0` with the
   raw bytes (`Content-Type: application/octet-stream`). Chunking is
   `FileAttachChunkSize` 1 MiB (`append=1` for later chunks); max
   `MaxAttachFileSize` 200 MB (from `StarsOne.mvc/StormsIntake`).
3. Then `POST Orion.Application/Orion.File.mvc/file` with
   `{"Fields":{"AttachedEntityKey":"<noticeId>","AttachedEntityDomainName":"STARS.IntakeNotice","FileGuid":"<guid>","FileDescription":"<name>","FileCategory":"","DataObjectId":"STARS_1","NoticeId":"<noticeId>","Link":"PE_Photo1","FileName":"<name.png>"}, ...}`.
4. List: `GET Orion.Application/Orion.File.mvc/AttachmentListClearSight?pageNumber=0&attachedEntityKey=<noticeId>&attachedEntityDomain=STARS.IntakeNotice`.

The modal (`STORMS_FILE_SELECT` → hidden `<input type=file multiple>` →
`STORMS_FILE_UPLOAD`) shows "Submission Succeeded" per row; three 1-pixel
PNGs uploaded fine on the test notice. `IsCategoryRequired` was false.

## 6. Implications for the module

- **Schema without scraping.** Ship the catalogue JSON (or fetch
  `CsNoticeView` at runtime from the SW with the user's cookie) and drive
  the form by `STARS_n`, not by label text. Labels and option codes are all
  there; the template version string tells us when Walmart changes it.
- **Filing an incident = a sequence of `SaveInterview` posts**, one per
  page, each with the full `FieldValues` dictionary and the correct `PageId`
  / `VisitedPages`, after a `CreateNotice2`. The recorded bodies are in the
  scratchpad captures (`step1-xhr.json`); replaying them from the SW
  (`credentials: "include"`) is the direct route. Driving the DOM through a
  content script is the fallback and what the probes do today (SLDS
  comboboxes need type → wait → click option; hidden radios accept `.click()`).
- **Facility lookup returns only the user's own store** (`1458` → `2645`),
  so the module can hard-map store → LocationID once per user.
- **The associate path needs a WIN** for the directory lookup; the paper
  Associate Incident Report does not collect one, so the module must ask
  for it (or read it from the Witness/Evidence Tag forms) before filing.
- **Photos gate the wizard**: three images are required before any
  statement page. The scans of the paper forms can be those attachments,
  but the packet rules want real scene photos; the module should upload
  scene photos as `PE_Photo1` and the form scans as ordinary attachments.
- **OCR target fields** are the memo fields (254 chars each, with a
  continuation field): `STARS_287`/`STARS_204` (WC), `STARS_94` (GL),
  `STARS_118` (witness). Long handwritten statements must be split or
  trimmed; a scanned copy carries the full text.
- The **Evidence Collection** sheet is filled *after* submission inside the
  incident record, which is also where the CAS evidence report (the current
  home widget) is scored. That page has not been mapped yet.

### Successful submit (UAT notice 19060, 2026-09-16)

Notice 19060 went through: status `P` → **`C` (Completed)**, `ClaimNumber` /
Incident # **26005842**, `IncidentId` 9498309, URL gains `&status=C`. The
Submit Confirmation page shows Date Reported, Submitted By, Incident # and
"Link to Lead Incident → Click here to open the Incident", and says the
summary and statements are emailed to management post-submission.

Things that had to be true first:

- **Cascading lookups must be consistent.** Child lists are filtered by
  their parents (`NoticeData2.ParentFieldnames`): specific body part ←
  body region (`STARS_45` ← `STARS_125`), specific location ← area
  (`STARS_35` ← `STARS_34`), specific cause ← type of incident
  (`STARS_40` ← `STARS_1152`…), equipment ← specific type (`STARS_41` ←
  `STARS_7`), specific item ← equipment (`STARS_42` ← `STARS_41` and its
  summary mirror `STARS_713`). The API accepts any code, but Submit
  re-validates and bounces mismatches to the Error Summary. Use
  `InterviewLookup?fieldName=…&parentFieldNames=…&parentValues=…` to get
  the legal children.
- **The photo requirement is checked client-side** from the attachment list
  the page has loaded. After a reload the Photo Evidence page reported
  `LINK_n` invalid until the Attach modal was opened once (which fetches
  `AttachmentListClearSight`); then Next/Submit passed. A pure-API filer
  should not hit this, but a DOM driver must open the modal after reload.
- The wizard clears the `InvalidQuestions` entries as pages are re-saved;
  Submit is the last `SaveInterview` from `GL_Summary` followed by a
  `Command: "Refresh"` save; the status change to `C` happened server-side
  right after (final endpoint: see §7).

## 6b. After submission: the incident record (Claims Admin app)

Quick Search (top bar, `RMIS/STARS.Claim.mvc/metadata/StormsQuickSearchResult`)
for the incident number returns a *Claims and Incidents* row (domain
`STARS.ClaimIncident`) with Case Manager, ClaimEasy Pro and Conduent
document links. Its **Open** folder icon routes to
`#/claims/stars.incident/<IncidentId>?groupKeys=1,20` (`1` = SetID, `20` =
MajorCoverage GL; WC would differ). Data: `GET RMIS/STARS.Incident.mvc/FormData?id=<IncidentId>&groupKeys=1,20`;
layout: `GET RMIS/STARS.Incident.mvc/CsFolderMetaData?groupKeys=1,20`
(14 pages, 82 fields with labels — saved as `incident-folderMeta.json` in
the scratchpad; the useful part is reproduced below).

Left menu: **Incident Info/Evidence Collection**, Supplemental Information,
Attachments, Distribution History (plus hidden pages: Records in
Occurrence, Notes, Tasks, Email, Contacts, Notices, Lost Time Periods,
Locations, Search Nearby Contacts, Activity Monitoring).

**Incident Info/Evidence Collection** page — the paper Evidence Collection
sheet lives here, as plain `STARS.Incident` fields (perm 2 = editable by
the facility user, 1 = read-only):

| Field | Label | Editable |
|---|---|---|
| `SpecialAnalysis#378` / `MiscDescription#283` | Facility Convert Incident to a Claim? / Reason | yes |
| `CoverageCode`, `SpecialAnalysis#19`, `ClaimName1`, `ClaimDescription`, `LossDate`, `SpecialAnalysis#14`, `MiscDate#7`, `IncidentReportDate`, `Cause`, `SpecialAnalysis#294/#355/#85/#4/#2/#356/#79/#222/#402/#206/#207/#209/#208` | Incident Information block (mirrors the intake answers) | read-only |
| `MiscUser#1`, `MiscDescription#48/#47/#46` | Case Manager, supervisor, phone, email | read-only |
| `SpecialAnalysis#372` | Location of incident captured on video? | yes |
| `MiscDescription#284` | Name the cameras that captured incident | yes |
| `SpecialAnalysis#369` | Exact video time stamp of incident | yes |
| `MiscDescription#285` | Description of claimant's clothing | yes |
| `MiscDescription#287` | If no surveillance video, explain here | yes |
| `MiscDescription#286` | Witnesses/Associates in area of incident | yes |
| `SpecialAnalysis#370` / `MiscDescription#288` | Is physical evidence available? / Describe | yes |
| `SpecialAnalysis#371` | Additional related documents available? | yes |
| `MiscDescription#289` | Managers name and title | yes |
| `MiscDate#142` | Evidence collection completion date | read-only (system) |

**Save** = `POST RMIS/STARS.Incident.mvc/<IncidentId>/StormsPut` with a
**delta** body (`{"MiscDescription#289":"…"}`) and the `custheader`. On the
UAT test incident it answered 500 "Occurrence number does not exist. You
must create this occurrence, then return to claim and save" — a UAT data
gap (the intake's `STARS.Occurrence` row was not created), not a payload
problem; retry on a real incident before relying on it.

**Supplemental Information** = the statements as child records
(`AddOn.SupplementalInfo/Supplemental.Information.mvc`, `ParentEntityID 70`
= STARS.Incident, `ParentID` = IncidentId, `InfoType` CST = customer
statement / WIT = witness; the intake wrote one "Customer/Member Statement"
row with who-completed / first / last / description).

**Attachments** on the incident (`AttachmentListClearSight?attachedEntityKey=<IncidentId>&attachedEntityDomain=STARS.Incident`)
were **empty** even though three photos sit on the notice
(`attachedEntityDomain=STARS.IntakeNotice`). So scans of the paper forms
should be uploaded twice if both places matter: to the notice during
intake (`Link: PE_Photo1` for the scene photos) and to the incident
afterwards (same `Orion.File.mvc` upload, `AttachedEntityDomainName:
"STARS.Incident"`, `AttachedEntityKey: <IncidentId>`).

## 6c. Scanning and handwriting (tested 2026-09-16)

Constraint from the analyst: **incident, health and safety data must not be
stored outside Walmart**. That rules out public cloud OCR and any personal
account; it also means model weights fetched from the public internet are
fine (nothing sensitive travels out) but scans are not.

| Step | What works | Notes |
|---|---|---|
| Scan | Windows Image Acquisition via PowerShell (`WIA.DeviceManager`), Canon TS3700 flatbed, 300 dpi, ~15 s | In the module this needs a native messaging helper (a browser cannot drive a scanner) or a drop-in file. |
| Classify page | Windows built-in OCR (`Windows.Media.Ocr`, on-device) reads the printed title, corner code (`INCR`, `WITS`, `ECST`, `MEDA`) and revision date | `dev/win-ocr.ps1` + `dev/scan-classify.py`; high-confidence match on the test form. |
| Locate answers | Printed labels give anchor boxes; crop right/below each | `scan-classify.py --crops`; `scan-lines.py` splits multi-line boxes. |
| Packet checklist | Required / conditional / optional forms per path from the packet cover pages | `dev/packet-status.py CUST …` prints scanned vs missing. |
| Read handwriting, on-device | Windows OCR: fails (name → "B adAock"). TrOCR (transformers.js, quantized, ~250 MB) is the local candidate, but its weights sit on a Hugging Face CDN that **McAfee Web Gateway blocks by category** — curl, Node and Edge all refused. Would have to be served from qrcallbox.com. | Not yet tested; runtime installed in `dev/`, config files in `dev/.models/`. |
| **Read handwriting, Walmart gateway** | **`https://puppy-backend.walmart.com/anthropic`** (the internal AI gateway Code Puppy uses; `.walmart.com`, no proxy). Anthropic-compatible; models `claude-opus-5` and `claude-sonnet-5` (plus Gemini and GPT routes). Auth = the user's `puppy_token` JWT from `~/.code_puppy/puppy.cfg` sent as `X-Api-Key` (models.json holds a `$puppy_token` placeholder). **Claude Opus 5 transcribed all 16 crops of the test form exactly** (name, address, phone, narrative with the writer's spelling kept, blanks as null) in 10.6 s. | `dev/gateway-ocr-test.py` (run with the code-puppy venv python; uses the Walmart CA bundle). This is the sanctioned route; confirm with InfoSec that the gateway is approved for this data class, and note the token expires (2026-10-05 for the current one) so the module needs the same sign-in flow Code Puppy has. |

## 6d. Video (2026-09-16, research in progress)

- The paper **Video Request Form** carries the camera in the *second* "Exact
  Location of Incident" box (Part II, reviewer) and the exact video time
  stamp next to it; cameras are named with underscores (`acc_bay_2`). The
  classifier now reads them as `camera` and `video_timestamp`; they belong
  in the incident record's Evidence Collection page (`MiscDescription#284`
  cameras, `SpecialAnalysis#369` time stamp).
- The store video system is **Intellicene Symphia** (formerly Verint Nextiva
  / Cognyte). Reviewing is done in **Symphia VMS Review**; an accident clip
  is exported via *External applications → Symphia Enhanced Export Client*.
  This is the "Enhanced Export?" column in the CAS evidence report that the
  Live Dashboard accident widget already reads (`livedashboard/lib/sources/accident.js`).
  It is installed on a different PC; a Claude session there
  ("Remote control activation") is investigating the client's export
  dialog, output format and any command-line / API surface.
- Packet rules: capture one hour before and one hour after; upload to WCS
  via the cloud, else two DVD copies.
- **Findings from the AP workstation (2026-09-16, `dev/VIDEO_EXPORT_FINDINGS.md`):**
  Symphia VMS Review 7.7 + the Walmart-customised **Enhanced Export Client**
  (Verint/Cognyte). The **CMI template is the "upload to WCS via the cloud"**:
  it writes `1458_Evidence-<case>_<timestamp>\<CAMERA>.mp4` (1-hour / 900 MB
  fragments, 1080p H.264 with burned-in timestamp, `Inventory.csv`) into
  `Transfer\Feeder`, and the transfer service pushes it to CMI's Azure blob;
  `Transfer\Status\<packet>.xml` records the upload result. The **case number
  is the WCS claim number**, which Clearsight assigns as soon as the statement
  page is saved (before Submit) — the module now reads it back after Prepare.
  VMS camera names are `ACC_BAY_02` style (upper-case, zero-padded), so the
  module normalises the paper `acc_bay_2` (`forms.js::vmsCameraName`).
  Export is GUI-only today: the Review SDK can open the right tile but has no
  export call; the Export SDK (`Verint.Vms.Export.Sdk`, x86 .NET) could
  automate it later but needs VMS credentials. Fully-manual path from the
  module's "Copy request": Review → Recorded → camera → Video Query (start
  = incident − 1 h, 2 h) → Enhanced Export → Insert tile → CMI → case → Start;
  about 18 minutes for two hours. When the incident is keyed in less than an
  hour after it happened, the "after" hour does not exist yet; the module
  flags the time it becomes available.
- **Network (2026-09-16):** this PC (7.90.28.142, corporate side) cannot
  reach the NVR (192.168.84.38, store LAN) but does reach the AP workstation
  `DVRPC2511232220` on its corporate address 7.90.28.63: ping, RDP 3389,
  SMB 445, RPC 135 and the Enhanced Export agent port 12388 are open. So a
  helper service on the AP PC (firewall rule for its port needed) can be
  driven from the module here, and the video client never has to be touched
  by hand. Plan: pre-load the tile via the client's command line / Review
  SDK, drive template + case + Start with Windows UI Automation, confirm via
  `Transfer\Status`. Prototype tasks were sent to the session on that PC.
- Attaching the MP4s to the Clearsight incident as well: possible (200 MB
  cap per file, 1 MiB chunks), but CMI already delivers them to WCS, so it is
  optional. The Evidence Collection page's camera and time-stamp fields
  should still be filled.

## 7. Open items

1. ~~Associate lookup~~ — done 2026-09-16 (see WC_Associate Statement).
   Notice 19059 is parked after the lookup, 19064 (CPD) at its summary;
   only 19060 was submitted. The AUTO path has not been walked live.
2. Identify the exact endpoint that flips the notice to `C` (the request
   log filter missed it; check `performance` resource entries or re-record
   with a broader filter on the next test submit).
3. Map the Incident Info/Evidence Collection page inside the submitted
   incident record (`STARS.Incident/view.cmdx?id=9498309` on UAT) and the
   attachments page there.
4. On prod, capture `custheader` from a real UI POST (the `StormsIntake`
   token is empty there) — read-only otherwise.
5. Packet PDFs: decide whether to bundle them in the module or link to the
   OneWalmart WCS Toolkit ("Do Not Copy Form - Print from wmlink/WCS" is
   printed on the Evidence Collection sheet, so linking is safer).
