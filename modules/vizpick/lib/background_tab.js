// Alarm workers have no implicit current window. Do not open a new browser
// window just to refresh; use an existing normal window or retry later.
export async function createCaptureTab(url) {
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  const target = windows.find((w) => w.focused) || windows[0];
  if (target?.id == null) throw new Error("No browser window is open. VizPick will retry when a browser window is available.");
  return chrome.tabs.create({ url, active: false, windowId: target.id });
}
