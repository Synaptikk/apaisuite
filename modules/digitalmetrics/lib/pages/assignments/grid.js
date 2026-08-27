// modules/digitalmetrics/lib/pages/assignments/grid.js
//
// The daily assignment grid: one row per associate, 17 hourly columns.
//
// Rendering notes that matter:
//   • Cells inside an associate's shift are tinted, so an empty cell that
//     needs filling looks different from one that is simply outside the shift.
//   • An empty in-shift cell shows its suggestion in a muted style. It is a
//     proposal, not an assignment, and must never look like one.
//   • The grid is wide by nature; it scrolls inside its own container with the
//     time header and the name column pinned.

import { esc } from "../_shared.js";
import { inRange } from "../../data/paste.js";
import { isWithinShift, lunchIssue } from "../../data/lunch.js";
import {
  TIME_SLOTS, SUMMARY_TASKS, summarise, fillPercentage, isHalfSlot,
} from "../../data/grid.js";

const STATUSES = [
  { key: "tardy",  label: "T", title: "Tardy" },
  { key: "absent", label: "A", title: "Absent" },
];

function cell(assoc, idx, suggestions, locked, selected) {
  const task       = assoc.slots?.[idx] || "";
  const suggestion = !task ? suggestions[assoc.name]?.[idx] : null;

  const inShift = typeof assoc.shiftStart === "number"
                && typeof assoc.shiftEnd === "number"
                && idx >= assoc.shiftStart && idx < assoc.shiftEnd;

  const classes = [
    "dm-cell",
    inShift ? "in-shift" : "",
    selected ? "is-selected" : "",
    task ? `task-${esc(task.toLowerCase())}` : "",
    suggestion ? "is-suggested" : "",
    isHalfSlot(assoc, idx) ? "is-half" : "",
  ].filter(Boolean).join(" ");

  const content = task
    ? esc(task)
    : suggestion
      ? `<span class="dm-suggestion-hint" title="${esc(suggestion.confidence)}% of recent days">${
          esc(suggestion.task)}</span>`
      : "";

  // Outside the shift there is nothing to ASSIGN — the associate is not here.
  // The cell stays focusable though, because CLEARING must always be possible:
  // days written before this rule existed hold tasks out there, and a cell you
  // cannot reach is a cell you cannot fix. index.js enforces "clear only".
  const editable = !locked;

  return `<td class="${classes}" data-dm-row="${esc(assoc.name)}" data-dm-slot="${idx}"
             ${editable ? 'tabindex="0"' : ""} role="gridcell"
             ${inShift ? "" : 'data-dm-offshift="1" aria-disabled="true"'}>${content}</td>`;
}

function associateRow(assoc, suggestions, locked, isSelected) {
  const status = assoc.status || "";
  const lunch  = lunchIssue(assoc);
  const buttons = STATUSES.map((s) => `
    <button class="dm-status ${status === s.key ? "is-active" : ""}"
            data-dm-status="${esc(assoc.name)}" data-dm-status-key="${esc(s.key)}"
            title="${esc(s.title)}" ${locked ? "disabled" : ""}>${esc(s.label)}</button>`).join("");

  return `<tr class="${[status ? `is-${esc(status)}` : "", lunch ? "has-lunch-issue" : ""].filter(Boolean).join(" ")}">
    <th scope="row" class="dm-name-cell">
      <span class="dm-name">${esc(assoc.name)}${
        lunch ? `<span class="dm-lunch-flag" title="${esc(lunch.message)}" aria-label="${esc(lunch.message)}">!</span>` : ""}</span>
      ${assoc.shiftLabel ? `<span class="dm-stat-note">${esc(assoc.shiftLabel)}</span>` : ""}
      <span class="dm-status-group">${buttons}</span>
    </th>
    ${TIME_SLOTS.map((_, i) => cell(assoc, i, suggestions, locked, isSelected(assoc.name, i))).join("")}
  </tr>`;
}

function summaryRows(assignments, suggestions) {
  const { counts, suggested, estimatedPicks } = summarise(assignments, suggestions);

  const fmt = (total, prop) => (prop > 0 ? `${total} (${prop})` : String(total));

  // The row header carries the task's own tint, so a column of numbers can be
  // traced back to the coloured cells it counts without reading the label.
  // Same `task-*` class the cells and the legend swatches use, so the three
  // cannot drift apart.
  const rows = SUMMARY_TASKS.map(({ key, task, label }) => `
    <tr class="dm-summary-row task-${esc(String(task).toLowerCase())}">
      <th scope="row">${esc(label)}</th>
      ${counts[key].map((n, i) =>
        `<td>${esc(fmt(n, suggested[key][i]))}</td>`).join("")}
    </tr>`);

  // Estimated picks sits directly under Pickers, which is the number it is
  // derived from.
  rows.splice(1, 0, `
    <tr class="dm-summary-row is-derived">
      <th scope="row">Est. Picks</th>
      ${estimatedPicks.map((n) => `<td>${esc(n)}</td>`).join("")}
    </tr>`);

  return rows.join("");
}

export function render(ctx) {
  const { assignments = [], suggestions = {}, locked = false, ui = {} } = ctx;

  // Selection is two corners (see data/paste.js::inRange), resolved against the
  // CURRENT row order on every render so it survives the grid reloading.
  const order = assignments.map((a) => a.name);
  const { anchor, head } = ui.gridSel || {};
  const isSelected = (name, slot) => inRange(order, anchor, head, name, slot);

  if (!assignments.length) {
    // "Import a schedule" was the old advice and that button no longer exists,
    // so it sent you looking for something that had been removed. Say what is
    // actually true: which dates the Workforce Planning pull has covered, and
    // that Sync is what extends it.
    const dates = ctx.scheduleDates;
    const covered = Array.isArray(dates) && dates.length
      ? `Workforce Planning data covers ${dates[0]} to ${dates[dates.length - 1]}` +
        (dates.length > 2 ? ` (${dates.length} days)` : "")
      : "No Workforce Planning schedules have been pulled for this store yet";

    return `<div class="dm-todo">
      <strong>No schedule for ${esc(ctx.date || "this date")}.</strong>
      <div class="dm-stat-note">${esc(covered)}.</div>
      <div class="dm-stat-note">The pull captures whichever week the scheduler
        page is showing, so a date outside it has nothing stored. Open that week
        in Workforce Planning and press Sync, or add associates by hand.</div>
    </div>`;
  }

  const fill = Math.round(fillPercentage(assignments));

  return `
    <div class="dm-grid-meta">
      <span class="pill ${locked ? "pill-ok" : ""}">${
        locked ? "Finalized" : `${fill}% filled`}</span>
      <span class="dm-stat-note">${assignments.length} associates</span>
    </div>
    <div class="dm-grid-scroll" data-dm-scroll="grid">
      <table class="dm-grid" role="grid">
        <thead>
          <tr>
            <th class="dm-name-cell">Associate</th>
            ${TIME_SLOTS.map((s) => `<th>${esc(s)}</th>`).join("")}
          </tr>
        </thead>
        <!-- Totals live at the TOP, sticky under the time header — same as the
             standalone app. In a tfoot they sat below 60 rows of roster, so
             the one thing you check while assigning was the one thing you had
             to scroll to find. -->
        <tbody class="dm-summary">${summaryRows(assignments, suggestions)}</tbody>
        <tbody>
          ${assignments.map((a) => associateRow(a, suggestions, locked, isSelected)).join("")}
        </tbody>
      </table>
    </div>`;
}
