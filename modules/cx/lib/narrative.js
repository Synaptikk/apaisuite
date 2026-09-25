// modules/cx/lib/narrative.js
//
// The written read: hands the already-computed breakdown to Walmart's internal
// AI gateway and gets back plain English a manager can act on.
//
// Two rules shape this file.
//
//  1. The model never gets to do the arithmetic. Everything numeric in the
//     prompt is a figure lib/aggregate.js already computed and the panel already
//     shows, and the model is told to use those figures rather than derive any.
//     So the prose cannot disagree with the table above it.
//
//  2. It is optional and it fails visibly. The whole panel works with the
//     narrative missing; when the token is absent or expired the module says so
//     in words instead of quietly rendering an empty box.
//
// Gateway details (endpoint, auth, CORS, token expiry): dev/CX_FINDINGS.md
// section 3 and MEMORY.md::Walmart AI gateway. This must run in the service
// worker — the gateway sends no CORS headers, so only an extension context with
// host_permissions can read the response.

const ENDPOINT = "https://puppy-backend.walmart.com/anthropic/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/** Verbatims per theme sent to the model. Enough to characterise, not to dump. */
const QUOTES_PER_THEME = 4;
/** Themes sent per side. Past this the prompt is long and nobody reads that far. */
const THEMES_PER_SIDE = 6;
/** Verbatims are truncated — a 600-word review adds tokens, not signal. */
const QUOTE_CHARS = 320;

export class GatewayError extends Error {
  constructor(message, errorClass = "HTTP") {
    super(message);
    this.name = "GatewayError";
    this.errorClass = errorClass;   // TOKEN | EXPIRED | HTTP | SHAPE
  }
}

/**
 * Decode the `exp` claim locally so the panel can warn before the token lapses
 * instead of surfacing a 401 as a mystery.
 *
 * Signature is not verified and does not need to be — this is a UI courtesy,
 * and the gateway is the only thing that decides whether the token is good.
 */
export function tokenExpiry(token) {
  try {
    const part = String(token).split(".")[1];
    if (!part) return null;
    const json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    return json?.exp ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function tokenStatus(token) {
  if (!token) return { ok: false, reason: "missing" };
  const exp = tokenExpiry(token);
  if (!exp) return { ok: true, expiresAt: null, reason: "opaque" };
  if (exp <= Date.now()) return { ok: false, reason: "expired", expiresAt: exp };
  return { ok: true, expiresAt: exp, reason: exp - Date.now() < 3 * 86_400_000 ? "expiring" : "ok" };
}

/**
 * Ask the gateway to write up one analysis.
 *
 * @param {object} analysis  the object from aggregate.js::buildAnalysis
 * @param {object} opts      { token, model, storeNbr, scores }
 * @returns {Promise<{text: string, model: string, usage: object, promptFacts: object}>}
 */
export async function writeNarrative(analysis, { token, model = "claude-sonnet-5", storeNbr, scores = null } = {}) {
  const status = tokenStatus(token);
  if (!status.ok) {
    throw new GatewayError(
      status.reason === "expired"
        ? "The AI gateway token has expired. Refresh it in Code Puppy and paste the new one into Cx settings."
        : "No AI gateway token set. Paste your Code Puppy token into Cx settings to turn the written read on.",
      status.reason === "expired" ? "EXPIRED" : "TOKEN",
    );
  }

  const facts = promptFacts(analysis, { storeNbr, scores });
  const body = {
    model,
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt(facts) }],
  };

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Api-Key": token,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new GatewayError(`Could not reach the AI gateway: ${e?.message ?? e}`, "HTTP");
  }

  if (res.status === 401 || res.status === 403) {
    throw new GatewayError("The AI gateway rejected the token (401). Refresh it in Code Puppy.", "EXPIRED");
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new GatewayError(`AI gateway returned ${res.status}. ${detail}`, "HTTP");
  }

  const json = await res.json().catch(() => null);
  const text = (json?.content ?? [])
    .filter((b) => b?.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) throw new GatewayError("The AI gateway returned no text.", "SHAPE");

  return { text, model: json?.model ?? model, usage: json?.usage ?? null, promptFacts: facts };
}

// ── Prompt construction ─────────────────────────────────────────────────

const SYSTEM_PROMPT = [
  "You write short Cx read-outs for a single Walmart store's leadership team.",
  "",
  "You are given figures that have ALREADY been computed from the store's own",
  "Medallia customer comments and its Hoops scorecard. Use those figures as given.",
  "Do not recompute, re-derive, estimate, or introduce any number that is not in",
  "the input. If something is not in the input, do not mention it.",
  "",
  "Write for a store manager who has ten minutes before a morning meeting:",
  "concrete, specific, no corporate filler, no motivational language, no",
  "restating of the numbers as a list. Name the actual thing customers describe",
  "(a register restarting, a locked case nobody came to open, orders left on the",
  "porch) rather than the theme label.",
  "",
  "Structure your reply with these markdown headings and nothing else:",
  "",
  "## The short version",
  "Two or three sentences. Lead with whichever movement matters most.",
  "",
  "## What's going wrong",
  "Three to five bullets, worst first. Each names the problem, cites the figure",
  "given for it, and quotes at most one short customer fragment.",
  "",
  "## What's going right",
  "Two to four bullets. Same shape. Do not manufacture praise; if a theme is",
  "genuinely thin, say the evidence is thin.",
  "",
  "## What changed",
  "Two to four bullets on the movement figures only. Say plainly when a move is",
  "too small to trust — the input flags thin themes.",
  "",
  "## Where I would start",
  "Two or three actions, each tied to a specific theme above and doable inside a",
  "store. No headcount requests, no capital asks, no corporate escalations.",
].join("\n");

