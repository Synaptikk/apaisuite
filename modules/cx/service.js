// modules/cx/service.js
//
// Service-worker handlers for the Cx module.
//
// Three sources, three failure modes, deliberately kept separate so one being
// cold does not blank the panel:
//   · Hoops  — the graded NPS and sub-scores. Cheap, usually works.
//   · Medallia — the comments. Needs a tab; the expensive one.
//   · AI gateway — the written read. Optional by design.
//
// A pull reports each source's outcome individually rather than throwing on the
// first failure, because "NPS is down 14 points but I could not read Medallia"
// is still worth showing.
//
// NOTE: no host.storage here — `host` exists only in the view page, so this
// file uses lib/store.js, which talks to raw chrome.storage with cx.* keys.
// See docs/AI_CONTEXT_BRIEF.md section 2.

import { ensureAlarm } from "../../shared/alarms.js";
import { withKeepAwake } from "../../shared/sw_keepalive.js";
import { createLogging } from "../../shared/logging.js";
import { getUserHomeStore } from "../../shared/userStore.js";

import { fetchNps, fetchSubscores, fetchGenAiSummary, fetchHoopsComments, TIME_TYPE, HoopsError } from "./lib/hoops.js";
import { fetchComments, MedalliaError } from "./lib/medallia.js";
import { buildAnalysis, addDays, maxDay } from "./lib/aggregate.js";
import { writeNarrative as askGateway, narrativeFingerprint, tokenStatus, GatewayError } from "./lib/narrative.js";
import * as store from "./lib/store.js";

const log = createLogging("cx");

export const ALARM_NAMES = { refresh: "cx.refresh" };

/**
 * Daily. Medallia publishes a comment hours after the response and the Hoops
 * week rolls once a week, so there is nothing an hourly poll would catch — and
 * a cold pull opens a tab, which is not something to do to someone hourly.
 */
const REFRESH_PERIOD_MIN = 12 * 60;

/** Don't re-pull on every SW wake. Pinned to the alarm period for the reason in digitalrollup/service.js. */
const BOOTSTRAP_MIN_GAP_MS = REFRESH_PERIOD_MIN * 60_000;

// One pull at a time: two concurrent pulls would race for the same Medallia
// anchor tab and the first would have it closed out from under it.
let inFlight = null;

function broadcast(type, payload = {}) {
  chrome.runtime.sendMessage({ module: "cx", type, ...payload }).catch(() => {});
}

// ── Handlers ────────────────────────────────────────────────────────────

