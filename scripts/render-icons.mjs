// scripts/render-icons.mjs
// One-shot icon generator: rasterizes assets/logos/suite.svg into
// assets/icons/suite-{16,32,48,128}.png using @resvg/resvg-js (pure WASM,
// no native build step). Run once when the source SVG changes.
//
//   node scripts/render-icons.mjs

import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here    = dirname(fileURLToPath(import.meta.url));
const extRoot = join(here, "..");
const srcSvg  = join(extRoot, "assets", "logos", "suite.svg");
const outDir  = join(extRoot, "assets", "icons");
const sizes   = [16, 32, 48, 128];

mkdirSync(outDir, { recursive: true });
const svgBuf = readFileSync(srcSvg);

for (const size of sizes) {
  const resvg = new Resvg(svgBuf, {
    fitTo: { mode: "width", value: size },
    background: "rgba(0,0,0,0)",
  });
  const png  = resvg.render().asPng();
  const out  = join(outDir, `suite-${size}.png`);
  writeFileSync(out, png);
  console.log(`  wrote ${out}  (${png.length} bytes)`);
}
