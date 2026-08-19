// modules/aurorbuddy/lib/firestore.js — REST-only Firestore client for AurorBuddy.
//
// Ported from shanesmith/extension/lib/firestore.js with the schema corrections
// described in:
//   - docs/BACKEND_TELEMETRY_AUDIT.md (what was wrong)
//   - docs/BACKEND_DATA_MODEL.md       (the corrected shape)
//   - docs/AUROR_WORKFLOW_LIFECYCLE.md (state machine)
//
// Key differences from the donor:
//   1. NO suspectTotalValue → totalValueTagged bump. The buggy
//      `valueInc: Number(payload.suspectTotalValue) || 0` is removed from
//      both writeEvent() and the retry path. totalValueTaggedConfirmed is
//      bumped only when a confirmed finalEventValue is captured.
//   2. New collection /tool_workflows for lifecycle tracking.
//   3. tool_events uses aurorEventId as the doc id (deterministic) so
//      finalEventValue can be set later via PATCH without query-then-write.
//   4. New tool_metric_events collection for per-action telemetry — schema +
//      writer in lib/usage_metrics.js, NOT here.
//   5. All chrome.storage keys are prefixed `aurorbuddy.` per the suite's
//      MEMORY rule (SW handlers must namespace raw chrome.storage manually).
//
// REST-only (no Firebase JS SDK) because the SDK pulls ~200 KB and assumes
// long-lived WebSocket/IndexedDB state that MV3 SWs can't keep across the
// 30s idle-sleep cycle. Same rationale as the donor.

import { FIREBASE_CONFIG, ANALYST_SOURCE } from "./firestore_config.js";

const { projectId, webApiKey } = FIREBASE_CONFIG;

const IDENTITY_BASE  = "https://identitytoolkit.googleapis.com/v1";
const SECURETOKEN    = "https://securetoken.googleapis.com/v1/token";
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;

const STORE_KEYS = {
  refreshToken:       "aurorbuddy.fb_refreshToken",
  uid:                "aurorbuddy.fb_uid",
  metricsInitialized: "aurorbuddy.fb_metricsInitialized",
  pendingWrites:      "aurorbuddy.fb_pendingWrites",
  aurorIdentity:      "aurorbuddy.fb_aurorIdentity",
  writerEnabled:      "aurorbuddy.fb_writerEnabled",  // sync — flag-gate kill switch (BACKEND_MIGRATION_PLAN.md §7)
};
const SESSION_KEYS = {
  idToken:   "aurorbuddy.fb_idToken",
  idTokenAt: "aurorbuddy.fb_idTokenAt",
};

const ID_TOKEN_TTL_MS         = 55 * 60 * 1000;
const QUEUE_FLUSH_ALARM       = "aurorbuddy-fb-queue-flush";
const QUEUE_FLUSH_PERIOD_MIN  = 5;
const MAX_QUEUE               = 200;

// ─── Writer-enabled flag (rollback switch) ─────────────────────────────────
// Read sync storage on each public write. If `aurorbuddy.fb_writerEnabled` is
// explicitly set to false, every write becomes a no-op so a broken release can
// be silently disabled via a one-line storage push without a rebuild.

async function writerEnabled() {
  try {
    const got = await chrome.storage.sync.get(STORE_KEYS.writerEnabled);
    return got[STORE_KEYS.writerEnabled] !== false;
  } catch {
    return true;
  }
}

// ─── Auror JWT identity capture ────────────────────────────────────────────
// Decodes the JWT payload (no signature check — the rules enforce trust on
// the Firebase side, the Auror JWT is just a convenient source of
// name/email/aurorUserId to stamp on rows).

function base64UrlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return atob(s);
}

export function decodeAurorJwt(rawHeader) {
  if (!rawHeader) return null;
  const tok = rawHeader.replace(/^bearer\s+/i, "").trim();
  const parts = tok.split(".");
  if (parts.length < 2) return null;
  let claims;
  try { claims = JSON.parse(base64UrlDecode(parts[1])); }
  catch { return null; }
  const name =
    claims.name ||
    claims.preferred_username ||
    claims.given_name ||
    (claims.email ? claims.email.split("@")[0] : "") ||
    "";
  return {
    name:        String(name).trim(),
    email:       String(claims.email || "").trim(),
    aurorUserId: String(claims.sub || claims.user_id || claims.uid || "").trim(),
  };
}

