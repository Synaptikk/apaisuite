// dev/cutover-aurorbuddy.mjs
//
// The whole AurorBuddy cutover in one command: delta-copy the data, verify the
// two sides agree, and only then rewrite the config to point at the new home.
//
//   node dev/cutover-aurorbuddy.mjs           # rehearse — copies nothing, changes nothing
//   node dev/cutover-aurorbuddy.mjs --apply   # do it
//
// WHY A RUNNER AND NOT A LIST OF STEPS. The steps have an order that matters
// and a failure mode that is silent if you get it wrong: the source keeps
// taking writes until the config flips, so anything written between the copy
// and the flip is stranded in a database nothing reads any more. Chaining them
// here closes that window to seconds and makes the flip CONDITIONAL on the
// copy having actually worked. A human running four commands in sequence can
// skip the verify; this cannot.
//
// ONE-WAY. After the flip, dev/migration-copy.mjs must never run again — it
// writes by document id and would revert live rows to their pre-cutover state.
// This script refuses to run once the config is already flipped, so it cannot
// become the thing that does that.

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APPLY = process.argv.includes("--apply");
const HERE  = path.dirname(fileURLToPath(import.meta.url));
const ROOT  = path.resolve(HERE, "..");
const CONFIG_PATH = path.join(ROOT, "modules", "aurorbuddy", "lib", "firestore_config.js");

const SRC = { project: "aurorbuddy", db: "(default)" };
const DST = { project: "apaisuite",  db: "aurorbuddy" };
const DST_WEB_API_KEY = "AIzaSyAxRJ7qjWqm9XgGtNHr1hUyW8IJgcndj_s";

const COLLECTIONS = [
  "tool_events", "tool_scans", "tool_workflows", "tool_metric_events",
  "tool_metrics", "tool_cache_stores", "tool_cache_scans", "users",
];

const die = (m) => { console.error(`\n✖ ${m}\n`); process.exit(1); };
const run = (cmd) => execSync(cmd, { cwd: ROOT, stdio: "inherit" });

// ─── Guards ───────────────────────────────────────────────────────────────

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) die(`Not found: ${CONFIG_PATH}`);
  return fs.readFileSync(CONFIG_PATH, "utf8");
}

// Everything below reads and writes the FIREBASE_CONFIG object literal ONLY.
//
// A whole-file regex is wrong here and quietly so: firestore_config.js carries
// a comment block spelling out the post-cutover values verbatim
// ("//   projectId: \"apaisuite\""), so a naive /projectId:\s*"([^"]+)"/ finds
// the COMMENT first. Reading it that way reports the cutover as already done;
// writing it that way edits the comment, leaves the real config untouched, and
// still passes a "does the file contain this string" check — a flip that
// announces success and changes nothing.
const BLOCK_RE = /(export\s+const\s+FIREBASE_CONFIG\s*=\s*\{)([\s\S]*?)(\n\};)/;

export function parseConfigBlock(src) {
  const m = src.match(BLOCK_RE);
  if (!m) die("Could not find the FIREBASE_CONFIG object in firestore_config.js — has the file changed shape?");
  return { head: m[1], body: m[2], tail: m[3], start: m.index, whole: m[0] };
}

export function readValue(body, key) {
  const m = body.match(new RegExp(`\\b${key}\\s*:\\s*"([^"]*)"`));
  return m ? m[1] : null;
}

export function assertNotAlreadyFlipped(src) {
  const { body } = parseConfigBlock(src);
  const current  = readValue(body, "projectId");
  if (!current) die("No projectId inside the FIREBASE_CONFIG object.");
  if (current === DST.project) {
    die(`Already cut over (projectId is "${DST.project}").\n` +
        `  Re-copying now would REVERT live rows to their pre-cutover state.\n` +
        `  If you genuinely need to re-run the copy, revert the config first and know why.`);
  }
  if (current !== SRC.project) {
    die(`Unexpected projectId "${current}" — expected "${SRC.project}". Refusing to guess.`);
  }
}

function token() {
  try { return execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim(); }
  catch { die("`gcloud auth print-access-token` failed. Run `gcloud auth login` first."); }
}

// ─── Counting ─────────────────────────────────────────────────────────────

const base = ({ project, db }) =>
  `https://firestore.googleapis.com/v1/projects/${project}/databases/${encodeURIComponent(db)}/documents`;

async function count(tok, target, collectionId) {
  const res = await fetch(`${base(target)}:runAggregationQuery`, {
    method:  "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body:    JSON.stringify({
      structuredAggregationQuery: {
        structuredQuery: { from: [{ collectionId }] },
        aggregations: [{ alias: "n", count: {} }],
      },
    }),
  });
  if (!res.ok) die(`COUNT ${collectionId} on ${target.project}/${target.db} failed (${res.status}).`);
  const body = await res.json();
  return Number(body?.[0]?.result?.aggregateFields?.n?.integerValue ?? 0);
}

