// shared/schema_watch.js
//
// Notices when a source we scrape changes shape, and says so — loudly, once,
// and before it breaks something.
//
// WHY
// ---
// On 2026-08-22 Tableau republished the VizPick workbook with two columns
// renamed ("Suggested Picks" -> "Suggested Picks Seen", "Suggested Picks
// Completed" -> "Suggested Picks Done"). Every current-day capture failed from
// that moment. It took two days to find, because:
//   · the parser only reported "unexpected columns" once it had already failed;
//   · a failed capture leaves the previous snapshot in place, so the UI kept
//     showing plausible, stale numbers;
//   · nothing anywhere was watching for the source changing shape.
//
// None of our sources are APIs with contracts. They are internal dashboards
// that other teams republish whenever they like. Treating a shape change as an
// expected event rather than a surprise is the only thing that scales.
//
// DESIGN
// ------
//   · Detection is OBSERVATIONAL. It never fails a parse. A drifted source may
//     still parse perfectly (a rename we alias, or an added column), and that
//     is exactly the case worth catching — it is the early warning before the
//     next change breaks something.
//   · A repo-checked baseline (data/source_schemas.json) is the known-good
//     shape. Comparing against a runtime-learned value would only ever tell us
//     "it changed since last time", which is silent on a fresh install and
//     unreviewable. A baseline in git is a diff someone approved.
//   · Reported ONCE per (source, shape). A ten-store crawl parses ten times
//     every half hour; without dedupe the signal would bury itself.
//
// PRIVACY: column NAMES only, never row values. Column names are schema —
// "Suggested Picks Done" — not data about a store or a person. There is a test
// asserting nothing but names can reach the payload, because this writes to
// Firestore and that boundary should not be a matter of care.

/** djb2, same hash the suite uses for stable ids elsewhere. */
export function fingerprintColumns(columns) {
  const norm = (columns || [])
    .map((c) => String(c ?? "").trim())
    .filter(Boolean);
  let h = 5381;
  const joined = norm.join("");
  for (let i = 0; i < joined.length; i++) h = ((h << 5) + h + joined.charCodeAt(i)) >>> 0;
  return { hash: h.toString(16), columns: norm, count: norm.length };
}

/**
 * Compare an observed header row against the approved baseline.
 *
 * Order-insensitive: a source reordering its columns is not a change we care
 * about — every parser here resolves columns BY NAME, so a reorder cannot
 * break anything, and flagging it would be noise. Renames, additions and
 * removals all change the name set and are reported.
 *
 * @returns {{status:"ok"|"drift"|"unbaselined", fingerprint:string,
 *            added:string[], removed:string[], observed:string[]}}
 */
export function diffSchema(observedColumns, baselineColumns) {
  const observed = fingerprintColumns(observedColumns);
  if (!baselineColumns || !baselineColumns.length) {
    return { status: "unbaselined", fingerprint: observed.hash, added: [], removed: [], observed: observed.columns };
  }
  const base = fingerprintColumns(baselineColumns);
  const o = new Set(observed.columns);
  const b = new Set(base.columns);
  const added   = observed.columns.filter((c) => !b.has(c));
  const removed = base.columns.filter((c) => !o.has(c));
  return {
    status: added.length || removed.length ? "drift" : "ok",
    fingerprint: observed.hash,
    added, removed,
    observed: observed.columns,
  };
}

/**
 * Human summary for a log line or a doc. Kept here so the wording is identical
 * in the debug panel, the telemetry row and the Firestore document.
 */
export function describeDrift(sourceId, diff) {
  if (diff.status === "ok") return `${sourceId}: schema unchanged`;
  if (diff.status === "unbaselined") return `${sourceId}: no approved baseline yet (${diff.observed.length} columns)`;
  const bits = [];
  if (diff.removed.length) bits.push(`gone: ${diff.removed.join(", ")}`);
  if (diff.added.length) bits.push(`new: ${diff.added.join(", ")}`);
  // Equal counts with both sides populated is almost always a rename, which is
  // the case that silently breaks an exact-name lookup.
  const likelyRename = diff.added.length && diff.removed.length && diff.added.length === diff.removed.length;
  return `${sourceId}: ${likelyRename ? "likely RENAME" : "schema changed"} — ${bits.join("; ")}`;
}

