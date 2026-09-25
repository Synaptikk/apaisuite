// modules/accidents/lib/cas.js
//
// PNL charge-summary parser for the CAS static HTML file
// (https://storage.googleapis.com/cas_storage/cas_static_html/<store>.html).
//
// The evidence tables on the same page are parsed by
// ../../livedashboard/lib/sources/accident.js (shared consumer, same file /
// one fetch). This lib adds the two remaining sections:
//   - FY27 PNL Summary
//   - FY26 PNL Summary
// Columns: PNL Month | Ref # | Status | Claimant | Category | Charge Div. |
// Total Charges [| Actions]. A negative Total Charges is a credit back —
// the charge was reversed (dispute won / claim denied).

const SECTION_RE = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
const PNL_TITLE_RE = /FY(\d{2})\s*PNL Summary/i;

export function parsePnl(html) {
  const out = [];
  if (typeof html !== "string" || !html.length) return out;
  const headers = [];
  let m;
  while ((m = SECTION_RE.exec(html)) !== null) {
    headers.push({ index: m.index, end: m.index + m[0].length, text: strip(m[1]).trim() });
  }
  for (let i = 0; i < headers.length; i++) {
    const t = headers[i].text.match(PNL_TITLE_RE);
    if (!t) continue;
    const fy = `FY${t[1]}`;
    const sectionEnd = i + 1 < headers.length ? headers[i + 1].index : html.length;
    const rows = tableRows(html.slice(headers[i].end, sectionEnd));
    for (const cells of rows) {
      if (cells.length < 7) continue;
      if (!/^[A-Za-z0-9]+$/.test(cells[1])) continue;      // totals / spacer rows have no Ref #
      const amount = money(cells[6]);
      out.push({
        fy,
        pnlMonth:  cells[0],
        ref:       cells[1],
        status:    cells[2],
        claimant:  cells[3] === "0" ? "" : cells[3],
        category:  cells[4],
        chargeDiv: cells[5],
        amount,
        isCredit:  amount != null && amount < 0,
      });
    }
  }
  return out;
}

// One entry per Ref # with the charge history folded in.
export function rollupPnl(charges) {
  const byRef = new Map();
  for (const c of charges) {
    let r = byRef.get(c.ref);
    if (!r) {
      r = { ref: c.ref, claimant: "", category: c.category, chargeDiv: c.chargeDiv,
            charges: [], total: 0, charged: 0, credited: 0, hasCredit: false, status: c.status };
      byRef.set(c.ref, r);
    }
    r.charges.push(c);
    if (c.claimant) r.claimant = c.claimant;
    r.status = c.status;                       // rows appear oldest-first; keep the last
    if (c.amount != null) {
      r.total += c.amount;
      if (c.amount >= 0) r.charged += c.amount; else { r.credited += -c.amount; r.hasCredit = true; }
    }
  }
  return [...byRef.values()];
}

function tableRows(sectionHtml) {
  const tableMatch = sectionHtml.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) return [];
  const rows = [];
  for (const trM of tableMatch[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const trHtml = trM[1];
    if (/<th\b/i.test(trHtml) && !/<td\b/i.test(trHtml)) continue;
    const cells = [...trHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => norm(c[1]));
    if (cells.length) rows.push(cells);
  }
  return rows;
}

function norm(h) {
  let s = String(h).replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, "$1");
  s = strip(s).replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  return s;
}
function strip(s) { return String(s).replace(/<[^>]+>/g, ""); }

// "-$1,000" → -1000, "$0" → 0, "" → null
function money(s) {
  const m = String(s || "").replace(/[,$\s]/g, "").match(/^(-?)\$?(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const n = Number(m[2]);
  return m[1] === "-" && n >= 0 ? -n : n;
}
