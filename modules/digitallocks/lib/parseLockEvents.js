// modules/digitallocks/lib/parseLockEvents.js
//
// Convert a CSV or XLSX import into canonical DigitalLockEvent records.
//
// Public entry: parseLockEventsFile(file) → { rows: DigitalLockEvent[], warnings: string[], headers: string[] }
// Pure helpers (header alias mapping, row normalization, ID derivation)
// are unit-testable from the console without a File object.
//
// Per docs/DIGITAL_LOCKS_QUESTIONS.md::Q2, the exact Power BI export
// column casing may vary slightly. We resolve via case-insensitive alias
// lookup so the parser tolerates "USER ID"/"User ID"/"user id", etc.

import { readXlsxFile } from "./xlsx.js";

// Header aliases. First entry is the canonical name we use internally.
// All comparisons are case- and whitespace-insensitive (see normalizeKey).
const HEADER_ALIASES = {
  store:         ["store", "store number", "store nbr", "store_nbr", "store #"],
  lockName:      ["lock name", "lockname", "lock"],
  zoneName:      ["zone name", "zone"],
  unlockSource:  ["unlock source", "source", "unlocksource"],
  userId:        ["user id", "userid", "associate id", "wmid", "wmlink id"],
  firstName:     ["first name", "firstname"],
  lastName:      ["last name", "lastname"],
  position:      ["position", "role", "job title", "title"],
  eventTime:     ["event_time", "event time", "timestamp", "datetime", "event datetime", "datetime_local", "datetimelocal", "event_datetime"],
};

const REQUIRED_FIELDS = ["store", "lockName", "zoneName", "userId", "eventTime"];

// ── Public ──────────────────────────────────────────────────────────

/**
 * Parse an imported File (.csv or .xlsx) into canonical events.
 * @param {File} file
 * @returns {Promise<{rows: object[], warnings: string[], headers: string[], unknownHeaders: string[]}>}
 */
