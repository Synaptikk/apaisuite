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
//   ctl = { data(), queue(), setQueue(list), roleId(), jobs(), rulesText(),
//           fitOpts(), validate() → Promise<result | { error }> }

import { DOW, SHORT, toMin, coverage, summarize, applyChanges, describe, paidHours, IN_HOME_JOB } from "./coverage.js";
import { parseRules } from "./rules.js";
import { suggest } from "./suggest.js";

const r2 = (x) => Math.round(x * 100) / 100;

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
  const tags = [w.payType, w.employmentType, /minor/i.test(String(w.minor ?? "")) && "MINOR",
    (String(w.job || "").includes(IN_HOME_JOB) || w.shifts.some((s) => s.job === IN_HOME_JOB)) && "IN-HOME"].filter(Boolean).join(" ");
  const paid = w.shifts.reduce((a, s) => a + paidHours(s), 0);
  return `${w.name} (id ${w.workerId}; ${tags}; ${r2(paid)} paid h) | ${days} | avail: ${av}${exc ? ` | exceptions: ${exc}` : ""}`;
}

function coverageText(data, roleId, jobs) {
  const days = coverage(data, roleId, jobs), sum = summarize(days);
  return days.map((d, i) => {
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
  return `You are the scheduling assistant inside the Digital Schedule tool of a Walmart store manager's extension. You change next weeks' shifts in the Workforce Planning (Polaris) scheduler by QUEUEING changes; the manager reviews them on the page and presses Save. You cannot save, and must never claim you saved anything.

Store ${c.store} (${c.site || ""}), fiscal WK ${c.wk}: ${data.dates.map((d, i) => `${DOW[i]}=${d}`).join(", ")}. Today is ${new Date().toISOString().slice(0, 10)}; never change today or earlier days.
Role being fitted: role id ${ctl.roleId()}, job codes ${js.join(", ")}.

HOW TO WORK
- Use find_associates when you need anyone not listed below, or to re-check someone. Names must match the roster exactly.
- Queue with queue_changes, then ALWAYS run check_with_scheduler and report the result (HARD = scheduler refuses; NEW WARN = this change adds a warning; about 20 soft warnings already sit on any week and are ignored).
- If a check fails, fix the change (lunch timing, another day) and re-check — don't hide problems. When rules conflict, ask the manager which one bends.
- For "fix the week to the guidance"-type requests use suggest_fit, then describe what it did and where it bent.
- Keep replies short: a before → after list of what you queued and the coverage effect. Use 12-hour times (9a, 1:30p) when talking to the manager.

CHANGE FORMAT (queue_changes)
{name, action: "edit"|"move"|"delete"|"create", day: "YYYY-MM-DD", from: "HH:MM" (existing shift start; required for edit/move/delete), start, end ("HH:MM" 24h; an end at or before start rolls past midnight), lunch: "HH:MM" (1 h unpaid) | "none", toDay (move only), job (create; defaults to the role's job)}.
edit keeps the day; move = to another day; omitted start/end keep the current ones; omitted lunch slides the old breaks with the shift.

STORE RULES (hard unless the manager says otherwise)
- Goal: as many "blue" hours as possible (scheduled EXACTLY equals guidance). Coverage: each 15 min on the clock outside unpaid lunch = 0.25 for that hour.
- Saturday/Sunday are the hardest days: never leave them short, never move a shift off a weekend day. 12p–4p is the most important window: never short.
- No hour below ~85% of guidance. Whole-hour starts. Prefer 9-hour blocks (8 paid + 1 h lunch). Every shift over 6 h needs a 1 h unpaid lunch starting 3–4 h in (validator 10017/10054).
- Leave In Home Delivery drivers (job ${IN_HOME_JOB}, tagged IN-HOME) alone. Minors (MINOR): never onto weekdays or earlier on a weekday (school hours, validator 12024 is HARD).
- Part-timers cap around 33.75 paid h/week (10003); no more than 6 days in a row across weeks (10001); 10 h rest between shifts.
- Never place a lunch at a time the person won't really take it just to make the graph look better.

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
  { name: "list_queue", description: "The queued changes with their # indexes.", input_schema: { type: "object", properties: {} } },
  { name: "check_with_scheduler", description: "Dry-run the whole queue through the scheduler's validator. Nothing is saved.", input_schema: { type: "object", properties: {} } },
  { name: "suggest_fit", description: "Run the fit-to-guidance optimiser (store + people rules) and put its changes in the queue.",
    input_schema: { type: "object", properties: { replaceQueue: { type: "boolean", description: "default true" }, floorPct: { type: "number", description: "0.5-1, default 0.85" },
      chaseBlue: { type: "string", enum: ["off", "some", "strong"] }, allowDayMoves: { type: "boolean" }, allowStretch: { type: "boolean" } } } },
];

function dayIdx(dates, d) { const s = String(d ?? "").toLowerCase(); const i = dates.indexOf(s); return i >= 0 ? i : SHORT.indexOf(s.slice(0, 3)); }

function effect(ctl, before, after) {
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
      ctl.setQueue(input.replaceQueue === false ? [...ctl.queue(), ...out.changes] : out.changes);
      const s = out.stats;
      return { text: `Fitter queued ${out.changes.length} change(s): blue hours ${s.blueBefore}→${s.blueAfter}, ${s.dayMoves} day moves, ${s.stretched} stretched to 9 h.\n`
        + out.changes.map((ch) => `- ${ch.name}: ${describe(ch, data.dates)}`).join("\n")
        + (out.notes.length ? `\nLeft alone: ${out.notes.map((n) => `${n.names.join("+")} ${n.day} ${n.shift} (${n.why})`).join("; ")}` : "")
        + `\nCoverage effect vs before: ${effect(ctl, before, queued()).join("; ") || "none"}`,
        activity: `ran fit to guidance: ${out.changes.length} change(s), blue ${s.blueBefore}→${s.blueAfter}` };
    }
    default: return { text: `Unknown tool ${name}`, activity: `unknown tool ${name}` };
  }
}
