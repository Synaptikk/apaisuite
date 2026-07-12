// modules/licenseintake/lib/card_lookup_adapter.js
//
// Card / APPRISS / transaction lookup for a scanned license person.
//
// We do NOT call APPRISS directly. AurorBuddy already owns:
//   - the APPRISS SAML/session auth probe (lib/appriss.js::probeApprissApiAuth)
//   - the throttled lookup loop (lib/appriss.js::apprissLookupAll)
//   - the retry/auth-wall HTTP wrapper (lib/appriss_http.js::postJson)
//   - the name-match helpers (lib/appriss_names.js)
// Reusing it via cross-module messaging means:
//   - one APPRISS auth path to keep working
//   - one place to handle 429s / auth walls
//   - no auth secrets in this module
//
// PII rules:
//   - Console logs report counts + match-class only — never cardholder
//     name, card number, or transaction amount.
//   - The returned TransactionCandidate[] has maskedPan only (last 4).
//     Even masked, the surname-on-card is sensitive; UI hides it by
//     default behind an Expand toggle.

import { CARD_LOOKUP_CLASS } from "./intake_models.js";
// We're running INSIDE the service worker (this adapter is imported by
// licenseintake/service.js). chrome.runtime.sendMessage from the SW
// doesn't deliver to the SW itself, so cross-module calls go via direct
// static import of the target module's handler map instead.
import { handlers as _aurorbuddy } from "../../aurorbuddy/service.js";

/**
 * Call an AurorBuddy handler from inside the SW. Mirrors what the
 * shell SW dispatcher does (await handler(msg, sender)) so we get the
 * same return shape — { ok, data | error }.
 *
 * @param {string} type   handler name on aurorbuddy::handlers
 * @param {Object} payload
 */
async function callAurorBuddy(type, payload = {}) {
  const handler = _aurorbuddy?.[type];
  if (typeof handler !== "function") {
    throw new Error(`aurorbuddy::${type} handler not found`);
  }
  const msg = { module: "aurorbuddy", type, ...payload };
  const result = await handler(msg, /* sender */ null);
  if (result && typeof result === "object" && "ok" in result) return result;
  return { ok: true, data: result };
}

/**
 * @typedef {import("./license_parser.js").LicensePerson} LicensePerson
 * @typedef {import("./intake_models.js").TransactionCandidate} TransactionCandidate
 */

/**
 * Trigger an APPRISS lookup for the scanned person via AurorBuddy.
 *
 * @param {LicensePerson} person
 * @param {{
 *   dryRun?: boolean,
 *   homeStore?: string|null,
 *   signal?: AbortSignal,
 *   confirmed?: boolean,         // required when dryRun=false
 * }} [opts]
 * @returns {Promise<{
 *   status: "ok" | "error" | "dry_run" | "needs_manual",
 *   class: string,               // one of CARD_LOOKUP_CLASS
 *   candidates: TransactionCandidate[],
 *   error?: string,
 *   notes: string[],
 * }>}
 */
