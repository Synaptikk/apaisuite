// modules/digitalmetrics/lib/pages/assignments/index.js
//
// The Assignments tab: toolbar, grid, keyboard entry, mobile task panel,
// suggestions, finalise, autosave and print.
//
// Uses the store selected on the Dashboard — there is deliberately no second
// store selector, because two selectors that can disagree is a bug generator.

import { esc, empty } from "../_shared.js";
import * as grid from "./grid.js";
import {
  TIME_SLOTS, resolveShortcut, dayName, emptyAssociate,
} from "../../data/grid.js";

const AUTOSAVE_DELAY_MS = 3000;

const TASK_BUTTONS = [
  ["PICK", "Pick"], ["DISP", "Disp"], ["STAGE", "Stage"], ["PREP", "Prep"],
  ["GMD", "GMD"], ["IP", "IP"], ["EXC", "Exc"], ["L", "Lunch"], ["B", "Break"],
  ["", "Clear"],
];

function toolbar(ctx) {
  const { date, store, locked, saveStatus = "", suggestionCount = 0 } = ctx;

  return `
    <div class="dm-controls">
      <label class="field">
        <span>Date</span>
        <input class="dm-input" id="dm-asg-date" type="date" value="${esc(date || "")}">
      </label>
      <span class="pill">${esc(dayName(date))}</span>
      <span class="dm-stat-note">Store ${esc(store || "—")}</span>

      <button class="btn" id="dm-asg-add" ${locked ? "disabled" : ""}>Add associate</button>
      <button class="btn" id="dm-asg-import">Import schedule</button>
      <button class="btn" id="dm-asg-print">Print</button>

      ${suggestionCount ? `
        <button class="btn" id="dm-asg-accept-all" ${locked ? "disabled" : ""}>
          Accept ${esc(suggestionCount)} suggestions</button>
        <button class="btn" id="dm-asg-dismiss-all">Dismiss</button>` : ""}

      <button class="btn" id="dm-asg-finalize">${locked ? "Unfinalize" : "Finalize"}</button>
      <span class="pill" id="dm-asg-save">${esc(saveStatus)}</span>
    </div>`;
}

function legend() {
  return `<div class="dm-legend dm-stat-note">
    Keys: ${TASK_BUTTONS.filter(([t]) => t).map(([task, label]) =>
      `<kbd>${esc(label[0].toUpperCase())}</kbd> ${esc(label)}`).join(" · ")}
    · <kbd>X</kbd> Clear
  </div>`;
}

/** Bottom sheet for touch, where a keyboard is not available. */
function mobilePanel(ctx) {
  const target = ctx.ui?.gridTarget;
  if (!target) return "";

  return `
    <div class="dm-task-panel" role="dialog" aria-label="Choose a task">
      <div class="dm-task-panel-head">
        <strong>${esc(target.name)}</strong>
        <span class="dm-stat-note">${esc(TIME_SLOTS[target.slot])}</span>
        <button class="dm-task-close" id="dm-asg-panel-close" aria-label="Close">✕</button>
      </div>
      <div class="dm-task-buttons">
        ${TASK_BUTTONS.map(([task, label]) =>
          `<button class="dm-task-btn" data-dm-task="${esc(task)}">${esc(label)}</button>`).join("")}
      </div>
    </div>`;
}

export function render(ctx) {
  if (!ctx.store) return empty("Select a store on the Dashboard first.");

  return toolbar(ctx) + legend() + grid.render(ctx) + mobilePanel(ctx);
}

export function wire(ctx, root) {
  const {
    host, onUiChange, onSetTask, onSetStatus, onDateChange,
    onAddAssociate, onFinalize, onImport, onAcceptAll, onDismissAll, onPrint,
    locked,
  } = ctx;

  const offs = [];
  const on = (sel, ev, fn) => {
    const el = root.querySelector(sel);
    el?.addEventListener(ev, fn);
    offs.push(() => el?.removeEventListener(ev, fn));
  };

  // ── Toolbar ──────────────────────────────────────────────────────────────
  on("#dm-asg-date", "change", (e) => onDateChange?.(e.target.value));
  on("#dm-asg-add", "click", () => {
    const name = prompt("Associate name");
    if (name?.trim()) onAddAssociate?.(emptyAssociate(name.trim().toUpperCase()));
  });
  on("#dm-asg-import",      "click", () => onImport?.());
  on("#dm-asg-print",       "click", () => onPrint?.());
  on("#dm-asg-finalize",    "click", () => onFinalize?.(!locked));
  on("#dm-asg-accept-all",  "click", () => onAcceptAll?.());
  on("#dm-asg-dismiss-all", "click", () => onDismissAll?.());

  if (locked) return () => offs.forEach((off) => off());

  // ── Cell selection ───────────────────────────────────────────────────────
  offs.push(host.ui.delegate(root, "click", ".dm-cell", (_e, el) => {
    const target = { name: el.dataset.dmRow, slot: Number(el.dataset.dmSlot) };
    // Touch has no keyboard, so a tap opens the task panel; on desktop the
    // cell simply takes focus and typing fills it.
    if (window.matchMedia?.("(pointer: coarse)").matches) onUiChange?.({ gridTarget: target });
    else el.focus();
  }));

  offs.push(host.ui.delegate(root, "keydown", ".dm-cell", (e, el) => {
    const name = el.dataset.dmRow;
    const slot = Number(el.dataset.dmSlot);

    // Arrow keys move between cells; the grid is a spreadsheet, not a form.
    const move = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (move !== undefined) {
      e.preventDefault();
      root.querySelector(`.dm-cell[data-dm-row="${CSS.escape(name)}"][data-dm-slot="${slot + move}"]`)?.focus();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const cells = [...root.querySelectorAll(`.dm-cell[data-dm-slot="${slot}"]`)];
      const here  = cells.findIndex((c) => c.dataset.dmRow === name);
      cells[here + (e.key === "ArrowDown" ? 1 : -1)]?.focus();
      return;
    }

    const task = resolveShortcut(e.key);
    if (task === undefined) return;   // unmapped key: leave the cell alone
    e.preventDefault();
    onSetTask?.(name, slot, task);
  }));

  // ── Mobile task panel ────────────────────────────────────────────────────
  offs.push(host.ui.delegate(root, "click", "[data-dm-task]", (_e, el) => {
    const target = ctx.ui?.gridTarget;
    if (!target) return;
    onSetTask?.(target.name, target.slot, el.dataset.dmTask);
    onUiChange?.({ gridTarget: null });
  }));
  on("#dm-asg-panel-close", "click", () => onUiChange?.({ gridTarget: null }));

  // ── Status ───────────────────────────────────────────────────────────────
  offs.push(host.ui.delegate(root, "click", "[data-dm-status]", (_e, el) => {
    onSetStatus?.(el.dataset.dmStatus, el.dataset.dmStatusKey);
  }));

  return () => offs.forEach((off) => off());
}

export { AUTOSAVE_DELAY_MS };
