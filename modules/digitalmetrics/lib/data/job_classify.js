// modules/digitalmetrics/lib/data/job_classify.js
//
// Derive an associate's classification from the job title the scheduler
// already knows, instead of asking someone to tick boxes on the Classify tab.
//
// The rule, as stated by the analyst 2026-08-25:
//
//   "anyone with picks not digital will be store help"
//
// So: the scheduler's jobName decides Digital, and everyone else who actually
// picked is Store Help. The Classify tab becomes a correction surface rather
// than the primary input.
//
// ── Why "has picks" is part of the rule ────────────────────────────────────
// Store 1458's roster is ~440 people and only ~150 appear in the fulfilment
// data. Classifying the whole roster as Store Help would bury the digital team
// in noise on every count, chart and benchmark. A classification is only
// meaningful for someone who shows up in the metrics.
//
// ── Why one category is NOT derived ────────────────────────────────────────
// `Exceptions` is behavioural, not a job: a digital associate who mostly works
// exception picks still has a Digital title. It is therefore PRESERVED when
// already set by hand, and never invented here.
//
// `Fashion` was retired 2026-08-25 — apparel pickers fall out as Store Help
// under the rule above, which is the intent. See data/classify.js.

import { CLASSIFICATIONS } from "./classify.js";

/** Job titles that mean the dedicated digital fulfilment team. */
export const DIGITAL_JOB_RE = /\bdigital\b/i;

/** Classifications a human set that a job title must not overwrite. */
export const MANUAL_ONLY = ["Exceptions"];

/**
 * Classification implied by a scheduler job title, or null when it implies
 * nothing (no title at all).
 *
 * Examples seen on the real roster:
 *   "Digital Personal Shopper 1-936-1451" → Digital
 *   "Fashion TL 1-625-7200"               → Store Help  (see note above)
 *   "Stocking ON TA 1-635-7440"           → Store Help
 */
export function classificationForJob(jobName) {
  const s = String(jobName ?? "").trim();
  if (!s) return null;
  return DIGITAL_JOB_RE.test(s) ? "Digital" : "Store Help";
}

/**
 * Build the name → classification map an automated pull should persist.
 *
 * @param scheduled  [{ name, jobName }]   from the scheduler pull
 * @param opts.existing  current name → classification (manual work to respect)
 * @param opts.pickers   Set/array of names that appear in the metrics data.
 *                       Required for the Store Help half of the rule; Digital
 *                       is assigned from the title alone, because a scheduled
 *                       digital associate is digital whether or not they
 *                       picked that week.
 *
 * Returns the FULL map (existing merged with derivations) so the caller can
 * hand it straight to the classifications writer, plus a summary of what
 * changed — silent reclassification of a roster is not something to do
 * without being able to say what happened.
 */
export function deriveClassifications(scheduled, { existing = {}, pickers = [] } = {}) {
  const pickerSet = new Set([...(pickers || [])].map((n) => String(n).trim().toUpperCase()));
  const map = { ...existing };
  const changes = [];
  let skippedManual = 0;

  // One title per person: the roster lists a job per shift, and someone who
  // covered a non-digital shift once is not thereby store help. Digital wins
  // if it appears anywhere in their week.
  const titleByName = new Map();
  for (const a of scheduled || []) {
    const name = String(a?.name ?? "").trim();
    if (!name) continue;
    const job = a?.jobName ?? null;
    if (!job) continue;
    const key = name.toUpperCase();
    const prev = titleByName.get(key);
    if (!prev || (DIGITAL_JOB_RE.test(job) && !DIGITAL_JOB_RE.test(prev))) {
      titleByName.set(key, job);
    }
  }

  for (const [key, job] of titleByName) {
    const derived = classificationForJob(job);
    if (!derived) continue;

    // Store Help only applies to people who actually appear in the metrics.
    if (derived === "Store Help" && !pickerSet.has(key)) continue;

    const current = map[key];
    if (current && MANUAL_ONLY.includes(current)) { skippedManual++; continue; }
    if (current === derived) continue;

    map[key] = derived;
    changes.push({ name: key, from: current || null, to: derived });
  }

  return {
    map,
    changes,
    skippedManual,
    derivedFrom: titleByName.size,
    // Anyone in the metrics we could not place — they were not on the
    // schedule, so no title exists. These are the rows the Classify tab is
    // still for.
    unresolved: [...pickerSet].filter((n) => !titleByName.has(n) && !map[n]),
  };
}

/** Guard: never write a classification the rest of the module does not know. */
export function isValidClassification(c) {
  return CLASSIFICATIONS.includes(c);
}
