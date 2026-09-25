// modules/digitalmetrics/lib/pages/insights.js

import { section, empty, esc, table, statCard, statRow } from "./_shared.js";
import {
  dailyPicks, digitalTone, distribution,
  storeHelpPeakHours, formatHour, lateStarts, helpVsExpress,
} from "../data/insights.js";
import { weekPickBreakdown, actualPickHoursByName, exceptionSplit, dateKey } from "../data/adherence.js";
import { firstHourStarts, clockText } from "../data/first_pick.js";
import { dayShortfall, underPickLeaders, longMeals, capacityRow } from "../data/shortfall.js";

const WEEKDAY = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "numeric", day: "numeric" });
const h = (n) => `${n.toFixed(1)}h`;

/** A collapsed drill-down section: the glance table up top carries the story,
 *  everything below it is detail on demand. */
const fold = (title, body) => (body
  ? `<details class="dm-fold"><summary>${esc(title)}</summary><div class="dm-fold-body">${body}</div></details>`
  : "");
const pct = (actual, assigned) => (assigned > 0 ? Math.round((actual / assigned) * 100) : null);
const tone = (p) => (p == null ? "" : p < 70 ? "is-bad" : p > 110 ? "is-warn" : "is-good");

/**
 * Picking and exception work side by side, per associate. Exceptions are not
 * timed in the metrics (their Pick Hours exclude exception time), so that side
 * is EXC hours from the board against exception items from the metrics.
 */
function exceptionSection(ctx) {
  if (!ctx.assignmentsByDate) return "";
  const rows = exceptionSplit(ctx.assignmentsByDate, ctx.rawData);
  if (!rows.length) return "";
  const per = (a, b) => (b > 0 ? Math.round(a / b) : null);
  const share = (a, b) => (b > 0 ? Math.round((a / b) * 100) : null);
  const dash = (v, suffix = "") => (v == null ? "—" : `${v}${suffix}`);

  const body = table([
    { label: "Associate", key: "name" },
    { label: "Days", key: "days", align: "right" },
    { label: "EXC hrs (board)", key: "excHours", align: "right" },
    { label: "Exception items", key: "excReq", align: "right" },
    { label: "Items / EXC hr", key: "excRate", align: "right",
      format: (r) => esc(dash(per(r.excReq, r.excHours))) },
    { label: "Picked as req.", key: "excFtp", align: "right",
      format: (r) => esc(dash(share(r.excPicked, r.excReq), "%")) },
    { label: "Nil / sub", key: "excNil", align: "right", format: (r) => esc(`${r.excNil} / ${r.excSub}`) },
    { label: "PICK hrs assigned", key: "pickAssigned", align: "right", format: (r) => esc(h(r.pickAssigned)) },
    { label: "Pick hrs actual", key: "pickActual", align: "right", format: (r) => esc(h(r.pickActual)) },
    { label: "Pick adherence", key: "adh", align: "right",
      format: (r) => { const q = pct(r.pickActual, r.pickAssigned); return q == null ? "—" : `<strong class="${tone(q)}">${q}%</strong>`; } },
    { label: "Items / pick hr", key: "pickRate", align: "right",
      format: (r) => esc(dash(per(r.regItems, r.pickActual))) },
  ], rows);

  return `
    <p class="dm-stat-note">Everyone who had EXC hours on the Daily Board or handled exception items this week,
      with their exception work and their regular picking shown separately. The metrics do not time
      exception work (their pick hours exclude it), so exceptions are measured in items per board EXC hour;
      pick adherence compares only PICK hours.</p>
    ${body}`;
}

/**
 * Assigned vs actual pick hours for the loaded week: by day, then by
 * associate with the biggest shortfall first. Assigned hours are net of
 * expected 15-minute breaks that land on Pick hours (adherence.js).
 */
