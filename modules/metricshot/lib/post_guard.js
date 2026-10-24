// modules/metricshot/lib/post_guard.js
//
// The "post at most once per slot" protocol around a Workvivo send. Pure: every
// side effect (local postedRuns write, shared claim, channel read-back, the
// send itself) is injected, so lib/tests/two_client.test.mjs drives this exact
// code with two fake installs sharing one fake claim store and one fake
// channel.
//
// Order, and why:
//   1. Local postedRuns[runKey] = "sending" FIRST. If the worker dies anywhere
//      after this, the next tick sees "sending" and resumes with a read-back
//      instead of treating the slot as never-run (the old send-then-record gap).
//   2. Shared claim (shared/post_claims.js) — one install per store/slot/channel.
//      Skipped for self-DM destinations ("@me" etc.): every user's self-DM is
//      a different channel, so two installs can never duplicate into it.
//   3. Read-back before re-sending when the previous attempt's outcome is
//      unknown (resumed "sending", claim taken over, or an ambiguous failure).
//   4. Send with a marker; on an ambiguous failure (watchdog, 5xx, threw),
//      read back before calling it a failure.
//   5. Complete / fail the claim. A failure with an UNKNOWN outcome keeps its
//      lease, so nobody else posts until the lease runs out — by then a late
//      upload is visible to their read-back.

import { sendingEntry, postOutcomeUnknown } from "./retry_policy.js";

const SELF_CHANNELS = new Set(["@me", "@self", "(me)"]);

export function isSelfChannel(name) {
  return SELF_CHANNELS.has(String(name || "").trim().toLowerCase());
}

/** The claim slot half of a runKey: "metricId:YYYY-MM-DD:HH:MM" → "YYYY-MM-DD:HH:MM". */
export function slotOf(metricId, runKey) {
  const p = `${metricId}:`;
  return String(runKey).startsWith(p) ? String(runKey).slice(p.length) : String(runKey);
}

/** The run marker posted with (and searched for in) the channel. Same on
 *  every install for the same slot, so one install can find another's post. */
export function markerFor(runKey, store) {
  return `${runKey}|${store || "-"}`;
}

/**
 * Steps 1–2.
 * @param {object} a
 * @param {string} a.runKey
 * @param {object|undefined} a.prior   postedRuns[runKey] before this run
 * @param {object|null} a.claimSpec    { store, kind, slot, channel, leaseMs } or null (no shared claim)
 * @param {string|null} a.claimId      claimIdFor(claimSpec), precomputed so step 1 can record it
 * @param {number} a.now
 * @param {{markLocal:Function, claimPostSlot:Function}} a.deps
 * @returns {Promise<{proceed:true, claimId:string|null, needReadBack:boolean}
 *   | {proceed:false, outcome:"skipped-claimed", owner:string|null, state:string}
 *   | {proceed:false, outcome:"claim-failed", error:string}>}
 */
export async function beginGuardedRun({ runKey, prior, claimSpec, claimId = null, now, deps }) {
  const resumed = !!prior && (prior.status === "sending" || prior.unknownOutcome === true);
  await deps.markLocal(runKey, sendingEntry(prior, now, claimSpec ? claimId : null));
  if (!claimSpec) return { proceed: true, claimId: null, needReadBack: resumed };

  const c = await deps.claimPostSlot(claimSpec);
  if (!c || !c.ok) return { proceed: false, outcome: "claim-failed", error: c?.error || "claim failed" };
  if (c.state === "held" || c.state === "sent") {
    await deps.markLocal(runKey, { status: "skipped-claimed", at: now, owner: c.owner ?? null, claimState: c.state, claimId: c.claimId });
    return { proceed: false, outcome: "skipped-claimed", owner: c.owner ?? null, state: c.state };
  }
  return { proceed: true, claimId: c.claimId, needReadBack: resumed || !!c.takenOver };
}

/**
 * Step 3: is the run already in the channel? Fail closed — an unreadable
 * channel is NOT "not posted".
 * @returns {Promise<{found:boolean, messageId?:string, error?:string}>}
 */
export async function readBack({ channelName, marker, sinceTs, deps }) {
  const f = await deps.findPostedMarker({ channelName, marker, sinceTs, reuseOnly: false });
  if (!f || !f.ok) return { found: false, error: `read-back failed: ${f?.error || f?.errorClass || "no result"}` };
  return f.found ? { found: true, messageId: f.messageId } : { found: false };
}

/**
 * Step 4: send once; on an ambiguous failure, read back before believing it.
 * @returns {Promise<object>} the post result, possibly rewritten to ok
 *   (recovered:true) or flagged unknownOutcome:true.
 */
export async function guardedPost({ channelName, marker, sinceTs, send, deps }) {
  const post = await send();
  if (post && post.ok) return post;
  if (!marker || !postOutcomeUnknown(post)) return post;
  const rb = await readBack({ channelName, marker, sinceTs, deps });
  if (rb.found) return { ...post, ok: true, recovered: true, messageId: rb.messageId, error: undefined };
  return { ...post, unknownOutcome: true, readBack: rb.error ? "failed" : "not-found" };
}

/** Step 5. Best-effort: the local record is primary. */
export async function finishGuardedRun({ claimId, ok, messageId, error, unknownOutcome = false, deps }) {
  if (!claimId) return;
  try {
    if (ok) await deps.completePostSlot(claimId, { messageId });
    else await deps.failPostSlot(claimId, { error, releaseLease: !unknownOutcome });
  } catch { /* the lease expires on its own */ }
}
