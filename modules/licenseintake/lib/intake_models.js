// modules/licenseintake/lib/intake_models.js
//
// Type definitions + factories for LicenseIntake session records. Pure
// data, no side effects. The IntakeSession is the unit of operator
// review work: one scanned license + its Auror search + its APPRISS
// lookup + the operator's decisions.
//
// Storage representation is the same shape; redaction happens at log/UI
// boundaries, not at storage write time (we need the data for the
// review workflow).

/**
 * @typedef {(
 *   | "scanned"
 *   | "parsed"
 *   | "auror_search_pending"
 *   | "auror_match_found"
 *   | "auror_no_match"
 *   | "create_person_staged"
 *   | "card_lookup_pending"
 *   | "card_lookup_complete"
 *   | "needs_review"
 *   | "completed"
 *   | "dismissed"
 * )} ReviewStatus
 */

export const REVIEW_STATUS = Object.freeze({
  Scanned:              "scanned",
  Parsed:               "parsed",
  AurorSearchPending:   "auror_search_pending",
  AurorMatchFound:      "auror_match_found",
  AurorNoMatch:         "auror_no_match",
  CreatePersonStaged:   "create_person_staged",
  CardLookupPending:    "card_lookup_pending",
  CardLookupComplete:   "card_lookup_complete",
  NeedsReview:          "needs_review",
  Completed:            "completed",
  Dismissed:            "dismissed",
});

export const MATCH_CLASS = Object.freeze({
  StrongMatch:     "STRONG_MATCH",
  PossibleMatch:   "POSSIBLE_MATCH",
  MultiplePossible:"MULTIPLE_POSSIBLE",
  NoMatch:         "NO_MATCH",
  Error:           "ERROR",
});

export const CARD_LOOKUP_CLASS = Object.freeze({
  CardMatchFound:        "CARD_MATCH_FOUND",
  PossibleCardMatch:     "POSSIBLE_CARD_MATCH",
  NoCardMatch:           "NO_CARD_MATCH",
  LookupNeedsManualAction:"LOOKUP_NEEDS_MANUAL_ACTION",
  Error:                 "ERROR",
});

/**
 * @typedef {import("./license_parser.js").LicensePerson} LicensePerson
 */

/**
 * Normalized Auror person hit (shape we control; adapter maps API → this).
 * @typedef {Object} AurorPersonCandidate
 * @property {string|null} identityGroupId
 * @property {string|null} pNumber
 * @property {string|null} displayName
 * @property {string|null} dob                       ISO YYYY-MM-DD if Auror exposes it
 * @property {string|null} lastEventDate
 * @property {string|null} aurorUrl                  deep link if available
 * @property {number}      matchScore                0..1 from scoreAurorPersonMatch()
 * @property {string[]}    matchReasons              human-readable, safe-to-log
 */

/**
 * Normalized card / transaction candidate (one row in the review pane).
 * @typedef {Object} TransactionCandidate
 * @property {string}      transactionId
 * @property {string|null} date                ISO
 * @property {string|null} storeNumber
 * @property {number|null} amount
 * @property {string|null} maskedPan           e.g. "************1234"
 * @property {string|null} surnameOnCard
 * @property {number}      matchScore          0..1
 * @property {string[]}    matchReasons
 */

/**
 * @typedef {Object} IntakeSession
 * @property {string}                 sessionId
 * @property {number}                 createdAt
 * @property {number}                 scannedAt
 * @property {number}                 lastUpdated
 * @property {LicensePerson|null}     parsedPerson
 * @property {ReviewStatus}           reviewStatus
 * @property {"idle"|"loading"|"ok"|"error"|"dry_run"} aurorSearchStatus
 * @property {AurorPersonCandidate[]} aurorMatches
 * @property {AurorPersonCandidate|null} selectedAurorPerson
 * @property {string}                 aurorMatchClass        one of MATCH_CLASS
 * @property {Object|null}            createPersonDraft
 * @property {"idle"|"loading"|"ok"|"error"|"dry_run"|"needs_manual"} apprissLookupStatus
 * @property {TransactionCandidate[]} cardTransactionCandidates
 * @property {string}                 cardLookupClass        one of CARD_LOOKUP_CLASS
 * @property {string}                 notes
 * @property {string[]}               errors                  human-readable, never raw payload
 */

/**
 * @param {LicensePerson|null} parsedPerson
 * @returns {IntakeSession}
 */
export function makeIntakeSession(parsedPerson = null) {
  const now = Date.now();
  return {
    sessionId: makeSessionId(now),
    createdAt: now,
    scannedAt: now,
    lastUpdated: now,
    parsedPerson,
    reviewStatus: parsedPerson ? REVIEW_STATUS.Parsed : REVIEW_STATUS.Scanned,
    aurorSearchStatus: "idle",
    aurorMatches: [],
    selectedAurorPerson: null,
    aurorMatchClass: MATCH_CLASS.NoMatch,
    createPersonDraft: null,
    apprissLookupStatus: "idle",
    cardTransactionCandidates: [],
    cardLookupClass: CARD_LOOKUP_CLASS.NoCardMatch,
    notes: "",
    errors: [],
  };
}

function makeSessionId(now) {
  // Non-PII opaque id. Time + 8 random hex chars.
  const rand = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  return `li_${now.toString(36)}_${rand}`;
}

/**
 * Touch lastUpdated on an in-place mutation.
 * @template {IntakeSession} T
 * @param {T} s
 * @returns {T}
 */
export function touch(s) {
  if (s) s.lastUpdated = Date.now();
  return s;
}
