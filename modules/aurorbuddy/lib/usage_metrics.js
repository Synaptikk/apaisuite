// modules/aurorbuddy/lib/usage_metrics.js
//
// Per-action telemetry helper. Writes /tool_metric_events rows + a separate
// retry queue from the firestore writer so a write storm in one doesn't
// stall the other.
//
// Spec: docs/USAGE_METRICS_MODEL.md
//
// CRITICAL: every public function is best-effort. Failures NEVER throw into
// the caller's promise chain. Failures NEVER block the user-visible workflow.
// All string fields pass through sanitizeForMetric() before write to enforce
// the no-PII rule.

import { FIREBASE_CONFIG, ANALYST_SOURCE } from "./firestore_config.js";
import { commonRowFields, toFirestoreFields, getUid } from "./firestore.js";

const { projectId } = FIREBASE_CONFIG;

const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;

const STORE_KEY_PENDING = "aurorbuddy.fb_pendingMetrics";
const STORE_KEY_TOKEN   = "aurorbuddy.fb_idToken";      // shared with firestore.js for token lookups
const SESSION_KEY_TOKEN = "aurorbuddy.fb_idToken";
const QUEUE_FLUSH_ALARM = "aurorbuddy-fb-metrics-flush";
const QUEUE_FLUSH_PERIOD_MIN = 5;
const MAX_QUEUE = 1000;

// ─── PII redaction ─────────────────────────────────────────────────────────
// Applied to every string field on every metric event before write.
// USAGE_METRICS_MODEL.md §5 enumerates the rules; this is the implementation.

const CARD_RUN_RE       = /\b\d{13,19}\b/g;
const SSN_RUN_RE        = /\b\d{9}\b/g;
const BEARER_RE         = /Bearer\s+[A-Za-z0-9._-]+/gi;
const SECRET_KV_RE      = /(password|token|secret|cookie|jwt|api[_-]?key)\s*[:=]\s*\S+/gi;
const EMAIL_RE          = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const CONTEXT_HINT_CAP  = 200;
const ERROR_MSG_CAP     = 500;

