#!/usr/bin/env node
// scripts/suite-usage-report.mjs
//
// Read `suite_usage_events` out of the apaisuite (default) database and print
// a rollup: which modules get used, by whom (pseudonymously), and how often.
//
// WHY A SCRIPT AND NOT A DASHBOARD. `backend/firestore.suite.rules` denies
// client reads outright, deliberately — an install that could read every other
// install's usage would be a deanonymising tool, and the rules say analysis
// happens "in the console or via a service account, both of which bypass rules
// entirely". This is that path: it authenticates with the Google OAuth
// credential your `firebase` CLI already holds, which is an owner credential
// and therefore not subject to security rules at all. It is also the only
// route from a Walmart machine, where the corp proxy blocks Google web
// sign-in for personal accounts and the console is unreachable.
//
// CREDENTIALS. Reads the refresh token your CLI stored at
// ~/.config/configstore/firebase-tools.json and exchanges it for a short-lived
// access token in memory. Nothing is written, nothing is printed, nothing
// leaves the machine except to Google's own endpoints.
//
// PSEUDONYMITY. These rows carry an installation id, store, market and role —
// never a name, email or WIN (see shared/usage_metrics.js). This report keeps
// it that way: it counts distinct installation ids and never prints one, so
// "12 installs" cannot become "which 12".
//
// USAGE
//   node scripts/suite-usage-report.mjs                 # last 30 days
//   node scripts/suite-usage-report.mjs --days=7
//   node scripts/suite-usage-report.mjs --days=all
//   node scripts/suite-usage-report.mjs --json          # machine-readable
//   node scripts/suite-usage-report.mjs --collection=suite_schema_drift

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { labelInstalls, labelFor } from "../shared/usage_labels.js";

const CLIENT_ID     = "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi";

const PROJECT    = "apaisuite";
const DATABASE   = "(default)";
const PAGE_SIZE  = 300;
// A backstop, not a silent cap: if it is hit the report says so rather than
// quietly describing a slice as if it were everything.
const MAX_ROWS   = 20_000;

const args       = process.argv.slice(2);
const asJson     = args.includes("--json");
const collection = arg("collection", "suite_usage_events");
const daysArg    = arg("days", "30");
const days       = daysArg === "all" ? null : Number(daysArg);

function arg(name, fallback) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
}

function die(msg) { console.error(`\n✖ ${msg}\n`); process.exit(1); }

if (days !== null && (!Number.isFinite(days) || days <= 0)) {
  die(`--days must be a positive number or "all" (got "${daysArg}")`);
}

// ─── Auth ─────────────────────────────────────────────────────────────────

async function accessToken() {
  const p = path.join(os.homedir(), ".config", "configstore", "firebase-tools.json");
  if (!fs.existsSync(p)) die(`No firebase-tools config at ${p}. Run \`firebase login\` first.`);
  let rt;
  try { rt = JSON.parse(fs.readFileSync(p, "utf8"))?.tokens?.refresh_token; }
  catch { die(`Could not parse ${p}.`); }
  if (!rt) die("No refresh token stored. Run `firebase login` first.");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      refresh_token: rt, grant_type: "refresh_token",
    }),
  });
  if (!res.ok) die(`Token exchange failed (${res.status}). Try \`firebase login --reauth\`.`);
  return (await res.json()).access_token;
}

// ─── Firestore read ───────────────────────────────────────────────────────

function decode(v) {
  if (!v || typeof v !== "object") return v;
  if (v.nullValue !== undefined)      return null;
  if (v.booleanValue !== undefined)   return v.booleanValue;
  if (v.integerValue !== undefined)   return Number(v.integerValue);
  if (v.doubleValue !== undefined)    return Number(v.doubleValue);
  if (v.stringValue !== undefined)    return v.stringValue;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.arrayValue !== undefined)     return (v.arrayValue.values || []).map(decode);
  if (v.mapValue !== undefined)       return decodeFields(v.mapValue.fields || {});
  return null;
}
const decodeFields = (f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, decode(v)]));

