// shared/updater_ui.js — Chrome Web Store build stub.
//
// See scripts/stubs/updater.js. The real module renders an "update available"
// pill and downloads the new build's ZIP via chrome.downloads — the part store
// policy actually forbids. A store install updates itself, so there is nothing
// to show.
//
// app.js imports mountUpdaterIndicator unconditionally; this keeps that import
// valid and leaves the placeholder element in app.html empty.

export function mountUpdaterIndicator(_hostEl) {
  return () => {};   // real one returns an unsubscribe; callers may invoke it
}
