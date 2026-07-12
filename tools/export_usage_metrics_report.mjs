#!/usr/bin/env node
// tools/export_usage_metrics_report.mjs
//
// AurorBuddy usage-metrics export. Runs from a developer/lead laptop with
// Firebase Admin credentials; NOT shipped in the extension.
//
// Spec: ../docs/USAGE_METRICS_MODEL.md §8
//
// Output: a JSON report on stdout, OR a directory of CSV files when
// --csv-dir <path> is passed. JSON shape:
//
//   {
//     generatedAt: ISO timestamp,
//     windowDays: N,
//     storeTotals:    [ { storeNumber, scansLast,  eventsLast,  distinctAnalysts } ],
//     userTotals:     [ { aurorUserEmail, scansLast, eventsLast, lastSeen } ],
//     moduleTotals:   [ { moduleName, opensLast, distinctUsers } ],
//     workflowStatusCounts: [ { status, count } ],
//     legacyValueWarnings: { rowsWithLegacyProxy, totalLegacyProxyValueUsd },
//     errors: [ { errorCode, count } ]
//   }
//
// Auth: set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON path
// with Firestore read access for project `aurorbuddy`.
//
// Usage:
//   node tools/export_usage_metrics_report.mjs                       # JSON to stdout, last 30 days
//   node tools/export_usage_metrics_report.mjs --days 7              # last 7 days
//   node tools/export_usage_metrics_report.mjs --csv-dir ./out       # CSV files in ./out
//   node tools/export_usage_metrics_report.mjs --project aurorbuddy  # override project id

