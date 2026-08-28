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
  TIME_SLOTS, TASK_SHORTCUTS, TASK_LABELS, resolveShortcut, dayName, emptyAssociate,
} from "../../data/grid.js";
import { parsePastedTasks, applyPaste, tasksToClipboard, cellsInRange } from "../../data/paste.js";
import { lunchSummary, isWithinShift } from "../../data/lunch.js";

const AUTOSAVE_DELAY_MS = 3000;

// Derived from TASK_SHORTCUTS so the buttons, the legend and the keyboard can
// never disagree about what exists or which key produces it. Adding a task is
// now one line in data/grid.js rather than four edits across two files.
//
// Order follows TASK_SHORTCUTS; the clear action is appended because it is not
// a task.
const TASK_BUTTONS = [
  ...Object.entries(TASK_SHORTCUTS)
    .filter(([key, task]) => task && key.length === 1)
    .map(([key, task]) => [task, TASK_LABELS[task] || task, key.toUpperCase()]),
  ["", "Clear", "X"],
];

function toolbar(ctx) {
  const { date, store, locked, saveStatus = "", saveError = null, suggestionCount = 0 } = ctx;

  return `
    <div class="dm-controls">
      <label class="field">
        <span>Date</span>
        <input class="dm-input" id="dm-asg-date" type="date" value="${esc(date || "")}">
      </label>
      <span class="pill">${esc(dayName(date))}</span>
      <span class="dm-stat-note">Store ${esc(store || "—")}</span>

      <button class="btn" id="dm-asg-add" ${locked ? "disabled" : ""}>Add associate</button>
      <button class="btn" id="dm-asg-print">Print</button>

      ${suggestionCount ? `
        <button class="btn" id="dm-asg-accept-all" ${locked ? "disabled" : ""}>
          Accept ${esc(suggestionCount)} suggestions</button>
        <button class="btn" id="dm-asg-dismiss-all">Dismiss</button>` : ""}

      <button class="btn" id="dm-asg-finalize">${locked ? "Unfinalize" : "Finalize"}</button>
      <span class="pill ${saveError ? "pill-fail" : ""}" id="dm-asg-save"
              ${saveError ? `title="${esc(saveError)}"` : ""}>${esc(saveStatus)}</span>
        ${saveError ? `<span class="status-strip status-strip-error dm-save-reason">${
          esc(saveError)}</span>` : ""}
    </div>`;
}

/**
 * Key legend, doubling as the colour key.
 *
 * The grid tints each task a different colour, but nothing said which was
 * which — you had to fill a cell to find out. The swatch uses the SAME
 * `task-*` class the cells do, so the legend can never drift from the grid.
 */
