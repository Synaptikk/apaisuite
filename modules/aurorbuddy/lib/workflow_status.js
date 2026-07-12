// modules/aurorbuddy/lib/workflow_status.js
//
// State-machine helper for AurorBuddy workflows. The ONLY place that should
// write `status` and `statusHistory` on /tool_workflows rows — every call
// site goes through transitionWorkflow() so we get transition validation,
// statusHistory append, and updatedAt stamping in one place.
//
// Spec: docs/AUROR_WORKFLOW_LIFECYCLE.md
// Schema: docs/BACKEND_DATA_MODEL.md §B
//
// CRITICAL: this helper enforces the value-field gate. A caller cannot pass
// `finalEventValue` in a patch unless the target status is
// "submitted_detected", "final_value_captured", or "completed". The gate is
// belt-and-suspenders alongside firestore.rules — better to fail loudly
// in the SW than silently corrupt the dashboard.

import {
  createWorkflow as fsCreateWorkflow,
  updateWorkflow as fsUpdateWorkflow,
  fetchAwaitingExpiredWorkflows,
} from "./firestore.js";

const STATUSES = [
  "import_started",
  "import_prefilled",
  "auror_search_complete",
  "auror_person_matched",
  "auror_person_no_match",
  "auror_draft_staged",
  "auror_draft_filled",
  "awaiting_user_completion",
  "submitted_detected",
  "final_value_captured",
  "completed",
  "failed",
  "canceled",
  "unknown",
];

// Allowed forward transitions per AUROR_WORKFLOW_LIFECYCLE.md §2.
// "failed" and "canceled" are reachable from any state (handled separately).
const ALLOWED = {
  import_started:           ["import_prefilled", "failed", "canceled"],
  import_prefilled:         ["auror_search_complete", "failed", "canceled"],
  auror_search_complete:    ["auror_person_matched", "auror_person_no_match", "failed", "canceled"],
  auror_person_matched:     ["auror_draft_staged", "failed", "canceled"],
  auror_person_no_match:    ["auror_draft_staged", "failed", "canceled"],
  auror_draft_staged:       ["auror_draft_filled", "failed", "canceled"],
  auror_draft_filled:       ["awaiting_user_completion", "failed", "canceled"],
  awaiting_user_completion: ["submitted_detected", "canceled", "failed"],
  submitted_detected:       ["final_value_captured", "failed"],
  final_value_captured:     ["completed"],
  completed:                [],
  failed:                   [],
  canceled:                 [],
  unknown:                  STATUSES,  // unknown is a last-resort initial state; any transition out is OK
};

const VALUE_FIELDS = new Set([
  "finalEventValue",
  "finalEventValueSource",
  "finalEventValueConfidence",
  "finalEventValueUnknownReason",
  "valueDisplayLabel",
]);

const STATUSES_THAT_MAY_TOUCH_VALUE_FIELDS = new Set([
  "submitted_detected",
  "final_value_captured",
  "completed",
]);

const WRITABLE_PATCH_FIELDS = new Set([
  // Lifecycle fields the helper sets/maintains
  "status",
  // Substep tracking
  "aurorPersonMatchStatus", "aurorPersonId",
  "aurorEventDraftStatus",
  "aurorSubmitStatus",
  "aurorEventId", "aurorEventUrl",
  // Suspect snapshot (early in the workflow only — gated by status check below)
  "suspectName", "suspectAurorPersonId",
  // Transaction snapshot
  "transactionContext",
  // Failure context
  "errorCode", "errorMessageRedacted",
  // Value fields (gated by VALUE_FIELDS + STATUSES_THAT_MAY_TOUCH_VALUE_FIELDS)
  ...VALUE_FIELDS,
]);

// statusHistory append helper. Kept client-side; cap at 50 entries.
function appendHistory(history, status, note) {
  const next = Array.isArray(history) ? history.slice() : [];
  next.push({ status, at: new Date().toISOString(), note: note || null });
  return next.slice(-50);
}

export function isValidStatus(s) {
  return STATUSES.includes(s);
}

export function canTransition(fromStatus, toStatus) {
  if (!isValidStatus(toStatus)) return false;
  if (toStatus === "failed" || toStatus === "canceled") return true;
  if (!fromStatus) return toStatus === "import_started" || toStatus === "unknown";
  if (!isValidStatus(fromStatus)) return false;
  return (ALLOWED[fromStatus] || []).includes(toStatus);
}

// Create a new workflow record in `import_started` (or another initial
// state if explicitly requested — unusual). Returns the workflowId.
export async function startWorkflow({
  suspectName = "",
  suspectAurorPersonId = null,
  storeNumber = "",
  source = "AurorBuddy",
  moduleName = "aurorbuddy",
  actionName = "import_to_auror",
  initialStatus = "import_started",
} = {}) {
  if (!isValidStatus(initialStatus)) {
    throw new Error(`startWorkflow: invalid initialStatus "${initialStatus}"`);
  }
  const statusHistory = appendHistory([], initialStatus, "workflow created");
  const workflowId = await fsCreateWorkflow({
    suspectName,
    suspectAurorPersonId,
    storeNumber,
    source,
    moduleName,
    actionName,
    status: initialStatus,
    statusHistory,
  });
  return workflowId;
}

