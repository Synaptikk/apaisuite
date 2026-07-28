// modules/metricshot/service.js
//
// Service-worker side of the Metric Screenshot Scheduler.
//
// Responsibilities:
//   1. Store + serve the metrics config (list, save, delete, toggle).
//   2. Fire a 1-minute alarm; on each tick, for each enabled metric, expand
//      due runs, consult the dedupe map, and post any new run.
//   3. Provide handlers for the view.js UI (run-now, preview, probe-destination).
//   4. Keep per-metric lastStatus / lastSuccess in chrome.storage.local so
//      the UI can render without polling.
//   5. Emit sanitized log entries via shared/logging.js.
//
// Storage layout (all keys manually prefixed with "metricshot." per
// docs/AI_CONTEXT_BRIEF.md::4 — service.js does not get a host object):
//
//   chrome.storage.sync
//     metricshot.metrics       — array of metric configs (small; syncs)
//
//   chrome.storage.local
//     metricshot.postedRuns    — { [runKey]: { status, at, path?, messageId?, error? } }
//                                capped at 500 most-recent keys
//     metricshot.lastStatus.<id>   — most recent run status per metric
//     metricshot.lastSuccess.<id>  — most recent successful post per metric
//     metricshot.lastPreview.<id>  — { pngBase64, at, width, height } (UI cache)

import { SEED_METRICS, SEED_URL_MIGRATIONS } from "./data/defaults.js";
import { normalizeMetric, readyForSave, validateMetric, shortScheduleSummary, metricNeedsStore, migrationMatches } from "./lib/metrics.js";
import { expandDueRuns, nextRun, isFirstOfDay, partsInZone, resolveZone } from "./lib/scheduler.js";
import { captureMetric } from "./lib/capture.js";
import { postScreenshotToWorkvivo, postTextToWorkvivo, resolveChannel } from "./lib/sendbird.js";
import { validatePngBytes, base64ToBytes } from "./lib/validate.js";
import { scrapeVizPick } from "./lib/sources/vizpick_scrape.js";
import { formatUnscannedMessage } from "./lib/format_message.js";
import { createLogging } from "../../shared/logging.js";
import { getUserHomeStore } from "../../shared/userStore.js";

const MODULE_ID    = "metricshot";
const PFX          = `${MODULE_ID}.`;
const ALARM_NAME   = "metricshot.tick";
const TICK_PERIOD_MIN = 1;
const MAX_POSTED_RUNS = 500;

const log = createLogging(MODULE_ID);

// In-flight metric ids — SW-lifetime lock preventing overlapping ticks for
// the same metric. Restart clears this; the dedupe map is the durable
// "already posted" record.
const _running = new Set();

// ── Storage helpers ──────────────────────────────────────────────────────

async function loadMetrics() {
  const got = await chrome.storage.sync.get(`${PFX}metrics`);
  const arr = got[`${PFX}metrics`];
  return Array.isArray(arr) ? arr.map(normalizeMetric) : [];
}

async function saveMetrics(list) {
  await chrome.storage.sync.set({ [`${PFX}metrics`]: list.map(normalizeMetric) });
}

async function loadPostedRuns() {
  const got = await chrome.storage.local.get(`${PFX}postedRuns`);
  return got[`${PFX}postedRuns`] || {};
}

async function markPostedRun(runKey, entry) {
  const map = await loadPostedRuns();
  map[runKey] = entry;
  // Trim to MAX_POSTED_RUNS most-recent by `at`.
  const keys = Object.keys(map);
  if (keys.length > MAX_POSTED_RUNS) {
    const sorted = keys.sort((a, b) => (map[b]?.at || 0) - (map[a]?.at || 0));
    const keep = new Set(sorted.slice(0, MAX_POSTED_RUNS));
    for (const k of keys) if (!keep.has(k)) delete map[k];
  }
  await chrome.storage.local.set({ [`${PFX}postedRuns`]: map });
}

async function writeStatus(metricId, status) {
  await chrome.storage.local.set({ [`${PFX}lastStatus.${metricId}`]: status });
  if (status?.ok) {
    await chrome.storage.local.set({ [`${PFX}lastSuccess.${metricId}`]: {
      at: status.at,
      channelUrl: status.channelUrl,
      messageId: status.messageId,
    }});
  }
  chrome.runtime.sendMessage({
    module: MODULE_ID,
    type: "status-changed",
    id: metricId,
    status,
  }).catch(() => {});
}