export const handlers = {
  /** Everything the view needs to render, with no network access. */
  async getState() {
    const [comments, scores, prefs, settings, lastRun] = await Promise.all([
      store.readComments(), store.readScores(), store.readPrefs(), store.readSettings(), store.readLastRun(),
    ]);
    const storeNbr = await resolveStore();
    return {
      storeNbr,
      hasData: !!comments?.records?.length,
      coverage: comments ? { from: comments.from, to: comments.to, count: comments.records.length, pulledAt: comments.pulledAt } : null,
      scores: scores ?? null,
      prefs,
      // The token itself never leaves the SW — the view gets its status only.
      settings: redactSettings(settings),
      lastRun,
    };
  },

  /**
   * Analysis for one chip selection. Runs in the SW rather than the view
   * because the record array is multi-MB and structured-cloning it into the
   * page on every chip click is the slow part.
   */
  async analyze(msg = {}) {
    const comments = await store.readComments();
    if (!comments?.records?.length) return { ok: false, reason: "NO_DATA" };

    const prefs = { ...(await store.readPrefs()), ...(msg.filters ?? {}) };
    const scores = await store.readScores();

    const analysis = buildAnalysis(comments.records, {
      filters: { journeys: prefs.journeys, channels: prefs.channels, from: msg.from ?? null, to: msg.to ?? null },
      windowDays: prefs.windowDays,
      scores,
    });

    return { ok: true, analysis: serializeAnalysis(analysis), coverage: { from: comments.from, to: comments.to, pulledAt: comments.pulledAt } };
  },

  async setPrefs(msg = {}) {
    return { ok: true, prefs: await store.writePrefs(msg.patch ?? {}) };
  },

  async setSettings(msg = {}) {
    const next = await store.writeSettings(msg.patch ?? {});
    return { ok: true, settings: redactSettings(next) };
  },

  /** Pull everything. `mode: "full" | "incremental"`. */
  async refresh(msg = {}) {
    if (inFlight) return inFlight;
    inFlight = runRefresh(msg).finally(() => { inFlight = null; });
    return inFlight;
  },

  /** The written read. Separate from refresh so a gateway problem never blocks a pull. */
  async narrate(msg = {}) {
    const settings = await store.readSettings();
    const comments = await store.readComments();
    if (!comments?.records?.length) return { ok: false, reason: "NO_DATA" };

    const storeNbr = await resolveStore();
    const prefs = { ...(await store.readPrefs()), ...(msg.filters ?? {}) };
    const scores = await store.readScores();
    const analysis = buildAnalysis(comments.records, {
      filters: { journeys: prefs.journeys, channels: prefs.channels },
      windowDays: prefs.windowDays,
      scores,
    });

    const fingerprint = narrativeFingerprint(analysis, { storeNbr, model: settings.gatewayModel });
    if (!msg.force) {
      const cached = await store.readNarrative(fingerprint);
      if (cached) return { ok: true, cached: true, narrative: cached };
    }

    try {
      const result = await withKeepAwake("cx.narrate", () => askGateway(analysis, {
        token: settings.gatewayToken,
        model: settings.gatewayModel,
        storeNbr,
        scores,
      }));
      const saved = await store.writeNarrative(fingerprint, {
        text: result.text, model: result.model, usage: result.usage,
        // Stored so "what was sent" can be shown; it holds the same verbatims
        // already on screen and no store figures beyond them.
        facts: result.promptFacts,
      });
      log.emit("cx.narrative.ok", { model: result.model });
      return { ok: true, cached: false, narrative: saved };
    } catch (e) {
      const errorClass = e instanceof GatewayError ? e.errorClass : "HTTP";
      log.emit("cx.narrative.fail", { errorClass });
      return { ok: false, reason: errorClass, error: String(e?.message ?? e) };
    }
  },

  /** Status of the gateway token, for the settings panel. */
  async tokenInfo() {
    const { gatewayToken } = await store.readSettings();
    return { ok: true, status: tokenStatus(gatewayToken) };
  },

  async clearHistory() {
    await store.clearComments();
    return { ok: true };
  },
};

// ── The pull ────────────────────────────────────────────────────────────

async function runRefresh({ mode = "incremental", storeNbr: override = null } = {}) {
  const storeNbr = override ?? (await resolveStore());
  if (!storeNbr) {
    const out = { ok: false, reason: "NO_STORE", error: "No home store set. Set one in suite settings." };
    await store.writeLastRun(out);
    return out;
  }

  const settings = await store.readSettings();
  broadcast("cx.refresh.start", { mode, storeNbr });

  const outcome = { ok: true, mode, storeNbr, hoops: null, medallia: null };

  // ── Hoops. Independent of Medallia on purpose: the graded numbers are the
  // headline and they should survive a Medallia outage.
  try {
    const [nps, subscores, genAi] = await Promise.all([
      fetchNps(storeNbr, { timeType: TIME_TYPE.WEEK }),
      fetchSubscores(storeNbr, { timeType: TIME_TYPE.WEEK }),
      // The portal's own summary is nearly a year stale in practice, so a
      // failure here is not worth failing the pull for.
      fetchGenAiSummary(storeNbr).catch(() => null),
    ]);
    await store.writeScores(storeNbr, { nps, subscores, genAi });
    outcome.hoops = { ok: true, weeks: nps.periods.length };
  } catch (e) {
    outcome.hoops = { ok: false, errorClass: e instanceof HoopsError ? e.errorClass : "HTTP", error: String(e?.message ?? e) };
    log.emit("cx.hoops.fail", { errorClass: outcome.hoops.errorClass });
  }

  // ── Medallia.
  try {
    const existing = await store.readComments();
    const sameStore = existing && String(existing.storeNbr) === String(storeNbr);

    // A store change invalidates the history outright — the role scopes the
    // query, so records from another store could not be merged meaningfully.
    if (existing && !sameStore) await store.clearComments();

    const today = todayIso();
    const full = mode === "full" || !sameStore || !existing;
    const from = full ? addDays(today, -(settings.windowWeeks * 7)) : overlapStart(existing, today);

    const stopAtIds = full ? null : await store.storedIds();

    // A 52-week pull is eight requests over roughly two minutes, almost all of
    // it awaiting fetch — exactly the shape that gets the worker collected at
    // the 30 s mark. See shared/sw_keepalive.js.
    const pull = await withKeepAwake("cx.comments", () => fetchComments({
      from, to: today, stopAtIds,
      onProgress: (p) => broadcast("cx.refresh.progress", { ...p, phase: "comments" }),
    }));

    const merged = await store.mergeComments(storeNbr, pull.records, {
      from: full ? from : (existing?.from ?? from),
      to: maxDay(pull.records) ?? existing?.to ?? today,
      total: pull.total,
    });

    outcome.medallia = {
      ok: true, fetched: pull.records.length, added: merged.added,
      held: merged.records.length, pages: pull.pages, total: pull.total,
      window: { from: merged.from, to: merged.to }, full,
    };
  } catch (e) {
    const errorClass = e instanceof MedalliaError ? e.errorClass : "HTTP";
    outcome.medallia = { ok: false, errorClass, error: String(e?.message ?? e) };
    log.emit("cx.medallia.fail", { errorClass });

    // Fallback so the panel is not empty for someone without Medallia access.
    // Fifty rows, roughly a week behind, no topic tags — labelled as such in
    // the UI, never merged into the Medallia history.
    try {
      const rows = await fetchHoopsComments(storeNbr);
      outcome.fallbackComments = { ok: true, count: rows.length, rows };
    } catch {
      outcome.fallbackComments = { ok: false };
    }
  }

  outcome.ok = !!(outcome.hoops?.ok || outcome.medallia?.ok);
  await store.writeLastRun(outcome);
  broadcast("cx.refresh.done", { outcome });
  return outcome;
}

