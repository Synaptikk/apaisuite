// modules/punchlookup/service.js
//
// Punch Lookup — service-worker half.
//   search { q }              → { ok, matches: [{ empId, win, gtaName }] }
//   load   { empId, from, to } → { ok, days: [...], from, to, pulledAt }
//   me / cases_mine / resolve_link / case_* → shared cases (case_service.js)
//   audit_team {}             → { ok, teamId, store, label }   store-wide edit review:
//   audit_day { teamId, date }→ { ok, date, rows: [{ name, punches }] } (lib/audit.js shapes)
//   audit_starts { store, dates } → { ok, starts: { date: { nameKey: min } } } (WFM schedules)
// A lookup is never written to storage here; a shared case lives in its
// owner's OneDrive, behind OneDrive sharing.

import { withTimesheet } from "./lib/gta.js";
import { parseTimesheetPage, parseDetails, planSearch, filterMatches } from "./lib/parse.js";
import { parseLookupRows } from "../digitalmetrics/lib/data/gta_parse.js";
import { caseHandlers } from "./case_service.js";
import { classifyClock, nameKey, parseShiftStart } from "./lib/audit.js";
import { schedules } from "../digitalmetrics/lib/firestore.js";
import { getUserHomeStore } from "../../shared/userStore.js";

const MAX_DAYS = 93;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function fail(e) { return { ok: false, error: String(e?.message || e) }; }

/** One load, checked: every page in order and every row the asked-for employee. */
async function loadOnce(call, empId, from, to) {
  const { pages, details } = await call({ op: "load", empId, from, to, details: true });
  const rows = [];
  for (const [k, html] of pages.entries()) {
    const pg = parseTimesheetPage(html);
    if (pg.none) return { rows: [], details: {} };
    if (pg.page != null && pg.page !== k + 1) return { drift: `page ${k + 1} came back as ${pg.page}` };
    const foreign = pg.rows.find((r) => r.empId && r.empId !== String(empId));
    if (foreign) return { drift: "another pull swapped the timesheet selection" };
    rows.push(...pg.rows);
  }
  return { rows, details: details || {} };
}

const base = {
  async search(msg) {
    const plan = planSearch(msg.q);
    if (!plan) return { ok: false, error: "Type at least two letters of a name, or a WIN." };
    try {
      return await withTimesheet(async (call) => {
        const res = await call({ op: "search", by: plan.by, term: plan.term });
        if (res.status !== 200) { console.warn("[punchlookup] timesheet search HTTP", res.status); return { ok: false, error: "The timesheet search failed — try again." }; }
        const matches = filterMatches(parseLookupRows(res.text), plan)
          .sort((a, b) => a.gtaName.localeCompare(b.gtaName));
        return { ok: true, matches };
      });
    } catch (e) { return fail(e); }
  },

  async load(msg) {
    const { empId, from, to } = msg;
    if (!empId || !ISO.test(from || "") || !ISO.test(to || "")) return { ok: false, error: "Pick an associate and a date range." };
    if (from > to) return { ok: false, error: "The start date is after the end date." };
    const span = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
    if (span > MAX_DAYS) return { ok: false, error: `Pick ${MAX_DAYS} days or fewer.` };
    try {
      return await withTimesheet(async (call) => {
        let got = await loadOnce(call, empId, from, to);
        if (got.drift) got = await loadOnce(call, empId, from, to);
        if (got.drift) return { ok: false, error: `The timesheet changed under the pull (${got.drift}). Try again in a minute.` };

        const rows = got.rows.filter((r) => r.date >= from && r.date <= to);
        const days = rows.map((r) => {
          const det = got.details[r.index] ? parseDetails(got.details[r.index]) : { segments: [], flags: [] };
          // Attendance codes (AT_*) ride on the day's own row too; those are the
          // reliable copy, the details block adds any the row leaves out.
          const flags = [...r.timeCodes.filter((c) => /^AT_/.test(c.code)).map((c) => ({ code: c.code, hourType: null })), ...det.flags]
            .filter((f, i, all) => all.findIndex((g) => g.code === f.code) === i);
          return {
            date: r.date, scheduled: r.scheduled, worked: r.worked, status: r.status,
            timeCodes: r.timeCodes.filter((c) => !/^AT_/.test(c.code)), hourTypes: r.hourTypes, punches: r.punches,
            segments: det.segments, flags,
          };
        });
        return { ok: true, empId, from, to, days, pulledAt: Date.now() };
      });
    } catch (e) { return fail(e); }
  },
};

// Store-wide punch-edit review: the view walks the days and caches them.
const audit = {
  async audit_team(msg) {
    try {
      const store = String(msg.store || (await getUserHomeStore().catch(() => "")) || "");
      return await withTimesheet(async (call) => ({ ok: true, ...(await call({ op: "storeTeam", store })) }));
    } catch (e) { return fail(e); }
  },

  async audit_day(msg) {
    if (!msg.teamId || !ISO.test(msg.date || "")) return { ok: false, error: "Need a team and a date." };
    try {
      return await withTimesheet(async (call) => {
        let res;
        // The selection lives in the server session; another pull between two
        // pages swaps it (drift) — run the day again once.
        try { res = await call({ op: "storeDay", teamId: msg.teamId, date: msg.date }); }
        catch (e) { if (!/came back as|paged team list/.test(String(e?.message))) throw e; res = await call({ op: "storeDay", teamId: msg.teamId, date: msg.date }); }
        const rows = res.rows.map(([name, clocks]) => ({ name, punches: clocks.map(([t, time, data]) => classifyClock(t, time, data)) }));
        return { ok: true, date: msg.date, pages: res.pages, pageSize: res.pageSize, rows, pulledAt: Date.now() };
      });
    } catch (e) { return fail(e); }
  },

  async audit_starts(msg) {
    const store = String(msg.store || "").replace(/^0+/, "");
    if (!store) return { ok: false, error: "No store." };
    const starts = {};
    await Promise.all((msg.dates || []).filter((d) => ISO.test(d)).map(async (d) => {
      const doc = await schedules.get(store, d).catch(() => null);
      const map = {};
      for (const a of doc?.associates || []) {
        const m = parseShiftStart(a.shiftStart);
        const k = nameKey(a.name);
        if (m != null && (map[k] == null || m < map[k])) map[k] = m;
      }
      if (Object.keys(map).length) starts[d] = map;
    }));
    return { ok: true, starts };
  },
};

// Shared cases (OneDrive) reuse the range loader for "refresh punches".
export const handlers = { ...base, ...audit, ...caseHandlers((msg) => base.load(msg)) };
