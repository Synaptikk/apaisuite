// modules/licenseintake/lib/licenseIntakeController.js
//
// Orchestration layer for the License Intake workflow. One function
// (`runFullWorkflow`) takes raw scanner text and walks the entire
// chain — parse → session → Auror search → stage draft or use match →
// APPRISS lookup → save — in one call. This is the "one controller"
// per the course-correction directive.
//
// Earlier the workflow was scattered across:
//   - `service.js` handlers (parse, create_session, search_auror, card_lookup)
//   - `view.js` button click handlers wiring them
//   - `content/auror_inline.js` Auror-page button
//
// All of those still work for the UI; the controller is what they
// (and any future caller) invoke instead of duplicating sequencing.
//
// The controller does NOT do live writes. Person creation requires an
// explicit operator confirmation in the opened Auror tab. APPRISS
// lookup is read-only.
//
// PII rules:
//   - Raw scanner text never logged.
//   - All console.info lines emit only redactedPreview + status enums.

import { parseLicensePayload, detectFormat } from "./license_parser.js";
import { searchPersonByName, createPersonDraft } from "./auror_search_adapter.js";
import { lookupCardsByPerson } from "./card_lookup_adapter.js";
import {
  makeIntakeSession,
  REVIEW_STATUS,
  MATCH_CLASS,
} from "./intake_models.js";
import { saveSession, loadSettings, resolveHomeStore } from "./intake_storage.js";

/**
 * Run the full intake workflow.
 *
 * @param {string} rawText
 * @param {{
 *   dryRun?: boolean,           // override settings.dryRun
 *   homeStore?: string,         // override settings.defaultHomeStore (APPRISS only)
 *   runApprissImmediately?: boolean,  // default true; set false to defer to operator click
 * }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   error?: string,
 *   sessionId?: string,
 *   session?: import("./intake_models.js").IntakeSession,
 *   stages: {
 *     parse:    { ok: boolean, format?: string, confidence?: number, warnings?: string[], error?: string },
 *     search:   { ok: boolean, matchClass?: string, candidateCount?: number, topPNumber?: string|null, error?: string, dryRun?: boolean, notes?: string[] },
 *     stage:    { ok: boolean, action: "use_existing" | "create_draft" | "needs_review", topPNumber?: string|null },
 *     appriss:  { ok: boolean, status?: string, class?: string, count?: number, error?: string, dryRun?: boolean, skipped?: boolean, notes?: string[] },
 *   },
 * }>}
 */