export async function lookupCardsByPerson(person, opts = {}) {
  const dryRun = !!opts.dryRun;
  const notes = [];

  if (!person?.lastName) {
    return {
      status: "error",
      class: CARD_LOOKUP_CLASS.Error,
      candidates: [],
      error: "no last name on parsed person",
      notes,
    };
  }

  console.info(`[licenseintake/cardlookup] start dryRun=${dryRun} hasFirst=${!!person.firstName}`);

  if (dryRun) {
    const cands = synthesizeDryRunCandidates(person);
    return {
      status: "dry_run",
      class: classify(cands),
      candidates: cands,
      notes: ["dry_run: synthetic candidates returned"],
    };
  }

  if (opts.confirmed !== true) {
    return {
      status: "needs_manual",
      class: CARD_LOOKUP_CLASS.LookupNeedsManualAction,
      candidates: [],
      notes: ["live lookup requires { confirmed: true } in opts"],
    };
  }

  // AurorBuddy's appriss_lookup expects an array of suspects (from
  // scan_auror). We synthesize a minimal one-suspect payload from the
  // license person so the helper can do its surname-based card match.
  // The helper internally uses `firstNameCandidates(suspect)` which
  // reads suspect.name and treats every token that ISN'T first/last as
  // a middle-name candidate. So including the middle name in `.name`
  // is what allows "Naomi Tinker" to match a scan of "Katlin Naomi
  // Tinker" — without the middle token in `.name`, the candidates
  // collapse to ["KATLIN"] and middle-name cardholders get dropped.
  const fullName = [person.firstName, person.middleName, person.lastName]
    .filter(Boolean).join(" ");
  const strictSuspect = [{
    person_id: null,
    name: fullName,
    first_name: person.firstName,
    last_name: person.lastName,
    event_count: 0,
    total_value: 0,
    auror_url: null,
    photo_url: null,
    threatening: false,
    is_orc: false,
  }];

  try {
    // STRICT pass — surname AND (first name OR any middle token) must match.
    // We deliberately DO NOT do a relaxed surname-only fallback: it was
    // surfacing every cardholder with the same last name at the store
    // (e.g. "Bob Tinker" when the license is Katlin Naomi Tinker),
    // which the operator correctly read as a false positive. If strict
    // returns no cards, we report it cleanly so the operator knows the
    // scanned person has no matching APPRISS activity at this store.
    const resp = await callAurorBuddy("appriss_lookup", {
      suspects: strictSuspect,
      homeStore: opts.homeStore || null,
      _source: "licenseintake",
    });

    // Auth-wall / SAML expiry surfaces as resp.ok === false. AurorBuddy's
    // ensureApprissAuth already attempted autonomous reauth (open SAML
    // URL in background, click SSO, poll cookie+probe up to 30s) before
    // returning failure — there is no further automation we can apply
    // from the licenseintake side. Surface as a plain error so the view
    // shows a passive message; never as "needs_manual" with a click-to-
    // act prompt, per the suite-wide autonomous-reauth policy.
    if (!resp?.ok) {
      const msg = resp?.error || "unknown error from aurorbuddy::appriss_lookup";
      return {
        status: "error",
        class: CARD_LOOKUP_CLASS.Error,
        candidates: [],
        error: msg,
        notes: [...notes, "appriss lookup failed after autonomous reauth"],
      };
    }

    const suspectsArr = resp.matched
      || resp.data?.matched
      || resp.data?.suspects
      || (Array.isArray(resp.data) ? resp.data : [])
      || [];
    const enrichedSuspect = suspectsArr[0];

    // Belt-and-suspenders: double-check each returned card's name against
    // our license first/middle whole-word match BEFORE we surface it.
    // This guards against any AurorBuddy code path that may have relaxed
    // the filter upstream (e.g. surname-only matches sneaking through).
    if (enrichedSuspect && Array.isArray(enrichedSuspect.appriss_cards)) {
      const allow = buildAllowedFirstTokens(person);
      const before = enrichedSuspect.appriss_cards.length;
      enrichedSuspect.appriss_cards = enrichedSuspect.appriss_cards.filter((card) => {
        // Card-level name first; fall back to first transaction's cardholder.
        const candidateName =
          (card.name || card.transactions?.[0]?.cardholder || "").toUpperCase();
        return cardNameMatchesAllowedTokens(candidateName, person.lastName, allow);
      });
      const dropped = before - enrichedSuspect.appriss_cards.length;
      if (dropped > 0) {
        notes.push(`dropped ${dropped} cardholder(s) that didn't match the scanned first/middle name`);
        console.info(`[licenseintake/cardlookup] post-filter dropped ${dropped} cards`);
      }
    }

    if (!enrichedSuspect || !(enrichedSuspect.appriss_cards || []).length) {
      const apprStatus = resp.data?.diag?.lookupStatus
        || resp.data?.apprStatusSummary
        || "no suspects returned";
      notes.push(
        `No APPRISS cardholder matches "${fullName}" at homeStore=${opts.homeStore || "(unset)"} ` +
        `(status="${apprStatus}"). Cards belonging to other people with the same ` +
        `last name are NOT surfaced — first or middle name must match.`,
      );
      console.info(`[licenseintake/cardlookup] done: 0 candidates (strict, no enriched suspects)`);
      return {
        status: "ok",
        class: CARD_LOOKUP_CLASS.NoCardMatch,
        candidates: [],
        notes,
      };
    }

    const candidates = normalizeApprissResult(enrichedSuspect);
    if (enrichedSuspect.appriss_status) {
      notes.push(`appriss_status=${enrichedSuspect.appriss_status}`);
    }
    const cls = classify(candidates);
    console.info(
      `[licenseintake/cardlookup] done: ${candidates.length} candidate(s), ` +
      `class=${cls}, appriss_status=${enrichedSuspect.appriss_status || "(none)"}`,
    );
    return {
      status: "ok",
      class: cls,
      candidates,
      // Preserve the original card structure (with .transactions[]
      // attached, matching AurorBuddy's shape) so the UI can render an
      // AurorBuddy-style per-card transaction table.
      cardsBlocks: (enrichedSuspect.appriss_cards || []).map((card) => ({
        name: card.name || null,
        last4: card.last4 || null,
        cardMasked: card.card_masked || (card.last4 ? `************${card.last4}` : null),
        accountHash: card.account_hash || null,
        count: card.count || String((card.transactions || []).length),
        transactions: (card.transactions || []).map((t) => ({
          transactionId: t.transaction_id || t.transactionId || "",
          store: t.store || null,
          register: t.register || null,
          transNo: t.trans_no || null,
          amount: t.amount != null ? String(t.amount) : null,
          datetime: t.datetime || t.date || null,
          cardholder: t.cardholder || null,
          cctvUrl: t.cctv_url || null,
          receiptUrl: t.receipt_url || null,
          atHome: !!t.at_home,
        })),
      })),
      suspectName: enrichedSuspect.name || null,
      relaxedSurfaced: false,
      notes,
    };
  } catch (err) {
    const msg = err?.message || String(err);
    console.warn("[licenseintake/cardlookup] handoff failed:", msg);
    return {
      status: "error",
      class: CARD_LOOKUP_CLASS.Error,
      candidates: [],
      error: msg,
      notes,
    };
  }
}

