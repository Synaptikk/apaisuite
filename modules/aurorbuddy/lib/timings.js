// lib/timings.js — per-stage wall-clock recorder for scans / downloads / fills
// ────────────────────────────────────────────────────────────────────────────
// Port of pipeline/timings.py. One Timings instance per message-handler
// invocation in background.js. Returned as `timings` on the response payload;
// app.js accumulates timings across the scan flow (preflight → find_stores →
// scan_auror → appriss_lookup) and renders one collapsible panel under the
// suspects table.
//
// Stage naming convention matches Python — `<module>.<action>`:
//   preflight.total, preflight.auror, preflight.appriss
//   find_stores.total
//   auror.total
//   appriss.total
//   download.total, download.cctv, download.receipt
//   fill.total
//
// Output shape matches Python's Timings.to_dict() exactly so the renderer
// could be reused 1:1 if the Python panel is ever ported back into the
// extension wholesale:
//   { "stage.name": { total_s: <number>, count: <int>, avg_s: <number> }, ... }

export class Timings {
  constructor() {
    this.stages = {};   // stage -> total seconds
    this.counts = {};   // stage -> invocation count
  }

  // Wraps an async fn. Returns whatever fn returns. Always records, even
  // if fn throws — matches the Python `try / finally` semantics.
  async measure(stage, fn) {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      this.add(stage, (performance.now() - t0) / 1000);
    }
  }

  add(stage, seconds) {
    this.stages[stage] = (this.stages[stage] || 0) + seconds;
    this.counts[stage] = (this.counts[stage] || 0) + 1;
  }

  // Sorted alphabetically (matches Python). The UI re-sorts by total_s
  // descending at render time — keeping the wire format stable lets the
  // payloads merge cleanly when multiple handlers contribute timings to
  // the same scan flow.
  toDict() {
    const out = {};
    for (const stage of Object.keys(this.stages).sort()) {
      const total = this.stages[stage];
      const count = this.counts[stage];
      out[stage] = {
        total_s: Math.round(total * 1000) / 1000,
        count,
        avg_s:   count ? Math.round((total / count) * 1000) / 1000 : 0,
      };
    }
    return out;
  }
}

// Merge two wire-format timings dicts (the shape toDict() emits). Used by
// app.js to accumulate timings from preflight + find_stores + scan_auror +
// appriss_lookup into a single render. Stage totals/counts add; avg_s is
// recomputed from the merged totals.
export function mergeTimings(...dicts) {
  const stages = {};
  const counts = {};
  for (const d of dicts) {
    if (!d) continue;
    for (const [stage, s] of Object.entries(d)) {
      stages[stage] = (stages[stage] || 0) + (s.total_s || 0);
      counts[stage] = (counts[stage] || 0) + (s.count   || 0);
    }
  }
  const out = {};
  for (const stage of Object.keys(stages).sort()) {
    const total = stages[stage];
    const count = counts[stage];
    out[stage] = {
      total_s: Math.round(total * 1000) / 1000,
      count,
      avg_s:   count ? Math.round((total / count) * 1000) / 1000 : 0,
    };
  }
  return out;
}
