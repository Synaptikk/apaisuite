// modules/digitalmetrics/lib/sources/gta_timesheet.js
//
// Clock punches from Global Time & Attendance (the Workbrain timesheet at
// timesheet.cloud.wal-mart.com). Runs in the service worker; the requests are
// made from inside a signed-in timesheet tab so they carry its session.
//
// ── How the site works (probed live 2026-09-23; dev/gta-clockins-check.mjs re-runs it) ──────
// menu.jsp frames dailytimesheet.action?action=SelectTimesheetAction, a plain
// form. Two things on that page are all a pull needs:
//
//   • the WIN picker is a "dblookup" backed by a JSON endpoint,
//       POST /gtaapp/services/platform/dblookup/getdblookup
//     whose data source is named by opaque encrypted strings the page carries
//     (DS_0 / DS_1 and the layer's `dsp` attribute). A criteria of
//     "__column2==SMITH~|~" searches Full Name; rows come back as
//     [empId, WIN, "SMITH, SHANE E"].
//   • Load posts the form to dailytimesheet.action?action=LoadEmployeeAction.
//     One employee over a date range lists one row per day; every row embeds
//     its punches as wb_tsclocks({ baseDate, clocks:[{type,time}] }).
//
// So a pull is: read the selection page for its tokens, look each last name
// up, then load each matched employee's range. The HTML is parsed in the SW
// by data/gta_parse.js; this file is transport only.

import { parseLookupRows, parseTimesheetRows, matchLookup } from "../data/gta_parse.js";

export const GTA_ORIGIN = "https://timesheet.cloud.wal-mart.com";
const MENU_URL = `${GTA_ORIGIN}/gtaapp/menu.jsp`;

const LOAD_MS = 30_000;   // a signed-in load takes ~1 s; SSO bounces take a few
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs IN the timesheet page (MAIN world). Serialised, so no closures and no
 * imports: everything it needs arrives in `req`, and it returns plain JSON.
 *
 *   { op: "init" }                          → { wbat, ds0, ds1, dsp } | { error }
 *   { op: "lookup", tokens, last }          → { text }   (raw JSON body)
 *   { op: "load", tokens, empId, from, to } → { html }
 */
export async function gtaInPage(req) {
  const base = "/gtaapp";
  try {
    if (req.op === "init") {
      const r = await fetch(`${base}/action/dailytimesheet.action?action=SelectTimesheetAction`,
        { credentials: "include" });
      const html = await r.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const layer = doc.getElementById("EMPLOYEE_IDS_layer");
      const ds = (n) => (html.match(new RegExp(`${n}='([^']*)'`)) || [])[1] || null;
      const wbat = doc.querySelector("input[name=wbat]")?.value || null;
      const out = { wbat, ds0: ds("DS_0"), ds1: ds("DS_1"), dsp: layer?.getAttribute("dsp") || null };
      if (!out.wbat || !out.ds0 || !out.dsp) {
        return { error: /login|sign ?in|saml/i.test(html.slice(0, 4000))
          ? "the timesheet needs a sign-in — open timesheet.cloud.wal-mart.com and sign in" : "the timesheet selection page did not have its lookup tokens" };
      }
      // The first (blank) lookup hands back `fieldNames`, which every search
      // must echo — the endpoint answers 500 without it.
      const first = await fetch(`${base}/services/platform/dblookup/getdblookup`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" },
        body: JSON.stringify({
          key: "", label: escape(out.ds1 || ""), fields: "", pageSize: "10",
          dataSourceType: "REGISTERED", dataSourceSpec: escape(out.ds0), dataSourceParams: escape(out.dsp),
          where: "", addWhere: "", filtersDuplicatesBySQL: "", initialBlank: "", multiple: "Y",
        }),
      });
      try {
        const head = JSON.parse(JSON.parse(await first.text())[0].data[0]);
        out.fieldNames = head.fieldNames || "";
      } catch { out.fieldNames = ""; }
      return out;
    }

    const t = req.tokens;
    if (req.op === "lookup") {
      const body = {
        key: "", label: escape(t.ds1 || ""), fields: "", pageSize: "50", pageNum: 0,
        dataSourceType: "REGISTERED", dataSourceSpec: escape(t.ds0), dataSourceParams: escape(t.dsp),
        where: "", addWhere: "", filtersDuplicatesBySQL: "", initialBlank: false,
        fieldNames: t.fieldNames || "", criteria: `__column2==${String(req.last).toUpperCase()}~|~`, sortOrderBy: null, multiple: "Y",
      };
      const r = await fetch(`${base}/services/platform/dblookup/getdblookup`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" },
        body: JSON.stringify(body),
      });
      return { status: r.status, text: await r.text() };
    }

    if (req.op === "load") {
      const ymd = (iso) => iso.replace(/-/g, "");
      const mdy = (iso) => { const [y, m, d] = iso.split("-"); return `${m}/${d}/${y}`; };
      const f = new URLSearchParams({
        wbat: t.wbat, pageAction: "", FROM_DAILY_SELECTION: "true", VIEW_SELECTION: "0",
        CREATE_DEFAULT_RECORDS: "N", EMPLOYEE_IDS: String(req.empId), EMPLOYEE_IDS_label: "",
        WBT_IDS: "", WBT_IDS_label: "", INCLUDE_SUB_TEAMS: "N", DATE_SELECTION: "7",
        TS_DATE_SELECTION_UI_EXTRA: "", TS_DATE_SELECTION_UI_MANUAL: "7",
        START_DATE: `${ymd(req.from)} 000000`, START_DATE_dummy: mdy(req.from),
        END_DATE: `${ymd(req.to)} 000000`, END_DATE_dummy: mdy(req.to),
        wbXpos: "0", wbYpos: "0",
      });
      for (let i = 1; i <= 10; i++) f.set(`TDF_FIELD${i}`, "null");
      const r = await fetch(`${base}/action/dailytimesheet.action?action=LoadEmployeeAction`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: f.toString(),
      });
      return { status: r.status, html: await r.text() };
    }
    return { error: `unknown op ${req.op}` };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

