// theme_boot.js
//
// Applies the saved theme AND layout to <html> BEFORE any stylesheet loads,
// so neither a dark-preference user nor a Preview-layout user gets a flash of
// the wrong look on every open.
//
// WHY THIS IS A FILE AND NOT AN INLINE <script>
// --------------------------------------------
// It was inline in app.html until 2026-08-23, which meant it never ran at all:
// MV3's default page CSP is `script-src 'self'` and the manifest declares no
// override, so Chrome blocked it on every load and logged
//   "Executing inline script violates the following Content Security Policy
//    directive 'script-src 'self''"
// The flash it exists to prevent had therefore been happening the whole time,
// silently — the console error was the only sign, and it looked like noise.
//
// Deliberately NOT type="module": modules are deferred, which would let the
// stylesheets paint first and reintroduce the flash. A classic script in
// <head> before the <link> tags is the point.
//
// localStorage is the fast path for both settings. app.js later reads
// chrome.storage.sync and may correct either if the user toggled it on
// another device.
(function () {
  try {
    var saved = localStorage.getItem("shell.theme") || "system";
    var resolved = saved;
    if (saved === "system") {
      resolved = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    document.documentElement.setAttribute("data-theme", resolved);
  } catch (e) { /* private mode / storage disabled — fall through to CSS defaults */ }

  // Layout is a separate, independent setting (shared/layoutPref.js owns the
  // authoritative validation; duplicated inline here because this is a
  // classic script and cannot import an ES module). Anything other than the
  // literal string "preview" — missing, stale, corrupt — resolves to
  // "current", the layout every existing user is already on.
  try {
    var layout = localStorage.getItem("shell.layout") === "preview" ? "preview" : "current";
    document.documentElement.setAttribute("data-layout", layout);
  } catch (e) { /* private mode / storage disabled — CSS defaults to current */ }

  // Sidebar collapse, third independent setting (shared/sidebarPref.js owns
  // the authoritative validation; duplicated inline here because this is a
  // classic script and cannot import an ES module).
  //
  // Pre-paint matters more here than for theme: the sidebar width is a grid
  // COLUMN, so applying it after first paint reflows the entire viewport —
  // the whole page visibly jumps sideways on every open.
  try {
    var sidebar = localStorage.getItem("shell.sidebar") === "collapsed" ? "collapsed" : "expanded";
    document.documentElement.setAttribute("data-sidebar", sidebar);
  } catch (e) { /* CSS defaults to expanded */ }
})();