export async function captureAurorIdentityFromJwt(rawHeader) {
  const id = decodeAurorJwt(rawHeader);
  if (!id) return null;
  const got = await chrome.storage.local.get(STORE_KEYS.aurorIdentity);
  const prev = got[STORE_KEYS.aurorIdentity] || {};
  const next = { ...prev };
  let changed = false;
  for (const k of ["name", "email", "aurorUserId"]) {
    if (id[k] && !next[k]) { next[k] = id[k]; changed = true; }
  }
  if (changed) await chrome.storage.local.set({ [STORE_KEYS.aurorIdentity]: next });
  return next;
}

export async function getAurorIdentity() {
  const got = await chrome.storage.local.get(STORE_KEYS.aurorIdentity);
  return got[STORE_KEYS.aurorIdentity] || { name: "", email: "", aurorUserId: "" };
}

export async function mergeAurorIdentity(details) {
  if (!details || typeof details !== "object") return;
  const cur = await getAurorIdentity();
  const next = { ...cur };
  let changed = false;
  for (const [k, v] of Object.entries(details)) {
    if (!v) continue;
    if (next[k] === v) continue;
    next[k] = v;
    changed = true;
  }
  if (changed) await chrome.storage.local.set({ [STORE_KEYS.aurorIdentity]: next });
}

// ─── Firebase Anonymous Auth ───────────────────────────────────────────────