// ── Reporting ─────────────────────────────────────────────────────────────

const SEEN_KEY = "shell.schemaWatch.seen";      // { "<sourceId>:<hash>": ts }
const QUEUE_KEY = "shell.schemaWatch.pending";  // rows awaiting upload
const MAX_QUEUE = 50;
const MAX_SEEN = 200;

/**
 * Record a drift once per (source, shape).
 *
 * Returns { reported: boolean, diff } so callers can log locally regardless.
 * Never throws: a watcher that can break the thing it watches is worse than no
 * watcher.
 *
 * @param {object} opts
 * @param {string} opts.sourceId       e.g. "vizpick.deptBreakout"
 * @param {string[]} opts.columns      Observed header row.
 * @param {string[]} opts.baseline     Approved columns from data/source_schemas.json.
 * @param {boolean} [opts.parsed]      Did the parse still succeed?
 */
export async function noteSchema({ sourceId, columns, baseline, parsed = true }) {
  const diff = diffSchema(columns, baseline);
  if (diff.status === "ok") return { reported: false, diff };

  try {
    const key = `${sourceId}:${diff.fingerprint}`;
    const got = await chrome.storage.local.get([SEEN_KEY, QUEUE_KEY]);
    const seen = got[SEEN_KEY] || {};
    if (seen[key]) return { reported: false, diff, alreadySeen: true };

    seen[key] = Date.now();
    // Bound it — oldest out first.
    const keys = Object.keys(seen);
    if (keys.length > MAX_SEEN) {
      keys.sort((a, b) => seen[a] - seen[b]).slice(0, keys.length - MAX_SEEN).forEach((k) => delete seen[k]);
    }

    const queue = got[QUEUE_KEY] || [];
    queue.push(buildDriftRow({ sourceId, diff, parsed }));
    if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);

    await chrome.storage.local.set({ [SEEN_KEY]: seen, [QUEUE_KEY]: queue });
    return { reported: true, diff };
  } catch {
    return { reported: false, diff, error: true };
  }
}

/** The Firestore payload. Column NAMES only — see the privacy note above. */
export function buildDriftRow({ sourceId, diff, parsed }) {
  return {
    sourceId: String(sourceId),
    status: diff.status,
    fingerprint: diff.fingerprint,
    added: diff.added,
    removed: diff.removed,
    observedColumns: diff.observed,
    columnCount: diff.observed.length,
    // Whether it broke us YET. A drift with parsed:true is the valuable one —
    // it is the warning shot before the change that does break something.
    stillParsed: !!parsed,
    summary: describeDrift(sourceId, diff),
    detectedAt: new Date().toISOString(),
  };
}

/** Anything queued but not yet uploaded. Read by the uploader and the panel. */
export async function readPendingDrift() {
  try {
    const got = await chrome.storage.local.get(QUEUE_KEY);
    return got[QUEUE_KEY] || [];
  } catch { return []; }
}

export async function clearPendingDrift(n) {
  try {
    const got = await chrome.storage.local.get(QUEUE_KEY);
    const queue = got[QUEUE_KEY] || [];
    await chrome.storage.local.set({ [QUEUE_KEY]: n == null ? [] : queue.slice(n) });
  } catch { /* best effort */ }
}

/** Forget what we have seen, so the next parse re-reports. For re-baselining. */
export async function resetSeen() {
  try { await chrome.storage.local.remove(SEEN_KEY); } catch {}
}

export const _internals = { SEEN_KEY, QUEUE_KEY, MAX_QUEUE, MAX_SEEN };
