// modules/licenseintake/service.js
//
// Service-worker handlers for LicenseIntake. Pure data orchestration
// (parse → search → score → store). Live external calls are gated by
// the operator-visible `dryRun` setting + per-call `confirmed: true`
// flags. No raw payload ever leaves the parser.
//
// All handlers return { ok, data } | { ok: false, error } per the
// APAISuite messaging contract.

import { parseLicensePayload, detectFormat } from "./lib/license_parser.js";
import {
  searchPersonByName,
  createPersonDraft,
} from "./lib/auror_search_adapter.js";
import {
  handoffToAurorBuddyCreate,
} from "./lib/auror_person_draft_adapter.js";
import {
  lookupCardsByPerson,
} from "./lib/card_lookup_adapter.js";
import { runFullWorkflow } from "./lib/licenseIntakeController.js";
import {
  makeIntakeSession,
  REVIEW_STATUS,
  MATCH_CLASS,
} from "./lib/intake_models.js";
import {
  listSessions,
  getSession,
  saveSession,
  deleteSession,
  clearAllSessions,
  loadSettings,
  saveSettings,
  resolveHomeStore,
} from "./lib/intake_storage.js";
import { redactForLog } from "./lib/redaction.js";

const MODULE_ID = "licenseintake";

// ---------------------------------------------------------------------
// Handler exports — keys match `{ module: "licenseintake", type: "<key>" }`
// ---------------------------------------------------------------------