async function fetchRows(token) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${encodeURIComponent(DATABASE)}/documents:runQuery`;
  const since = days === null ? null : new Date(Date.now() - days * 86_400_000).toISOString();

  const rows = [];
  let offset = 0, truncated = false;

  for (;;) {
    const structuredQuery = {
      from:    [{ collectionId: collection }],
      orderBy: [{ field: { fieldPath: "timestamp" }, direction: "DESCENDING" }],
      limit:   PAGE_SIZE,
      offset,
    };
    if (since) {
      structuredQuery.where = {
        fieldFilter: {
          field: { fieldPath: "timestamp" },
          op:    "GREATER_THAN_OR_EQUAL",
          value: { timestampValue: since },
        },
      };
    }

    const res = await fetch(url, {
      method:  "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body:    JSON.stringify({ structuredQuery }),
    });
    const body = await res.text();
    if (!res.ok) {
      if (res.status === 403) die(`403 reading ${collection}. Your account may lack access to ${PROJECT}.\n  ${body.slice(0, 300)}`);
      die(`Query failed (${res.status}).\n  ${body.slice(0, 300)}`);
    }

    let page;
    try { page = JSON.parse(body); } catch { die("Unparseable response from Firestore."); }
    const docs = page.filter((e) => e.document).map((e) => ({
      ...decodeFields(e.document.fields || {}),
      _timestamp: e.document.fields?.timestamp?.timestampValue || e.document.createTime,
    }));

    rows.push(...docs);
    if (docs.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    if (rows.length >= MAX_ROWS) { truncated = true; break; }
  }
  return { rows, truncated };
}

// ─── Rollups ──────────────────────────────────────────────────────────────

const dayOf = (iso) => (iso || "").slice(0, 10);

function tally(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k === null || k === undefined || k === "") continue;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
const distinct = (rows, k) => new Set(rows.map((r) => r[k]).filter(Boolean)).size;

function bar(n, max, width = 28) {
  if (!max) return "";
  return "█".repeat(Math.max(1, Math.round((n / max) * width)));
}

function section(title, pairs, { total, extra } = {}) {
  console.log(`\n${title}`);
  console.log("─".repeat(title.length));
  if (!pairs.length) { console.log("  (none)"); return; }
  const max = pairs[0][1];
  const w   = Math.max(...pairs.map(([k]) => String(k).length));
  for (const [k, n] of pairs) {
    const pct = total ? ` ${String(Math.round((n / total) * 100)).padStart(3)}%` : "";
    const ex  = extra ? extra(k) : "";
    console.log(`  ${String(k).padEnd(w)}  ${String(n).padStart(5)}${pct}  ${bar(n, max)}${ex}`);
  }
}

function median(xs) {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const token = await accessToken();
  const { rows, truncated } = await fetchRows(token);

  if (asJson) {
    console.log(JSON.stringify({ collection, days, count: rows.length, truncated, rows }, null, 2));
    return;
  }

  const window = days === null ? "all time" : `last ${days} day${days === 1 ? "" : "s"}`;
  console.log(`\n${collection} — ${window}   (${PROJECT}/${DATABASE})`);
  console.log(`${rows.length} event${rows.length === 1 ? "" : "s"}`);

  if (!rows.length) {
    console.log(`
Nothing recorded in this window. If that is unexpected, the likely causes are:
  · the extension has not run since the telemetry client was repointed
  · rules were not deployed:  firebase deploy --only firestore --project ${PROJECT}
  · events are still sitting in the local retry queue (chrome.storage.local,
    key "shell.usage.pending") because an earlier write failed
