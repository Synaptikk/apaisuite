// modules/cx/lib/aggregate.js
//
// Turns stored comment records into the breakdown the panel draws: what is
// going wrong, what is going right, and which of those changed.
//
// Pure functions over plain arrays — no chrome APIs — so the whole analytic
// layer is testable in node (lib/tests/aggregate.test.mjs).
//
// Two deliberate choices worth knowing before reading the numbers:
//
//  1. Topic tags cover a MINORITY of comments (42% over the 90-day sample).
//     Every themed figure therefore reports `taggedCount` beside it, and the
//     rating mix is computed over ALL records instead, because score and
//     journey are present on essentially every one.
//
//  2. "Movement" is a recent window against the window before it, not a
//     week-on-week step. A single store sees roughly 150 comments a week and
//     under half carry tags, so one quiet week swings any one theme by several
//     hundred percent. Four weeks against the prior four is the shortest span
//     that moves for a reason.

import { themeFor, themeMeta, topicLabel, polarityOf, sentimentWeight, ratingBand } from "./topics.js";

/** Default comparison span, in days, for "what changed". */
export const MOVEMENT_WINDOW_DAYS = 28;

/** A theme needs at least this many mentions in the recent window to be called a mover. */
const MOVER_MIN_MENTIONS = 5;

/** Verbatims kept per theme for the drill-down. */
const EXAMPLES_PER_THEME = 6;

// ── Filtering ───────────────────────────────────────────────────────────

/**
 * Narrow records to what the chips currently allow.
 *
 * `journeys` / `channels` empty or null means "everything" rather than
 * "nothing" — an empty chip row should never blank the page.
 */
export function filterRecords(records, { from = null, to = null, journeys = null, channels = null } = {}) {
  const jset = journeys?.length ? new Set(journeys) : null;
  const cset = channels?.length ? new Set(channels) : null;

  return records.filter((r) => {
    if (from && (!r.day || r.day < from)) return false;
    if (to && (!r.day || r.day > to)) return false;
    if (jset && !jset.has(r.journey ?? "(none)")) return false;
    if (cset && !cset.has(r.channel ?? "(none)")) return false;
    return true;
  });
}

/** Distinct journeys present, most common first — used to build the chip row. */
export function journeyFacets(records) {
  return countFacet(records, (r) => r.journey ?? "(none)");
}

/** Distinct channels present (Surveys, Google Reviews, ...), most common first. */
export function channelFacets(records) {
  return countFacet(records, (r) => r.channel ?? "(none)");
}