async function fetchJson(url, init) {
  const r = await fetch(url, init);
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!r.ok) {
    const err = new Error(`HTTP ${r.status}: ${data?.error?.message || text || "(no body)"}`);
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function signUpAnonymous() {
  const data = await fetchJson(`${IDENTITY_BASE}/accounts:signUp?key=${webApiKey}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    "{}",
  });
  await chrome.storage.local.set({
    [STORE_KEYS.refreshToken]: data.refreshToken,
    [STORE_KEYS.uid]:          data.localId,
  });
  await chrome.storage.session.set({
    [SESSION_KEYS.idToken]:   data.idToken,
    [SESSION_KEYS.idTokenAt]: Date.now(),
  });
  return data.idToken;
}

async function refreshIdToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type:    "refresh_token",
    refresh_token: refreshToken,
  });
  const data = await fetchJson(`${SECURETOKEN}?key=${webApiKey}`, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    body.toString(),
  });
  await chrome.storage.local.set({
    [STORE_KEYS.refreshToken]: data.refresh_token,
  });
  await chrome.storage.session.set({
    [SESSION_KEYS.idToken]:   data.id_token,
    [SESSION_KEYS.idTokenAt]: Date.now(),
  });
  return data.id_token;
}

async function getIdToken() {
  const ses = await chrome.storage.session.get([SESSION_KEYS.idToken, SESSION_KEYS.idTokenAt]);
  if (ses[SESSION_KEYS.idToken] && (Date.now() - (ses[SESSION_KEYS.idTokenAt] || 0)) < ID_TOKEN_TTL_MS) {
    return ses[SESSION_KEYS.idToken];
  }
  const loc = await chrome.storage.local.get(STORE_KEYS.refreshToken);
  if (loc[STORE_KEYS.refreshToken]) {
    return await refreshIdToken(loc[STORE_KEYS.refreshToken]);
  }
  return await signUpAnonymous();
}

export async function getUid() {
  const got = await chrome.storage.local.get(STORE_KEYS.uid);
  if (got[STORE_KEYS.uid]) return got[STORE_KEYS.uid];
  await getIdToken();
  const after = await chrome.storage.local.get(STORE_KEYS.uid);
  return after[STORE_KEYS.uid] || "";
}

// ─── Typed-field encoder/decoder (Firestore REST verbosity tax) ────────────

function toFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean")        return { booleanValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === "string")         return { stringValue: v };
  if (v instanceof Date)             return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map(toFirestoreValue) } };
  }
  if (typeof v === "object")         return { mapValue: { fields: toFirestoreFields(v) } };
  return { stringValue: String(v) };
}

export function toFirestoreFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = toFirestoreValue(v);
  }
  return out;
}

function fromFirestoreValue(v) {
  if (!v || typeof v !== "object") return v;
  if (v.nullValue !== undefined)      return null;
  if (v.booleanValue !== undefined)   return v.booleanValue;
  if (v.integerValue !== undefined)   return Number(v.integerValue);
  if (v.doubleValue !== undefined)    return Number(v.doubleValue);
  if (v.stringValue !== undefined)    return v.stringValue;
  if (v.timestampValue !== undefined) return new Date(v.timestampValue);
  if (v.arrayValue !== undefined)     return (v.arrayValue.values || []).map(fromFirestoreValue);
  if (v.mapValue !== undefined)       return fromFirestoreFields(v.mapValue.fields || {});
  return null;
}

export function fromFirestoreFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = fromFirestoreValue(v);
  return out;
}

// ─── Common header (every doc — BACKEND_DATA_MODEL.md §4) ──────────────────

export async function commonRowFields() {
  const [uid, identity] = await Promise.all([getUid(), getAurorIdentity()]);
  const manifest = chrome.runtime.getManifest?.() ?? {};
  return {
    analystUid:      uid,
    analystSource:   ANALYST_SOURCE,                        // "suite"
    aurorUserName:   identity.name   || "",
    aurorUserEmail:  identity.email  || "",
    aurorUserId:     identity.aurorUserId || "",
    aurorUserStore:  identity.store  || "",
    aurorUserMarket: identity.market || "",
    aurorUserTitle:  identity.title  || "",
    toolVersion:     manifest.version || "",
  };
}

// ─── REST primitives ──────────────────────────────────────────────────────

async function authedFetch(url, body, method = "POST") {
  const idToken = await getIdToken();
  return fetchJson(url, {
    method,
    headers: {
      "Authorization": `Bearer ${idToken}`,
      "Content-Type":  "application/json",
    },
    body:    body ? JSON.stringify(body) : undefined,
  });
}

function randomDocId() {
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  for (let i = 0; i < 20; i++) out += alpha[bytes[i] % alpha.length];
  return out;
}

// Exported for shared/usage_metrics.js, which writes the suite-wide usage
// collection. Exporting the primitive rather than a second copy of the auth
// dance keeps one anonymous-auth path and one token cache; see the note at the
// top of shared/usage_metrics.js about the layering.
export async function commitCreateWithServerTimestamp(collection, docId, fields, timestampField) {
  const docName = `projects/${projectId}/databases/(default)/documents/${collection}/${docId}`;
  const writes = [{
    update: {
      name:   docName,
      fields: toFirestoreFields(fields),
    },
    currentDocument: { exists: false },
    updateTransforms: [
      { fieldPath: timestampField, setToServerValue: "REQUEST_TIME" },
    ],
  }];
  return await authedFetch(`${FIRESTORE_BASE}:commit`, { writes });
}

async function patchDoc(collection, docId, fields, updateMaskFieldPaths, transforms = []) {
  // Update via :commit so we can attach transforms (e.g. updatedAt = REQUEST_TIME)
  // alongside the field updates, and gate updatedAt to server time.
  const docName = `projects/${projectId}/databases/(default)/documents/${collection}/${docId}`;
  const writes = [{
    update: {
      name:   docName,
      fields: toFirestoreFields(fields),
    },
    updateMask:        { fieldPaths: updateMaskFieldPaths },
    updateTransforms:  transforms,
  }];
  return await authedFetch(`${FIRESTORE_BASE}:commit`, { writes });
}

// ─── Public writes (CORRECTED schema per BACKEND_DATA_MODEL.md) ────────────

// Write a tool_scans row. Telemetry-only. Unchanged in shape from donor.
async function writeScanInternal(payload) {
  const common = await commonRowFields();
  const docId = randomDocId();
  await commitCreateWithServerTimestamp("tool_scans", docId, { ...common, ...payload }, "timestamp");
  await bumpMetrics({ scansRunInc: 1 });
}

// Create a tool_workflows row at the moment an AurorBuddy-assisted workflow
// starts. Returns the workflowId. The caller passes that id forward to every
// transitionWorkflow() and write hook for the rest of the flow.
async function createWorkflowInternal(payload) {
  const common = await commonRowFields();
  const workflowId = payload.workflowId || randomDocId();
  const merged = {
    workflowId,
    moduleName:                "aurorbuddy",
    actionName:                "import_to_auror",
    source:                    "AurorBuddy",
    status:                    "import_started",
    aurorPersonMatchStatus:    null,
    aurorPersonId:             null,
    aurorEventDraftStatus:     null,
    aurorSubmitStatus:         null,
    suspectName:               "",
    suspectAurorPersonId:      null,
    transactionContext:        null,
    aurorEventId:              null,
    aurorEventUrl:             null,
    errorCode:                 null,
    errorMessageRedacted:      null,
    ...payload,
    ...common,
  };
  // createdAt + updatedAt both gated to REQUEST_TIME via two transforms on commit.
  const docName = `projects/${projectId}/databases/(default)/documents/tool_workflows/${workflowId}`;
  const writes = [{
    update: { name: docName, fields: toFirestoreFields(merged) },
    currentDocument: { exists: false },
    updateTransforms: [
      { fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" },
      { fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" },
    ],
  }];
  await authedFetch(`${FIRESTORE_BASE}:commit`, { writes });
  await bumpMetrics({ workflowStartedInc: 1 });
  return workflowId;
}

// Update an existing tool_workflows row. Caller has already validated the
// state transition via lib/workflow_status.js (we don't re-validate here).
async function updateWorkflowInternal(workflowId, patch, transforms = []) {
  const writeable = Object.keys(patch);
  const allTransforms = [
    { fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" },
    ...transforms,
  ];
  await patchDoc("tool_workflows", workflowId, patch, writeable, allTransforms);
}

// Write a tool_events row. Doc id = aurorEventId so later finalEventValue
// updates land deterministically (no query-then-write). CRITICAL: this never
// bumps totalValueTagged from any proxy field. totalValueTaggedConfirmed is
// bumped only by writeFinalEventValue() once a confirmed value lands.
async function writeEventInternal(payload) {
  if (!payload.aurorEventId) {
    throw new Error("writeEvent: aurorEventId required for deterministic doc id");
  }
  const common = await commonRowFields();
  const merged = {
    transactionTotalCandidate:        null,
    transactionTotalCandidateSource:  null,
    finalEventValue:                  null,
    finalEventValueSource:            null,
    finalEventValueCapturedAt:        null,
    finalEventValueConfidence:        "unknown",
    finalEventValueUnknownReason:     null,
    valueDisplayLabel:                "Final event value unknown",
    aurorEventStatus:                 "submitted",
    aurorEventSubmittedAt:            null,
    suspectName:                      "",
    suspectAurorPersonId:             null,
    transactionContext:               null,
    ...payload,
    ...common,
  };
  const docId = String(payload.aurorEventId);
  const docName = `projects/${projectId}/databases/(default)/documents/tool_events/${docId}`;
  const writes = [{
    update: { name: docName, fields: toFirestoreFields(merged) },
    currentDocument: { exists: false },
    updateTransforms: [
      { fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" },
      { fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" },
      // `timestamp` mirrors `createdAt` so the existing dashboard query
      // `orderBy('timestamp', 'desc')` (originally built for legacy shanesmith
      // rows) picks up new-shape rows too without a query rewrite. Until the
      // dashboard fully cuts over, this is the cheaper compatibility move.
      { fieldPath: "timestamp", setToServerValue: "REQUEST_TIME" },
      { fieldPath: "aurorEventSubmittedAt", setToServerValue: "REQUEST_TIME" },
    ],
  }];
  await authedFetch(`${FIRESTORE_BASE}:commit`, { writes });
  await bumpMetrics({ eventsSubmittedConfirmedInc: 1 });
}

// Patch an existing tool_events row with a confirmed final value. Called from
// the "Mark Submitted" UX (FINAL_VALUE_CAPTURE_PLAN.md §2 Option A). Only
// this entry point bumps totalValueTaggedConfirmed.
async function writeFinalEventValueInternal({
  aurorEventId,
  finalEventValue,                      // number | null
  finalEventValueSource,                // "user_confirmed" | "auror_page_detected" | "auror_api_fetched" | null
  finalEventValueConfidence,            // "confirmed_by_analyst" | "confirmed_from_auror_page" | "confirmed_from_auror_api" | "unknown"
  finalEventValueUnknownReason = null,
}) {
  if (!aurorEventId) throw new Error("writeFinalEventValue: aurorEventId required");
  const isConfirmed = finalEventValue != null
    && /^confirmed_/.test(finalEventValueConfidence || "");
  const patch = {
    finalEventValue:              isConfirmed ? Number(finalEventValue) : null,
    finalEventValueSource:        isConfirmed ? finalEventValueSource : null,
    finalEventValueConfidence:    finalEventValueConfidence || "unknown",
    finalEventValueUnknownReason: isConfirmed ? null : (finalEventValueUnknownReason || null),
    valueDisplayLabel:            isConfirmed
      ? "Final event value confirmed"
      : "Final event value unknown",
  };
  const transforms = [
    { fieldPath: "updatedAt",                setToServerValue: "REQUEST_TIME" },
  ];
  if (isConfirmed) {
    transforms.push({ fieldPath: "finalEventValueCapturedAt", setToServerValue: "REQUEST_TIME" });
  }
  await patchDoc("tool_events", String(aurorEventId), patch, Object.keys(patch), transforms);
  if (isConfirmed) {
    await bumpMetrics({ valueConfirmedInc: Number(finalEventValue) || 0 });
  }
}

// ─── Per-analyst rollups (corrected schema) ────────────────────────────────

async function bumpMetrics({
  scansRunInc = 0,
  workflowStartedInc = 0,
  eventsSubmittedConfirmedInc = 0,
  valueConfirmedInc = 0,
} = {}) {
  const uid = await getUid();
  const identity = await getAurorIdentity();
  const docName = `projects/${projectId}/databases/(default)/documents/tool_metrics/${uid}`;

  const transforms = [
    { fieldPath: "lastUsedAt", setToServerValue: "REQUEST_TIME" },
  ];
  if (scansRunInc)                 transforms.push({ fieldPath: "scansRun",                 increment: { integerValue: String(scansRunInc) } });
  if (workflowStartedInc)          transforms.push({ fieldPath: "workflowsStarted",         increment: { integerValue: String(workflowStartedInc) } });
  if (eventsSubmittedConfirmedInc) transforms.push({ fieldPath: "eventsSubmittedConfirmed", increment: { integerValue: String(eventsSubmittedConfirmedInc) } });
  // ONLY confirmed values bump totalValueTaggedConfirmed. Proxies never.
  if (valueConfirmedInc)           transforms.push({ fieldPath: "totalValueTaggedConfirmed", increment: { doubleValue: valueConfirmedInc } });

  const flagGot = await chrome.storage.local.get(STORE_KEYS.metricsInitialized);
  const isFirst = !flagGot[STORE_KEYS.metricsInitialized];
  if (isFirst) {
    transforms.push({ fieldPath: "firstUsedAt", setToServerValue: "REQUEST_TIME" });
  }

  const identityFields = {
    analystSource:  ANALYST_SOURCE,
    aurorUserName:  identity.name   || "",
    aurorUserEmail: identity.email  || "",
    aurorUserId:    identity.aurorUserId || "",
    storeNumber:    identity.store  || "",
    aurorUserStore: identity.store  || "",
    aurorUserTitle: identity.title  || "",
  };

  const writes = [{
    update: {
      name:   docName,
      fields: toFirestoreFields(identityFields),
    },
    updateMask:       { fieldPaths: Object.keys(identityFields) },
    updateTransforms: transforms,
  }];

  await authedFetch(`${FIRESTORE_BASE}:commit`, { writes });

  if (isFirst) {
    await chrome.storage.local.set({ [STORE_KEYS.metricsInitialized]: true });
  }
}

// ─── Public API: best-effort, retry-queued ─────────────────────────────────

const RETRYABLE_KINDS = new Set(["scan", "createWorkflow", "updateWorkflow", "event", "finalValue"]);

async function tryWrite(kind, payload) {
  if (!RETRYABLE_KINDS.has(kind)) {
    console.warn("[aurorbuddy.firestore] unknown write kind:", kind);
    return;
  }
  if (!(await writerEnabled())) {
    return;  // kill switch active
  }
  try {
    return await dispatch(kind, payload);
  } catch (err) {
    console.warn(`[aurorbuddy.firestore] ${kind} write failed, queuing:`, err?.message || err);
    await enqueue({ kind, payload, queuedAt: Date.now() });
    await scheduleQueueFlush();
    return null;
  }
}

async function dispatch(kind, payload) {
  switch (kind) {
    case "scan":           return await writeScanInternal(payload);
    case "createWorkflow": return await createWorkflowInternal(payload);
    case "updateWorkflow": return await updateWorkflowInternal(payload.workflowId, payload.patch, payload.transforms || []);
    case "event":          return await writeEventInternal(payload);
    case "finalValue":     return await writeFinalEventValueInternal(payload);
  }
  return null;
}

export async function writeScan(payload)    { return tryWrite("scan", payload); }
export async function createWorkflow(payload) { return tryWrite("createWorkflow", payload); }
export async function updateWorkflow(workflowId, patch, transforms) {
  return tryWrite("updateWorkflow", { workflowId, patch, transforms });
}
export async function writeEvent(payload)   { return tryWrite("event", payload); }
export async function writeFinalEventValue(payload) { return tryWrite("finalValue", payload); }

// ─── Retry queue ───────────────────────────────────────────────────────────

async function enqueue(item) {
  const got = await chrome.storage.local.get(STORE_KEYS.pendingWrites);
  const queue = got[STORE_KEYS.pendingWrites] || [];
  queue.push(item);
  await chrome.storage.local.set({
    [STORE_KEYS.pendingWrites]: queue.slice(-MAX_QUEUE),
  });
}

export async function flushQueue() {
  const got = await chrome.storage.local.get(STORE_KEYS.pendingWrites);
  const queue = got[STORE_KEYS.pendingWrites] || [];
  if (!queue.length) return { drained: 0, remaining: 0 };

  const remaining = [];
  let drained = 0;
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    try {
      await dispatch(item.kind, item.payload);
      drained++;
    } catch {
      // Stop on first failure — preserves order and avoids stampede.
      remaining.push(...queue.slice(i));
      break;
    }
  }
  await chrome.storage.local.set({ [STORE_KEYS.pendingWrites]: remaining });
  return { drained, remaining: remaining.length };
}

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
  flushQueue().then(({ remaining }) => {
    if (remaining === 0) chrome.alarms.clear(QUEUE_FLUSH_ALARM);
  }).catch(() => {});
}

// ─── Reads (used by future Mark-Submitted UX + dashboard parity) ───────────

async function runQuery(structuredQuery) {
  const idToken = await getIdToken();
  const r = await fetch(`${FIRESTORE_BASE}:runQuery`, {
    method:  "POST",
    headers: {
      "Authorization": `Bearer ${idToken}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({ structuredQuery }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`runQuery HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  const arr = await r.json();
  return (arr || [])
    .filter((entry) => entry?.document?.fields)
    .map((entry) => fromFirestoreFields(entry.document.fields));
}

// Workflows owned by this UID still awaiting final value capture. Used by
// the "Mark Submitted" surface to show the analyst what's outstanding.
export async function fetchAwaitingFinalValue() {
  try {
    const uid = await getUid();
    return await runQuery({
      from: [{ collectionId: "tool_events" }],
      where: {
        compositeFilter: {
          op: "AND",
          filters: [
            { fieldFilter: { field: { fieldPath: "analystUid" },                op: "EQUAL",     value: { stringValue: uid } } },
            { fieldFilter: { field: { fieldPath: "finalEventValueConfidence" }, op: "EQUAL",     value: { stringValue: "unknown" } } },
          ],
        },
      },
      orderBy: [{ field: { fieldPath: "createdAt" }, direction: "DESCENDING" }],
      limit: 50,
    });
  } catch (err) {
    console.warn("[aurorbuddy.firestore] fetchAwaitingFinalValue failed:", err?.message || err);
    return [];
  }
}

// Workflows owned by this UID stuck in `awaiting_user_completion` longer
// than the AUROR_WORKFLOW_LIFECYCLE.md §4 timeout. The cleanup helper in
// workflow_status.js transitions these to `canceled` with errorCode
// "abandoned_timeout".
export async function fetchAwaitingExpiredWorkflows({ olderThanMs = 72 * 60 * 60 * 1000 } = {}) {
  try {
    const uid = await getUid();
    const cutoff = new Date(Date.now() - olderThanMs);
    return await runQuery({
      from: [{ collectionId: "tool_workflows" }],
      where: {
        compositeFilter: {
          op: "AND",
          filters: [
            { fieldFilter: { field: { fieldPath: "analystUid" }, op: "EQUAL",     value: { stringValue: uid } } },
            { fieldFilter: { field: { fieldPath: "status" },     op: "EQUAL",     value: { stringValue: "awaiting_user_completion" } } },
            { fieldFilter: { field: { fieldPath: "updatedAt" },  op: "LESS_THAN", value: { timestampValue: cutoff.toISOString() } } },
          ],
        },
      },
      // No orderBy on a multi-field inequality query without a composite
      // index. The caller doesn't care about order — it iterates all.
      limit: 100,
    });
  } catch (err) {
    // Common reason for failure: Firestore needs a composite index for
    // (analystUid ASC, status ASC, updatedAt ASC). Index hint comes back
    // in the error body. Silent on failure — cleanup is best-effort.
    console.warn("[aurorbuddy.firestore] fetchAwaitingExpiredWorkflows failed:", err?.message || err);
    return [];
  }
}

export const _internals = { QUEUE_FLUSH_ALARM, STORE_KEYS, SESSION_KEYS };
