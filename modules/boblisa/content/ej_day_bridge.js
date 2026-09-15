// modules/boblisa/content/ej_day_bridge.js
//
// Injected programmatically (chrome.scripting.executeScript { files }) into
// the ISOLATED world of an ej.walmart.com tab, right before lib/ej_day.js runs
// its fetch-and-analyze function there. A classic script cannot `import`, so
// it dynamic-imports the pure analysis module through its web-accessible URL
// (manifest.json::web_accessible_resources) and parks it on globalThis for
// the function that follows.
//
// Why analyze in the tab at all: a whole store-day is ~8,000 receipts, about
// 12 MB of text. Returning that through executeScript's result channel hangs
// the service worker; returning the ~40 KB analysis does not.

(async () => {
  if (globalThis.__boblisa) return;
  try {
    const mod = await import(chrome.runtime.getURL("modules/boblisa/lib/pairs.js"));
    globalThis.__boblisa = { analyzeDay: mod.analyzeDay, DEFAULT_OPTS: mod.DEFAULT_OPTS };
  } catch (e) {
    globalThis.__boblisaError = String(e?.message || e);
  }
})();
