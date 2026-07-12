try {
  const m = await import("file:///C:/Users/ses008s.s01458/Desktop/APAISuite/unified-extension-suite/modules/livedashboard/view.js");
  console.log("import ok, keys:", Object.keys(m));
} catch (e) {
  console.log("import failed:", e.message);
  console.log(e.stack?.slice(0, 2000));
}
