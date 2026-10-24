// modules/safetyagent/content/camp_paint.js — makes CAMP's own "edit tiles"
// grid (camp.walmart.com camera modal) paint with hold-and-drag instead of
// one click per tile.
//
// CAMP renders each tile as <button data-tile-label="I7" aria-pressed> whose
// React onClick toggles it. We drive those same buttons, so CAMP's state,
// dirty-tracking and Publish stay entirely its own:
//   - pointerdown on a tile picks the stroke's direction from that tile
//     (unblocked → paint, blocked → erase) and applies it;
//   - every tile the pointer crosses while held is brought to that state by
//     calling .click() on it (only when it differs, so nothing flips back);
//   - the browser's own trusted click after a mouse press is swallowed, or it
//     would undo the first tile. Keyboard activation (detail 0) passes through.
// Shift while dragging forces erase. Isolated world is enough: the buttons and
// their click handlers are reachable from the DOM.

(() => {
  if (window.__apaiCampPaint) return;
  window.__apaiCampPaint = true;

  const TILE = "button[data-tile-label]";
  const STEP_PX = 6;
  let stroke = null;   // { blocked: boolean, last: Element|null, x, y }

  const isBlocked = (b) => b.getAttribute("aria-pressed") === "true";

  function tileAt(x, y) {
    // The grid-line SVG sits over the buttons; look through the whole stack.
    for (const el of document.elementsFromPoint(x, y)) {
      const b = el.closest?.(TILE);
      if (b) return b;
    }
    return null;
  }

  function apply(b) {
    if (!b || b === stroke.last) return;
    stroke.last = b;
    if (!b.disabled && isBlocked(b) !== stroke.blocked) b.click();
  }

  document.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const b = e.target.closest?.(TILE);
    if (!b) return;
    e.preventDefault();   // no text selection / image drag while painting
    stroke = { blocked: e.shiftKey ? false : !isBlocked(b), last: null, x: e.clientX, y: e.clientY };
    apply(b);
  }, true);

  document.addEventListener("pointermove", (e) => {
    if (!stroke) return;
    if (!(e.buttons & 1)) { stroke = null; return; }
    // Fast drags skip tiles between samples; walk each segment in small steps.
    const pts = e.getCoalescedEvents?.() ?? [];
    for (const p of pts.length ? pts : [e]) {
      const dx = p.clientX - stroke.x, dy = p.clientY - stroke.y;
      const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / STEP_PX));
      for (let i = 1; i <= n; i++) apply(tileAt(stroke.x + (dx * i) / n, stroke.y + (dy * i) / n));
      stroke.x = p.clientX; stroke.y = p.clientY;
    }
  }, true);

  const end = () => { stroke = null; };
  document.addEventListener("pointerup", end, true);
  document.addEventListener("pointercancel", end, true);

  document.addEventListener("click", (e) => {
    if (e.isTrusted && e.detail > 0 && e.target.closest?.(TILE)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);
})();
