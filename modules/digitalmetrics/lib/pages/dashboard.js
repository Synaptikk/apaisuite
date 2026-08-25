// modules/digitalmetrics/lib/pages/dashboard.js
//
// Three rows of headline figures for the selected store + week.

import { statCard, statRow, section, empty } from "./_shared.js";
import { countByClassification, totals } from "../data/classify.js";

export function render(ctx) {
  const { associates = [], benchmarks = {}, classifications = {}, dates = [], store, week } = ctx;

  if (!associates.length) {
    return empty(store
      ? `No metrics loaded for store ${store}${week ? ` week ${week}` : ""}.`
      : "Select a store to load metrics.");
  }

  const counts = countByClassification(associates, classifications);
  const t      = totals(associates);

  return [
    section("Overview", statRow([
      statCard("Total Associates", t.associates),
      statCard("Digital",      counts.Digital),
      statCard("Exceptions",   counts.Exceptions,   { tone: "warn" }),
      statCard("Fashion",      counts.Fashion,      { tone: "fashion" }),
      statCard("Store Help",   counts["Store Help"], { tone: "help" }),
      statCard("Unclassified", counts.Unclassified, { tone: "warn" }),
      statCard("Avg FTPR", `${benchmarks.ftpr ?? 0}%`),
    ])),

    section("Key Metrics", statRow([
      statCard("Total Picks", t.picks.toLocaleString(),
               { note: `${t.exceptionPicks.toLocaleString()} exception` }),
      statCard("Total Hours",   t.hours.toFixed(1)),
      statCard("Avg Pick Rate", `${t.avgPickRate}/hr`),
      statCard("Total Nil Picks", t.nil.toLocaleString(), { tone: "warn" }),
      statCard("Total Subs",      t.sub.toLocaleString(), { tone: "warn" }),
      statCard("Days Loaded",     dates.length),
    ])),
  ].join("");
}