async function compare(tok) {
  const rows = [];
  for (const c of COLLECTIONS) {
    const [s, d] = await Promise.all([count(tok, SRC, c), count(tok, DST, c)]);
    rows.push({ collection: c, source: s, destination: d, match: s === d });
  }
  const w = Math.max(...rows.map((r) => r.collection.length));
  console.log(`\n  ${"collection".padEnd(w)}   source   dest`);
  for (const r of rows) {
    console.log(`  ${r.collection.padEnd(w)}   ${String(r.source).padStart(6)}   ${String(r.destination).padStart(4)}  ${r.match ? "✔" : "✖ MISMATCH"}`);
  }
  return rows;
}

// ─── The flip ─────────────────────────────────────────────────────────────

const TARGET = { projectId: DST.project, databaseId: DST.db, webApiKey: DST_WEB_API_KEY };

/** Pure: source text in, rewritten source text out. Exported so it is testable. */
export function rewriteConfig(src) {
  const { body, whole, head, tail } = parseConfigBlock(src);

  let nextBody = body;
  for (const [key, want] of Object.entries(TARGET)) {
    const re = new RegExp(`(\\b${key}\\s*:\\s*)"[^"]*"`);
    if (!re.test(nextBody)) die(`No ${key} inside the FIREBASE_CONFIG object.`);
    nextBody = nextBody.replace(re, `$1"${want}"`);
  }

  const next = src.replace(whole, `${head}${nextBody}${tail}`);

  // Verify by RE-PARSING the block, not by searching the file. The values we
  // just wrote also appear in the comment above, so a file-wide check would
  // pass even if nothing in the object had changed.
  const after = parseConfigBlock(next).body;
  for (const [key, want] of Object.entries(TARGET)) {
    const got = readValue(after, key);
    if (got !== want) die(`Rewrite did not take for ${key} (found "${got}"). File left untouched.`);
  }
  return next;
}

function flipConfig() {
  fs.writeFileSync(CONFIG_PATH, rewriteConfig(readConfig()));
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nAurorBuddy cutover — ${SRC.project}/${SRC.db}  →  ${DST.project}/${DST.db}`);
  console.log(APPLY ? "MODE: apply\n" : "MODE: rehearsal (nothing is copied, nothing is changed)\n");

  assertNotAlreadyFlipped(readConfig());
  const tok = token();

  console.log("1. Counts before");
  const before = await compare(tok);

  if (!APPLY) {
    const gaps = before.filter((r) => !r.match);
    console.log(gaps.length
      ? `\n${gaps.length} collection(s) differ — the copy would close them.`
      : "\nAlready in sync. A run would still re-copy, to catch anything written since.");
    console.log("\nRe-run with --apply to copy, verify and flip.\n");
    return;
  }

  console.log("\n2. Delta copy");
  run("node dev/migration-copy.mjs --apply");

  console.log("\n3. Counts after");
  const after = await compare(tok);
  const bad = after.filter((r) => !r.match);
  if (bad.length) {
    die(`${bad.length} collection(s) still differ after the copy: ${bad.map((r) => r.collection).join(", ")}.\n` +
        `  CONFIG NOT FLIPPED — the module is still pointed at ${SRC.project}, so nothing is lost.\n` +
        `  Investigate, then re-run.`);
  }
  console.log("\n   every collection matches ✔");

  console.log("\n4. Flipping firestore_config.js");
  flipConfig();
  console.log(`   projectId  → ${DST.project}`);
  console.log(`   databaseId → ${DST.db}`);
  console.log(`   webApiKey  → ${DST_WEB_API_KEY.slice(0, 12)}…`);

  console.log(`
Done. Remaining steps are yours:

  · Reload the extension at edge://extensions — service-worker code is cached
    until you do, so nothing has actually changed in the browser yet.
  · Run one AurorBuddy scan and watch the service-worker console. The first
    write logs "project changed aurorbuddy → apaisuite; clearing cached
    identity" — that is the guard doing its job, not an error. Firebase
    anonymous users are per project, so the module signs in fresh and gets a
    new uid.
  · Re-run this script's step 1 (node dev/cutover-aurorbuddy.mjs) to confirm
    the destination is now AHEAD of the source by that scan's rows.

  · dev/migration-copy.mjs is now retired. It writes by document id and would
    revert live rows. This script refuses to run again for that reason.
`);
}

// Only run when invoked directly, so the pure text helpers above can be
// imported by tests without the script trying to talk to Firestore.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) main().catch((e) => die(e?.message ?? String(e)));
