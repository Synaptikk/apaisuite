// modules/digitallocks/lib/dsrDecode.js
//
// Decode Power BI's DSR (Data Shape Result) into plain row objects.
//
// Input: the `data` block of the response —
//   { descriptor: { Select: [...] }, dsr: { DS: [{ PH:[{DM0:[...]}], ValueDicts:{...} }] } }
//
// Output: array of objects keyed by column Property name (e.g. "Lock Name",
// "store", "datetime_local") — matching what the existing XLSX parser
// produces.
//
// Format reference (reverse-engineered from probes 2026-06-02):
//   - DM0[0] carries the schema `S` (mapping column G0..GN → dictionary name
//     D0..DN) AND the first row's values in `C`.
//   - Subsequent DM0 entries are subsequent rows. Each may carry:
//       C: array of values (numeric = dict index, string = inline literal)
//       R: bitmask of "repeat this column from previous row"
//       Ø: bitmask of "this column is null in this row"
//     Column count is fixed by the schema; (repeats + nulls + |C|) === N.
//   - The `Ø` key is literally the Unicode character U+00D8.

export function decodeDsr(data) {
  if (!data) return [];
  const descriptor = data.descriptor;
  const dsr = data.dsr;
  const ds = dsr?.DS?.[0];
  const ph = ds?.PH?.[0];
  const dm = ph?.DM0;
  if (!Array.isArray(dm) || dm.length === 0) return [];

  const dicts = ds.ValueDicts || {};
  const select = descriptor?.Select || [];
  const colNames = select.map((s) => s.GroupKeys?.[0]?.Source?.Property || s.Name);
  const nCols = colNames.length;

  const schemaRow = dm[0];
  const colDict = (schemaRow.S || []).map((s) => s.DN);
  while (colDict.length < nCols) colDict.push(null);

  const rows = [];
  const prev = new Array(nCols).fill(undefined);

  for (const entry of dm) {
    const R = entry.R | 0;
    const O = entry["Ø"] | 0;
    const C = entry.C || [];
    let cIdx = 0;

    for (let col = 0; col < nCols; col++) {
      const isNull   = (O >> col) & 1;
      const isRepeat = (R >> col) & 1;
      if (isNull) {
        prev[col] = null;
      } else if (isRepeat) {
        // keep prev[col]
      } else {
        const raw = C[cIdx++];
        if (typeof raw === "number") {
          const dictName = colDict[col];
          const dict = dictName ? dicts[dictName] : null;
          prev[col] = dict ? dict[raw] : raw;
        } else {
          prev[col] = raw;
        }
      }
    }

    rows.push(prev.slice());
  }

  return rows.map((r) => {
    const o = {};
    for (let i = 0; i < nCols; i++) o[colNames[i]] = r[i];
    return o;
  });
}