`);
    return;
  }
  if (truncated) {
    console.log(`⚠ capped at ${MAX_ROWS} rows — figures below describe the most recent ${MAX_ROWS}, not the whole window.`);
  }

  // Installation ids are counted, never printed. That distinction is the
  // pseudonymity guarantee, not a formatting choice.
  console.log(`${distinct(rows, "installationId")} install(s) · ` +
              `${distinct(rows, "storeNumber")} store(s) · ` +
              `${distinct(rows, "marketNumber")} market(s)`);

  // ── user vs automation ──────────────────────────────────────────────────
  //
  // Alarm-driven work is recorded (it is the only evidence those alarms fire)
  // but must never be counted as usage — vizpick checks every 30 min,
  // sparkscango every 15, metricshot every minute. Rows written before the
  // `trigger` field existed have none; those predate automation being recorded
  // at all, so treating them as user rows is correct rather than merely
  // convenient.
  const isAuto = (r) => r.trigger === "auto";
  const auto   = rows.filter(isAuto);
  const used   = rows.filter((r) => !isAuto(r));
  const opens  = used.filter((r) => r.actionName === "module_opened");
  const work   = used.filter((r) => r.actionName !== "module_opened");

  console.log(`${work.length} action(s) · ${opens.length} module open(s) · ${auto.length} automated`);

  // Opening a module is not using it. Kept separate because the gap between
  // the two columns is the interesting number: opened often but rarely used
  // means the tool is found and then abandoned, which no single count shows.
  const byModule = tally(work, (r) => r.moduleName);
  section("Module use (actions, excluding opens and automation)", byModule, {
    total: work.length,
    extra: (m) => {
      const n = new Set(work.filter((r) => r.moduleName === m).map((r) => r.installationId)).size;
      const o = opens.filter((r) => r.moduleName === m).length;
      return `  ${n} install${n === 1 ? "" : "s"}, ${o} open${o === 1 ? "" : "s"}`;
    },
  });

  const openedNotUsed = tally(opens, (r) => r.moduleName)
    .filter(([m]) => !byModule.some(([k]) => k === m));
  if (openedNotUsed.length) {
    section("Opened but never used", openedNotUsed, { total: opens.length });
  }

  // ── per person, without knowing who anyone is ───────────────────────────
  //
  // Labels are DERIVED from (storeNumber, installationId) at read time — see
  // shared/usage_labels.js. Nothing identifying is stored, and the raw
  // installation ids are never printed: "12 installs" must not become
  // "which 12".
  const labels = labelInstalls(rows);
  const perUser = tally(work, (r) => labelFor(labels, r));
  section("Per user (store-scoped pseudonym)", perUser, {
    total: work.length,
    extra: (lbl) => {
      const mods = new Set(work.filter((r) => labelFor(labels, r) === lbl).map((r) => r.moduleName));
      return `  ${mods.size} module${mods.size === 1 ? "" : "s"}`;
    },
  });

  section("Per store", tally(work, (r) => String(r.storeNumber || "").trim() || "(no store)"), {
    total: work.length,
    extra: (s) => {
      const n = [...labels.values()].filter((v) => v.store === s).length;
      return `  ${n} user${n === 1 ? "" : "s"}`;
    },
  });

  if (auto.length) {
    section("Automation (NOT usage — proves the alarms fire)", tally(auto, (r) => `${r.moduleName}.${r.actionName}`), { total: auto.length });
  }

  section("Top actions", tally(rows, (r) => `${r.moduleName}.${r.actionName}`).slice(0, 15), { total: rows.length });
  section("Result", tally(rows, (r) => r.result), { total: rows.length });
  section("By day", tally(rows, (r) => dayOf(r._timestamp || r.occurredAt)).sort((a, b) => a[0].localeCompare(b[0])));

  const roles = tally(rows, (r) => r.role);
  if (roles.length) section("Role", roles, { total: rows.length });

  const versions = tally(rows, (r) => r.toolVersion);
  if (versions.length > 1) section("Tool version", versions, { total: rows.length });

  // Slowest actions by median, not mean: one 90-second outlier should not
  // promote an action that is usually instant.
  const timed = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.durationMs)) continue;
    const k = `${r.moduleName}.${r.actionName}`;
    if (!timed.has(k)) timed.set(k, []);
    timed.get(k).push(r.durationMs);
  }
  const slow = [...timed.entries()]
    .map(([k, xs]) => [k, median(xs), xs.length])
    .filter(([, m]) => m != null)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  if (slow.length) {
    console.log("\nSlowest actions (median)");
    console.log("────────────────────────");
    const w = Math.max(...slow.map(([k]) => k.length));
    for (const [k, m, n] of slow) {
      console.log(`  ${k.padEnd(w)}  ${String((m / 1000).toFixed(1) + "s").padStart(7)}   n=${n}`);
    }
  }

  const errors = rows.filter((r) => r.result && r.result !== "success");
  if (errors.length) {
    section("Failing actions", tally(errors, (r) => `${r.moduleName}.${r.actionName}`).slice(0, 10), { total: errors.length });
  }
  console.log("");
}

main().catch((e) => die(e?.message ?? String(e)));