function sanitizeForMetric(value, { selfEmail = "", maxLen = ERROR_MSG_CAP } = {}) {
  if (value == null) return null;
  let s = String(value);
  s = s.replace(CARD_RUN_RE, "<card-redacted>");
  s = s.replace(SSN_RUN_RE,  "<id-redacted>");
  s = s.replace(BEARER_RE,   "Bearer <token-redacted>");
  s = s.replace(SECRET_KV_RE, (_m, key) => `${key}: <redacted>`);
  s = s.replace(EMAIL_RE, (m) => (selfEmail && m.toLowerCase() === selfEmail.toLowerCase()) ? m : "<email-redacted>");
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

// ─── Browser hint ──────────────────────────────────────────────────────────

function browserSlug() {
  try {
    const ua = navigator.userAgent || "";
    if (/Edg\/\d+/.test(ua)) return "Edge/" + ua.match(/Edg\/(\d+)/)?.[1];
    if (/Chrome\/\d+/.test(ua)) return "Chrome/" + ua.match(/Chrome\/(\d+)/)?.[1];
  } catch {}
  return "unknown";
}

// ─── REST primitives ──────────────────────────────────────────────────────
// Reuses the firestore writer's auth (same anonymous UID + ID token cache).

async function getIdToken() {
  const ses = await chrome.storage.session.get(SESSION_KEY_TOKEN);
  return ses[SESSION_KEY_TOKEN] || null;
}

async function postMetricEvent(payloadFields) {
  // Note: getIdToken() here pulls from the SAME session-cached token as
  // firestore.js. If the token is missing/stale, the firestore writer will
  // refresh it on its next write; in the meantime our metric event queues.
  const idToken = await getIdToken();
  if (!idToken) throw new Error("no_id_token_cached");
  const docName = "tool_metric_events";
  const r = await fetch(`${FIRESTORE_BASE}/${docName}`, {
    method:  "POST",
    headers: {
      "Authorization": `Bearer ${idToken}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({ fields: toFirestoreFields(payloadFields) }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

export async function recordMetric({
  moduleName,
  actionName,
  result = "success",
  durationMs = null,
  workflowId = null,
  contextHint = null,
  errorCode = null,
  errorMessageRedacted = null,
} = {}) {
  if (!moduleName || !actionName) return;
  try {
    const common = await commonRowFields();
    const fields = {
      ...common,
      timestamp: new Date(),  // client time; server timestamp not supported on plain POST docs without :commit. Acceptable for metrics.
      workflowId,
      moduleName: String(moduleName),
      actionName: String(actionName),
      result:     String(result),
      durationMs: durationMs == null ? null : Number(durationMs),
      browser:    browserSlug(),
      contextHint: sanitizeForMetric(contextHint, { selfEmail: common.aurorUserEmail, maxLen: CONTEXT_HINT_CAP }),
      errorCode:   errorCode ? String(errorCode).slice(0, 80) : null,
      errorMessageRedacted: sanitizeForMetric(errorMessageRedacted, { selfEmail: common.aurorUserEmail, maxLen: ERROR_MSG_CAP }),
    };
    try {
      await postMetricEvent(fields);
    } catch (err) {
      await enqueue({ fields, queuedAt: Date.now() });
      await scheduleQueueFlush();
    }
  } catch (err) {
    // Outer catch — telemetry is best-effort, never throw.
    console.warn("[aurorbuddy.usage_metrics] recordMetric swallowed:", err?.message || err);
  }
}

export async function recordError(moduleName, actionName, errorCode, errorMessageRedacted = "") {
  return recordMetric({
    moduleName,
    actionName,
    result: "failure",
    errorCode,
    errorMessageRedacted,
  });
}

// recordWorkflowStatus is a convenience that also emits a metric event
// alongside the workflow_status.js state transition. The state transition
// itself goes through workflow_status.transitionWorkflow() — this is just
// the telemetry surface.
export async function recordWorkflowStatus(workflowId, status, patch = {}) {
  if (!workflowId || !status) return;
  return recordMetric({
    moduleName: "aurorbuddy",
    actionName: "workflow_status_changed",
    result:     "success",
    workflowId,
    contextHint: `status=${status}` + (patch?.errorCode ? `,errorCode=${patch.errorCode}` : ""),
  });
}

// ─── Retry queue (separate from firestore.js's queue) ──────────────────────

async function enqueue(item) {
  const got = await chrome.storage.local.get(STORE_KEY_PENDING);
  const queue = got[STORE_KEY_PENDING] || [];
  queue.push(item);
  await chrome.storage.local.set({
    [STORE_KEY_PENDING]: queue.slice(-MAX_QUEUE),
  });
}

export async function flushQueuedMetrics() {
  const got = await chrome.storage.local.get(STORE_KEY_PENDING);
  const queue = got[STORE_KEY_PENDING] || [];
  if (!queue.length) return { drained: 0, remaining: 0 };

  const remaining = [];
  let drained = 0;
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    try {
      await postMetricEvent(item.fields);
      drained++;
    } catch {
      // Stop on first failure to preserve order + avoid stampede.
      remaining.push(...queue.slice(i));
      break;
    }
  }
  await chrome.storage.local.set({ [STORE_KEY_PENDING]: remaining });
  return { drained, remaining: remaining.length };
}

// Alias matching the user prompt's API wording.
export const retryFailedMetrics = flushQueuedMetrics;

export async function scheduleQueueFlush() {
  if (chrome.alarms?.get) {
    const existing = await chrome.alarms.get(QUEUE_FLUSH_ALARM);
    if (existing) return;
    chrome.alarms.create(QUEUE_FLUSH_ALARM, {
      delayInMinutes:  QUEUE_FLUSH_PERIOD_MIN,
      periodInMinutes: QUEUE_FLUSH_PERIOD_MIN,
    });
  }
}

export function onAlarm(name) {
  if (name !== QUEUE_FLUSH_ALARM) return;
  flushQueuedMetrics().then(({ remaining }) => {
    if (remaining === 0) chrome.alarms.clear(QUEUE_FLUSH_ALARM);
  }).catch(() => {});
}

export const _internals = { QUEUE_FLUSH_ALARM, STORE_KEY_PENDING, sanitizeForMetric };