async function readStatus(metricId) {
  const got = await chrome.storage.local.get([
    `${PFX}lastStatus.${metricId}`,
    `${PFX}lastSuccess.${metricId}`,
  ]);
  return {
    lastStatus:  got[`${PFX}lastStatus.${metricId}`]  || null,
    lastSuccess: got[`${PFX}lastSuccess.${metricId}`] || null,
  };
}

// ── Seed installation (idempotent) ───────────────────────────────────────

async function ensureSeed() {
  const current = await loadMetrics();
  if (current.length > 0) {
    // Migrate any stored copies of an older, known-broken seed.
    //
    // A migration entry describes ONE specific broken state. ALL of its
    // specified fingerprint keys must match for it to fire (AND semantics).
    // Using OR here was a bug: v0.1.2 lists the *current* URL as `fromUrl`,
    // so an OR match re-fired on every SW restart and wiped the user's
    // capture block (incl. their saved crop) back to seed defaults.
    let mutated = false;
    for (const migration of SEED_URL_MIGRATIONS) {
      for (const seed of SEED_METRICS) {
        const existing = current.find((m) => m.id === seed.id);
        if (!existing) continue;

        // Only fire if ALL of this migration's specified fingerprint keys
        // match (see metrics.js::migrationMatches for the why).
        if (migrationMatches(migration, existing)) {
          existing.url = seed.url;
          // Full replace of capture block on migration — old fields we no
          // longer use (like requiredSelector defaults from prior seed) get
          // wiped, and new fields (clip, containText, region mode) land.
          existing.capture = { ...seed.capture };
          mutated = true;
          log.emit("migrated-seed", { id: seed.id, from: migration.fromUrl || migration.fromRequiredSelector || `mode=${migration.fromCaptureMode}` });
        }
      }
    }
    if (mutated) await saveMetrics(current);
    return;
  }
  const marker = await chrome.storage.local.get(`${PFX}seededOnce`);
  if (marker[`${PFX}seededOnce`]) return;                                   // user emptied — respect that
  await saveMetrics(SEED_METRICS);
  await chrome.storage.local.set({ [`${PFX}seededOnce`]: Date.now() });
  log.emit("seeded", { count: SEED_METRICS.length });
}

// ── Alarm ────────────────────────────────────────────────────────────────

export async function installTickAlarm() {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (existing) return;                                                    // preserve schedule across resumes
  await chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 0.5,
    periodInMinutes: TICK_PERIOD_MIN,
  });
}

export async function clearTickAlarm() {
  await chrome.alarms.clear(ALARM_NAME);
}

// Registered at top-level in module.js so Chrome wakes the SW on the alarm.
export function onAlarm(alarm) {
  if (alarm?.name !== ALARM_NAME) return;
  tick().catch((err) => {
    console.error("[metricshot] tick threw:", err);
    log.emit("tick-error", { error: String(err?.message ?? err) });
  });
}

async function tick() {
  const at = Date.now();
  const [metrics, postedRuns] = await Promise.all([loadMetrics(), loadPostedRuns()]);
  const ran = [];
  const skipped = [];

  await Promise.all(metrics.filter((m) => m.enabled).map(async (metric) => {
    if (_running.has(metric.id)) {
      skipped.push({ id: metric.id, reason: "in-flight" });
      return;
    }
    const due = expandDueRuns(metric, at);
    for (const run of due) {
      if (postedRuns[run.runKey]) {
        skipped.push({ id: metric.id, runKey: run.runKey, reason: "already-posted" });
        continue;
      }
      if (run.stale) {
        await markPostedRun(run.runKey, { status: "skipped-stale", at, ageMs: run.ageMs });
        skipped.push({ id: metric.id, runKey: run.runKey, reason: "stale" });
        log.emit("skipped-stale", { id: metric.id, runKey: run.runKey, ageMs: run.ageMs });
        continue;
      }
      // Runnable. Acquire per-metric lock + fire.
      if (_running.has(metric.id)) {
        skipped.push({ id: metric.id, runKey: run.runKey, reason: "in-flight" });
        break;
      }
      _running.add(metric.id);
      try {
        await runOne(metric, { reason: "scheduled", runKey: run.runKey, scheduledAt: run.scheduledAt });
        ran.push({ id: metric.id, runKey: run.runKey });
      } catch (err) {
        log.emit("run-threw", { id: metric.id, runKey: run.runKey, error: String(err?.message ?? err) });
      } finally {
        _running.delete(metric.id);
      }
      // One run per metric per tick — the next due run (rare — only in
      // catch-up scenarios) fires on the next tick.
      break;
    }
  }));

  chrome.runtime.sendMessage({
    module: MODULE_ID, type: "tick", at, ran, skipped,
  }).catch(() => {});
}

