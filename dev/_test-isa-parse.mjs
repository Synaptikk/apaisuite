// dev/_test-isa-parse.mjs — validates parse_dax against the REAL captured DSR.
import { readFileSync } from "node:fs";
import { decodeDaxKpis } from "../modules/market120/lib/parse_dax.js";

const d = JSON.parse(readFileSync("./isa-powerbi-probe.json", "utf8"));

// The measure list from isa_powerbi.js (exact names first).
const measures = [
  "ISA.Adj $", "CountNonNull(ISA.Adj Qty)", "Min(ISA.Adj Date)", "Max(ISA.Adj Date)",
  "Sum(ISA.Adj Amt)", "Sum(ISA.adj_amt)", "Sum(ISA.Adj Retail)", "Sum(ISA.adj_retail)",
  "Sum(ISA.Adj Retail Amt)", "Total Adjusted $", "Total Adjusted Qty", "Total Adj $",
];

// Find the response that carries the target measure and decode it.
let passed = false;
for (const r of d.captured) {
  if (!r.respBody || !r.respBody.includes('"ISA.Adj $"')) continue;
  const { ok, values, seen } = decodeDaxKpis(r.respBody, measures);
  if (!ok) continue;
  const dollars = values["ISA.Adj $"];
  if (dollars === null) continue;
  const qty = values["CountNonNull(ISA.Adj Qty)"];
  console.log("decoded ISA.Adj $   =", dollars, "(seen decoy ISA.Adj $... =", seen["ISA.Adj $..."], ")");
  console.log("decoded Adj Qty     =", qty);

  const dollarsOK = dollars === -656048.04;
  const notDecoy  = dollars !== -2837.87 && dollars !== 40;
  console.assert(dollarsOK, "❌ FAIL: expected -656048.04");
  console.assert(notDecoy, "❌ FAIL: grabbed a decoy value!");
  if (dollarsOK && notDecoy) { passed = true; }
  break;
}
console.log(passed ? "\n✅ PASS — exact match beat the decoys." : "\n❌ FAIL");
process.exit(passed ? 0 : 1);
