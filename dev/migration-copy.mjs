// dev/migration-copy.mjs
//
// Copy AurorBuddy's Firestore data from the standalone `aurorbuddy` project
// into the `aurorbuddy` named database inside `apaisuite`.
//
//   node dev/migration-copy.mjs            # dry run, writes nothing
//   node dev/migration-copy.mjs --apply    # actually copy
//
// ── Why not gcloud export/import ───────────────────────────────────────────
// That is the documented route and it is unavailable here: the SOURCE project
// has no billing account (Spark plan), so it cannot own a GCS bucket, and
// Firestore export/import goes through one. With 222 documents in total the
// REST route is simpler anyway and needs no bucket, no billing change and no
// cross-project IAM grant.
//
// ── Auth ───────────────────────────────────────────────────────────────────
// An owner OAuth token from `gcloud auth print-access-token`. That is ADMIN
// access: it bypasses security rules, which is required in both directions —
// the source collections are gated to password users, and the destination was
// deliberately created with closed rules.
//
// ── What it preserves, and what it cannot ──────────────────────────────────
// Document IDs are preserved. That is load-bearing twice over: `users/{uid}`
// is keyed by auth uid, and the dashboard de-duplicates the two projects on
// document id, so an id that changed here would show as a duplicate row and
// double every count.
//
// createTime/updateTime are server-owned and CANNOT be preserved — the copies
// will carry today's date as their Firestore metadata. Every document in these
// collections stores its own `timestamp`/`createdAt` field, which is what the
// dashboard actually reads, and those come across untouched.
//
// Idempotent: a document is written by id, so re-running overwrites rather
// than duplicating. Safe to re-run while the destination is not taking live
// writes; NOT safe after cutover, when it would revert newer rows.

import { execSync } from "node:child_process";

const APPLY = process.argv.includes("--apply");

const SRC = { project: "aurorbuddy", db: "(default)" };
const DST = { project: "apaisuite", db: "aurorbuddy" };

const COLLECTIONS = [
  "tool_events",
  "tool_scans",
  "tool_workflows",
  "tool_metric_events",
  "tool_metrics",
  "tool_cache_stores",
  "tool_cache_scans",
  "users",
];

const token = execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();
const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

const base = ({ project, db }) =>
  `https://firestore.googleapis.com/v1/projects/${project}/databases/${encodeURIComponent(db)}/documents`;

/** Every document in a collection, following pagination. */
async function listAll(target, collectionId) {
  const out = [];
  let pageToken;
  do {
    const qs = new URLSearchParams({ pageSize: "300" });
    if (pageToken) qs.set("pageToken", pageToken);
    const res = await fetch(`${base(target)}/${collectionId}?${qs}`, { headers: H });
    if (!res.ok) throw new Error(`list ${collectionId}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    for (const d of body.documents || []) out.push(d);
    pageToken = body.nextPageToken;
  } while (pageToken);
  return out;
}

/** Does this document hide subcollections the copy would silently drop? */
async function subcollectionsOf(target, docPath) {
  const res = await fetch(`${base(target)}/${docPath}:listCollectionIds`, {
    method: "POST", headers: H, body: "{}",
  });
  if (!res.ok) return [];
  return (await res.json()).collectionIds || [];
}

let copied = 0, failed = 0, subFound = [];

console.log(APPLY ? "APPLYING — writing to the destination\n" : "DRY RUN — nothing will be written\n");
console.log(`  ${SRC.project}/${SRC.db}  ->  ${DST.project}/${DST.db}\n`);

for (const c of COLLECTIONS) {
  const docs = await listAll(SRC, c);
  process.stdout.write(`  ${c.padEnd(20)} ${String(docs.length).padStart(4)} docs`);

  // Spot-check the first document for subcollections rather than every one:
  // these collections are flat by design (the rules file matches only
  // top-level paths), and this is a cheap way to notice if that stops being
  // true instead of assuming it.
  if (docs.length) {
    const id = docs[0].name.split("/").pop();
    const subs = await subcollectionsOf(SRC, `${c}/${id}`);
    if (subs.length) subFound.push(`${c}/${id}: ${subs.join(", ")}`);
  }

  if (!APPLY) { console.log("   (dry run)"); continue; }

  let ok = 0;
  for (const d of docs) {
    const id = d.name.split("/").pop();
    // PATCH with no updateMask replaces the whole document, keyed by id.
    const res = await fetch(`${base(DST)}/${c}/${encodeURIComponent(id)}`, {
      method: "PATCH", headers: H, body: JSON.stringify({ fields: d.fields || {} }),
    });
    if (res.ok) { ok++; copied++; }
    else {
      failed++;
      if (failed <= 3) console.log(`\n    FAILED ${c}/${id}: ${res.status} ${(await res.text()).slice(0, 160)}`);
    }
  }
  console.log(`   -> ${ok} written`);
}

console.log(`\n  copied: ${copied}   failed: ${failed}`);
if (subFound.length) {
  console.log("\n  SUBCOLLECTIONS FOUND — these are NOT copied by this script:");
  for (const s of subFound) console.log("    " + s);
}
if (!APPLY) console.log("\n  Re-run with --apply to write.");