// ── The run pipeline ─────────────────────────────────────────────────────

/**
 * Capture + validate + post. Owns retries. Writes status + dedupe entry.
 * Never throws — returns { ok, ... } for the caller.
 */
async function runOne(metric, { reason, runKey, scheduledAt }) {
  const at = Date.now();
  const store = await getUserHomeStore().catch(() => null);
  const cap = metric.capture || {};

  // Store-required guard: if this metric injects templated parameter values
  // (e.g. {{HOME_STORE}}) but no valid store is resolved, abort before
  // spinning up a capture tab. Otherwise Tableau would render its default
  // store ("1") and we'd post a blank report. capture.js also guards this,
  // but skipping early is cheaper and yields a clearer status.
  if (metricNeedsStore(metric) && !/^\d{1,5}$/.test(String(store ?? "").trim())) {
    const status = {
      ok: false, at,
      error: "no store set — set your store in Settings → Defaults",
      reason: "store-required",
    };
    log.emit("run-skipped", { id: metric.id, reason: "store-required", runKey });
    await writeStatus(metric.id, status);
    return status;
  }

  const retries = Math.max(0, cap.retries ?? 2);

  let lastFail = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    log.emit("run-start", { id: metric.id, reason, runKey, attempt, store });
    const captureRes = await captureMetric(metric);
    if (!captureRes.ok) {
      lastFail = { stage: "capture", reason: captureRes.reason, attempt };
      log.emit("capture-failed", { id: metric.id, attempt, reason: captureRes.reason });
      // No point retrying an auth wall — the tab needs user attention.
      if (/auth wall|login|access[- ]denied|not authorized/i.test(String(captureRes.reason))) break;
      continue;
    }

    // Validate PNG shape + size.
    const bytes = base64ToBytes(captureRes.pngBase64);
    const v = validatePngBytes(bytes);
    if (!v.ok) {
      lastFail = { stage: "validate", reason: v.reason, attempt };
      log.emit("validate-failed", { id: metric.id, attempt, reason: v.reason, bytes: bytes.length });
      continue;
    }

    // Cache the preview (last successful capture, even if the post fails).
    await chrome.storage.local.set({
      [`${PFX}lastPreview.${metric.id}`]: {
        pngBase64: captureRes.pngBase64,
        at: captureRes.capturedAt,
        width: v.width, height: v.height,
      },
    });

    // Post to Workvivo/Sendbird.
    const localWhen = formatLocal(scheduledAt || captureRes.capturedAt, metric.timezone);
    const fileName  = `${metric.id}-${fileTimestamp(captureRes.capturedAt)}.png`;
    const captionLines = [
      metric.name,
      metric.caption?.trim() || null,
      `Captured: ${localWhen}`,
    ].filter(Boolean);
    const post = await postScreenshotToWorkvivo({
      channelName: metric.destination?.channelName,
      pngBase64:   captureRes.pngBase64,
      fileName,
      caption:     captionLines.join("\n"),
    });

    if (!post.ok) {
      lastFail = { stage: "post", reason: post.error, class: post.errorClass, attempt };
      log.emit("post-failed", {
        id: metric.id, attempt,
        errorClass: post.errorClass, error: safeShort(post.error),
        path: post.path,
      });
      // AUTH failures won't recover on retry — the Sendbird session is stale.
      if (post.errorClass === "AUTH") break;
      // NOT_FOUND won't self-heal within a tick either.
      if (post.errorClass === "NOT_FOUND") break;
      continue;
    }

    // Cache the resolved channelUrl back onto the metric config so the UI
    // can display it and future runs don't need to re-list.
    if (post.channelUrl) {
      const list = await loadMetrics();
      const idx = list.findIndex((m) => m.id === metric.id);
      if (idx >= 0) {
        list[idx].destination = {
          ...list[idx].destination,
          channelUrl: post.channelUrl,
          resolvedAt: Date.now(),
        };
        await saveMetrics(list);
      }
    }

    const status = {
      ok: true,
      at: Date.now(),
      reason,
      runKey,
      channelUrl: post.channelUrl,
      messageId: post.messageId,
      path: post.path,
      capturedAt: captureRes.capturedAt,
      width: v.width, height: v.height,
      store,
    };

    // Follow-up text message on non-first-of-day slots. Only for VizPick
    // (identified by the scrapeVizPick source). Skipped silently on manual
    // "Run now" because there's no scheduled dow/hhmm context.
    if (reason === "scheduled" && scheduledAt) {
      const zone = resolveZone(metric.timezone);
      const parts = partsInZone(scheduledAt, zone);
      const hhmm = `${String(parts.hh).padStart(2,"0")}:${String(parts.mm).padStart(2,"0")}`;
      const first = isFirstOfDay(metric, parts.dow, hhmm);
      const wantsExtras = metric.destination?.type === "workvivo-sendbird"
        && metric.id === "vizpick-score"                                    // scoped to VizPick for now
        && !first;
      if (wantsExtras) {
        const followUp = await _sendVizPickFollowUp(metric, status);
        status.followUp = followUp;
      } else {
        status.followUp = { skipped: first ? "first-of-day" : "not-applicable" };
      }
    }

    await Promise.all([
      writeStatus(metric.id, status),
      runKey ? markPostedRun(runKey, {
        status: "ok", at: status.at, path: post.path, messageId: post.messageId,
        followUp: status.followUp || null,
      }) : Promise.resolve(),
    ]);
    log.emit("post-ok", {
      id: metric.id, runKey, path: post.path, messageId: post.messageId,
      channelUrlSuffix: post.channelUrl ? post.channelUrl.slice(-6) : null,
      followUpOk: status.followUp?.ok ?? null,
    });
    return status;
  }

  const status = {
    ok: false,
    at: Date.now(),
    reason,
    runKey,
    stage: lastFail?.stage,
    error: safeShort(lastFail?.reason),
    errorClass: lastFail?.class || null,
    attempts: retries + 1,
    store,
  };
  await writeStatus(metric.id, status);
  // Do NOT mark postedRuns[runKey] on failure — we want the next tick to
  // retry (as long as it's still within catchUpWindowMs). If the run goes
  // stale, next tick's `run.stale` will mark it skipped.
  return status;
}

