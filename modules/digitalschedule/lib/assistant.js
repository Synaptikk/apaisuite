// modules/digitalschedule/lib/assistant.js
//
// The schedule assistant: Claude (through the AI gateway, lib/gateway.js) with
// the loaded week in its system prompt and tools that work on the SAME queue
// the page shows. It can look people up, queue / remove changes, run the
// fitter and the scheduler's validator. It cannot save: saving stays the
// page's Save button and its confirm dialog (the skill's rule — a shown plan
// is not approval).
//
// No DOM here. The view hands in a controller:
//   ctl = { data(), queue(), setQueue(list), roleId() (one id or an array), scopeLabel()?, jobs(), rulesText(),
//           fitOpts(), areas()? (open-to-close areas, lib/areas.js), validate() → Promise<result | { error }>,
//           pastWeeks()? → Promise<[read result]> (cached earlier weeks of this store, newest first) }

import { GAP_LABEL, areaGaps, areaDelta, staggerLunches } from "./areas.js";
import { DOW, SHORT, toMin, coverage, summarize, applyChanges, describe, paidHours, IN_HOME_JOB, isMinor, PEAK_LABEL } from "./coverage.js";
import { parseRules } from "./rules.js";
import { suggest } from "./suggest.js";
import { headroom, headroomText, bestShift, lenFor } from "./headroom.js";
import { addHours } from "./addhours.js";

const r2 = (x) => Math.round(x * 100) / 100;
const fmtHM = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

function shiftText(s) {
  const l = (s.breaks || []).map((b) => `${b.paid ? "paid " : "lunch "}${b.start}-${b.end}`).join(" ");
  return `${s.start}-${s.end}${l ? " " + l : ""}${s.job ? ` [${s.job}]` : ""}`;
}

export function workerLine(w, dates) {
  const days = dates.map((d, i) => {
    const ss = w.shifts.filter((s) => s.day === d).map(shiftText);
    const ev = (w.otherEvents || []).filter((e) => e.day === d).map((e) => e.type);
    return `${DOW[i]} ${[...ss, ...ev].join(" + ") || "off"}`;
  }).join("; ");
  const av = w.availability ? SHORT.map((k) => `${k} ${w.availability[k] ?? "?"}`).join(", ") : "no availability record";
  const exc = (w.exceptions || []).map((e) => `${String(e.from).slice(0, 16)}→${String(e.to).slice(0, 16)}`).join(", ");
  const tags = [w.payType, w.employmentType, isMinor(w) && "MINOR",
    (String(w.job || "").includes(IN_HOME_JOB) || w.shifts.some((s) => s.job === IN_HOME_JOB)) && "IN-HOME"].filter(Boolean).join(" ");
  const paid = w.shifts.reduce((a, s) => a + paidHours(s), 0);
  return `${w.name} (id ${w.workerId}; ${tags}; ${r2(paid)} paid h) | ${days} | avail: ${av}${exc ? ` | exceptions: ${exc}` : ""}`;
}

function coverageText(data, roleId, jobs) {
  const days = coverage(data, roleId, jobs), sum = summarize(days);
  const t = (k) => r2(sum.reduce((a, s) => a + s[k], 0));
  return `WEEK: guidance ${t("guide")} h, scheduled ${t("sched")} h, short ${t("underHrs")} h, over ${t("overHrs")} h, blue ${t("blue")}/${t("hours")}
` + days.map((d, i) => {
    const hrs = d.need.map((n, h) => [h, n, d.have[h]]).filter(([, n, v]) => n > 0 || v > 0)
      .map(([h, n, v]) => `${String(h).padStart(2, "0")}:${r2(v)}/${r2(n)}`).join(" ");
    const s = sum[i];
    return `${DOW[i]} ${d.date} — blue ${s.blue}/${s.hours}, short ${r2(s.underHrs)} h, over ${r2(s.overHrs)} h. Hourly scheduled/guidance: ${hrs}`;
  }).join("\n");
}

