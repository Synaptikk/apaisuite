// modules/digitalschedule/lib/fitclean.js
//
// Fit to guidance (suggest) plus optional extra hours (addHours), checked with
// the scheduler's validator BEFORE anything reaches the queue. The manager
// asked (2026-10-21) that a HARD never shows up in the queued changes.
//
// Polaris reports violations per associate, not per change, and some rules
// can't be seen from the page (school times are per minor and not exposed).
// So: validate the whole proposal; anyone with a HARD, or with a change the
// page couldn't build, is locked (left exactly as saved) and the fit runs
// again so other people cover what they would have. A few rounds settle it;
// whatever is still flagged after the last round is dropped, never queued.
//
// Associates whose SAVED schedule already breaks a HARD rule are locked from
// the first round: changing them can't be submitted cleanly either way.

import { suggest } from "./suggest.js";
import { addHours } from "./addhours.js";
import { applyChanges } from "./coverage.js";

const MAX_ROUNDS = 4;

/**
 * @param {object} data        the loaded week
 * @param {object} fitOpts     suggest() options (rules, roleId, jobs, …)
 * @param {object|null} extra  addHours() options without roleId/jobs/rules, or null for fit only
 * @param {(changes: object[]) => Promise<object>} validate  page.js validate result for a list
 * @param {(text: string) => void} [progress]
 * @returns {Promise<{ out, add, changes, check, held: Array<{ workerId, name, why }>, rounds, error? }>}
 */
export async function fitClean(data, fitOpts, extra, validate, progress = () => {}) {
  const lock = new Set((fitOpts.lock || []).map(String));
  const held = new Map();   // workerId → { name, why }
  const hold = (id, name, why) => { const k = String(id); lock.add(k); if (!held.has(k)) held.set(k, { workerId: id, name, why }); };
  let out = null, add = null, changes = [], check = null, rounds = 0;

  for (rounds = 1; rounds <= MAX_ROUNDS; rounds++) {
    out = suggest(data, { ...fitOpts, lock: [...lock] });
    add = extra ? addHours(applyChanges(data, out.changes).data, { ...extra, rules: fitOpts.rules, lock: [...lock] }) : null;
    changes = [...out.changes, ...(add?.changes || [])];
    if (!changes.length) return { out, add, changes, check: null, held: [...held.values()], rounds };
    progress(`Checking ${changes.length} change(s) with the scheduler${rounds > 1 ? ` (round ${rounds})` : ""}…`);
    check = await validate(changes);
    if (!check || check.error) return { out, add, changes, check, held: [...held.values()], rounds, error: check?.error || "validator call failed" };

    const bad = new Map();
    for (const h of check.hard || []) bad.set(String(h.workerId), { name: h.name, why: `${h.code} ${h.message}` });
    for (const s of check.skipped || []) { const ch = changes[s.idx]; if (ch?.workerId != null && !bad.has(String(ch.workerId))) bad.set(String(ch.workerId), { name: ch.name, why: s.why }); }
    for (const h of check.preexistingHard || []) if (!bad.has(String(h.workerId))) bad.set(String(h.workerId), { name: h.name, why: `already on the saved schedule: ${h.code} ${h.message}` });
    if (!bad.size) return { out, add, changes, check, held: [...held.values()], rounds };
    for (const [id, b] of bad) hold(id, b.name, b.why);
  }

  // Still flagged after the last round: drop those people's changes rather than queue them.
  rounds = MAX_ROUNDS;
  changes = changes.filter((ch) => !lock.has(String(ch.workerId)));
  check = changes.length ? await validate(changes) : null;
  return { out, add, changes, check, held: [...held.values()], rounds, leftover: !!(check?.hard?.length || check?.skipped?.length) };
}