// ── VizPick follow-up (scrape + text message) ────────────────────────────

/**
 * After a successful image post at 2pm/8pm, scrape the VizPick VizQL response
 * still sitting in the tab's content-script ring, format a follow-up text
 * message, and post it to the same channel. Failures are surfaced in the run
 * status but never block the primary post.
 */
async function _sendVizPickFollowUp(metric, priorStatus) {
  try {
    const scrape = await scrapeVizPick();
    if (!scrape.ok) {
      log.emit("followup-scrape-failed", {
        id: metric.id, errorClass: scrape.errorClass,
        error: safeShort(scrape.error),
      });
      return { ok: false, stage: "scrape", errorClass: scrape.errorClass, error: safeShort(scrape.error) };
    }
    const text = formatUnscannedMessage({
      metricName: metric.name,
      at: priorStatus.at,
      timezone: metric.timezone,
      locationDetails: scrape.locationDetails,
      departmentBreakout: scrape.departmentBreakout,
    });
    if (!text) {
      log.emit("followup-nothing-to-send", { id: metric.id });
      return { ok: true, skipped: "nothing-to-report" };
    }
    const post = await postTextToWorkvivo({
      channelName: metric.destination?.channelName,
      text,
    });
    if (!post.ok) {
      log.emit("followup-post-failed", {
        id: metric.id, errorClass: post.errorClass, path: post.path,
        error: safeShort(post.error),
      });
      return { ok: false, stage: "post", errorClass: post.errorClass, error: safeShort(post.error) };
    }
    log.emit("followup-post-ok", {
      id: metric.id, path: post.path, messageId: post.messageId,
      bins: scrape.locationDetails?.length ?? 0,
      depts: scrape.departmentBreakout?.length ?? 0,
    });
    return { ok: true, path: post.path, messageId: post.messageId };
  } catch (e) {
    log.emit("followup-threw", { id: metric.id, error: String(e?.message ?? e) });
    return { ok: false, stage: "exception", error: String(e?.message ?? e) };
  }
}