export async function runFullWorkflow(rawText, opts = {}) {
  const settings = await loadSettings();
  const dryRun = typeof opts.dryRun === "boolean" ? opts.dryRun : settings.dryRun;
  // Auto-resolve homeStore from sibling modules if our own setting is empty.
  const homeStore = opts.homeStore || settings.defaultHomeStore || (await resolveHomeStore());
  const runAppriss = opts.runApprissImmediately !== false;

  /** @type {any} */
  const stages = {
    parse: { ok: false }, search: { ok: false }, stage: { ok: false }, appriss: { ok: false, skipped: false },
  };

  // ─── Stage 1: parse ──────────────────────────────────────────────
  const format = detectFormat(rawText || "");
  const person = parseLicensePayload(rawText || "");
  if (person.parseConfidence === 0) {
    stages.parse = {
      ok: false,
      format,
      confidence: 0,
      warnings: person.parseWarnings,
      error: person.parseWarnings.join("; ") || "no AAMVA fields found",
    };
    console.info("[licenseintake/controller] parse failed");
    return { ok: false, error: stages.parse.error, stages };
  }
  stages.parse = {
    ok: true,
    format,
    confidence: person.parseConfidence,
    warnings: person.parseWarnings,
  };

  // ─── Session ─────────────────────────────────────────────────────
  const session = makeIntakeSession(person);
  await saveSession(session);
  console.info(
    `[licenseintake/controller] session=${session.sessionId} ` +
    `parse.confidence=${person.parseConfidence} ` +
    `preview="${person.redactedPreview}" dryRun=${dryRun} homeStore=${homeStore || "(unset)"}`,
  );

  // ─── Stage 2: Auror search ───────────────────────────────────────
  session.aurorSearchStatus = "loading";
  session.reviewStatus = REVIEW_STATUS.AurorSearchPending;
  session.errors = (session.errors || []).filter((e) => !/auror search/i.test(e));
  await saveSession(session);

  const searchRes = await searchPersonByName(person, { dryRun });
  session.aurorSearchStatus = searchRes.status;
  session.aurorMatches = searchRes.candidates;
  session.aurorMatchClass = searchRes.matchClass;
  if (searchRes.error) session.errors.push(`auror search: ${searchRes.error}`);

  const topMatch = (searchRes.candidates || [])[0] || null;
  const topPNumber = topMatch?.pNumber || null;
  stages.search = {
    ok: searchRes.status !== "error",
    matchClass: searchRes.matchClass,
    candidateCount: (searchRes.candidates || []).length,
    topPNumber,
    error: searchRes.error,
    dryRun,
    notes: searchRes.notes,
  };

  // ─── Stage 3: stage existing-vs-draft ────────────────────────────
  // We ALWAYS stage a createPersonDraft from the parsed license, even
  // when Auror surfaces matches. The UI shows section 4 as a fallback
  // ("none of these are right → import this license as a new person"),
  // and crucially, surfaces it when the Auror search returned ERROR
  // (e.g., missing JWT) or zero candidates — without the draft, the
  // operator has no way to import the scanned license. Strong/possible
  // matches still drive the reviewStatus so APPRISS / event linking
  // wires up to the right person.
  session.createPersonDraft = createPersonDraft(person);

  if (searchRes.matchClass === MATCH_CLASS.NoMatch) {
    session.reviewStatus = REVIEW_STATUS.CreatePersonStaged;
    stages.stage = { ok: true, action: "create_draft", topPNumber: null };
  } else if (
    searchRes.matchClass === MATCH_CLASS.StrongMatch ||
    searchRes.matchClass === MATCH_CLASS.PossibleMatch
  ) {
    session.reviewStatus = REVIEW_STATUS.AurorMatchFound;
    // Don't auto-select; operator clicks "Use this person" in the UI.
    stages.stage = { ok: true, action: "use_existing", topPNumber };
  } else if (searchRes.matchClass === MATCH_CLASS.MultiplePossible) {
    session.reviewStatus = REVIEW_STATUS.NeedsReview;
    stages.stage = { ok: true, action: "needs_review", topPNumber };
  } else {
    // ERROR class — operator still needs an import path; draft is staged
    // above so the create-new-person card appears in the UI.
    session.reviewStatus = REVIEW_STATUS.CreatePersonStaged;
    stages.stage = { ok: false, action: "create_draft_on_error", topPNumber: null };
  }
  await saveSession(session);

  // ─── Stage 4: APPRISS lookup ─────────────────────────────────────
  if (!runAppriss) {
    stages.appriss = { ok: true, skipped: true };
  } else {
    session.apprissLookupStatus = "loading";
    session.reviewStatus = REVIEW_STATUS.CardLookupPending;
    session.errors = (session.errors || []).filter((e) => !/card lookup/i.test(e));
    await saveSession(session);

    const apprRes = await lookupCardsByPerson(person, {
      dryRun,
      confirmed: !dryRun,            // live calls auto-confirmed in this orchestration entry point
      homeStore,
    });
    session.apprissLookupStatus = apprRes.status;
    session.cardTransactionCandidates = apprRes.candidates;
    session.cardLookupClass = apprRes.class;
    session._cardLookupNotes = apprRes.notes || [];
    // Mirror the card_lookup handler: persist the original card
    // structure so the UI can render the AurorBuddy-style nested table.
    session._cardsBlocks = apprRes.cardsBlocks || [];
    session._apprissSuspectName = apprRes.suspectName || null;
    session._apprissRelaxedSurfaced = !!apprRes.relaxedSurfaced;
    if (apprRes.error) session.errors.push(`card lookup: ${apprRes.error}`);

    if (apprRes.status === "ok" || apprRes.status === "dry_run") {
      session.reviewStatus = REVIEW_STATUS.CardLookupComplete;
    } else if (apprRes.status === "needs_manual") {
      session.reviewStatus = REVIEW_STATUS.NeedsReview;
    }

    stages.appriss = {
      ok: apprRes.status !== "error",
      status: apprRes.status,
      class: apprRes.class,
      count: (apprRes.candidates || []).length,
      error: apprRes.error,
      dryRun,
      notes: apprRes.notes,
    };
    await saveSession(session);
  }

  console.info(
    `[licenseintake/controller] done session=${session.sessionId} ` +
    `auror=${stages.search.matchClass} stage=${stages.stage.action} ` +
    `appriss=${stages.appriss.status || (stages.appriss.skipped ? "skipped" : "?")}`,
  );

  return {
    ok: true,
    sessionId: session.sessionId,
    session,
    stages,
  };
}
