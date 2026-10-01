// modules/safetyagent/lib/gta_store.js
//
// Every associate's punches for one store-day, from Global Time & Attendance
// (timesheet.cloud.wal-mart.com, Workbrain). Digital Metrics loads GTA one
// person at a time by name; this loads the whole STORE TEAM instead, which is
// what "who was on the clock at 2:14pm" needs. Probed live 2026-10-01:
//
//   • The team picker (WBT_IDS) is a dblookup like the WIN picker; its first
//     row for the user's store is the store team ("01458", id 13825 at 1458).
//   • LoadEmployeeAction with WBT_IDS=<team> + INCLUDE_SUB_TEAMS=Y lists every
//     employee of the store, 7 per page ("Page 1 of 64" — ~447 people), and
//     ignores any ROWS_ON_PAGE we send.
//   • Further pages: POST action=ViewTimesheetAction&TS_STARTING_ROW=7k. The
//     selection lives in the SERVER session, so a Digital Metrics per-person
//     load in the same session between two pages swaps the list under us —
//     every page's "Page N of M" is checked and a drifted day is re-run.
//   • Each row embeds wb_tsclocks({baseDate, clocks:[{type,time,data}]}):
//     type 1 in, 2 out, 6 time-code switch (data carries TCODE=MEAL|WRK).
//   • ~0.25 s a page, so ~16–25 s a store-day.
//
// Punches are PII and each punch's data carries device GPS; only the name,
// type, time and TCODE leave the page, and they are cached locally only.

/**
 * Runs IN the timesheet page (MAIN world). Serialised: no closures, no
 * imports, plain-JSON result.
 *
 *   { op: "team", store }  → { teamId, label } | { error }
 *   { op: "day", teamId, date } → { pages, rows: [[name, [[type, "YYYYMMDDHHMMSS", tcode]...]]] } | { error, drift }
 */