/**
 * Last-name-only convenience search (no first name available).
 *
 * @param {string} lastName
 * @param {{ dryRun?: boolean, confirmed?: boolean, homeStore?: string|null }} [opts]
 */
export async function lookupTransactionsByLastName(lastName, opts = {}) {
  return lookupCardsByPerson(
    { firstName: null, lastName, dob: null },
    opts,
  );
}

/**
 * Normalize an enriched suspect from AurorBuddy::appriss_lookup into
 * TransactionCandidate[].
 *
 * Input shape:
 *   { ..., appriss_cards: [
 *     { name, card_masked, last4, count,
 *       transactions: [{ store, cashier, register, trans_no, amount,
 *                        datetime, cardholder, transaction_id, ... }] }
 *   ], appriss_status: "found"|"empty"|... }
 *
 * Output: one TransactionCandidate per transaction. If a card has no
 * transactions at the operator's homeStore, surface a single "card on
 * file" candidate so the operator knows the cardholder exists in APPRISS
 * even though no purchases were made locally.
 */
export function normalizeApprissResult(enrichedSuspect) {
  if (!enrichedSuspect || typeof enrichedSuspect !== "object") return [];
  const cards = enrichedSuspect.appriss_cards || enrichedSuspect.cards || [];
  if (!Array.isArray(cards) || cards.length === 0) return [];

  /** @type {TransactionCandidate[]} */
  const out = [];

  for (const c of cards) {
    const cardMasked = maskPan(c.card_masked || c.maskedPan || (c.last4 ? `************${c.last4}` : null));
    const surname = c.name || c.surname || null;
    const txns = Array.isArray(c.transactions) ? c.transactions : [];

    if (txns.length === 0) {
      // Card-on-file marker: APPRISS knows this cardholder exists at
      // some store but no transactions surfaced for the operator's
      // homeStore. Distinguishable in the UI by transactionId === "" + amount null.
      out.push({
        transactionId: "",
        date: null,
        storeNumber: null,
        amount: null,
        maskedPan: cardMasked,
        surnameOnCard: surname,
        matchScore: 0,
        matchReasons: ["card on file in APPRISS (no transactions at this store)"],
      });
      continue;
    }

    for (const t of txns) {
      const amount = parseFloat(t.amount);
      out.push({
        transactionId: t.transaction_id || t.transactionId || "",
        date: t.datetime || t.date || null,
        storeNumber: t.store || t.storeNumber || null,
        amount: Number.isFinite(amount) ? amount : null,
        maskedPan: cardMasked,
        surnameOnCard: t.cardholder || surname,
        // Keep extra context for the UI / future use.
        register: t.register || null,
        cashier: t.cashier || null,
        transNo: t.trans_no || null,
        cctvUrl: t.cctv_url || null,
        receiptUrl: t.receipt_url || null,
        matchScore: 0,
        matchReasons: [],
      });
    }
  }

  return out;
}

/**
 * Backwards-compat alias used by some callers.
 */
export function normalizeCardLookupResult(rawApprissData) {
  return normalizeApprissResult(rawApprissData);
}

/**
 * Score a transaction candidate against the scanned person. Currently
 * surname-based (the most-decisive signal in APPRISS responses); future
 * versions can layer in date proximity / store match.
 *
 * @param {LicensePerson} person
 * @param {TransactionCandidate} cand
 * @returns {TransactionCandidate}
 */
export function scoreTransactionCandidate(person, cand) {
  const reasons = [];
  let score = 0;
  const wantLast = (person?.lastName || "").toUpperCase();
  const haveLast = (cand?.surnameOnCard || "").toUpperCase();
  if (wantLast && haveLast && wantLast === haveLast) {
    score += 0.7;
    reasons.push("surname on card matches license last name");
  } else if (wantLast && haveLast && haveLast.includes(wantLast)) {
    score += 0.4;
    reasons.push("surname on card contains license last name");
  }
  if (cand.date) {
    score += 0.05;
    reasons.push("date present");
  }
  if (score > 1) score = 1;
  return { ...cand, matchScore: score, matchReasons: reasons };
}

