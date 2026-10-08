// modules/safetyobs/service.js
//
// Safety Observations — two jobs (asked 2026-10-08):
//
//  1. Sentence → survey. The user types "Shane was observed in Fresh cleaning
//     a spill with a mop"; `parse` turns it into the QR-poster Microsoft
//     Form's answers (lib/parse.js rules, overlaid by the AI gateway when the
//     Cx module holds a live token), the panel shows them for a check, and
//     `submit` fills the real form in a background tab and presses Submit
//     (lib/form_fill.js). Submissions are the user's own: the form records the
//     signed-in account.
//
//  2. 4:45 PM coach check. Every day at CHECK time the alarm reads today's
//     schedule (Digital Metrics' WFM import, whole store, job titles), today's
//     observations per submitter (Field_Dashboard Power BI, the same report
//     the Live Dashboard reads), and @mentions in the "1458 management"
//     Workvivo chat each scheduled coach / Store Manager / Ops Manager with
//     fewer than 2 (lib/coach_check.js). Nothing is posted when nobody is short.
//     Needs the browser running at 4:45; a run more than LATE_LIMIT_MIN late
//     (machine asleep, browser closed) is skipped rather than posted stale.

import { QUESTIONS, FORM_URL, missingAnswers, LOCATIONS, PROCESSES, TOOLS, TYPES } from "./lib/form_schema.js";
import { FILL_FORM } from "./lib/form_fill.js";
import { PAGE_URL, RESPONSES_URL, readPageTokens, buildResponseBody, responseHeaders } from "./lib/form_api.js";
import { parseObservation, mergeAiPick } from "./lib/parse.js";
import { checkCoaches, buildMessage, buildLedger, isCheckedTitle, MIN_PER_DAY } from "./lib/coach_check.js";
import { fetchSubmitters } from "../livedashboard/lib/sources/recognition.js";
import { schedules } from "../digitalmetrics/lib/firestore.js";
import { postTextToWorkvivo, listChannelMembers } from "../metricshot/lib/sendbird.js";
import { readSettings as readCxSettings } from "../cx/lib/store.js";
import { tokenStatus, DEFAULT_CLIENT_VERSION } from "../cx/lib/narrative.js";
import { withKeepAwake } from "../../shared/sw_keepalive.js";
import { registerSessionTab, forgetSessionTab } from "../../shared/tabSessions.js";

const MODULE_ID = "safetyobs";
const KEY = {
  settings: "safetyobs.settings.v1",
  history:  "safetyobs.history.v1",    // last submissions, newest first
  check:    "safetyobs.lastCheck.v1",  // last coach-check result (preview or posted)
  posted:   "safetyobs.postedDay.v1",  // local date the 4:45 message last went out
  schedCache: "safetyobs.leaderLines.v1", // { dateIso: [leader lines] | "foreign-or-empty" marker }
  ledger:   "safetyobs.lastLedger.v1",
};
export const ALARM = "safetyobs.coachCheck";
const LATE_LIMIT_MIN = 45;
const HISTORY_MAX = 50;

export const DEFAULT_SETTINGS = Object.freeze({
  storeNbr: "1458",
  role: "Coach",
  channel: "1458 management",
  // Off until turned on in ONE browser: the suite is installed in both the
  // normal and the debug Edge, and each install would post its own 4:45 message.
  checkEnabled: false,
  checkAt: "16:45",
  useAi: true,
  // First day Digital Metrics holds a 1458 schedule doc; nothing earlier can
  // say who was scheduled, so the ledger cannot start before it.
  ledgerFrom: "2026-08-22",
});

const GATEWAY = "https://puppy-backend.walmart.com/anthropic/v1/messages";

// ── Settings / storage ─────────────────────────────────────────────

export async function readSettings() {
  const got = (await chrome.storage.local.get(KEY.settings))[KEY.settings] || {};
  return { ...DEFAULT_SETTINGS, ...got };
}

async function writeSettings(patch) {
  const next = { ...(await readSettings()), ...patch };
  await chrome.storage.local.set({ [KEY.settings]: next });
  return next;
}

const localDay = (d = new Date()) => d.toLocaleDateString("en-CA");
const parseHm = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : 16 * 60 + 45;
};

// ── Alarm: next CHECK time, rescheduled after every fire (DST-safe) ─

