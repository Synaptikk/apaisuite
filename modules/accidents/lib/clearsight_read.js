// modules/accidents/lib/clearsight_read.js
//
// READ-ONLY client for the Clearsight (Riskonnect) PROD Claims Admin app.
// Everything here is a GET with the user's session cookie — no anti-forgery
// token needed (that is only required for POSTs; see
// dev/CLEARSIGHT_INTAKE_FINDINGS.md §1 and the write-capable client in
// modules/incidentintake/lib/clearsight.js).
//
// Endpoints recorded live on prod 2026-09-22 (dev/.claim-probe/):
//   quick search  GET RMIS/STARS.Claim.mvc/metadata/StormsQuickSearchResult
//                     ?pageNumber=0&quickSearchCriteria=<text>&SessionMode=ReadOnly
//                 → { Rows: [{ Key: "<claimId>", ClaimNumber, CoverageCode, ... }] }
//   claim         GET RMIS/STARS.Claim.mvc/FormData?id=<claimId>&groupKeys=1,<coverage>
//                 → flat field dict + <field>Lookup decode objects; includes the
//                   Evidence Collection fields (SpecialAnalysis#369-372,
//                   MiscDescription#283-289, MiscDate#142)
//   statements    GET AddOn.SupplementalInfo/Supplemental.Information.mvc/GridSearch
//                     ?searchParms=ParentEntityID : 41>ParentID : <claimId>>ParentKey : <claimId>
//                     &pageNumber=0&groupKeys=1,<CST|WIT>&viewId=<8496|8497>&ParentEntityID=41
//                 then FormData?id=<Key>&groupKeys=1,<CST|WIT> per row for the text
//   attachments   GET Orion.Application/Orion.File.mvc/AttachmentListClearSight
//                     ?pageNumber=0&attachedEntityKey=<claimId>&attachedEntityDomain=STARS.Claim

export const BASE = "https://www.riskonnectclearsight.com/Walmart";
const Q = "SessionMode=ReadOnly&appName=ClaimsAdmin&clearsight=true";

export const STATEMENT_VIEWS = { CST: 8496, WIT: 8497 };

export class NotSignedIn extends Error {}

async function getJson(path) {
  const r = await fetch(`${BASE}/${path}`, { credentials: "include", headers: { Accept: "application/json" } });
  const text = await r.text();
  if (/<html|login\.cmdx|SsoSessionEnded|noAuthentication/i.test(text.slice(0, 400))) {
    throw new NotSignedIn("Not signed in to Clearsight in this browser.");
  }
  if (!r.ok) throw new Error(`Clearsight ${path.split("?")[0].split("/").pop()} returned ${r.status}`);
  try { return JSON.parse(text); } catch { throw new Error(`Bad JSON from ${path.split("?")[0]}: ${text.slice(0, 120)}`); }
}

// Cheap signed-in probe (231-byte JSON when authenticated, HTML login page when not).
export async function isSignedIn() {
  try { await getJson(`Favorite.mvc?${Q}`); return true; }
  catch (e) { if (e instanceof NotSignedIn) return false; return true; }
}

// Resolve a CAS Ref # (26xxxxxx claim number or legacy C…/L… number) to the
// claim row. Returns null when Clearsight finds nothing.
export async function quickSearch(text) {
  const j = await getJson(`RMIS/STARS.Claim.mvc/metadata/StormsQuickSearchResult?pageNumber=0&quickSearchCriteria=${encodeURIComponent(text)}&sortOrder=&attachmentParents=&${Q}`);
  const row = (j.Rows || [])[0];
  if (!row) return null;
  return {
    claimId:      String(row.Key),
    claimNumber:  row.ClaimNumber || "",
    claimant:     (row.ClaimName1 || "").trim(),
    coverageCode: String(row.CoverageCode || ""),
    claimType:    row["DECODE_SpecialAnalysis#19"] || "",
    status:       row.DECODE_Status || "",
    lossDate:     row.LossDate || "",
    caseManagerEmail: row["MiscDescription#46"] || "",
  };
}

// Full claim record. `coverageCode` from quickSearch (GL 20, WC 10, GK 22 …).
export async function claimFormData(claimId, coverageCode) {
  return getJson(`RMIS/STARS.Claim.mvc/FormData?id=${claimId}&copy=false&groupKeys=1,${coverageCode}&${Q}`);
}

// Retired lookup codes decode as "! Invalid Code ( 19: Cut/Puncture-Misc )" —
// keep just the label.
const cleanCode = (s) => {
  if (s == null) return null;
  const m = String(s).match(/^!\s*Invalid Code\s*\(\s*\d+:\s*(.+?)\s*\)\s*$/i);
  return m ? m[1] : s;
};
const deco = (d, field) => cleanCode(d?.[`${field}Lookup`]?.Description ?? d?.[field] ?? null);

