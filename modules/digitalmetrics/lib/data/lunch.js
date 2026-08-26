// modules/digitalmetrics/lib/data/lunch.js
//
// Lunch compliance for the assignment grid, and the shift-bounds rule. Pure.
//
// ── Where the numbers come from ────────────────────────────────────────────
// Recovered from the standalone web app's own suggestion engine
// (digitalmetrics-fe0f3.web.app, read 2026-08-26):
//
//     // Skip lunch suggestions for shifts 6 hours or less
//     if (task === 'L' && shiftDuration <= 6) return;
//     // Skip lunch in first 2 or last 2 hours of shift
//     if (task === 'L' && (slot < shiftStart + 2 || slot >= shiftEnd - 2)) return;
//
// So the policy the app already encoded is: a shift LONGER than 6 hours gets a
// lunch, and it belongs between shiftStart+2 and shiftEnd-2. Those same two
// numbers drive the warning here, rather than a fresh guess — a threshold that
// disagreed with the suggestion engine would flag the very cells the app had
// just proposed.
//
// The app also exempts Digital TLs by name (`name.includes('DIGITAL TL')`).
// That is not reproduced: the port knows job titles properly now
// (data/job_classify.js), and matching on a person's name is exactly the kind
// of rule that breaks when someone's title changes.

/** A shift must be LONGER than this many slots to require a lunch. */
export const LUNCH_REQUIRED_AFTER_HOURS = 6;

/** Lunch may not fall within this many slots of either end of the shift. */
export const LUNCH_EDGE_MARGIN = 2;

const LUNCH = "L";

/** Slots an associate is actually scheduled for, as [start, end). */
export function shiftBounds(assoc) {
  const start = typeof assoc?.shiftStart === "number" ? assoc.shiftStart : null;
  const end   = typeof assoc?.shiftEnd   === "number" ? assoc.shiftEnd   : null;
  if (start === null || end === null || end <= start) return null;
  return { start, end, hours: end - start };
}

/**
 * Is this slot inside the associate's shift?
 *
 * An associate with no shift window on the row (added by hand, or a schedule
 * that never imported) is unconstrained — refusing every cell would make them
 * unassignable, which is worse than allowing the edit.
 */
export function isWithinShift(assoc, slot) {
  const b = shiftBounds(assoc);
  if (!b) return true;
  const s = Number(slot);
  return Number.isFinite(s) && s >= b.start && s < b.end;
}

/** The window a lunch may legally sit in, or null if none is required. */
export function lunchWindow(assoc) {
  const b = shiftBounds(assoc);
  if (!b || b.hours <= LUNCH_REQUIRED_AFTER_HOURS) return null;
  const from = b.start + LUNCH_EDGE_MARGIN;
  const to   = b.end   - LUNCH_EDGE_MARGIN;      // exclusive
  return to > from ? { from, to } : null;
}

/** Slots where this associate currently has a lunch. */
export function lunchSlots(assoc) {
  return Object.entries(assoc?.slots || {})
    .filter(([, task]) => String(task).toUpperCase() === LUNCH)
    .map(([slot]) => Number(slot))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
}

/**
 * Lunch problems for one associate, or null when there is nothing to say.
 *
 * Three distinct states, because their fixes differ:
 *   missing   — a shift over 6h with no lunch at all
 *   edge      — a lunch too close to the start or end of the shift
 *   duplicate — more than one lunch on the day
 */
export function lunchIssue(assoc) {
  const window = lunchWindow(assoc);
  const slots = lunchSlots(assoc);

  if (!window) {
    // A short shift does not need one, but if a lunch was entered anyway that
    // is the user's call — not something to nag about.
    return null;
  }

  if (!slots.length) {
    const b = shiftBounds(assoc);
    return { kind: "missing", window,
             message: `${b.hours}h shift has no lunch` };
  }
  if (slots.length > 1) {
    return { kind: "duplicate", window, slots,
             message: `${slots.length} lunches assigned` };
  }

  const at = slots[0];
  if (at < window.from || at >= window.to) {
    return { kind: "edge", window, slots,
             message: "lunch is too close to the start or end of the shift" };
  }
  return null;
}

/** Every associate with a lunch problem. */
export function lunchIssues(assignments) {
  const out = [];
  for (const a of assignments || []) {
    const issue = lunchIssue(a);
    if (issue) out.push({ name: a.name, ...issue });
  }
  return out;
}

/** One-line summary for the warning banner, or null when the day is clean. */
export function lunchSummary(assignments) {
  const issues = lunchIssues(assignments);
  if (!issues.length) return null;

  const by = (kind) => issues.filter((i) => i.kind === kind).length;
  const parts = [];
  if (by("missing"))   parts.push(`${by("missing")} without a lunch`);
  if (by("edge"))      parts.push(`${by("edge")} with a lunch at the edge of the shift`);
  if (by("duplicate")) parts.push(`${by("duplicate")} with more than one lunch`);

  return { count: issues.length, issues, text: parts.join(", ") };
}
