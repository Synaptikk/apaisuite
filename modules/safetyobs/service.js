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
//  2. Morning catch-up post. Field_Dashboard (Power BI) refreshes once, early
//     in the morning, and never holds today's observations: the original
//     4:45 PM "under 2 today" check flagged nearly every coach (measured
//     2026-10-08: 1 observation for the day at both 10:49 AM and 3:54 PM).
//     So at POST time (default 9:00) the alarm builds the ledger through
//     yesterday (2 per scheduled day since ledgerFrom, lib/coach_check.js),
//     reads today's schedule (Digital Metrics' WFM import), and @mentions in
//     the "1458 management" Workvivo chat each leader on today who is behind:
//     "complete N today", N = behind + today's 2. Nothing is posted when
//     nobody on today is behind. A run more than LATE_LIMIT_MIN late is
//     skipped; the numbers would still be right, but a mid-afternoon post is noise.

import { QUESTIONS, FORM_URL, missingAnswers, LOCATIONS, PROCESSES, TOOLS, TYPES } from "./lib/form_schema.js";
import { FILL_FORM } from "./lib/form_fill.js";
import { PAGE_URL, RESPONSES_URL, SILENT_SIGNIN_URL, FORMS_LOGIN_COOKIE, readPageTokens, buildResponseBody, responseHeaders } from "./lib/form_api.js";
import { parseObservation, mergeAiPick } from "./lib/parse.js";
import { buildCatchUp, buildCatchUpMessage, buildLedger, isCheckedTitle } from "./lib/coach_check.js";
import { fetchSubmitters } from "../livedashboard/lib/sources/recognition.js";
import { schedules, safetyObs } from "../digitalmetrics/lib/firestore.js";
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
  posted:   "safetyobs.postedDay.v1",  // local date the daily message last went out
  schedCache: "safetyobs.leaderLines.v1", // { dateIso: [leader lines] | "foreign-or-empty" marker }
  ledger:   "safetyobs.lastLedger.v1",
  me:       "safetyobs.me.v1",          // { displayName, at }: who this browser submits as
};
export const ALARM = "safetyobs.coachCheck";
const LATE_LIMIT_MIN = 180;
const HISTORY_MAX = 50;

export const DEFAULT_SETTINGS = Object.freeze({
  storeNbr: "1458",
  role: "Coach",
  channel: "1458 management",
  // Off until turned on in ONE browser: the suite is installed in both the
  // normal and the debug Edge, and each install would post its own message.
  checkEnabled: false,
  // Morning, after Power BI's overnight refresh. A new key so the stored
  // `checkAt` (the old 16:45 "under 2 today" post) is ignored.
  postAt: "09:00",
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
  return m ? Number(m[1]) * 60 + Number(m[2]) : 9 * 60;
};
const shortDay = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" }).replace(",", "");
const monthDay = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "numeric", day: "numeric" });

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
  const when = nextAt(s.postAt);
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
      await saveCheck({ dateIso: localDay(), at: Date.now(), ok: false, skipped: `Missed the ${s.postAt} post (browser was closed)` });
      console.warn(`[safetyobs] check alarm fired ${Math.round(lateMin)} min late`);
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
    const throughIso = localDay(new Date(Date.now() - 86_400_000));

    const sched = await schedules.get(s.storeNbr, dateIso).catch((e) => ({ error: String(e?.message || e) }));
    const schedule = sched?.associates || [];
    if (!schedule.length) {
      if (sched?.error) console.warn("[safetyobs] schedule read failed:", sched.error);
      return saveCheck({ dateIso, at: Date.now(), trigger, ok: false, error: `No schedule for store ${s.storeNbr} on ${dateIso}.` });
    }

    const led = await ledgerThrough(s, throughIso);
    if (!led.ok) return saveCheck({ dateIso, at: Date.now(), trigger, ok: false, error: led.error });

    const mem = await listChannelMembers({ channelName: s.channel });
    const members = mem.ok ? mem.members : [];

    const live = await liveToday(s.storeNbr, dateIso);
    const result = buildCatchUp({ ledgerRows: led.rows, schedule, members, today: live.entries });
    const message = buildCatchUpMessage(result.behind, { throughLabel: shortDay(throughIso), sinceLabel: monthDay(led.fromIso) });

    const rec = {
      dateIso, throughIso, fromIso: led.fromIso, at: Date.now(), trigger, ok: true,
      checked: result.rows, behind: result.behind.map((c) => c.name), message: message?.text || null,
      observationsThrough: led.observationsThrough,
      liveToday: live.entries.length, liveError: live.error,
      membersError: mem.ok ? null : mem.error, posted: false,
    };
    // Yesterday had a schedule but not one observation at the store: the
    // overnight refresh has probably not landed, so the alarm holds off
    // rather than post a backlog a day stale. "Post now" still sends.
    if (post && trigger === "alarm" && led.scheduledThrough && !led.observationsThrough) {
      rec.error = `No observations dated ${throughIso} yet; Field_Dashboard may not have refreshed. Not posted.`;
      return saveCheck(rec);
    }
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

