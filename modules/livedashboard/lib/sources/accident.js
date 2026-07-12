// modules/livedashboard/lib/sources/accident.js
//
// Accident Charge Summary source. See dev/ACCIDENT_EVIDENCE_V3_FINDINGS.md.
//
// Single GET to a Google Cloud Storage static HTML file:
//   https://storage.googleapis.com/cas_storage/cas_static_html/<storeNbr>.html
// No auth needed. Returns ~30KB HTML containing two report tables:
//   - Bodily Injury Evidence Report
//   - Garage Keeper - Property Damage Evidence Report
// Each table has the same 11-column schema (Reference Nbr, Claimant,
// Tracking #, Days since claim Open, Customer Statement, Witness Statement,
// Video, Photos, Evidence Collection Sheet, Evidence Status, Enhanced Export?).
//
// SW has no DOMParser, so HTML is parsed with focused regex. Tables are
// produced by a server-side dataframe-to-HTML converter, so the markup is
// stable and predictable — regex is sufficient.

const BASE_URL = "https://storage.googleapis.com/cas_storage/cas_static_html";

const SECTION_TITLES = {
  BodilyInjury:               /Bodily Injury Evidence Report/i,
  GarageKeeperPropertyDamage: /Garage Keeper\s*-\s*Property Damage Evidence Report/i,
};

const EVIDENCE_FIELDS = {
  customerStatement:       4,
  witnessStatement:        5,
  video:                   6,
  photos:                  7,
  evidenceCollectionSheet: 8,
};

export async function fetchAccident(storeNbr) {
  const url = `${BASE_URL}/${encodeURIComponent(String(storeNbr))}.html`;
  const resp = await fetch(url, { method: "GET", credentials: "omit" });
  if (resp.status === 404) {
    return { ok: false, errorClass: "NOT_FOUND", error: `No accident report file for store ${storeNbr} (cas_storage 404).` };
  }
  if (!resp.ok) {
    return { ok: false, errorClass: "HTTP", error: `cas_storage returned ${resp.status}` };
  }
  const html = await resp.text();
  return parseAccidentHtml(html, storeNbr);
}

export function parseAccidentHtml(html, storeNbr) {
  if (typeof html !== "string" || !html.length) {
    return { ok: false, errorClass: "EMPTY", error: "Empty HTML response." };
  }
  const updatedAt = extractUpdatedTimestamp(html);
  const sections = splitSections(html);

  const records = [];
  for (const [reportType, sectionHtml] of Object.entries(sections)) {
    const rows = parseDataframeTable(sectionHtml);
    for (const row of rows) {
      const rec = mapRowToRecord(row, reportType, storeNbr, updatedAt);
      if (rec) records.push(rec);
    }
  }
  return {
    ok: true,
    records,
    capturedAt: new Date().toISOString(),
    sourceDataUpdatedOn: updatedAt,
  };
}

// ── Section split ───────────────────────────────────────────────────

function splitSections(html) {
  // Walk the HTML by H2 markers; for each H2 whose text matches a known
  // section title, take the HTML between this H2 and the NEXT H2 (or EOF).
  const out = { BodilyInjury: "", GarageKeeperPropertyDamage: "" };
  const h2Re = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
  const headers = [];
  let m;
  while ((m = h2Re.exec(html)) !== null) {
    headers.push({ index: m.index, end: m.index + m[0].length, text: stripTags(m[1]).trim() });
  }
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const sectionEnd = i + 1 < headers.length ? headers[i + 1].index : html.length;
    const sectionHtml = html.slice(h.end, sectionEnd);
    for (const [key, regex] of Object.entries(SECTION_TITLES)) {
      if (regex.test(h.text)) { out[key] = sectionHtml; break; }
    }
  }
  return out;
}

// ── Table parsing ───────────────────────────────────────────────────