/** Next local occurrence of hh:mm, strictly after `from`. */
export function nextAt(hm, from = new Date()) {
  const min = parseHm(hm);
  const t = new Date(from);
  t.setHours(Math.floor(min / 60), min % 60, 0, 0);
  if (t <= from) t.setDate(t.getDate() + 1);
  return t.getTime();
}

export async function ensureCheckAlarm() {
  const s = await readSettings();
  const existing = await chrome.alarms.get(ALARM);
  if (!s.checkEnabled) { if (existing) await chrome.alarms.clear(ALARM); return null; }
  const when = nextAt(s.checkAt);
  // Not create() unconditionally: it would replace a pending alarm (shared/alarms.js BUG 1).
  if (existing && Math.abs(existing.scheduledTime - when) < 60_000) return existing.scheduledTime;
  await chrome.alarms.create(ALARM, { when });
  return when;
}

export async function onCheckAlarm(alarm) {
  if (alarm?.name !== ALARM) return;
  try {
    const s = await readSettings();
    if (!s.checkEnabled) return;
    const lateMin = (Date.now() - alarm.scheduledTime) / 60_000;
    const postedDay = (await chrome.storage.local.get(KEY.posted))[KEY.posted];
    if (postedDay === localDay()) return;                             // already posted today
    if (lateMin > LATE_LIMIT_MIN) {
      await saveCheck({ dateIso: localDay(), at: Date.now(), ok: false, skipped: `alarm fired ${Math.round(lateMin)} min late (browser closed or asleep at ${s.checkAt})` });
      return;
    }
    await runCheck({ post: true, trigger: "alarm" });
  } finally {
    await ensureCheckAlarm().catch(() => {});
  }
}

async function saveCheck(rec) {
  await chrome.storage.local.set({ [KEY.check]: rec });
  return rec;
}

// ── Coach check ────────────────────────────────────────────────────

async function runCheck({ post, trigger }) {
  return withKeepAwake("safetyobs.check", async () => {
    const s = await readSettings();
    const dateIso = localDay();
    const atMin = parseHm(s.checkAt);

    const sched = await schedules.get(s.storeNbr, dateIso).catch((e) => ({ error: String(e?.message || e) }));
    const schedule = sched?.associates || [];
    if (!schedule.length) {
      return saveCheck({ dateIso, at: Date.now(), trigger, ok: false, error: `No schedule for store ${s.storeNbr} on ${dateIso} in Digital Metrics${sched?.error ? `: ${sched.error}` : ""}.` });
    }

    const obs = await fetchSubmitters(s.storeNbr, dateIso);
    if (!obs.ok) return saveCheck({ dateIso, at: Date.now(), trigger, ok: false, error: `Field_Dashboard: ${obs.error}` });

    const mem = await listChannelMembers({ channelName: s.channel });
    const members = mem.ok ? mem.members : [];

    const result = checkCoaches({ schedule, observations: obs.rows, members, atMin, minPerDay: MIN_PER_DAY });
    const atLabel = new Date(2000, 0, 1, Math.floor(atMin / 60), atMin % 60).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    const message = buildMessage(result.behind, { atLabel });

    const rec = {
      dateIso, at: Date.now(), trigger, ok: true,
      checked: result.checked, behind: result.behind.map((c) => c.name), message: message?.text || null,
      observationsToday: obs.rows.reduce((n, r) => n + r.count, 0),
      membersError: mem.ok ? null : mem.error, posted: false,
    };
    if (post && message) {
      const sent = await postTextToWorkvivo({ channelName: s.channel, text: message.text, mentionedUserIds: message.mentionedUserIds });
      rec.posted = !!sent.ok;
      rec.postError = sent.ok ? null : `${sent.errorClass || ""} ${sent.error || ""}`.trim();
    } else if (post) {
      rec.posted = true;                 // nothing to say counts as done for the day
      rec.nothingToPost = true;
    }
    if (rec.posted) await chrome.storage.local.set({ [KEY.posted]: dateIso });
    return saveCheck(rec);
  });
}

// ── Ledger: 2 per scheduled day since ledgerFrom ───────────────────

function daysBetween(fromIso, toIso) {
  const out = [];
  const d = new Date(fromIso + "T12:00:00");
  const end = new Date(toIso + "T12:00:00");
  while (d <= end && out.length < 400) { out.push(d.toLocaleDateString("en-CA")); d.setDate(d.getDate() + 1); }
  return out;
}

