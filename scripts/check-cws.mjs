// scripts/check-cws.mjs
//
// Pre-upload validation for the Chrome Web Store package. Catches the things
// the store rejects only after you've waited through an upload.
//
// Usage:
//   node check-cws.mjs manifest <staged-ext-dir>   — validate the staged tree
//   node check-cws.mjs zip <archive.zip>           — validate archive layout

import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { argv, exit } from "node:process";

const [, , mode, target] = argv;
if (!mode || !target) {
  console.error("usage: node check-cws.mjs <manifest|zip> <path>");
  exit(64);
}

const fail = [];

if (mode === "manifest") {
  const m = JSON.parse(readFileSync(path.join(target, "manifest.json"), "utf8"));

  // Self-hosting leftovers the store refuses.
  if (m.update_url) fail.push('manifest has "update_url" — remove it; the store serves updates');
  if (m.key) fail.push('manifest has "key" — remove it; the store assigns the extension ID');

  if (m.manifest_version !== 3) fail.push("manifest_version must be 3");
  if (!/^\d+(\.\d+){0,3}$/.test(m.version ?? "")) fail.push(`bad version string: ${m.version}`);

  // Listing fields the dashboard enforces.
  const desc = m.description ?? "";
  if (!desc) fail.push("description is required");
  else if (desc.length > 132) fail.push(`description is ${desc.length} chars, store max is 132`);
  if (!m.icons?.["128"]) fail.push("a 128x128 icon is required for the store listing");

  // Every referenced path must exist inside the staged tree, or the store
  // rejects on "file not found" — a stale manifest entry is easy to miss.
  const refs = [];
  for (const cs of m.content_scripts ?? []) refs.push(...(cs.js ?? []), ...(cs.css ?? []));
  if (m.background?.service_worker) refs.push(m.background.service_worker);
  refs.push(...Object.values(m.icons ?? {}), ...Object.values(m.action?.default_icon ?? {}));
  for (const p of refs) {
    if (!existsSync(path.join(target, p))) fail.push(`referenced file missing from package: ${p}`);
  }

  if (!fail.length) {
    console.log(
      `  ok — v${m.version}, ${(m.permissions ?? []).length} permissions, ` +
        `${(m.host_permissions ?? []).length} host permissions, ${refs.length} referenced files present`,
    );
  }
} else if (mode === "zip") {
  const { default: AdmZip } = await import("adm-zip");
  const entries = new AdmZip(target).getEntries().map((e) => e.entryName);
  if (!entries.includes("manifest.json")) {
    fail.push('manifest.json is not at the archive root — the store rejects this with "Manifest file is missing or unreadable"');
  }
  const mb = statSync(target).size / 1048576;
  if (mb > 2048) fail.push(`archive is ${mb.toFixed(0)} MB, over the store's 2 GB limit`);
  if (!fail.length) console.log(`  ok — ${entries.length} entries, manifest.json at root, ${mb.toFixed(2)} MB`);
} else {
  console.error(`unknown mode: ${mode}`);
  exit(64);
}

if (fail.length) {
  console.error("  store validation FAILED:");
  for (const f of fail) console.error("   - " + f);
  exit(1);
}
