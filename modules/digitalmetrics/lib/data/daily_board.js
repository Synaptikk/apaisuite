// modules/digitalmetrics/lib/data/daily_board.js
//
// Imports the "Daily Board" workbook — the spreadsheet the store fills in by
// hand — into assignment documents.
//
// Layout of one sheet:
//
//   SATURDAY 1/3/26          ← day header, carries the date
//   Pickers   14  15  20 …   ← summary rows, recomputed on import and ignored
//   Picks   1120 1200 1600 …
//   …
//   Associate  5-6  6-7 …    ← column header row
//   ZEPHYRA  PICK PICK …   ← one row per associate
//
// One sheet per day. The workbook routinely holds a full week plus scratch
// sheets, so sheets that do not match the layout are skipped rather than
// treated as errors.

import { parseXlsxAllSheets } from "../../vendor/xlsx_min.js";
import { TIME_SLOTS } from "./grid.js";

const DAY_HEADER = /^(SUNDAY|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY)\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i;

/** "SATURDAY 1/3/26" → "2026-01-03". */
export function parseDayHeader(text) {
  const m = DAY_HEADER.exec(String(text || "").trim());
  if (!m) return null;

  const [, , month, day, year] = m;
  const y = Number(year) < 100 ? 2000 + Number(year) : Number(year);
  return `${y}-${String(Number(month)).padStart(2, "0")}-${String(Number(day)).padStart(2, "0")}`;
}

/** Index of the row whose first cell is "Associate". */
function headerRowIndex(rows) {
  return rows.findIndex((r) => String(r?.[0] || "").trim().toLowerCase() === "associate");
}

/**
 * Convert one sheet to an assignment document, or null if it isn't a day board.
 */
export function sheetToDay(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;

  // The date lives in the first few rows, above the summary block.
  let date = null;
  for (const row of rows.slice(0, 6)) {
    date = parseDayHeader(row?.[0]);
    if (date) break;
  }
  if (!date) return null;

  const headerIdx = headerRowIndex(rows);
  if (headerIdx === -1) return null;

  // Map each spreadsheet column to a grid slot by its label, rather than
  // assuming column N is slot N — the board has been re-ordered before.
  const header = rows[headerIdx];
  const slotForColumn = new Map();
  header.forEach((label, col) => {
    const idx = TIME_SLOTS.indexOf(String(label || "").trim());
    if (idx !== -1) slotForColumn.set(col, idx);
  });
  if (!slotForColumn.size) return null;

  const associates = [];
  for (const row of rows.slice(headerIdx + 1)) {
    const name = String(row?.[0] || "").trim().toUpperCase();
    if (!name) continue;

    const slots = {};
    for (const [col, slot] of slotForColumn) {
      const task = String(row[col] || "").trim().toUpperCase();
      if (task) slots[slot] = task;
    }
    // A name with no tasks at all is a blank template row, not a person who
    // worked and did nothing.
    if (!Object.keys(slots).length) continue;

    const filled = Object.keys(slots).map(Number).sort((a, b) => a - b);
    associates.push({
      name,
      slots,
      status: null,
      // The board records no shift times, so infer the worked span from the
      // filled cells. Adherence needs a shift window and would otherwise
      // charge every associate for the whole 17-hour day.
      shiftStart: filled[0],
      shiftEnd:   filled.at(-1) + 1,
      shiftLabel: null,
    });
  }

  return associates.length ? { date, associates } : null;
}

/** Whole workbook → one document per recognisable day, oldest first. */
export async function parseDailyBoard(bytes) {
  const res = await parseXlsxAllSheets(bytes);
  if (!res.ok) return { ok: false, reason: res.reason };

  const days = [];
  let skipped = 0;
  for (const sheet of res.sheets) {
    const day = sheetToDay(sheet.rows);
    if (day) days.push(day);
    else skipped++;
  }

  if (!days.length) {
    return { ok: false, reason: "no day boards found — is this the Daily Board workbook?" };
  }

  days.sort((a, b) => a.date.localeCompare(b.date));
  return { ok: true, days, skippedSheets: skipped };
}
