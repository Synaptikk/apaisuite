// theme_boot.js
//
// Applies the saved theme to <html> BEFORE any stylesheet loads, so a
// dark-preference user does not get a flash of the light theme on every open.
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
// localStorage is the fast path. app.js later reads chrome.storage.sync and
// may correct this if the user toggled the theme on another device.
(function () {
  try {
    var saved = localStorage.getItem("shell.theme") || "system";
    var resolved = saved;
    if (saved === "system") {
      resolved = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    document.documentElement.setAttribute("data-theme", resolved);
  } catch (e) { /* private mode / storage disabled — fall through to CSS defaults */ }
})();
