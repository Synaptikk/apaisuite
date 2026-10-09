// modules/punchlookup/lib/gta.js
//
// Transport for Punch Lookup: Global Time & Attendance (Workbrain, at
// timesheet.cloud.wal-mart.com). Requests run INSIDE a signed-in timesheet tab
// so they carry its session; parsing happens in the SW (parse.js).
//
// Probed live 2026-10-08 (same site Digital Metrics + Safety Agent read):
//   • The WIN picker's dblookup takes SQL-style wildcards: criteria
//     "__column2==%BROOK%~|~" matches BROOKS, ALISSA and ABERNATHY, BROOKLYN;
//     "__column1==<WIN>~|~" finds by WIN. Scoped to the user's store.
//   • LoadEmployeeAction for one associate lists one row per day, 7 a page;
//     further pages are action=ViewTimesheetAction&TS_STARTING_ROW=7k and keep
//     the global row numbering (tsRow7…).
//   • action=LoadInlineDetailsAction&WRKS_INDEX=<row> returns that day's work
//     details (job, department, team, hour type, attendance flags) — but only
//     for a row on the page the server is CURRENTLY showing; a row on another
//     page comes back empty. So each page's details are read before moving on.
//   • The loaded selection lives in the SERVER session: a Digital Metrics or
//     Safety Agent pull in between swaps it, so every page is checked for its
//     page number and employee, and a drifted load is re-run once.

export const GTA_ORIGIN = "https://timesheet.cloud.wal-mart.com";
const MENU_URL = `${GTA_ORIGIN}/gtaapp/menu.jsp`;
const LOAD_MS = 30_000;
const SCRIPT_MS = 90_000;   // a frozen tab never answers executeScript
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs IN the timesheet page (MAIN world). Serialised: no closures, no imports.
 *   { op: "search", by: "name"|"win", term }       → { status, text }
 *   { op: "load", empId, from, to, details }       → { pages: [html], details: { row: html } }
 */
