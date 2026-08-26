// shared/sidebarPref.js
//
// Validation for the sidebar collapse setting. Separate from theme and layout
// for the same reason those are separate from each other: three independent
// settings must never share a resolution path, or a bug in one silently moves
// another.
//
// Storage shape: chrome.storage.sync["shell.sidebar"] = "expanded" | "collapsed",
// mirrored to localStorage["shell.sidebar"] for the pre-paint fast path in
// theme_boot.js (same pattern as "shell.theme" and "shell.layout").
//
// Collapsed shows module ICONS only, at --shell-sidebar-collapsed-w. That
// token already existed in styles/tokens.css — declared and unused — so the
// width was decided before this file was written.

export const SIDEBAR = Object.freeze({
  EXPANDED: "expanded",
  COLLAPSED: "collapsed",
});

// Anything other than the literal string "collapsed" resolves to "expanded":
// missing, null, malformed, or a value from some future or older build.
// Expanded is the only safe default — it is what every existing user has, and
// nobody should open the suite to a sidebar they did not ask to shrink.
export function resolveSidebarPref(raw) {
  return raw === SIDEBAR.COLLAPSED ? SIDEBAR.COLLAPSED : SIDEBAR.EXPANDED;
}

export function isCollapsed(raw) {
  return resolveSidebarPref(raw) === SIDEBAR.COLLAPSED;
}

/** The state you get by toggling from `raw`. */
export function toggledSidebarPref(raw) {
  return isCollapsed(raw) ? SIDEBAR.EXPANDED : SIDEBAR.COLLAPSED;
}
