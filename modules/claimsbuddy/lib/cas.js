// Fetch and parse the CAS static HTML report for a store.
//
// Source URL pattern:
//   https://storage.googleapis.com/cas_storage/cas_static_html/{store}.html
//
// The page has 4 logical data tables, each wrapped in a single-cell outer
// table (so 8 in the DOM). The inner ones all have class="dataframe".
//   - Bodily Injury Evidence Report   (per-claim evidence-tracking detail)
//   - Garage Keeper PD Evidence Report (same schema)
//   - FY27 PNL Summary                (monthly charges per claim)
//   - FY26 PNL Summary                (monthly charges per claim)
// We pull rows from the Evidence tables, then scan the PNL tables for
// claims with Status="Open" that aren't already in the evidence tables
// (the Evidence Reports only list claims with active tracking attention;
// PNL lists every claim, open or closed — taking the open ones gives
// fuller visibility into "what's actually still open at this store").
//
// CAS is described as publicly accessible, but Walmart corp may gate it
// at the network layer — `credentials: "include"` is harmless either way.

const BASE = "https://storage.googleapis.com/cas_storage/cas_static_html";

export async function fetchCasReport(store) {
  const url = `${BASE}/${store.short}.html`;
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`CAS HTTP ${res.status} for store ${store.short}`);
  }
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, "text/html");

  // The CAS page wraps every data table in a single-cell outer table:
  //   <table><tbody><tr><td><table class="dataframe">…real table…</table>
  // Targeting `.dataframe` skips the wrappers so we only parse real data.
  const dataTables = Array.from(doc.querySelectorAll("table.dataframe"));
  console.log(`[ClaimsBuddy] CAS: page has ${dataTables.length} data table(s)`);
  for (const t of dataTables) {
    const hdrs = tableHeaders(t);
    const label = nearestHeadingLabel(t);
    console.log(
      `[ClaimsBuddy] CAS table "${label.slice(0, 60)}": ${hdrs.length} cols, ${t.querySelectorAll("tbody tr").length} rows`,
      "headers:", hdrs
    );
  }

  // ─── Evidence tables (BI Evidence Report, GK PD Evidence Report) ─────────
  const evidenceTables = dataTables
    .map((t) => ({ table: t, headers: tableHeaders(t) }))
    .filter(({ headers }) => looksLikeEvidenceTable(headers));

  const bodilyInjury = [];
  const garageKeeper = [];
  for (const { table } of evidenceTables) {
    const label = nearestHeadingLabel(table);
    const rows = parseEvidenceRows(table);
    if (/garage keeper/i.test(label) || /property damage/i.test(label)) {
      garageKeeper.push(...rows);
    } else {
      bodilyInjury.push(...rows);
    }
  }

  // ─── PNL tables (FY27, FY26) — open claims + cumulative charges by ref ───
  const pnlTables = dataTables
    .map((t) => {
      const headers = tableHeaders(t);
      const label = nearestHeadingLabel(t);
      // FY detection by section heading — used to scope the closed-paid
      // section to the current fiscal year only.
      const fiscalYear = /fy\s*27/i.test(label) ? 27 : /fy\s*26/i.test(label) ? 26 : null;
      return { table: t, headers, label, fiscalYear };
    })
    .filter(({ headers }) => looksLikePnlTable(headers));

  const existingRefs = new Set([
    ...bodilyInjury.map((r) => r.referenceNbr),
    ...garageKeeper.map((r) => r.referenceNbr),
  ]);
  const { openClaims, closedPaidClaims, chargesByRef } = parsePnlData(pnlTables, existingRefs);
  console.log(`[ClaimsBuddy] CAS: ${openClaims.length} open + ${closedPaidClaims.length} closed-paid (FY27) from PNL; charges for ${chargesByRef.size} ref(s)`);

  return {
    store: store.short,
    fetchedAt: new Date().toISOString(),
    bodilyInjury,
    garageKeeper,
    openClaims,
    closedPaidClaims,
    chargesByRef,
  };
}

function tableHeaders(table) {
  const ths = table.querySelectorAll("thead th");
  if (ths.length > 0) return Array.from(ths).map((th) => th.textContent.trim());
  // Some CAS tables use a plain <tr> as the header row, no <thead>.
  const firstRow = table.querySelector("tr");
  if (!firstRow) return [];
  return Array.from(firstRow.children).map((c) => c.textContent.trim());
}