// The digest the module actually renders, from the raw FormData dict.
export function claimDigest(d) {
  return {
    claimId:      String(d.ClaimID ?? ""),
    claimNumber:  String(d.ClaimNumber ?? ""),
    claimant:     (d.ClaimName1 || "").trim(),
    status:       deco(d, "Status"),
    coverage:     deco(d, "CoverageCode"),
    claimType:    deco(d, "SpecialAnalysis#19"),
    lossDate:     (d.LossDate || "").split(" ")[0],
    lossTime:     deco(d, "SpecialAnalysis#14"),
    reportDate:   (d.ReportDate || "").split(" ")[0],
    description:  d.ClaimDescription || "",
    cause:        deco(d, "Cause"),
    causeDetail:  deco(d, "SpecialAnalysis#294"),
    bodyPart:     deco(d, "SpecialAnalysis#2"),
    injury:       deco(d, "SpecialAnalysis#4"),
    claimantType: deco(d, "SpecialAnalysis#85"),
    area:         deco(d, "SpecialAnalysis#79"),
    spot:         deco(d, "SpecialAnalysis#356"),
    facility:     deco(d, "LocationID"),
    caseManager: {
      name:  deco(d, "MiscUser#1"),
      email: d["MiscDescription#46"] || "",
      phone: d["MiscDescription#47"] || "",
    },
    claimEasyUrl: d.HyperLink2 || "",
    evidence:     evidenceChecklist(d),
  };
}

// Incident Info / Evidence Collection page fields on the claim record
// (labels from dev/CLEARSIGHT_INTAKE_FINDINGS.md §6b). null/"" = not filled in.
const EVIDENCE_FIELDS = [
  { id: "SpecialAnalysis#372", label: "Location of incident captured on video?", lookup: true },
  { id: "MiscDescription#284", label: "Cameras that captured the incident" },
  { id: "SpecialAnalysis#369", label: "Exact video time stamp of incident", lookup: true },
  { id: "MiscDescription#285", label: "Description of claimant's clothing" },
  { id: "MiscDescription#287", label: "If no surveillance video, explanation" },
  { id: "MiscDescription#286", label: "Witnesses/associates in area of incident" },
  { id: "SpecialAnalysis#370", label: "Is physical evidence available?", lookup: true },
  { id: "MiscDescription#288", label: "Physical evidence retained (description)" },
  { id: "SpecialAnalysis#371", label: "Additional related documents available?", lookup: true },
  { id: "MiscDescription#289", label: "Manager's name and title" },
];

export function evidenceChecklist(d) {
  const items = EVIDENCE_FIELDS.map((f) => {
    const raw = f.lookup ? deco(d, f.id) : d[f.id];
    const value = raw == null ? "" : String(raw).trim();
    return { id: f.id, label: f.label, value, filled: value !== "" };
  });
  const completedOn = (d["MiscDate#142"] || "").split(" ")[0] || "";
  return {
    items,
    filled: items.filter((i) => i.filled).length,
    total: items.length,
    completedOn,
    complete: completedOn !== "",
  };
}

// Customer (CST) + witness (WIT) statements for one claim: grid rows first,
// then each row's FormData for the actual text. `max` caps the per-type
// FormData fan-out.
export async function statements(claimId, { max = 6 } = {}) {
  const out = [];
  for (const [type, viewId] of Object.entries(STATEMENT_VIEWS)) {
    const parms = encodeURIComponent(`ParentEntityID : 41>ParentID : ${claimId}>ParentKey : ${claimId}`);
    let grid;
    try {
      grid = await getJson(`AddOn.SupplementalInfo/Supplemental.Information.mvc/GridSearch?searchParms=${parms}&pageNumber=0&groupKeys=1,${type}&viewId=${viewId}&ParentEntityID=41&${Q}`);
    } catch (e) {
      if (e instanceof NotSignedIn) throw e;
      continue;                       // a claim type without this SIM view
    }
    const rows = (grid.Rows || []).slice(0, max);
    for (const row of rows) {
      let text = "", who = "", completedBy = "", date = row.CreateDT || "";
      try {
        const d = await getJson(`AddOn.SupplementalInfo/Supplemental.Information.mvc/FormData?id=${row.Key}&groupKeys=1,${type}&${Q}`);
        who = d["SpecialAnalysis#17Lookup"]?.Description || d["SpecialAnalysis#17"] || "";
        completedBy = d["MiscDescription#23"] || "";
        text = d["MiscDescription#24"] || longestText(d);
        date = d["MiscDate#10"]?.split(" ")[0] || date;
      } catch { /* keep the grid-level row */ }
      out.push({
        type,
        key: String(row.Key),
        first: (row["MiscDescription#10"] || "").trim(),
        last: (row["MiscDescription#11"] || "").trim(),
        who, completedBy, date, text: String(text || "").trim(),
      });
    }
  }
  return out;
}

// Fallback: the longest free-text answer on the record.
function longestText(d) {
  let best = "";
  for (const [k, v] of Object.entries(d)) {
    if (!/^MiscDescription#/.test(k) || typeof v !== "string") continue;
    if (v.length > best.length && v.length > 20) best = v;
  }
  return best;
}

export async function attachmentCount(claimId) {
  const j = await getJson(`Orion.Application/Orion.File.mvc/AttachmentListClearSight?pageNumber=0&attachedEntityKey=${claimId}&attachedEntityDomain=STARS.Claim&${Q}`);
  return j.TotalNumberOfRows ?? (j.FieldValues || []).length;
}

export function claimUrl(claimId) {
  return `${BASE}/app/Clearsight/#/dashboards/stars.claim/${claimId}`;
}