function countFacet(records, keyOf) {
  const counts = new Map();
  for (const r of records) {
    const k = keyOf(r);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

// ── Headline counts ─────────────────────────────────────────────────────

/**
 * Rating mix over ALL filtered records, plus a comment-derived NPS.
 *
 * The comment NPS is NOT the graded NPS from Hoops — it is computed only over
 * customers who left a comment, which is a self-selecting minority. It is here
 * so a movement in the comments can be read on the same scale as the number the
 * store is graded on, and the UI labels it as such rather than implying they
 * should match.
 */
export function ratingMix(records) {
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let scored = 0;
  for (const r of records) {
    if (r.score >= 1 && r.score <= 5) { counts[r.score]++; scored++; }
  }
  const bands = { promoter: counts[5], passive: counts[4], detractor: counts[1] + counts[2] + counts[3] };
  return {
    counts,
    scored,
    total: records.length,
    bands,
    // NPS convention: %promoters - %detractors, on the 5-point survey where
    // 5 promotes and 1-3 detract (matching ratingBand in topics.js).
    commentNps: scored ? Math.round(((bands.promoter - bands.detractor) / scored) * 100) : null,
    // Mean is offered but the mix is what the UI leads with — this store's
    // distribution is barbelled (1s and 5s), so a mean near 4 describes almost
    // nobody's actual visit.
    mean: scored
      ? Math.round(([1, 2, 3, 4, 5].reduce((a, s) => a + s * counts[s], 0) / scored) * 100) / 100
      : null,
  };
}

/** Weekly series of the rating mix, oldest first, for the trend bars. */
export function weeklyRatingMix(records) {
  const byWeek = new Map();
  for (const r of records) {
    if (!r.day) continue;
    const wk = isoWeekStart(r.day);
    if (!byWeek.has(wk)) byWeek.set(wk, []);
    byWeek.get(wk).push(r);
  }
  return [...byWeek.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([weekStart, rows]) => ({ weekStart, ...ratingMix(rows) }));
}

// ── Theme breakdown ─────────────────────────────────────────────────────

/**
 * Rank themes by sentiment, with the verbatims that justify each row.
 *
 * Returned `positive` and `negative` are the same theme list sorted by
 * different columns, not two different analyses — so a theme that is both
 * loudly praised and loudly criticised (checkout usually is) appears in both,
 * which is the truth about it.
 */
export function themeBreakdown(records, { examplesPerTheme = EXAMPLES_PER_THEME } = {}) {
  const themes = new Map();
  let taggedCount = 0;

  for (const r of records) {
    if (!r.topics?.length) continue;
    taggedCount++;

    // A comment may hit several themes; count it once per theme so a rambling
    // comment tagged five times inside "Associates" is one complaint there.
    const seenThemes = new Map();
    for (const t of r.topics) {
      const themeId = themeFor(t.name);
      if (!themeId) continue;
      const polarity = polarityOf(t.sentiment);
      const prev = seenThemes.get(themeId);
      // Within one comment, a negative reading of the theme wins the count.
      if (!prev || (prev.polarity !== "negative" && polarity === "negative")) {
        seenThemes.set(themeId, { polarity, sentiment: t.sentiment });
      }
    }

    for (const [themeId, hit] of seenThemes) {
      const bucket = themes.get(themeId) ?? newThemeBucket(themeId);
      themes.set(themeId, bucket);
      bucket.mentions++;
      bucket[hit.polarity]++;
      bucket.weight += sentimentWeight(hit.sentiment) * (hit.polarity === "negative" ? 1 : 0);

      // Per-topic detail inside the theme, so "Associates & service" can be
      // opened to see whether it is attitude or staffing.
      for (const t of r.topics) {
        if (themeFor(t.name) !== themeId) continue;
        const key = t.name;
        const tb = bucket.topics.get(key) ?? { name: key, label: topicLabel(key), mentions: 0, positive: 0, negative: 0, neutral: 0 };
        tb.mentions++;
        tb[polarityOf(t.sentiment)]++;
        bucket.topics.set(key, tb);
      }

      if (bucket.examples[hit.polarity].length < examplesPerTheme && r.text) {
        bucket.examples[hit.polarity].push({
          id: r.id, day: r.day, journey: r.journey, score: r.score,
          text: r.text, sentiment: hit.sentiment,
        });
      }
    }
  }

  const list = [...themes.values()].map((b) => ({
    themeId:  b.themeId,
    ...themeMeta(b.themeId),
    mentions: b.mentions,
    positive: b.positive,
    negative: b.negative,
    neutral:  b.neutral,
    // Share of this theme's opinionated mentions that were negative. Neutral
    // mentions are excluded from the denominator: a topic mentioned without an
    // opinion says nothing about whether it is going well.
    negativeShare: opinionated(b) ? b.negative / opinionated(b) : null,
    weight: Math.round(b.weight * 10) / 10,
    topics: [...b.topics.values()].sort((x, y) => y.mentions - x.mentions),
    examples: b.examples,
  }));

  return {
    taggedCount,
    totalRecords: records.length,
    // Ranked by volume of negative mentions, weighted so two "strongly
    // negative" outrank three "mixed".
    negative: [...list].filter((t) => t.negative > 0)
      .sort((a, b) => b.weight - a.weight || b.negative - a.negative),
    positive: [...list].filter((t) => t.positive > 0)
      .sort((a, b) => b.positive - a.positive),
    byTheme: new Map(list.map((t) => [t.themeId, t])),
    all: list,
  };
}

function newThemeBucket(themeId) {
  return {
    themeId, mentions: 0, positive: 0, negative: 0, neutral: 0, weight: 0,
    topics: new Map(), examples: { positive: [], negative: [], neutral: [] },
  };
}

const opinionated = (b) => b.positive + b.negative;

// ── Movement ────────────────────────────────────────────────────────────

/**
 * Which themes got worse or better, recent window against the one before it.
 *
 * Both windows are the same length, so counts are directly comparable without
 * rate maths. Comparison is on negative mentions per 100 comments rather than
 * raw counts, because comment volume itself moves week to week (a holiday week
 * runs light) and a raw count would read that as an improvement.
 */
export function movement(records, { windowDays = MOVEMENT_WINDOW_DAYS, asOf = null, minMentions = MOVER_MIN_MENTIONS } = {}) {
  const latest = asOf || maxDay(records);
  if (!latest) return { recent: null, prior: null, movers: [] };

  const recentFrom = addDays(latest, -(windowDays - 1));
  const priorTo    = addDays(recentFrom, -1);
  const priorFrom  = addDays(priorTo, -(windowDays - 1));

  const recentRows = filterRecords(records, { from: recentFrom, to: latest });
  const priorRows  = filterRecords(records, { from: priorFrom, to: priorTo });

  const recent = themeBreakdown(recentRows);
  const prior  = themeBreakdown(priorRows);

  const themeIds = new Set([...recent.byTheme.keys(), ...prior.byTheme.keys()]);
  const movers = [];

  for (const id of themeIds) {
    const r = recent.byTheme.get(id);
    const p = prior.byTheme.get(id);
    const recentNeg = r?.negative ?? 0;
    const priorNeg  = p?.negative ?? 0;

    // Per 100 comments in each window, so changing comment volume does not
    // masquerade as changing sentiment.
    const recentRate = recentRows.length ? (recentNeg / recentRows.length) * 100 : 0;
    const priorRate  = priorRows.length  ? (priorNeg  / priorRows.length)  * 100 : 0;

    // Anything this thin is noise on a single store's week, so it is reported
    // as present but never ranked as a mover.
    const thin = Math.max(recentNeg, priorNeg) < minMentions;

    movers.push({
      themeId: id,
      ...themeMeta(id),
      recentNegative: recentNeg,
      priorNegative:  priorNeg,
      recentRate: round1(recentRate),
      priorRate:  round1(priorRate),
      deltaRate:  round1(recentRate - priorRate),
      recentPositive: r?.positive ?? 0,
      priorPositive:  p?.positive ?? 0,
      thin,
      direction: recentRate > priorRate ? "worse" : recentRate < priorRate ? "better" : "flat",
    });
  }

  movers.sort((a, b) => {
    if (a.thin !== b.thin) return a.thin ? 1 : -1;
    return Math.abs(b.deltaRate) - Math.abs(a.deltaRate);
  });

  return {
    windowDays,
    recent: { from: recentFrom, to: latest, count: recentRows.length, breakdown: recent },
    prior:  { from: priorFrom,  to: priorTo, count: priorRows.length, breakdown: prior },
    movers,
  };
}

// ── One object for the view ─────────────────────────────────────────────

/**
 * Everything the panel needs for the current chip selection, in one pass.
 *
 * `scores` is the Hoops payload passed straight through — it is the graded
 * number and is never recomputed from comments.
 */
export function buildAnalysis(records, { filters = {}, windowDays = MOVEMENT_WINDOW_DAYS, scores = null } = {}) {
  const filtered = filterRecords(records, filters);
  return {
    filters,
    counts: {
      all: records.length,
      filtered: filtered.length,
      firstDay: minDay(filtered),
      lastDay: maxDay(filtered),
    },
    facets: {
      journeys: journeyFacets(records),
      channels: channelFacets(records),
    },
    ratings: ratingMix(filtered),
    weekly: weeklyRatingMix(filtered),
    themes: themeBreakdown(filtered),
    movement: movement(filtered, { windowDays }),
    scores,
  };
}

// ── Date helpers ────────────────────────────────────────────────────────
// Plain "YYYY-MM-DD" string maths on purpose: every date in this module comes
// from Medallia as a local-store-time string, and routing it through Date()
// would shift days across the UTC boundary.

export function addDays(day, delta) {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

/** Monday of the week containing `day`. */
export function isoWeekStart(day) {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = (dt.getUTCDay() + 6) % 7;   // 0 = Monday
  dt.setUTCDate(dt.getUTCDate() - dow);
  return dt.toISOString().slice(0, 10);
}

export function minDay(records) {
  let min = null;
  for (const r of records) if (r.day && (!min || r.day < min)) min = r.day;
  return min;
}

export function maxDay(records) {
  let max = null;
  for (const r of records) if (r.day && (!max || r.day > max)) max = r.day;
  return max;
}

const round1 = (n) => Math.round(n * 10) / 10;
