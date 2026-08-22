// dev/preview-digitalrollup.mjs
//
//   node dev/preview-digitalrollup.mjs <path-to-fixture.json> [--keep]
//
// Mounts modules/digitalrollup/view.js for real — its own mount(), its own
// render path, the shell's stylesheets — against a captured /api/dashboard
// payload, and screenshots it in both themes at three widths.
//
// Why a harness rather than just loading the extension: the render path is
// the part worth eyeballing, and it needs no Chrome APIs beyond a `host`
// object and chrome.storage, both of which are stubbed below. Everything the
// harness cannot exercise (the SW pull, the cookie-scope fallback in
// lib/gif_api.js, the tab fetch) is exactly the part that must be tested in a
// real profile instead. See docs/CURRENT_TASKS.md.
//
// The fixture is a real payload and holds store-level figures, so it lives
// outside the repo and is passed in by path — do not commit one.

// puppeteer-core against system Edge, matching the other dev/ scripts —
// the corp proxy blocks Chromium downloads, so a bundled browser is not an
// option here (see ~/.claude/MCP-SETUP.md).
import puppeteer from "puppeteer-core";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// fileURLToPath, not URL.pathname: on Windows the latter yields "/C:/Users/…"
// and path.resolve turns that into "C:\C:\Users\…", so every static file 404s.
const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const PORT = Number(process.env.PORT || 8756);
const KEEP = process.argv.includes("--keep");
const FIXTURE = process.argv.slice(2).find((a) => !a.startsWith("--"));

if (!FIXTURE || !existsSync(FIXTURE)) {
  console.error("usage: node dev/preview-digitalrollup.mjs <path-to-fixture.json> [--keep]");
  process.exit(2);
}
const fixture = await readFile(FIXTURE, "utf8");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".mjs":  "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
};