function pickHoursSection(ctx) {
  const byDate = ctx.assignmentsByDate;
  if (byDate == null) return empty("Loading assignments…");
  if (!Object.keys(byDate).length) {
    return empty("No assignments saved for this week, so there is nothing to compare picking against.");
  }
  const { days, people } = weekPickBreakdown(byDate, actualPickHoursByName(ctx.rawData), ctx.classifications);

  const dayTable = table([
    { label: "Day",      key: "date", format: (d) => esc(WEEKDAY(d.date)) },
    { label: "Assigned", key: "assigned", align: "right", format: (d) => esc(h(d.assigned)) },
    { label: "Actual",   key: "actual",   align: "right", format: (d) => esc(h(d.actual)) },
    { label: "Short",    key: "short",    align: "right",
      format: (d) => esc(h(Math.max(0, d.assigned - d.actual))) },
    { label: "Actual / assigned", key: "pct", align: "right",
      format: (d) => { const p = pct(d.actual, d.assigned); return p == null ? "—" : `<strong class="${tone(p)}">${p}%</strong>`; } },
    { label: "Associates", key: "people", align: "right", format: (d) => esc(d.people) },
  ], days);

  const dates = days.map((d) => d.date);
  const ranked = [...people].sort((a, b) => (b.assigned - b.actual) - (a.assigned - a.actual));
  const cell = (p, date) => {
    const v = p.byDate[date];
    if (!v) return `<td class="is-right dm-stat-note">—</td>`;
    const q = pct(v.actual, v.assigned);
    return `<td class="is-right" title="${esc(`${h(v.actual)} picked of ${h(v.assigned)} assigned`)}">
      <span class="${tone(q)}">${esc(v.actual.toFixed(1))}</span><span class="dm-stat-note"> / ${esc(v.assigned.toFixed(1))}</span></td>`;
  };
  const personTable = ranked.length ? `
    <div class="dm-table-scroll"><table class="data-table">
      <thead><tr><th>Associate</th>${dates.map((d) => `<th class="is-right">${esc(WEEKDAY(d))}</th>`).join("")}
        <th class="is-right">Week picked / assigned</th><th class="is-right">%</th></tr></thead>
      <tbody>${ranked.map((p) => { const q = pct(p.actual, p.assigned); return `<tr>
        <td>${esc(p.name)}</td>${dates.map((d) => cell(p, d)).join("")}
        <td class="is-right">${esc(h(p.actual))} / ${esc(h(p.assigned))}</td>
        <td class="is-right">${q == null ? "—" : `<strong class="${tone(q)}">${q}%</strong>`}</td></tr>`; }).join("")}
      </tbody></table></div>` : empty("No Digital or Exceptions associates were assigned Pick this week.");

  return `
    <p class="dm-stat-note">Assigned = Pick hours on the Assignments grid, less a 15-minute break wherever one is
      expected on a Pick hour. Actual = pick time in the metrics. Each cell is picked / assigned hours.
      Days with Pick assigned but nothing picked count as 0.</p>
    ${dayTable}${personTable}`;
}

// ── Capacity & digital shortfall ─────────────────────────────────────────
//
// Plan vs volume vs delivery, and where the plan leaked. The plan side is the
// WFM schedule + board (TLs erase call-ins from the board live, so the board
// alone under-states it); the presence side is GTA punches (clockIns). Both
// arrive async — the sections render what they have and say what is missing.

