// modules/cx/lib/topics.js
//
// Folds Medallia's topic names into one theme vocabulary.
//
// Why this exists: Medallia runs PARALLEL taxonomies across its three tag
// pools. The in-store survey and the OPD survey have different names for the
// same idea — "Interaction - Attitude" and "Associate Interaction - Attitude",
// "Checkout - General" and "Checkout Experience - Checkout Process",
// "Product Availability - Availability/Out of Stock" and "Product Page -
// Stock/Availability Information". Ranked raw, one real problem shows up as
// two half-sized rows and the list is wrong at the top, which is the only part
// anybody reads.
//
// So each topic is mapped to a THEME (what to do about it) while the original
// name is always kept for drill-down. Nothing is discarded: a family this file
// has never seen falls back to its own first segment, so a new Medallia topic
// appears as its own theme rather than vanishing.
//
// Family volumes that shaped this mapping are in dev/CX_FINDINGS.md section 2.

/**
 * Themes in the order they should be offered. `scope` says whether the theme is
 * something the store floor controls ("store"), something the digital/OPD
 * operation controls ("digital"), or a judgement about Walmart at large
 * ("company") that a store cannot coach away.
 */
export const THEMES = Object.freeze([
  { id: "associates",  label: "Associates & service",   scope: "store",   blurb: "How associates treated the customer — attitude, helpfulness, knowledge, direct name mentions." },
  { id: "checkout",    label: "Checkout",               scope: "store",   blurb: "Lanes, wait, self-checkout, pinpads, the checkout process itself." },
  { id: "availability",label: "On the shelf",           scope: "store",   blurb: "Out of stocks, substitutions, and stock information that turned out to be wrong." },
  { id: "quality",     label: "Product quality",        scope: "store",   blurb: "Condition, freshness, damage, melted or leaking product." },
  { id: "store",       label: "Store environment",      scope: "store",   blurb: "Cleanliness, layout, remodels, carts, bags, wheelchairs." },
  { id: "servicedesk", label: "Service desk & returns", scope: "store",   blurb: "Refunds, returns, issue resolution, calling the store." },
  { id: "pharmacy",    label: "Pharmacy, Vision & ACC", scope: "store",   blurb: "The in-store specialty departments." },
  { id: "accuracy",    label: "Order accuracy",         scope: "digital", blurb: "Missing items, wrong items, wrong order, substitutions on a digital order." },
  { id: "handoff",     label: "Delivery & pickup",      scope: "digital", blurb: "Where and how the order arrived, driver conduct, instructions, bagging, speed." },
  { id: "digital",     label: "App & website",          scope: "digital", blurb: "The app, the site, notifications, product pages, payment." },
  { id: "price",       label: "Price & value",          scope: "company", blurb: "Prices, fees, value for money, inflation." },
  { id: "brand",       label: "Overall / brand",        scope: "company", blurb: "General satisfaction with Walmart, not attached to anything specific." },
]);

const THEME_BY_ID = new Map(THEMES.map((t) => [t.id, t]));

/**
 * Family (the part before the first " - ") to theme.
 *
 * Keyed on family rather than full topic name on purpose: Medallia adds
 * subthemes far more often than families, and a family-level map keeps working
 * when it does.
 */
const FAMILY_THEME = Object.freeze({
  // Associates — four families for one idea, which is the whole problem.
  "Interaction":               "associates",
  "Associate Interaction":     "associates",
  "Associate -Direct Mentions": "associates",
  "Associate Direct Mentions": "associates",
  "Associate Dept":            "associates",
  "Customer Support":          "servicedesk",

  "Checkout":                  "checkout",
  "Checkout Experience":       "checkout",

  "Product Availability":      "availability",
  "Product Page":              "availability",
  "Substitutions":             "availability",

  "Product":                   "quality",
  "Product Overall/Issues":    "quality",

  "Atmosphere":                "store",
  "Shopping Cart":             "store",
  "Shopping Bags":             "store",
  "Store Experience":          "store",

  "Returns":                   "servicedesk",
  "Service Desk":              "servicedesk",

  "Pharmacy":                  "pharmacy",
  "Vision Center":             "pharmacy",
  "Auto Care Center":          "pharmacy",

  "Accuracy of Order":         "accuracy",

  "Fulfillment":               "handoff",
  "Delivery Location":         "handoff",
  "Delivery Instructions":     "handoff",
  "Speed":                     "handoff",
  "Tipping":                   "handoff",
  "Driver":                    "handoff",

  "Notifications":             "digital",
  "App":                       "digital",
  "Website":                   "digital",
  "Payment/Fees":              "digital",
  "Order Placement":           "digital",

  "Pricing Value":             "price",
  "Pricing":                   "price",

  "Brand":                     "brand",
  "Brand Affinity":            "brand",
});

