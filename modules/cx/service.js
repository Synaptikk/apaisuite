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
import { fetchMarket, marketTable } from "./lib/market.js";
import { getUserHomeMarket } from "../../shared/userStore.js";
import { getMarketRoster, MARKET_ROSTERS } from "../../shared/marketRoster.js";
import { fetchComments, MedalliaError } from "./lib/medallia.js";
import { buildAnalysis, filterRecords, addDays, maxDay } from "./lib/aggregate.js";
import { themeFor, themeMeta } from "./lib/topics.js";
import { writeNarrative as askGateway, narrativeFingerprint, tokenStatus, GatewayError, DEFAULT_CLIENT_VERSION } from "./lib/narrative.js";
import { runPuppyAuth, readAuthLog, acceptRelayedToken, PuppyAuthError } from "./lib/puppy_auth.js";
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
    const [comments, scores, prefs, settings, lastRun, fallback] = await Promise.all([
      store.readComments(), store.readScores(), store.readPrefs(), store.readSettings(),
      store.readLastRun(), store.readFallbackComments(),
    ]);
    const storeNbr = await resolveStore();
    // Explicit `ok` on every handler: the SW dispatcher auto-wraps a bare
    // return as { ok: true, data: ... }, so a handler that omits it hands the
    // view an extra `data` layer it does not expect
    // (background/service_worker.js::150).
    return {
      ok: true,
      storeNbr,
      hasData: !!comments?.records?.length,
      coverage: comments ? { from: comments.from, to: comments.to, count: comments.records.length, pulledAt: comments.pulledAt } : null,
      scores: scores ?? null,
      // Only offered when there is no real history — 50 rows with no topic tags
      // is a stopgap, not something to show alongside a year of tagged comments.
      fallback: comments?.records?.length ? null : (fallback ?? null),
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

  /**
   * A page of actual comments for the evidence list.
   *
   * Separate from `analyze` on purpose: the theme cards only carry a handful of
   * example verbatims each, so a Comments panel built from those would quietly
   * be a sample of a sample. This returns the real filtered set, paged, so the
   * panel can honestly say how many there are.
   */
  async comments(msg = {}) {
    const box = await store.readComments();
    if (!box?.records?.length) return { ok: false, reason: "NO_DATA" };

    const prefs = { ...(await store.readPrefs()), ...(msg.filters ?? {}) };
    let rows = filterRecords(box.records, { journeys: prefs.journeys, channels: prefs.channels });

    const q = (msg.query ?? "").trim().toLowerCase();
    if (q) rows = rows.filter((r) => r.text.toLowerCase().includes(q));

    if (msg.rating === "detractor") rows = rows.filter((r) => r.score >= 1 && r.score <= 3);
    else if (msg.rating) rows = rows.filter((r) => r.score === Number(msg.rating));

    if (msg.themeId) {
      rows = rows.filter((r) => r.topics.some((t) => themeFor(t.name) === msg.themeId));
    }

    // Already newest-first from mergeComments, so no re-sort.
    const offset = Number(msg.offset ?? 0);
    const limit = Math.min(Number(msg.limit ?? 30), 200);
    return {
      ok: true,
      total: rows.length,
      offset,
      rows: rows.slice(offset, offset + limit).map((r) => ({
        id: r.id, day: r.day, journey: r.journey, channel: r.channel,
        score: r.score, text: r.text,
        // Theme labels rather than raw Medallia names: the panel shows the same
        // vocabulary as the cards above it.
        themes: [...new Set(r.topics.map((t) => themeMeta(themeFor(t.name)).label))],
      })),
    };
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
        clientVersion: settings.gatewayClientVersion || DEFAULT_CLIENT_VERSION,
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

  /** The market scoreboard, read from storage. */
  async getMarket() {
    return { ok: true, market: await store.readMarket() };
  },

  /**
   * Pull every store in the home market from Hoops.
   *
   * Scores only, and deliberately so: Medallia scopes comments to the role, and
   * a Store Manager role sees exactly one store (dev/CX_FINDINGS.md section 2),
   * so there is no market-wide comment data to be had from this account. The
   * panel says that rather than implying the themes below cover the market.
   */
  async pullMarket(msg = {}) {
    const homeStore = await resolveStore();
    const marketNbr = msg.marketNbr ?? (await resolveMarket());
    if (!marketNbr) {
      return { ok: false, reason: "NO_MARKET", error: "No home market set. Set one in suite settings." };
    }
    const roster = msg.stores?.length ? msg.stores : getMarketRoster(marketNbr);
    if (!roster?.length) {
      return {
        ok: false, reason: "NO_ROSTER",
        error: `No store roster for market ${marketNbr}. Add one to shared/marketRoster.js.`,
      };
    }

    broadcast("market_start", { marketNbr, stores: roster.length });
    try {
      const pull = await withKeepAwake("cx.market", () => fetchMarket(roster, {
        marketNbr, homeStore,
        onProgress: (p) => broadcast("market_progress", p),
      }));
      const table = marketTable(pull);
      const saved = await store.writeMarket(table);
      broadcast("market_done", { ok: true });
      return { ok: true, market: saved };
    } catch (e) {
      const errorClass = e instanceof HoopsError ? e.errorClass : "HTTP";
      log.emit("cx.market.fail", { errorClass });
      broadcast("market_done", { ok: false });
      return { ok: false, reason: errorClass, error: String(e?.message ?? e) };
    }
  },

  /**
   * Sign in to the AI gateway and store the token, with no paste.
   *
   * Opens the gateway's own sign-in page with a localhost callback and reads the
   * token out of the POST the page makes back to it — see lib/puppy_auth.js for
   * why that works and why nothing needs to be listening on the port.
   */
  async signInGateway() {
    try {
      const { token } = await withKeepAwake("cx.signin", () => runPuppyAuth({
        onStage: (stage) => broadcast("signin_stage", { stage }),
      }));
      const status = tokenStatus(token);
      if (!status.ok) {
        return { ok: false, reason: "BAD_TOKEN", error: "The sign-in returned a token that is already expired." };
      }
      await store.writeSettings({ gatewayToken: token });
      log.emit("cx.signin.ok", {});
      // Status only — the token itself never leaves the service worker.
      return { ok: true, status };
    } catch (e) {
      const errorClass = e instanceof PuppyAuthError ? e.errorClass : "AUTH";
      log.emit("cx.signin.fail", { errorClass });
      return { ok: false, reason: errorClass, error: String(e?.message ?? e) };
    }
  },

  /**
   * Handed a token by the sign-in page's content-script relay.
   *
   * The relay forwards whatever the page produced; the decision to keep it is
   * made here, and only while a sign-in the user started is armed.
   */
  async puppyTokenSeen(msg = {}, sender) {
    // Only from the sign-in page itself.
    if (!/^https:\/\/puppy\.walmart\.com\//.test(sender?.url ?? "")) {
      return { ok: false, reason: "BAD_ORIGIN" };
    }
    const verdict = await acceptRelayedToken(msg.token);
    return { ok: true, ...verdict };
  },

  /**
   * What the sign-in reported, for when a flow does not complete.
   * Metadata only — host, port, path, field names and lengths, never a token.
   */
  async authDiagnostics() {
    const { observed, armed } = await readAuthLog();
    const perms = await new Promise((res) => chrome.permissions.getAll((p) => res(p)));
    return {
      ok: true,
      armed,
      observed,
      // The silent failure mode: without this the page hook never runs.
      authPageGranted: (perms.origins ?? []).some((o) => o.includes("puppy.walmart.com")),
    };
  },

  /** Forget the stored gateway token. */
  async signOutGateway() {
    await store.writeSettings({ gatewayToken: "" });
    return { ok: true, status: tokenStatus("") };
  },

  /**
   * The cached written read for the current selection, if there is one.
   *
   * Read-only — it never calls the gateway. The view needs this because the
   * narrative lives in service-worker storage but the panel only held it in
   * memory: route away and back and the read was still on screen from cache,
   * but the PDF quietly omitted it.
   */
  async getNarrative(msg = {}) {
    const [settings, comments] = await Promise.all([store.readSettings(), store.readComments()]);
    if (!comments?.records?.length) return { ok: true, narrative: null };

    const storeNbr = await resolveStore();
    const prefs = { ...(await store.readPrefs()), ...(msg.filters ?? {}) };
    const scores = await store.readScores();
    const analysis = buildAnalysis(comments.records, {
      filters: { journeys: prefs.journeys, channels: prefs.channels },
      windowDays: prefs.windowDays,
      scores,
    });
    const fingerprint = narrativeFingerprint(analysis, { storeNbr, model: settings.gatewayModel });
    return { ok: true, narrative: await store.readNarrative(fingerprint) };
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
  broadcast("refresh_start", { mode, storeNbr });

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
    // Paint the scorecard now rather than at the end of the pull. The graded
    // numbers arrive in a couple of seconds; the comments take minutes, and
    // there is no reason to stare at an empty page in between.
    broadcast("scores_ready");
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
      onProgress: (p) => broadcast("refresh_progress", { ...p, phase: "comments" }),
    }));

    const merged = await store.mergeComments(storeNbr, pull.records, {
      from: full ? from : (existing?.from ?? from),
      to: maxDay(pull.records) ?? existing?.to ?? today,
      total: pull.total,
    });

    // Medallia worked, so the 50-row stopgap is stale by definition.
    await store.clearFallbackComments();

    outcome.medallia = {
      ok: true, fetched: pull.records.length, added: merged.added,
      held: merged.records.length, pages: pull.pages, total: pull.total,
      window: { from: merged.from, to: merged.to }, full,
      // Non-zero means a Medallia tab froze and had to be replaced mid-pull.
      // Reported because a slow-but-successful pull should not read the same as
      // a clean one.
      reanchors: pull.reanchors ?? 0,
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
      await store.writeFallbackComments(storeNbr, rows);
      outcome.fallbackComments = { ok: true, count: rows.length };
    } catch {
      outcome.fallbackComments = { ok: false };
    }
  }

  outcome.ok = !!(outcome.hoops?.ok || outcome.medallia?.ok);
  await store.writeLastRun(outcome);
  broadcast("refresh_done", { outcome });
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

/**
 * The market to read.
 *
 * Settings first, but a missing home market is not worth blocking on: the
 * roster already says which market a store belongs to, so a user whose home
 * store is set gets the right answer without a detour through Settings. Only a
 * store in no known roster actually needs asking.
 */
async function resolveMarket() {
  try {
    const set = await getUserHomeMarket();
    if (set) return set;
  } catch { /* fall through to the roster */ }

  const home = await resolveStore();
  if (!home) return null;
  for (const [market, stores] of Object.entries(MARKET_ROSTERS)) {
    if (stores.some((s) => String(s) === String(home))) return market;
  }
  return null;
}

function redactSettings(settings) {
  const { gatewayToken, ...rest } = settings;
  return {
    ...rest,
    gatewayTokenSet: !!gatewayToken,
    gatewayTokenStatus: tokenStatus(gatewayToken),
    // Shown in Settings so what we send is visible rather than buried.
    gatewayClientVersionEffective: settings.gatewayClientVersion || DEFAULT_CLIENT_VERSION,
  };
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