// ── Live submissions: shared so any browser sees today's ──────────
//
// Field_Dashboard only shows an observation from the next morning, so the
// suite's own submissions are the one same-day count there is. Each browser
// keeps its history locally; today's entries are pushed to
// digitalmetrics/stores/{store}/safetyObs/{date} (names sealed, codec.js) so
// the browser that posts the catch-up sees what another one submitted. QR
// submissions from phones are still only seen the next morning.

/** The Forms account this browser submits as, cached; null if unknown. */
async function whoAmI({ tokens } = {}) {
  if (tokens?.displayName) {
    await chrome.storage.local.set({ [KEY.me]: { displayName: tokens.displayName, at: Date.now() } });
    return tokens.displayName;
  }
  const cached = (await chrome.storage.local.get(KEY.me))[KEY.me];
  if (cached?.displayName) return cached.displayName;
  try {
    let t = await loadPageTokens();
    if (t && !t.signedIn) { await renewFormsLogin(); t = await loadPageTokens(); }
    if (t?.displayName) return whoAmI({ tokens: t });
  } catch { /* unknown for now; the next sync retries */ }
  return null;
}

/**
 * Push this browser's not-yet-shared submissions from today. Older ones are
 * left: Field_Dashboard has them by now. Merges by entry id, so a retry or a
 * second browser never double counts.
 */
