// modules/digitalschedule/service.js
//
// Digital Schedule — service-worker half. Every call runs lib/page.js inside
// the Polaris scheduler tab (MAIN world: the page's Redux store, the scheduler
// remote's own webpack modules for validate / save / readback).
//
//   open_tab                         → { ok, tabId }   (bring the scheduler tab forward)
//   week     { wk }                  → { ok, ctx }
//   read                             → { ok, data }    (ctx, dates, demand, workers)
//   validate { changes }             → { ok, result }  (hard / newWarnings / skipped)
//   save     { changes, allowWarnings, allowSkips }
//                                    → { ok, result, entry }  saved, read back, undo kept
//   history                          → { ok, entries }
//   chat     { model, system, messages, tools } → { ok, content, stop_reason }
//                                    one schedule-assistant turn (lib/gateway.js)
//   gateway_status                   → { ok, status }
//
// Writes go to the live schedule. The view only sends `save` after the user
// confirmed this exact list; this file re-validates inside the same call
// (page.js refuses on HARD, on new warnings and on skips unless allowed).

import { withKeepAwake } from "../../shared/sw_keepalive.js";
import { wfmInPage } from "./lib/page.js";
import { buildUndo, readbackMisses } from "./lib/coverage.js";
import { chatTurn, gatewayStatus } from "./lib/gateway.js";

const SCHEDULER_URL = "https://workforce-planning-portal.us-walmart.prod.polaris.walmart.com/scheduler";
const MATCH = "https://workforce-planning-portal.us-walmart.prod.polaris.walmart.com/scheduler*";
const HISTORY_KEY = "digitalschedule.history";
const HISTORY_MAX = 30;
const PAGE_TIMEOUT_MS = 240_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (e) => ({ ok: false, error: String(e?.message || e) });

async function waitComplete(tabId, ms = 90_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) throw new Error("The scheduler tab was closed.");
    if (t.status === "complete") return t;
    await sleep(500);
  }
  throw new Error("The scheduler page did not finish loading.");
}

async function schedulerTab({ focus = false } = {}) {
  let [tab] = await chrome.tabs.query({ url: MATCH });
  if (!tab) {
    const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
    const win = wins.find((w) => w.focused) || wins[0];
    if (win?.id == null) throw new Error("No browser window is open.");
    tab = await chrome.tabs.create({ url: SCHEDULER_URL, active: focus, windowId: win.id });
    await waitComplete(tab.id);
  }
  // Edge sleeps hidden tabs; executeScript into a frozen tab never settles.
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  if (tab.discarded) { await chrome.tabs.reload(tab.id); await waitComplete(tab.id); }
  if (focus) { await chrome.tabs.update(tab.id, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {}); }
  return tab;
}

// Edge freezes background tabs ("sleeping tabs"); a script sent into a frozen
// tab never settles. Probe with a trivial script; if it doesn't answer, show
// the tab for a moment (which wakes it) and hand focus back.
async function wake(tab) {
  const probe = () => Promise.race([
    chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: () => 1 }).then(() => true, () => false),
    sleep(8000).then(() => false),
  ]);
  if (await probe()) return;
  const [prev] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  await chrome.tabs.update(tab.id, { active: true });
  await sleep(2000);
  if (prev && prev.id !== tab.id) await chrome.tabs.update(prev.id, { active: true }).catch(() => {});
  await probe();
}

async function inPage(args) {
  return withKeepAwake("digitalschedule", async () => {
    const tab = await schedulerTab();
    await wake(tab);
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(
      "The scheduler tab did not answer. Edge may have put it to sleep — press “Show scheduler”, wait for it to load, then try again.")), PAGE_TIMEOUT_MS); });
    try {
      const [res] = await Promise.race([
        chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: wfmInPage, args: [args] }),
        timeout,
      ]);
      const v = res?.result;
      if (!v) throw new Error("No answer from the scheduler page.");
      if (v.error) throw new Error(v.error + (v.available ? ` (weeks in the picker: ${v.available.map((a) => a.replace(/^Week /, "").split(",")[0]).join(", ")})` : ""));
      return v;
    } finally { clearTimeout(timer); }
  });
}

async function readHistory() {
  const got = await chrome.storage.local.get(HISTORY_KEY);
  return Array.isArray(got[HISTORY_KEY]) ? got[HISTORY_KEY] : [];
}

export const handlers = {
  async open_tab() {
    try { const t = await schedulerTab({ focus: true }); return { ok: true, tabId: t.id }; } catch (e) { return fail(e); }
  },

  async week(msg) {
    const wk = +String(msg.wk ?? "").replace(/\D/g, "");
    if (!wk) return { ok: false, error: "Type a WK number." };
    try { return { ok: true, ctx: (await inPage({ cmd: "week", wk })).ctx }; } catch (e) { return fail(e); }
  },

  async read() {
    try { return { ok: true, data: await inPage({ cmd: "read" }) }; } catch (e) { return fail(e); }
  },

  async validate(msg) {
    if (!Array.isArray(msg.changes) || !msg.changes.length) return { ok: false, error: "No changes to check." };
    try { return { ok: true, result: await inPage({ cmd: "validate", changes: msg.changes }) }; } catch (e) { return fail(e); }
  },

  async save(msg) {
    const changes = msg.changes;
    if (!Array.isArray(changes) || !changes.length) return { ok: false, error: "No changes to save." };
    try {
      const result = await inPage({ cmd: "save", changes, allowWarnings: !!msg.allowWarnings, allowSkips: !!msg.allowSkips });
      if (!result.saved) return { ok: true, result };
      // the server's copy, to check every change landed
      let misses = null;
      try {
        const rb = await inPage({ cmd: "readback", who: [...new Set(result.applied.map((a) => a.workerId))] });
        misses = readbackMisses(result.applied, rb.readback).map((m) => ({ name: m.name, action: m.action, next: m.next, orig: m.orig }));
      } catch (e) { misses = [{ name: "(readback failed)", action: String(e?.message || e) }]; }
      const entry = {
        id: `${Date.now()}`, at: new Date().toISOString(), label: msg.label || null,
        store: result.ctx.store, wk: result.ctx.wk, weekStart: result.ctx.weekStart,
        changes, applied: result.applied, saveStatus: result.saveStatus,
        undo: buildUndo(result.applied), misses, undoOf: msg.undoOf || null,
      };
      const hist = [entry, ...(await readHistory())].slice(0, HISTORY_MAX);
      if (msg.undoOf) { const src = hist.find((h) => h.id === msg.undoOf); if (src) src.undoneAt = entry.at; }
      await chrome.storage.local.set({ [HISTORY_KEY]: hist });
      return { ok: true, result, entry };
    } catch (e) { return fail(e); }
  },

  async chat(msg) {
    try { return { ok: true, ...(await chatTurn(msg)) }; }
    catch (e) { return { ok: false, error: String(e?.message || e), code: e?.code || null }; }
  },

  async gateway_status() {
    try { return { ok: true, status: await gatewayStatus() }; } catch (e) { return fail(e); }
  },

  async history() {
    try { return { ok: true, entries: await readHistory() }; } catch (e) { return fail(e); }
  },
};