/**
 * Leader lines (checked titles only, plus a size so a foreign roster still
 * reads as "had a schedule") per day. Days older than yesterday are cached:
 * the WFM import does not rewrite settled days, and 48+ Firestore reads per
 * refresh add up.
 */
async function leaderSchedules(storeNbr, dates) {
  const cacheAll = (await chrome.storage.local.get(KEY.schedCache))[KEY.schedCache] || {};
  const cache = cacheAll[storeNbr] || {};
  const yesterday = localDay(new Date(Date.now() - 86_400_000));
  const out = [];
  let dirty = false;
  for (const dateIso of dates) {
    let entry = dateIso < yesterday ? cache[dateIso] : null;
    if (!entry) {
      const doc = await schedules.get(storeNbr, dateIso).catch(() => null);
      const all = doc?.associates || [];
      entry = {
        size: all.length,
        lines: all.filter((a) => isCheckedTitle(a.jobName)).map(({ name, jobName, shiftStart, shiftEnd }) => ({ name, jobName, shiftStart, shiftEnd })),
      };
      if (dateIso < yesterday) { cache[dateIso] = entry; dirty = true; }
    }
    if (entry.size > 0) out.push({ dateIso, schedule: entry.lines.length ? entry.lines : [{ name: "", jobName: "", shiftStart: "" }] });
  }
  if (dirty) await chrome.storage.local.set({ [KEY.schedCache]: { ...cacheAll, [storeNbr]: cache } });
  return out;
}

async function runLedger({ from } = {}) {
  return withKeepAwake("safetyobs.ledger", async () => {
    const s = await readSettings();
    const todayIso = localDay();
    const fromIso = /^\d{4}-\d{2}-\d{2}$/.test(from || "") ? from : s.ledgerFrom;
    const days = await leaderSchedules(s.storeNbr, daysBetween(fromIso, todayIso));
    if (!days.length) return { ok: false, error: `No schedules for store ${s.storeNbr} from ${fromIso} in Digital Metrics.` };
    const obs = await fetchSubmitters(s.storeNbr, fromIso, todayIso);
    if (!obs.ok) return { ok: false, error: `Field_Dashboard: ${obs.error}` };
    const now = new Date();
    const led = buildLedger({ days, observations: obs.rows, todayIso, nowMin: now.getHours() * 60 + now.getMinutes() });
    const rec = { ok: true, at: Date.now(), fromIso, toIso: todayIso, ...led };
    await chrome.storage.local.set({ [KEY.ledger]: rec });
    return rec;
  });
}

// ── Sentence → answers ─────────────────────────────────────────────

