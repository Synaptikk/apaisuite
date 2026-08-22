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
//      1b. edge bands drop to AFTERHOURS_EDGE_EXPECTED only when the
//          Position is in roleZone.expectedEdgeHourPositions (normally on
//          shift across shift change) AND rule 2 says the event is in that
//          role's own area. On shift + wrong zone keeps full weight, on
//          top of ROLE_MISMATCH. Deep band is never discounted.
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
  const CAL = rules.calibration ?? {};
  const calibrating = CAL.enabled !== false;

  // Derived baselines (depend on the whole import, not one row).
  const meta = computeImportBaselines(events, T);

  // Per-user precomputation (volume, multi-zone-window, repeated same-lock).
  const userAggs = computeUserAggregates(events, T);

  // Per-user "normal": median day volume and the hours they actually work.
  // This is what turns "opened a case at 6am" into "opened a case at 6am,
  // which is when they always work" — see userNormals().
  const normals = calibrating
    ? userNormals(userAggs, CAL.userBaseline ?? {})
    : new Map();

  // (position → zone) pairings the store demonstrably runs on.
  const pairings = calibrating
    ? observedRolePairings(events, CAL.observedRolePairing ?? {})
    : new Set();

  // ── Pass 1: decide which rules fire, without scoring anything ──────
  //
  // Weights cannot be applied until every rule's fire-rate across the whole
  // import is known: a rule that fires on nearly every row is describing the
  // store, not the event, and must not contribute. That is only knowable
  // after all rows have been evaluated, hence two passes.
  const hits = events.map((e) => evaluateRules(e, {
    W, T, TW, rules, meta, userAggs, normals, pairings, calibrating,
  }));

  const fireRate = computeFireRates(hits, events.length);
  const weightScale = calibrating
    ? baseRateScales(fireRate, events.length, CAL)
    : new Map();

  // ── Pass 2: apply scaled weights ──────────────────────────────────
  events.forEach((e, i) => {
    const reasons  = [];   // scored — why this event is above the line
    const baseline = [];   // fired but suppressed — context, not signal
    let score = 0;

    for (const hit of hits[i]) {
      const scale = weightScale.has(hit.rule) ? weightScale.get(hit.rule) : 1;
      const points = Math.round((W[hit.rule] ?? 0) * hit.weightFactor * scale);
      if (points > 0) {
        score += points;
        reasons.push(hit.reason);
      } else {
        baseline.push(hit.reason);
      }
    }

    e.riskScore = score;
    e.riskReasons = reasons;
    // Kept separate so the UI can show them muted. Merging them into
    // riskReasons is what made "high-risk zone/lock" look like a finding on
    // all 500 rows of a single-zone store.
    e.baselineReasons = baseline;
    e.riskLevel = labelForScore(score, rules.bands);
  });

  // _meta is intentionally not persisted — it's recomputed on the fly so a
  // rules change immediately re-bins all events without a migration.
  events._meta = {
    ...meta,
    userP95: meta.userDayP95,
    calibrated: calibrating,
    fireRate: Object.fromEntries(fireRate),
    weightScale: Object.fromEntries(weightScale),
    observedPairings: [...pairings],
  };
  return events;
}

/**
 * Evaluate every rule for one event. Returns `[{ rule, reason, weightFactor }]`
 * — NO scores. `weightFactor` is the rule's own discount (e.g. an edge-hours
 * event that matches the associate's usual shift), applied before the
 * import-wide base-rate scale.
 */
