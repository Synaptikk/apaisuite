// modules/digitaldashboard/lib/store_roster.js
//
// The day's picking roster for store 1458, accumulated over time so no single
// read has to drill every associate. Pure: no chrome.*, no node:*, runs under
// node --test. The daemon holds the state; the SW adds the digital/store-help
// coding (classifications live in Digital Metrics, browser-only).
//
// Why accumulate (the user's design, 2026-10-03):
//   - GIF shows a pick COUNT only one associate at a time; there is no bulk
//     count. The "All" list (every associate active today) and its sub-lists
//     (Picking / Backroom / Not active) are, by contrast, one cheap read.
//   - A pick count only changes while that associate is ACTIVELY picking. Once
//     they are inactive it is frozen. So after a confirming read it is "settled"
//     and never re-read — unless they go active again.
//
// Each tick: read the All list (cheap) to refresh everyone's status, then drill
// details for only the few who still need a count (active, newly seen, or just
// reactivated). Over the day the whole table fills in for a handful of reads a
// tick instead of 80+ at once.

// A pick count only moves while the associate is actively PICKING — backroom,
// dispensing and not-active all leave it frozen, so only "picking" counts as
// active-for-recheck. Anyone who resumes picking is caught by the
// inactive→active reactivation in mergeSnapshot.
export const ACTIVE = new Set(["picking"]);
const isActive = (s) => ACTIVE.has(s);

// Confirming reads before an inactive associate is settled. Two (the user's
// rule): the first captures the stopped count, the second confirms it did not
// move — belt and suspenders against a status that lags the last scan.
export const SETTLE_AFTER_INACTIVE_CHECKS = 2;

export function emptyRoster(day) { return { day, associates: {} }; }

/** The board day ("YYYY-MM-DD", 5 AM boundary) — kept in sync with gif_metrics. */
export function rosterDay(boardDayStr) { return boardDayStr; }

/**
 * Fold one All-list snapshot into the roster. Returns a NEW roster.
 *
 * @param prev      previous roster (or null)
 * @param snapshot  { day, seen: [{name, status}] } — status is "picking" |
 *                  "backroom" | "notactive"; names present in All but in none
 *                  of those are "offclock".
 * @param now       ms
 *
 * Status transitions drive the check logic: inactive→active clears `settled`
 * (their count will move again); a name that drops off the All list entirely is
 * marked offclock but keeps its last count and settled state.
 */
export function mergeSnapshot(prev, snapshot, now = Date.now()) {
  const day = snapshot?.day;
  const base = prev && prev.day === day ? prev : emptyRoster(day);
  const associates = {};
  const seenNames = new Set();

  for (const { name, status } of snapshot?.seen || []) {
    if (!name) continue;
    seenNames.add(name);
    const old = base.associates[name];
    const reactivated = old && !isActive(old.status) && isActive(status);
    associates[name] = {
      name,
      status,
      picks: old?.picks ?? null,
      checkedAt: old?.checkedAt ?? null,
      firstSeen: old?.firstSeen ?? now,
      lastSeen: now,
      inactiveChecks: reactivated ? 0 : (old?.inactiveChecks ?? 0),
      // A reactivated associate is no longer settled — their count moves again.
      settled: reactivated ? false : (old?.settled ?? false),
    };
  }
  // Names in the roster but no longer in the All list: off the clock now. Keep
  // their count + settled flag (it will not change while they are gone).
  for (const [name, rec] of Object.entries(base.associates)) {
    if (seenNames.has(name)) continue;
    associates[name] = { ...rec, status: "offclock", lastSeen: rec.lastSeen };
  }
  return { day, associates };
}

/**
 * Who still needs a detail read this tick, most-worth-it first, capped at
 * `budget`. A name needs a read when:
 *   - it is active (count is moving) and its last read is older than
 *     `activeMinGapMs`, or
 *   - it is not settled yet (we have no final count): never read, or read while
 *     active and now inactive (needs the confirming reads).
 * Priority: just-stopped (active last read, now inactive) > active, stalest
 * first > never-read inactive.
 */
export function needsCheck(roster, { now = Date.now(), budget = 5, activeMinGapMs = 90_000 } = {}) {
  const recs = Object.values(roster?.associates || {});
  const want = [];
  for (const r of recs) {
    if (r.settled) continue;
    const age = r.checkedAt == null ? Infinity : now - r.checkedAt;
    if (isActive(r.status)) {
      if (age >= activeMinGapMs) want.push({ r, prio: 1, age });
    } else {
      // inactive and not settled — needs the confirming read(s)
      want.push({ r, prio: r.checkedAt == null ? 2 : 0, age });
    }
  }
  // prio 0 = just-stopped/confirming (most urgent — capture the final count),
  // then 1 = active, then 2 = never-seen inactive. Within a tier, stalest first.
  want.sort((a, b) => a.prio - b.prio || b.age - a.age);
  return want.slice(0, budget).map((w) => w.r.name);
}

/**
 * Fold detail reads back in. `details` is { name: { picks } | { error } }.
 * Settles an inactive associate once it has been confirmed
 * SETTLE_AFTER_INACTIVE_CHECKS times; clears the counter while active.
 */
export function applyDetails(roster, details, now = Date.now()) {
  const associates = { ...roster.associates };
  for (const [name, d] of Object.entries(details || {})) {
    const rec = associates[name];
    if (!rec || !d || d.error != null) continue;
    const picks = Number.isFinite(d.picks) ? d.picks : rec.picks;
    const active = isActive(rec.status);
    const inactiveChecks = active ? 0 : (rec.inactiveChecks ?? 0) + 1;
    associates[name] = {
      ...rec,
      picks,
      checkedAt: now,
      inactiveChecks,
      settled: !active && inactiveChecks >= SETTLE_AFTER_INACTIVE_CHECKS,
    };
  }
  return { ...roster, associates };
}

/** Rows for display/commands, newest-count first. `code(name)` → classification string. */
export function rosterRows(roster, code = () => null) {
  return Object.values(roster?.associates || {})
    .map((r) => ({
      name: r.name,
      code: code(r.name),
      status: r.status,
      picks: r.picks,
      settled: r.settled,
      checkedAt: r.checkedAt,
      stale: r.checkedAt == null,
    }))
    .sort((a, b) => (b.picks ?? -1) - (a.picks ?? -1) || a.name.localeCompare(b.name));
}

/**
 * Totals. `isDigital(name)` decides the split. storeTotal (GIF's live day
 * figure) is optional; when given, digital picks are inferred as
 * storeTotal − storeHelp so we never need every digital associate's count.
 */
export function rosterTotals(roster, isDigital = () => true, storeTotal = null) {
  const rows = Object.values(roster?.associates || {});
  let help = 0, helpKnown = 0, helpCount = 0, counted = 0, pending = 0;
  for (const r of rows) {
    const digital = isDigital(r.name);
    if (!digital) {
      helpCount++;
      if (Number.isFinite(r.picks)) { help += r.picks; helpKnown++; } else pending++;
    }
    if (Number.isFinite(r.picks)) counted += r.picks;
  }
  return {
    associates: rows.length,
    storeHelpAssociates: helpCount,
    storeHelpPicks: help,
    storeHelpPending: pending,          // store-help still awaiting a first count
    countedPicks: counted,              // sum of every known count (diagnostic)
    storeTotal,                         // GIF's live day total, if provided
    digitalPicks: storeTotal != null && helpKnown === helpCount ? Math.max(0, storeTotal - help) : null,
  };
}
