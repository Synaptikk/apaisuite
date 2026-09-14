// modules/registerls/lib/dispo.js
//
// Pre-fill a WorkView disposition from the module's suggestion. Drives the
// APPRISS detail page's own form (recorded 2026-09-12, see
// dev/REGISTER_LS_FINDINGS.md §1 "Disposition flow"):
//
//   Start Work  → POST workview/api/v1/assignToSelf            (we click the button)
//   Disposition → lightbox with <sng-filterbox data-qa-id="wv-abandon-filterbox-<sourceApp>">
//                 (reasons from /system/workview/search/abandonreasonsselect.search)
//                 and <textarea id="wv-abandon-reason"> "More Information"
//   Complete    → NOT clicked. The analyst reads the filled form and submits.
//
// Reasons available for long/short items (sourceApp mel): Cash Card Scam,
// Counterfeit Bills, Internal Theft, Multiple Reasons, Not Identified,
// Phone Scam, Process Errors, Quick Change, Robbery.

import { findOrOpenTracked, closeIfOpened } from "../../../shared/tabs.js";
import { DETAIL_URL } from "./workview.js";

// Runs inside the APPRISS tab (serialised — no closures over module scope).
export function driveDisposition({ reasonLabel, text, complete = false, dryRun = false }) {
  return (async () => {
    const log = [];
    const note = (m) => log.push(m);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const vis = (e) => !!(e && (e.offsetParent || e.getClientRects().length));
    const txt = (e) => (e.innerText || e.textContent || "").trim().replace(/\s+/g, " ");
    const findBtn = (re) => [...document.querySelectorAll("button, a[role=button], [role=button]")].filter(vis).find((e) => re.test(txt(e)));
    const waitFor = async (fn, ms, step = 200) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(step); } return null; };
    try {
      // The lightbox needs the Angular app to be up; the work item card is the tell.
      if (!(await waitFor(() => document.querySelector("#workview-card"), 15_000))) throw new Error("work item page did not render");
      // The toolbar (Start Work / Disposition / Assigned to … / Reinstate)
      // renders after the card, later still in a background tab where timers
      // are throttled. Wait for it rather than judging the page from its
      // first paint, and say which state it is in when we cannot proceed.
      const toolbarState = () => {
        if (findBtn(/^Start Work$/i)) return "new";
        if (findBtn(/^Disposition$/i)) return "mine";
        if (findBtn(/^Reinstate$/i)) return "closed:already dispositioned (it shows Reinstate)";
        const assigned = [...document.querySelectorAll("button, a, span, div")].filter(vis).map(txt).find((t) => /^Assigned to /i.test(t) && t.length < 60);
        if (assigned && !/Assigned to you/i.test(assigned)) return "other:" + assigned;
        const status = txt(document.querySelector("#workview-card")).match(/(Completed|Closed|Abandoned|Snoozed)/i);
        if (status) return "closed:" + status[1].toLowerCase();
        return null;
      };
      const state = await waitFor(toolbarState, 20_000);
      if (!state) {
        const seen = [...document.querySelectorAll("button")].filter(vis).map(txt).filter(Boolean).slice(0, 12);
        throw new Error(`work item toolbar never rendered (buttons seen: ${seen.join(", ") || "none"})`);
      }
      if (state.startsWith("other:")) throw new Error(`work item is ${state.slice(6)} — only the assignee can disposition it`);
      if (state.startsWith("closed:")) throw new Error(`work item is ${state.slice(7)}`);
      if (state === "new") {
        findBtn(/^Start Work$/i).click(); note("Start Work → click");
        if (!(await waitFor(() => findBtn(/^Disposition$/i) && !findBtn(/^Start Work$/i), 15_000))) throw new Error("Start Work did not take (no Disposition button after assigning)");
        await sleep(500);
      } else {
        note("already assigned to you");
      }

      const dispo = findBtn(/^Disposition$/i);
      if (!dispo) throw new Error("Disposition button not available after assignment");
      if (!document.querySelector('[data-qa-id^="wv-abandon-filterbox-"]')) { dispo.click(); note("Disposition → click"); }
      const fb = await waitFor(() => document.querySelector('[data-qa-id^="wv-abandon-filterbox-"]'), 10_000);
      if (!fb) throw new Error("disposition form did not open");
      await sleep(400);

      // Reason picker. The list is paged (10 at a time, infinite scroll) and
      // differs per work-item source, so narrow it with the filter box first.
      const opener = fb.querySelector('[ng-click="open()"]');
      if (!opener) throw new Error("reason picker not found");
      opener.click(); note("reason picker → open");
      await waitFor(() => fb.querySelectorAll("ul li").length, 8_000);
      const want = String(reasonLabel).trim().toLowerCase();
      const exact = () => [...fb.querySelectorAll("ul li")].filter(vis).find((l) => txt(l).toLowerCase() === want) || null;
      let li = exact();
      if (!li) {
        const filter = fb.querySelector('input[placeholder="Filter..."], input[ng-model="filterText"]');
        if (filter) {
          filter.focus(); filter.value = reasonLabel;
          filter.dispatchEvent(new Event("input", { bubbles: true })); filter.dispatchEvent(new Event("change", { bubbles: true }));
          note("reason filter → typed");
          li = await waitFor(exact, 8_000);
        }
      }
      if (!li) {
        const have = [...fb.querySelectorAll("ul li")].map(txt).filter(Boolean);
        throw new Error(`reason "${reasonLabel}" not offered for this work item — list shows: ${have.join(", ") || "(empty)"}`);
      }
      li.click(); note(`reason → ${reasonLabel}`);
      await sleep(400);

      // More Information — AngularJS ng-model listens for input events.
      const ta = document.querySelector("#wv-abandon-reason");
      if (!ta) throw new Error("More Information textarea not found");
      ta.focus();
      ta.value = String(text || "");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.dispatchEvent(new Event("change", { bubbles: true }));
      note("More Information → filled");

      const chosen = txt(fb.querySelector('[ng-click="open()"]')) || "";
      if (chosen.toLowerCase() !== want) throw new Error(`picker shows "${chosen}" after selection, expected "${reasonLabel}"`);

      if (dryRun) {
        const cancel = findBtn(/^Cancel$/i);
        if (cancel) { cancel.click(); note("dry run → Cancel"); await sleep(500); }
        return { ok: true, completed: false, dryRun: true, log, chosen, url: location.href };
      }
      if (!complete) return { ok: true, completed: false, log, chosen, textLength: ta.value.length, completeVisible: !!findBtn(/^Complete$/i), url: location.href };

      const btn = findBtn(/^Complete$/i);
      if (!btn) throw new Error("Complete button not visible");
      btn.click(); note("Complete → click");
      // Success = the lightbox goes away.
      const closed = await waitFor(() => !document.querySelector('[data-qa-id^="wv-abandon-filterbox-"]'), 15_000);
      if (!closed) {
        const err = [...document.querySelectorAll("[class*=error], [class*=invalid], [class*=validation]")].filter(vis).map(txt).filter(Boolean).slice(0, 3);
        throw new Error(`form did not close after Complete${err.length ? `: ${err.join(" | ")}` : ""}`);
      }
      await sleep(1200);
      const after = { dispositionButton: !!findBtn(/^Disposition$/i), startWork: !!findBtn(/^Start Work$/i), status: txt(document.querySelector("#workview-card")).slice(0, 200) };
      return { ok: true, completed: true, log, chosen, after, url: location.href };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e), log, url: location.href };
    }
  })();
}