function evaluateRules(e, ctx) {
  const { W, T, TW, rules, meta, userAggs, normals, pairings, calibrating } = ctx;
  const out = [];
  const norm = normals.get(e.userId) ?? null;

  // Role/zone verdict is computed FIRST because the time rule depends on it.
  // true = mismatch, false = positively in-zone, null = position not in
  // roleZoneMap, so we cannot judge either way.
  let mm = roleZoneMismatch(e.position, e.zoneName, e.lockName, rules.roleZone);

  // A pairing the store visibly runs on is not a mismatch. Recorded as
  // `false` (positively normal), not `null`, so it also earns the edge-hours
  // discount below — if Hardlines TAs routinely work this zone, a Hardlines
  // TA here at 6am is doubly explained.
  const paired = pairings.has(pairingKey(e.position, e.zoneName));
  if (mm === true && paired) mm = false;

  // Rule 1 — time of day. Skipped for unparseable timestamps.
  if (e.eventHour != null) {
    if (inHourRange(e.eventHour, TW.deepAfterHours)) {
      out.push({
        rule: "AFTERHOURS_DEEP",
        reason: `after-hours 12am-5am (${formatHour(e.eventHour)})`,
        weightFactor: 1,
      });
    } else {
      // Edge bands straddle shift change. Two independent things can excuse
      // one: the job code being normally on shift then (config), or this
      // associate demonstrably working these hours (learned). Either way the
      // event must ALSO be in their own area — being scheduled at 5am
      // explains a bakery associate at a bakery lock and explains nothing
      // about a bakery associate at an electronics case.
      const byRole  = positionExpectsEdgeHours(e.position, rules.roleZone);
      const byHabit = calibrating && norm != null && hourWithinShift(e.eventHour, norm);
      const onShift = mm === false && (byRole || byHabit);

      for (const w of TW.edgeAfterHours || []) {
        if (!inHourRange(e.eventHour, w)) continue;
        // Two tiers of "expected", because they rest on different evidence.
        // The role list says people with this job code are often scheduled
        // then — a generalisation. A learned habit says THIS person has
        // worked these hours, in their own area, across days of the import.
        // The second is the stronger claim, so it scores nothing by default
        // while the first keeps a small residue.
        const expected = onShift && byHabit
          ? (W.AFTERHOURS_EDGE_HABITUAL ?? 0)
          : (W.AFTERHOURS_EDGE_EXPECTED ?? W.AFTERHOURS_EDGE);
        const factor = onShift ? (expected / (W.AFTERHOURS_EDGE || 1)) : 1;
        const why = !onShift ? ""
          : byHabit ? ` — their usual hours (${formatHour(norm.shiftFrom)}-${formatHour(norm.shiftTo)}), own area`
          : " — on shift, own area";
        out.push({
          rule: "AFTERHOURS_EDGE",
          reason: `edge after-hours ${formatHour(w.fromHour)}-${formatHour(w.toHour)} (${formatHour(e.eventHour)})${why}`,
          weightFactor: factor,
        });
        break;
      }
    }
  }

  // Rule 3 — high-risk zone / lock keywords. Base-rate suppression does the
  // real work here: in a single-zone import this fires on everything.
  if (containsAny(`${e.zoneName} ${e.lockName}`, rules.highRiskKeywords)) {
    out.push({ rule: "HIGH_RISK_ZONE", reason: "high-risk zone/lock", weightFactor: 1 });
  }

  // Rule 2 — role/zone mismatch.
  if (mm === true) {
    out.push({
      rule: "ROLE_MISMATCH",
      reason: `role/zone mismatch (${e.position} → ${e.zoneName})`,
      weightFactor: 1,
    });
  }

  // Rule 4 — volume. Against the user's OWN median where we have enough of
  // their history; the store-wide percentile is only the cold-start fallback.
  const u = userAggs.byUser.get(e.userId);
  if (u) {
    const dayCount = u.byDay.get(e.eventDate) || 0;
    if (calibrating && norm != null) {
      const bar = Math.max(
        norm.medianDay * (rules.calibration?.userBaseline?.volumeMultiple ?? 1.75),
        T.volumeAbsoluteFloor,
      );
      if (dayCount > bar) {
        out.push({
          rule: "HIGH_VOLUME",
          reason: `high volume for this user (${dayCount}/day vs their usual ${norm.medianDay})`,
          weightFactor: 1,
        });
      }
    } else if (dayCount > meta.userDayP95 && dayCount >= T.volumeAbsoluteFloor) {
      out.push({
        rule: "HIGH_VOLUME",
        reason: `high user volume (${dayCount}/day, p95=${meta.userDayP95})`,
        weightFactor: 1,
      });
    }
  }

  // Rule 8a — multi-zone window (>= N distinct zones in K minutes).
  if (e._multiZoneWindow) {
    out.push({
      rule: "MULTI_ZONE_WINDOW",
      reason: `${e._multiZoneWindow} zones in ${T.multiZoneWindowMinutes}min`,
      weightFactor: 1,
    });
  }

  // Rule 8b — repeated same lock. `_repeatedSameLock` counts PARTNERS, so
  // opens = n + 1. Two opens of a drawer five minutes apart is what stocking
  // freight looks like; the floor is configurable and defaults to 3.
  if (e._repeatedSameLock) {
    const opens = e._repeatedSameLock + 1;
    if (opens >= (T.repeatedLockMinOpens ?? 2)) {
      out.push({
        rule: "REPEATED_SAME_LOCK",
        reason: `same lock repeated ${opens}x within ${T.repeatedLockWindowMinutes}min`,
        weightFactor: 1,
      });
    }
  }

  // Rule 7 — unusual unlock source (only if there IS a dominant source).
  if (e.unlockSource && meta.dominantSource && meta.dominantSourceShare > 0.9) {
    if (canon(e.unlockSource) !== canon(meta.dominantSource)) {
      out.push({
        rule: "UNUSUAL_SOURCE",
        reason: `unusual unlock source: ${e.unlockSource}`,
        weightFactor: 1,
      });
    }
  }

  // Rule 5 — hour spike. The store's busiest hour is lunch, and flagging it
  // flags normality: it only means something if the hour is ALSO unusual for
  // the person. Without a baseline for them, fall back to the store view.
  if (e.eventHour != null && meta.hourSpikeHours.has(e.eventHour)) {
    const usualForThem = calibrating && norm != null && hourWithinShift(e.eventHour, norm);
    if (!usualForThem) {
      out.push({
        rule: "DAY_HOUR_SPIKE",
        reason: `store hour spike (${formatHour(e.eventHour)})`,
        weightFactor: 1,
      });
    }
  }

  return out;
}