// Find the first <table class=dataframe> in `sectionHtml`, extract <tr>
// rows. Returns array-of-arrays (rows × cells). The first row is headers
// (skipped here — caller knows the positional schema).
function parseDataframeTable(sectionHtml) {
  if (!sectionHtml) return [];
  const tableMatch = sectionHtml.match(/<table[^>]*class\s*=\s*['"]?dataframe['"]?[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) return [];
  const tbody = tableMatch[1];
  const trMatches = [...tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  const rows = [];
  for (const trM of trMatches) {
    const trHtml = trM[1];
    // Cells: prefer <td class=cellinside> if present, else any <td>; skip header rows (<th>)
    if (/<th\b/i.test(trHtml) && !/<td\b/i.test(trHtml)) continue;
    const cellMatches = [...trHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)];
    if (!cellMatches.length) continue;
    const cells = cellMatches.map((c) => normalizeCell(c[1]));
    rows.push(cells);
  }
  return rows;
}

// Strip nested anchors, tags, collapse whitespace.
function normalizeCell(html) {
  // First, capture FedEx tracking link href if present (we'll surface it
  // separately via the record's trackingUrl helper if needed).
  let s = String(html);
  s = s.replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, "$1");
  s = stripTags(s);
  s = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function stripTags(s) {
  return String(s).replace(/<[^>]+>/g, "");
}

function extractUpdatedTimestamp(html) {
  const m = html.match(/All information below updated on:\s*([0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9/-]+)/i);
  return m ? m[1].trim() : null;
}

// ── Record mapping ──────────────────────────────────────────────────

function mapRowToRecord(cells, reportType, storeNbr, updatedAt) {
  if (!Array.isArray(cells) || cells.length < 10) return null;
  const referenceNbr = cells[0];
  if (!referenceNbr || !/^\w+$/.test(referenceNbr)) return null;   // skip junk rows

  const claimant   = cells[1] || "";
  const trackingNbr = cells[2] || "";
  const daysOpenRaw = cells[3] || "";
  const daysOpen    = Number(daysOpenRaw);

  const customerStatement       = mapStatus(cells[EVIDENCE_FIELDS.customerStatement]);
  const witnessStatement        = mapStatus(cells[EVIDENCE_FIELDS.witnessStatement]);
  const video                   = mapStatus(cells[EVIDENCE_FIELDS.video]);
  const photos                  = mapStatus(cells[EVIDENCE_FIELDS.photos]);
  const evidenceCollectionSheet = mapStatus(cells[EVIDENCE_FIELDS.evidenceCollectionSheet]);
  const evidenceStatus          = mapOverall(cells[9]);
  const enhancedExport          = mapYesNo(cells[10]);

  const missingItems = [];
  if (customerStatement       === "missing") missingItems.push("customerStatement");
  if (witnessStatement        === "missing") missingItems.push("witnessStatement");
  if (video                   === "missing") missingItems.push("video");
  if (photos                  === "missing") missingItems.push("photos");
  if (evidenceCollectionSheet === "missing") missingItems.push("evidenceCollectionSheet");

  const priorityScore = computePriorityScore({
    reportType,
    daysOpen: Number.isFinite(daysOpen) ? daysOpen : null,
    video, customerStatement, witnessStatement,
    missingCount: missingItems.length,
  });

  return {
    storeNbr:                 String(storeNbr),
    reportType,
    referenceNbr,
    trackingNbr,
    claimant,
    daysOpen: Number.isFinite(daysOpen) ? daysOpen : null,
    customerStatement,
    witnessStatement,
    video,
    photos,
    evidenceCollectionSheet,
    evidenceStatus,
    enhancedExport,
    missingItems,
    missingCount: missingItems.length,
    priorityScore,
    _source: {
      module:      "livedashboard",
      capturedAt:  new Date().toISOString(),
      sourceUrl:   `${BASE_URL}/${storeNbr}.html`,
      dataUpdatedOn: updatedAt,
    },
  };
}

function mapStatus(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "unknown";
  if (s === "yes" || s === "received" || s === "complete") return "complete";
  if (s.startsWith("no") || s.includes("not received") || s.includes("missing")) return "missing";
  if (s.includes("partial") || s.includes("in progress")) return "partial";
  return "unknown";
}
function mapOverall(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (s.includes("efficient") && !s.includes("inefficient")) return "complete";
  if (s.includes("inefficient")) return "missing";
  if (s.includes("partial")) return "partial";
  return "unknown";
}
function mapYesNo(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (s === "yes") return "yes";
  if (s === "no")  return "no";
  return "unknown";
}

// Per RISK_RULES.md §3 — priorityScore sums AE1-AE5 weights.
function computePriorityScore({ reportType, daysOpen, video, customerStatement, witnessStatement, missingCount }) {
  let score = 0;
  if (reportType === "BodilyInjury" && video === "missing") score += 5;   // AE1
  if (customerStatement === "missing")                       score += 2;   // AE2
  if (witnessStatement  === "missing" && (daysOpen ?? 0) >= 3) score += 1; // AE3
  if ((daysOpen ?? 0) >= 14)                                  score += 2;  // AE4
  if (missingCount >= 3)                                      score += 3;  // AE5
  return score;
}

export function rollup(records) {
  let withMissing = 0;
  let highPriority = 0;
  let agingOpen = 0;
  let worstScore = 0;
  for (const r of records) {
    if ((r.missingCount ?? 0) > 0) withMissing++;
    if ((r.priorityScore ?? 0) >= 7) highPriority++;
    if ((r.daysOpen ?? 0) >= 14) agingOpen++;
    if ((r.priorityScore ?? 0) > worstScore) worstScore = r.priorityScore;
  }
  return {
    total: records.length,
    withMissing,
    highPriority,
    agingOpen,
    worstScore,
  };
}
