// shared/post_claims.js
//
// One shared, atomic "who posts this slot?" record per scheduled post, so two
// installs at the same store cannot both post (and both email) the same
// scheduled report. Before this, the only "already posted" record was each
// browser's own chrome.storage.local — nothing was shared between users.
//
// Storage: Firestore REST, project `apaisuite`, database `digitalmetrics`
// (the same one modules/digitalmetrics/lib/firestore.js uses — BACKEND is
// imported from its config.js, the few transport lines are copied, nothing in
// that module is imported or edited). Collection:
//
//   postClaims/{claimId}   claimId = claimIdFor({ store, kind, slot, channel })
//   { owner, state: "sending"|"sent"|"failed", at, leaseUntil, messageId,
//     kind, store, slot, channel, error? }
//
// owner = chrome.storage.local["shell.installationId"] (shared/push.js makes
// it; generated and persisted here under the same key if it is missing).
//
// Acquire = a `documents:commit` create with `currentDocument.exists=false`,
// which Firestore applies atomically: exactly one client gets it, every other
// gets 409 ALREADY_EXISTS. On conflict the doc is read and decideClaim()
// (pure, tested) says: sent → skip; held by a live lease → skip; lease
// expired (or our own earlier claim) → take over with an `updateTime`
// precondition, so two clients racing for a dead lease still produce one
// winner.
//
// FAIL CLOSED. When the claim service is unreachable (network, auth, rules
// not deployed → 403) claimPostSlot returns ok:false and the caller skips the
// post THIS tick and goes through its normal failure backoff. Failing open
// would quietly bring back the very duplicate this exists to stop — on the
// days the backend is down, every install at the store would post. A late
// report is better than two of them; the caller's retry/backoff (and the
// catch-up window) bounds how late.
//
// failPostSlot sets leaseUntil = now, so the slot is immediately takeable by
// anyone — the failed owner on its own backoff retry, or another install.
// Failures are only recorded after a read-back found no message (see
// metricshot/lib/post_guard.js), so letting another install try is the right
// call. Exception: an UNKNOWN outcome (releaseLease:false) keeps the lease.
//
// Lives in the service worker only (chrome.storage.session for the token).

import { BACKEND } from "../modules/digitalmetrics/lib/config.js";

const IDENTITY_BASE  = "https://identitytoolkit.googleapis.com/v1";
const TOKEN_KEY      = "postClaims.fb_idToken";
const TOKEN_AT_KEY   = "postClaims.fb_idTokenAt";
const TOKEN_TTL_MS   = 50 * 60 * 1000;          // Firebase ID tokens last 60 min
const INSTALL_ID_KEY = "shell.installationId";
const COLLECTION     = "postClaims";
const REQ_TIMEOUT_MS = 15_000;

// ── Pure helpers (exported for tests) ──────────────────────────────────────

/** Lower-cased, trimmed channel name — the channel half of the claim key. */
export function channelKey(channel) {
  return String(channel || "").trim().toLowerCase();
}

/**
 * Deterministic, collision-free document id for a slot. Characters outside
 * [A-Za-z0-9_.:-] are escaped as ~XX (UTF-8 hex), so distinct inputs never
 * map to the same id and "/" can never appear.
 */
export function claimIdFor({ store, kind, slot, channel }) {
  const raw = `${String(store ?? "")}|${String(kind ?? "")}|${String(slot ?? "")}|${channelKey(channel)}`;
  let out = "";
  for (const byte of new TextEncoder().encode(raw)) {
    const ch = String.fromCharCode(byte);
    out += /[A-Za-z0-9_.:-]/.test(ch) ? ch : "~" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

/**
 * What to do given the claim doc that beat our create.
 * @param {object|null} existing  decoded doc (or null if none)
 * @param {number} now
 * @param {string} self           our owner id
 * @returns {"acquire"|"sent"|"held"|"takeover"}
 */
export function decideClaim(existing, now, self) {
  if (!existing) return "acquire";
  if (existing.state === "sent") return "sent";
  const lease = Number(existing.leaseUntil) || 0;
  // Our own unfinished claim: a retry after our own failure or SW death.
  // Gated upstream by the local postedRuns "sending" in-flight window, and
  // the caller reads back before re-sending.
  if (self && existing.owner === self) return "takeover";
  if (lease < now) return "takeover";
  return "held";
}

// ── Firestore value encoding (copied from digitalmetrics/lib/firestore.js) ──

function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean")        return { booleanValue: v };
  if (typeof v === "number") {
    if (!Number.isFinite(v))         return { nullValue: null };
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  return { stringValue: String(v) };
}
function toFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = toValue(v);
  return out;
}
function fromValue(v) {
  if (!v || typeof v !== "object") return v;
  if (v.nullValue    !== undefined) return null;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue  !== undefined) return Number(v.doubleValue);
  if (v.stringValue  !== undefined) return v.stringValue;
  return null;
}
function fromFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = fromValue(v);
  return out;
}

// ── Transport ──────────────────────────────────────────────────────────────

