// dev/_test-isa-race.mjs
// Simulates the LIVE race: qty-card response arrives first, dollar-card later.
// Proves pollForCapture's completeness gate waits for BOTH before returning.
import { readFileSync } from "node:fs";
import { decodeDaxKpis } from "../modules/market120/lib/parse_dax.js";

const d = JSON.parse(readFileSync("./isa-powerbi-probe.json", "utf8"));
const measures = [
  "ISA.Adj $", "CountNonNull(ISA.Adj Qty)", "Min(ISA.Adj Date)", "Max(ISA.Adj Date)",
  "Sum(ISA.Adj Amt)", "Sum(ISA.adj_amt)", "Sum(ISA.Adj Retail)", "Sum(ISA.adj_retail)",
  "Sum(ISA.Adj Retail Amt)", "Total Adjusted $", "Total Adjusted Qty", "Total Adj $",
];
const requiredMeasures = [
  ["ISA.Adj $", "Sum(ISA.Adj Amt)", "Sum(ISA.adj_amt)", "Total Adjusted $"],
  ["CountNonNull(ISA.Adj Qty)", "Sum(ISA.Adj Qty)", "Total Adjusted Qty"],
];

// Mirror the pure logic of pollForCapture (no chrome).
function decodeAccumulated(envs) {
  const merged = {};
  for (const env of envs) {
    const pr = decodeDaxKpis(env.respBody, measures);
    for (const [k, v] of Object.entries(pr.values || {})) {
      if ((merged[k] === undefined || merged[k] === null) && v !== null) merged[k] = v;
    }
  }
  return merged;
}
const isComplete = (envs) =>
  requiredMeasures.every((g) => g.some((m) => Number.isFinite(decodeAccumulated(envs)[m])));

// Build the trickle: qty response (#72, has -78507) first, THEN dollar (#71).
const qtyEnv = d.captured.find((r) => r.respBody && r.respBody.includes("-78507") && r.respBody.includes("CountNonNull"));
const dollarEnv = d.captured.find((r) => r.respBody && r.respBody.includes("656048"));

// t=0: only qty arrived — OLD code would return here (bug). New code must NOT.
const afterQtyOnly = [qtyEnv];
const stoppedEarly = isComplete(afterQtyOnly);
console.log("after qty-only  -> complete?", stoppedEarly, "(expected false)");

// t=1: dollar arrives too.
const afterBoth = [qtyEnv, dollarEnv];
const nowComplete = isComplete(afterBoth);
const merged = decodeAccumulated(afterBoth);
console.log("after both      -> complete?", nowComplete, "(expected true)");
console.log("dollars =", merged["ISA.Adj $"], " qty =", merged["CountNonNull(ISA.Adj Qty)"]);

const pass = stoppedEarly === false && nowComplete === true &&
  merged["ISA.Adj $"] === -656048.04 && merged["CountNonNull(ISA.Adj Qty)"] === -78507;
console.assert(!stoppedEarly, "❌ poll would have returned early with qty-only (the live bug)");
console.assert(nowComplete, "❌ poll never completes even with both");
console.log(pass ? "\n✅ PASS — poll waits for the dollar card; race fixed." : "\n❌ FAIL");
process.exit(pass ? 0 : 1);