export const handlers = {

  /**
   * Parse raw scanner text → LicensePerson. Pure local; safe in any mode.
   * payload: { rawText: string }
   * returns { ok, data: { person, format } }
   */
  parse({ rawText }) {
    const format = detectFormat(rawText || "");
    const person = parseLicensePayload(rawText || "");
    console.info(
      "[licenseintake/svc] parse:",
      `format=${format} confidence=${person.parseConfidence} warnings=${person.parseWarnings.length}`,
    );
    return { ok: true, data: { person, format } };
  },

  /**
   * Create a new intake session from already-parsed person data.
   * payload: { person: LicensePerson }
   */
  async create_session({ person }) {
    const session = makeIntakeSession(person);
    await saveSession(session);
    return { ok: true, data: { sessionId: session.sessionId, session } };
  },

  /**
   * List all stored sessions, newest first.
   */
  async list_sessions() {
    const sessions = await listSessions();
    return { ok: true, data: { count: sessions.length, sessions } };
  },

  /**
   * Get one session by id.
   * payload: { sessionId }
   */
  async get_session({ sessionId }) {
    const s = await getSession(sessionId);
    if (!s) return { ok: false, error: "not found" };
    return { ok: true, data: s };
  },

  /**
   * Delete one session by id.
   * payload: { sessionId }
   */
  async delete_session({ sessionId }) {
    const ok = await deleteSession(sessionId);
    return ok ? { ok: true, data: { deleted: sessionId } } : { ok: false, error: "not found" };
  },

  /**
   * Wipe all sessions. Used by the "Clear all" button.
   */
  async clear_all_sessions() {
    const n = await clearAllSessions();
    return { ok: true, data: { cleared: n } };
  },

  /**
   * Explicitly resolve the home store (runs all 4 detection steps) and
   * persist the result. Called by view.js on mount if no store is set yet.
   */
  async resolve_home_store() {
    const store = await resolveHomeStore();
    return { ok: true, data: { homeStore: store } };
  },

  /**
   */
  async get_settings() {
    const s = await loadSettings();
    return { ok: true, data: s };
  },

  /**
   * Save settings patch.
   * payload: { patch: Partial<Settings> }
   */
  async set_settings({ patch }) {
    const s = await saveSettings(patch || {});
    return { ok: true, data: s };
  },

  /**
   * Search Auror for the person on the given session and persist the
   * result. Respects settings.dryRun unless explicitly overridden.
   *
   * payload: { sessionId, overrideDryRun?: boolean }
   */
  async search_auror({ sessionId, overrideDryRun }) {
    const session = await getSession(sessionId);
    if (!session) return { ok: false, error: "session not found" };
    if (!session.parsedPerson) return { ok: false, error: "session has no parsed person" };

    const settings = await loadSettings();
    const dryRun = typeof overrideDryRun === "boolean" ? overrideDryRun : settings.dryRun;

    session.aurorSearchStatus = "loading";
    session.reviewStatus = REVIEW_STATUS.AurorSearchPending;
    // Clear any prior auror-search errors from this session so the UI
    // doesn't show stale "no JWT" lines after a successful retry.
    session.errors = (session.errors || []).filter((e) => !/auror search/i.test(e));
    await saveSession(session);

    // Auror person search is GLOBAL (no store filter). homeStore stays
    // out of this call — it only matters for card_lookup.
    const res = await searchPersonByName(session.parsedPerson, { dryRun });

    session.aurorSearchStatus = res.status;
    session.aurorMatches = res.candidates;
    session.aurorMatchClass = res.matchClass;
    session._aurorSearchNotes = res.notes || [];
    if (res.error) session.errors.push(`auror search: ${res.error}`);

    if (res.matchClass === MATCH_CLASS.NoMatch) {
      session.reviewStatus = REVIEW_STATUS.AurorNoMatch;
      // Stage a draft so the operator can review/create-person later.
      session.createPersonDraft = createPersonDraft(session.parsedPerson);
      session.reviewStatus = REVIEW_STATUS.CreatePersonStaged;
    } else if (res.matchClass === MATCH_CLASS.StrongMatch || res.matchClass === MATCH_CLASS.PossibleMatch) {
      session.reviewStatus = REVIEW_STATUS.AurorMatchFound;
    } else if (res.matchClass === MATCH_CLASS.MultiplePossible) {
      session.reviewStatus = REVIEW_STATUS.NeedsReview;
    }

    await saveSession(session);
    console.info(`[licenseintake/svc] search_auror done sessionId=${sessionId} class=${res.matchClass}${res.error ? ` error="${res.error}"` : ""}`);
    return { ok: true, data: { session, searchNotes: res.notes } };
  },

  /**
   * Mark the operator-chosen Auror person on a session. Pass `candidate: null`
   * to clear the selection.
   * payload: { sessionId, candidate | null }
   */
  async select_auror_person({ sessionId, candidate }) {
    const session = await getSession(sessionId);
    if (!session) return { ok: false, error: "session not found" };
    if (candidate === null || candidate === undefined) {
      session.selectedAurorPerson = null;
      // Re-stage a draft so the operator can fall through to create-person
      // if they decide none of the matches is the right person.
      if (session.parsedPerson) {
        const { createPersonDraft } = await import("./lib/auror_search_adapter.js");
        session.createPersonDraft = createPersonDraft(session.parsedPerson);
        session.reviewStatus = REVIEW_STATUS.CreatePersonStaged;
      }
    } else {
      session.selectedAurorPerson = candidate;
      session.createPersonDraft = null;
      session.reviewStatus = REVIEW_STATUS.AurorMatchFound;
    }
    await saveSession(session);
    return { ok: true, data: session };
  },

  /**
   * Lookup card/transaction activity for the session via AurorBuddy.
   * payload: { sessionId, overrideDryRun?: boolean, confirmed?: boolean, homeStore?: string }
   */
  async card_lookup({ sessionId, overrideDryRun, confirmed, homeStore }) {
    const session = await getSession(sessionId);
    if (!session) return { ok: false, error: "session not found" };
    if (!session.parsedPerson) return { ok: false, error: "session has no parsed person" };

    const settings = await loadSettings();
    const dryRun = typeof overrideDryRun === "boolean" ? overrideDryRun : settings.dryRun;
    // Auto-resolve homeStore from sibling modules (livedashboard /
    // closinglist) if the operator hasn't set one in our UI.
    const home = homeStore || settings.defaultHomeStore || (await resolveHomeStore());

    session.apprissLookupStatus = "loading";
    session.reviewStatus = REVIEW_STATUS.CardLookupPending;
    await saveSession(session);

    const res = await lookupCardsByPerson(session.parsedPerson, {
      dryRun,
      confirmed: !!confirmed,
      homeStore: home,
    });

    session.apprissLookupStatus = res.status;
    session.cardTransactionCandidates = res.candidates;
    session.cardLookupClass = res.class;
    session._cardLookupNotes = res.notes || [];
    session._cardsBlocks = res.cardsBlocks || [];
    session._apprissSuspectName = res.suspectName || null;
    session._apprissRelaxedSurfaced = !!res.relaxedSurfaced;
    if (res.error) session.errors.push(`card lookup: ${res.error}`);

    if (res.status === "ok" || res.status === "dry_run") {
      session.reviewStatus = REVIEW_STATUS.CardLookupComplete;
    } else if (res.status === "needs_manual") {
      session.reviewStatus = REVIEW_STATUS.NeedsReview;
    }

    await saveSession(session);
    console.info(`[licenseintake/svc] card_lookup done sessionId=${sessionId} class=${res.class}${res.error ? ` error="${res.error}"` : ""}`);
    return { ok: true, data: { session, lookupNotes: res.notes } };
  },

  /**
   * Hand off the staged create-person draft to AurorBuddy::create_event.
   * Requires confirmed: true. Honors dry-run.
   *
   * payload: { sessionId, confirmed: true, overrideDryRun?: boolean, suspectName?: string, store?: string }
   */
  async handoff_create_person({ sessionId, confirmed, overrideDryRun, suspectName, store }) {
    if (confirmed !== true) {
      return { ok: false, error: "handoff requires confirmed: true" };
    }
    const session = await getSession(sessionId);
    if (!session) return { ok: false, error: "session not found" };
    if (!session.createPersonDraft) return { ok: false, error: "no createPersonDraft on session" };

    const settings = await loadSettings();
    const dryRun = typeof overrideDryRun === "boolean" ? overrideDryRun : settings.dryRun;

    const res = await handoffToAurorBuddyCreate(session.createPersonDraft, {
      confirmed: true,
      dryRun,
      suspectName,
      store: store || settings.defaultHomeStore || null,
      scannedAt: session.scannedAt || Date.now(),
    });

    if (res.status === "ok" || res.status === "dry_run") {
      session.reviewStatus = REVIEW_STATUS.Completed;
    }
    if (res.error) session.errors.push(`handoff: ${res.error}`);
    await saveSession(session);

    return { ok: true, data: { result: res, session } };
  },

  /**
   * Mark a session completed (operator decided no further action).
   * payload: { sessionId, notes? }
   */
  async mark_completed({ sessionId, notes }) {
    const session = await getSession(sessionId);
    if (!session) return { ok: false, error: "session not found" };
    session.reviewStatus = REVIEW_STATUS.Completed;
    if (typeof notes === "string") session.notes = notes;
    await saveSession(session);
    return { ok: true, data: session };
  },

  /**
   * Mark a session dismissed (e.g. accidental scan).
   * payload: { sessionId }
   */
  async mark_dismissed({ sessionId }) {
    const session = await getSession(sessionId);
    if (!session) return { ok: false, error: "session not found" };
    session.reviewStatus = REVIEW_STATUS.Dismissed;
    await saveSession(session);
    return { ok: true, data: session };
  },

  /**
   * Open the suite's full LicenseIntake page in a new tab. Fired by the
   * "Scan License" tab the content script injects into Auror's main
   * header nav. If the tab is already open, just focus it.
   */
  async open_full_view() {
    const url = chrome.runtime.getURL("app.html#/licenseintake");
    // Reuse an existing tab that's on our app page if there is one.
    try {
      const existing = await chrome.tabs.query({ url: chrome.runtime.getURL("app.html*") });
      if (existing && existing.length > 0) {
        const t = existing[0];
        await chrome.tabs.update(t.id, { active: true, url });
        if (t.windowId) await chrome.windows.update(t.windowId, { focused: true });
        return { ok: true, data: { reused: true, tabId: t.id } };
      }
    } catch (e) {
      console.warn("[licenseintake/svc] open_full_view: tab.query failed:", e?.message || e);
    }
    const created = await chrome.tabs.create({ url, active: true });
    return { ok: true, data: { reused: false, tabId: created.id } };
  },

  /**
   * Trigger a Canon flatbed scan via the native scanner host, decode the
   * PDF417 barcode, and run the full intake workflow. Also crops and saves
   * the DL image to the Desktop and optionally prints a copy.
   *
   * payload: { overrideDryRun?, homeStore?, runApprissImmediately?, print? }
   * returns: same shape as scan_and_search + { croppedPath, croppedB64, barcodeDecoded }
   */
  async scan_from_flatbed({ overrideDryRun, homeStore, runApprissImmediately, print: doPrint }) {
    const HOST_NAME = "com.apaisuite.scanner_host";

    // Call the native host. MV3 service workers can use sendNativeMessage
    // directly — no relay tab needed.
    let hostResp;
    try {
      hostResp = await new Promise((resolve, reject) => {
        chrome.runtime.sendNativeMessage(
          HOST_NAME,
          { action: "scan", print: doPrint !== false },
          (resp) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(resp);
            }
          },
        );
      });
    } catch (err) {
      return {
        ok: false,
        error: `Scanner host error: ${err?.message || err}. ` +
               `Run "Install Scanner Bridge.cmd" in modules/licenseintake/native_host/ first.`,
      };
    }

    if (!hostResp?.ok) {
      return { ok: false, error: hostResp?.error || "Scanner host returned failure" };
    }

    const { aamvaText, barcodeDecoded, ocrDecoded, ocrError, croppedPath, croppedB64 } = hostResp;

    if (!aamvaText) {
      // Scan succeeded but nothing decoded (no barcode and no OCR result).
      const msgParts = ["Scan complete but no license data found."];
      if (ocrError) msgParts.push(`OCR: ${ocrError}`);
      else msgParts.push("Try repositioning the license — front or back both work.");
      return {
        ok: true,
        data: {
          needsManualEntry: true,
          barcodeDecoded: false,
          ocrDecoded: false,
          ocrError: ocrError || null,
          croppedPath,
          croppedB64,
          message: msgParts.join(" "),
        },
      };
    }

    // Barcode or OCR decoded — run the full parse → Auror search → APPRISS workflow.
    const result = await runFullWorkflow(aamvaText, {
      dryRun: overrideDryRun,
      homeStore,
      runApprissImmediately: runApprissImmediately !== false,
    });

    if (!result.ok) {
      return { ok: false, error: result.error, data: { stages: result.stages } };
    }

    const topMatch = (result.session.aurorMatches || [])[0] || null;
    const topMatchNumericId = topMatch?.pNumber
      ? topMatch.pNumber.replace(/^p/i, "")
      : null;

    return {
      ok: true,
      data: {
        sessionId: result.sessionId,
        person: result.session.parsedPerson,
        matchClass: result.session.aurorMatchClass,
        candidateCount: result.stages.search.candidateCount,
        topMatch,
        topMatchNumericId,
        searchNotes: result.stages.search.notes || [],
        apprissStatus: result.stages.appriss.status,
        apprissClass: result.stages.appriss.class,
        apprissCount: result.stages.appriss.count,
        stages: result.stages,
        barcodeDecoded: !!barcodeDecoded,
        ocrDecoded: !!ocrDecoded,
        croppedPath,
        croppedB64,
      },
    };
  },

  /**
   * One-shot orchestration for the Auror page inline button.
   * Delegates to licenseIntakeController.runFullWorkflow which now owns
   * the parse → search → stage → APPRISS chain.
   *
   * payload: { rawText, overrideDryRun?, homeStore?, runApprissImmediately? }
   */
  async scan_and_search({ rawText, overrideDryRun, homeStore, runApprissImmediately }) {
    const result = await runFullWorkflow(rawText, {
      dryRun: overrideDryRun,
      homeStore,
      runApprissImmediately: runApprissImmediately !== false,
    });
    if (!result.ok) {
      return { ok: false, error: result.error, data: { stages: result.stages } };
    }
    const topMatch = (result.session.aurorMatches || [])[0] || null;
    const topMatchNumericId = topMatch?.pNumber
      ? topMatch.pNumber.replace(/^p/i, "")
      : null;
    return {
      ok: true,
      data: {
        sessionId: result.sessionId,
        person: result.session.parsedPerson,
        matchClass: result.session.aurorMatchClass,
        candidateCount: result.stages.search.candidateCount,
        topMatch,
        topMatchNumericId,
        searchNotes: result.stages.search.notes || [],
        apprissStatus: result.stages.appriss.status,
        apprissClass: result.stages.appriss.class,
        apprissCount: result.stages.appriss.count,
        stages: result.stages,
      },
    };
  },
};
