#!/usr/bin/env node
//
// Fails if any real associate name has leaked into this module.
//
// Why this exists: while porting, real names from the donor's committed
// NAME_MAPPINGS table and from a real Daily Board workbook were twice copied
// into comments and test fixtures — exactly what this module exists to
// prevent. A checklist item did not stop it; a script does.
//
// The names are READ FROM THE DONOR AT RUNTIME and never written anywhere.
// This file contains no roster data and is safe to commit.
//
// Usage:
//   node modules/digitalmetrics/tools/audit_names.mjs [donorRepoPath]
//
// Exits 0 if clean, 1 if a name leaked, 2 if the donor could not be read
// (so CI can tell "clean" from "did not actually check").

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const DONOR = process.argv[2] || join(process.env.HOME || "", "Digital Metrics");

// Sources of real names inside the donor.
const DONOR_SOURCES = ["functions/index.js"];

const MIN_LEN = 4;   // shorter tokens produce false positives ("JOHN" in a URL)

/**
 * The literal assigned to `name`, brace-matched.
 *
 * A fixed-size window was tried first and was wrong: the donor declares a task
 * list immediately after the name tables, so the window swallowed PICK, DISP,
 * STAGE and friends and reported the entire module as leaking.
 */
function extractLiteral(src, name) {
  const decl = src.indexOf(name);
  if (decl === -1) return null;

  const open = src.slice(decl).search(/[{[]/);
  if (open === -1) return null;

  const start = decl + open;
  const openCh = src[start];
  const closeCh = openCh === "{" ? "}" : "]";

  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === openCh) depth++;
    else if (src[i] === closeCh && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

function realNames() {
  const found = new Set();

  for (const rel of DONOR_SOURCES) {
    const path = join(DONOR, rel);
    if (!existsSync(path)) continue;
    const src = readFileSync(path, "utf8");

    for (const block of ["NAME_MAPPINGS", "TEAM_LEAD_NAMES"]) {
      const literal = extractLiteral(src, block);
      if (!literal) continue;
      for (const m of literal.matchAll(/['"]([A-Za-z][A-Za-z .'-]{2,40})['"]/g)) {
        for (const word of m[1].split(/[\s.'-]+/)) {
          if (word.length >= MIN_LEN) found.add(word.toUpperCase());
        }
      }
    }
  }
  return found;
}

function moduleFiles(dir = MODULE_DIR) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : moduleFiles(path);
    return /\.(js|mjs|md|html|css|json)$/.test(e.name) ? [path] : [];
  });
}

const names = realNames();
if (!names.size) {
  console.error(`Could not read any names from the donor at ${DONOR}.`);
  console.error("Pass the donor repo path as an argument. Not treating this as a pass.");
  process.exit(2);
}

// Words that are real names but also ordinary English; skipping them keeps the
// signal usable. Add sparingly, and never a full name.
const IGNORE = new Set(["DIGITAL", "TRUE", "FALSE", "NULL", "NAME", "TEAM"]);

const hits = [];
for (const file of moduleFiles()) {
  // The audit script itself is allowed to talk about the problem.
  if (file.endsWith("tools/audit_names.mjs")) continue;

  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    const upper = line.toUpperCase();
    for (const name of names) {
      if (IGNORE.has(name)) continue;
      if (new RegExp(`\\b${name}\\b`).test(upper)) {
        hits.push(`${relative(MODULE_DIR, file)}:${i + 1}  (${name})`);
      }
    }
  });
}

if (hits.length) {
  console.error(`Real associate names found in the module (${hits.length}):\n`);
  for (const h of hits) console.error("  " + h);
  console.error("\nReplace them with synthetic names. See docs/DIGITAL_METRICS_PRIVACY.md §5.");
  process.exit(1);
}

console.log(`Clean — checked ${names.size} real names against the module.`);
