// modules/digitalmetrics/lib/data/paste.js
//
// Turn pasted clipboard text into a block of task assignments. Pure.
//
// The grid is used like a spreadsheet, so it should accept what a spreadsheet
// puts on the clipboard: rows separated by newlines, cells by tabs. Pasting
// then fills right and down from the focused cell, exactly as Excel does.
//
// Accepted per cell, case-insensitively:
//   · a task name        PICK, DISP, STAGE, PREP, QC, DRV, DS, TRN, IP, EXC, L, B, 30
//   · a shortcut letter  p, d, s, r, g, i, e, l, b, 3   (the grid's own keys)
//   · empty              clears the cell
// Anything else is reported as unrecognised rather than silently written — a
// paste that half-lands is worse than one that refuses.

import { TASK_SHORTCUTS } from "./grid.js";

/** Every task the grid can hold, derived from the shortcut table. */
export const TASKS = [...new Set(Object.values(TASK_SHORTCUTS).filter(Boolean))];

/**
 * One clipboard cell → a task, "" to clear, or undefined if unrecognised.
 */
export function normaliseTask(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";

  const upper = s.toUpperCase();
  if (TASKS.includes(upper)) return upper;

  // Single-character shortcuts, so a column of "p" pastes as PICK.
  if (s.length === 1) {
    const mapped = TASK_SHORTCUTS[s] ?? TASK_SHORTCUTS[s.toLowerCase()];
    if (mapped !== undefined) return mapped;
  }

  // Common spreadsheet spellings of "nothing here".
  if (["-", "—", ".", "N/A", "NA", "NONE"].includes(upper)) return "";

  return undefined;
}

/**
 * Parse clipboard text into a rectangular block of tasks.
 *
 * @returns { rows: string[][], unrecognised: string[] }
 *
 * `rows` is always rectangular — short rows are padded with null, meaning
 * "leave this cell alone" rather than "clear it". Pasting a 3-wide block over
 * a 5-wide selection must not wipe the two columns it never mentioned.
 */
export function parsePastedTasks(text) {
  const raw = String(text ?? "").replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  if (!raw) return { rows: [], unrecognised: [] };

  const lines = raw.split("\n");
  const unrecognised = [];
  const rows = lines.map((line) =>
    line.split("\t").map((cell) => {
      const t = normaliseTask(cell);
      if (t === undefined) {
        const shown = String(cell).trim();
        if (shown && !unrecognised.includes(shown)) unrecognised.push(shown);
        return null;              // leave the cell as it was
      }
      return t;
    }));

  const width = Math.max(...rows.map((r) => r.length));
  return {
    rows: rows.map((r) => [...r, ...Array(width - r.length).fill(null)]),
    unrecognised,
  };
}

/**
 * Apply a parsed block to the grid.
 *
 * @param assignments  current grid rows (order matters — it is what the user
 *                     sees, so paste follows visible order)
 * @param startName    row the focused cell is on
 * @param startSlot    slot the focused cell is in
 * @param block        rows from parsePastedTasks
 * @param slotCount    number of columns in the grid
 *
 * @returns { updates: [{name, slot, task}], skipped }
 *
 * Returns the edits rather than mutating: the caller owns state, and this
 * stays testable without a DOM.
 */
export function applyPaste(assignments, startName, startSlot, block, slotCount) {
  const order = (assignments || []).map((a) => a.name);
  const startRow = order.indexOf(startName);
  if (startRow < 0) return { updates: [], skipped: 0 };

  const updates = [];
  let skipped = 0;

  block.forEach((cells, r) => {
    const name = order[startRow + r];
    // Past the last associate: a paste taller than the grid stops rather than
    // wrapping onto someone unrelated.
    if (name === undefined) { skipped += cells.filter((c) => c !== null).length; return; }

    cells.forEach((task, c) => {
      if (task === null) return;               // untouched by this paste
      const slot = Number(startSlot) + c;
      if (!Number.isFinite(slot) || slot < 0 || slot >= slotCount) { skipped++; return; }
      updates.push({ name, slot, task });
    });
  });

  return { updates, skipped };
}

/**
 * Text to put on the clipboard for a block of cells, so a copy out of the grid
 * pastes back into it — and into a spreadsheet — unchanged.
 */
export function tasksToClipboard(rows) {
  return (rows || []).map((r) => r.map((c) => c ?? "").join("\t")).join("\n");
}

/**
 * Every cell in the rectangle between two corners.
 *
 * Selection is stored as two corners rather than a set of cells so it survives
 * a re-render: rows move as the grid reloads, and a frozen set of coordinates
 * would drift. Rows are resolved through the CURRENT visible order each time.
 *
 * @returns [{ name, slot }] in visible order, or [] if either corner is gone.
 */
export function cellsInRange(assignments, anchor, head) {
  if (!anchor || !head) return [];
  const order = (assignments || []).map((a) => a.name);
  const r1 = order.indexOf(anchor.name);
  const r2 = order.indexOf(head.name);
  if (r1 < 0 || r2 < 0) return [];

  const [rowFrom, rowTo] = r1 <= r2 ? [r1, r2] : [r2, r1];
  const s1 = Number(anchor.slot);
  const s2 = Number(head.slot);
  if (!Number.isFinite(s1) || !Number.isFinite(s2)) return [];
  const [slotFrom, slotTo] = s1 <= s2 ? [s1, s2] : [s2, s1];

  const out = [];
  for (let r = rowFrom; r <= rowTo; r++) {
    for (let s = slotFrom; s <= slotTo; s++) out.push({ name: order[r], slot: s });
  }
  return out;
}

/** Is this cell inside the selection rectangle? Cheap enough for every cell. */
export function inRange(order, anchor, head, name, slot) {
  if (!anchor || !head) return false;
  const r1 = order.indexOf(anchor.name);
  const r2 = order.indexOf(head.name);
  const r  = order.indexOf(name);
  if (r1 < 0 || r2 < 0 || r < 0) return false;
  if (r < Math.min(r1, r2) || r > Math.max(r1, r2)) return false;
  const s = Number(slot);
  return s >= Math.min(anchor.slot, head.slot) && s <= Math.max(anchor.slot, head.slot);
}