// ── Base-rate calibration ───────────────────────────────────────────
//
// The premise: a reason attached to almost every event in an import is a
// description of the store, not of the event. Store 1458's entire 500-row
// export is one high-risk zone, so HIGH_RISK_ZONE fired on 100% of rows and
// added a flat +20 to every score — enough, with any single +10 rule, to push
// the whole store past the Watch band. Scaling by fire-rate removes that
// automatically, and keeps removing it at the next store without anyone
// editing a keyword list.

function computeFireRates(hits, total) {
  const counts = new Map();
  for (const rowHits of hits) {
    // A rule counts once per event even if it somehow fired twice.
    for (const r of new Set(rowHits.map((h) => h.rule))) {
      counts.set(r, (counts.get(r) || 0) + 1);
    }
  }
  const rates = new Map();
  for (const [rule, n] of counts) rates.set(rule, total ? n / total : 0);
  return rates;
}

function baseRateScales(fireRate, eventCount, CAL) {
  const br = CAL.baseRate ?? {};
  const suppressAbove = br.suppressAbove ?? 0.6;
  const zeroAt        = br.zeroAt ?? 0.9;
  const minEvents     = br.minEvents ?? 50;
  const pinned = new Set(CAL.pinnedRules?.rules ?? []);

  const scales = new Map();
  // Too small an import to know what "usual" looks like — a 12-row test file
  // would otherwise zero every rule it happens to contain.
  if (eventCount < minEvents) return scales;

  for (const [rule, rate] of fireRate) {
    if (pinned.has(rule)) { scales.set(rule, 1); continue; }
    if (rate <= suppressAbove)  { scales.set(rule, 1); continue; }
    if (rate >= zeroAt)         { scales.set(rule, 0); continue; }
    const span = Math.max(1e-9, zeroAt - suppressAbove);
    scales.set(rule, 1 - (rate - suppressAbove) / span);
  }
  return scales;
}