export function buildSystem(ctl) {
  const data = ctl.data(), c = data.ctx, js = ctl.jobs();
  const roster = data.workers.filter((w) => w.shifts.some((s) => js.includes(s.job)));
  const q = ctl.queue();
  return `You are the scheduling assistant inside the ScheduleRight tool of a Walmart store manager's extension. You change next weeks' shifts in the Workforce Planning (Polaris) scheduler by QUEUEING changes; the manager reviews them on the page and presses Save. You cannot save, and must never claim you saved anything.

Store ${c.store} (${c.site || ""}), fiscal WK ${c.wk}: ${data.dates.map((d, i) => `${DOW[i]}=${d}`).join(", ")}. Today is ${new Date().toISOString().slice(0, 10)}; never change today or earlier days.
Scope being fitted: ${ctl.scopeLabel?.() || `role id ${ctl.roleId()}`} — guidance of role id(s) ${[ctl.roleId()].flat().join(", ")}, shifts of job codes ${js.join(", ")}.

HOW TO WORK
- Use find_associates when you need anyone not listed below, or to re-check someone. Names must match the roster exactly.
- Queue with queue_changes, then ALWAYS run check_with_scheduler and report the result (HARD = scheduler refuses; NEW WARN = this change adds a warning; about 20 soft warnings already sit on any week and are ignored).
- If a check fails, fix the change (lunch timing, another day) and re-check — don't hide problems. When rules conflict, ask the manager which one bends.
- For "fix the week to the guidance"-type requests use suggest_fit, then describe what it did and where it bent.
- The manager decides. If a request costs blue hours or payroll (adding hours over guidance, staffing past the graph), say so ONCE in a line with the number, then do it — don't refuse, don't make them ask twice, don't offer a menu instead of acting. Only push back on what the scheduler itself refuses (HARD) or a people/store rule; for those, do the legal part and list what was left out.
- "Add N hours" / "overschedule by N" / "max it out": suggest_fit with extraHours N (3000 for "max"). It fits to guidance, then fills short hours and spreads the rest by volume weighted to weekends and ${PEAK_LABEL}, in proper shifts. Then check_with_scheduler. headroom is for "who has room" questions.
- Earlier weeks: previous_weeks reads the weeks this browser loaded before (scheduled vs guidance as last read — not hours actually worked). Say which weeks it had.
- Only state facts you got from this prompt or a tool. The QUEUE section below and list_queue are the only truth about what is queued; MINOR/PT/FT come from the tags.
- Keep replies short: a before → after list of what you queued and the coverage effect. Use 12-hour times (9a, 1:30p) when talking to the manager.

CHANGE FORMAT (queue_changes)
{name, action: "edit"|"move"|"delete"|"create", day: "YYYY-MM-DD", from: "HH:MM" (existing shift start; required for edit/move/delete), start, end ("HH:MM" 24h; an end at or before start rolls past midnight), lunch: "HH:MM" (1 h unpaid) | "none", toDay (move only), job (create; defaults to the role's job)}.
edit keeps the day; move = to another day; omitted start/end keep the current ones; omitted lunch slides the old breaks with the shift.

STORE RULES (hard unless the manager says otherwise)
- Goal: as many "blue" hours as possible (scheduled EXACTLY equals guidance). Coverage: each 15 min on the clock outside unpaid lunch = 0.25 for that hour.
- Saturday/Sunday are the hardest days: never leave them short, never move a shift off a weekend day. ${PEAK_LABEL} is the most important window: never short.
- No hour below ~85% of guidance. Whole-hour starts. Prefer 9-hour blocks (8 paid + 1 h lunch). Every shift over 6 h needs a 1 h unpaid lunch starting 3–4 h in (validator 10017/10054).
- Leave In Home Delivery drivers (job ${IN_HOME_JOB}, tagged IN-HOME) alone. Minors (MINOR): never onto weekdays or earlier on a weekday (school hours, validator 12024 is HARD).
- Part-timers cap around 33.75 paid h/week (10003); no more than 6 days in a row across weeks (10001); 10 h rest between shifts.
- Never place a lunch at a time the person won't really take it just to make the graph look better.
- OPEN-TO-CLOSE AREAS (registers away from the front end): each needs at least one associate on the floor every minute between its open and close, counting every job. A lunch with nobody else on is a gap — stagger lunches of people closing (or opening) together (stagger_lunches does it). Never queue a change that opens a gap; queue_changes reports any it opens — undo or fix those.
${areaText(ctl)}

PEOPLE RULES (from the manager; they override availability):
${ctl.rulesText().trim() || "(none)"}

CURRENT SCHEDULE — ${roster.length} associates with ${js.join("/")} shifts (as saved in the scheduler, before the queue):
${roster.map((w) => workerLine(w, data.dates)).join("\n")}

COVERAGE NOW (saved schedule):
${coverageText(data, ctl.roleId(), js)}

QUEUE (${q.length} change(s) waiting on the page):
${q.map((ch, i) => `#${i} ${ch.name}: ${describe(ch, data.dates)}`).join("\n") || "(empty)"}`;
}

