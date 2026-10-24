// modules/safetyobs/lib/catchup_post.js
//
// "Post the morning catch-up at most once per store per day", pure: the
// shared claim, the channel read-back and the send are injected, so
// lib/tests/catchup_post.test.mjs drives this exact code with two fake
// browsers sharing one fake claim store and one fake channel.
//
// Before this, the only "already posted" record was each browser's own
// safetyobs.postedDay.v1, so two browsers with checkEnabled on both posted
// (and both @mentioned every coach). Reuses MetricShot's guard
// (metricshot/lib/post_guard.js) for the send → read-back → finish steps.
//
//   - Alarm runs take the shared claim (shared/post_claims.js) right before
//     sending — after the Field_Dashboard hold decision, so a held run never
//     consumes the slot.
//   - "held"/"sent" → skip; the caller records postedDay so this browser
//     stops retrying.
//   - Claim service unreachable → FAIL CLOSED: do not post, let the caller's
//     hold-retry alarm re-check. A catch-up that goes out at 9:30 instead of
//     9:00 is fine; two of them @mentioning every coach is the bug.
//   - Manual "Post now" skips the claim (a person is looking at the panel and
//     pressed the button) but still sends the marker.

import { guardedPost, finishGuardedRun, readBack } from "../../metricshot/lib/post_guard.js";

export const CLAIM_KIND = "safetyobs:catchup";

export function catchUpMarker(storeNbr, dateIso) {
  return `safetyobs:${storeNbr}:${dateIso}`;
}

/**
 * @param {object} a
 * @param {boolean} a.manual        trigger === "manual-post"
 * @param {object} a.claimSpec      { store, kind, slot, channel }
 * @param {string} a.channelName
 * @param {string} a.marker
 * @param {number} a.sinceTs        read-back window start (start of today)
 * @param {() => Promise<object>} a.send   postTextToWorkvivo(...) with the marker
 * @param {object} a.deps           { claimPostSlot, completePostSlot, failPostSlot, findPostedMarker }
 * @returns {Promise<{outcome:"sent"|"recovered"|"failed"|"skipped-claimed"|"claim-failed"|"readback-failed",
 *   posted:boolean, error?:string, state?:string, owner?:string|null, messageId?:string, post?:object, unknownOutcome?:boolean}>}
 */
export async function postCatchUpOnce({ manual, claimSpec, channelName, marker, sinceTs, send, deps }) {
  let claimId = null;
  if (!manual) {
    const c = await deps.claimPostSlot(claimSpec);
    if (!c || !c.ok) return { outcome: "claim-failed", posted: false, error: c?.error || "claim failed" };
    if (c.state === "held" || c.state === "sent") {
      return { outcome: "skipped-claimed", posted: false, state: c.state, owner: c.owner ?? null };
    }
    claimId = c.claimId;
    // Taken over from a dead lease (ours after a service-worker death, or a
    // browser whose send had an unknown outcome): it may already be in the
    // channel. Fail closed on an unreadable channel.
    if (c.takenOver) {
      const rb = await readBack({ channelName, marker, sinceTs, deps });
      if (rb.found) {
        await finishGuardedRun({ claimId, ok: true, messageId: rb.messageId, deps });
        return { outcome: "recovered", posted: true, messageId: rb.messageId };
      }
      if (rb.error) {
        await finishGuardedRun({ claimId, ok: false, error: rb.error, unknownOutcome: true, deps });
        return { outcome: "readback-failed", posted: false, error: rb.error };
      }
    }
  }
  const post = await guardedPost({ channelName, marker, sinceTs, send, deps });
  const ok = !!post?.ok;
  await finishGuardedRun({
    claimId, ok, messageId: post?.messageId, error: post?.error,
    unknownOutcome: !!post?.unknownOutcome, deps,
  });
  return {
    outcome: ok ? (post.recovered ? "recovered" : "sent") : "failed",
    posted: ok, post, messageId: post?.messageId,
    unknownOutcome: !!post?.unknownOutcome,
    error: ok ? undefined : `${post?.errorClass || ""} ${post?.error || ""}`.trim(),
  };
}
