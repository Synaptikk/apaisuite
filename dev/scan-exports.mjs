// dev/scan-exports.mjs
//
// Resolve every local `import { a, b } from "./x.js"` against what x.js
// actually exports.
//
// Why this exists: modules/vizpick/view.js imported getUserHomeMarket and
// onUserMarketChange from shared/userStore.js for weeks before either was
// written. A missing NAMED export is a link-time error that only fires when
// the module is actually loaded — `node --check` passes, the registry loads,
// and the failure surfaces as one module's page being blank. Same shape as
// the market120/sparkrisk registry imports that pointed at files which never
// existed.
//
// Run: node dev/scan-exports.mjs
//
// Matches are anchored to the start of a line so a usage example written as
// `import { x } from "./y.js"` inside a comment is not mistaken for real code
// — the `//` or ` * ` prefix keeps it from matching. An earlier version tried
// stripping comments first and silently ate half of any file containing a
// string literal with `/*` in it, inventing seven missing exports.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const SKIP = new Set(["node_modules", ".git", "dist", "vendor"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const f = path.join(dir, name);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (f.endsWith(".js") || f.endsWith(".mjs")) out.push(f);
  }
  return out;
}

const files = walk(ROOT);

// Named exports of a module: `export function x`, `export const x`,
// `export class x`, `export { a, b }`, `export async function x`.
function exportsOf(file) {
  let src;
  try { src = readFileSync(file, "utf8"); } catch { return null; }
  const names = new Set();
  for (const m of src.matchAll(/^\s*export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm)) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      names.add((as[1] ?? as[0]).trim());
    }
  }
  if (/^\s*export\s+default/m.test(src)) names.add("default");
  if (/^\s*export\s+\*/m.test(src)) names.add("*STAR*");
  return names;
}

const cache = new Map();
const problems = [];

for (const file of files) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/^[ \t]*import\s*\{([^}]*)\}\s*from\s*["'](\.[^"']+)["']/gm)) {
    const spec = m[2];
    const target = path.resolve(path.dirname(file), spec);
    if (!cache.has(target)) cache.set(target, exportsOf(target));
    const have = cache.get(target);
    if (have === null) {
      problems.push(`MISSING FILE  ${path.relative(ROOT, file)} -> ${spec}`);
      continue;
    }
    if (have.has("*STAR*")) continue;   // re-export barrel; can't resolve statically
    for (const raw of m[1].split(",")) {
      const t = raw.trim();
      if (!t) continue;
      const want = t.split(/\s+as\s+/)[0].trim();
      if (!have.has(want)) {
        problems.push(`MISSING EXPORT  ${path.relative(ROOT, file)}  imports '${want}' from ${spec}`);
      }
    }
  }
}

console.log(problems.length ? problems.join("\n") : "clean — every named import resolves");
console.log(`\nscanned ${files.length} files`);
