// modules/digitallocks/lib/statusStore.js
//
// Per-event review-status overlay. Stored in chrome.storage.local via
// host.storage so status edits are cheap (one key per event) and survive
// re-imports of the same file (event IDs are deterministic — see
// parseLockEvents.makeEventId).
//
// Storage layout (keys are prefixed `digitallocks.` by host.storage):
//   status.<eventId> = { status, notes, clearedAt, clearedReason, updatedAt }
//
// Why per-event keys and not one big map: chrome.storage.local serializes
// the value at each affected key, not the whole storage area. Per-key
// writes mean a single "Mark Non-Malicious" click rewrites ~150 bytes
// instead of the whole overlay.
//
// Status values match the spec:
//   active                — fresh, awaiting review
//   needs_follow_up       — reviewer wants more info before deciding
//   confirmed_theft_review — escalated for theft-review process (no accusation made)
//   non_malicious         — reviewer has explained the event; not a concern
//   dismissed             — reviewer chose to ignore (e.g. known operational pattern)

export const STATUSES = [
  "active",
  "needs_follow_up",
  "confirmed_theft_review",
  "non_malicious",
  "dismissed",
];

export const STATUS_LABEL = {
  active:                  "Active",
  needs_follow_up:         "Needs follow-up",
  confirmed_theft_review:  "Theft Review",
  non_malicious:           "Non-Malicious",
  dismissed:               "Dismissed",
};

const KEY_PREFIX = "status.";

/**
 * Apply persisted overlay records onto an in-memory event list. Mutates
 * each row's reviewStatus / reviewerNotes / clearedAt / clearedReason.
 * @param {object} hostStorage  host.storage from createHost (host.storage.local interface)
 * @param {object[]} events
 */
export async function applyOverlay(hostStorageLocal, events) {
  // Bulk-read all status.* keys for this module in one trip — fastest.
  const all = await hostStorageLocal.get(null);
  for (const e of events) {
    const k = KEY_PREFIX + e.id;
    const rec = all[k];
    if (rec) {
      e.reviewStatus  = rec.status || "active";
      e.reviewerNotes = rec.notes  || "";
      e.clearedAt     = rec.clearedAt || null;
      e.clearedReason = rec.clearedReason || null;
    }
  }
}

/**
 * Persist a status change for one event.
 *   await setStatus(host.storage.local, eventId, { status: "non_malicious", notes: "Stocking task confirmed" });
 */
export async function setStatus(hostStorageLocal, eventId, patch) {
  if (!eventId) throw new Error("setStatus: eventId required");
  const k = KEY_PREFIX + eventId;
  const prev = (await hostStorageLocal.get(k)) || {};
  const next = {
    status:        patch.status        ?? prev.status        ?? "active",
    notes:         patch.notes         ?? prev.notes         ?? "",
    clearedAt:     patch.status && patch.status !== "active"
                     ? (patch.clearedAt ?? Date.now())
                     : null,
    clearedReason: patch.clearedReason ?? prev.clearedReason ?? null,
    updatedAt:     Date.now(),
  };
  await hostStorageLocal.set(k, next);
  return next;
}

/** Remove the overlay for one event (returns it to default "active"). */
export async function clearStatus(hostStorageLocal, eventId) {
  await hostStorageLocal.remove(KEY_PREFIX + eventId);
}

/**
 * Bulk-archive every event from a given import (sets status to dismissed
 * and clearedReason="archived"). Used when the user picks "Archive old
 * active results and start new review" during a new import.
 */
export async function archiveImport(hostStorageLocal, events) {
  const now = Date.now();
  const mapped = {};
  for (const e of events) {
    if (e.reviewStatus && e.reviewStatus !== "active") continue;
    mapped[KEY_PREFIX + e.id] = {
      status: "dismissed",
      notes: "",
      clearedAt: now,
      clearedReason: "archived",
      updatedAt: now,
    };
  }
  if (Object.keys(mapped).length) {
    await hostStorageLocal.set(mapped);
  }
  return Object.keys(mapped).length;
}
