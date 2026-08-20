// dev/_test-grid-decode.mjs
// Verifies parse_dax_grid decodes Power BI's ValueDicts + R-repeat compression
// correctly against the REAL captured backroom grid (resp#46, store 1458 by
// associate). This is the shape that broke naive positional decoding.
import { readFileSync } from "node:fs";
import { decodeDaxGrids } from "../modules/market120/lib/parse_dax_grid.js";

const d = JSON.parse(readFileSync("./backroom-powerbi-probe.json", "utf8"));
const { ok, grids } = decodeDaxGrids(d.captured[46].respBody);
console.assert(ok, "❌ no grids decoded");

// Find the Store×UserID×Total Adj $ grid (22 rows).
const grid = grids.find((g) => g.rows.length === 22 && g.measureNames.some((m) => /Total Adj \$/.test(m)));
console.assert(grid, "❌ 22-row associate grid not found");
console.log("dimNames    :", grid.dimNames);
console.log("measureNames:", grid.measureNames);

const measure = grid.measureNames.find((m) => /Total Adj \$/.test(m));
const storeDim = grid.dimNames.find((n) => /store/i.test(n));
const userDim  = grid.dimNames.find((n) => /user/i.test(n));

console.log("\ntop 5 associates by |$|:");
const sorted = [...grid.rows].sort((a, b) => Math.abs(b.measures[measure]) - Math.abs(a.measures[measure]));
for (const r of sorted.slice(0, 5))
  console.log(`   store=${r.dims[storeDim]}  user=${r.dims[userDim]}  $=${r.measures[measure]}`);

const total = grid.rows.reduce((s, r) => s + (r.measures[measure] || 0), 0);
const top = sorted[0];
const allStore1458 = grid.rows.every((r) => String(r.dims[storeDim]) === "1458");

console.log("\nsum of all 22 =", total.toFixed(2), "(expected ~ -46595)");
console.log("top associate =", top.dims[userDim], top.measures[measure].toFixed(2), "(expected SRELDER ~ -13342.85)");
console.log("all rows store 1458?", allStore1458);

const pass =
  grid.rows.length === 22 &&
  Math.round(total) === -46595 &&
  top.dims[userDim] === "SRELDER" &&
  Math.round(top.measures[measure]) === -13343 &&
  allStore1458;

console.assert(Math.round(total) === -46595, "❌ total mismatch");
console.assert(top.dims[userDim] === "SRELDER", "❌ top associate mismatch (dict/repeat decode wrong)");
console.log(pass ? "\n✅ PASS — grid decoder handles ValueDicts + R-repeat correctly." : "\n❌ FAIL");
process.exit(pass ? 0 : 1);