async function waitForComplete(tabId, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return false;
    if (t.status === "complete") return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// Opens (or reuses) the work item's detail tab in the FOREGROUND, drives the
// form, and leaves the tab open on the filled form for the analyst to submit.
export async function prefillDisposition(workItemId, { reasonLabel, text }) {
  const url = DETAIL_URL(workItemId);
  const { tab } = await (async () => {
    const existing = await chrome.tabs.query({ url: "https://apps.apprissretail.com/*" });
    const same = existing.find((t) => (t.url || "").includes(`workview#/detail/${workItemId}`));
    if (same) { await chrome.tabs.update(same.id, { active: true, url }); return { tab: same }; }
    return { tab: await chrome.tabs.create({ url, active: true }) };
  })();
  try { if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }); } catch {}
  await waitForComplete(tab.id, 30_000);
  await new Promise((r) => setTimeout(r, 2500));
  let result;
  try {
    const [inj] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: driveDisposition, args: [{ reasonLabel, text }] });
    result = inj?.result;
  } catch (e) {
    return { ok: false, error: `executeScript failed: ${e?.message || e}`, tabId: tab.id, url };
  }
  if (!result) return { ok: false, error: "driver returned nothing (SSO page?)", tabId: tab.id, url };
  return { ...result, tabId: tab.id };
}

// Background: open (or reuse) the detail tab without focusing it, drive the
// form, optionally Complete, then close the tab if we opened it. The tab is
// never brought to the front; a tab the analyst already had open is reused
// (reloaded to a clean form) and left open.
export async function completeDisposition(workItemId, { reasonLabel, text, complete = true, dryRun = false }) {
  const url = DETAIL_URL(workItemId);
  const state = await findOrOpenTracked(url, {
    active: false,
    match: "https://apps.apprissretail.com/*",
    accept: (t) => String(t.url || "").includes(`workview#/detail/${workItemId}`),
  });
  const tab = state.tab;
  try {
    if (!state.opened) { try { await chrome.tabs.update(tab.id, { url }); } catch {} }
    await waitForComplete(tab.id, 30_000);
    await new Promise((r) => setTimeout(r, 2500));
    let result;
    try {
      const [inj] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: driveDisposition, args: [{ reasonLabel, text, complete, dryRun }] });
      result = inj?.result;
    } catch (e) {
      return { ok: false, error: `executeScript failed: ${e?.message || e}`, url };
    }
    if (!result) return { ok: false, error: "driver returned nothing (SSO page?)", url };
    return { ...result, tabId: tab.id, openedTab: state.opened };
  } finally {
    if (state.opened) await closeIfOpened(state);
  }
}