async function findOrOpenTab() {
  const [open] = await chrome.tabs.query({ url: `${GTA_ORIGIN}/*` });
  if (open) return { tab: open, opened: false };
  const tab = await chrome.tabs.create({ url: MENU_URL, active: false });
  const t0 = Date.now();
  while (Date.now() - t0 < LOAD_MS) {
    const cur = await chrome.tabs.get(tab.id).catch(() => null);
    if (!cur) throw new Error("the timesheet tab was closed");
    if (cur.status === "complete" && cur.url?.startsWith(GTA_ORIGIN)) return { tab: cur, opened: true };
    await sleep(1000);
  }
  // Still somewhere else after the wait: SSO wanted a sign-in it could not
  // complete silently. Say so rather than reading a login page.
  chrome.tabs.remove(tab.id).catch(() => {});
  throw new Error("the timesheet needs a sign-in — open timesheet.cloud.wal-mart.com and sign in");
}

async function inPage(tabId, req) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId }, world: "MAIN", func: gtaInPage, args: [req],
  });
  const out = res?.result;
  if (!out) throw new Error("the timesheet page did not answer");
  if (out.error) throw new Error(out.error);
  return out;
}

/**
 * Clock punches for a roster over [from, to] (ISO dates, inclusive).
 *
 * @param people   [{ name }] roster names as the board holds them ("KIRA JUNE")
 * @param idCache  { NAME: { empId, win, gtaName } } — earlier matches, reused
 * @returns { byName: { NAME: { win, empId, gtaName, days: { iso: { clockIn, clockOut, punches } } } },
 *            ids, unmatched: [name], errors: [string] }
 */
export async function pullClockIns({ people, from, to, idCache = {}, onProgress = () => {} }) {
  const { tab, opened } = await findOrOpenTab();
  try {
    onProgress("reading the timesheet page");
    const tokens = await inPage(tab.id, { op: "init" });

    const ids = { ...idCache };
    const unmatched = [], errors = [], byName = {};
    const lookups = new Map();     // last name → parsed rows, one request per surname

    for (const [i, p] of people.entries()) {
      const name = p.name;
      onProgress(`matching ${i + 1}/${people.length}`);
      if (!ids[name]) {
        const last = name.trim().split(/\s+/).at(-1);
        if (!lookups.has(last)) {
          const res = await inPage(tab.id, { op: "lookup", tokens, last });
          lookups.set(last, res.status === 200 ? parseLookupRows(res.text) : []);
        }
        const hit = matchLookup(name, lookups.get(last));
        if (!hit) { unmatched.push(name); continue; }
        ids[name] = hit;
      }
    }

    const matched = people.filter((p) => ids[p.name]);
    for (const [i, p] of matched.entries()) {
      onProgress(`loading punches ${i + 1}/${matched.length}`);
      const id = ids[p.name];
      try {
        const res = await inPage(tab.id, { op: "load", tokens, empId: id.empId, from, to });
        const rows = parseTimesheetRows(res.html).filter((r) => !r.empId || r.empId === String(id.empId));
        const days = {};
        for (const r of rows) days[r.date] = { clockIn: r.clockIn, clockOut: r.clockOut, punches: r.punches };
        byName[p.name] = { ...id, days };
      } catch (e) {
        errors.push(`${p.name}: ${e.message}`);
      }
    }
    return { byName, ids, unmatched, errors };
  } finally {
    if (opened) chrome.tabs.remove(tab.id).catch(() => {});
  }
}
