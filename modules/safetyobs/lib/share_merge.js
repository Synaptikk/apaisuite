// modules/safetyobs/lib/share_merge.js
//
// shareToday's compare-and-set loop, pure so lib/tests/share_merge.test.mjs
// can run two interleaved writers against a fake store that enforces
// updateTime.
//
// Why: stores/{store}/safetyObs/{date} is ONE document holding every
// browser's entries for the day. The old shareToday read it, appended, and
// wrote the whole thing back unconditionally — two browsers sharing in the
// same minute each wrote "theirs + what I read", and the later write erased
// the earlier one's entries. The catch-up then under-counted that coach and
// @mentioned them for observations they had done.
//
// Now: read (with updateTime) → merge by entry id → write with an updateTime
// precondition (exists:false when the read found no doc) → on a lost
// precondition re-read and merge again.

export const MAX_SHARE_ATTEMPTS = 5;

/**
 * Merge this browser's pending submissions into the day's shared entries.
 * Entry id = the submitting browser's history stamp (String(h.at)), so a
 * re-sync never double counts. Existing entries are kept verbatim.
 * @param {Array} existing   entries already in the shared doc
 * @param {Array} pending    this browser's history items ({ at, answers, submitter })
 * @param {string} me        display name to credit when an item has no submitter
 * @returns {{ entries: Array, added: number }}
 */
export function mergeShareEntries(existing, pending, me) {
  const entries = [...(existing || [])];
  const have = new Set(entries.map((e) => String(e.id)));
  let added = 0;
  for (const h of pending || []) {
    const id = String(h.at);
    if (have.has(id)) continue;
    have.add(id);
    entries.push({ id, at: h.at, type: h.answers?.type || null, name: h.submitter || me });
    added++;
  }
  return { entries, added };
}

/**
 * Compare-and-set share.
 * @param {object} a
 * @param {() => Promise<{doc:object|null, updateTime:string|null}>} a.read
 * @param {(doc:object, ifUpdateTime:string|null) => Promise<{ok:boolean, conflict?:boolean, error?:string}>} a.write
 *   ifUpdateTime null = "only if the doc still does not exist".
 * @param {Array} a.pending
 * @param {string} a.me
 * @param {string} a.store
 * @returns {Promise<{ok:true, written:boolean, attempts:number} | {ok:false, error:string, conflict?:boolean, attempts:number}>}
 */
export async function casShareEntries({ read, write, pending, me, store, maxAttempts = MAX_SHARE_ATTEMPTS }) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { doc, updateTime } = await read();
    const { entries, added } = mergeShareEntries(doc?.entries, pending, me);
    if (!added) return { ok: true, written: false, attempts: attempt };   // all already there
    const w = await write({ entries, store }, updateTime ?? null);
    if (w?.ok) return { ok: true, written: true, attempts: attempt };
    if (!w?.conflict) return { ok: false, error: w?.error || "Firestore write failed", attempts: attempt };
    // Someone else wrote between our read and write: re-read and merge again.
  }
  return { ok: false, conflict: true, error: `safetyObs share kept conflicting (${maxAttempts} attempts)`, attempts: maxAttempts };
}