const CHANGE_SCHEMA = { type: "object", properties: {
  name: { type: "string" }, action: { type: "string", enum: ["edit", "move", "delete", "create"] },
  day: { type: "string", description: "YYYY-MM-DD" }, from: { type: "string", description: "existing shift start HH:MM" },
  start: { type: "string" }, end: { type: "string" }, lunch: { type: "string", description: "HH:MM or none" },
  toDay: { type: "string" }, job: { type: "string" } }, required: ["name", "action", "day"] };

export const TOOLS = [
  { name: "find_associates", description: "Look up associates on this week's whole roster (any job) by part of a name. Returns shifts as currently queued, availability, exceptions, tags.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "get_coverage", description: "Hourly scheduled/guidance for the role WITH the queued changes applied, with the saved-schedule numbers for comparison.",
    input_schema: { type: "object", properties: { day: { type: "string", description: "YYYY-MM-DD or sat..fri; omit for all days" } } } },
  { name: "queue_changes", description: "Add shift changes to the page's queue (not saved). Returns any change that could not be applied and the coverage effect.",
    input_schema: { type: "object", properties: { changes: { type: "array", items: CHANGE_SCHEMA } }, required: ["changes"] } },
  { name: "remove_queued", description: "Remove queued changes by their # index, or all of them.",
    input_schema: { type: "object", properties: { indexes: { type: "array", items: { type: "integer" } }, all: { type: "boolean" } } } },
  { name: "stagger_lunches", description: "Re-time lunches (3-4 h into the shift, same shift) so no open-to-close area has everyone at lunch at once. Adds lunch edits to the queue.", input_schema: { type: "object", properties: {} } },
  { name: "list_queue", description: "The queued changes with their # indexes.", input_schema: { type: "object", properties: {} } },
  { name: "headroom", description: "Per associate in scope: paid hours now vs weekly cap, and the best legal shift on each open day (availability, exceptions, PTO, day limits, minors weekends-only, never today or earlier), with how much of it covers short guidance. With queueHours, queues those shifts (most short-covering first) up to that many paid hours.",
    input_schema: { type: "object", properties: { queueHours: { type: "number", description: "queue up to this many paid hours; 0/omit = report only; a huge number = everything legal" },
      onlyShort: { type: "boolean", description: "queue only shifts that cover short hours (default false)" } } } },
  { name: "previous_weeks", description: "Earlier weeks of this store this browser has loaded (up to 6): per day guidance vs scheduled, short/over, blue hours for the same role/jobs, and paid hours per associate. Scheduled as last read, not hours worked.",
    input_schema: { type: "object", properties: { people: { type: "boolean", description: "include per-associate paid hours (default false)" } } } },
  { name: "check_with_scheduler", description: "Dry-run the whole queue through the scheduler's validator. Nothing is saved.", input_schema: { type: "object", properties: {} } },
  { name: "suggest_fit", description: "Run the fit-to-guidance optimiser (store + people rules) and put its changes in the queue.",
    input_schema: { type: "object", properties: { replaceQueue: { type: "boolean", description: "default true" }, floorPct: { type: "number", description: "0.5-1, default 0.85" },
      chaseBlue: { type: "string", enum: ["off", "some", "strong"] }, allowDayMoves: { type: "boolean" }, allowStretch: { type: "boolean" },
      extraHours: { type: "number", description: "paid hours to add on top of the fitted week (overschedule); 0/omit = fit only" },
      weekendWeight: { type: "string", enum: ["none", "some", "strong"], description: "where extra hours lean; default some" },
      peakWeight: { type: "string", enum: ["none", "some", "strong", "very strong"], description: "default strong" } } } },
];