const HARNESS = `<!doctype html>
<html><head><meta charset="utf-8"><title>digitalrollup preview</title>
<link rel="stylesheet" href="/styles/tokens.css">
<link rel="stylesheet" href="/styles/base.css">
<link rel="stylesheet" href="/styles/layout.css">
<link rel="stylesheet" href="/styles/components.css">
</head><body>
<div class="shell"><section class="shell-viewport"><main id="m"></main></section></div>
<script type="module">
const q = new URLSearchParams(location.search);
document.documentElement.setAttribute("data-theme", q.get("theme") || "light");

// Enough chrome for shared/userStore.js. A home store of 1458 is what makes
// the "yours" card render, which is one of the things worth looking at.
const FAKE_STORAGE = {
  "apai.userHomeStoreOverride": 1458,
  "apai.userHomeMarket": "120",
};
const area = {
  async get(keys) {
    if (keys == null) return { ...FAKE_STORAGE };
    const list = Array.isArray(keys) ? keys : [keys];
    const out = {};
    for (const k of list) if (k in FAKE_STORAGE) out[k] = FAKE_STORAGE[k];
    return out;
  },
  async set() {}, async remove() {},
  onChanged: { addListener() {}, removeListener() {} },
};
globalThis.chrome = {
  storage: { local: area, sync: area, session: area, onChanged: { addListener() {}, removeListener() {} } },
  runtime: { getURL: (p) => "/" + String(p).replace(/^\\//, ""), lastError: null, sendMessage() {} },
};

const { normalizeDashboard } = await import("/modules/digitalrollup/lib/normalize.js");
const fx = await (await fetch("/__fixture.json")).json();

const norm = normalizeDashboard(fx.dashboard, { market: "120" });
if (!norm.ok) throw new Error("fixture failed normalize: " + norm.missing.join(", "));
const snapshot = { ...norm.snapshot, via: "direct" };
const hierarchy = {
  via: "direct",
  markets: (fx.hierarchy.regions || []).flatMap((r) =>
    (r.markets || []).map((m) => ({
      market: String(m.market_nbr), name: m.market_name,
      region: String(r.region_nbr), storeCount: m.store_count,
    }))),
};

const prefs = {};
const auto = { enabled: true };
const host = {
  id: "digitalrollup",
  url: (p) => "/modules/digitalrollup/" + p,
  storage: { local: {
    async get(k) { return prefs[k]; },
    async set(o) { Object.assign(prefs, o); },
  } },
  messaging: {
    // Returns an unsubscribe fn, same as the real one — the view calls it on
    // cleanup, so a stub that returns undefined would throw on unmount.
    on() { return () => {}; },
    async send(type, payload) {
      if (type === "get_state") {
        return {
          ok: true, snapshot, hierarchy,
          debug: { ok: true, at: Date.now(), via: "direct" },
          auto: { enabled: auto.enabled }, periodMin: 10,
        };
      }
      if (type === "set_auto") { Object.assign(auto, payload?.auto || {}); return { ok: true, auto }; }
      if (type === "diagnostics") return { ok: true, diagnostics: { harness: true } };
      return { ok: true };
    },
    async sendRaw(type) {
      if (type === "pull") return { ok: true, snapshot };
      return { ok: true };
    },
  },
};

const main = document.getElementById("m");
main.className = "module-digitalrollup";
const { mount } = await import("/modules/digitalrollup/view.js");
await mount(host, main);

// Open one card so the detail rows are in the shot too.
if (q.get("expand") === "1") {
  main.querySelector("[data-toggle-store]")?.click();
  await new Promise((r) => setTimeout(r, 120));
}
document.documentElement.dataset.ready = "1";
</script>
</body></html>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/__preview") {
    res.writeHead(200, { "content-type": MIME[".html"] });
    return res.end(HARNESS);
  }
  // The browser asks for this unprompted; a 404 here would be reported as a
  // page error and read as a real failure.
  if (url.pathname === "/favicon.ico") {
    res.writeHead(204); return res.end();
  }
  if (url.pathname === "/__fixture.json") {
    res.writeHead(200, { "content-type": MIME[".json"] });
    return res.end(fixture);
  }
  // Static, confined to ROOT.
  const target = path.resolve(ROOT, "." + url.pathname);
  if (!target.startsWith(ROOT) || !existsSync(target)) {
    res.writeHead(404); return res.end("not found");
  }
  try {
    const body = await readFile(target);
    res.writeHead(200, { "content-type": MIME[path.extname(target)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(500); res.end("error");
  }
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const EDGE = process.env.EDGE_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--no-first-run", "--no-default-browser-check"],
});
const page = await browser.newPage();

// The harness must be entirely local — nothing here should reach the network.
await page.setRequestInterception(true);
page.on("request", (r) => (r.url().includes(`127.0.0.1:${PORT}`) ? r.continue() : r.abort()));

const errors = [];
page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

const shots = [
  { name: "light-1440", theme: "light", w: 1440, h: 1000, expand: 1 },
  { name: "dark-1440",  theme: "dark",  w: 1440, h: 1000, expand: 1 },
  { name: "light-1920", theme: "light", w: 1920, h: 1080, expand: 0 },
  { name: "light-900",  theme: "light", w: 900,  h: 1200, expand: 0 },
];

for (const s of shots) {
  await page.setViewport({ width: s.w, height: s.h });
  await page.goto(`http://127.0.0.1:${PORT}/__preview?theme=${s.theme}&expand=${s.expand}`, { waitUntil: "domcontentloaded" });
  try {
    await page.waitForSelector("html[data-ready='1']", { timeout: 15000 });
  } catch (e) {
    // The mount threw. The stack is what we actually need, so report it
    // rather than letting the timeout bury it.
    console.error(`\n${s.name}: mount never completed.`);
    for (const err of errors) console.error("  " + err);
    if (!errors.length) console.error("  (no page errors captured — check the harness script itself)");
    await browser.close(); server.close();
    process.exit(1);
  }
  const out = path.join(ROOT, "dev", "screenshots", `digitalrollup-${s.name}.png`);
  await page.screenshot({ path: out, fullPage: true });
  const counts = await page.evaluate(() => ({
    cards: document.querySelectorAll(".dmr-store-card").length,
    tiles: document.querySelectorAll(".dmr-tile").length,
    home:  document.querySelectorAll(".dmr-store-card.is-home").length,
    headline: document.querySelector(".dmr-headline")?.children.length ?? 0,
    sorts: document.querySelectorAll("[data-sort-select] option").length,
    // The card grid must never push the page sideways; wide content is the
    // usual cause and it is invisible in a fullPage screenshot.
    overflowX: document.documentElement.scrollWidth > window.innerWidth,
  }));
  console.log(
    `${s.name.padEnd(12)} cards=${counts.cards} tiles=${counts.tiles} home=${counts.home} ` +
    `headline=${counts.headline} sorts=${counts.sorts}` +
    `${counts.overflowX ? "  ⚠ HORIZONTAL OVERFLOW" : ""} → ${path.relative(ROOT, out)}`
  );
  if (counts.overflowX) errors.push(`${s.name}: page scrolls horizontally`);
}

if (errors.length) {
  console.error("\nPage errors:");
  for (const e of errors) console.error("  " + e);
}

if (!KEEP) { await browser.close(); server.close(); }
console.log(errors.length ? "\nFAILED" : "\nok");
process.exit(errors.length ? 1 : 0);
