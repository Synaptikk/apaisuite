// scripts/strip-modules.mjs
//
// Remove modules from a STAGED extension tree before it is packaged, without
// touching the repo. Used by pack-cws.sh to keep work-in-progress modules out
// of the Chrome Web Store build while they stay in git for development.
//
// Stripping a module means three things, and missing any one of them either
// breaks the extension or leaves privilege the package cannot justify:
//   1. delete modules/<id>/
//   2. drop its content_scripts entries from the manifest (a declared script
//      that isn't in the package makes the extension fail to load)
//   3. drop host_permissions only that module needed (a reviewer will ask
//      what reaches a host, and nothing in the package would)
//
// Usage:  node strip-modules.mjs <staged-dir> <id>:<host>,<host> [<id>:...]

import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { argv, exit } from "node:process";

const [, , stageDir, ...specs] = argv;
if (!stageDir || !specs.length) {
  console.error("usage: node strip-modules.mjs <staged-dir> <id>[:host,host] ...");
  exit(64);
}

const manifestPath = path.join(stageDir, "manifest.json");
const m = JSON.parse(readFileSync(manifestPath, "utf8"));
const registryPath = path.join(stageDir, "modules", "_registry.js");

for (const spec of specs) {
  // Split on the FIRST colon only — the host list is full of https:// URLs.
  const sep = spec.indexOf(":");
  const id = sep === -1 ? spec : spec.slice(0, sep);
  const hostList = sep === -1 ? "" : spec.slice(sep + 1);
  const dir = path.join(stageDir, "modules", id);

  if (!existsSync(dir)) {
    console.error(`  strip: module not found in staged tree: ${id}`);
    exit(1);
  }
  rmSync(dir, { recursive: true, force: true });

  const before = m.content_scripts?.length ?? 0;
  m.content_scripts = (m.content_scripts ?? []).filter(
    (cs) => !(cs.js ?? []).some((j) => j.startsWith(`modules/${id}/`)),
  );
  const droppedScripts = before - m.content_scripts.length;

  const hosts = (hostList ?? "").split(",").filter(Boolean);
  const beforeHosts = m.host_permissions?.length ?? 0;
  m.host_permissions = (m.host_permissions ?? []).filter((h) => !hosts.includes(h));
  const droppedHosts = beforeHosts - m.host_permissions.length;

  // A registry entry pointing at a deleted directory throws on load and takes
  // every other module down with it — the exact failure this consolidation
  // already hit once with market120/sparkrisk.
  const reg = readFileSync(registryPath, "utf8");
  const live = new RegExp(`^\\s*import\\s+${id}\\b`, "m").test(reg) &&
               !new RegExp(`^\\s*//\\s*import\\s+${id}\\b`, "m").test(reg);
  if (live) {
    console.error(`  strip: ${id} is still imported in _registry.js — stripping it would break the build`);
    exit(1);
  }

  console.log(`  stripped ${id}: module dir, ${droppedScripts} content script(s), ${droppedHosts} host permission(s)`);
}

writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