import { initializeApp, applicationDefault, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

// ─── Args ──────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
const windowDays = Number(args.days ?? 30);
const csvDir     = args["csv-dir"] || null;
const projectId  = args.project    || "aurorbuddy";

if (!Number.isFinite(windowDays) || windowDays <= 0 || windowDays > 365) {
  fatal(`--days must be 1..365 (got ${windowDays})`);
}

// ─── Firebase Admin init ───────────────────────────────────────────────────

initializeApp({ projectId, credential: applicationDefault() });
const db = getFirestore();

// ─── Window cutoff ─────────────────────────────────────────────────────────

const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

// ─── Pulls ─────────────────────────────────────────────────────────────────

const [scanDocs, eventDocs, metricEventDocs, workflowDocs, metricsDocs] = await Promise.all([
  pullWindow("tool_scans",           "timestamp"),
  pullWindow("tool_events",          "timestamp"),
  pullWindow("tool_metric_events",   "timestamp"),
  pullWindow("tool_workflows",       "createdAt"),
  pullAll  ("tool_metrics"),
]);

// ─── Aggregates ────────────────────────────────────────────────────────────

const storeTotals    = aggregateByStore(scanDocs, eventDocs);
const userTotals     = aggregateByUser(scanDocs, eventDocs, metricsDocs);
const moduleTotals   = aggregateByModule(metricEventDocs);
const workflowStatusCounts = aggregateByStatus(workflowDocs);
const legacyValueWarnings  = countLegacyValueRows(eventDocs);
const errors         = aggregateByErrorCode(metricEventDocs);

const report = {
  generatedAt:          new Date().toISOString(),
  projectId,
  windowDays,
  storeTotals,
  userTotals,
  moduleTotals,
  workflowStatusCounts,
  legacyValueWarnings,
  errors,
};

// ─── Emit ──────────────────────────────────────────────────────────────────

if (csvDir) {
  await mkdir(csvDir, { recursive: true });
  await Promise.all([
    writeCsv(path.join(csvDir, "store_totals.csv"),
             ["storeNumber", "scansLast", "eventsLast", "distinctAnalysts"], storeTotals),
    writeCsv(path.join(csvDir, "user_totals.csv"),
             ["aurorUserEmail", "scansLast", "eventsLast", "lastSeen"], userTotals),
    writeCsv(path.join(csvDir, "module_totals.csv"),
             ["moduleName", "opensLast", "distinctUsers"], moduleTotals),
    writeCsv(path.join(csvDir, "workflow_status_counts.csv"),
             ["status", "count"], workflowStatusCounts),
    writeCsv(path.join(csvDir, "errors.csv"),
             ["errorCode", "count"], errors),
    writeFile(path.join(csvDir, "report.json"), JSON.stringify(report, null, 2)),
  ]);
  process.stderr.write(`Wrote ${csvDir}/ (5 CSVs + report.json) — window: last ${windowDays} days\n`);
} else {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

// ─── Helpers ───────────────────────────────────────────────────────────────

async function pullWindow(collection, timestampField) {
  try {
    const snap = await db.collection(collection)
      .where(timestampField, ">=", cutoff)
      .get();
    return snap.docs.map((d) => d.data());
  } catch (err) {
    // If timestampField doesn't exist on any doc, the query returns empty.
    // If the collection doesn't exist, Firestore returns empty (not error).
    // Other errors (permissions, etc.) are fatal.
    if (/PERMISSION_DENIED|UNAUTHENTICATED/i.test(String(err?.message ?? ""))) {
      fatal(`Firestore read of /${collection} denied — check service account permissions`);
    }
    process.stderr.write(`[warn] /${collection} query failed: ${err?.message ?? err}\n`);
    return [];
  }
}

async function pullAll(collection) {
  try {
    const snap = await db.collection(collection).get();
    return snap.docs.map((d) => d.data());
  } catch (err) {
    process.stderr.write(`[warn] /${collection} pull failed: ${err?.message ?? err}\n`);
    return [];
  }
}

function aggregateByStore(scans, events) {
  const map = new Map();
  for (const s of scans) {
    const key = String(s.homeStore || s.storeNumber || "");
    if (!key) continue;
    const cur = map.get(key) || { storeNumber: key, scansLast: 0, eventsLast: 0, _analysts: new Set() };
    cur.scansLast++;
    if (s.analystUid) cur._analysts.add(s.analystUid);
    map.set(key, cur);
  }
  for (const e of events) {
    const key = String(e.homeStore || e.storeNumber || e.secureStore || "");
    if (!key) continue;
    const cur = map.get(key) || { storeNumber: key, scansLast: 0, eventsLast: 0, _analysts: new Set() };
    cur.eventsLast++;
    if (e.analystUid) cur._analysts.add(e.analystUid);
    map.set(key, cur);
  }
  return [...map.values()].map((r) => ({
    storeNumber: r.storeNumber,
    scansLast: r.scansLast,
    eventsLast: r.eventsLast,
    distinctAnalysts: r._analysts.size,
  })).sort((a, b) => b.scansLast - a.scansLast);
}

function aggregateByUser(scans, events, metrics) {
  const map = new Map();
  function bump(uid, email, kind) {
    const key = email || uid;
    if (!key) return;
    const cur = map.get(key) || { aurorUserEmail: email || "", scansLast: 0, eventsLast: 0, lastSeen: null };
    if (kind === "scan")  cur.scansLast++;
    if (kind === "event") cur.eventsLast++;
    map.set(key, cur);
  }
  for (const s of scans)  bump(s.analystUid, s.aurorUserEmail, "scan");
  for (const e of events) bump(e.analystUid, e.aurorUserEmail, "event");
  for (const m of metrics) {
    const key = m.aurorUserEmail || m.analystUid;
    const cur = map.get(key);
    if (!cur) continue;
    cur.lastSeen = toIso(m.lastUsedAt) || cur.lastSeen;
  }
  return [...map.values()].sort((a, b) => (b.scansLast + b.eventsLast) - (a.scansLast + a.eventsLast));
}

function aggregateByModule(metricEvents) {
  const map = new Map();
  for (const ev of metricEvents) {
    if (ev.actionName !== "module_opened") continue;
    const key = ev.moduleName || "";
    if (!key) continue;
    const cur = map.get(key) || { moduleName: key, opensLast: 0, _users: new Set() };
    cur.opensLast++;
    if (ev.analystUid) cur._users.add(ev.analystUid);
    map.set(key, cur);
  }
  return [...map.values()].map((r) => ({
    moduleName: r.moduleName,
    opensLast: r.opensLast,
    distinctUsers: r._users.size,
  })).sort((a, b) => b.opensLast - a.opensLast);
}

function aggregateByStatus(workflows) {
  const map = new Map();
  for (const w of workflows) {
    const key = w.status || "unknown";
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()].map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count);
}

function countLegacyValueRows(events) {
  let rowsWithLegacyProxy = 0;
  let totalLegacyProxyValueUsd = 0;
  for (const e of events) {
    const hasLegacyProxy = (e.suspectTotalValue != null) && (e.finalEventValue == null);
    if (hasLegacyProxy) {
      rowsWithLegacyProxy++;
      totalLegacyProxyValueUsd += Number(e.suspectTotalValue) || 0;
    }
  }
  return { rowsWithLegacyProxy, totalLegacyProxyValueUsd: Math.round(totalLegacyProxyValueUsd * 100) / 100 };
}

function aggregateByErrorCode(metricEvents) {
  const map = new Map();
  for (const ev of metricEvents) {
    if (ev.result !== "failure" || !ev.errorCode) continue;
    map.set(ev.errorCode, (map.get(ev.errorCode) || 0) + 1);
  }
  return [...map.entries()].map(([errorCode, count]) => ({ errorCode, count }))
    .sort((a, b) => b.count - a.count);
}

function toIso(v) {
  if (!v) return null;
  if (typeof v === "string") return v;
  if (v.toDate) return v.toDate().toISOString();
  if (v instanceof Date) return v.toISOString();
  return null;
}

async function writeCsv(filePath, cols, rows) {
  const lines = [cols.join(",")];
  for (const r of rows) {
    lines.push(cols.map((c) => csvCell(r[c])).join(","));
  }
  await writeFile(filePath, lines.join("\n") + "\n");
}

function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { out[key] = next; i++; }
    else { out[key] = true; }
  }
  return out;
}

function fatal(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}