function dayIdx(dates, d) { const s = String(d ?? "").toLowerCase(); const i = dates.indexOf(s); return i >= 0 ? i : SHORT.indexOf(s.slice(0, 3)); }

function fmtGap(g) { return `${GAP_LABEL[g.kind]} ${g.from}-${g.to}`; }
function areaText(ctl) {
  const areas = ctl.areas?.() || [], data = ctl.data();
  if (!areas.length) return "  (no areas set up)";
  return areas.map((a) => `  ${a.name} ${a.open}-${a.close} (jobs ${a.jobs.join(", ") || "-"}${a.people.length ? `; people ${a.people.join(", ")}` : ""}): `
    + (areaGaps(data, a).map((d, i) => d.gaps.length ? `${DOW[i]} ${d.gaps.map(fmtGap).join(", ")}` : null).filter(Boolean).join("; ") || "covered all week")).join("\n");
}

function effect(ctl, before, after) {
  const gaps = areaDelta(before, after, ctl.areas?.() || []).flatMap((x) => x.days.flatMap((d) => d.added.map((g) => `AREA GAP OPENED: ${x.area.name} ${DOW[ctl.data().dates.indexOf(d.date)]} ${fmtGap(g)}`)));
  return [...gaps, ...effectHours(ctl, before, after)];
}

function effectHours(ctl, before, after) {
  const a = summarize(coverage(before, ctl.roleId(), ctl.jobs())), b = summarize(coverage(after, ctl.roleId(), ctl.jobs()));
  return b.map((s, i) => ({ s, o: a[i] })).filter(({ s, o }) => s.blue !== o.blue || Math.abs(s.underHrs - o.underHrs) > 1e-9 || Math.abs(s.overHrs - o.overHrs) > 1e-9)
    .map(({ s, o }) => `${DOW[ctl.data().dates.indexOf(s.date)]}: blue ${o.blue}→${s.blue}, short ${r2(o.underHrs)}→${r2(s.underHrs)} h, over ${r2(o.overHrs)}→${r2(s.overHrs)} h${s.low ? `, lowest ${s.low.hour}:00 at ${Math.round(s.low.pct * 100)}%` : ""}`);
}

