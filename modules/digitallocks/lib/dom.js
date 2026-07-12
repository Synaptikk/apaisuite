// modules/digitallocks/lib/dom.js
//
// Tiny DOM helper — same shape as claimsdisposition/lib/dom.js so anyone
// reading both modules sees the same API. Repo convention is to keep this
// helper module-local rather than promote it to shared/ until a second
// consumer asks for the exact same shape (see CLAUDE.md::Shared helper
// inventory).

/**
 * Create a DOM element.
 *   h("div", { class: "dl-card", onClick: fn }, "label", h("span", null, "x"))
 *
 * Props:
 *   class / className → element.className
 *   style (object)    → Object.assign(el.style, ...)
 *   dataset (object)  → Object.assign(el.dataset, ...)
 *   onX (function)    → addEventListener("x", fn)
 *   v === true        → boolean attribute (e.g. disabled)
 *   v == null|false   → skipped
 *   other             → setAttribute(k, String(v))
 *
 * Children: DOM nodes, strings, numbers, arrays (flattened), null/false (skipped).
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

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function replace(node, ...children) {
  clear(node);
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
