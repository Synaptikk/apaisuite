// Run the module's own analytic layer over the real Medallia pull captured by
// dev/cx-probe-medallia-pull.mjs, so the numbers can be eyeballed before the
// UI is trusted.
import fs from "node:fs";
import { normalizeRecord } from "../modules/cx/lib/medallia.js";
import { buildAnalysis } from "../modules/cx/lib/aggregate.js";

const src = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const records = src.all.map(normalizeRecord);
console.log(`records: ${records.length}  ${src.from} → ${src.to}`);

const show = (label, filters) => {
  const a = buildAnalysis(records, { filters, windowDays: 28 });
  console.log(`\n${"=".repeat(74)}\n${label}   (${a.counts.filtered} comments, ${a.counts.firstDay} → ${a.counts.lastDay})`);
  console.log(`rating mix  1:${a.ratings.counts[1]} 2:${a.ratings.counts[2]} 3:${a.ratings.counts[3]} 4:${a.ratings.counts[4]} 5:${a.ratings.counts[5]}`
            + `   comment NPS ${a.ratings.commentNps}   mean ${a.ratings.mean}`);
  console.log(`topic tags on ${a.themes.taggedCount}/${a.counts.filtered} (${Math.round(a.themes.taggedCount/a.counts.filtered*100)}%)`);

  console.log("\n  WHAT'S GOING WRONG");
  for (const t of a.themes.negative.slice(0, 7)) {
    console.log(`   ${String(t.negative).padStart(4)} neg  ${String(Math.round((t.negativeShare ?? 0)*100)).padStart(3)}% of opinions  ${t.label.padEnd(24)} [${t.scope}]`
              + `  top: ${t.topics.slice(0,3).map(x=>`${x.label}(${x.negative})`).join(", ")}`);
  }
  console.log("\n  WHAT'S GOING RIGHT");
  for (const t of a.themes.positive.slice(0, 7)) {
    console.log(`   ${String(t.positive).padStart(4)} pos  ${String(t.negative).padStart(4)} neg      ${t.label.padEnd(24)} [${t.scope}]`
              + `  top: ${t.topics.slice(0,3).map(x=>`${x.label}(${x.positive})`).join(", ")}`);
  }
  console.log(`\n  WHAT CHANGED  (${a.movement.recent.from}→${a.movement.recent.to}, ${a.movement.recent.count} vs ${a.movement.prior.from}→${a.movement.prior.to}, ${a.movement.prior.count})`);
  for (const m of a.movement.movers.slice(0, 8)) {
    const arrow = m.direction === "worse" ? "WORSE" : m.direction === "better" ? "better" : "flat";
    console.log(`   ${arrow.padEnd(6)} ${m.label.padEnd(24)} ${String(m.priorRate).padStart(5)} → ${String(m.recentRate).padStart(5)} per 100`
              + ` (${m.deltaRate > 0 ? "+" : ""}${m.deltaRate})  ${m.priorNegative}→${m.recentNegative} mentions${m.thin ? "  [thin]" : ""}`);
  }
  console.log(`\n  weekly bars: ${a.weekly.length} weeks, last: ${JSON.stringify(a.weekly[a.weekly.length-1]?.bands)}`);
  return a;
};

show("ALL JOURNEYS (the blended view)", {});
show("IN-STORE ONLY", { journeys: ["Store", "Unscheduled Pickup", "Rx", "Vision", "Returns", "ACC"] });
show("DELIVERY ONLY", { journeys: ["Scheduled Delivery", "InHome"] });

// One quote per side, to confirm verbatims survive the pipeline.
const a = buildAnalysis(records, { filters: {}, windowDays: 28 });
const worst = a.themes.negative[0];
console.log(`\n${"=".repeat(74)}\nsample verbatims under "${worst.label}":`);
for (const ex of worst.examples.negative.slice(0, 3)) {
  console.log(`  ${ex.day} ${ex.journey} ${ex.score}* ${ex.sentiment}\n    ${ex.text.slice(0, 150)}`);
}