/**
 * A handful of subthemes belong somewhere other than their family's theme.
 * Keyed on the full topic name, checked before the family map.
 */
const TOPIC_OVERRIDE = Object.freeze({
  // A pinpad complaint is a checkout complaint even though the survey files it
  // under payment.
  "Payment/Fees - Payment Methods": "checkout",
  // "Delivery Fees" is a pricing judgement, not a handoff failure.
  "Payment/Fees - Delivery Fees":   "price",
  // Staffing shows up under associate interaction but reads as a checkout
  // problem whenever it is about the wait.
  "Associate Interaction - Sufficient Staffing/Wait Time": "checkout",
});

/** Split "Family - Subtheme" keeping any further " - " inside the subtheme. */
export function splitTopic(name) {
  const i = (name || "").indexOf(" - ");
  if (i === -1) return { family: (name || "").trim(), subtheme: null };
  return { family: name.slice(0, i).trim(), subtheme: name.slice(i + 3).trim() || null };
}

/**
 * Theme id for a Medallia topic name.
 *
 * An unmapped family becomes its own theme (id `other:<family>`) rather than
 * being dropped or lumped into a catch-all, so a taxonomy change is visible in
 * the UI instead of silently shrinking the totals.
 */
export function themeFor(topicName) {
  if (!topicName) return null;
  const override = TOPIC_OVERRIDE[topicName];
  if (override) return override;
  const { family } = splitTopic(topicName);
  return FAMILY_THEME[family] ?? `other:${family}`;
}

/** Display metadata for a theme id, including the generated `other:` ones. */
export function themeMeta(themeId) {
  const known = THEME_BY_ID.get(themeId);
  if (known) return known;
  if (typeof themeId === "string" && themeId.startsWith("other:")) {
    const family = themeId.slice(6);
    return { id: themeId, label: family, scope: "store", blurb: `Medallia topic family "${family}", not yet mapped to a theme.` };
  }
  return { id: themeId ?? "unknown", label: "Unknown", scope: "store", blurb: "" };
}

/** Short label for a topic within its theme — the subtheme carries the detail. */
export function topicLabel(topicName) {
  const { family, subtheme } = splitTopic(topicName);
  return subtheme || family;
}

// ── Sentiment ───────────────────────────────────────────────────────────

/**
 * Medallia's six sentiments collapsed to the three a reader acts on.
 *
 * MIXED_OPINION counts as a negative: for a comment that says "the cashier was
 * lovely but the wait was 20 minutes", the mixed reading on the wait is the
 * half worth working on, and filing it as neutral hides it entirely.
 */
export function polarityOf(sentiment) {
  switch (sentiment) {
    case "STRONGLY_POSITIVE":
    case "POSITIVE":
      return "positive";
    case "NEGATIVE":
    case "STRONGLY_NEGATIVE":
    case "MIXED_OPINION":
      return "negative";
    default:
      return "neutral";   // NO_OPINION, UNSPECIFIED
  }
}

/** Weight for ranking: a strong opinion counts for more than a mild one. */
export function sentimentWeight(sentiment) {
  switch (sentiment) {
    case "STRONGLY_NEGATIVE":
    case "STRONGLY_POSITIVE":
      return 1.5;
    case "MIXED_OPINION":
      return 0.5;
    default:
      return 1;
  }
}

/** Rating bucket in NPS terms, applied to the 1-5 survey score. */
export function ratingBand(score) {
  if (score === 5) return "promoter";
  if (score === 4) return "passive";
  if (score >= 1 && score <= 3) return "detractor";
  return null;
}
