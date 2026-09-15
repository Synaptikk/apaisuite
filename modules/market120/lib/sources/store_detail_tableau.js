// modules/market120/lib/sources/store_detail_tableau.js
//
// Per-store item detail for the Market 120 store drill-down.
//
// The ClearanceDeleted dashboard's "CD Location Details" worksheet lists every
// item (Item Number, Description, Dept, Location Name, Clearance/Deleted
// flags) with Total Clearance Deleted $ / Units — but only once a Store is
// selected. We open our own background tab, apply the Store quick filter to
// that throwaway vizql session (tabdoc/categorical-filter), and read the
// sheet through the summary-data command. No dialog, no focus change.
//
// Verified live 2026-09-15: item sums equal the CD Store totals to the
// dollar and unit for stores 1458 and 1215, and a filter-replace switches
// stores within one session. Flag semantics from the same check: items
// flagged Clearance AND Deleted count toward the store's "Clearance $";
// the store's "Deleted $" is deleted-only items.
//
// Read-only for data, but NOT free of side effects: Tableau saves a signed-in
// user's last filter state server-side, so a Store filter left applied makes
// every later session — the store pull, the user's own Tableau tab — open on
// that one store (hit live 2026-09-15). detailFn always resets the filter to
// all values before returning.

import {
  openReportTab, waitForTabLoad, execScript,
  STORE_FILTER_FN, STORE_FILTER_WORKSHEET,
} from "./clearance_stores_tableau.js";

const WORKSHEET = "CD Location Details";
const DASHBOARD = "Clearance Deleted";

const LOAD_TIMEOUT_MS = 30_000;
const SESSION_WAIT_MS = 90_000;
const POLL_MS         = 1_000;