async function aiPick(sentence) {
  const cx = await readCxSettings().catch(() => ({}));
  const token = cx.gatewayToken;
  if (!tokenStatus(token).ok) return { skipped: "no live AI gateway token (sign in from the Cx module to turn this on)" };
  const prompt = [
    "Classify this store safety observation for a survey. Reply with ONLY a JSON object:",
    '{"type": ..., "location": ..., "process": ..., "tool": ...}',
    "Each value MUST be copied exactly from its list, or null if the sentence gives no basis for it.",
    `type: ${JSON.stringify(TYPES)} (Engagement = correcting an UNSAFE behaviour; Recognition = celebrating a SAFE one)`,
    `location: ${JSON.stringify(LOCATIONS)} (WHERE the work happened in a Walmart Supercenter. A work area beats the merchandise's department: receiving, the dock, unloading, shrink-wrapping pallets and the backroom are "Backroom" even for grocery freight. null if no place or product is named)`,
    `process: ${JSON.stringify(PROCESSES)}`,
    `tool: ${JSON.stringify(TOOLS)}`,
    "",
    `Observation: ${sentence}`,
  ].join("\n");
  const res = await fetch(GATEWAY, {
    method: "POST",
    headers: {
      "content-type": "application/json", "X-Api-Key": token, "anthropic-version": "2023-06-01",
      "x-puppy-version": cx.gatewayClientVersion || DEFAULT_CLIENT_VERSION,
    },
    body: JSON.stringify({
      model: "claude-sonnet-5", max_tokens: 600, thinking: { type: "disabled" },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) return { error: `AI gateway ${res.status}` };
  const j = await res.json().catch(() => null);
  const text = (j?.content || []).filter((b) => b?.type === "text").map((b) => b.text).join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { error: "AI gateway gave no JSON" };
  try { return { pick: JSON.parse(m[0]) }; } catch { return { error: "AI gateway JSON did not parse" }; }
}

// ── Form tab ───────────────────────────────────────────────────────

// The QR link (forms.office.com) redirects to forms.cloud.microsoft after its
// first "complete", so tab status alone is not readiness: a script injected
// then dies with the old document and returns nothing. Ready = the rendered
// questions exist in the current document.
async function waitForForm(tabId, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return false;
    if (t.status === "complete" && /forms\.cloud\.microsoft|forms\.office\.com/i.test(t.url || "")) {
      const probe = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => document.querySelectorAll('[data-automation-id="questionItem"]').length,
      }).catch(() => null);
      if ((probe?.[0]?.result || 0) >= 4) return true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function fillInTab(answers, submit) {
  // Always a fresh tab of our own: a form the user has half filled in another
  // tab must not be overwritten or submitted.
  const tab = await chrome.tabs.create({ url: FORM_URL, active: false });
  await registerSessionTab(MODULE_ID, tab.id, { idleMs: 3 * 60_000 }).catch(() => {});
  try {
    if (!(await waitForForm(tab.id))) {
      const t = await chrome.tabs.get(tab.id).catch(() => null);
      return { ok: false, step: "load", error: `The form did not load (${t?.url || "tab gone"}). Open the QR link once to sign in to Microsoft Forms.` };
    }
    const timeout = new Promise((r) => setTimeout(() => r([{ result: { ok: false, step: "timeout", error: "Form fill timed out after 60 s." } }]), 60_000));
    const ran = await Promise.race([
      chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: FILL_FORM, args: [{ questions: QUESTIONS, answers, submit }] }),
      timeout,
    ]);
    return ran?.[0]?.result || { ok: false, step: "inject", error: "no result from the form tab" };
  } finally {
    await forgetSessionTab(tab.id).catch(() => {});
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// ── Direct submit (no tab) ─────────────────────────────────────────
//
// lib/form_api.js has the captured recipe. Outcomes:
//   sent     — 2xx from /responses: recorded.
//   rejected — the server answered 4xx: nothing recorded, safe to fall back
//              to filling the form in a tab.
//   unsure   — network failure or 5xx after the POST left: it MAY have been
//              recorded, so never retry; the user checks Field_Dashboard.
//   noToken  — page fetch failed or came back signed out: fall back.

async function submitViaApi(answers, startedAt) {
  let html;
  try {
    const page = await fetch(PAGE_URL, { credentials: "include" });
    html = await page.text();
  } catch (e) {
    return { outcome: "noToken", error: `form page: ${e?.message || e}` };
  }
  const tokens = readPageTokens(html);
  if (!tokens) return { outcome: "noToken", error: "form page had no verification token (signed out of Microsoft?)" };
  const muid = (await chrome.cookies.get({ url: "https://forms.cloud.microsoft/", name: "MUID" }).catch(() => null))?.value;
  const body = buildResponseBody(QUESTIONS, answers, { startDate: startedAt });
  let res;
  try {
    res = await fetch(RESPONSES_URL, {
      method: "POST", credentials: "include",
      headers: responseHeaders({ ...tokens, muid }),
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { outcome: "unsure", error: `network error after sending: ${e?.message || e}` };
  }
  const text = await res.text().catch(() => "");
  if (res.ok) {
    let id = null;
    try { id = JSON.parse(text)?.id ?? null; } catch { /* body is optional */ }
    return { outcome: "sent", status: res.status, responseId: id };
  }
  return { outcome: res.status >= 500 ? "unsure" : "rejected", status: res.status, error: `${res.status} ${text.slice(0, 200)}` };
}

// ── Handlers ───────────────────────────────────────────────────────

export const handlers = {
  async get_settings() {
    const settings = await readSettings();
    const alarm = await chrome.alarms.get(ALARM);
    const cx = await readCxSettings().catch(() => ({}));
    return { ok: true, settings, nextCheckAt: alarm?.scheduledTime || null, aiReady: tokenStatus(cx.gatewayToken).ok };
  },

  async save_settings(msg = {}) {
    const p = msg.patch || {};
    const patch = {};
    if (p.storeNbr != null) patch.storeNbr = String(p.storeNbr).replace(/\D/g, "");
    if (p.role != null) patch.role = String(p.role);
    if (p.channel != null) patch.channel = String(p.channel).trim();
    if (p.checkEnabled != null) patch.checkEnabled = !!p.checkEnabled;
    if (p.checkAt != null && /^\d{1,2}:\d{2}$/.test(p.checkAt)) patch.checkAt = p.checkAt;
    if (p.useAi != null) patch.useAi = !!p.useAi;
    if (p.ledgerFrom != null && /^\d{4}-\d{2}-\d{2}$/.test(p.ledgerFrom)) patch.ledgerFrom = p.ledgerFrom;
    const settings = await writeSettings(patch);
    const nextCheckAt = await ensureCheckAlarm();
    return { ok: true, settings, nextCheckAt };
  },

  /** { sentence } → proposed answers; nothing is sent anywhere but the AI gateway. */
  async parse(msg = {}) {
    const sentence = String(msg.sentence || "").trim();
    if (!sentence) return { ok: false, error: "Type what you observed." };
    const s = await readSettings();
    const rules = parseObservation(sentence);
    let answers = { ...rules.answers };
    let ai = { used: false };
    if (s.useAi) {
      const r = await aiPick(sentence).catch((e) => ({ error: String(e?.message || e) }));
      if (r.pick) {
        const merged = mergeAiPick(answers, r.pick);
        answers = merged.answers;
        ai = { used: true, changed: merged.changed };
        // The model saw no place either: keep asking rather than guess.
        if (r.pick.location == null && rules.missing.includes("location")) answers.location = null;
      } else {
        ai = { used: false, note: r.skipped || r.error };
      }
    }
    answers = { store: s.storeNbr, role: s.role, ...answers };
    if (answers.type === "Recognition" && !answers.description) answers.description = rules.answers.description || sentence;
    return {
      ok: true, sentence, answers, ai,
      guessed: rules.guessed.filter((k) => !(ai.changed || []).includes(k)),
      missing: missingAnswers(answers),
      hour: rules.hour,
    };
  },

  /** { answers, submit } — submit:false fills the form and closes it unsent (a dry run). */
  async submit(msg = {}) {
    const answers = { ...(msg.answers || {}) };
    if (answers.type !== "Recognition") delete answers.description;
    const missing = missingAnswers(answers);
    if (missing.length) return { ok: false, step: "validate", error: `Still needed: ${missing.join(", ")}`, missing };
    const submit = msg.submit !== false;
    const res = await withKeepAwake("safetyobs.submit", async () => {
      if (!submit) return fillInTab(answers, false);                    // test fill stays on the real page
      const api = await submitViaApi(answers, msg.startedAt);
      if (api.outcome === "sent") return { ok: true, submitted: true, method: "api", status: api.status, responseId: api.responseId };
      if (api.outcome === "unsure") {
        return { ok: false, step: "api", method: "api", error: `Not sure it went through (${api.error}). Check Field_Dashboard before submitting again.` };
      }
      const ui = await fillInTab(answers, true);                         // rejected / no token → the page way
      return { ...ui, method: "form", apiError: api.error };
    });
    if (res.ok && res.submitted) {
      const hist = (await chrome.storage.local.get(KEY.history))[KEY.history] || [];
      hist.unshift({ at: Date.now(), sentence: String(msg.sentence || ""), answers, method: res.method, apiError: res.apiError || null });
      await chrome.storage.local.set({ [KEY.history]: hist.slice(0, HISTORY_MAX) });
    }
    return res;
  },

  async history() {
    return { ok: true, items: (await chrome.storage.local.get(KEY.history))[KEY.history] || [] };
  },

  /** Run the coach check now. { post: false } previews without posting. */
  async check(msg = {}) {
    return runCheck({ post: msg.post === true, trigger: msg.post ? "manual-post" : "preview" });
  },

  /** { from? } → per coach: scheduled days, expected (2/day), done, behind. */
  async ledger(msg = {}) {
    return runLedger({ from: msg.from });
  },

  async last_ledger() {
    return { ok: true, ledger: (await chrome.storage.local.get(KEY.ledger))[KEY.ledger] || null };
  },

  async last_check() {
    return { ok: true, check: (await chrome.storage.local.get(KEY.check))[KEY.check] || null };
  },
};