/** Run one tool call. Returns { text, activity } — text goes back to the model, activity is shown on the page. */
export async function runTool(name, input, ctl) {
  const data = ctl.data();
  const queued = () => applyChanges(data, ctl.queue()).data;
  switch (name) {
    case "find_associates": {
      const q = String(input.query || "").toLowerCase().trim();
      const hits = queued().workers.filter((w) => q && w.name.toLowerCase().includes(q)).slice(0, 12);
      return { text: hits.length ? hits.map((w) => workerLine(w, data.dates)).join("\n") : `Nobody on this week's roster matches "${input.query}".`, activity: `looked up “${input.query}”` };
    }
    case "get_coverage": {
      const di = input.day ? dayIdx(data.dates, input.day) : -1;
      const now = coverage(data, ctl.roleId(), ctl.jobs()), next = coverage(queued(), ctl.roleId(), ctl.jobs());
      const rows = next.map((d, i) => ({ d, o: now[i], i })).filter(({ i }) => di < 0 || i === di).map(({ d, o, i }) =>
        `${DOW[i]} ${d.date}: ` + d.need.map((n, h) => [h, n, d.have[h], o.have[h]]).filter(([, n, v, w]) => n > 0 || v > 0 || w > 0)
          .map(([h, n, v, w]) => `${String(h).padStart(2, "0")}:${r2(v)}/${r2(n)}${v !== w ? `(was ${r2(w)})` : ""}`).join(" "));
      return { text: `queued-state scheduled/guidance per hour:\n${rows.join("\n")}`, activity: "read coverage" };
    }
    case "stagger_lunches": {
      const out = staggerLunches(queued(), ctl.areas?.() || [], { editableFrom: ctl.fitOpts().editableFrom });
      if (out.changes.length) ctl.setQueue([...ctl.queue(), ...out.changes]);
      return { text: out.changes.length ? `queued ${out.changes.length} lunch change(s), ${out.fixedMin} gap minutes closed, ${out.leftMin} left:\n${out.changes.map((c) => `${c.name} ${c.day} lunch → ${c.lunch}`).join("\n")}` : `no lunch move helps (${out.leftMin} gap minutes left)`, activity: "staggered lunches" };
    }
    case "list_queue":
      return { text: ctl.queue().map((ch, i) => `#${i} ${ch.name}: ${describe(ch, data.dates)}`).join("\n") || "(empty)", activity: "listed the queue" };
    case "remove_queued": {
      const q = ctl.queue();
      if (input.all) { ctl.setQueue([]); return { text: `Removed all ${q.length}.`, activity: `cleared the queue` }; }
      const drop = new Set((input.indexes || []).map(Number));
      ctl.setQueue(q.filter((_, i) => !drop.has(i)));
      return { text: `Removed ${drop.size}; queue now ${ctl.queue().length}. Indexes have shifted — use list_queue.`, activity: `removed ${drop.size} queued change(s)` };
    }
    case "queue_changes": {
      const before = queued(), ok = [], bad = [];
      for (const raw of input.changes || []) {
        const w = data.workers.find((x) => x.name.toLowerCase() === String(raw.name || "").toLowerCase());
        if (!w) { bad.push(`${raw.name}: not on this week's roster (use find_associates)`); continue; }
        const di = dayIdx(data.dates, raw.day), ti = raw.toDay != null ? dayIdx(data.dates, raw.toDay) : di;
        if (di < 0 || ti < 0) { bad.push(`${w.name}: day ${raw.day}${raw.toDay ? "/" + raw.toDay : ""} not in this week`); continue; }
        const ch = { ...raw, name: w.name, workerId: w.workerId, day: data.dates[di], ...(raw.action === "move" ? { toDay: data.dates[ti] } : {}) };
        if (raw.action !== "move") delete ch.toDay;
        if (ch.action === "create" && !ch.job) ch.job = ctl.jobs()[0];
        if (ch.from && ch.action !== "create") { const s = w.shifts.find((x) => x.day === ch.day && toMin(x.start) === toMin(ch.from)); if (s) { ch.expectEnd = s.end; ch.job = ch.job || s.job; } }
        const trial = applyChanges(data, [...ctl.queue(), ...ok, ch]);
        const p = trial.problems.find((x) => x.idx === ctl.queue().length + ok.length);
        if (p) { bad.push(`${w.name} ${describe(ch, data.dates)}: ${p.why}`); continue; }
        ok.push(ch);
      }
      if (ok.length) ctl.setQueue([...ctl.queue(), ...ok]);
      const eff = effect(ctl, before, queued());
      return { text: `Queued ${ok.length}.${bad.length ? `\nNOT queued:\n- ${bad.join("\n- ")}` : ""}\nCoverage effect: ${eff.join("; ") || "none on the role's bars"}`,
        activity: `queued ${ok.length} change(s)${bad.length ? `, ${bad.length} rejected` : ""}` };
    }
    case "check_with_scheduler": {
      if (!ctl.queue().length) return { text: "Queue is empty.", activity: "nothing to check" };
      const r = await ctl.validate();
      if (!r || r.error) return { text: `Validator call failed: ${r?.error || "unknown"}`, activity: "check failed" };
      const lines = [...(r.skipped || []).map((s) => `SKIPPED ${s.change} — ${s.why}`), ...(r.hard || []).map((h) => `HARD ${h.name}: ${h.code} ${h.message} ${h.value ?? ""}`),
        ...(r.newWarnings || []).map((h) => `NEW WARN ${h.name}: ${h.code} ${h.message} ${h.value ?? ""}`)];
      const clean = !lines.length;
      return { text: clean ? `CLEAN: ${r.applied.length} change(s) pass (${r.preexistingWarnings} pre-existing warnings ignored). The manager can press Submit changes.` : lines.join("\n"),
        activity: clean ? "checked with the scheduler: clean" : `checked with the scheduler: ${lines.length} issue(s)` };
    }
    case "suggest_fit": {
      const base = ctl.fitOpts();
      const out = suggest(data, { ...base, rules: parseRules(ctl.rulesText()),
        ...(input.floorPct ? { floorPct: input.floorPct } : {}), ...(input.chaseBlue ? { matchBonus: { off: 0, some: 5, strong: 15 }[input.chaseBlue] } : {}),
        ...(input.allowDayMoves != null ? { allowDayMoves: input.allowDayMoves } : {}), ...(input.allowStretch != null ? { allowExtend: input.allowStretch } : {}) });
      const before = queued();
      const fitted = input.replaceQueue === false ? [...ctl.queue(), ...out.changes] : out.changes;
      const extra = Math.max(0, +input.extraHours || 0), W = { none: 0, some: 0.25, strong: 0.6 }, PW = { none: 0, some: 0.25, strong: 0.5, "very strong": 1 };
      const add = extra > 0 ? addHours(applyChanges(data, fitted).data, { roleId: ctl.roleId(), jobs: ctl.jobs(), roleJobs: base.roleJobs, extra, rules: parseRules(ctl.rulesText()),
        neighbors: base.neighbors, editableFrom: base.editableFrom, weekendBoost: W[input.weekendWeight] ?? 0.25, peakBoost: PW[input.peakWeight] ?? 0.5, allowExtend: input.allowStretch !== false }) : null;
      ctl.setQueue(add ? [...fitted, ...add.changes] : fitted);
      const s = out.stats;
      const addText = add ? `\nExtra hours: +${add.stats.added} of ${extra} h (${add.stats.created} new shifts, ${add.stats.extended} stretched). By day: ${add.stats.byDay.map((h, i) => `${DOW[i]} +${h}`).join(", ")}.`
        + (add.stats.stopWhy ? ` Stopped early: ${add.stats.stopWhy}.` : "") + `\nPeople: ${add.people.map((p) => `${p.name} ${p.before}→${p.after}`).join(", ") || "none"}\n` + add.changes.map((ch) => `- ${ch.name}: ${describe(ch, data.dates)}`).join("\n") : "";
      return { text: `Fitter queued ${out.changes.length} change(s): blue hours ${s.blueBefore}→${s.blueAfter}, ${s.dayMoves} day moves, ${s.stretched} stretched to 9 h, ${s.added} shift(s) added on open days.\n`
        + (out.turnarounds.length ? `Rest under 12 h (closing then opening): ${out.turnarounds.map((t) => `${t.name} ${t.restH} h before ${t.day} ${t.start}`).join(", ")}\n` : "")
        + (out.hours.some((h) => h.why) ? `Full-timers under target (40 less 8 per PTO day): ${out.hours.filter((h) => h.why).map((h) => `${h.name} ${h.after}/${h.target} h (${h.why})`).join(", ")}\n` : "")
        + out.changes.map((ch) => `- ${ch.name}: ${describe(ch, data.dates)}`).join("\n")
        + (out.notes.length ? `\nLeft alone: ${out.notes.map((n) => `${n.names.join("+")} ${n.day} ${n.shift} (${n.why})`).join("; ")}` : "")
        + addText
        + `\nCoverage effect vs before: ${effect(ctl, before, queued()).join("; ") || "none"}`,
        activity: `ran fit to guidance: ${out.changes.length} change(s), blue ${s.blueBefore}→${s.blueAfter}${add ? `, +${add.stats.added} extra h` : ""}` };
    }
    case "headroom": {
      const out = headroom(queued(), { roleId: ctl.roleId(), jobs: ctl.jobs(), editableFrom: ctl.fitOpts().editableFrom });
      let text = headroomText(out), activity = `worked out headroom: ${out.totals.legal} h placeable`;
      const want = +input.queueHours || 0;
      if (want > 0) {
        const picks = out.rows.flatMap((r) => r.picks.map((o) => ({ r, o }))).filter(({ o }) => !input.onlyShort || o.short > 0)
          .sort((a, b) => b.o.short / b.o.paid - a.o.short / a.o.paid);
        const changes = []; let got = 0;
        for (const { r, o: o0 } of picks) {
          if (got >= want - 1e-9) break;
          const o = o0.paid > want - got ? bestShift(coverage(queued(), ctl.roleId(), ctl.jobs())[o0.di], o0.wins, lenFor(want - got)) : o0;
          if (!o) continue;
          changes.push({ name: r.name, action: "create", day: o0.date, start: fmtHM(o.start), end: fmtHM(o.start + o.len), lunch: o.len > 360 ? fmtHM(o.start + 240) : "none" });
          got += o.paid;
        }
        const res = await runTool("queue_changes", { changes }, ctl);
        text += `\n\nQueued toward ${want} h:\n${res.text}`;
        activity += `; ${res.activity}`;
      }
      return { text, activity };
    }
    case "previous_weeks": {
      const weeks = (await ctl.pastWeeks?.().catch(() => [])) || [];
      if (!weeks.length) return { text: "No earlier weeks of this store are cached in this browser. The manager can load one (type its WK, Load week) and ask again.", activity: "no earlier weeks cached" };
      const text = weeks.map((w) => {
        const days = coverage(w, ctl.roleId(), ctl.jobs()), sum = summarize(days);
        const need = days.reduce((a, d) => a + d.need.reduce((x, y) => x + y, 0), 0), have = days.reduce((a, d) => a + d.have.reduce((x, y) => x + y, 0), 0);
        const ppl = input.people ? "\n  paid h: " + w.workers.filter((x) => x.shifts.some((s) => ctl.jobs().includes(s.job)))
          .map((x) => `${x.name} ${r2(x.shifts.reduce((a, s) => a + paidHours(s), 0))}`).join(", ") : "";
        return `WK ${w.ctx.wk} (${w.dates[0]}→${w.dates[6]}, read ${String(w.savedAt || "").slice(0, 16)}): guidance ${r2(need)} h, scheduled ${r2(have)} h (${r2(have - need)} net), blue ${sum.reduce((a, s) => a + s.blue, 0)}/${sum.reduce((a, s) => a + s.hours, 0)}\n  `
          + sum.map((s, i) => `${DOW[i]} short ${r2(s.underHrs)} over ${r2(s.overHrs)}`).join("; ") + ppl;
      }).join("\n");
      return { text, activity: `read ${weeks.length} earlier week(s)` };
    }
    default: return { text: `Unknown tool ${name}`, activity: `unknown tool ${name}` };
  }
}