export async function fetchStoreDetail(store, { topN = 25 } = {}) {
  const s = String(store ?? "").trim();
  if (!/^\d+$/.test(s)) return { ok: false, errorClass: "INPUT", error: `Bad store number: ${store}` };

  const opened = await openReportTab();
  if (!opened) return { ok: false, errorClass: "TAB", error: "Could not open Tableau ClearanceDeleted tab." };
  const { tab } = opened;
  let keepOpen = false;

  try {
    await waitForTabLoad(tab.id, LOAD_TIMEOUT_MS);
    const got = await pollDetail(tab.id, s);
    if (!got?.ok) {
      keepOpen = !got;
      return got
        ? { ok: false, errorClass: "SUMMARY", error: `Tableau detail read failed: ${got.reason}` }
        : {
            ok: false,
            errorClass: "SESSION",
            error: "Tableau session did not start in time (may need SSO sign-in). " +
                   "The tab was left open in the background — sign in there, then try again.",
          };
    }

    const agg = aggregateLocationDetail(got.cols, got.tuples, { topN });
    if (!agg.ok) return { ok: false, errorClass: "PARSE", error: agg.reason };
    const foreign = agg.stores.filter((x) => x && x !== s);
    if (foreign.length) {
      return { ok: false, errorClass: "FILTER", error: `Store filter did not apply (got stores ${foreign.slice(0, 5).join(", ")}).` };
    }
    return { ok: true, detail: { store: s, capturedAt: new Date().toISOString(), ms: got.ms, ...agg.detail } };
  } finally {
    if (!keepOpen) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

/**
 * Roll the long-format CD Location Details tuples up into item rows,
 * a clearance/deleted split, dept + location rollups and top items. Pure.
 */
export function aggregateLocationDetail(cols, tuples, { topN = 25 } = {}) {
  const at = (n) => (cols || []).indexOf(n);
  const I = {
    clr: at("Clearance"), del: at("Deleted"), dept: at("Dept"), desc: at("Description"),
    item: at("Item Number"), loc: at("Location Name"), mn: at("Measure Names"), mv: at("Measure Values"), store: at("Store"),
  };
  if (I.item < 0 || I.mn < 0 || I.mv < 0) {
    return { ok: false, reason: `unexpected columns: ${(cols || []).join(", ")}` };
  }
  const cell = (t, i) => (i >= 0 ? String(t[i] ?? "").trim() : "");

  const items = new Map();
  const stores = new Set();
  for (const t of tuples || []) {
    const measure = cell(t, I.mn);
    const field = measure === "Total Clearance Deleted $" ? "dollars"
      : measure === "Total Clearance Deleted Units" ? "units" : null;
    if (!field) continue;
    const clr = cell(t, I.clr).toUpperCase() === "Y";
    const del = cell(t, I.del).toUpperCase() === "Y";
    const key = [cell(t, I.item), cell(t, I.loc), clr, del].join("|");
    let it = items.get(key);
    if (!it) {
      it = {
        item: cell(t, I.item), desc: cell(t, I.desc), dept: cell(t, I.dept), loc: cell(t, I.loc),
        type: clr && del ? "both" : del ? "deleted" : clr ? "clearance" : "other",
        dollars: 0, units: 0,
      };
      items.set(key, it);
    }
    it[field] += num(t[I.mv]);
    if (I.store >= 0) stores.add(cell(t, I.store));
  }

  const list = [...items.values()];
  const bucket = () => ({ dollars: 0, units: 0, items: 0 });
  const add = (b, it) => { b.dollars += it.dollars; b.units += it.units; b.items += 1; };
  const totals = bucket();
  // clearance includes "both"; deletedOnClearance is that "both" subset.
  const split = { clearance: bucket(), deletedOnly: bucket(), deletedOnClearance: bucket() };
  const depts = new Map();
  const locs = new Map();
  for (const it of list) {
    add(totals, it);
    if (it.type === "clearance" || it.type === "both") add(split.clearance, it);
    if (it.type === "deleted") add(split.deletedOnly, it);
    if (it.type === "both") add(split.deletedOnClearance, it);
    if (!depts.has(it.dept)) depts.set(it.dept, { dept: it.dept, ...bucket() });
    add(depts.get(it.dept), it);
    if (!locs.has(it.loc)) locs.set(it.loc, { loc: it.loc, ...bucket() });
    add(locs.get(it.loc), it);
  }
  const byDollars = (a, b) => b.dollars - a.dollars;

  return {
    ok: true,
    stores: [...stores],
    detail: {
      itemCount: list.length,
      totals,
      split,
      depts: [...depts.values()].sort(byDollars),
      locations: [...locs.values()].sort(byDollars).slice(0, 15),
      topItems: list.sort(byDollars).slice(0, topN),
    },
  };
}

function num(s) {
  const t = String(s ?? "").trim();
  const neg = /^\(.*\)$/.test(t);
  const v = Number(t.replace(/[$,()\s]/g, ""));
  return Number.isFinite(v) ? (neg ? -Math.abs(v) : v) : 0;
}

// Retry until a frame has a vizql session and the filtered read answers.
// Returns the read, a {ok:false} from a frame that had a session, or null.
async function pollDetail(tabId, store) {
  const deadline = Date.now() + SESSION_WAIT_MS;
  let lastFailure = null;
  while (Date.now() < deadline) {
    try {
      const results = await execScript({
        target: { tabId, allFrames: true },
        world:  "MAIN",
        args:   [store, WORKSHEET, DASHBOARD, STORE_FILTER_FN, STORE_FILTER_WORKSHEET],
        func:   detailFn,
      });
      const answered = (results || []).map((r) => r?.result).filter(Boolean);
      const ok = answered.find((r) => r.ok);
      if (ok) return ok;
      if (answered.length) lastFailure = answered[0];
    } catch (e) {
      lastFailure = { ok: false, reason: String(e?.message ?? e) };
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return lastFailure;
}

// Injected into every frame (MAIN world); self-contained. Null in frames
// without a vizql session.
async function detailFn(store, worksheet, dashboard, fallbackFn, fallbackWs) {
  const c = window.tsConfig;
  if (!c?.sessionid || !c.repositoryUrl || !c.site_root) return null;
  const [wb, view] = String(c.repositoryUrl).split("/");
  const base = `${location.origin}/vizql${c.site_root}/w/${wb}/v/${view}/sessions/${c.sessionid}`;

  let fn = fallbackFn;
  let filterWs = fallbackWs;
  try {
    const cap = window.__APAISUITE_MARKET120_TABLEAU_CAP;
    const boot = (cap?.all() || []).map((e) => e.respBody || "").find((b) => b.includes("quickFilterTitle")) || "";
    const semi = boot.indexOf(";");
    if (semi > 0) {
      const json = JSON.parse(boot.slice(semi + 1, semi + 1 + Number(boot.slice(0, semi))));
      const stack = [json];
      while (stack.length) {
        const o = stack.pop();
        if (!o || typeof o !== "object") continue;
        const qf = o.quickFilterDisplay;
        if (qf && /^stores?$/i.test(qf.quickFilterTitle?.caption || "")) {
          const cmd = (qf.quickFilterCommands?.commandItems || []).map((x) => x.command || "").find(Boolean) || "";
          const f = cmd.match(/fn="([^"]+)"/);
          const w = cmd.match(/worksheet="([^"]+)"/);
          if (f) { fn = f[1]; if (w) filterWs = w[1]; break; }
        }
        for (const v of Object.values(o)) if (v && typeof v === "object") stack.push(v);
      }
    }
  } catch {}

  const post = (cmd, args) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(args)) form.append(k, v);
    return fetch(`${base}/commands/${cmd}`, { method: "POST", body: form, credentials: "include", signal: AbortSignal.timeout(30000) });
  };

  const t0 = performance.now();
  try {
    const f = await post("tabdoc/categorical-filter", {
      visualIdPresModel: JSON.stringify({ worksheet: filterWs, dashboard }),
      globalFieldName: fn, membershipTarget: "filter",
      filterValues: JSON.stringify([store]), filterUpdateType: "filter-replace",
    });
    if (!f.ok) return { ok: false, reason: `filter HTTP ${f.status}` };
    const ft = await f.text();
    const fe = ft.match(/"errorMessage"\s*:\s*"([^"]*)"/);
    if (fe) return { ok: false, reason: `filter rejected: ${fe[1]}` };

    const r = await post("tabdoc/api-get-worksheet-summary-logical-table-data", {
      visualIdPresModel: JSON.stringify({ worksheet, dashboard }),
      versionName: "1.0", maxRows: "0", ignoreAliases: "false", ignoreSelection: "true",
    });
    if (!r.ok) return { ok: false, reason: `summary HTTP ${r.status}` };
    const body = await r.json().catch(() => null);
    const model = body?.vqlCmdResponse?.cmdResultList?.[0]?.commandReturn?.dataTablePresModel;
    if (!model?.showDataFormattedTable) return { ok: false, reason: "summary returned no table (viz still bootstrapping?)" };
    const table = JSON.parse(model.showDataFormattedTable).table;
    const cols = (table.schema || []).map((name) =>
      model.showDataTableColumnPresModels?.find((col) => col.uniqueName === name)?.fieldCaption || name);
    return { ok: true, cols, tuples: table.tuples || [], ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  } finally {
    // Undo the Store filter so Tableau doesn't save it as the user's view.
    await post("tabdoc/categorical-filter", {
      visualIdPresModel: JSON.stringify({ worksheet: filterWs, dashboard }),
      globalFieldName: fn, membershipTarget: "filter",
      filterValues: "[]", filterUpdateType: "filter-all",
    }).catch(() => {});
  }
}
