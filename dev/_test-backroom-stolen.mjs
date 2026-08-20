// dev/_test-backroom-stolen.mjs
// Proves the Stolen Adj $ card is isolated by the REQUEST-body filter, not by
// measure name (both stolen + all-adjustments share "Total Adj $").
import { readFileSync } from "node:fs";
import { decodeDaxKpis } from "../modules/market120/lib/parse_dax.js";

const d = JSON.parse(readFileSync("./backroom-powerbi-probe.json", "utf8"));
const measures = ["Sum(BR Adjustments.Total Adj $)", "Total Adj $"];
const reqBodyMustContainAll = ["'Stolen'"];

// Mirror readCaptureForReport's request-filter step.
const all = d.captured.filter((r) => r.respBody && decodeDaxKpis(r.respBody, measures).ok);
const stolenOnly = all.filter((r) =>
  reqBodyMustContainAll.every((lit) => (r.reqBody || "").includes(lit))
);

console.log(`envelopes with Total Adj $ descriptor : ${all.length}`);
console.log(`  of those, Stolen-filtered           : ${stolenOnly.length}`);

// Merge stolen-only (first non-null wins).
const merged = {};
for (const env of stolenOnly) {
  const pr = decodeDaxKpis(env.respBody, measures);
  for (const [k, v] of Object.entries(pr.values || {}))
    if ((merged[k] ?? null) === null && v !== null) merged[k] = v;
}
const stolen = merged["Sum(BR Adjustments.Total Adj $)"] ?? merged["Total Adj $"];
console.log("stolen_adjusted_dollars =", stolen);

// The stolen figure (-46595.06) must come ONLY from filtered requests, and
// there must be at least one such request (else we'd silently show a wrong #).
const pass = stolenOnly.length > 0 && Number.isFinite(stolen) && Math.round(stolen) === -46595;
console.assert(stolenOnly.length > 0, "❌ no Stolen-filtered request captured");
console.assert(Math.round(stolen) === -46595, "❌ unexpected stolen total");
console.log(pass ? "\n✅ PASS — Stolen card isolated via request filter." : "\n❌ FAIL");
process.exit(pass ? 0 : 1);
