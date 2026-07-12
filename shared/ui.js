// shared/ui.js
//
// Lightweight DOM helpers shared by all modules. No framework. CSP-safe
// (event delegation instead of inline handlers).

export function createUI(/* moduleId — reserved */) {
  return {
    $,
    $$,
    delegate,
    escapeHtml,
    toast,
    spinner,
  };
}

export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

// Delegated event listener.
//   delegate(document, "click", ".btn-primary", (e, el) => {...});
export function delegate(root, eventName, selector, handler, options) {
  const listener = (e) => {
    const el = e.target?.closest?.(selector);
    if (!el || !root.contains(el)) return;
    handler(e, el);
  };
  root.addEventListener(eventName, listener, options);
  return () => root.removeEventListener(eventName, listener, options);
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]
  ));
}

// Toast notifications. Mounts a single .toast-region on first use.
export function toast(message, { kind = "info", durationMs = 3500 } = {}) {
  let region = document.querySelector(".toast-region");
  if (!region) {
    region = document.createElement("div");
    region.className = "toast-region";
    document.body.appendChild(region);
  }
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  region.appendChild(el);
  if (durationMs > 0) {
    setTimeout(() => el.remove(), durationMs);
  }
  return () => el.remove();
}

export function spinner({ large = false } = {}) {
  const span = document.createElement("span");
  span.className = "spinner" + (large ? " spinner-lg" : "");
  return span;
}