// ── Per-associate normal ────────────────────────────────────────────
//
// `medianDay` — the middle of this user's own daily counts. The store-wide
// p95 answers "who touches locks most", which in a single-zone import is
// permanently the people whose job that zone is.
//
// `shiftFrom` / `shiftTo` — the hours they demonstrably work, padded. Used to
// excuse edge-hours and hour-spike hits, never deep after-hours: a pattern of
// 3am openings is a finding, not a baseline (AFTERHOURS_DEEP is pinned).
//
// Users below the minimums get NO baseline (null), so a single 3am event can
// never establish 3am as somebody's normal.

function userNormals(userAggs, cfg) {
  const minDays   = cfg.minDaysForBaseline ?? 3;
  const minEvents = cfg.minEventsForBaseline ?? 8;
  const pad       = cfg.shiftPadHours ?? 1;

  const out = new Map();
  for (const [userId, u] of userAggs.byUser) {
    if (u.byDay.size < minDays || u.events.length < minEvents) continue;

    const dayCounts = [...u.byDay.values()].sort((a, b) => a - b);
    const medianDay = percentile(dayCounts, 0.5);

    const hours = u.events.map((e) => e.eventHour).filter((h) => h != null);
    if (!hours.length) continue;
    // Trim the extremes so one unusual night doesn't widen someone's whole
    // envelope — the point is their routine, not their outermost event.
    const sorted = [...hours].sort((a, b) => a - b);
    const shiftFrom = Math.max(0,  percentile(sorted, 0.05) - pad);
    const shiftTo   = Math.min(23, percentile(sorted, 0.95) + pad);

    out.set(userId, { medianDay, shiftFrom, shiftTo, days: u.byDay.size });
  }
  return out;
}

function hourWithinShift(hour, norm) {
  if (!norm) return false;
  return hour >= norm.shiftFrom && hour <= norm.shiftTo;
}

// ── Observed (position → zone) pairings ─────────────────────────────
//
// Requiring several DISTINCT people is what separates "this is how the store
// runs" from "one person keeps going somewhere they shouldn't" — the second
// must keep scoring, and a per-event count alone would excuse it.

function pairingKey(position, zoneName) {
  return `${canon(position)}|${canon(zoneName)}`;
}

function observedRolePairings(events, cfg) {
  const minEvents = cfg.minEvents ?? 20;
  const minUsers  = cfg.minUsers ?? 2;

  const agg = new Map();
  for (const e of events) {
    if (!e.position || !e.zoneName) continue;
    const k = pairingKey(e.position, e.zoneName);
    let a = agg.get(k);
    if (!a) { a = { n: 0, users: new Set() }; agg.set(k, a); }
    a.n++;
    if (e.userId) a.users.add(e.userId);
  }

  const out = new Set();
  for (const [k, a] of agg) {
    if (a.n >= minEvents && a.users.size >= minUsers) out.add(k);
  }
  return out;
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

// ── Rule 1b: is this job code normally on shift at the edge hours? ──
//
// Only half the test — the caller ALSO requires roleZoneMismatch() === false
// before applying the discount. On its own this answers "were they supposed
// to be here at 5am?", not "were they supposed to be at THIS lock?".
//
// Deliberately scoped to the EDGE bands only. The deep band (12am-5am)
// keeps full weight for every role: "scheduled overnight" explains being
// in the building, not being in a locked case at 3am.

function positionExpectsEdgeHours(position, roleZone) {
  const p = canon(position);
  if (!p) return false;
  for (const r of roleZone?.expectedEdgeHourPositions || []) {
    if (p.includes(canon(r))) return true;
  }
  return false;
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
    // Guard: a hand-edited entry with a missing/blank `position` canon()s to
    // "", and p.includes("") is true for every position — it would swallow
    // the whole map and silently disable this rule. Skip it instead.
    const key = canon(entry?.position);
    if (!key) continue;
    if (p.includes(key)) {
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