/**
 * Start day for an incremental pull.
 *
 * Deliberately overlapping: Medallia applies sentiment and topic tags
 * asynchronously after a response lands, so a comment read the day it arrived
 * is often untagged. Re-reading the last two weeks picks the tags up (merge is
 * by id, newest wins) at the cost of one extra page.
 */
function overlapStart(existing, today) {
  const to = existing?.to;
  if (!to) return addDays(today, -14);
  const candidate = addDays(to, -14);
  return candidate < existing.from ? existing.from : candidate;
}

// ── Alarm / bootstrap ───────────────────────────────────────────────────

export async function installAlarms() {
  await ensureAlarm(ALARM_NAMES.refresh, { periodInMinutes: REFRESH_PERIOD_MIN });
}

export async function onAlarm(alarm) {
  if (alarm?.name !== ALARM_NAMES.refresh) return;
  try {
    // Incremental: the background tick should never be the thing that opens a
    // tab for eight pages.
    await handlers.refresh({ mode: "incremental" });
  } catch (e) {
    log.emit("cx.alarm.fail", { error: String(e?.message ?? e) });
  }
}

/**
 * Top up on service-worker boot when the stored data is older than the alarm
 * period — the alarm alone misses the case where the browser was closed across
 * its window.
 */
export async function bootstrapIfNeeded() {
  const comments = await store.readComments();
  // Never a cold 52-week pull unprompted: that opens a tab and runs for two
  // minutes, which the user should have asked for.
  if (!comments?.records?.length) return;
  if (Date.now() - (comments.pulledAt ?? 0) < BOOTSTRAP_MIN_GAP_MS) return;
  await handlers.refresh({ mode: "incremental" });
}

// ── Helpers ─────────────────────────────────────────────────────────────

async function resolveStore() {
  try {
    return await getUserHomeStore();
  } catch {
    return null;
  }
}

function redactSettings(settings) {
  const { gatewayToken, ...rest } = settings;
  return { ...rest, gatewayTokenSet: !!gatewayToken, gatewayTokenStatus: tokenStatus(gatewayToken) };
}

// Maps are not structured-cloneable across the message boundary in a shape the
// view can use, so byTheme is dropped here — the view reads `all` instead.
function serializeAnalysis(a) {
  return {
    filters: a.filters,
    counts: a.counts,
    facets: a.facets,
    ratings: a.ratings,
    weekly: a.weekly,
    themes: {
      taggedCount: a.themes.taggedCount,
      totalRecords: a.themes.totalRecords,
      negative: a.themes.negative,
      positive: a.themes.positive,
      all: a.themes.all,
    },
    movement: {
      windowDays: a.movement.windowDays,
      recent: a.movement.recent ? { from: a.movement.recent.from, to: a.movement.recent.to, count: a.movement.recent.count } : null,
      prior: a.movement.prior ? { from: a.movement.prior.from, to: a.movement.prior.to, count: a.movement.prior.count } : null,
      movers: a.movement.movers,
    },
    scores: a.scores,
  };
}

function todayIso() {
  const d = new Date();
  // Local day: Medallia timestamps are store-local, so a UTC day would slide
  // the window by one for the evening hours.
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
