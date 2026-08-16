// dev/probe-vizpick-bgtab.mjs
//
// Does the VizPickDetails viz actually RENDER in a tab that is never brought
// to the front?
//
// This is the question behind the recurring "SESSION — VizPick Details did not
// render in time" failures. The capture deliberately opens its Tableau tab
// with active:false so it never steals focus, and then waits for the viz
// toolbar to appear. If Chrome's background-tab throttling stops the render
// pipeline (requestAnimationFrame does not fire in a hidden tab), that wait can
// never succeed and every background capture is doomed regardless of session
// state — the error would be blaming SSO for a rendering problem.
//
// Runs the same wait twice against the same signed-in session:
//   1. hidden   — the tab exists but another tab is in front the whole time
//   2. visible  — the tab is in front
// and reports, for each: time to toolbar, visibilityState, and whether rAF
// ticked at all.
//
// Read-only: loads a report and observes it.

import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BROWSER_URL = process.env.EDGE_CDP_URL || "http://localhost:9222";
const REPORT_URL =
  "https://stores.tableau.wal-mart.com/#/site/OnlineGrocery/views/VizPick/VizPickDetails?:iid=1&:linktarget=_self";
const TOOLBAR = '[data-tb-test-id="viz-viewer-toolbar-button-download"]';
const WAIT_MS = 120_000;
const OUT = resolve(HERE, "vizpick-bgtab-probe.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { startedAt: new Date().toISOString(), waitMs: WAIT_MS, trials: {} };
const save = () => writeFileSync(OUT, JSON.stringify(out, null, 2));

const browser = await puppeteer.connect({
  browserURL: BROWSER_URL,
  defaultViewport: null,
  protocolTimeout: 300_000,
});
console.log("✓ connected");

// A parking page we can hold in front, so the page under test is genuinely the
// non-active tab of its window rather than merely unfocused.
const parking = await browser.newPage();
await parking.goto("about:blank");

async function trial(name, { hidden }) {
  const page = await browser.newPage();
  // Count rAF ticks from the moment of navigation. If this stays at 0 the
  // render pipeline never ran, which is the whole hypothesis.
  await page.evaluateOnNewDocument(() => {
    window.__rafTicks = 0;
    const tick = () => { window.__rafTicks++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });

  await page.goto(REPORT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  if (hidden) await parking.bringToFront();
  else await page.bringToFront();

  // The viz — and therefore the toolbar — lives in an embedded iframe
  // (/t/<site>/views/...?:embed=y), NOT the top document. The extension polls
  // with allFrames:true, so the probe must scan every frame too or it reports
  // a failure that never happened.
  const toolbarInAnyFrame = async () => {
    for (const f of page.frames()) {
      const hit = await f.evaluate((sel) => !!document.querySelector(sel), TOOLBAR).catch(() => false);
      if (hit) return true;
    }
    return false;
  };

  const t0 = Date.now();
  let toolbarAt = null;
  while (Date.now() - t0 < WAIT_MS) {
    // Re-assert front-ness every poll: Tableau's SSO chain can navigate, and a
    // navigation is enough to make a tab active again in some cases.
    if (hidden) await parking.bringToFront().catch(() => {});
    if (await toolbarInAnyFrame()) { toolbarAt = Date.now() - t0; break; }
    await sleep(500);
  }

  const state = await page.evaluate(() => ({
    visibility: document.visibilityState,
    rafTicks: window.__rafTicks ?? null,
    url: location.href,
    title: document.title,
    // Anything that looks like an auth wall rather than a slow render.
    hasVizCanvas: !!document.querySelector("canvas"),
    bodyHead: (document.body?.innerText || "").trim().slice(0, 200),
  })).catch((e) => ({ error: String(e) }));

  out.trials[name] = { hidden, toolbarMs: toolbarAt, rendered: toolbarAt != null, ...state };
  save();
  console.log(
    `${name.padEnd(8)} rendered=${toolbarAt != null} ` +
    `${toolbarAt != null ? `in ${(toolbarAt / 1000).toFixed(1)}s ` : `(gave up after ${WAIT_MS / 1000}s) `}` +
    `visibility=${state.visibility} rafTicks=${state.rafTicks}`
  );
  await page.close().catch(() => {});
}

// Hidden first: if the session needs re-auth, the visible run will show it and
// we can tell the two failure modes apart.
await trial("hidden", { hidden: true });
await trial("visible", { hidden: false });

await parking.close().catch(() => {});
out.finishedAt = new Date().toISOString();
save();
console.log(`\n→ ${OUT}`);
await browser.disconnect();
