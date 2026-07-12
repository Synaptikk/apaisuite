// modules/digitallocks/lib/riskScoring.js
//
// Risk-rule engine for digital lock events.
//
// IMPORTANT FRAMING: the score is a triage priority, not a verdict. Every
// score MUST carry the list of contributing rule names so a human reviewer
// can see why an event surfaced. Never present a score without its
// `riskReasons`. UI copy uses "needs review" / "unusual" / "high-risk
// event" — never "guilty", "bad actor", "theft", "malicious".
//
// Rules implemented (matches spec in module.js header + DIGITAL_LOCKS_MODULE.md):
//   1. AFTERHOURS_DEEP / AFTERHOURS_EDGE  — Event_time hour bands
//   2. ROLE_MISMATCH                       — Position vs. zone keywords
//   3. HIGH_RISK_ZONE                      — Lock/zone keyword hit
//   4. HIGH_VOLUME                         — User's per-day count > percentile + floor
//   5. DAY_HOUR_SPIKE                      — Store's per-hour count > mean+2σ
//   6. (repeat-pattern aggregation handled by computeUserAggregates)
//   7. UNUSUAL_SOURCE                      — Source not the dominant one in the import
//   8. MULTI_ZONE_WINDOW / REPEATED_SAME_LOCK — Per-user rapid-sequence flags
//
// All rules are pure functions of the import + config. scoreEvents mutates
// each row's riskScore / riskLevel / riskReasons in place AND returns the
// same array (for chaining).
//
// Episode dedup (groupIntoEpisodes) is a presentation concern, not a
// scoring one — events are still individually scored; episodes group runs
// of the same user + same zone within ~30 min so the daily checklist
// doesn't show 9 lines of the same incident.

import { canon, containsAny } from "./normalize.js";

// ── Public API ──────────────────────────────────────────────────────

/**
 * Score every event in `events` in place. `rules` shape:
 *   {
 *     weights:      from risk_weights.json::weights
 *     bands:        from risk_weights.json::bands       (ascending min)
 *     timeWindows:  from risk_weights.json::timeWindows
 *     thresholds:   from risk_weights.json::thresholds
 *     highRiskKeywords: array from high_risk_keywords.json::keywords
 *     roleZone:     from role_zone_rules.json (whole object)
 *   }
 * Returns: the same events array, plus diagnostic `_meta` with derived
 * thresholds (so the UI can show "p95 of per-user/day counts = 23" etc.).
 */
export function scoreEvents(events, rules) {
  const W = rules.weights;
  const T = rules.thresholds;
  const TW = rules.timeWindows;

  // Derived baselines (depend on the whole import, not one row).
  const meta = computeImportBaselines(events, T);

  // Per-user precomputation (volume, multi-zone-window, repeated same-lock).
  const userAggs = computeUserAggregates(events, T);

  for (const e of events) {
    const reasons = [];
    let score = 0;

    // Rule 1 — time of day. Skipped for unparseable timestamps.
    if (e.eventHour != null) {
      if (inHourRange(e.eventHour, TW.deepAfterHours)) {
        score += W.AFTERHOURS_DEEP;
        reasons.push(`after-hours 12am-5am (${formatHour(e.eventHour)})`);
      } else {
        for (const w of TW.edgeAfterHours || []) {
          if (inHourRange(e.eventHour, w)) {
            score += W.AFTERHOURS_EDGE;
            reasons.push(`edge after-hours ${formatHour(w.fromHour)}-${formatHour(w.toHour)} (${formatHour(e.eventHour)})`);
            break;
          }
        }
      }
    }

    // Rule 3 — high-risk zone / lock keywords.
    if (containsAny(`${e.zoneName} ${e.lockName}`, rules.highRiskKeywords)) {
      score += W.HIGH_RISK_ZONE;
      reasons.push("high-risk zone/lock");
    }

    // Rule 2 — role/zone mismatch. Skipped when role is in broadAccessPositions
    // or when no rule bucket matches the position at all (unknown role).
    const mm = roleZoneMismatch(e.position, e.zoneName, e.lockName, rules.roleZone);
    if (mm === true) {
      score += W.ROLE_MISMATCH;
      reasons.push(`role/zone mismatch (${e.position} → ${e.zoneName})`);
    }

    // Rule 4 — user volume outlier.
    const u = userAggs.byUser.get(e.userId);
    if (u) {
      const dayCount = u.byDay.get(e.eventDate) || 0;
      if (dayCount > meta.userDayP95 && dayCount >= T.volumeAbsoluteFloor) {
        score += W.HIGH_VOLUME;
        reasons.push(`high user volume (${dayCount}/day, p95=${meta.userDayP95})`);
      }
    }

    // Rule 8a — multi-zone window (>= N distinct zones in K minutes).
    if (e._multiZoneWindow) {
      score += W.MULTI_ZONE_WINDOW;
      reasons.push(`${e._multiZoneWindow} zones in ${T.multiZoneWindowMinutes}min`);
    }
    // Rule 8b — repeated same lock in short window.
    if (e._repeatedSameLock) {
      score += W.REPEATED_SAME_LOCK;
      reasons.push(`same lock repeated ${e._repeatedSameLock + 1}x within ${T.repeatedLockWindowMinutes}min`);
    }

    // Rule 7 — unusual unlock source (only if there IS a dominant source).
    if (e.unlockSource && meta.dominantSource && meta.dominantSourceShare > 0.9) {
      if (canon(e.unlockSource) !== canon(meta.dominantSource)) {
        score += W.UNUSUAL_SOURCE;
        reasons.push(`unusual unlock source: ${e.unlockSource}`);
      }
    }

    // Rule 5 — store hour spike.
    if (e.eventHour != null && meta.hourSpikeHours.has(e.eventHour)) {
      score += W.DAY_HOUR_SPIKE;
      reasons.push(`store hour spike (${formatHour(e.eventHour)})`);
    }

    e.riskScore = score;
    e.riskReasons = reasons;
    e.riskLevel = labelForScore(score, rules.bands);
  }

  // _meta is intentionally not persisted — it's recomputed on the fly so a
  // rules change immediately re-bins all events without a migration.
  events._meta = { ...meta, userP95: meta.userDayP95 };
  return events;
}