/**
 * The numeric contract handed to the model. Built separately from the prompt
 * text so it can be shown to the user ("what was sent") and stored beside the
 * narrative for audit.
 */
export function promptFacts(analysis, { storeNbr, scores = null } = {}) {
  const a = analysis;
  const npsPeriods = scores?.nps?.periods ?? [];
  const recentNps = npsPeriods.slice(-6).map((p) => ({ period: p.label, ty: p.ty, ly: p.ly }));
  const lastNps = [...npsPeriods].reverse().find((p) => p.ty != null) ?? null;

  const sub = scores?.subscores?.periods ?? [];
  const lastSub = sub.length ? sub[sub.length - 1] : null;

  return {
    store: String(storeNbr ?? ""),
    coverage: {
      comments: a.counts.filtered,
      firstDay: a.counts.firstDay,
      lastDay: a.counts.lastDay,
      journeysIncluded: a.filters?.journeys?.length ? a.filters.journeys : "all",
      channelsIncluded: a.filters?.channels?.length ? a.filters.channels : "all",
      // Stated explicitly so the model does not imply the themes describe every
      // comment: under half of them carry topic tags.
      commentsWithTopicTags: a.themes.taggedCount,
    },
    gradedScores: {
      note: "From the Hoops scorecard. NPS is weekly (not published daily). These are the graded numbers; the comment figures below are a separate, self-selecting sample.",
      npsLatest: lastNps ? { period: lastNps.label, thisYear: lastNps.ty, lastYear: lastNps.ly } : null,
      npsRecentWeeks: recentNps,
      subScoresLatest: lastSub
        ? { period: lastSub.label, scores: Object.fromEntries(Object.entries(lastSub.scores).map(([k, v]) => [k, { thisYear: v.ty, lastYear: v.ly }])) }
        : null,
    },
    commentRatings: {
      note: "Ratings of customers who left a comment. Not the graded NPS.",
      counts: a.ratings.counts,
      promoters: a.ratings.bands.promoter,
      passives: a.ratings.bands.passive,
      detractors: a.ratings.bands.detractor,
      commentNps: a.ratings.commentNps,
    },
    goingWrong: a.themes.negative.slice(0, THEMES_PER_SIDE).map((t) => ({
      theme: t.label,
      scope: t.scope,
      negativeMentions: t.negative,
      positiveMentions: t.positive,
      negativeShareOfOpinions: pct(t.negativeShare),
      topTopics: t.topics.slice(0, 4).map((x) => ({ topic: x.label, mentions: x.mentions, negative: x.negative })),
      quotes: t.examples.negative.slice(0, QUOTES_PER_THEME).map(quote),
    })),
    goingRight: a.themes.positive.slice(0, THEMES_PER_SIDE).map((t) => ({
      theme: t.label,
      scope: t.scope,
      positiveMentions: t.positive,
      negativeMentions: t.negative,
      topTopics: t.topics.slice(0, 4).map((x) => ({ topic: x.label, mentions: x.mentions, positive: x.positive })),
      quotes: t.examples.positive.slice(0, QUOTES_PER_THEME).map(quote),
    })),
    whatChanged: {
      note: `Last ${a.movement.windowDays} days against the ${a.movement.windowDays} before. Rates are negative mentions per 100 comments, so changing comment volume does not read as changing sentiment. "thin: true" means too few mentions to trust.`,
      recentWindow: a.movement.recent ? { from: a.movement.recent.from, to: a.movement.recent.to, comments: a.movement.recent.count } : null,
      priorWindow: a.movement.prior ? { from: a.movement.prior.from, to: a.movement.prior.to, comments: a.movement.prior.count } : null,
      movers: a.movement.movers.slice(0, 8).map((m) => ({
        theme: m.label,
        direction: m.direction,
        negPer100Recent: m.recentRate,
        negPer100Prior: m.priorRate,
        change: m.deltaRate,
        recentNegativeMentions: m.recentNegative,
        priorNegativeMentions: m.priorNegative,
        thin: m.thin,
      })),
    },
  };
}

function quote(ex) {
  const text = (ex.text || "").replace(/\s+/g, " ").trim();
  return {
    day: ex.day,
    journey: ex.journey,
    rating: ex.score,
    text: text.length > QUOTE_CHARS ? `${text.slice(0, QUOTE_CHARS)}…` : text,
  };
}

function userPrompt(facts) {
  return [
    `Store ${facts.store}. Write the Cx read-out from the figures below.`,
    "",
    "```json",
    JSON.stringify(facts, null, 1),
    "```",
  ].join("\n");
}

const pct = (v) => (v == null ? null : Math.round(v * 100));

/**
 * Fingerprint of what a narrative describes, so the cache invalidates when the
 * chips or the data move. Cheap and order-stable.
 */
export function narrativeFingerprint(analysis, { storeNbr, model }) {
  const f = analysis.filters ?? {};
  return [
    storeNbr,
    model,
    (f.journeys ?? []).slice().sort().join(","),
    (f.channels ?? []).slice().sort().join(","),
    analysis.movement?.windowDays,
    analysis.counts.filtered,
    analysis.counts.lastDay,
  ].join("|");
}
