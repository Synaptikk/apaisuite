// dev/_test-isa-merge.mjs — simulate the extension's multi-envelope merge.
import { readFileSync } from "node:fs";
import { decodeDaxKpis } from "../modules/market120/lib/parse_dax.js";

const d = JSON.parse(readFileSync("./isa-powerbi-probe.json", "utf8"));
const measures = [
  "ISA.Adj $", "CountNonNull(ISA.Adj Qty)", "Min(ISA.Adj Date)", "Max(ISA.Adj Date)",
  "Sum(ISA.Adj Amt)", "Sum(ISA.adj_amt)", "Sum(ISA.Adj Retail)", "Sum(ISA.adj_retail)",
  "Sum(ISA.Adj Retail Amt)", "Total Adjusted $", "Total Adjusted Qty", "Total Adj $",
];
const respNeedles = measures.map((m) => m.toLowerCase());

// Mimic findAllByRespBodySubstr: all envelopes whose respBody has any needle.
const envelopes = d.captured.filter((r) => {
  const b = (r.respBody || "").toLowerCase();
  return b && respNeedles.some((n) => b.includes(n));
});
console.log(`matched ${envelopes.length} envelopes`);

// Mimic captureReport merge.
const merged = {};
for (const env of envelopes) {
  const pr = decodeDaxKpis(env.respBody, measures);
  for (const [k, v] of Object.entries(pr.values || {})) {
    if ((merged[k] === undefined || merged[k] === null) && v !== null) merged[k] = v;
  }
}

// Mimic pickFirstNumeric alias resolution from isa_powerbi.js.
const pick = (keys) => { for (const k of keys) if (Number.isFinite(merged[k])) return merged[k]; return null; };
const dollars = pick(["ISA.Adj $", "Sum(ISA.Adj Amt)", "Sum(ISA.adj_amt)", "Total Adjusted $", "Total Adj $"]);
const qty = pick(["CountNonNull(ISA.Adj Qty)", "Sum(ISA.Adj Qty)", "Total Adjusted Qty"]);

console.log("isa_total_adjusted_dollars =", dollars);
console.log("isa_total_adjusted_qty     =", qty);

const ok = dollars === -656048.04 && qty === -78507;
console.assert(dollars === -656048.04, "❌ dollars wrong");
console.assert(qty === -78507, "❌ qty wrong");
console.log(ok ? "\n✅ PASS — both KPIs correct after multi-envelope merge." : "\n❌ FAIL");
process.exit(ok ? 0 : 1);
