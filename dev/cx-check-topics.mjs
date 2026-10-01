// dev/cx-check-topics.mjs <pull.json>
//
// Audits lib/topics.js against a real Medallia pull (from
// dev/cx-probe-medallia-pull.mjs). Two things it looks for:
//
//   · families falling through unmapped, which each become their own one-row
//     theme where a single mention can rank as a "mover";
//   · one label appearing under two CANONICAL keys inside a theme, which draws
//     two rows with the same name and half the count each.
//
// Raw Medallia names folding into ONE canonical key is the intended merge and is
// printed as confirmation, not as a problem.

import fs from "node:fs";
import { normalizeRecord } from "../modules/cx/lib/medallia.js";
import { themeFor, canonicalTopic } from "../modules/cx/lib/topics.js";

const src = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const records = src.all.map(normalizeRecord);

const unmapped = new Map(), byTheme = new Map();
for (const r of records) {
  for (const t of r.topics) {
    const th = themeFor(t.name);
    if (String(th).startsWith("other:")) unmapped.set(t.name, (unmapped.get(t.name) ?? 0) + 1);
    if (!byTheme.has(th)) byTheme.set(th, new Set());
    byTheme.get(th).add(t.name);
  }
}

console.log(`records: ${records.length}`);

console.log("\n=== UNMAPPED families (each becomes its own one-row theme) ===");
if (!unmapped.size) console.log("  none");
for (const [name, n] of [...unmapped].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${name}`);
}

let defects = 0;
const merges = [];
for (const [theme, names] of byTheme) {
  const byKey = new Map(), byLabel = new Map();
  for (const name of names) {
    const c = canonicalTopic(name);
    if (!byKey.has(c.key)) byKey.set(c.key, new Set());
    byKey.get(c.key).add(name);
    if (!byLabel.has(c.label)) byLabel.set(c.label, new Set());
    byLabel.get(c.label).add(c.key);
  }
  for (const [, raw] of byKey) {
    if (raw.size > 1) merges.push(`  ${theme}: ${[...raw].join("  +  ")}`);
  }
  for (const [label, keys] of byLabel) {
    if (keys.size > 1) { defects++; console.log(`  DEFECT ${theme}: "${label}" under ${[...keys].join(", ")}`); }
  }
}

console.log("\n=== canonical merges (intended) ===");
if (!merges.length) console.log("  none");
for (const m of merges) console.log(m);

console.log(`\n=== duplicate labels under different keys ===\n  ${defects ? `${defects} DEFECT(S) above` : "none"}`);
process.exit(unmapped.size || defects ? 1 : 0);
