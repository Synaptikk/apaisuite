// modules/metricshot/lib/email_jobs.js
//
// Scheduled "report" metrics: build a report the way its own module's button
// does, then email it (Outlook on the web, shared/outlook_send.js) and post it
// to a Workvivo channel. Two kinds:
//
//   kind "closinglist"    — the Closing List email text for TODAY.
//   kind "vizpick-email"  — the VizPick ✉ report image for one store. Each
//                           schedule slot says which day: reportDay
//                           "previous" (yesterday's closed day) or "current"
//                           (Today, refreshed for that store first).
//
// Building is delegated to the module's own view, opened headless in a
// background suite tab (app.html?<param>=<job json>#/<route>). The view writes
// its result to chrome.storage.local["metricshot.reportJob.<id>"]. That keeps
// one copy of each report's logic — the same names, filters, IVR merge and
// image the person gets from the button.
//
// Parts (email, workvivo) are tracked separately so a retry after a failed
// Workvivo post does not email the group a second time.

import { sendOutlookMail } from "../../../shared/outlook_send.js";
import { postScreenshotToWorkvivo, postTextToWorkvivo } from "./sendbird.js";
import { ensureTodayRowForStore } from "../../vizpick/lib/ensure_today_store.js";
import { handlers as vizpickHandlers } from "../../vizpick/service.js";
import { partsInZone } from "./scheduler.js";

export const JOB_KINDS = new Set(["closinglist", "vizpick-email"]);

const VIEW_JOB_TIMEOUT_MS = { closinglist: 6 * 60_000, "vizpick-email": 3 * 60_000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Open the module view headless and wait for the result it stores. */
export async function runViewJob({ route, param, job, timeoutMs }) {
  const key = `metricshot.reportJob.${job.id}`;
  await chrome.storage.local.remove(key);
  const url = chrome.runtime.getURL(`app.html?${param}=${encodeURIComponent(JSON.stringify(job))}#/${route}`);
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await sleep(1000);
      const got = (await chrome.storage.local.get(key))[key];
      if (got) return got;
      if (!(await chrome.tabs.get(tab.id).then(() => true, () => false))) {
        return { ok: false, error: `${route} report tab was closed` };
      }
    }
    return { ok: false, error: `${route} report timed out after ${Math.round(timeoutMs / 1000)}s` };
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
    await chrome.storage.local.remove(key).catch(() => {});
  }
}

/** YYYY-MM-DD of the day before `epochMs` in `zone`. */
export function previousDay(epochMs, zone) {
  const today = partsInZone(epochMs, zone).yyyyMMdd;
  for (let h = 12; h <= 36; h += 6) {
    const d = partsInZone(epochMs - h * 3_600_000, zone).yyyyMMdd;
    if (d !== today) return d;
  }
  return partsInZone(epochMs - 86_400_000, zone).yyyyMMdd;
}

/** "Wed 10/7" for a YYYY-MM-DD. */
export function dayLabel(ymd) {
  const [y, m, d] = String(ymd).split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return `${dt.toLocaleDateString("en-US", { weekday: "short" })} ${m}/${d}`;
}

/** Which day a vizpick-email slot reports on: the schedule entry's reportDay. */
export function reportDayFor(metric, hhmm) {
  const s = (metric.schedules || []).find((x) => x.time === hhmm);
  return s?.reportDay === "current" ? "current" : "previous";
}

/**
 * Build + deliver one report. Never throws.
 * @param {object} metric
 * @param {object} ctx { scheduledAt, hhmm, store, priorParts, reportDay?, onStep }
 * @returns {Promise<{ok:boolean, parts:object, stage?:string, error?:string, subject?:string}>}
 */
