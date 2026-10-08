// modules/digitalmetrics/lib/pages/pickhours.js
//
// Pick Hours: the store's items picked per clock hour, one board day at a
// time, with every recorded day in a table underneath.
//
// The data is Digital Rollup's per-day archive (that module's
// lib/pick_days.js): it reads the GIF board's running day total for the HOME
// store, differences it at each hour boundary, and keeps the result past the
// day. This page only presents it — no fetching, no arithmetic on the totals.
// The chart is the same SVG builder the Rollup card draws live, so the picture
// here is the picture that was on the board, not a re-interpretation.
//
// ctx: { store, pickDays: null | Array<record & {key, closed}>, ui.pickDay }
// (view.js::loadPickDays fills pickDays; ui.pickDay is the selected day key).

import { section, empty, esc, table, statCard, statRow } from "./_shared.js";
import { barChartSvg } from "../../../digitaldashboard/lib/pick_chart.js";
import { hoursByClock, peakHour } from "../../../digitaldashboard/lib/pick_days.js";

const HOUR = 3600e3;
const dayText = (key) => new Date(`${key}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "numeric", day: "numeric" });
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const hourLabel = (h) => `${h % 12 || 12}${h < 12 ? "a" : "p"}`;
const n = (v) => Math.round(Number(v) || 0).toLocaleString();

// Board days start at 5 AM, so hour columns run 5a … 4a rather than 12a … 11p.
const boardOrder = (h) => (h - 5 + 24) % 24;

/**
 * A closed day's last hour was recorded as "now" (so far) by the final
 * reading of that day. It is complete as far as the day is concerned, so it
 * draws solid; the hover text still shows when the last reading landed.
 */
function chartShape(rec) {
  if (!rec) return null;
  const hours = (rec.hours || []).map((h) => (rec.closed && h.kind === "now" ? { ...h, kind: "hour", end: h.start + HOUR } : h));
  return { dayStart: rec.dayStart, asOf: rec.asOf, total: rec.total, dayAvgPerHour: rec.dayAvgPerHour, before: rec.before ?? null, hours };
}

function dayOption(rec, selected) {
  const label = `${dayText(rec.key)} · ${n(rec.total)} picks${rec.closed ? "" : " (today, so far)"}`;
  return `<option value="${esc(rec.key)}" ${rec.key === selected.key ? "selected" : ""}>${esc(label)}</option>`;
}

function selectedDaySection(rec, days) {
  const measured = (rec.hours || []).filter((h) => h.kind === "hour").length;
  const inProgress = !rec.closed && (rec.hours || []).some((h) => h.kind === "now");
  const peak = peakHour(rec);
  const shape = chartShape(rec);
  const svg = barChartSvg(shape, { width: 760, height: 240 });

  const toolbar = `
    <div class="dm-pickhours-toolbar">
      <label class="field">
        <span class="field-label">Day</span>
        <select class="input" data-dm-pickday-select>${days.map((d) => dayOption(d, rec)).join("")}</select>
      </label>
      <span class="muted">${days.length} day${days.length === 1 ? "" : "s"} recorded · this browser only</span>
    </div>`;

  const stats = statRow([
    statCard("Items picked", n(rec.total), { note: `since ${clock(rec.dayStart)}` }),
    statCard("Avg per hour", `${n(rec.dayAvgPerHour)}/hr`),
    statCard("Peak hour", peak ? n(peak.picked) : "—",
             { note: peak ? `${hourLabel(new Date(peak.start).getHours())}–${hourLabel((new Date(peak.start).getHours() + 1) % 24)}` : "" }),
    statCard("Hours measured", String(measured), { note: inProgress ? "plus the current hour" : (rec.before ? "earlier hours averaged" : "") }),
    statCard("Last reading", clock(rec.asOf), { note: `${n(rec.samples)} readings` }),
  ]);

  const chart = svg
    ? `<div class="dm-pickchart">${svg}<div class="dm-pickchart-tip" hidden></div></div>`
    : empty("Nothing to draw for this day.");

  const note = rec.before
    ? `<p class="muted dm-pick-note">The grey block is the stretch before this browser started recording that day: only its total is known (${n(rec.before.picked)} picked, avg ${n(rec.before.perHour)}/hr), so it is drawn at the average rather than as invented hours.</p>`
    : "";

  return section(`Picks per hour · ${dayText(rec.key)}${rec.closed ? "" : " (today)"}`, toolbar + stats + chart + note);
}

function historySection(days, selected) {
  // Hour columns: every clock hour any day measured, in board order.
  const seen = new Set();
  for (const d of days) for (const h of d.hours || []) seen.add(new Date(h.start).getHours());
  const hours = [...seen].sort((a, b) => boardOrder(a) - boardOrder(b));

  const rows = days.map((d) => ({ ...d, _clock: hoursByClock(d), _peak: peakHour(d) }));

  const columns = [
    { key: "key", label: "Day", sortable: false,
      format: (r) => `<button type="button" class="dm-pickday-btn${r.key === selected.key ? " is-active" : ""}" data-dm-pickday="${esc(r.key)}" title="Show this day's graph">${esc(dayText(r.key))}</button>${r.closed ? "" : ` <span class="dm-pick-now">today</span>`}` },
    { key: "total", label: "Picked", align: "right", format: (r) => esc(n(r.total)) },
    { key: "dayAvgPerHour", label: "Avg/hr", align: "right", format: (r) => esc(n(r.dayAvgPerHour)) },
    { key: "_peak", label: "Peak", align: "right",
      format: (r) => (r._peak ? `${esc(n(r._peak.picked))} <span class="muted">@ ${esc(hourLabel(new Date(r._peak.start).getHours()))}</span>` : "—") },
    ...hours.map((h) => ({
      key: `h${h}`, label: hourLabel(h), align: "right", sortable: false,
      format: (r) => {
        const cell = r._clock.get(h);
        if (cell) {
          const peak = r._peak && cell.start === r._peak.start;
          const partial = cell.kind === "now" && !r.closed;
          return `<span class="${peak ? "dm-pick-peak" : ""}${partial ? " dm-pick-now" : ""}" title="${esc(partial ? `${n(cell.picked)} so far this hour` : `${n(cell.picked)} picked ${hourLabel(h)}–${hourLabel((h + 1) % 24)}`)}">${esc(n(cell.picked))}</span>`;
        }
        // Inside the "before recording" stretch: the total is known, the hour is not.
        const b = r.before;
        if (b) {
          const slot = new Date(r.dayStart); slot.setHours(h, 0, 0, 0);
          let t = slot.getTime(); if (t < r.dayStart) t += 24 * HOUR;
          if (t >= b.start && t < b.end) return `<span class="dm-pick-est" title="${esc(`before recording started — avg ${n(b.perHour)}/hr across ${clock(b.start)}–${clock(b.end)}`)}">~</span>`;
        }
        return `<span class="dm-pick-est">·</span>`;
      },
    })),
  ];

  const body = table(columns, rows, { emptyMessage: "No days recorded yet." }) +
    `<p class="muted dm-pick-note">Bold is the day's peak hour. “~” is an hour inside the averaged block before recording started; “·” has no reading. Click a day to see its graph.</p>`;
  return section("Every recorded day", body);
}