export async function parseLockEventsFile(file) {
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

// ── CSV parser (handles BOM, quoted fields, escaped quotes "") ──────

export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
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
        if (text[i + 1] === '"') { cell += '"'; i++; }   // escaped quote
        else inQuotes = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") pushCell();
    else if (ch === "\n") pushRow();
    else if (ch === "\r") { /* swallow; \n handles row break */ }
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

// ── Header alias resolution ─────────────────────────────────────────

function normalizeKey(s) {
  return String(s || "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

/**
 * Build a {canonicalField → actualHeader} map from the file's headers.
 * Returns the map AND the list of headers that didn't match any alias
 * (useful for surfacing in the import UI).
 */
export function resolveHeaders(headers) {
  const norm = headers.map((h) => ({ raw: h, key: normalizeKey(h) }));
  const map = {};
  const used = new Set();
  for (const [canon, aliases] of Object.entries(HEADER_ALIASES)) {
    const aliasKeys = aliases.map(normalizeKey);
    const hit = norm.find((n) => aliasKeys.includes(n.key) && !used.has(n.raw));
    if (hit) {
      map[canon] = hit.raw;
      used.add(hit.raw);
    }
  }
  const unknown = norm.filter((n) => !used.has(n.raw)).map((n) => n.raw);
  return { map, unknown };
}

// ── Normalization to canonical events ───────────────────────────────

export function normalize(headers, rawRows, sourceFileName) {
  const warnings = [];
  const { map, unknown } = resolveHeaders(headers);

  const missing = REQUIRED_FIELDS.filter((f) => !map[f]);
  if (missing.length) {
    throw new Error(
      `Import missing required column(s): ${missing.join(", ")}. ` +
      `Found headers: ${headers.join(" | ") || "(none)"}`
    );
  }
  if (unknown.length) warnings.push(`Ignored unrecognized column(s): ${unknown.join(", ")}`);

  const rows = [];
  let unparsedTimestamps = 0;
  let unattributed = 0;
  let blankPosition = 0;

  let rowIndex = 0;
  for (const raw of rawRows) {
    rowIndex++;
    // Pull canonical fields out of the raw row using the alias map.
    const get = (canon) => {
      const h = map[canon];
      const v = h ? raw[h] : "";
      return v == null ? "" : String(v).trim();
    };
    const store        = get("store");
    const lockName     = get("lockName");
    const zoneName     = get("zoneName");
    const unlockSource = get("unlockSource");
    const userId       = get("userId");
    const firstName    = get("firstName");
    const lastName     = get("lastName");
    const position     = get("position");
    const eventTimeRaw = get("eventTime");

    // Skip empties (often Power BI exports trailing blank rows / filter
    // metadata rows like "Applied filters:" / "Column is N").
    if (!store && !lockName && !zoneName && !userId && !eventTimeRaw) continue;

    const { date, hour, day } = parseTimestamp(eventTimeRaw);
    if (eventTimeRaw && !date) unparsedTimestamps++;
    if (!userId) unattributed++;
    if (!position) blankPosition++;

    const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();

    rows.push({
      // Stable, deterministic ID: same row → same id, so re-imports merge
      // with previous review status. Uses the natural key + the original
      // row position. Including rowIndex eliminates birthday-paradox
      // collisions on the 32-bit DJB2 hash at the event volumes this tool
      // targets (≥30% collision probability at 50k events without it),
      // while still preserving stability across re-imports of an unchanged
      // file. Never includes the import timestamp or file name.
      id: makeEventId({ store, userId, lockName, zoneName, eventTimeRaw, rowIndex }),

      store,
      lockName,
      zoneName,
      unlockSource,
      userId,
      firstName,
      lastName,
      fullName,
      position,

      eventTime:  date ? date.toISOString() : eventTimeRaw, // preserve original if unparseable
      eventTimeRaw,
      eventDate:  day,
      eventHour:  hour,

      // Risk fields populated downstream by riskScoring.scoreEvents.
      riskScore:   0,
      riskLevel:   "Normal",
      riskReasons: [],

      // Review fields are merged from the status overlay at render time
      // (lib/statusStore.js). Defaults shown here are the "no overlay" state.
      reviewStatus:  "active",
      reviewerNotes: "",
      clearedAt:     null,
      clearedReason: null,

      importedAt:     null,        // set by db.putImport before persistence
      sourceFileName,
    });
  }

  if (unparsedTimestamps > 0) warnings.push(`${unparsedTimestamps} row(s) had an unparseable Event_time and will not be scored on time-of-day rules.`);
  if (unattributed > 0)       warnings.push(`${unattributed} row(s) had no USER ID and will be marked as unattributed.`);
  if (blankPosition > 0)      warnings.push(`${blankPosition} row(s) had no Position and will skip role/zone mismatch scoring.`);

  return { rows, warnings, headers, unknownHeaders: unknown, headerMap: map };
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Parse Power BI's typical timestamp formats. Returns store-local Date.
 * Observed shapes:
 *   "2026-05-13 09:02:02.000"
 *   "2026-05-13T09:02:02"
 *   "05/13/2026 09:02:02 AM"
 *   "2026-05-13" (date only)
 */
export function parseTimestamp(s) {
  if (!s) return { date: null, hour: null, day: null };
  let mm = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (mm) {
    const d = new Date(Date.UTC(+mm[1], +mm[2] - 1, +mm[3], +mm[4], +mm[5], +mm[6]));
    return { date: d, hour: d.getUTCHours(), day: dayKey(d) };
  }
  mm = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (mm) {
    const d = new Date(Date.UTC(+mm[1], +mm[2] - 1, +mm[3]));
    return { date: d, hour: null, day: dayKey(d) };
  }
  mm = String(s).match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2})(?:\s*(AM|PM))?/i);
  if (mm) {
    let h = +mm[4];
    const ampm = (mm[7] || "").toUpperCase();
    if (ampm === "PM" && h < 12) h += 12;
    if (ampm === "AM" && h === 12) h = 0;
    const d = new Date(Date.UTC(+mm[3], +mm[1] - 1, +mm[2], h, +mm[5], +mm[6]));
    return { date: d, hour: d.getUTCHours(), day: dayKey(d) };
  }
  // Last resort: let Date try. Inconsistent across browsers, so we accept
  // only finite results.
  const d = new Date(s);
  if (Number.isFinite(d?.getTime())) {
    return { date: d, hour: d.getUTCHours(), day: dayKey(d) };
  }
  return { date: null, hour: null, day: null };
}

function dayKey(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Stable event ID — same row always produces the same id so re-imports
 * preserve existing review status. The natural-key DJB2 hash alone has a
 * ~30% birthday-collision probability at 50k events; rowIndex (the 1-based
 * position of this row in its source file) is added as a tiebreaker. The
 * combination remains stable across re-imports of an unchanged file but is
 * not stable across files that re-order the same logical events. For V1
 * that tradeoff is acceptable — Power BI exports for the same date range
 * preserve row order in practice.
 */
export function makeEventId({ store, userId, lockName, zoneName, eventTimeRaw, rowIndex }) {
  const key = `${store}|${userId}|${lockName}|${zoneName}|${eventTimeRaw}`;
  const hash = djb2(key).toString(36);
  return rowIndex != null ? `evt_${hash}_${rowIndex}` : `evt_${hash}`;
}

function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h;
}