export async function gtaStoreInPage(req) {
  const base = "/gtaapp";
  const post = (url, body, json) => fetch(url, {
    method: "POST", credentials: "include",
    headers: json ? { "Content-Type": "application/json; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" }
                  : { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  try {
    const sel = await fetch(`${base}/action/dailytimesheet.action?action=SelectTimesheetAction`, { credentials: "include" });
    const html = await sel.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const wbat = doc.querySelector("input[name=wbat]")?.value;
    if (!wbat) {
      return { error: /login|sign ?in|saml/i.test(html.slice(0, 4000))
        ? "the timesheet needs a sign-in — open timesheet.cloud.wal-mart.com and sign in"
        : "the timesheet selection page did not load" };
    }

    if (req.op === "team") {
      const layer = doc.getElementById("WBT_IDS_layer");
      const ds = (n) => (html.match(new RegExp(`${n}='([^']*)'`)) || [])[1] || "";
      if (!layer) return { error: "the timesheet has no team picker for this sign-in" };
      const spec = ds(layer.getAttribute("dss") || "DS_2"), label = ds(layer.getAttribute("fls") || "DS_3");
      const call = async (extra) => {
        const r = await post(`${base}/services/platform/dblookup/getdblookup`, JSON.stringify({
          key: "", label: escape(label), fields: "", pageSize: "200", dataSourceType: "REGISTERED",
          dataSourceSpec: escape(spec), dataSourceParams: escape(layer.getAttribute("dsp") || ""),
          where: "", addWhere: "", filtersDuplicatesBySQL: "", initialBlank: "", multiple: "Y", ...extra,
        }), true);
        return JSON.parse(await r.text());
      };
      const head = await call({});
      let fieldNames = "";
      try { fieldNames = JSON.parse(head[0].data[0]).fieldNames || ""; } catch {}
      const all = await call({ pageNum: 0, initialBlank: false, fieldNames, criteria: "", sortOrderBy: null });
      const cell = (c) => String(c ?? "").split("~|~")[0].trim();
      const want = String(req.store).padStart(5, "0");
      // Plain loop on purpose: the timesheet page ships a legacy library that
      // replaces Array.prototype.find (it returns -1 there).
      let hit = null;
      for (let i = 1; i < all.length && !hit; i++) {
        const d = all[i]?.data;
        if (Array.isArray(d) && cell(d[1]) === want) hit = d;
      }
      if (!hit) return { error: `the timesheet sign-in does not cover store ${req.store}` };
      return { teamId: cell(hit[0]), label: cell(hit[2]) };
    }

    if (req.op === "day") {
      const [y, m, d] = req.date.split("-");
      const f = new URLSearchParams({
        wbat, pageAction: "", FROM_DAILY_SELECTION: "true", VIEW_SELECTION: "0", CREATE_DEFAULT_RECORDS: "N",
        EMPLOYEE_IDS: "", EMPLOYEE_IDS_label: "", WBT_IDS: String(req.teamId), WBT_IDS_label: "", INCLUDE_SUB_TEAMS: "Y",
        DATE_SELECTION: "7", TS_DATE_SELECTION_UI_EXTRA: "", TS_DATE_SELECTION_UI_MANUAL: "7",
        START_DATE: `${y}${m}${d} 000000`, START_DATE_dummy: `${m}/${d}/${y}`,
        END_DATE: `${y}${m}${d} 000000`, END_DATE_dummy: `${m}/${d}/${y}`, wbXpos: "0", wbYpos: "0",
      });
      for (let i = 1; i <= 10; i++) f.set(`TDF_FIELD${i}`, "null");

      const parse = (h) => {
        const rows = [];
        const parts = h.split(/<tr id='tsRow\d+'/);
        for (let i = 1; i < parts.length; i++) {
          const ch = parts[i];
          const who = /class=.textMedium.>([^<]+?)\s+-\s+\d{6,}</.exec(ch);
          const cl = /baseDate:'\d{8}'[^[]*clocks:\[(.*?)\]\s*\}\)/s.exec(ch);
          if (!who || !cl) continue;
          const clocks = [];
          for (const p of cl[1].matchAll(/\{type:'(\d+)',time:'(\d{12,14})'(?:,data:'([^']*)')?/g)) {
            clocks.push([Number(p[1]), p[2], (/TCODE=([A-Z_]+)/.exec(p[3] || "") || [])[1] || ""]);
          }
          if (clocks.length) rows.push([who[1].replace(/\s+/g, " ").trim(), clocks]);
        }
        const pm = /Page\s+(\d+)\s+of\s+(\d+)/.exec(h.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "));
        return { rows, page: pm ? Number(pm[1]) : null, of: pm ? Number(pm[2]) : null, none: /No Associates found/i.test(h) };
      };

      let pg = parse(await (await post(`${base}/action/dailytimesheet.action?action=LoadEmployeeAction`, f.toString())).text());
      if (pg.none) return { pages: 0, rows: [] };
      if (pg.page !== 1 || !pg.of) return { error: "the timesheet did not return a paged team list", drift: true };
      const rows = [...pg.rows];
      for (let k = 1; k < pg.of; k++) {
        const body = `action=ViewTimesheetAction&TS_STARTING_ROW=${k * 7}&SHOW_APPLIED_OVERRIDES=&INLINE_DETAILS_EXPANDED=`;
        const next = parse(await (await post(`${base}/action/dailytimesheet.action`, body)).text());
        if (next.page !== k + 1) return { error: `timesheet page ${k + 1} came back as ${next.page}`, drift: true };
        rows.push(...next.rows);
      }
      return { pages: pg.of, rows };
    }
    return { error: `unknown op ${req.op}` };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

const KIND = { 1: "in", 2: "out", 6: "switch" };

/**
 * [[type, "YYYYMMDDHHMMSS", tcode]] → [{ kind, min, code }], minutes since
 * midnight of `date` (a punch after midnight counts past 1440). Pure.
 */
export function decodeClocks(clocks, date) {
  const day0 = Date.parse(`${date}T00:00:00Z`);
  return (clocks || []).map(([type, t, code]) => {
    const s = String(t);
    const d = Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`);
    const min = Math.round((d - day0) / 60000) + Number(s.slice(8, 10)) * 60 + Number(s.slice(10, 12));
    return { kind: KIND[type] || `t${type}`, min, code: code || null };
  }).sort((a, b) => a.min - b.min);
}