// ── Public handler surface (RPCs from view.js) ───────────────────────────

export const handlers = {
  async "list-metrics"() {
    const metrics = await loadMetrics();
    return {
      ok: true,
      metrics: await Promise.all(metrics.map(async (m) => ({
        ...m,
        summary: shortScheduleSummary(m),
        ...(await readStatus(m.id)),
        next: nextRun(m),
      }))),
      home: await getUserHomeStore().catch(() => null),
    };
  },

  async "save-metric"(msg) {
    const list = await loadMetrics();
    const proposed = readyForSave(msg.metric || {}, list);
    const v = validateMetric(proposed, { existing: list });
    if (!v.ok) return { ok: false, error: v.errors.join("; ") };
    const idx = list.findIndex((m) => m.id === v.normalized.id);
    if (idx >= 0) list[idx] = v.normalized; else list.push(v.normalized);
    await saveMetrics(list);
    log.emit("saved-metric", { id: v.normalized.id, isNew: idx < 0 });
    return { ok: true, id: v.normalized.id };
  },

  async "delete-metric"(msg) {
    const id = String(msg?.id || "");
    const list = await loadMetrics();
    const next = list.filter((m) => m.id !== id);
    if (next.length === list.length) return { ok: false, error: `no metric with id ${id}` };
    await saveMetrics(next);
    await chrome.storage.local.remove([
      `${PFX}lastStatus.${id}`,
      `${PFX}lastSuccess.${id}`,
      `${PFX}lastPreview.${id}`,
    ]);
    log.emit("deleted-metric", { id });
    return { ok: true };
  },

  async "set-enabled"(msg) {
    const id = String(msg?.id || "");
    const enabled = !!msg?.enabled;
    const list = await loadMetrics();
    const idx = list.findIndex((m) => m.id === id);
    if (idx < 0) return { ok: false, error: "not found" };
    list[idx].enabled = enabled;
    await saveMetrics(list);
    log.emit("set-enabled", { id, enabled });
    return { ok: true };
  },

  // Persist a crop adjustment from the preview crop tool. `padding` insets
  // (may be negative) are applied on top of the anchor region at capture time.
  async "set-crop"(msg) {
    const id = String(msg?.id || "");
    const p = msg?.padding || {};
    const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
    const list = await loadMetrics();
    const idx = list.findIndex((m) => m.id === id);
    if (idx < 0) return { ok: false, error: "not found" };
    // Defense-in-depth: absurdly large negative insets collapse the capture
    // region below the min size (validate.js rejects <100px), which leaves
    // the user unable to open the preview to fix it. Cap each inset so the
    // client crop math can't brick a metric.
    const cap = (v) => Math.max(-2000, num(v));
    list[idx].capture = {
      ...list[idx].capture,
      padding: { top: cap(p.top), right: cap(p.right), bottom: cap(p.bottom), left: cap(p.left) },
    };
    await saveMetrics(list);
    log.emit("set-crop", { id, padding: list[idx].capture.padding });
    return { ok: true, padding: list[idx].capture.padding };
  },

  async "run-now"(msg) {
    const id = String(msg?.id || "");
    const list = await loadMetrics();
    const metric = list.find((m) => m.id === id);
    if (!metric) return { ok: false, error: "not found" };
    if (_running.has(id)) return { ok: false, error: "a run is already in flight for this metric" };
    _running.add(id);
    try {
      const runKey = `${id}:manual-${Date.now()}`;
      const status = await runOne(metric, { reason: "manual", runKey, scheduledAt: Date.now() });
      // Manual run counts as a posted-runs entry so it appears in history.
      if (status.ok) await markPostedRun(runKey, { status: "ok-manual", at: status.at, path: status.path, messageId: status.messageId });
      return { ok: true, status };
    } finally {
      _running.delete(id);
    }
  },

  async "preview"(msg) {
    const id = String(msg?.id || "");
    const list = await loadMetrics();
    const metric = list.find((m) => m.id === id);
    if (!metric) return { ok: false, error: "not found" };
    log.emit("preview-start", { id });
    try {
      // Watchdog: captureMetric is documented as "never throws", but a hung
      // CDP/debugger await can stall it forever (symptom: preview-start with
      // no completion line). Race it against a timeout so we ALWAYS resolve.
      const WATCHDOG_MS = 90_000;
      let watchdog;
      const timeout = new Promise((resolve) => {
        watchdog = setTimeout(() => resolve({ __timedOut: true }), WATCHDOG_MS);
      });
      const res = await Promise.race([
        captureMetric(metric, {
          onStep: (name, extra) => log.emit("preview-step", { id, step: name, ...(extra || {}) }),
        }),
        timeout,
      ]);
      clearTimeout(watchdog);
      if (res && res.__timedOut) {
        log.emit("preview-failed", { id, reason: `capture hung > ${WATCHDOG_MS / 1000}s (see last preview-step)` });
        return { ok: false, error: `capture timed out after ${WATCHDOG_MS / 1000}s — check the last preview-step in the log` };
      }
      if (!res.ok) {
        log.emit("preview-failed", { id, reason: res.reason });
        return { ok: false, error: res.reason };
      }
      const v = validatePngBytes(base64ToBytes(res.pngBase64));
      if (!v.ok) {
        log.emit("preview-failed", { id, reason: `validation: ${v.reason}` });
        return { ok: false, error: `validation: ${v.reason}` };
      }
      await chrome.storage.local.set({
        [`${PFX}lastPreview.${id}`]: {
          pngBase64: res.pngBase64,
          at: res.capturedAt,
          width: v.width, height: v.height,
        },
      });

      // Also assemble the follow-up text (VizPick-only for now) so the user can
      // eyeball what 2pm/8pm would post alongside the image. This runs after
      // the screenshot — the tab is already loaded + primed, so scrape reads
      // whatever's in the capture ring.
      let followUp = null;
      if (metric.id === "vizpick-score") {
        const scrape = await scrapeVizPick().catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
        if (scrape.ok) {
          const text = formatUnscannedMessage({
            metricName: metric.name,
            at: res.capturedAt,
            timezone: metric.timezone,
            locationDetails: scrape.locationDetails,
            departmentBreakout: scrape.departmentBreakout,
          });
          followUp = {
            ok: true,
            text,
            binsCount: scrape.locationDetails?.length ?? 0,
            deptsCount: scrape.departmentBreakout?.length ?? 0,
          };
        } else {
          followUp = { ok: false, errorClass: scrape.errorClass, error: scrape.error };
          // Stash the raw captured response so we can inspect Tableau's actual
          // shape and fix the parser. Retrievable via the "get-scrape-debug"
          // RPC / exposed in the UI. Only the first ~64KB to stay under quota.
          try {
            const dbg = scrape.debug || {};
            await chrome.storage.local.set({
              [`${PFX}scrapeDebug.${id}`]: {
                at: Date.now(),
                errorClass: scrape.errorClass,
                error: scrape.error,
                capturedUrl: dbg.capturedUrl || null,
                respBodyPreview: (dbg.respBodyPreview || "").slice(0, 65_536),
                ringSummary: dbg.ringSummary || null,
              },
            });
            log.emit("scrape-debug-saved", { id, errorClass: scrape.errorClass, hasBody: !!dbg.respBodyPreview });
          } catch (_) { /* quota / serialization — ignore */ }
        }
      }

      log.emit("preview-ok", { id, width: v.width, height: v.height, followUpOk: followUp?.ok ?? null });
      return {
        ok: true,
        pngBase64: res.pngBase64,
        width: v.width, height: v.height,
        at: res.capturedAt,
        followUp,
        // Crop-tool inputs: the absolute box we captured, the anchor region
        // before padding, and the padding currently applied.
        clipUsed: res.clipUsed || null,
        anchorRegion: res.anchorRegion || null,
        padding: metric.capture?.padding || null,
      };
    } catch (e) {
      // Never let a thrown capture error swallow the preview silently — that
      // showed up as a "preview-start" with no matching completion line.
      const reason = String(e?.message ?? e);
      log.emit("preview-failed", { id, reason });
      return { ok: false, error: reason };
    }
  },

  // Retrieve the last saved scrape-debug blob (raw Tableau response preview)
  // so the parser can be fixed against real data.
  async "get-scrape-debug"(msg) {
    const id = String(msg?.id || "");
    const got = await chrome.storage.local.get(`${PFX}scrapeDebug.${id}`);
    return { ok: true, debug: got[`${PFX}scrapeDebug.${id}`] || null };
  },

  async "get-preview"(msg) {
    const id = String(msg?.id || "");
    const got = await chrome.storage.local.get(`${PFX}lastPreview.${id}`);
    return { ok: true, preview: got[`${PFX}lastPreview.${id}`] || null };
  },

  async "probe-destination"(msg) {
    const id = String(msg?.id || "");
    const list = await loadMetrics();
    const metric = list.find((m) => m.id === id);
    if (!metric) return { ok: false, error: "not found" };
    const r = await resolveChannel(metric.destination?.channelName || "");
    if (r.ok) {
      // Cache the resolved channelUrl.
      const idx = list.findIndex((m) => m.id === id);
      if (idx >= 0) {
        list[idx].destination = { ...list[idx].destination, channelUrl: r.channelUrl, resolvedAt: Date.now() };
        await saveMetrics(list);
      }
    }
    return {
      ok: r.ok,
      matched: r.ok ? r.name : null,
      channelUrlSuffix: r.channelUrl ? r.channelUrl.slice(-6) : null,
      error: r.error, errorClass: r.errorClass,
    };
  },

  async "get-log"(msg) {
    const limit = Math.max(1, Math.min(500, Number(msg?.limit ?? 100)));
    const entries = await log.read({ limit });
    return { ok: true, entries };
  },

  async "get-tick-state"() {
    const alarm = await chrome.alarms.get(ALARM_NAME);
    return {
      ok: true,
      alarmScheduledAt: alarm?.scheduledTime || null,
      alarmPeriodMin:   alarm?.periodInMinutes || null,
    };
  },

  // Debug: probe the VizQL scrape without posting. Returns the parsed rows +
  // a truncated raw-body preview so the parser can be tuned against real data.
  async "debug-scrape"() {
    const scrape = await scrapeVizPick();
    return { ok: true, scrape };
  },

  // Debug: preview the follow-up text without posting. Useful for eyeballing
  // format before enabling on the scheduled slots.
  async "debug-followup-text"(msg) {
    const id = String(msg?.id || "");
    const list = await loadMetrics();
    const metric = list.find((m) => m.id === id);
    if (!metric) return { ok: false, error: "not found" };
    const scrape = await scrapeVizPick();
    if (!scrape.ok) return { ok: false, error: scrape.error, errorClass: scrape.errorClass, scrape };
    const text = formatUnscannedMessage({
      metricName: metric.name,
      at: Date.now(),
      timezone: metric.timezone,
      locationDetails: scrape.locationDetails,
      departmentBreakout: scrape.departmentBreakout,
    });
    return { ok: true, text, scrape };
  },
};

// ── Init hook (called from module.js::register) ──────────────────────────

export async function register() {
  await ensureSeed();
  await installTickAlarm();
}

// ── Utilities ────────────────────────────────────────────────────────────

function formatLocal(epochMs, zone) {
  const opts = { dateStyle: "medium", timeStyle: "short" };
  if (zone && zone !== "local") opts.timeZone = zone;
  try { return new Intl.DateTimeFormat([], opts).format(new Date(epochMs)); }
  catch { return new Date(epochMs).toString(); }
}

function fileTimestamp(epochMs) {
  const d = new Date(epochMs);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}`;
}

function safeShort(s) {
  return String(s || "").slice(0, 200);
}
