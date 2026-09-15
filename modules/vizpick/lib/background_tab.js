import { registerSessionTab } from "../../../shared/tabSessions.js";

// Longer than anything that can legitimately still be using a capture tab:
// sw_keepalive releases the worker at 35 min and tableau_lock evicts a holder
// at 30. Past this a registered capture tab has no live owner.
export const CAPTURE_TAB_IDLE_MS = 40 * 60_000;

// Alarm workers have no implicit current window. Do not open a new browser
// window just to refresh; use an existing normal window or retry later.
//
// Every capture tab is registered with the suite tab reaper
// (shared/tabSessions.js, swept by the service worker's _suite_tabreap alarm).
// The captures still close their own tabs in `finally`; the registration is for
// when that never runs. Observed 2026-09-15: overnight, Edge froze the hidden
// tabs, executeScript into a frozen tab never settled, the crawl hung until the
// keep-alive released and Chrome killed the worker — and 46 VizPick Details
// tabs were left open by morning, about three per auto-check. A tab the capture
// closed normally is simply dropped from the registry on the next sweep.
export async function createCaptureTab(url) {
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  const target = windows.find((w) => w.focused) || windows[0];
  if (target?.id == null) throw new Error("No browser window is open. VizPick will retry when a browser window is available.");
  const tab = await chrome.tabs.create({ url, active: false, windowId: target.id });
  if (tab?.id != null) {
    await registerSessionTab("vizpick", tab.id, { idleMs: CAPTURE_TAB_IDLE_MS }).catch(() => {});
  }
  return tab;
}
