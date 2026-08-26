// modules/digitalmetrics/lib/pages/opportunities.js
//
// Associates performing below their cohort benchmark, worst first.

import { section, empty, esc, table, associateCell, flipDir, compareBy, nextSort } from "./_shared.js";
import { classificationOf, badgeClass, CLASSIFICATIONS, UNCLASSIFIED } from "../data/classify.js";
import { analyseOpportunities, sortOpportunities } from "../data/opportunities.js";

const SORT_OPTIONS = [
  ["overall",        "Overall"],
  ["ftpr",           "FTPR"],
  ["pick_rate",      "Pick Rate"],
  ["nil_rate",       "Nil Rate"],
  ["sub_rate",       "Sub Rate"],
  ["late_start",     "Late Start"],
  ["pick_adherence", "Pick Adherence"],
];

// Which way each SORTS comparator actually runs, so the header arrow tells the
// truth. They all put the WORST first, but "worst" is a low number for FTPR and
// a high one for Nil Rate — the arrow has to follow the value, not the intent.
const NATURAL_DIR = {
  overall: "desc", ftpr: "asc", pick_rate: "asc", nil_rate: "desc",
  sub_rate: "desc", late_start: "desc", pick_adherence: "asc",
};

// Columns with no worst-first judgement, and the order that reads as most
// useful on the first click.
const PLAIN_DIR = { name: "asc", picked_qty: "desc", hours: "desc" };

// Every group except Exceptions, whose pickers are measured on a different
// scale and whose presence buries everyone else.
//
// Derived from CLASSIFICATIONS rather than listed, because listing it is how
// it went stale: this used to name "Fashion", which stopped being a
// classification and left the default filtering on a group that could never
// match. A derived list cannot drift when the categories change.
const DEFAULT_GROUPS = [...CLASSIFICATIONS.filter((g) => g !== "Exceptions"), UNCLASSIFIED];