function legend() {
  return `<div class="dm-legend dm-stat-note">
    Keys: ${TASK_BUTTONS.filter(([t]) => t).map(([task, label, key]) =>
      `<span class="dm-legend-item">` +
        `<span class="dm-legend-swatch task-${esc(task.toLowerCase())}"></span>` +
        // The REAL shortcut, not the label's first letter. That guess printed
        // P for Prep (the key is R) and P again for Pick, so the legend told
        // you to press a key that did something else.
        `<kbd>${esc(key)}</kbd> ${esc(label)}` +
      `</span>`).join("")}
    <span class="dm-legend-item"><kbd>X</kbd> Clear</span>
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

/**
 * Lunch compliance banner.
 *
 * Thresholds come from the standalone app's own suggestion engine — a shift
 * over 6 hours needs a lunch, and it belongs at least 2 slots from either end.
 * See data/lunch.js for the source of those numbers.
 */
function lunchBanner(ctx) {
  const summary = lunchSummary(ctx.assignments);
  if (!summary) return "";
  return `<div class="dm-warn" role="status">
    <strong>Lunch:</strong> ${esc(summary.count)} associate${summary.count === 1 ? "" : "s"} —
    ${esc(summary.text)}.
  </div>`;
}

/**
 * Store / date caption, shown ONLY on paper.
 *
 * On screen the toolbar says which store and day you are looking at, but print
 * hides the toolbar — and a grid of 65 names with no date on it is useless the
 * moment it leaves the printer.
 */
function printTitle(ctx) {
  return `<div class="dm-print-title" hidden>` +
    `Store ${esc(ctx.store || "—")} · ${esc(dayName(ctx.date))} ${esc(ctx.date || "")}` +
  `</div>`;
}

export function render(ctx) {
  if (!ctx.store) return empty("Select a store on the Dashboard first.");

  return toolbar(ctx) + printTitle(ctx) + legend() + lunchBanner(ctx) +
         grid.render(ctx) + mobilePanel(ctx);
}

export function wire(ctx, root) {
  const {
    host, onUiChange, onSetTask, onSetTasks, onSetStatus, onDateChange,
    onAddAssociate, onFinalize, onAcceptAll, onDismissAll, onPrint,
    locked, assignments = [], ui = {},
  } = ctx;

  const offs = [];
  const on = (sel, ev, fn) => {
    const el = root.querySelector(sel);
    el?.addEventListener(ev, fn);
    offs.push(() => el?.removeEventListener(ev, fn));
  };

  // ── Condense the totals once the grid is scrolled ────────────────────────
  //
  // The summary is a reference while you are down among the roster rows, not
  // something being read closely, so it gives its height back: ten pinned rows
  // at 24px hold 268px of the viewport, at 17px they hold 198px.
  //
  // A class on the table, not inline styles, so the sticky offsets follow from
  // the same --dm-summary-h the padding uses. Toggled straight on the DOM
  // rather than through state: this fires on every scroll frame, and a
  // re-render per frame would fight the focus and scroll restoration.
  const scroller = root.querySelector("[data-dm-scroll='grid']");
  const table = root.querySelector(".dm-grid");
  if (scroller && table) {
    const sync = () => table.classList.toggle("is-condensed", scroller.scrollTop > 4);
    scroller.addEventListener("scroll", sync, { passive: true });
    offs.push(() => scroller.removeEventListener("scroll", sync));
    sync();   // a re-render mid-scroll must not come back expanded
  }

  // ── Toolbar ──────────────────────────────────────────────────────────────
  on("#dm-asg-date", "change", (e) => onDateChange?.(e.target.value));
  on("#dm-asg-add", "click", () => {
    const name = prompt("Associate name");
    if (name?.trim()) onAddAssociate?.(emptyAssociate(name.trim().toUpperCase()));
  });
  on("#dm-asg-print",       "click", () => onPrint?.());
  on("#dm-asg-finalize",    "click", () => onFinalize?.(!locked));
  on("#dm-asg-accept-all",  "click", () => onAcceptAll?.());
  on("#dm-asg-dismiss-all", "click", () => onDismissAll?.());

  if (locked) return () => offs.forEach((off) => off());

  // ── Cell selection ───────────────────────────────────────────────────────
  //
  // Hold and drag across cells to select a rectangle, or shift-click to extend
  // from the last anchor. A task key then applies to the whole selection, which
  // is how you fill a block of pick hours without pressing P forty times.
  //
  // During the drag the highlight is painted DIRECTLY onto the DOM rather than
  // pushed through state — a re-render per mousemove would be unusable, and
  // would fight the focus/scroll restore. State is written once, on mouseup.
  // Seeded from state, NOT reset to null. Committing a selection re-renders,
  // which re-runs wire() — so a fresh {anchor:null} here meant the selection
  // was visually highlighted (it comes from ui.gridSel) while the key handler
  // saw nothing selected and filled only the focused cell.
  const sel = {
    anchor: ui.gridSel?.anchor ?? null,
    head:   ui.gridSel?.head   ?? null,
    dragging: false,
  };

  const coords = (el) => ({ name: el.dataset.dmRow, slot: Number(el.dataset.dmSlot) });

  // A Set needs a scalar key, and an associate's name can hold punctuation, so
  // join on a character no roster will ever contain.
  const key = (name, slot) => `${name}␟${slot}`;

  const paint = () => {
    const chosen = new Set(
      cellsInRange(assignments, sel.anchor, sel.head).map((c) => key(c.name, c.slot)));
    for (const c of root.querySelectorAll(".dm-cell")) {
      c.classList.toggle("is-selected",
        chosen.has(key(c.dataset.dmRow, Number(c.dataset.dmSlot))));
    }
  };

  const commit = () => onUiChange?.({ gridSel: sel.anchor && sel.head
    ? { anchor: { ...sel.anchor }, head: { ...sel.head } } : null });

  offs.push(host.ui.delegate(root, "mousedown", ".dm-cell", (e, el) => {
    if (e.button !== 0) return;
    if (window.matchMedia?.("(pointer: coarse)").matches) return;   // touch uses the panel
    // Shift extends the existing rectangle instead of starting a new one.
    if (e.shiftKey && sel.anchor) sel.head = coords(el);
    else { sel.anchor = coords(el); sel.head = coords(el); }
    sel.dragging = true;
    // Stop the browser starting a text selection across the table.
    e.preventDefault();
    el.focus({ preventScroll: true });
    paint();
  }));

  offs.push(host.ui.delegate(root, "mouseover", ".dm-cell", (_e, el) => {
    if (!sel.dragging) return;
    sel.head = coords(el);
    paint();
  }));

  // mouseup on the document, not the grid: releasing outside the table still
  // has to end the drag, or the grid keeps selecting as the pointer moves back.
  const onUp = () => {
    if (!sel.dragging) return;
    sel.dragging = false;
    commit();
  };
  document.addEventListener("mouseup", onUp);
  offs.push(() => document.removeEventListener("mouseup", onUp));

  offs.push(host.ui.delegate(root, "click", ".dm-cell", (_e, el) => {
    const target = coords(el);
    // Touch has no keyboard, so a tap opens the task panel; on desktop the
    // cell simply takes focus and typing fills it.
    if (window.matchMedia?.("(pointer: coarse)").matches) onUiChange?.({ gridTarget: target });
    else el.focus({ preventScroll: true });
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

    if (e.key === "Escape") {
      sel.anchor = null; sel.head = null;
      paint(); commit();
      return;
    }

    const task = resolveShortcut(e.key);
    if (task === undefined) return;   // unmapped key: leave the cell alone
    e.preventDefault();

    // A key applies to the whole selection when there is one, and to the
    // focused cell otherwise.
    // Never write outside a shift, however the cell was reached — a selection
    // dragged past the end of someone's day would otherwise assign hours they
    // are not working.
    // Assigning outside a shift is refused; CLEARING one is always allowed, so
    // stale out-of-shift tasks can be removed by hand.
    const byName = new Map(assignments.map((a) => [a.name, a]));
    const allowed = (c) => task === "" || isWithinShift(byName.get(c.name), c.slot);

    const block = cellsInRange(assignments, sel.anchor, sel.head);
    if (block.length > 1 && block.some((c) => c.name === name && c.slot === slot)) {
      const writable = block.filter(allowed);
      const blocked = block.length - writable.length;
      if (writable.length) onSetTasks?.(writable.map((c) => ({ ...c, task })));
      if (blocked) host.ui.toast(`${blocked} cell(s) skipped — outside the shift.`);
    } else if (allowed({ name, slot })) {
      onSetTask?.(name, slot, task);
    }
  }));

  // ── Copy / paste ─────────────────────────────────────────────────────────
  //
  // The grid is used like a spreadsheet, so it accepts what one puts on the
  // clipboard: tab-separated columns, newline-separated rows, filling right and
  // down from the focused cell.
  //
  // Bound on `root` rather than on the cell, because the clipboard events fire
  // at the focused element and bubble — and the focused element is a <td> that
  // the next render will have replaced.
  const focusedCell = () => {
    const a = document.activeElement;
    return a && root.contains(a) && a.classList?.contains("dm-cell") ? a : null;
  };

  const onPaste = (e) => {
    const cell = focusedCell();
    if (!cell) return;
    const text = e.clipboardData?.getData("text/plain");
    if (!text) return;
    e.preventDefault();

    const { rows, unrecognised } = parsePastedTasks(text);
    if (!rows.length) return;

    const { updates, skipped } = applyPaste(
      assignments, cell.dataset.dmRow, Number(cell.dataset.dmSlot), rows, TIME_SLOTS.length);

    const byName = new Map(assignments.map((a) => [a.name, a]));
    const writable = updates.filter((u) => u.task === "" || isWithinShift(byName.get(u.name), u.slot));
    const offShift = updates.length - writable.length;
    onSetTasks?.(writable);

    if (unrecognised.length) {
      host.ui.toast(`Ignored ${unrecognised.length} unrecognised value(s): ${unrecognised.slice(0, 4).join(", ")}`,
        { kind: "error" });
    }
    if (skipped) host.ui.toast(`${skipped} pasted cell(s) fell outside the grid.`);
    if (offShift) host.ui.toast(`${offShift} pasted cell(s) skipped — outside the shift.`);
    if (writable.length) host.ui.toast(`Pasted ${writable.length} assignment(s).`);
  };

  const onCopy = (e) => {
    const cell = focusedCell();
    if (!cell) return;
    const row = assignments.find((a) => a.name === cell.dataset.dmRow);
    if (!row) return;
    e.preventDefault();
    // Copy the focused cell. Copying its whole row would surprise anyone
    // expecting single-cell behaviour, and the paste side handles blocks
    // regardless of where they came from.
    e.clipboardData?.setData("text/plain",
      tasksToClipboard([[row.slots?.[cell.dataset.dmSlot] ?? ""]]));
  };

  root.addEventListener("paste", onPaste);
  root.addEventListener("copy", onCopy);
  offs.push(() => {
    root.removeEventListener("paste", onPaste);
    root.removeEventListener("copy", onCopy);
  });

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