function looksLikeEvidenceTable(headers) {
  // Match loosely so a column rename doesn't break detection. The pair of
  // "Reference" + "Evidence Status" is unique to the two evidence tables.
  const norm = headers.map((h) => h.toLowerCase());
  return norm.some((h) => h.includes("reference"))
      && norm.some((h) => h.includes("evidence status"));
}

function looksLikePnlTable(headers) {
  // FY27 / FY26 PNL tables have: PNL Month, Ref #, Status, Claimant,
  // Category, Charge Div., Total Charges, Denial Credit, Evidence Credit.
  // We match on the combination that doesn't overlap with the evidence tables.
  const norm = headers.map((h) => h.toLowerCase().trim());
  return norm.some((h) => h === "pnl month")
      && norm.some((h) => h === "status")
      && norm.some((h) => h === "category");
}

function nearestHeadingLabel(table) {
  let el = table.previousElementSibling;
  while (el) {
    if (/^H[1-6]$/.test(el.tagName)) return el.textContent.trim();
    el = el.previousElementSibling;
  }
  let parent = table.parentElement;
  while (parent) {
    let sib = parent.previousElementSibling;
    while (sib) {
      if (/^H[1-6]$/.test(sib.tagName)) return sib.textContent.trim();
      sib = sib.previousElementSibling;
    }
    parent = parent.parentElement;
  }
  return "";
}

function parseEvidenceRows(table) {
  const headers = tableHeaders(table).map((h) => h.replace(/\s+/g, " ").trim());
  const idx = (label) => headers.findIndex(
    (h) => h.toLowerCase().startsWith(label.toLowerCase())
  );
  const cIdx = {
    referenceNbr:            idx("Reference"),
    claimant:                idx("Claimant"),
    tracking:                idx("Tracking"),
    daysOpen:                idx("Days"),
    customerStatement:       idx("Customer"),
    witnessStatement:        idx("Witness"),
    video:                   idx("Video"),
    photos:                  idx("Photos"),
    evidenceCollectionSheet: idx("Evidence Collection"),
    status:                  idx("Evidence Status"),
    enhancedExport:          idx("Enhanced Export"),
  };

  const tbodyRows = table.querySelectorAll("tbody tr");
  const rows = tbodyRows.length > 0
    ? Array.from(tbodyRows)
    : Array.from(table.querySelectorAll("tr")).slice(1);

  const parsed = rows.map((tr) => {
    // Only count direct child cells. A nested <table> inside a <td> would
    // otherwise leak its inner cells into this row's cell list.
    const cells = Array.from(tr.children)
      .filter((el) => el.tagName === "TD" || el.tagName === "TH")
      .map((td) => td.textContent.replace(/\s+/g, " ").trim());
    const get = (i) => (i >= 0 && i < cells.length ? cells[i] : "");
    return {
      referenceNbr:            get(cIdx.referenceNbr),
      claimant:                get(cIdx.claimant),
      tracking:                get(cIdx.tracking),
      daysOpen:                parseInt(get(cIdx.daysOpen), 10) || 0,
      customerStatement:       get(cIdx.customerStatement),
      witnessStatement:        get(cIdx.witnessStatement),
      video:                   get(cIdx.video),
      photos:                  get(cIdx.photos),
      evidenceCollectionSheet: get(cIdx.evidenceCollectionSheet),
      status:                  get(cIdx.status),
      enhancedExport:          get(cIdx.enhancedExport),
      _cellCount:              cells.length,
    };
  });

  // Real CAS claim refs are numeric or [CL]-prefixed numeric per
  // CAS_STATIC_HTML_REFERENCE.md §9. The HTML for this store has extra
  // <tr>s — repeated header rows, nested detail tables, footer rows —
  // that pollute the row list. Drop anything whose referenceNbr cell
  // doesn't look like a real claim reference, OR that lacks a claimant
  // (a real claim row always has both).
  const refPattern = /^[CL]?\d{4,}$/i;
  const kept = [];
  const dropped = [];
  for (const r of parsed) {
    if (!r.referenceNbr || !refPattern.test(r.referenceNbr) || !r.claimant) {
      dropped.push(r);
    } else {
      delete r._cellCount;
      kept.push(r);
    }
  }
  if (dropped.length > 0) {
    console.log(`[ClaimsBuddy] CAS dropped ${dropped.length} junk row(s) from table with headers:`, headers);
    console.log("[ClaimsBuddy] CAS dropped sample:", dropped.slice(0, 3));
  }
  return kept;
}

