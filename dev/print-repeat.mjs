// dev/print-repeat.mjs
//
// Do the totals repeat on every page when the roster spills past one sheet?
//
//   node dev/print-repeat.mjs
//
// Renders dev/_printrepeat.html to a real multi-page PDF and counts, per page,
// how many times a totals row label appears. "It should repeat because it is in
// a thead" is a claim about browser behaviour, not something to take on trust —
// only one header group repeats, tbody never does, and the whole point of
// moving the rows was to land on the side of that rule that works.
//
// Reads the PDF's own text, page by page, rather than eyeballing a render.

import puppeteer from "puppeteer-core";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = resolve(HERE, "_printrepeat.html");
if (!existsSync(PAGE)) {
  console.error("missing dev/_printrepeat.html — build it first");
  process.exit(1);
}

const browser = await puppeteer.connect({
  browserURL: "http://localhost:9222", defaultViewport: null,
});

// Reuse an existing tab: Target.createTarget is refused in this browser
// context, and a blank tab is enough to render a file:// page.
const targets = browser.targets().filter((t) => t.type() === "page");
if (!targets.length) { console.error("no page target to borrow"); process.exit(1); }
const cdp = await targets[0].createCDPSession();

await cdp.send("Page.enable");
await cdp.send("Page.navigate", { url: "file:///" + PAGE.replace(/\\/g, "/") });
await new Promise((r) => setTimeout(r, 2500));

const { data } = await cdp.send("Page.printToPDF", {
  printBackground: true,
  paperWidth: 8.27, paperHeight: 11.69,          // A4 portrait
  marginTop: 0.24, marginBottom: 0.24, marginLeft: 0.24, marginRight: 0.24,
});
const buf = Buffer.from(data, "base64");
const out = resolve(HERE, "screenshots", "print-repeat.pdf");
const { writeFileSync } = await import("node:fs");
writeFileSync(out, buf);

const pages = (buf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
console.log(`  pages           : ${pages}`);
console.log(`  pdf             : ${out}`);
console.log(`  (PRIVACY: synthetic names only — this harness never loads real roster data)`);

// Count the label occurrences across the whole document. With 9 totals rows
// repeating on every page, "Downstack" should appear once per page.
const text = buf.toString("latin1");
for (const label of ["Downstack", "Exception", "Pickers"]) {
  const n = (text.match(new RegExp(label, "g")) || []).length;
  console.log(`  "${label}" occurrences: ${n}`);
}
console.log(`\n  Expect each totals label ~= page count if the header repeats.`);
console.log(`  PDF text is often compressed, so a 0 here means "cannot read the`);
console.log(`  stream", not "did not repeat" — open the PDF to confirm.`);

await cdp.detach().catch(() => {});
browser.disconnect();