/**
 * Group successive events into "episodes" for the daily checklist view.
 * Two events join the same episode when they share (userId, zoneName) and
 * the gap between them is <= `windowMinutes`. Returns an array of
 * { userId, name, position, store, zoneName, startTime, endTime, eventCount,
 *   locks: string[], reasons: Set<string>, maxScore, events: row[] }
 *
 * Use this for the daily checklist export — NOT for the full event table
 * (analysts still want per-row visibility there).
 */
export function groupIntoEpisodes(events, { windowMinutes = 30 } = {}) {
  // Sort by user, zone, time. Then walk linearly.
  const sorted = [...events]
    .filter((e) => e.eventTime)
    .sort((a, b) => {
      if (a.userId !== b.userId) return a.userId < b.userId ? -1 : 1;
      if (a.zoneName !== b.zoneName) return a.zoneName < b.zoneName ? -1 : 1;
      return new Date(a.eventTime) - new Date(b.eventTime);
    });

  const out = [];
  let cur = null;
  const winMs = windowMinutes * 60_000;
  for (const e of sorted) {
    const t = new Date(e.eventTime).getTime();
    if (!cur || cur.userId !== e.userId || cur.zoneName !== e.zoneName || t - cur.endTimeMs > winMs) {
      if (cur) out.push(finalizeEpisode(cur));
      cur = {
        userId: e.userId,
        name: e.fullName,
        position: e.position,
        store: e.store,
        zoneName: e.zoneName,
        startTime: e.eventTime,
        endTime: e.eventTime,
        startTimeMs: t,
        endTimeMs: t,
        eventCount: 0,
        locks: new Set(),
        reasons: new Set(),
        maxScore: 0,
        events: [],
      };
    }
    cur.endTime = e.eventTime;
    cur.endTimeMs = t;
    cur.eventCount += 1;
    if (e.lockName) cur.locks.add(e.lockName);
    for (const r of e.riskReasons || []) cur.reasons.add(r.split(" (")[0]);
    if (e.riskScore > cur.maxScore) cur.maxScore = e.riskScore;
    cur.events.push(e);
  }
  if (cur) out.push(finalizeEpisode(cur));
  return out.sort((a, b) => b.maxScore - a.maxScore);
}

function finalizeEpisode(ep) {
  return {
    userId: ep.userId,
    name: ep.name,
    position: ep.position,
    store: ep.store,
    zoneName: ep.zoneName,
    startTime: ep.startTime,
    endTime: ep.endTime,
    eventCount: ep.eventCount,
    locks: [...ep.locks],
    reasons: [...ep.reasons],
    maxScore: ep.maxScore,
    events: ep.events,
  };
}

// ── Per-import baselines ────────────────────────────────────────────

function computeImportBaselines(events, T) {
  // Per-(user,day) count distribution → p95 floor for the volume rule.
  const userDayCounts = [];
  const userDayMap = new Map();
  for (const e of events) {
    if (!e.userId || !e.eventDate) continue;
    const k = `${e.userId}|${e.eventDate}`;
    userDayMap.set(k, (userDayMap.get(k) || 0) + 1);
  }
  for (const c of userDayMap.values()) userDayCounts.push(c);
  userDayCounts.sort((a, b) => a - b);
  const userDayP95 = percentile(userDayCounts, T.volumePercentile);

  // Store-wide hourly distribution → which hours are spikes (mean + 2σ).
  const hourCounts = new Array(24).fill(0);
  for (const e of events) if (e.eventHour != null) hourCounts[e.eventHour]++;
  const { mean, sd } = meanStd(hourCounts);
  const spikeThreshold = mean + T.hourSpikeStdDevs * sd;
  const hourSpikeHours = new Set();
  hourCounts.forEach((c, h) => { if (c > spikeThreshold) hourSpikeHours.add(h); });

  // Source dominance for the "unusual source" rule.
  const srcCounts = new Map();
  let totalWithSrc = 0;
  for (const e of events) {
    if (!e.unlockSource) continue;
    srcCounts.set(e.unlockSource, (srcCounts.get(e.unlockSource) || 0) + 1);
    totalWithSrc++;
  }
  const srcRanked = [...srcCounts.entries()].sort((a, b) => b[1] - a[1]);
  const dominantSource = srcRanked[0]?.[0] ?? null;
  const dominantSourceShare = srcRanked[0] ? srcRanked[0][1] / Math.max(1, totalWithSrc) : 0;

  return {
    userDayP95,
    hourSpikeHours,
    hourCounts,
    hourMean: mean,
    hourSd: sd,
    dominantSource,
    dominantSourceShare,
    sourceCounts: Object.fromEntries(srcCounts),
    eventCount: events.length,
  };
}

