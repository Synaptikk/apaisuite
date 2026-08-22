// shared/schema_watch_report.js
//
// The wiring half of shared/schema_watch.js: pulls the approved baseline out
// of data/source_schemas.json, records drift, and mirrors it to telemetry so
// it shows up in Settings' debug panel without waiting for an upload.
//
// Kept separate from schema_watch.js so that file stays pure and Node-testable
// — it has no fetch, no storage and no logging, which is why its tests can
// assert the exact payload that leaves the machine.
//
// Call sites are one line and must never care about the result:
//
//     watchSourceSchema("vizpick.deptBreakout", csvText, parsed.ok);
//
// Fire-and-forget by design. A source-shape watcher that can delay or fail a
// capture is worse than no watcher at all.

import { noteSchema, describeDrift, readPendingDrift, clearPendingDrift } from "./schema_watch.js";
import { createLogging } from "./logging.js";

const log = createLogging("schema");

let _baselines = null;
async function baselines() {
  if (_baselines) return _baselines;
  try {
    const url = chrome.runtime.getURL("shared/data/source_schemas.json");
    _baselines = await (await fetch(url)).json();
  } catch (e) {
    console.warn("[schema-watch] could not load baselines:", e?.message ?? e);
    _baselines = {};
  }
  return _baselines;
}

/** First line of a tab-separated crosstab, as trimmed column names. */
export function headerRowOf(text) {
  if (!text || typeof text !== "string") return [];
  const first = text.replace(/^﻿/, "").split(/\r?\n/).find((l) => l.length);
  return first ? first.split("\t").map((h) => h.trim()) : [];
}

/**
 * @param {string} sourceId  Key in data/source_schemas.json.
 * @param {string|string[]} textOrColumns  Raw crosstab body, or columns.
 * @param {boolean} parsed   Did the parse still succeed?
 */
export function watchSourceSchema(sourceId, textOrColumns, parsed = true) {
  // Deliberately not awaited by callers. Errors are swallowed here rather than
  // handed back, so no call site has to remember a .catch().
  (async () => {
    try {
      const columns = Array.isArray(textOrColumns) ? textOrColumns : headerRowOf(textOrColumns);
      if (!columns.length) return;
      const all = await baselines();
      const baseline = all?.[sourceId]?.columns || null;
      const { reported, diff } = await noteSchema({ sourceId, columns, baseline, parsed });
      if (!reported) return;
      // Local first: the debug panel shows this immediately, whereas the
      // Firestore row waits for the next flush and a working network.
      log.emit("source-schema-drift", {
        sourceId, status: diff.status, stillParsed: !!parsed,
        added: diff.added, removed: diff.removed,
        summary: describeDrift(sourceId, diff),
      });
      console.warn(`[schema-watch] ${describeDrift(sourceId, diff)}`);
    } catch { /* never let the watcher affect the capture */ }
  })();
}

// ── Upload ────────────────────────────────────────────────────────────────
//
// Same shape as shared/usage_metrics.js: a bounded local queue drained on a
// working connection, stopping at the first failure so a sustained outage does
// not burn the queue on retries that will also fail.
//
// Separate collection from suite_usage_events on purpose. These rows are about
// the SOURCES, not about people — no install id, no store, no market, nothing
// that would need the pseudonymity argument usage_metrics has to make. They
// are closer to a build signal than to telemetry, and one dashboard query
// should be able to answer "what changed under us this week" without filtering
// a busy usage collection.
const COLLECTION = "suite_schema_drift";

export async function flushSchemaDrift() {
  const pending = await readPendingDrift();
  if (!pending.length) return { drained: 0, remaining: 0 };

  // Imported here, not at module scope: this file is pulled in by the capture
  // path, and a static import would drag the Firestore anonymous-auth dance
  // into every context that parses a CSV — including Node tests, which have no
  // chrome.identity to stub.
  const { commitCreateWithServerTimestamp, toFirestoreFields } =
    await import("../modules/aurorbuddy/lib/firestore.js");

  let drained = 0;
  for (const row of pending) {
    try {
      // Doc id is source+fingerprint, so the SAME drift reported from five
      // analysts' machines converges on ONE document instead of five. What
      // matters is that a source changed, not how many people saw it.
      const docId = `${row.sourceId}__${row.fingerprint}`.replace(/[^A-Za-z0-9_.-]/g, "_");
      await commitCreateWithServerTimestamp(COLLECTION, docId, toFirestoreFields(row), "serverDetectedAt");
      drained++;
    } catch {
      break;
    }
  }
  await clearPendingDrift(drained);
  return { drained, remaining: pending.length - drained };
}
