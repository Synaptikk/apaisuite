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
import {
  TIME_SLOTS, SUMMARY_TASKS, summarise, fillPercentage, isHalfSlot,
} from "../../data/grid.js";

const STATUSES = [
  { key: "tardy",  label: "T", title: "Tardy" },
  { key: "absent", label: "A", title: "Absent" },
];

function cell(assoc, idx, suggestions, locked) {
  const task       = assoc.slots?.[idx] || "";
  const suggestion = !task ? suggestions[assoc.name]?.[idx] : null;

  const inShift = typeof assoc.shiftStart === "number"
                && typeof assoc.shiftEnd === "number"
                && idx >= assoc.shiftStart && idx < assoc.shiftEnd;

  const classes = [
    "dm-cell",
    inShift ? "in-shift" : "",
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

  return `<td class="${classes}" data-dm-row="${esc(assoc.name)}" data-dm-slot="${idx}"
             ${locked ? "" : 'tabindex="0"'} role="gridcell">${content}</td>`;
}

function associateRow(assoc, suggestions, locked) {
  const status = assoc.status || "";
  const buttons = STATUSES.map((s) => `
    <button class="dm-status ${status === s.key ? "is-active" : ""}"
            data-dm-status="${esc(assoc.name)}" data-dm-status-key="${esc(s.key)}"
            title="${esc(s.title)}" ${locked ? "disabled" : ""}>${esc(s.label)}</button>`).join("");

  return `<tr class="${status ? `is-${esc(status)}` : ""}">
    <th scope="row" class="dm-name-cell">
      <span class="dm-name">${esc(assoc.name)}</span>
      ${assoc.shiftLabel ? `<span class="dm-stat-note">${esc(assoc.shiftLabel)}</span>` : ""}
      <span class="dm-status-group">${buttons}</span>
    </th>
    ${TIME_SLOTS.map((_, i) => cell(assoc, i, suggestions, locked)).join("")}
  </tr>`;
}

function summaryRows(assignments, suggestions) {
  const { counts, suggested, estimatedPicks } = summarise(assignments, suggestions);

  const fmt = (total, prop) => (prop > 0 ? `${total} (${prop})` : String(total));

  const rows = SUMMARY_TASKS.map(({ key, label }) => `
    <tr class="dm-summary-row">
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
  const { assignments = [], suggestions = {}, locked = false } = ctx;

  if (!assignments.length) {
    return `<div class="dm-todo">No roster for this date. Import a schedule or add
            associates to begin.</div>`;
  }

  const fill = Math.round(fillPercentage(assignments));

  return `
    <div class="dm-grid-meta">
      <span class="pill ${locked ? "pill-ok" : ""}">${
        locked ? "Finalized" : `${fill}% filled`}</span>
      <span class="dm-stat-note">${assignments.length} associates</span>
    </div>
    <div class="dm-grid-scroll">
      <table class="dm-grid" role="grid">
        <thead>
          <tr>
            <th class="dm-name-cell">Associate</th>
            ${TIME_SLOTS.map((s) => `<th>${esc(s)}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${assignments.map((a) => associateRow(a, suggestions, locked)).join("")}
        </tbody>
        <tfoot>${summaryRows(assignments, suggestions)}</tfoot>
      </table>
    </div>`;
}