function computeUserAggregates(events, T) {
  const byUser = new Map();
  for (const e of events) {
    if (!e.userId) continue;
    let u = byUser.get(e.userId);
    if (!u) {
      u = { events: [], byDay: new Map(), zones: new Set(), locks: new Set() };
      byUser.set(e.userId, u);
    }
    u.events.push(e);
    if (e.eventDate) u.byDay.set(e.eventDate, (u.byDay.get(e.eventDate) || 0) + 1);
    if (e.zoneName)  u.zones.add(e.zoneName);
    if (e.lockName)  u.locks.add(e.lockName);
  }

  // Stamp each event with _multiZoneWindow / _repeatedSameLock by walking
  // each user's events in time order. O(n·k) where k is events per user
  // within the largest window — small in practice.
  for (const u of byUser.values()) {
    u.events.sort((a, b) => (new Date(a.eventTime) || 0) - (new Date(b.eventTime) || 0));
    const repWinMs = T.repeatedLockWindowMinutes * 60_000;
    const multiWinMs = T.multiZoneWindowMinutes * 60_000;

    for (let i = 0; i < u.events.length; i++) {
      const e = u.events[i];
      const t = e.eventTime ? new Date(e.eventTime).getTime() : null;
      if (t == null) continue;

      // Same lock repeated in window
      for (let j = i + 1; j < u.events.length; j++) {
        const f = u.events[j];
        const tf = f.eventTime ? new Date(f.eventTime).getTime() : null;
        if (tf == null) continue;
        if (tf - t > repWinMs) break;
        if (e.lockName && e.lockName === f.lockName) {
          e._repeatedSameLock = (e._repeatedSameLock || 0) + 1;
          f._repeatedSameLock = (f._repeatedSameLock || 0) + 1;
        }
      }
      // N+ distinct zones in window
      const zs = new Set();
      for (let j = i; j < u.events.length; j++) {
        const f = u.events[j];
        const tf = f.eventTime ? new Date(f.eventTime).getTime() : null;
        if (tf == null) continue;
        if (tf - t > multiWinMs) break;
        if (f.zoneName) zs.add(f.zoneName);
      }
      if (zs.size >= T.multiZoneCountThreshold) e._multiZoneWindow = zs.size;
    }
  }
  return { byUser };
}

// ── Rule 2: role/zone mismatch ──────────────────────────────────────

function roleZoneMismatch(position, zoneName, lockName, roleZone) {
  const p = canon(position);
  if (!p) return null;

  // Broad-access roles: skip the rule (treat as not-mismatch).
  for (const r of roleZone.broadAccessPositions || []) {
    if (p.includes(canon(r))) return false;
  }

  // First substring match wins. Configurable via roleZoneMap.
  for (const entry of roleZone.roleZoneMap || []) {
    if (p.includes(canon(entry.position))) {
      const allowed = entry.allowedZoneKeywords || [];
      if (allowed.length === 0) return false;
      return !containsAny(`${zoneName} ${lockName}`, allowed);
    }
  }
  // Unknown role → cannot judge, do not flag.
  return null;
}

// ── Tiny stats helpers ──────────────────────────────────────────────

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.floor(sortedArr.length * p));
  return sortedArr[idx];
}

function meanStd(arr) {
  if (arr.length === 0) return { mean: 0, sd: 0 };
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
  return { mean, sd: Math.sqrt(variance) };
}

// Inclusive lower, exclusive upper (so [0,5) means 0..4 -- "12am to 5am").
function inHourRange(hour, range) {
  if (!range) return false;
  return hour >= range.fromHour && hour < range.toHour;
}

function formatHour(h) {
  if (h == null) return "?";
  if (h === 0) return "12am";
  if (h === 12) return "12pm";
  if (h === 24) return "12am";
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

function labelForScore(score, bands) {
  // bands are sorted ascending by min; pick the largest min ≤ score.
  let label = bands[0]?.label || "Normal";
  for (const b of bands) {
    if (score >= b.min) label = b.label;
  }
  return label;
}

// ── Risk-level styling hints (used by the UI; kept here so any future
// consumer — e.g. PDF export — doesn't reinvent the mapping). ────────
export const RISK_LEVEL_TO_BADGE_CLASS = {
  Normal:   "dl-risk-normal",
  Watch:    "dl-risk-watch",
  High:     "dl-risk-high",
  Critical: "dl-risk-critical",
};
