// modules/market120/lib/parse_dax_grid.js
//
// Decode a Power BI DSR "grid" response into an array of row objects:
//   [{ dims: { "<dimName>": value, ... }, measures: { "<measureName>": number } }]
//
// This is the multi-row companion to parse_dax.js (which extracts single-value
// KPI cards). The two are deliberately separate: cards and grids have different
// shapes and different callers, so keeping them apart honours single
// responsibility and keeps each decoder small.
//
// The hard part (learned via CDP probe 2026-07-28, dev/_dump-dsr-raw.mjs) is
// Power BI's two compression tricks inside dsr.DS[*].PH[*].DM<n>:
//
//   1. ValueDicts — repeated strings are hoisted into ds.ValueDicts.D<k> and
//      referenced by integer index. The FIRST row's S[] entries carry a
//      `DN: "D<k>"` telling you which dict a column draws from.
//        D0: ["1458"]                     ← Store column
//        D1: ["SRELDER","HND0018",...]    ← UserID column
//        row0.C = [0, 0, "-13342.85"]     ← C[0]=store idx0, C[1]=user idx0
//
//   2. R / Ø bitmasks — after the first row, unchanged columns are OMITTED
//      from C and flagged in a bitmask:
//        R (repeat): bit i set → column i repeats the PREVIOUS row's value.
//        Ø (null):   bit i set → column i is null this row.
//      So {"C":[1,"-12725.83"],"R":1} means: col0 repeats (store "1458"),
//      then the remaining C values fill the NON-repeated columns in order.
//
// Getting this wrong silently shifts values into the wrong columns — hence the
// dedicated decoder + regression tests (dev/_test-grid-decode.mjs).

/**
 * @param {string|null} respBody
 * @returns {{ ok: boolean, grids: Array<{
 *   dimNames: string[], measureNames: string[],
 *   rows: Array<{ dims: Record<string, any>, measures: Record<string, number|null> }>
 * }>, reason?: string }}
 */
export function decodeDaxGrids(respBody) {
  if (!respBody || typeof respBody !== "string") {
    return { ok: false, grids: [], reason: "empty response body" };
  }
  let resp;
  try { resp = JSON.parse(respBody); }
  catch (e) { return { ok: false, grids: [], reason: "JSON parse failed: " + e.message }; }

  const results = resp?.results;
  if (!Array.isArray(results) || !results.length) {
    return { ok: false, grids: [], reason: "no results array" };
  }

  const grids = [];
  for (const result of results) {
    const data = result?.result?.data;
    if (!data) continue;

    // Map DSR column code (e.g. "G0","M0") -> human name via descriptor.
    const codeToName = {};
    for (const s of (data.descriptor?.Select || [])) {
      if (s && s.Value) codeToName[s.Value] = s.Name || s.Value;
    }

    for (const ds of (data.dsr?.DS || [])) {
      const valueDicts = ds.ValueDicts || {};
      for (const ph of (ds.PH || [])) {
        for (const dmKey of Object.keys(ph).filter((k) => /^DM\d+$/.test(k))) {
          const rawRows = ph[dmKey] || [];
          const grid = decodeGrid(rawRows, valueDicts, codeToName);
          if (grid && grid.rows.length) grids.push(grid);
        }
      }
    }
  }

  return { ok: grids.length > 0, grids, reason: grids.length ? undefined : "no grids found" };
}

// Decode one DM<n> block (an array of raw rows) into a typed grid.
function decodeGrid(rawRows, valueDicts, codeToName) {
  if (!Array.isArray(rawRows) || !rawRows.length) return null;

  // The FIRST row carries the column schema in S[]. Each S entry:
  //   { N: "<code>", T: <type>, DN?: "D<k>" }  (DN present → dict-backed)
  const first = rawRows[0];
  const schema = Array.isArray(first?.S) ? first.S : null;
  if (!schema) return null;

  const columns = schema.map((s) => ({
    code: s?.N,
    name: codeToName[s?.N] || s?.N,
    dict: s?.DN && valueDicts[s.DN] ? valueDicts[s.DN] : null,
    isMeasure: /^M/i.test(s?.N || ""), // M-codes = measures; G-codes = grouping dims
  }));

  const dimNames = columns.filter((c) => !c.isMeasure).map((c) => c.name);
  const measureNames = columns.filter((c) => c.isMeasure).map((c) => c.name);

  const rows = [];
  let prev = new Array(columns.length).fill(null); // carry-forward for R-repeats

  for (const raw of rawRows) {
    const c = Array.isArray(raw?.C) ? raw.C : [];
    const repeatMask = typeof raw?.R === "number" ? raw.R : 0;
    const nullMask   = typeof raw?.["Ø"] === "number" ? raw["Ø"] : 0;

    // Walk every column; pull the next C value only for columns that are
    // neither repeated nor null this row.
    const resolved = new Array(columns.length);
    let ci = 0;
    for (let col = 0; col < columns.length; col++) {
      const bit = 1 << col;
      if (nullMask & bit) {
        resolved[col] = null;
      } else if (repeatMask & bit) {
        resolved[col] = prev[col];
      } else {
        resolved[col] = ci < c.length ? c[ci] : null;
        ci++;
      }
    }
    prev = resolved.slice();

    // Materialise dims (dict-decode) and measures (numeric-coerce).
    const dims = {};
    const measures = {};
    for (let col = 0; col < columns.length; col++) {
      const colDef = columns[col];
      let val = resolved[col];
      if (colDef.dict && Number.isInteger(val)) val = colDef.dict[val] ?? val;
      if (colDef.isMeasure) {
        const num = typeof val === "string" ? Number(val) : val;
        measures[colDef.name] = Number.isFinite(num) ? num : null;
      } else {
        dims[colDef.name] = val;
      }
    }
    rows.push({ dims, measures });
  }

  return { dimNames, measureNames, rows };
}
