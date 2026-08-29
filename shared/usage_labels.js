// shared/usage_labels.js
//
// Turn pseudonymous usage rows into readable per-person labels — "Store 756
// User 2" — WITHOUT storing anything that identifies anybody.
//
// suite_usage_events carries a random installationId and a storeNumber, never
// a name, email or WIN; backend/firestore.suite.rules rejects those field
// names outright and docs/privacy/index.html states that to users. So the
// labelling has to happen at READ time, derived from data already present.
// Nothing here is ever written back.
//
// WHAT A LABEL ACTUALLY MEANS. It identifies an INSTALL, not a person:
//   · one analyst across two browser profiles is two "users"
//   · a shared back-office workstation is one "user" for several people
//   · in a store with a single analyst, "User 1" is that analyst by
//     elimination — the label adds no information store+role did not already
//     imply, but it is a persistent handle, which is worth knowing before
//     anyone reports off it
//
// STABILITY. Installs are ordered within a store by when they were first seen,
// so numbering does not shuffle between runs over the same data. It CAN shift
// if a row arrives late — the retry queue can flush days after the fact — and
// an install turns out to be older than one already numbered. That is the
// price of deriving rather than storing, and it is the right trade: a stored
// number would be a persistent identifier for a person, which is the thing
// this design refuses to hold.

const UNKNOWN_STORE = "(no store)";

/** Earliest timestamp on a row, whichever field carries it. */
function firstSeenOf(row) {
  return row?._timestamp || row?.timestamp || row?.occurredAt || "";
}

/**
 * Build a stable installationId → label map.
 *
 * @param {Array<object>} rows  usage rows (any order)
 * @returns {Map<string, {store: string, index: number, label: string}>}
 */
export function labelInstalls(rows) {
  // installationId → { store, firstSeen }
  const installs = new Map();

  for (const r of rows || []) {
    const id = r?.installationId;
    if (!id) continue;
    const store = String(r.storeNumber || "").trim() || UNKNOWN_STORE;
    const seen  = firstSeenOf(r);
    const prev  = installs.get(id);

    if (!prev) {
      installs.set(id, { store, firstSeen: seen });
      continue;
    }
    // Earliest wins for ordering. An install whose store changed (an analyst
    // moving stores) is filed under the store it was FIRST seen at, so its
    // label does not migrate mid-report and read as two different people.
    if (seen && (!prev.firstSeen || seen < prev.firstSeen)) {
      prev.firstSeen = seen;
      prev.store     = store;
    }
  }

  // Group by store, then order by first-seen (ties broken by id so the result
  // is fully deterministic and not dependent on Map insertion order).
  const byStore = new Map();
  for (const [id, info] of installs) {
    if (!byStore.has(info.store)) byStore.set(info.store, []);
    byStore.get(info.store).push({ id, firstSeen: info.firstSeen });
  }

  const out = new Map();
  for (const [store, list] of byStore) {
    list.sort((a, b) =>
      (a.firstSeen || "").localeCompare(b.firstSeen || "") || a.id.localeCompare(b.id));
    list.forEach((entry, i) => {
      const index = i + 1;
      out.set(entry.id, {
        store,
        index,
        label: store === UNKNOWN_STORE ? `Unknown store User ${index}` : `Store ${store} User ${index}`,
      });
    });
  }
  return out;
}

/** Convenience: label for one row, or a stable fallback. */
export function labelFor(labels, row) {
  return labels.get(row?.installationId)?.label ?? "(unattributed)";
}

export const _internals = { UNKNOWN_STORE, firstSeenOf };
