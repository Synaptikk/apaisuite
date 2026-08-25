// modules/digitalmetrics/lib/pages/insights.js

import { section, empty, esc, table, statCard, statRow } from "./_shared.js";
import {
  dailyPicks, digitalTone, distribution,
  storeHelpPeakHours, formatHour, lateStarts,
} from "../data/insights.js";

export function render(ctx) {
  const { rawData = [], associates = [], classifications = {} } = ctx;
  if (!rawData.length) return empty("Select a store to see insights.");

  const daily = dailyPicks(rawData, classifications);
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
    { label: "Digital %",  key: "digitalPct",   align: "right",
      format: (d) => `<strong class="is-${esc(digitalTone(d.digitalPct))}">${esc(d.digitalPct)}%</strong>` },
  ], daily, { emptyMessage: "No dated rows in this week." });

  const range = daily.length
    ? `${daily[daily.length - 1].date} – ${daily[0].date} · ${daily.length} days`
    : "";

  // ── Split ──────────────────────────────────────────────────────────────
  const split = statRow([
    statCard("Total Picks",     dist.total.toLocaleString()),
    statCard("Digital",         `${dist.digitalPct}%`,
             { note: `${dist.digitalTotal.toLocaleString()} picks` }),
    statCard("Store Help",      `${dist.storeHelpPct}%`,
             { tone: "help", note: `${dist.storeHelp.toLocaleString()} picks` }),
  ]);

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

  return [
    section(`Daily Picks${range ? ` — ${range}` : ""}`, dailyTable),
    section("Digital vs Store Help", split),
    section("Store Help Peak Hours", peakSection),
    section("5am Late Starts", lateSection),
  ].join("");
}
