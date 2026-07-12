// dev/snapshot-directory-page.mjs
//
// Open the directory.html URL in a tab via attached Edge, wait for it to
// fully render (it redirects to search-results, which is an SPA), then
// take a screenshot AND dump the rendered DOM's interesting parts so we
// can see what people-search UI (if any) actually exists.

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";

const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1000 });

console.log("→ navigating…");
await page.goto("https://one.walmart.com/content/uswire/en_us/directory.html", {
  waitUntil: "networkidle2", timeout: 30000,
});
await new Promise((r) => setTimeout(r, 3000));   // let any client-side render settle
console.log(`✓ final URL: ${page.url()}`);

await page.screenshot({ path: "directory-screenshot.png", fullPage: true });
console.log("✓ screenshot → directory-screenshot.png");

// Dump every link, button, tab, and any element containing words like
// people/directory/find/profile in its text. That'll tell us where the
// people-search affordance actually lives.
const found = await page.evaluate(() => {
  const out = { links: [], buttons: [], tabs: [], peopleMentions: [] };
  for (const a of document.querySelectorAll("a")) {
    if (!a.offsetParent) continue;
    const t = (a.textContent || "").trim().slice(0, 80);
    const h = a.href;
    if (t) out.links.push({ text: t, href: h });
  }
  for (const b of document.querySelectorAll("button")) {
    if (!b.offsetParent) continue;
    const t = (b.textContent || "").trim().slice(0, 60);
    if (t) out.buttons.push({ text: t, type: b.type, ariaLabel: b.getAttribute("aria-label") });
  }
  for (const t of document.querySelectorAll('[role="tab"], .tab, [data-tab]')) {
    if (!t.offsetParent) continue;
    out.tabs.push({ text: (t.textContent || "").trim().slice(0, 60), role: t.getAttribute("role") });
  }
  // Heuristic search for people-related text on the page
  const all = document.body?.innerText || "";
  const lines = all.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (/people|director|profile|find.{0,15}person|find.{0,15}associate|workvivo/i.test(line) && line.length < 120) {
      out.peopleMentions.push(line);
    }
  }
  return out;
});

console.log(`\n── Visible buttons (${found.buttons.length}) ──`);
found.buttons.slice(0, 30).forEach((b) => console.log(`  "${b.text}"  type=${b.type}  aria=${b.ariaLabel}`));

console.log(`\n── Visible tabs (${found.tabs.length}) ──`);
found.tabs.slice(0, 20).forEach((t) => console.log(`  [${t.role}] "${t.text}"`));

console.log(`\n── Visible links matching people/profile/director (filtered) ──`);
const peopleLinks = found.links.filter((l) =>
  /people|director|profile|find.{0,15}person|workvivo/i.test(l.text + " " + l.href)
);
peopleLinks.slice(0, 25).forEach((l) => console.log(`  "${l.text}"  → ${l.href}`));

console.log(`\n── People-related text mentions ──`);
found.peopleMentions.slice(0, 20).forEach((m) => console.log(`  ${m}`));

writeFileSync("directory-dom-dump.json", JSON.stringify(found, null, 2));
console.log(`\n✓ Full dump → directory-dom-dump.json`);
browser.disconnect();
process.exit(0);