async function fetchT(url, init) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), REQ_TIMEOUT_MS);
  try { return await fetch(url, { ...init, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

async function idToken() {
  const got = await chrome.storage.session.get([TOKEN_KEY, TOKEN_AT_KEY]);
  if (got[TOKEN_KEY] && Date.now() - (got[TOKEN_AT_KEY] || 0) < TOKEN_TTL_MS) return got[TOKEN_KEY];
  const res = await fetchT(`${IDENTITY_BASE}/accounts:signUp?key=${BACKEND.apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  if (!res.ok) throw new Error(`post_claims: anonymous sign-in failed (${res.status})`);
  const data = await res.json();
  await chrome.storage.session.set({ [TOKEN_KEY]: data.idToken, [TOKEN_AT_KEY]: Date.now() });
  return data.idToken;
}

async function ownerId() {
  const got = await chrome.storage.local.get(INSTALL_ID_KEY);
  const id = got?.[INSTALL_ID_KEY];
  if (typeof id === "string" && id.length >= 8) return id;
  const fresh = crypto.randomUUID();
  await chrome.storage.local.set({ [INSTALL_ID_KEY]: fresh });
  return fresh;
}

function docName(claimId) {
  return `projects/${BACKEND.projectId}/databases/${BACKEND.databaseId}/documents/${COLLECTION}/${claimId}`;
}

/** One-write commit. → { ok:true } | { ok:false, conflict:boolean, status, error } */
async function commitOne(write) {
  const res = await fetchT(`${BACKEND.root}:commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${await idToken()}` },
    body: JSON.stringify({ writes: [write] }),
  });
  if (res.ok) return { ok: true };
  const text = await res.text().catch(() => "");
  // exists:false lost → 409 ALREADY_EXISTS; updateTime lost → 400/409
  // FAILED_PRECONDITION or ABORTED. All of them mean "someone else wrote".
  const conflict = res.status === 409 || /ALREADY_EXISTS|FAILED_PRECONDITION|ABORTED/.test(text);
  return { ok: false, conflict, status: res.status, error: `commit ${res.status}: ${text.slice(0, 200)}` };
}

/** → { data, updateTime } | null (missing). Throws on transport failure. */
async function getClaim(claimId) {
  const res = await fetchT(`${BACKEND.root}/${COLLECTION}/${claimId}`, {
    headers: { "Authorization": `Bearer ${await idToken()}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`get ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const doc = await res.json();
  return { data: fromFields(doc.fields), updateTime: doc.updateTime };
}

async function patchClaim(claimId, fields) {
  return commitOne({
    update: { name: docName(claimId), fields: toFields(fields) },
    updateMask: { fieldPaths: Object.keys(fields) },
    currentDocument: { exists: true },
  });
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Claim one scheduled post slot for this install.
 * @returns {Promise<{ok:true, state:"acquired"|"held"|"sent", claimId:string, owner:string,
 *   takenOver?:boolean, messageId?:string} | {ok:false, error:string, claimId?:string}>}
 *   `owner` is us when acquired, the holder otherwise.
 */
export async function claimPostSlot({ store, kind, slot, channel, leaseMs = 10 * 60_000 }) {
  const claimId = claimIdFor({ store, kind, slot, channel });
  try {
    const self = await ownerId();
    const now = Date.now();
    const doc = {
      owner: self, state: "sending", at: now, leaseUntil: now + leaseMs, messageId: null,
      kind: String(kind), store: String(store), slot: String(slot), channel: channelKey(channel),
    };
    const created = await commitOne({
      update: { name: docName(claimId), fields: toFields(doc) },
      currentDocument: { exists: false },
    });
    if (created.ok) return { ok: true, state: "acquired", claimId, owner: self };
    if (!created.conflict) return { ok: false, claimId, error: created.error };

    const cur = await getClaim(claimId);
    if (!cur) return { ok: false, claimId, error: "claim vanished between create and read" };
    const decision = decideClaim(cur.data, now, self);
    if (decision === "sent") return { ok: true, state: "sent", claimId, owner: cur.data.owner, messageId: cur.data.messageId || undefined };
    if (decision === "held") return { ok: true, state: "held", claimId, owner: cur.data.owner };

    const took = await commitOne({
      update: { name: docName(claimId), fields: toFields(doc) },
      currentDocument: { updateTime: cur.updateTime },
    });
    if (took.ok) return { ok: true, state: "acquired", claimId, owner: self, takenOver: true };
    if (took.conflict) return { ok: true, state: "held", claimId, owner: null };   // someone else took it first
    return { ok: false, claimId, error: took.error };
  } catch (e) {
    return { ok: false, claimId, error: String(e?.message ?? e) };
  }
}

/** Mark the slot delivered. Best-effort: the caller's local record is primary. */
export async function completePostSlot(claimId, { messageId } = {}) {
  try {
    const r = await patchClaim(claimId, { state: "sent", messageId: messageId ? String(messageId) : null, at: Date.now() });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * Mark the slot failed. By default releases its lease (leaseUntil = now) —
 * see header. releaseLease:false keeps the lease: used when the post's outcome
 * is UNKNOWN (watchdog fired, upload may still land), so no other install
 * posts until the lease expires and its read-back can see a late arrival.
 */
export async function failPostSlot(claimId, { error, releaseLease = true } = {}) {
  try {
    const now = Date.now();
    const fields = { state: "failed", at: now, error: String(error ?? "").slice(0, 200) };
    if (releaseLease) fields.leaseUntil = now;
    const r = await patchClaim(claimId, fields);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
