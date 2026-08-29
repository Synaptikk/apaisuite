// dev/migration-count.mjs
//
// How much data is actually in the standalone aurorbuddy project?
//
//   node dev/migration-count.mjs
//
// READ-ONLY. Counts only.
//
// Uses runAggregationQuery COUNT rather than listing documents: a COUNT is
// billed at roughly one read per thousand index entries, where listing every
// document to length-check it would burn a read per document. The source
// project is on the Spark plan with a 50k/day read quota, and spending that on
// counting would be a poor trade.
//
// Auth is an owner OAuth token from `gcloud auth print-access-token`, which is
// admin access and bypasses security rules — necessary because the dashboard
// collections are gated to password users.

import { execSync } from "node:child_process";

const SRC = { project: "aurorbuddy", db: "(default)" };
const DST = { project: "apaisuite", db: "aurorbuddy" };

const COLLECTIONS = [
  "tool_events",
  "tool_scans",
  "tool_workflows",
  "tool_metric_events",
  "tool_metrics",
  "tool_cache_stores",
  "tool_cache_scans",
  "users",
];

const token = execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();

const base = ({ project, db }) =>
  `https://firestore.googleapis.com/v1/projects/${project}/databases/${encodeURIComponent(db)}/documents`;

async function countOf(target, collectionId) {
  const res = await fetch(`${base(target)}:runAggregationQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredAggregationQuery: {
        structuredQuery: { from: [{ collectionId }] },
        aggregations: [{ alias: "n", count: {} }],
      },
    }),
  });
  if (!res.ok) return { error: `${res.status} ${(await res.text()).slice(0, 120)}` };
  const body = await res.json();
  const n = body?.[0]?.result?.aggregateFields?.n?.integerValue;
  return { count: n == null ? null : Number(n) };
}

console.log(`source     : ${SRC.project} / ${SRC.db}`);
console.log(`destination: ${DST.project} / ${DST.db}\n`);
console.log("  collection            source   destination");

let total = 0;
for (const c of COLLECTIONS) {
  const [a, b] = await Promise.all([countOf(SRC, c), countOf(DST, c)]);
  if (a.error) { console.log(`  ${c.padEnd(22)} ERROR ${a.error}`); continue; }
  total += a.count || 0;
  const dst = b.error ? `err(${b.error.slice(0, 12)})` : String(b.count ?? "?");
  console.log(`  ${c.padEnd(22)} ${String(a.count).padStart(6)}   ${dst.padStart(11)}`);
}
console.log(`\n  total documents to copy: ${total}`);
console.log(`  (a REST copy writes one document per request, so this is roughly`);
console.log(`   the number of writes the destination will take)`);