/**
 * Build a one-line summary of candidate hits (no PII).
 * @param {TransactionCandidate[]} candidates
 */
export function summarizeCandidates(candidates) {
  const n = candidates?.length || 0;
  if (n === 0) return "no transactions found";
  const strong = candidates.filter((c) => c.matchScore >= 0.7).length;
  const weak = n - strong;
  return `${n} transaction(s) — ${strong} strong / ${weak} weak match`;
}

function classify(cands) {
  if (!cands?.length) return CARD_LOOKUP_CLASS.NoCardMatch;
  const strong = cands.filter((c) => c.matchScore >= 0.7);
  if (strong.length > 0) return CARD_LOOKUP_CLASS.CardMatchFound;
  return CARD_LOOKUP_CLASS.PossibleCardMatch;
}

function maskPan(pan) {
  if (!pan) return null;
  const s = String(pan);
  if (s.length <= 4) return "*".repeat(s.length);
  // Match AurorBuddy's masking style if already masked.
  if (/[*X]/.test(s)) return s;
  return "*".repeat(s.length - 4) + s.slice(-4);
}

/**
 * Build the set of UPPERCASE first/middle tokens we're willing to accept
 * as a name match. Includes initials for length-1 matches against multi-
 * character tokens on the card (e.g. "Katlin N Tinker" → allow "N").
 *
 * @param {LicensePerson} person
 */
function buildAllowedFirstTokens(person) {
  const tokens = new Set();
  for (const raw of [person?.firstName, person?.middleName]) {
    const t = (raw || "").trim().toUpperCase();
    if (t) tokens.add(t);
  }
  return tokens;
}

/**
 * Whole-word match: surname must be the last meaningful token on the card
 * (after stripping JR/SR/etc.) AND at least one of the allowed first/middle
 * tokens must appear as a whole word OR as an initial that prefixes a
 * cardholder token. Mirrors AurorBuddy's `nameMatchesAny` semantics but
 * keyed off OUR allow-list rather than the upstream candidates.
 *
 * @param {string} cardNameUpper   already UPPERCASE
 * @param {string} licenseLastName mixed case
 * @param {Set<string>} allowedFirstTokens UPPERCASE first + middle tokens
 */
function cardNameMatchesAllowedTokens(cardNameUpper, licenseLastName, allowedFirstTokens) {
  if (!cardNameUpper) return false;
  const SUFFIXES = new Set(["JR", "SR", "II", "III", "IV", "V"]);
  const tokens = cardNameUpper.split(/\s+/).filter(Boolean);
  const meaningful = tokens.filter((t) => !SUFFIXES.has(t));
  if (!meaningful.length) return false;
  // Surname must be the last meaningful token on the card.
  const last = meaningful[meaningful.length - 1];
  const wantLast = (licenseLastName || "").toUpperCase();
  if (!wantLast || last !== wantLast) return false;
  // At least one allowed first/middle token must appear as a whole word.
  if (!allowedFirstTokens || allowedFirstTokens.size === 0) {
    // No first/middle info on the license — accept surname-only match.
    return true;
  }
  for (const tok of meaningful) {
    if (allowedFirstTokens.has(tok)) return true;
    // Single-letter card token: matches if its letter is the first letter
    // of any allowed multi-char token ("N" on card matches "Naomi" on license).
    if (tok.length === 1) {
      for (const a of allowedFirstTokens) {
        if (a.length > 1 && a.startsWith(tok)) return true;
      }
    }
    // Single-letter allowed token: matches when card token starts with it
    // ("J" on license matches "JOHN" on card).
    for (const a of allowedFirstTokens) {
      if (a.length === 1 && tok.startsWith(a)) return true;
    }
  }
  return false;
}

function synthesizeDryRunCandidates(person) {
  const last = (person?.lastName || "DOE").toUpperCase();
  /** @type {TransactionCandidate[]} */
  const cands = [
    {
      transactionId: "txn_dryrun_001",
      date: "2026-05-30",
      storeNumber: "1234",
      amount: 49.99,
      maskedPan: "************1234",
      surnameOnCard: last,
      matchScore: 0,
      matchReasons: [],
    },
    {
      transactionId: "txn_dryrun_002",
      date: "2026-05-29",
      storeNumber: "1234",
      amount: 12.40,
      maskedPan: "************1234",
      surnameOnCard: last,
      matchScore: 0,
      matchReasons: [],
    },
  ];
  return cands.map((c) => scoreTransactionCandidate(person, c));
}
