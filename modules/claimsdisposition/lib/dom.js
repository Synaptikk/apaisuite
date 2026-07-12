// modules/claimsdisposition/lib/dom.js
//
// Tiny DOM helper used by every component factory. Replaces React.createElement
// for the vanilla port. About 25 lines — deliberately small. We are NOT
// reimplementing JSX, just making element construction terse.
//
// Usage:
//   import { h, clear } from "../lib/dom.js";
//
//   const card = h("div", { class: "cd-card", onClick: () => ... },
//     h("div", { class: "cd-card-title" }, "Total Disposals"),
//     h("div", { class: "cd-stat" }, value),
//   );

/**
 * Create a DOM element.
 * @param {string} tag
 * @param {object|null} [props]
 *   - `class` / `className`           → sets element.className
 *   - `style` (object)                → Object.assign(el.style, ...)
 *   - `dataset` (object)              → Object.assign(el.dataset, ...)
 *   - `onX` (function)                → addEventListener("x", fn)
 *   - everything else                 → setAttribute (skipped if false/null)
 *   - value === true                  → boolean attribute (e.g. disabled)
 * @param  {...any} children          DOM nodes, strings, numbers, arrays, or null/false (ignored).
 * @returns {HTMLElement}
 */
export function h(tag, props = null, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class" || k === "className") { el.className = v; continue; }
      if (k === "style"   && typeof v === "object") { Object.assign(el.style, v); continue; }
      if (k === "dataset" && typeof v === "object") { Object.assign(el.dataset, v); continue; }
      if (k.startsWith("on") && typeof v === "function") {
        el.addEventListener(k.slice(2).toLowerCase(), v);
        continue;
      }
      if (v === true) { el.setAttribute(k, ""); continue; }
      el.setAttribute(k, String(v));
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Remove all children from a node — faster than innerHTML = "". */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Replace all children of `node` with one or more new children. */
export function replace(node, ...children) {
  clear(node);
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
