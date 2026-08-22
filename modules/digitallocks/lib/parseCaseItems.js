// modules/digitallocks/lib/parseCaseItems.js
//
// Parse a CSV or XLSX case-item mapping file into canonical CaseItemEntry records.
//
// Required columns: zoneName, lockName, upc
// Optional: itemNumber, description, store
//
// UPCs are normalised to 13-digit GTIN-13 (the "wupc" format GScope expects).
// The same file can cover multiple stores — leave `store` blank to treat the
// entry as chain-wide (matched when event.store is not present in the file).

import { readXlsxFile } from "../../../shared/xlsx.js";

const HEADER_ALIASES = {
  zoneName:    ["zone name", "zone", "zonename"],
  lockName:    ["lock name", "lock", "lockname", "case", "section", "fixture"],
  upc:         ["upc", "gtin", "wupc", "barcode", "upc code"],
  itemNumber:  ["item number", "item id", "item#", "itemnumber", "walmart item", "item no"],
  description: ["description", "item name", "name", "product", "product name"],
  store:       ["store", "store number", "store nbr", "store#", "store no"],
};

const REQUIRED_FIELDS = ["zoneName", "lockName", "upc"];

// ── Public ──────────────────────────────────────────────────────────────────

export async function parseCaseItemsFile(file) {
  const name = (file?.name || "").toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xlsm")) {
    const { headers, rows } = await readXlsxFile(file);
    return normalize(headers, rows, file.name);
  }
  if (name.endsWith(".csv") || name.endsWith(".txt") || file?.type === "text/csv") {
    const text = await file.text();
    const { headers, rows } = parseCsv(text);
    return normalize(headers, rows, file.name);
  }
  throw new Error(`Unsupported file type: ${file?.name || "<unnamed>"}. Expected .csv or .xlsx.`);
}

/**
 * Normalise any UPC variant to 13-digit GTIN-13 (leading-zero format).
 * GScope's wupc field uses this format: "0007874211433".
 */
export function normalizeUpc(raw) {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 12) return "0" + digits;          // UPC-A → GTIN-13
  if (digits.length === 13) return digits;                 // already GTIN-13
  if (digits.length === 14) return digits.slice(1);        // GTIN-14, strip check
  if (digits.length < 12)   return digits.padStart(13, "0");
  return digits.slice(-13);
}

/**
 * Given a loaded mapping's items array, return those matching a lock event.
 * Matching is: zoneName + lockName (case-insensitive, whitespace-collapsed),
 * and store must match if present on the mapping entry.
 */
export function lookupCaseItems(items, { zoneName, lockName, store }) {
  const cz = c(zoneName), cl = c(lockName);
  return (items || []).filter((item) => {
    if (c(item.zoneName) !== cz) return false;
    if (c(item.lockName) !== cl) return false;
    if (item.store && store && item.store !== store) return false;
    return true;
  });
}

// ── CSV parser ───────────────────────────────────────────────────────────────

function parseCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = [];
  let row = [], cell = "", inQuotes = false;
  const pushCell = () => { row.push(cell); cell = ""; };
  const pushRow  = () => { pushCell(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false; }
      else cell += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',') pushCell();
    else if (ch === '\n') pushRow();
    else if (ch === '\r') {}
    else cell += ch;
  }
  if (cell.length > 0 || row.length > 0) pushRow();
  if (rows.length === 0) return { headers: [], rows: [] };
  const headers = rows[0].map((h) => h.trim());
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length === 1 && r[0].trim() === "") continue;
    const obj = {};
    for (let c = 0; c < headers.length; c++) obj[headers[c]] = r[c] ?? "";
    out.push(obj);
  }
  return { headers, rows: out };
}

// ── Header resolution ─────────────────────────────────────────────────────────

function normalizeKey(s) {
  return String(s || "").trim().toLowerCase().replace(/[\s_#-]+/g, " ");
}

function resolveHeaders(headers) {
  const norm = headers.map((h) => ({ raw: h, key: normalizeKey(h) }));
  const map = {};
  const used = new Set();
  for (const [canon, aliases] of Object.entries(HEADER_ALIASES)) {
    const aliasKeys = aliases.map(normalizeKey);
    const hit = norm.find((n) => aliasKeys.includes(n.key) && !used.has(n.raw));
    if (hit) { map[canon] = hit.raw; used.add(hit.raw); }
  }
  const unknown = norm.filter((n) => !used.has(n.raw)).map((n) => n.raw);
  return { map, unknown };
}

// ── Normalisation ─────────────────────────────────────────────────────────────

function normalize(headers, rawRows, sourceFileName) {
  const warnings = [];
  const { map, unknown } = resolveHeaders(headers);
  const missing = REQUIRED_FIELDS.filter((f) => !map[f]);
  if (missing.length) {
    throw new Error(
      `Case map missing required column(s): ${missing.join(", ")}. ` +
      `Found headers: ${headers.join(" | ") || "(none)"}`
    );
  }
  if (unknown.length) warnings.push(`Ignored unrecognized column(s): ${unknown.join(", ")}`);

  const rows = [];
  let badUpc = 0;
  for (const raw of rawRows) {
    const get = (field) => {
      const h = map[field];
      const v = h ? raw[h] : "";
      return v == null ? "" : String(v).trim();
    };
    const zoneName    = get("zoneName");
    const lockName    = get("lockName");
    const upcRaw      = get("upc");
    const itemNumber  = get("itemNumber");
    const description = get("description");
    const store       = get("store");

    if (!zoneName && !lockName && !upcRaw) continue;

    const upc = normalizeUpc(upcRaw);
    if (!upc) { badUpc++; continue; }

    rows.push({ zoneName, lockName, upc, itemNumber, description, store });
  }
  if (badUpc > 0) warnings.push(`${badUpc} row(s) skipped — no valid UPC.`);

  return { rows, warnings, headers, sourceFileName };
}

// Collapse whitespace + lowercase for comparison.
function c(s) {
  return String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}