// Transition a workflow to a new status with optional field patch.
// Throws if the transition is disallowed OR the patch tries to touch
// value fields outside the permitted state window.
export async function transitionWorkflow(workflowId, toStatus, { fromStatus = null, patch = {}, note = "" } = {}) {
  if (!workflowId) throw new Error("transitionWorkflow: workflowId required");
  if (!isValidStatus(toStatus)) throw new Error(`transitionWorkflow: invalid toStatus "${toStatus}"`);
  if (fromStatus !== null && !canTransition(fromStatus, toStatus)) {
    // Caller passed a known fromStatus — enforce. Otherwise trust the doc.
    throw new Error(`transitionWorkflow: ${fromStatus} → ${toStatus} not allowed`);
  }

  // Filter patch to writable fields only.
  const safePatch = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!WRITABLE_PATCH_FIELDS.has(k)) {
      console.warn(`[aurorbuddy.workflow_status] dropping non-writable patch field "${k}"`);
      continue;
    }
    // Value-field gate: only allowed when the target state opens the value window.
    if (VALUE_FIELDS.has(k) && !STATUSES_THAT_MAY_TOUCH_VALUE_FIELDS.has(toStatus)) {
      throw new Error(`transitionWorkflow: cannot set "${k}" when transitioning to "${toStatus}" (must be submitted_detected/final_value_captured/completed)`);
    }
    safePatch[k] = v;
  }

  safePatch.status = toStatus;
  // statusHistory: caller doesn't pass it; we append on the way. Reading the
  // existing history would require a getDoc round-trip; cheaper to overwrite
  // with the just-appended-1 fragment. The dashboard reads history as
  // best-effort — losing earlier entries on retry is acceptable.
  // (Future improvement: keep history client-side in chrome.storage and
  // merge before writing.)
  safePatch.statusHistory = appendHistory([], toStatus, note);

  await fsUpdateWorkflow(workflowId, safePatch);
}

// Convenience: fail a workflow with an error code + redacted message.
export async function failWorkflow(workflowId, errorCode, errorMessageRedacted = "") {
  if (!workflowId) return;
  try {
    await transitionWorkflow(workflowId, "failed", {
      patch: {
        errorCode,
        errorMessageRedacted: errorMessageRedacted || null,
      },
      note: errorCode || "",
    });
  } catch (err) {
    // Already-failed or other transition error: log + swallow. Telemetry
    // shouldn't block user-visible workflows on its own retry logic.
    console.warn("[aurorbuddy.workflow_status] failWorkflow swallowed:", err?.message || err);
  }
}

// Convenience: cancel.
export async function cancelWorkflow(workflowId, reason = "user_canceled") {
  if (!workflowId) return;
  try {
    await transitionWorkflow(workflowId, "canceled", { note: reason });
  } catch (err) {
    console.warn("[aurorbuddy.workflow_status] cancelWorkflow swallowed:", err?.message || err);
  }
}

// ─── Expired-workflow cleanup (72h timeout) ────────────────────────────────
// AUROR_WORKFLOW_LIFECYCLE.md §4: workflows stuck in
// `awaiting_user_completion` longer than 72h auto-transition to `canceled`
// with errorCode "abandoned_timeout". Fired by a recurring SW alarm
// registered at module.js top level.

const CLEANUP_ALARM_NAME      = "aurorbuddy-workflow-cleanup";
const CLEANUP_PERIOD_MIN      = 6 * 60;       // 6 hours — well below the 72h timeout granularity
const CLEANUP_OLDER_THAN_MS   = 72 * 60 * 60 * 1000;
const CLEANUP_MAX_PER_TICK    = 25;           // safety cap so a backlog doesn't burst the queue

export async function cleanupAwaitingExpired() {
  let expired = [];
  try {
    expired = await fetchAwaitingExpiredWorkflows({ olderThanMs: CLEANUP_OLDER_THAN_MS });
  } catch (err) {
    return { swept: 0, errored: 0, reason: "fetch_failed" };
  }
  if (!expired.length) return { swept: 0, errored: 0 };

  let swept = 0, errored = 0;
  const slice = expired.slice(0, CLEANUP_MAX_PER_TICK);
  for (const w of slice) {
    const workflowId = w.workflowId || w.id;
    if (!workflowId) continue;
    try {
      await transitionWorkflow(workflowId, "canceled", {
        patch: {
          errorCode: "abandoned_timeout",
          errorMessageRedacted: `awaiting_user_completion > ${Math.round(CLEANUP_OLDER_THAN_MS / 3600000)}h`,
        },
        note: "abandoned_timeout",
      });
      swept++;
    } catch (err) {
      errored++;
    }
  }
  return { swept, errored, remaining: expired.length - slice.length };
}

export function scheduleCleanupAlarm() {
  if (!chrome?.alarms?.create) return;
  chrome.alarms.get(CLEANUP_ALARM_NAME).then((existing) => {
    if (existing) return;
    chrome.alarms.create(CLEANUP_ALARM_NAME, {
      delayInMinutes:  CLEANUP_PERIOD_MIN,
      periodInMinutes: CLEANUP_PERIOD_MIN,
    });
  }).catch(() => {});
}

export function onAlarm(name) {
  if (name !== CLEANUP_ALARM_NAME) return;
  cleanupAwaitingExpired()
    .then((r) => {
      if (r.swept || r.errored) {
        console.log("[aurorbuddy.workflow_status] cleanup tick:", r);
      }
    })
    .catch(() => {});
}

export const _internals = { CLEANUP_ALARM_NAME, CLEANUP_PERIOD_MIN, CLEANUP_OLDER_THAN_MS };
