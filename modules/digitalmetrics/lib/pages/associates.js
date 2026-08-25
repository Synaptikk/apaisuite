// modules/digitalmetrics/lib/pages/associates.js
//
// Search for an associate, then their full report: headline metrics, per-day
// breakdown with adherence, and historical task patterns.

import { section, empty, esc, table, statCard, statRow } from "./_shared.js";
import { badgeClass } from "../data/classify.js";
import { searchAssociates, associateReport } from "../data/associates.js";
import { formatHour } from "../data/insights.js";

const SLOT_COUNT = 17;              // 5am–10pm inclusive
const slotLabel = (idx) => formatHour((5 + Number(idx)) % 24);

function searchBox(ctx) {
  const { associates = [], classifications = {}, ui = {} } = ctx;
  const query   = ui.assocSearch || "";
  const matches = searchAssociates(associates, query);

  const list = query && matches.length
    ? `<ul class="dm-suggestions">${matches.map((a) => `
        <li><button class="dm-suggestion" data-dm-associate="${esc(a.name)}">
          ${esc(a.name)}
          <span class="badge ${esc(badgeClass(classifications[a.name] || "Unclassified"))}">${
            esc(classifications[a.name] || "Unclassified")}</span>
        </button></li>`).join("")}</ul>`
    : query
      ? `<ul class="dm-suggestions"><li class="dm-stat-note">No matches.</li></ul>`
      : "";

  return `
    <div class="dm-controls">
      <label class="field" style="flex:1 1 260px">
        <span>Find an associate</span>
        <input class="dm-input" id="dm-assoc-search" type="search" autocomplete="off"
               placeholder="Start typing a name" value="${esc(query)}">
      </label>
    </div>${list}`;
}

function reportView(ctx, name) {
  const report = associateReport(name, ctx);
  const { summary, adherence, daily, classification } = report;

  if (!summary) return empty(`No metrics for ${name} in this week.`);

  const headline = statRow([
    statCard("FTPR",      `${summary.ftpr}%`),
    statCard("Pick Rate", summary.pick_rate),
    statCard("Hours",     summary.hours),
    statCard("Picks",     summary.picked_qty.toLocaleString()),
    statCard("Nil Rate",  `${summary.nil_rate}%`, { tone: "warn" }),
    statCard("Sub Rate",  `${summary.sub_rate}%`, { tone: "warn" }),
  ]);

  const adherenceCard = adherence
    ? statRow([
        statCard("Pick Adherence", `${adherence.adherence}%`,
                 { tone: adherence.isLowAdherence ? "warn" : "",
                   note: `${adherence.actualHours}h actual of ${adherence.assignedHours}h assigned` }),
        statCard("Days Measured", adherence.daysWithData),
      ])
    : empty("No pick assignments recorded for this associate this week.");

  // Per-day adherence is keyed by the MM/DD/YY label the metrics rows use.
  const adherenceByDate = Object.fromEntries(
    (adherence?.dailyDetails || []).map((d) => [d.date, d]));

  const dailyTable = table([
    { label: "Date",      key: "date" },
    { label: "First Scan", key: "firstScan", format: (d) => esc(d.firstScan || "—") },
    { label: "Hours",     key: "hours",     align: "right" },
    { label: "Picks",     key: "picked",    align: "right",
      format: (d) => esc(d.picked.toLocaleString()) },
    { label: "Pick Rate", key: "pickRate",  align: "right" },
    { label: "FTPR",      key: "ftpr",      align: "right", format: (d) => `${esc(d.ftpr)}%` },
    { label: "Nil",       key: "nilRate",   align: "right", format: (d) => `${esc(d.nilRate)}%` },
    { label: "Sub",       key: "subRate",   align: "right", format: (d) => `${esc(d.subRate)}%` },
    {
      label: "Adherence", key: "_adh", align: "right",
      format: (d) => {
        const a = adherenceByDate[d.date];
        if (!a) return "—";
        const low = a.adherence < 70;
        return `<span class="${low ? "is-bad" : "is-good"}">${esc(a.adherence)}%</span>`;
      },
    },
  ], daily, { emptyMessage: "No daily rows." });

  const patterns = ctx.patterns;
  const patternsView = !patterns
    ? empty("Loading historical patterns…")
    : patterns.totalDays === 0
      ? empty("No historical assignment data for this associate.")
      : table([
          { label: "Time", key: "slot", format: (r) => esc(slotLabel(r.slot)) },
          { label: "Usual task", key: "task",
            format: (r) => `${esc(r.top.task)} <span class="dm-stat-note">${
              esc(r.top.confidence)}% of ${esc(patterns.totalDays)} days</span>` },
          { label: "Also seen", key: "rest",
            format: (r) => r.rest.length
              ? esc(r.rest.map((t) => `${t.task} (${t.confidence}%)`).join(", "))
              : "—" },
        ], Array.from({ length: SLOT_COUNT }, (_, i) => String(i))
              .filter((slot) => patterns.slots[slot]?.length)
              .map((slot) => ({
                slot,
                top:  patterns.slots[slot][0],
                rest: patterns.slots[slot].slice(1),
              })));

  return [
    section(`${name} — ${classification}`, headline),
    section("Pick Adherence", adherenceCard),
    section("Daily Breakdown", dailyTable),
    section("Recommended Assignments", patternsView),
  ].join("");
}

export function render(ctx) {
  const { associates = [], ui = {} } = ctx;
  if (!associates.length) return empty("Select a store to look up associates.");

  const selected = ui.assocSelected;
  return section("Associates", searchBox(ctx)) +
         (selected ? reportView(ctx, selected) : empty("Search for an associate to see their report."));
}

export function wire(ctx, root) {
  const { host, onUiChange, onSelectAssociate } = ctx;

  let timer = null;
  const input = root.querySelector("#dm-assoc-search");
  const onInput = (e) => {
    clearTimeout(timer);
    const value = e.target.value;
    timer = setTimeout(() => onUiChange?.({ assocSearch: value }), 150);
  };
  input?.addEventListener("input", onInput);

  const offPick = host.ui.delegate(root, "click", "[data-dm-associate]", (_e, el) => {
    onSelectAssociate?.(el.dataset.dmAssociate);
  });

  return () => {
    clearTimeout(timer);
    input?.removeEventListener("input", onInput);
    offPick?.();
  };
}