export async function punchesInPage(req) {
  const base = "/gtaapp";
  const post = (url, body, json) => fetch(url, {
    method: "POST", credentials: "include",
    headers: json ? { "Content-Type": "application/json; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" }
                  : { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body,
  });
  try {
    const sel = await fetch(`${base}/action/dailytimesheet.action?action=SelectTimesheetAction`, { credentials: "include" });
    const html = await sel.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const wbat = doc.querySelector("input[name=wbat]")?.value;
    if (!wbat) {
      return { error: /login|sign ?in|saml/i.test(html.slice(0, 4000))
        ? "The timesheet needs a sign-in. Open timesheet.cloud.wal-mart.com, sign in, then try again."
        : "The timesheet selection page did not load." };
    }

    if (req.op === "search") {
      const ds = (n) => (html.match(new RegExp(`${n}='([^']*)'`)) || [])[1] || "";
      const layer = doc.getElementById("EMPLOYEE_IDS_layer");
      if (!layer) return { error: "The timesheet has no associate picker for this sign-in." };
      const common = {
        key: "", label: escape(ds("DS_1")), fields: "", dataSourceType: "REGISTERED",
        dataSourceSpec: escape(ds("DS_0")), dataSourceParams: escape(layer.getAttribute("dsp") || ""),
        where: "", addWhere: "", filtersDuplicatesBySQL: "", multiple: "Y",
      };
      // The blank call hands back `fieldNames`, which a search must echo (500 without it).
      let fieldNames = "";
      try {
        const head = await post(`${base}/services/platform/dblookup/getdblookup`,
          JSON.stringify({ ...common, pageSize: "10", initialBlank: "" }), true);
        fieldNames = JSON.parse(JSON.parse(await head.text())[0].data[0]).fieldNames || "";
      } catch { /* the search will say */ }
      const col = req.by === "win" ? "__column1" : "__column2";
      const term = req.by === "win" ? req.term : `%${req.term}%`;
      const r = await post(`${base}/services/platform/dblookup/getdblookup`, JSON.stringify({
        ...common, pageSize: "100", pageNum: 0, initialBlank: false, fieldNames,
        criteria: `${col}==${term}~|~`, sortOrderBy: null,
      }), true);
      return { status: r.status, text: await r.text() };
    }

    if (req.op === "load") {
      const ymd = (iso) => iso.replace(/-/g, "");
      const mdy = (iso) => { const [y, m, d] = iso.split("-"); return `${m}/${d}/${y}`; };
      const f = new URLSearchParams({
        wbat, pageAction: "", FROM_DAILY_SELECTION: "true", VIEW_SELECTION: "0",
        CREATE_DEFAULT_RECORDS: "N", EMPLOYEE_IDS: String(req.empId), EMPLOYEE_IDS_label: "",
        WBT_IDS: "", WBT_IDS_label: "", INCLUDE_SUB_TEAMS: "N", DATE_SELECTION: "7",
        TS_DATE_SELECTION_UI_EXTRA: "", TS_DATE_SELECTION_UI_MANUAL: "7",
        START_DATE: `${ymd(req.from)} 000000`, START_DATE_dummy: mdy(req.from),
        END_DATE: `${ymd(req.to)} 000000`, END_DATE_dummy: mdy(req.to),
        wbXpos: "0", wbYpos: "0",
      });
      for (let i = 1; i <= 10; i++) f.set(`TDF_FIELD${i}`, "null");
      const pages = [], details = {};
      // Details only answer for rows on the page being shown, so they are read
      // straight after each page. Days with no punches and no hours are skipped.
      const readDetails = async (html) => {
        if (!req.details) return;
        const parts = html.split(/<tr[^>]*\bid=["']tsRow(\d+)["']/);
        for (let i = 1; i < parts.length; i += 2) {
          const row = parts[i + 1] || "";
          if (!/\{type:'\d+'/.test(row) && !/>\s*\d+:\d{2}\s*</.test(row)) continue;
          const r = await post(`${base}/action/dailytimesheet.action`,
            `action=LoadInlineDetailsAction&WRKS_INDEX=${parts[i]}&wbat=${encodeURIComponent(wbat)}`);
          details[parts[i]] = r.ok ? await r.text() : "";
        }
      };
      const first = await (await post(`${base}/action/dailytimesheet.action?action=LoadEmployeeAction`, f.toString())).text();
      pages.push(first);
      await readDetails(first);
      const flat = first.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
      const of = Number((/Page\s+\d+\s+of\s+(\d+)/.exec(flat) || [])[1] || 1);
      for (let k = 1; k < of && k < 60; k++) {
        const body = `action=ViewTimesheetAction&TS_STARTING_ROW=${k * 7}&SHOW_APPLIED_OVERRIDES=&INLINE_DETAILS_EXPANDED=`;
        const html = await (await post(`${base}/action/dailytimesheet.action`, body)).text();
        pages.push(html);
        await readDetails(html);
      }
      return { pages, details };
    }
    // Store-wide (edit review): the store team, then one day of every
    // associate's raw clocks. GPS (g=) is dropped here, before it leaves the page.
    if (req.op === "storeTeam") {
      const layer = doc.getElementById("WBT_IDS_layer");
      const ds = (n) => (html.match(new RegExp(`${n}='([^']*)'`)) || [])[1] || "";
      if (!layer) return { error: "The timesheet has no team picker for this sign-in." };
      const common = {
        key: "", label: escape(ds(layer.getAttribute("fls") || "DS_3")), fields: "", pageSize: "200", dataSourceType: "REGISTERED",
        dataSourceSpec: escape(ds(layer.getAttribute("dss") || "DS_2")), dataSourceParams: escape(layer.getAttribute("dsp") || ""),
        where: "", addWhere: "", filtersDuplicatesBySQL: "", initialBlank: "", multiple: "Y",
      };
      const head = JSON.parse(await (await post(`${base}/services/platform/dblookup/getdblookup`, JSON.stringify(common), true)).text());
      let fieldNames = "";
      try { fieldNames = JSON.parse(head[0].data[0]).fieldNames || ""; } catch { /* the lookup will say */ }
      const all = JSON.parse(await (await post(`${base}/services/platform/dblookup/getdblookup`, JSON.stringify({
        ...common, pageNum: 0, initialBlank: false, fieldNames, criteria: "", sortOrderBy: null }), true)).text());
      const cell = (c) => String(c ?? "").split("~|~")[0].trim();
      const want = String(req.store || "").padStart(5, "0");
      // Index loop: the page's legacy library replaces Array.prototype.find.
      for (let i = 1; i < all.length; i++) {
        const d = all[i]?.data;
        if (Array.isArray(d) && (!req.store ? /^\d{5}$/.test(cell(d[1])) : cell(d[1]) === want)) return { teamId: cell(d[0]), store: cell(d[1]), label: cell(d[2]) };
      }
      return { error: req.store ? `Your timesheet sign-in does not cover store ${req.store}.` : "No store team on this sign-in." };
    }

    if (req.op === "storeDay") {
      const [y, m, d] = req.date.split("-");
      const f = new URLSearchParams({
        wbat, pageAction: "", FROM_DAILY_SELECTION: "true", VIEW_SELECTION: "0", CREATE_DEFAULT_RECORDS: "N",
        EMPLOYEE_IDS: "", EMPLOYEE_IDS_label: "", WBT_IDS: String(req.teamId), WBT_IDS_label: "", INCLUDE_SUB_TEAMS: "Y",
        DATE_SELECTION: "7", TS_DATE_SELECTION_UI_EXTRA: "", TS_DATE_SELECTION_UI_MANUAL: "7",
        START_DATE: `${y}${m}${d} 000000`, START_DATE_dummy: `${m}/${d}/${y}`,
        END_DATE: `${y}${m}${d} 000000`, END_DATE_dummy: `${m}/${d}/${y}`, wbXpos: "0", wbYpos: "0",
      });
      for (let i = 1; i <= 10; i++) f.set(`TDF_FIELD${i}`, "null");
      // The form's hidden ROWS_ON_PAGE is 7, which made a store day ~66 pages.
      // Ask for more; if the server ignores it the walk below still works,
      // because it steps by the global tsRow index, not by an assumed size.
      const ROWS = String(req.rows || 50);
      f.set("ROWS_ON_PAGE", ROWS);
      const parse = (h) => {
        const rows = [];
        const ids = [...h.matchAll(/<tr id='tsRow(\d+)'/g)].map((m) => Number(m[1]));
        const parts = h.split(/<tr id='tsRow\d+'/);
        for (let i = 1; i < parts.length; i++) {
          const who = /class=.textMedium.>([^<]+?)\s+-\s+\d{6,}</.exec(parts[i]);
          const cl = /baseDate:'\d{8}'[^[]*clocks:\[(.*?)\]\s*\}\)/s.exec(parts[i]);
          if (!who || !cl) continue;
          const clocks = [];
          for (const p of cl[1].matchAll(/\{type:'(\d+)',time:'(\d{12,14})'(?:,data:'([^']*)')?/g)) {
            clocks.push([Number(p[1]), p[2], (p[3] || "").split("&").filter((kv) => !/^g=/.test(kv)).join("&")]);
          }
          if (clocks.length) rows.push([who[1].replace(/\s+/g, " ").trim(), clocks]);
        }
        const pm = /Page\s+(\d+)\s+of\s+(\d+)/.exec(h.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "));
        return { rows, ids, page: pm ? Number(pm[1]) : null, of: pm ? Number(pm[2]) : null, none: /No Associates found/i.test(h) };
      };
      const pg = parse(await (await post(`${base}/action/dailytimesheet.action?action=LoadEmployeeAction`, f.toString())).text());
      if (pg.none) return { pages: 0, rows: [] };
      if (pg.page !== 1 || !pg.of || !pg.ids.length) return { error: "The timesheet did not return a paged team list.", drift: true };
      const rows = [...pg.rows];
      let cur = pg, pages = 1;
      while (cur.page < cur.of && pages < 400) {
        const start = cur.ids[cur.ids.length - 1] + 1;
        const next = parse(await (await post(`${base}/action/dailytimesheet.action`,
          `action=ViewTimesheetAction&TS_STARTING_ROW=${start}&ROWS_ON_PAGE=${ROWS}&SHOW_APPLIED_OVERRIDES=&INLINE_DETAILS_EXPANDED=`)).text());
        if (next.ids[0] !== start || next.page !== cur.page + 1) {
          return { error: `Timesheet page ${cur.page + 1} came back as ${next.page} (row ${next.ids[0]}, wanted ${start}).`, drift: true };
        }
        rows.push(...next.rows);
        cur = next; pages++;
      }
      return { pages, rows, pageSize: pg.ids.length };
    }
    return { error: `unknown op ${req.op}` };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

async function findOrOpenTab({ fresh = false } = {}) {
  if (!fresh) {
    const open = (await chrome.tabs.query({ url: `${GTA_ORIGIN}/*` }))
      .find((t) => !t.discarded && !t.frozen && t.status === "complete");
    // A sleeping tab never answers; a 3 s ping finds out before the real call.
    if (open && await ping(open.id)) return { tab: open, opened: false };
  }
  const tab = await chrome.tabs.create({ url: MENU_URL, active: false });
  const t0 = Date.now();
  while (Date.now() - t0 < LOAD_MS) {
    const cur = await chrome.tabs.get(tab.id).catch(() => null);
    if (!cur) throw new Error("The timesheet tab was closed.");
    if (cur.status === "complete" && cur.url?.startsWith(GTA_ORIGIN)) return { tab: cur, opened: true };
    await sleep(800);
  }
  // Stuck on the sign-in page: hand this tab to signInThenRun rather than close it.
  throw Object.assign(new Error("The timesheet needs a sign-in. Open timesheet.cloud.wal-mart.com, sign in, then try again."), { signInTabId: tab.id });
}

async function ping(tabId) {
  let timer;
  try {
    const [res] = await Promise.race([
      chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: () => location.origin }),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("asleep")), 3000); }),
    ]);
    return res?.result === GTA_ORIGIN;
  } catch { return false; }
  finally { clearTimeout(timer); }
}

async function inPage(tabId, req) {
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("The timesheet tab stopped answering (it may be asleep). Click into it once, then try again.")), SCRIPT_MS); });
  try {
    const [res] = await Promise.race([
      chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: punchesInPage, args: [req] }),
      timeout,
    ]);
    const out = res?.result;
    if (!out) throw new Error("The timesheet page did not answer.");
    if (out.error) throw new Error(out.error);
    return out;
  } finally { clearTimeout(timer); }
}

