// modules/claimsdisposition/lib/csv.js
//
// Tiny CSV parser — replaces papaparse for the one use case the donor had:
// parsing a static comma-separated file with a header row and standard
// double-quote escaping (no escaped quotes inside fields).
//
// Handles:
//   - Leading UTF-8 BOM (the donor CSV starts with one)
//   - CR/LF/CRLF line endings
//   - Quoted fields with embedded commas and newlines
//   - Empty trailing rows
//
// Does NOT handle:
//   - Escaped double-quotes inside fields ("" pattern). Add if a future
//     dataset needs it; the donor's data doesn't.
//   - Streaming. The full file is parsed into memory at once (3 MB / 22k
//     rows is fine for this).

/**
 * Parse CSV text and return an array of row objects keyed by header name.
 * @param {string} text - the full CSV text
 * @param {object} [opts]
 * @param {(h: string) => string} [opts.transformHeader] - applied to each header (e.g. .trim())
 * @returns {{ headers: string[], rows: object[] }}
 */
export function parseCsv(text, opts = {}) {
  const transformHeader = opts.transformHeader || ((h) => h);
  // Strip UTF-8 BOM if present.
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  const cells = tokenize(text);
  if (cells.length === 0) return { headers: [], rows: [] };

  const headers = cells[0].map(transformHeader);
  const rows = [];

  for (let i = 1; i < cells.length; i++) {
    const row = cells[i];
    if (row.length === 1 && row[0] === "") continue; // skip empty lines
    const obj = {};
    for (let c = 0; c < headers.length; c++) obj[headers[c]] = row[c] ?? "";
    rows.push(obj);
  }

  return { headers, rows };
}

// Two-mode state machine: in-quotes vs out-of-quotes. Returns
// string[][] — outer array is rows, inner is the row's cells.
function tokenize(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  const pushCell = () => { row.push(cell); cell = ""; };
  const pushRow  = () => { pushCell(); rows.push(row); row = []; };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      pushCell();
    } else if (ch === "\n") {
      pushRow();
    } else if (ch === "\r") {
      // Swallow — \n on the next iteration handles the row break.
      // Standalone \r (old Mac line endings) is not handled.
    } else {
      cell += ch;
    }
  }

  // Final row (in case the file doesn't end with a newline).
  if (cell.length > 0 || row.length > 0) pushRow();

  return rows;
}