export function render(ctx) {
  const { associates = [], benchmarks = {}, classifications = {}, adherence = {}, ui = {} } = ctx;
  if (!associates.length) return empty("Select a store to see opportunities.");

  const sortBy = ui.oppSort || "overall";
  const groups = ui.oppGroups || DEFAULT_GROUPS;

  const inGroup = associates.filter((a) =>
    groups.includes(classificationOf(a.name, classifications)));

  const analysed = analyseOpportunities(inGroup, benchmarks, adherence)
    .filter((a) => a.issues.length);

  // Two ordering paths, split by whether the column carries a judgement.
  //
  // Ranked columns (FTPR, Nil Rate, Adherence…) go through sortOpportunities,
  // which owns the worst-first rules and is pinned by its own tests. Inverting
  // reverses its result rather than running a second comparator that could
  // drift out of agreement with it.
  //
  // Descriptive columns (Associate, Pick Qty, Hours) have no worst-first
  // meaning — nobody is "doing badly at hours" — so they sort plainly. Without
  // this they would hit sortOpportunities' unknown-key fallback and silently
  // re-sort by Overall, which reads as a broken header.
  const ranked = Object.prototype.hasOwnProperty.call(NATURAL_DIR, sortBy);
  const dir = ui.oppRev
    ? flipDir(NATURAL_DIR[sortBy] || PLAIN_DIR[sortBy] || "desc")
    : (NATURAL_DIR[sortBy] || PLAIN_DIR[sortBy] || "desc");

  let flagged;
  if (ranked) {
    flagged = sortOpportunities(analysed, sortBy);
    if (ui.oppRev) flagged.reverse();
  } else {
    flagged = [...analysed].sort(compareBy(sortBy, dir));
  }

  const controls = `
    <div class="dm-controls">
      <label class="field">
        <span>Sort by</span>
        <select class="dm-input" id="dm-opp-sort">
          ${SORT_OPTIONS.map(([v, l]) =>
            `<option value="${esc(v)}" ${v === sortBy ? "selected" : ""}>${esc(l)}</option>`).join("")}
        </select>
      </label>
      <div class="dm-filter-group">
        ${[...CLASSIFICATIONS, UNCLASSIFIED].map((g) => `
          <button class="dm-filter ${groups.includes(g) ? "is-active" : ""}"
                  data-dm-group="${esc(g)}">${esc(g)}</button>`).join("")}
      </div>
      <span class="dm-stat-note">${flagged.length} flagged</span>
    </div>`;

  const rows = table([
    {
      label: "Associate", key: "name",
      format: (a) => {
        const cls = classificationOf(a.name, classifications);
        return associateCell(a.name, cls);
      },
    },
    // Score sorts as "overall" — the column shows the score, but the ranking
    // that produced it is the one the rest of the page is built around.
    { label: "Score", key: "score", align: "right", sortKey: "overall",
      // The breakdown is the justification; without it the number is arbitrary.
      format: (a) => `<span title="${esc(a.scoreBreakdown.join("\n"))}">${esc(a.score)}</span>` },
    { label: "FTPR",      key: "ftpr",      align: "right", format: (a) => `${esc(a.ftpr)}%` },
    { label: "Pick Rate", key: "pick_rate", align: "right" },
    { label: "Nil",       key: "nil_rate",  align: "right", format: (a) => `${esc(a.nil_rate)}%` },
    { label: "Sub",       key: "sub_rate",  align: "right", format: (a) => `${esc(a.sub_rate)}%` },
    // Volume was missing entirely, which made the flags hard to weigh: a bad
    // FTPR over 40 picks and over 4000 are not the same finding.
    { label: "Pick Qty", key: "picked_qty", align: "right",
      format: (a) => esc((a.picked_qty || 0).toLocaleString()) },
    { label: "Hours", key: "hours", align: "right" },
    { label: "Late", key: "late_start", align: "right", sortKey: "late_start",
      format: (a) => (a.totalLateMinutes ? `${esc(a.totalLateMinutes)}m` : "—") },
    {
      label: "Adherence", key: "adherence", align: "right", sortKey: "pick_adherence",
      format: (a) => {
        const info = adherence[a.name];
        if (!info) return "—";
        return `<span class="${info.isLowAdherence ? "is-bad" : "is-good"}">${esc(info.adherence)}%</span>` +
               `<div class="dm-stat-note">${esc(info.actualHours)}h / ${esc(info.assignedHours)}h</div>`;
      },
    },
    // A list of issue strings has no order of its own to sort by.
    { label: "Issues", key: "issues", sortable: false,
      format: (a) => `<ul class="dm-issues">${
        a.issues.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` },
  ], flagged, {
    emptyMessage: "No associates are below benchmark in the selected groups.",
    sort: { key: sortBy, dir },
  });

  return section("Opportunities", controls + rows);
}

export function wire(ctx, root) {
  const { host, onUiChange, ui = {} } = ctx;

  const sort = root.querySelector("#dm-opp-sort");
  // Choosing from the dropdown drops any inversion, so the metric arrives in
  // its natural worst-first order.
  const onSort = (e) => onUiChange?.({ oppSort: e.target.value, oppRev: false });
  sort?.addEventListener("change", onSort);

  // Same convention as the Leaderboard: re-click the active column to flip.
  const offHeader = host.ui.delegate(root, "click", "[data-dm-sort]", (_e, el) => {
    onUiChange?.(nextSort({
      clicked: el.dataset.dmSort,
      current: ui.oppSort || "overall",
      rev: ui.oppRev,
      keyField: "oppSort",
      revField: "oppRev",
    }));
  });

  const offAssoc = host.ui.delegate(root, "click", "[data-dm-associate]", (_e, el) => {
    ctx.onSelectAssociate?.(el.dataset.dmAssociate);
  });

  const offGroup = host.ui.delegate(root, "click", "[data-dm-group]", (_e, el) => {
    const group   = el.dataset.dmGroup;
    const current = ui.oppGroups || DEFAULT_GROUPS;
    const next    = current.includes(group)
      ? current.filter((g) => g !== group)
      : [...current, group];
    onUiChange?.({ oppGroups: next });
  });

  return () => {
    sort?.removeEventListener("change", onSort);
    offGroup?.();
    offAssoc?.();
    offHeader?.();
  };
}