// An already-open timesheet tab can refuse the script: Edge's sleeping tabs
// swap its frame out ("Frame with ID 0 was removed"), or GTA reloads it
// mid-call. Seen 2026-10-08 in both Edge profiles. Those errors come from the
// tab, not the site, so the call is retried once in a fresh background tab.
const TAB_TROUBLE = /Frame with ID|No frame with id|No tab with id|tab was closed|stopped answering|did not answer|Cannot access contents/i;

async function runIn(fn, opts) {
  const { tab, opened } = await findOrOpenTab(opts);
  try { return await fn((req) => inPage(tab.id, req)); }
  finally { if (opened) chrome.tabs.remove(tab.id).catch(() => {}); }
}

// Signed out (the GTA session expired): bring the timesheet up in FRONT so
// SSO can finish (often on its own, sometimes with a click), wait for it to
// land back on the timesheet, then carry on in that tab. It's left open: the
// user signed in there.
const NEEDS_SIGN_IN = /needs a sign-in/i;
const SIGN_IN_MS = 75_000;

async function signInThenRun(fn, tabId) {
  const tab = (tabId && await chrome.tabs.update(tabId, { active: true }).catch(() => null))
    || await chrome.tabs.create({ url: MENU_URL, active: true });
  const t0 = Date.now();
  while (Date.now() - t0 < SIGN_IN_MS) {
    await sleep(1500);
    const cur = await chrome.tabs.get(tab.id).catch(() => null);
    if (!cur) throw new Error("The timesheet sign-in tab was closed. Sign in at timesheet.cloud.wal-mart.com, then try again.");
    if (cur.status !== "complete" || !cur.url?.startsWith(GTA_ORIGIN)) continue;
    try { return await fn((req) => inPage(tab.id, req)); }
    catch (e) { if (!NEEDS_SIGN_IN.test(String(e?.message || e))) throw e; }
  }
  throw new Error("Still not signed in to the timesheet. Finish signing in in the timesheet tab, then try again.");
}

/** Run `fn(call)` against a timesheet tab (`call(req)` runs punchesInPage there); closes the tab after if it was opened here. */
export async function withTimesheet(fn) {
  try { return await runIn(fn); }
  catch (e) {
    const msg = String(e?.message || e);
    if (NEEDS_SIGN_IN.test(msg)) return signInThenRun(fn, e.signInTabId);
    if (!TAB_TROUBLE.test(msg)) throw e;
    try { return await runIn(fn, { fresh: true }); }
    catch (e2) { if (NEEDS_SIGN_IN.test(String(e2?.message || e2))) return signInThenRun(fn, e2.signInTabId); throw e2; }
  }
}