export async function runReportMetric(metric, ctx) {
  const step = (name, extra) => { try { ctx.onStep?.(name, extra); } catch { /* ignore */ } };
  const parts = { ...(ctx.priorParts || {}) };
  const zone = metric.timezone;
  const at = ctx.scheduledAt || Date.now();
  const wantEmail = !!metric.email?.to;
  const wantWv = !!metric.destination?.channelName;

  try {
    let built;
    if (metric.kind === "closinglist") {
      step("build", { kind: "closinglist" });
      built = await runViewJob({ route: "closinglist", param: "clReport", job: { id: `${metric.id}-${at}` }, timeoutMs: VIEW_JOB_TIMEOUT_MS.closinglist });
      if (!built.ok) return { ok: false, parts, stage: "build", error: built.error };
      built.emailText = built.text;
      built.wvText = `${built.subject}\n\n${built.text}`;
    } else {
      const which = ctx.reportDay || (ctx.hhmm ? reportDayFor(metric, ctx.hhmm) : "previous");
      const store = String(ctx.store || "").trim();
      if (!/^\d{1,5}$/.test(store)) return { ok: false, parts, stage: "build", error: "no home store set" };
      const day = which === "current" ? "today" : previousDay(at, zone);
      if (which === "current") {
        step("refresh-today", { store });
        // 30 min: a 4:45 report should not be the 3:00 numbers.
        await ensureTodayRowForStore(store, { maxAgeMs: 30 * 60_000 }).catch(() => null);
      }
      const job = { id: `${metric.id}-${at}`, store, day };
      step("build", { kind: "vizpick", day });
      built = await runViewJob({ route: "vizpick", param: "vpReport", job, timeoutMs: VIEW_JOB_TIMEOUT_MS["vizpick-email"] });
      if (!built.ok && which === "previous" && /no closed-day/i.test(built.error || "")) {
        // Yesterday's summary not pulled yet — pull it once and try again.
        step("pull-yesterday");
        await vizpickHandlers.pull_stores({}).catch(() => null);
        built = await runViewJob({ route: "vizpick", param: "vpReport", job: { ...job, id: `${job.id}-r` }, timeoutMs: VIEW_JOB_TIMEOUT_MS["vizpick-email"] });
      }
      if (!built.ok) return { ok: false, parts, stage: "build", error: built.error };
      const when = which === "current"
        ? `${dayLabel(partsInZone(at, zone).yyyyMMdd)} ${new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} (current day)`
        : `${dayLabel(day)} (previous day)`;
      built.subject = `VizPick — Store ${store} — ${when}`;
      built.emailText = which === "current"
        ? `VizPick for store ${store} as of ${when.replace(" (current day)", "")}.`
        : `VizPick for store ${store}, ${dayLabel(day)} (closed day).`;
    }

    if (wantEmail && !parts.email) {
      step("email");
      const images = built.pngBase64 ? [{ base64: built.pngBase64, name: `vizpick-${ctx.store}.png` }] : [];
      const sent = await sendOutlookMail({ to: metric.email.to, subject: built.subject, text: built.emailText, images, onStep: (n) => step(`email:${n}`) });
      if (!sent.ok) return { ok: false, parts, stage: "email", error: sent.error, errorClass: sent.errorClass, subject: built.subject };
      parts.email = Date.now();
    }
    if (wantWv && !parts.workvivo) {
      step("workvivo");
      const post = built.pngBase64
        ? await postScreenshotToWorkvivo({
            channelName: metric.destination.channelName,
            pngBase64: built.pngBase64,
            fileName: `${metric.id}-${at}.png`,
            caption: built.subject,
          })
        : await postTextToWorkvivo({ channelName: metric.destination.channelName, text: built.wvText });
      if (!post.ok) return { ok: false, parts, stage: "workvivo", error: post.error, errorClass: post.errorClass, subject: built.subject };
      parts.workvivo = Date.now();
    }
    return { ok: true, parts, subject: built.subject };
  } catch (e) {
    return { ok: false, parts, stage: "exception", error: String(e?.message ?? e) };
  }
}