const signedH = (v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}h`;
const signedTone = (v) => (v >= 0 ? "is-good" : v > -10 ? "is-warn" : "is-bad");

function shortfallSections(ctx, daily) {
  const { rawData = [], clockIns = {}, assignmentsByDate, schedulesByDate } = ctx;
  if (!assignmentsByDate) return null;
  const actualByName = actualPickHoursByName(rawData);

  // Total pick hours per day (everyone, help included), for the demonstrated
  // rates that price "required hours".
  const hoursByIso = new Map();
  {
    let last = null;
    for (const row of rawData) {
      if (row["Pick Date"]) last = dateKey(row["Pick Date"]);
      if (!last) continue;
      const hr = typeof row["Pick Hours"] === "number" ? row["Pick Hours"] : 0;
      hoursByIso.set(last, (hoursByIso.get(last) || 0) + hr);
    }
  }

  // The store's own blended rates, from the days whose Express pull exists.
  let nonExpressRate = 93, expressRate = 60;
  {
    const withExp = daily.filter((d) => d.expressRateHours > 0);
    const expU = withExp.reduce((s, d) => s + d.expressRateUnits, 0);
    const expH = withExp.reduce((s, d) => s + d.expressRateHours, 0);
    const nonU = withExp.reduce((s, d) => s + (d.total - d.expressRateUnits), 0);
    const nonH = withExp.reduce((s, d) => s + ((hoursByIso.get(dateKey(d.date)) || 0) - d.expressRateHours), 0);
    if (expH > 0) expressRate = Math.round(expU / expH);
    if (nonH > 0) nonExpressRate = Math.round(nonU / nonH);
  }

  const rows = [];   // every loaded day; ds only where a board exists
  for (const d of daily) {
    const iso = dateKey(d.date);
    const board = assignmentsByDate[iso];
    const ds = board
      ? dayShortfall(board.associates, schedulesByDate?.[iso]?.associates || [],
          clockIns[iso] || null, actualByName, iso)
      : null;
    const cap = ds ? capacityRow({
      units: d.total, expressUnits: d.expressRateUnits ?? null,
      plan: ds.plan, delivered: ds.delivered, helpHours: d.storeHelpHours,
      nonExpressRate, expressRate,
    }) : null;
    rows.push({ iso, day: d, ds, cap, totalHours: hoursByIso.get(iso) || 0 });
  }
  const days = rows.filter((x) => x.ds);
  const noClock = days.filter((x) => !x.ds.clockCoverage).length;

  // ── Week at a Glance ───────────────────────────────────────────────────
  // The one table that answers "how did the day go": the plan, what digital
  // actually picked, the gap, and who absorbed it. Everything below is
  // drill-down.
  const dash = (v, f) => (v == null ? `<span class="dm-stat-note">—</span>` : f(v));
  const glanceTable = table([
    { label: "Day", key: "iso", format: (x) => esc(WEEKDAY(x.iso)) },
    { label: "Units", key: "units", align: "right", format: (x) => esc(x.day.total.toLocaleString()) },
    { label: "Sched. Pick", key: "plan", align: "right",
      format: (x) => dash(x.ds?.plan, (v) => esc(h(v))) },
    { label: "Actual Pick", key: "del", align: "right",
      format: (x) => dash(x.ds?.delivered, (v) => esc(h(v))) },
    { label: "Gap", key: "gap", align: "right",
      format: (x) => x.ds
        ? `<strong class="${signedTone(-(x.ds.plan - x.ds.delivered))}">${esc(h(x.ds.plan - x.ds.delivered))}</strong>`
        : `<span class="dm-stat-note">—</span>` },
    // The gap's attendance slice — absences + tardies + early departures in
    // one number, the split and the names on hover. Zero renders as a quiet
    // dash so a clean day reads clean.
    { label: "Attendance", key: "attendance", align: "right",
      format: (x) => {
        if (!x.ds) return `<span class="dm-stat-note">—</span>`;
        const b = x.ds.buckets;
        const total = b.callin + b.tardy + b.leftEarly;
        if (total < 0.1) return `<span class="dm-stat-note">—</span>`;
        const part = (k, label) => (b[k]
          ? `${label} ${b[k]}h: ${x.ds.people[k].slice(0, 5).map((p) => `${p.name} ${p.hours}h`).join(", ")}`
          : "");
        const tip = [part("callin", "absent"), part("tardy", "tardy"), part("leftEarly", "left early")]
          .filter(Boolean).join(" · ");
        return `<span class="is-warn" title="${esc(tip)}">${esc(h(total))}</span>`;
      } },
    { label: "Express Hrs", key: "exp", align: "right",
      format: (x) => dash(x.day.expressRateHours, (v) => esc(h(v))) },
    { label: "Store Help Hrs", key: "help", align: "right", format: (x) => esc(h(x.day.storeHelpHours)) },
    { label: "Total Hrs", key: "tot", align: "right", format: (x) => esc(h(x.totalHours)) },
  ], rows);
  const wk = (f) => days.reduce((s, x) => s + f(x), 0);
  const glanceCards = days.length ? statRow([
    statCard("Sched. Pick", h(wk((x) => x.ds.plan))),
    statCard("Actual Pick", h(wk((x) => x.ds.delivered)),
             { note: `${Math.round((wk((x) => x.ds.delivered) / Math.max(1, wk((x) => x.ds.plan))) * 100)}% of plan` }),
    statCard("Gap", h(wk((x) => x.ds.plan - x.ds.delivered)), { tone: "warn" }),
    statCard("Store Help", h(daily.reduce((s, d) => s + d.storeHelpHours, 0)), { tone: "help" }),
  ]) : "";
  const glance = glanceCards + `
    <p class="dm-stat-note">Sched. Pick = WFM schedule + board, call-ins the board no longer shows included,
      lunches on pick hours excluded. Rates this week: ${nonExpressRate}/hr regular, ${expressRate}/hr Express.</p>
    ${glanceTable}`;
  if (!days.length) return { glance, shortfall: "", underPick: "", lunches: "" };

  // ── Shortfall buckets ──────────────────────────────────────────────────
  const BUCKETS = [
    ["callin", "Call-ins"], ["reassigned", "Reassigned"],
    ["tardy", "Tardy"], ["leftEarly", "Left Early"], ["underPick", "Under-picked"],
  ];
  const names = (x, k) => x.ds.people[k].slice(0, 6).map((p) => `${p.name} ${p.hours}h`).join(", ");
  const sfTable = table([
    { label: "Day", key: "iso", format: (x) => esc(WEEKDAY(x.iso)) },
    { label: "Gap", key: "gap", align: "right",
      format: (x) => `<strong>${esc(h(Math.max(0, x.ds.plan - x.ds.delivered)))}</strong>` },
    ...BUCKETS.map(([k, label]) => ({
      label, key: k, align: "right",
      format: (x) => x.ds.buckets[k]
        ? `<span title="${esc(names(x, k))}">${esc(h(x.ds.buckets[k]))}</span>`
        : `<span class="dm-stat-note">—</span>`,
    })),
  ], days);
  const weekTop = (k) => {
    const agg = new Map();
    for (const x of days) for (const p of x.ds.people[k]) agg.set(p.name, (agg.get(p.name) || 0) + p.hours);
    return [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([n, hrs]) => `${n} ${Math.round(hrs * 10) / 10}h`).join(", ");
  };
  const weekLines = BUCKETS.map(([k, label]) => {
    const total = days.reduce((s, x) => s + x.ds.buckets[k], 0);
    return total >= 0.1 ? `<li><strong>${esc(h(Math.round(total * 10) / 10))}</strong> ${esc(label.toLowerCase())} — ${esc(weekTop(k))}</li>` : "";
  }).join("");
  // The pull's status must live HERE, beside the button: the detailed status
  // line sits in First-Hour Pick Starts, which is folded shut, so without
  // this a running pull looks like a dead button (the user, 2026-09-23).
  const pull = ctx.clockPull;
  const pullStatus = pull?.running
    ? `<strong>Pulling clock-ins from the timesheet…</strong> a full roster takes a few minutes;
       this page updates when it finishes.`
    : pull?.error ? `<strong class="is-bad">Clock-in pull failed:</strong> ${esc(pull.error)}
       — sign in at timesheet.cloud.wal-mart.com and try again.`
    : pull?.at ? `Clock-ins updated ${esc(new Date(pull.at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }))}:
       ${esc(String(pull.days ?? 0))} shift day(s) for ${esc(String(pull.matched ?? 0))} associate(s)${
       pull.unmatched?.length ? `. Not found in the timesheet: ${esc(pull.unmatched.join(", "))}` : ""}`
    : "";
  const shortfall = section("Digital Shortfall — Where the Plan Leaked", `
    <p class="dm-stat-note">Hover a cell for names. Call-ins count any digital no-show at full task
      hours — a dispenser's absence pulls a picker onto dispensing. Lunches landing on pick hours
      reduce the plan and blame nobody.${noClock ? ` <strong>${noClock} day(s) have no clock-in data
      yet</strong> — call-ins there are invisible until punches are pulled.
      <button class="btn" data-dm-pull-clockins ${pull?.running ? "disabled" : ""}>Pull clock-ins</button>` : ""}
      ${pullStatus ? `<span class="dm-stat-note"> ${pullStatus}</span>` : ""}</p>
    ${sfTable}<ul class="dm-issues">${weekLines}</ul>`);

  // ── Under-pick leaders ─────────────────────────────────────────────────
  const READ_LABEL = { bagging: "fast — bagging (ok)", "multi-task": "multi-task bleed",
                       slow: "SLOW + missing", leak: "unexplained" };
  const up = underPickLeaders(days.map((x) => ({
    roster: assignmentsByDate[x.iso].associates,
    schedule: schedulesByDate?.[x.iso]?.associates || [],
    clockDay: clockIns[x.iso] || null, actualByName, iso: x.iso,
  })), rawData);
  const upCards = statRow([
    statCard("Under-picked", h(up.totals.all)),
    statCard("Bagging (ok)", h(up.totals.bagging), { note: `top 20% rate, ≥${up.fastCut}/hr` }),
    statCard("Multi-task", h(up.totals.multiTask), { note: "4h+ other tasks or 100+ exceptions" }),
    statCard("Slow + missing", h(up.totals.slow), { tone: "warn", note: `<85% of ${up.teamRate}/hr` }),
    statCard("Unexplained", h(up.totals.leak), { tone: "warn" }),
  ]);
  const upTable = table([
    { label: "Associate", key: "name" },
    { label: "Days", key: "days", align: "right" },
    { label: "Under", key: "hours", align: "right", format: (p) => esc(h(p.hours)) },
    { label: "Rate", key: "rate", align: "right", format: (p) => esc(p.rate ?? "—") },
    { label: "Exc. Items", key: "excItems", align: "right" },
    { label: "Read", key: "read",
      format: (p) => `<span class="${p.read === "slow" || p.read === "leak" ? "is-warn" : "dm-stat-note"}">${esc(READ_LABEL[p.read])}</span>` },
  ], up.list.filter((p) => p.hours >= 1).slice(0, 15));
  const underPick = `
    <p class="dm-stat-note">Present pickers whose pick hours fell short of plan after punches and
      lunches are accounted for. Fast pickers bag their own orders after each walk — their gap is
      expected, not leakage.</p>${upCards}${upTable}`;

  // ── Long lunches ───────────────────────────────────────────────────────
  const isoSet = new Set(days.map((x) => x.iso));
  const meals = longMeals(Object.fromEntries(Object.entries(clockIns).filter(([iso2]) => isoSet.has(iso2))));
  const lunches = meals.length
    ? table([
        { label: "Day", key: "date", format: (m) => esc(WEEKDAY(m.date)) },
        { label: "Associate", key: "name" },
        { label: "Length", key: "minutes", align: "right",
          format: (m) => `${Math.floor(m.minutes / 60)}:${String(m.minutes % 60).padStart(2, "0")}` },
        { label: "Over By", key: "over", align: "right",
          format: (m) => `<strong class="is-bad">+${esc(m.over)}m</strong>` },
      ], meals)
    : empty("No meal window over 1:10 in the loaded days — lunches are running clean.");

  return { glance, shortfall, underPick, lunches, longLunchCount: meals.length };
}

// ── First-hour pick starts ───────────────────────────────────────────────
// Everyone whose first hour on the board is Pick: scheduled start, clock-in
// (Global Time & Attendance, pulled on demand), first pick scan.

const signed = (m) => (m == null ? "—" : m === 0 ? "on time" : m > 0 ? `+${m} min` : `${m} min`);
const lateTone = (m) => (m == null ? "" : m > 5 ? "is-bad" : m > 0 ? "is-warn" : "is-good");

function firstPickSection(ctx) {
  if (!ctx.assignmentsByDate) return "";
  const { days, people, totals } = firstHourStarts(ctx.assignmentsByDate, ctx.rawData, ctx.clockIns);
  const pull = ctx.clockPull;
  const when = pull?.at
    ? new Date(pull.at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : "";
  const how = pull?.at ? ` (${pull.auto ? "auto" : "manual"}, ${when}${pull.ms ? `, ${(pull.ms / 1000).toFixed(1)} s` : ""})` : "";
  const note = pull?.running ? "Pulling clock-ins from the timesheet…"
    : pull?.error ? `Clock-in pull failed${how}: ${pull.error}`
    : pull?.at ? `Clock-ins updated${how}: ${pull.days} shift day(s) for ${pull.matched} associate(s)` +
             (pull.unmatched?.length ? `. Not found in the timesheet: ${pull.unmatched.join(", ")}` : "") +
             (pull.errors?.length ? `. Errors: ${pull.errors.join("; ")}` : "")
    : totals.withClock ? "" : "No clock-ins yet. They update with each sync; sign in to the timesheet site if this stays empty.";
  const bar = `<div class="dm-toolbar">
      <button class="btn" data-dm-pull-clockins ${pull?.running ? "disabled" : ""}>Pull clock-ins</button>
      ${note ? `<span class="muted">${esc(note)}</span>` : ""}
    </div>`;
  if (!days.length) return bar + empty("No one assigned Pick in their first hour has a clock-in or first scan this week.");

  const cards = statRow([
    statCard("Associates", totals.associates),
    statCard("Late Clock-ins", totals.lateClockDays, { tone: totals.lateClockDays ? "warn" : "" }),
    statCard("Avg Clock → Pick", totals.avgClockToPick == null ? "—" : `${totals.avgClockToPick} min`),
    statCard("Time Lost", `${totals.lostMinutes} min`, { tone: "warn", note: "scheduled start → first pick" }),
  ]);
  const summary = table([
    { label: "Associate", key: "name" },
    { label: "Days", key: "dayCount", align: "right" },
    { label: "Avg Clock-in", key: "avgClockLate", align: "right",
      format: (p) => `<span class="${lateTone(p.avgClockLate)}">${esc(signed(p.avgClockLate))}</span>` },
    { label: "Avg Clock → Pick", key: "avgClockToPick", align: "right",
      format: (p) => esc(p.avgClockToPick == null ? "—" : `${p.avgClockToPick} min`) },
    { label: "Min Lost", key: "totalLost", align: "right" },
    { label: "Daily", key: "days", sortable: false,
      format: (p) => `<ul class="dm-issues">${p.days.map((d) =>
        `<li>${esc(WEEKDAY(d.date))} — sched ${esc(clockText(d.schedStart))}, in ${esc(clockText(d.clockIn))}` +
        `, first pick ${esc(clockText(d.firstPick))}${d.lost ? ` <strong class="is-bad">(${esc(d.lost)} min)</strong>` : ""}</li>`).join("")}</ul>` },
  ], people);
  return bar + cards + summary;
}

/** Buttons on this page. The pull button appears both in the shortfall note
 *  (when clock data is missing) and in First-Hour Pick Starts. */
export function wire(ctx, el) {
  const btns = [...el.querySelectorAll("[data-dm-pull-clockins]")];
  const onClick = () => ctx.onPullClockIns?.();
  for (const b of btns) b.addEventListener("click", onClick);
  return () => { for (const b of btns) b.removeEventListener("click", onClick); };
}

export function render(ctx) {
  const { rawData = [], associates = [], classifications = {}, express = null, expressRate = null } = ctx;
  if (!rawData.length) return empty("Select a store to see insights.");

  const daily = dailyPicks(rawData, classifications, express, expressRate);
  const dist  = distribution(daily);
  const peaks = storeHelpPeakHours(rawData, classifications);
  const late  = lateStarts(rawData, associates, classifications);

  // ── Daily volume ───────────────────────────────────────────────────────
  const dailyTable = table([
    { label: "Date",       key: "date" },
    { label: "Total",      key: "total",        align: "right",
      format: (d) => esc(d.total.toLocaleString()) },
    { label: "Digital",    key: "digitalTotal", align: "right",
      format: (d) => esc(d.digitalTotal.toLocaleString()) },
    { label: "Store Help", key: "storeHelp",    align: "right",
      format: (d) => esc(d.storeHelp.toLocaleString()) },
    // What the borrowed help cost the store: their Pick Hours for the day.
    { label: "Help Hours", key: "storeHelpHours", align: "right",
      format: (d) => esc(d.storeHelpHours ? h(d.storeHelpHours) : "—") },
    { label: "Digital %",  key: "digitalPct",   align: "right",
      format: (d) => `<strong class="is-${esc(digitalTone(d.digitalPct))}">${esc(d.digitalPct)}%</strong>` },
    // Express Pickup comes from a different dashboard, one Tableau load per
    // day, so a day can be missing while its picks are not. "—" is "not
    // pulled yet"; 0 is a real zero.
    { label: "Express Orders", key: "expressOrders", align: "right",
      format: (d) => esc(d.expressOrders == null ? "—" : d.expressOrders.toLocaleString()) },
    { label: "Express Picks",  key: "expressPicks",  align: "right",
      format: (d) => esc(d.expressPicks == null ? "—" : d.expressPicks.toLocaleString()) },
    { label: "Express Pick Rate", key: "expressRate", align: "right",
      format: (d) => esc(d.expressRate == null ? "—" : d.expressRate.toFixed(1)) },
  ], daily, { emptyMessage: "No dated rows in this week." });

  const range = daily.length
    ? `${daily[daily.length - 1].date} – ${daily[0].date} · ${daily.length} days`
    : "";

  const expressCardList = [
    ...(dist.expressDays ? [
      statCard("Express Orders", dist.expressOrders.toLocaleString(),
               { note: `${dist.expressDays} of ${daily.length} days` }),
      statCard("Express Picks",  dist.expressPicks.toLocaleString(),
               { note: "UNITS on the Metric Overview" }),
    ] : []),
    ...(dist.expressRate != null ? [
      statCard("Express Pick Rate", dist.expressRate.toFixed(1),
               { note: `units/hr · ${dist.expressRateDays} of ${daily.length} days` }),
    ] : []),
  ];
  const expressCards = expressCardList.length ? statRow(expressCardList) : "";

  // ── Split ──────────────────────────────────────────────────────────────
  const split = statRow([
    statCard("Total Picks",     dist.total.toLocaleString()),
    statCard("Digital",         `${dist.digitalPct}%`,
             { note: `${dist.digitalTotal.toLocaleString()} picks` }),
    statCard("Store Help",      `${dist.storeHelpPct}%`,
             { tone: "help", note: `${dist.storeHelp.toLocaleString()} picks` }),
    statCard("Store Help Hours", h(dist.storeHelpHours),
             { tone: "help", note: "pick hours worked by borrowed help" }),
  ]);

  // ── Store Help vs Express ──────────────────────────────────────────────
  // Does more Express work mean more borrowed help? Compare the two hour
  // figures on the days where the Express pick-rate pull exists.
  const hve = helpVsExpress(daily);
  const rText = hve.r == null ? "—"
    : hve.r >= 0.7 ? `${hve.r} — strong: heavy Express days are heavy Store Help days`
    : hve.r >= 0.4 ? `${hve.r} — moderate link`
    : hve.r >= -0.4 ? `${hve.r} — little to no link`
    : `${hve.r} — inverse: help shows up on light Express days`;
  const helpExpressSection = hve.days.length
    ? statRow([
        statCard("Days Compared", hve.days.length,
                 { note: `of ${daily.length} loaded (needs the Express rate pull)` }),
        statCard("Store Help Hours", h(hve.helpHours), { tone: "help" }),
        statCard("Express Pick Hours", h(hve.expressHours)),
        statCard("Correlation", hve.r == null ? "—" : hve.r,
                 { note: hve.r == null ? "needs 3+ compared days" : rText.replace(/^[-\d.]+ — /, "") }),
      ]) + table([
        { label: "Date", key: "date" },
        { label: "Store Help Hours", key: "storeHelpHours", align: "right",
          format: (d) => esc(d.storeHelpHours ? h(d.storeHelpHours) : "—") },
        { label: "Express Hours", key: "expressRateHours", align: "right",
          format: (d) => esc(h(d.expressRateHours)) },
        { label: "Express Picks", key: "expressRateUnits", align: "right",
          format: (d) => esc(d.expressRateUnits.toLocaleString()) },
        { label: "Store Help Picks", key: "storeHelp", align: "right",
          format: (d) => esc(d.storeHelp.toLocaleString()) },
      ], hve.days)
    : empty("No days with an Express pick-rate pull yet — pull Express to compare.");

  // ── Peak hours ─────────────────────────────────────────────────────────
  const peakCards = peaks.slice(0, 5).map((h, i) =>
    statCard(`#${i + 1} Peak Hour`, formatHour(h.hour),
             { note: `${h.picks.toLocaleString()} picks (${h.pct}%)` }));

  const peakSection = peaks.length
    ? statRow(peakCards) + table([
        { label: "Hour",       key: "hour",  format: (h) => esc(formatHour(h.hour)) },
        { label: "Associates", key: "count", align: "right" },
        { label: "Picks",      key: "picks", align: "right",
          format: (h) => esc(h.picks.toLocaleString()) },
        { label: "Share",      key: "pct",   align: "right", format: (h) => `${esc(h.pct)}%` },
      ], peaks)
    : empty("No Store Help scan times in this week.");

  // ── Late starts ────────────────────────────────────────────────────────
  const lateSection = late.associateCount
    ? statRow([
        statCard("5am Associates", late.associateCount),
        statCard("Avg Start",      `5:${String(late.avgStartMinutes).padStart(2, "0")} AM`),
        statCard("Late Days",      late.totalLateDays, { tone: "warn" }),
        statCard("Time Lost",      `${late.totalLostMinutes} min`, { tone: "warn" }),
        statCard("Est. Picks Lost", late.totalLostPicks.toLocaleString(),
                 { tone: "warn", note: "estimate" }),
      ]) + table([
        { label: "Associate", key: "name" },
        { label: "Days",      key: "dayCount",  align: "right" },
        { label: "Avg Start", key: "avgMinutes", align: "right",
          format: (p) => `5:${String(p.avgMinutes).padStart(2, "0")} AM` },
        { label: "Late Days", key: "lateDays",  align: "right",
          format: (p) => esc(p.lateDays.length) },
        { label: "Min Lost",  key: "totalLost", align: "right" },
        { label: "Est. Picks Lost", key: "lostPicks", align: "right",
          format: (p) => esc(p.lostPicks.toLocaleString()) },
        { label: "Daily", key: "days",
          format: (p) => `<ul class="dm-issues">${p.days
            .map((d) => `<li>${esc(d.date)} — 5:${esc(String(d.minutes).padStart(2, "0"))}${
              d.minutes > 5 ? " ⚠" : ""}</li>`).join("")}</ul>` },
      ], late.people.slice(0, 5))
    : empty("No 5am associates in this week.");

  // The glance table + shortfall ledger carry the story; every other view is
  // a collapsed drill-down (the user, 2026-09-23: the tab had gotten
  // convoluted).
  const parts = shortfallSections(ctx, daily);
  const lead = parts
    ? section(`Week at a Glance${range ? ` — ${range}` : ""}`, parts.glance) + parts.shortfall
    : section(`Daily Picks${range ? ` — ${range}` : ""}`,
        `<p class="dm-stat-note">Loading assignments…</p>` + expressCards + dailyTable);

  return [
    lead,
    fold("Daily Picks & Express detail", parts ? expressCards + dailyTable : ""),
    fold("Under-picked While Present", parts?.underPick),
    fold(`Excessive Lunches (>1:10)${parts?.longLunchCount ? ` — ${parts.longLunchCount} flagged` : ""}`, parts?.lunches),
    fold("Digital vs Store Help", split),
    fold("Store Help vs Express", `
      <p class="dm-stat-note">Express pick hours against borrowed-help hours, day by day, on the days
        the Express pick-rate pull covers. A strong correlation suggests Express volume is what pulls
        store help onto picking; it is a pattern over few days, not proof.</p>
      ${helpExpressSection}`),
    fold("Store Help Peak Hours", peakSection),
    fold("First-Hour Pick Starts", firstPickSection(ctx)),
    fold("5am Late Starts", lateSection),
    fold("Pick Hours — Assigned vs Actual", pickHoursSection(ctx)),
    fold("Exceptions vs Picking", exceptionSection(ctx)),
  ].join("");
}