async function shareToday() {
  const s = await readSettings();
  const today = localDay();
  const hist = (await chrome.storage.local.get(KEY.history))[KEY.history] || [];
  const pending = hist.filter((h) => !h.shared && localDay(new Date(h.at)) === today);
  if (!pending.length) return { ok: true, shared: 0 };
  const me = await whoAmI();
  if (!me) return { ok: false, error: "Could not tell which Microsoft account submitted (Forms signed out)." };
  try {
    const doc = (await safetyObs.get(s.storeNbr, today)) || { entries: [] };
    const have = new Set((doc.entries || []).map((e) => String(e.id)));
    const entries = [...(doc.entries || [])];
    for (const h of pending) {
      const id = String(h.at);
      if (!have.has(id)) entries.push({ id, at: h.at, type: h.answers?.type || null, name: h.submitter || me });
    }
    const put = await safetyObs.put(s.storeNbr, today, { entries, store: s.storeNbr });
    if (!put?.ok) return { ok: false, error: put?.error || "Firestore write failed" };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
  const ids = new Set(pending.map((h) => h.at));
  const fresh = (await chrome.storage.local.get(KEY.history))[KEY.history] || [];
  await chrome.storage.local.set({ [KEY.history]: fresh.map((h) => (ids.has(h.at) ? { ...h, shared: true, submitter: h.submitter || me } : h)) });
  return { ok: true, shared: pending.length };
}

/** Today's shared entries for the store: [{ name, count }]. */
async function liveToday(storeNbr, dateIso) {
  await shareToday().catch(() => {});        // this browser's own first
  try {
    const doc = await safetyObs.get(storeNbr, dateIso);
    return { entries: (doc?.entries || []).map((e) => ({ name: e.name, count: 1 })), error: null };
  } catch (e) {
    return { entries: [], error: String(e?.message || e) };
  }
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

/**
 * The ledger through `throughIso` (yesterday). Field_Dashboard has no
 * same-day data, so counting today would charge every leader on today 2
 * observations the report cannot show yet.
 */
async function ledgerThrough(s, throughIso, from) {
  const fromIso = /^\d{4}-\d{2}-\d{2}$/.test(from || "") ? from : s.ledgerFrom;
  const days = await leaderSchedules(s.storeNbr, daysBetween(fromIso, throughIso));
  if (!days.length) return { ok: false, error: `No schedules for store ${s.storeNbr} from ${fromIso} to ${throughIso}.` };
  const obs = await fetchSubmitters(s.storeNbr, fromIso, throughIso);
  if (!obs.ok) { console.warn("[safetyobs] observations read failed:", obs.error); return { ok: false, error: "Couldn't load observations. Try again." }; }
  const led = buildLedger({ days, observations: obs.rows, todayIso: throughIso });
  return {
    ok: true, fromIso, toIso: throughIso, ...led,
    scheduledThrough: days.some((d) => d.dateIso === throughIso),
    observationsThrough: obs.rows.filter((r) => r.dateIso === throughIso).reduce((n, r) => n + r.count, 0),
  };
}

async function runLedger({ from } = {}) {
  return withKeepAwake("safetyobs.ledger", async () => {
    const s = await readSettings();
    const led = await ledgerThrough(s, localDay(new Date(Date.now() - 86_400_000)), from);
    if (!led.ok) return led;
    // Today stays out of Expected/Done/Behind (Field_Dashboard has none of
    // it); shown beside them instead: who is on today, what they logged
    // through the suite (the only same-day count there is), what they owe.
    const todayIso = localDay();
    const sched = await schedules.get(s.storeNbr, todayIso).catch((e) => ({ error: String(e?.message || e) }));
    const live = await liveToday(s.storeNbr, todayIso);
    const cu = buildCatchUp({ ledgerRows: led.rows, schedule: sched?.associates || [], today: live.entries });
    const rec = {
      ...led, at: Date.now(), todayIso,
      today: cu.rows.map(({ name, jobName, shiftStart, shiftEnd, doneToday, owe }) => ({ name, jobName, shiftStart, shiftEnd, doneToday, owe })),
      todayScheduleError: sched?.associates?.length ? null : (sched?.error || `no schedule for ${todayIso} in Digital Metrics`),
      liveTodayCount: live.entries.length, liveError: live.error,
    };
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
    return ran?.[0]?.result || { ok: false, step: "inject", error: "Form fill failed. Try again." };
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

async function loadPageTokens() {
  const page = await fetch(PAGE_URL, { credentials: "include" });
  return readPageTokens(await page.text());
}

/**
 * Renew the hour-long Forms login cookie by loading the page's silent sign-in
 * link in a hidden tab. It has to be a tab: Edge signs navigations in with the
 * Windows account, while a fetch of the same link gets AADSTS50058 "no user
 * is signed in" (tried 2026-10-08). The tab never shows the form.
 */
async function renewFormsLogin(ms = 20_000) {
  const tab = await chrome.tabs.create({ url: SILENT_SIGNIN_URL, active: false });
  await registerSessionTab(MODULE_ID, tab.id, { idleMs: 60_000 }).catch(() => {});
  try {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const ck = await chrome.cookies.get({ url: "https://forms.cloud.microsoft/", name: FORMS_LOGIN_COOKIE }).catch(() => null);
      if (ck) return null;
      const t = await chrome.tabs.get(tab.id).catch(() => null);
      if (!t) return "sign-in tab closed";
      if (t.status === "complete" && /silentsignincomplete/i.test(t.url || "")) return null;
      await new Promise((r) => setTimeout(r, 300));
    }
    return "silent sign-in timed out";
  } finally {
    await forgetSessionTab(tab.id).catch(() => {});
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function submitViaApi(answers, startedAt) {
  let tokens;
  try {
    tokens = await loadPageTokens();
    if (tokens && !tokens.signedIn) {
      const why = await renewFormsLogin();
      tokens = await loadPageTokens();
      if (!tokens?.signedIn) return { outcome: "noToken", error: `Microsoft Forms login lapsed and did not renew${why ? `: ${why}` : ""}` };
    }
  } catch (e) {
    return { outcome: "noToken", error: `form page / sign-in: ${e?.message || e}` };
  }
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
    return { outcome: "sent", status: res.status, responseId: id, displayName: tokens.displayName || null };
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
    if (p.postAt != null && /^\d{1,2}:\d{2}$/.test(p.postAt)) patch.postAt = p.postAt;
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
      if (api.outcome === "sent") return { ok: true, submitted: true, method: "api", status: api.status, responseId: api.responseId, displayName: api.displayName };
      if (api.outcome === "unsure") {
        console.warn("[safetyobs] submit outcome unsure:", api.error);
        return { ok: false, step: "api", method: "api", error: "Not sure it went through. Check the dashboard before resubmitting." };
      }
      const ui = await fillInTab(answers, true);                         // rejected / no token → the page way
      return { ...ui, method: "form", apiError: api.error };
    });
    if (res.ok && res.submitted) {
      const submitter = res.displayName ? await whoAmI({ tokens: { displayName: res.displayName } }) : await whoAmI();
      const hist = (await chrome.storage.local.get(KEY.history))[KEY.history] || [];
      hist.unshift({ at: Date.now(), sentence: String(msg.sentence || ""), answers, method: res.method, apiError: res.apiError || null, submitter });
      await chrome.storage.local.set({ [KEY.history]: hist.slice(0, HISTORY_MAX) });
      res.share = await shareToday().catch((e) => ({ ok: false, error: String(e?.message || e) }));
    }
    return res;
  },

  async history() {
    // Opening the panel also pushes anything from today not shared yet
    // (submissions made before sharing existed, or while Firestore was down).
    const share = await shareToday().catch((e) => ({ ok: false, error: String(e?.message || e) }));
    return { ok: true, items: (await chrome.storage.local.get(KEY.history))[KEY.history] || [], share };
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