// Single pass over the PNL tables that returns three things:
//   - openClaims:        open-status refs not already in the evidence tables
//                        (deduped across months and across FY27/FY26)
//   - closedPaidClaims:  closed-status refs from FY27 only with nonzero
//                        cumulative charges — i.e., money the store paid out
//                        on resolved claims this fiscal year
//   - chargesByRef:      total cumulative charges per ref, summed across every
//                        PNL row (open + closed, both fiscal years). The
//                        evidence-table rows can look up their cost by ref
//                        from this map.
function parsePnlData(pnlTables, existingRefs) {
  const refPattern = /^[CL]?\d{4,}$/i;
  const chargesByRef     = new Map();
  const openClaims       = new Map();
  const closedPaidRefs   = new Map();  // ref → {claimant, category, pnlMonth} from FY27 only

  for (const { table, headers, fiscalYear } of pnlTables) {
    const idx = (label) => headers.findIndex(
      (h) => h.toLowerCase().trim() === label.toLowerCase()
    );
    const cIdx = {
      pnlMonth:     idx("PNL Month"),
      referenceNbr: idx("Ref #"),
      status:       idx("Status"),
      claimant:     idx("Claimant"),
      category:     idx("Category"),
      totalCharges: idx("Total Charges"),
    };
    const tbodyRows = table.querySelectorAll("tbody tr");
    const rows = tbodyRows.length > 0
      ? Array.from(tbodyRows)
      : Array.from(table.querySelectorAll("tr")).slice(1);

    for (const tr of rows) {
      const cells = Array.from(tr.children)
        .filter((el) => el.tagName === "TD" || el.tagName === "TH")
        .map((td) => td.textContent.replace(/\s+/g, " ").trim());
      const get = (i) => (i >= 0 && i < cells.length ? cells[i] : "");
      const referenceNbr = get(cIdx.referenceNbr);
      if (!referenceNbr || !refPattern.test(referenceNbr)) continue;

      // Accumulate cost regardless of status / year — a closed claim still
      // has a total cost we want to show wherever the ref surfaces.
      chargesByRef.set(
        referenceNbr,
        (chargesByRef.get(referenceNbr) ?? 0) + parseCurrency(get(cIdx.totalCharges))
      );

      const status = get(cIdx.status).toLowerCase();

      // Open-claims list: not already in evidence reports, status=Open,
      // first occurrence per ref.
      if (!existingRefs.has(referenceNbr) && status === "open" && !openClaims.has(referenceNbr)) {
        openClaims.set(referenceNbr, {
          referenceNbr,
          claimant: get(cIdx.claimant),
          category: get(cIdx.category),
          pnlMonth: get(cIdx.pnlMonth),
        });
      }

      // Closed-paid list: FY27 only, status=Closed, first occurrence per ref.
      // The charges check happens after the loop (we need the full sum first).
      if (fiscalYear === 27 && status === "closed" && !closedPaidRefs.has(referenceNbr)) {
        closedPaidRefs.set(referenceNbr, {
          referenceNbr,
          claimant: get(cIdx.claimant),
          category: get(cIdx.category),
          pnlMonth: get(cIdx.pnlMonth),
        });
      }
    }
  }

  // Attach cumulative charges; drop closed-paid entries that ended up with $0
  // (those weren't actually "paid out").
  for (const c of openClaims.values()) {
    c.totalCharges = chargesByRef.get(c.referenceNbr) ?? 0;
  }
  const closedPaidClaims = [];
  for (const c of closedPaidRefs.values()) {
    c.totalCharges = chargesByRef.get(c.referenceNbr) ?? 0;
    if (c.totalCharges > 0) closedPaidClaims.push(c);
  }

  return {
    openClaims: Array.from(openClaims.values()),
    closedPaidClaims,
    chargesByRef,
  };
}

// "$1,234.56" → 1234.56. Empty / unparseable → 0.
function parseCurrency(s) {
  if (!s) return 0;
  const n = parseFloat(s.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}
