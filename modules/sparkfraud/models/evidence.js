// EvidenceRecord — provenance metadata attached to every model.
//
// Per docs/ARCHITECTURE.md: "Evidence lineage must be preserved."
// Every Trip / Order / Item carries an EvidenceRecord so downstream consumers
// (UI, telemetry, future investigation journal) can answer "where did this
// data come from and was it live or replayed?"

export function toEvidence({ source, capturedAtMs, fetchedBy }) {
  return {
    sources: [{ system: source, capturedAtMs: capturedAtMs ?? Date.now() }],
    fetchedBy: fetchedBy || "live",  // "live" | "replay" | "cached"
  };
}