export function render(ctx) {
  const { store, pickDays, ui = {} } = ctx;
  if (!store) return empty("Select a store to see its picks per hour.");
  if (pickDays == null) return empty(`Loading pick history for store ${store}…`);
  if (!pickDays.length) {
    return empty(`No picks-per-hour history for store ${store} yet. Digital Rollup records the home store's board readings ` +
      `while its Auto refresh is on (every 5 minutes in the background, every 15 seconds with the board open); ` +
      `each day shows up here from its first reading and stays after the day ends.`);
  }
  const selected = pickDays.find((d) => d.key === ui.pickDay) || pickDays[0];
  return selectedDaySection(selected, pickDays) + historySection(pickDays, selected);
}

export function wire(ctx, el) {
  const pick = (key) => { if (key) ctx.onUiChange?.({ pickDay: key }); };

  const select = el.querySelector("[data-dm-pickday-select]");
  const onSelect = () => pick(select.value);
  select?.addEventListener("change", onSelect);

  const offRow = ctx.host?.ui?.delegate?.(el, "click", "[data-dm-pickday]", (_e, b) => pick(b.dataset.dmPickday));

  // Hover text on the bars: the SVG carries the words (data-tip on each hit
  // area); this only positions them. Same mechanics as the Rollup card.
  const svg = el.querySelector(".dm-pickchart svg");
  const tip = el.querySelector(".dm-pickchart-tip");
  const onMove = (e) => {
    const hit = e.target?.closest?.(".dmr-bar-hit");
    svg.querySelectorAll(".dmr-bar-hit.is-on").forEach((r) => r.classList.remove("is-on"));
    if (!hit || !tip) { if (tip) tip.hidden = true; return; }
    hit.classList.add("is-on");
    tip.hidden = false;
    tip.textContent = hit.dataset.tip;
    const box = svg.getBoundingClientRect();
    const hb = hit.getBoundingClientRect();
    const left = hb.left - box.left + hb.width / 2;
    tip.style.left = `${Math.min(Math.max(left, 120), box.width - 120)}px`;
  };
  const onLeave = () => {
    if (tip) tip.hidden = true;
    svg?.querySelectorAll(".dmr-bar-hit.is-on").forEach((r) => r.classList.remove("is-on"));
  };
  svg?.addEventListener("mousemove", onMove);
  svg?.addEventListener("mouseleave", onLeave);

  return () => {
    select?.removeEventListener("change", onSelect);
    offRow?.();
    svg?.removeEventListener("mousemove", onMove);
    svg?.removeEventListener("mouseleave", onLeave);
  };
}
