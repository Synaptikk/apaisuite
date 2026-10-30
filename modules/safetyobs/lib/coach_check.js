// modules/safetyobs/lib/coach_check.js
//
// Which scheduled leaders owe safety observations, and the Workvivo message
// that @mentions them. Pure; tested in lib/tests/coach_check.test.mjs.
// The service posts the morning catch-up (buildCatchUp, at the bottom); the
// same-day checkCoaches/buildMessage pair is no longer wired, because
// Field_Dashboard never holds today's observations.
//
// Who is checked (the user's rule, 2026-10-08): every schedule title with
// "Coach" in it, plus Store Manager, Emerging Store Manager (added 2026-10-15)
// and Ops Manager, whose shift today starts before the check time. An overnight coach starting at 9 PM has not worked
// yet at 4:45 and is left out. Hourly managers ("Vision Center Mgr Hrly") and
// "People Lead" are not coaches.
//
// Counting: Field_Dashboard's "High Accidents Survey" rows carry the
// submitter's Name and Email (the form records identity). They are matched to
// the schedule by name key (first | last, see safetyagent/lib/oncall.js).
//
// Mentions: Workvivo chat writes a mention as `@[Nickname](person:<user_id>)`
// in the message text plus mention_type "users" / mentioned_user_ids — read
// off a real mention in "1458 management" 2026-10-08.

import { nameKeys, clockToMin } from "../../safetyagent/lib/oncall.js";

export const MIN_PER_DAY = 2;
export const CHECK_AT_MIN = 16 * 60 + 45;   // 4:45 PM local

const LEADER_TITLE_RE = /\bcoach\b|^store manager\b|^emerging store manager\b|\bops manager\b|\boperations manager\b|\bstore lead\b/i;

export const isCheckedTitle = (jobName) => LEADER_TITLE_RE.test(String(jobName || ""));

/**
 * @param {object}   p
 * @param {Array<{name:string, jobName:string, shiftStart:string, shiftEnd:string}>} p.schedule
 * @param {Array<{name:string, email?:string, count?:number}>} p.observations   today's rows for the store
 * @param {Array<{userId:string, nickname:string}>} [p.members]                  the chat's members
 * @param {number} [p.atMin]   check time, minutes since midnight
 * @returns {{checked: Array, behind: Array, done: Array}}
 */
export function checkCoaches({ schedule = [], observations = [], members = [], atMin = CHECK_AT_MIN, minPerDay = MIN_PER_DAY }) {
  const counts = new Map();
  for (const o of observations) {
    const n = Math.max(1, Math.round(Number(o.count) || 1));
    for (const k of nameKeys(o.name)) counts.set(k, (counts.get(k) || 0) + n);
  }
  const memberByKey = new Map();
  for (const m of members) for (const k of nameKeys(m.nickname)) if (!memberByKey.has(k)) memberByKey.set(k, m);

  const seen = new Set();
  const checked = [];
  for (const s of schedule) {
    if (!isCheckedTitle(s.jobName)) continue;
    const start = clockToMin(s.shiftStart);
    if (start == null || start >= atMin) continue;
    const keys = nameKeys(s.name);
    if (!keys.length || seen.has(keys[0])) continue;
    seen.add(keys[0]);
    // A name with several keys can match on any of them; count once, by the best.
    const count = Math.max(0, ...keys.map((k) => counts.get(k) || 0));
    const member = keys.map((k) => memberByKey.get(k)).find(Boolean) || null;
    checked.push({
      name: titleCase(s.name), jobName: s.jobName, shiftStart: s.shiftStart, shiftEnd: s.shiftEnd,
      count, member: member ? { userId: String(member.userId), nickname: member.nickname } : null,
    });
  }
  checked.sort((a, b) => a.count - b.count || a.name.localeCompare(b.name));
  return {
    checked,
    behind: checked.filter((c) => c.count < minPerDay),
    done: checked.filter((c) => c.count >= minPerDay),
  };
}

/**
 * The chat message. Null when nobody is behind (the user chose: @mention the
 * coaches who are short, nothing when everyone is done).
 * @returns {{text:string, mentionedUserIds:string[]}|null}
 */
export function buildMessage(behind, { minPerDay = MIN_PER_DAY, atLabel = "4:45 PM" } = {}) {
  if (!behind.length) return null;
  const lines = behind.map((c) => {
    const who = c.member ? `@[${c.member.nickname}](person:${c.member.userId})` : c.name;
    return `• ${who}: ${c.count} of ${minPerDay}`;
  });
  return {
    text: [
      `Safety observations as of ${atLabel}: still under ${minPerDay} today`,
      ...lines,
      `Please get your ${minPerDay} in before you leave.`,
    ].join("\n"),
    mentionedUserIds: behind.filter((c) => c.member).map((c) => c.member.userId),
  };
}

function titleCase(s) {
  return String(s || "").toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

// ── Running ledger: expected vs done since a start date ────────────
//
// The user's follow-up (2026-10-08): coaches owe 2 observations for every day
// they are scheduled, so from a start date on, expected = 2 × scheduled days,
// and behind = expected − observations submitted in the same span (a day off
// spent observing still counts toward the total).
//
// Some schedule docs are another store's roster (1458's 2026-09-05..11 hold
// store 5151's people, see safetyagent/lib/oncall.js::scheduleMatches). Such a
// day lists none of the store's regular leaders; it is dropped from BOTH
// sides, and returned in `excludedDays`, rather than read as "everyone off".

/**
 * @param {object} p
 * @param {Array<{dateIso:string, schedule:Array}>} p.days   one entry per day with a schedule doc
 * @param {Array<{dateIso:string, name:string, count?:number}>} p.observations
 * @param {string} p.todayIso
 * @param {number} [p.nowMin]   today's shifts count only once started
 * @returns {{rows:Array, excludedDays:string[], days:string[]}}
 */
export function buildLedger({ days = [], observations = [], todayIso, nowMin = 24 * 60, minPerDay = MIN_PER_DAY }) {
  // Leaders per day, keyed by their first name key.
  const perDay = days.map((d) => {
    const leaders = new Map();
    for (const s of d.schedule || []) {
      if (!isCheckedTitle(s.jobName)) continue;
      const start = clockToMin(s.shiftStart);
      if (d.dateIso === todayIso && (start == null || start > nowMin)) continue;
      const keys = nameKeys(s.name);
      if (keys.length && !leaders.has(keys[0])) leaders.set(keys[0], { keys, s });
    }
    return { dateIso: d.dateIso, leaders, hasSchedule: (d.schedule || []).length > 0 };
  });

  // "Regulars": leaders on at least a quarter of the days. A day with a
  // schedule but none of them is a foreign roster.
  const freq = new Map();
  for (const d of perDay) for (const k of d.leaders.keys()) freq.set(k, (freq.get(k) || 0) + 1);
  const regular = new Set([...freq].filter(([, n]) => n >= Math.max(2, perDay.length / 4)).map(([k]) => k));
  const excludedDays = [];
  const good = perDay.filter((d) => {
    const ok = d.hasSchedule && (regular.size === 0 || [...d.leaders.keys()].some((k) => regular.has(k)));
    if (!ok && d.hasSchedule) excludedDays.push(d.dateIso);
    return ok;
  });
  const goodSet = new Set(good.map((d) => d.dateIso));

  const people = new Map();   // key → row
  for (const d of good) {
    for (const [k, { keys, s }] of d.leaders) {
      const row = people.get(k) || { name: titleCase(s.name), keys, jobName: s.jobName, scheduledDays: 0, lastScheduled: null, done: 0, today: 0, scheduledToday: false, byDay: {} };
      row.scheduledDays++;
      (row.byDay[d.dateIso] ||= { scheduled: false, shift: "", done: 0 }).scheduled = true;
      row.byDay[d.dateIso].shift = s.shiftStart && s.shiftEnd ? `${s.shiftStart}–${s.shiftEnd}` : "";
      if (!row.lastScheduled || d.dateIso > row.lastScheduled) { row.lastScheduled = d.dateIso; row.jobName = s.jobName; }
      if (d.dateIso === todayIso) row.scheduledToday = true;
      people.set(k, row);
    }
  }
  for (const o of observations) {
    if (!goodSet.has(o.dateIso)) continue;
    const n = Math.max(1, Math.round(Number(o.count) || 1));
    const ok = nameKeys(o.name);
    for (const row of people.values()) {
      if (row.keys.some((k) => ok.includes(k))) {
        row.done += n;
        (row.byDay[o.dateIso] ||= { scheduled: false, shift: "", done: 0 }).done += n;
        if (o.dateIso === todayIso) row.today += n;
        break;
      }
    }
  }
  const rows = [...people.values()].map((r) => {
    const expected = r.scheduledDays * minPerDay;
    const { keys, byDay, ...rest } = r;
    // Per day, oldest first: scheduled days owe minPerDay; an unscheduled day
    // with observations still counts toward Done.
    const days = Object.keys(byDay).sort().map((dateIso) => ({ dateIso, ...byDay[dateIso], expected: byDay[dateIso].scheduled ? minPerDay : 0 }));
    return { ...rest, byDay: days, expected, behind: Math.max(0, expected - r.done), ahead: Math.max(0, r.done - expected), pct: expected ? Math.round((100 * r.done) / expected) : null };
  }).sort((a, b) => b.behind - a.behind || a.name.localeCompare(b.name));
  return { rows, excludedDays: excludedDays.sort(), days: good.map((d) => d.dateIso).sort() };
}

// ── Overnight shifts (2026-10-24) ──────────────────────────────────
//
// An overnight coach's shift (Overnight Stocking Coach, 8:00pm–8:00am) sits
// on the schedule day it starts, but what they log after midnight carries
// the next date. The 9 AM post counts through yesterday, so last night's
// after-midnight observations fell out of the ledger and into "done so far
// today": a coach who did their 2 at 3 AM read "2 behind + today's 2, 2 done
// so far" and was @mentioned every morning while caught up. Observations are
// credited to the shift day instead.
//
// Field_Dashboard rows hold no time of day, so a row dated D by someone whose
// shift on D−1 ran past midnight goes to D−1. On back-to-back nights a row
// from before midnight on D moves a day early too; the running total does not
// change. Left alone: the person also had a day shift on D (either is
// possible), or the entry has a time (suite submissions) later than the
// overnight shift's end plus OVERNIGHT_GRACE_MIN.

export const OVERNIGHT_GRACE_MIN = 120;

export function crossesMidnight(s) {
  const a = clockToMin(s?.shiftStart), b = clockToMin(s?.shiftEnd);
  return a != null && b != null && b <= a;
}

/**
 * @param {object} p
 * @param {Array<{dateIso:string, schedule:Array}>} p.days   schedule days, through the observations' last date
 * @param {Array<{dateIso:string, name:string, count?:number, at?:number}>} p.observations
 * @returns {Array} the observations, `dateIso` moved to the shift day where it applies (`shiftedFrom` set)
 */
export function creditShiftDays({ days = [], observations = [] }) {
  const overnight = new Map();   // "key|date" → shift that started that date and crossed midnight
  const dayShift = new Set();    // "key|date" → a shift that stayed within the date
  for (const d of days) {
    for (const s of d.schedule || []) {
      if (!isCheckedTitle(s.jobName)) continue;
      for (const k of nameKeys(s.name)) {
        if (crossesMidnight(s)) overnight.set(`${k}|${d.dateIso}`, s);
        else if (clockToMin(s.shiftStart) != null) dayShift.add(`${k}|${d.dateIso}`);
      }
    }
  }
  return observations.map((o) => {
    if (!o?.dateIso) return o;
    const prev = shiftIsoDay(o.dateIso, -1);
    const keys = nameKeys(o.name);
    const shift = keys.map((k) => overnight.get(`${k}|${prev}`)).find(Boolean);
    if (!shift) return o;
    if (keys.some((k) => dayShift.has(`${k}|${o.dateIso}`))) return o;
    if (o.at != null) {
      const t = new Date(o.at);
      if (t.getHours() * 60 + t.getMinutes() > clockToMin(shift.shiftEnd) + OVERNIGHT_GRACE_MIN) return o;
    }
    return { ...o, dateIso: prev, shiftedFrom: o.dateIso };
  });
}

function shiftIsoDay(iso, n) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── Morning catch-up (2026-10-08) ──────────────────────────────────
//
// Field_Dashboard lags (measured 2026-10-08: no same-day rows; 2026-10-17:
// same-day rows by 1 PM, but yesterday still filling in after 9 AM), so a
// 4:45 "under 2 today" check flagged nearly everyone. The post goes out in
// the morning and tells each leader scheduled
// today how many to complete today: what the ledger says they are behind
// through yesterday, plus today's 2 (the user: "complete 4 today to catch up,
// 6 etc, however many").

/**
 * @param {object} p
 * @param {Array} p.ledgerRows   buildLedger rows computed through yesterday
 * @param {Array<{name:string, jobName:string, shiftStart:string, shiftEnd:string}>} p.schedule   today's whole schedule
 * @param {Array<{userId:string, nickname:string}>} [p.members]
 * @param {Array<{name:string, count?:number}>} [p.today]   today's observations so far
 *        (mergeTodayCounts of suite submissions and Field_Dashboard's same-day rows)
 * @returns {{rows: Array, behind: Array}}   rows: every leader on today; behind: those with backlog still owed
 */
export function buildCatchUp({ ledgerRows = [], schedule = [], members = [], today = [], minPerDay = MIN_PER_DAY }) {
  const todayCounts = new Map();
  for (const o of today) {
    const n = Math.max(1, Math.round(Number(o.count) || 1));
    for (const k of nameKeys(o.name)) todayCounts.set(k, (todayCounts.get(k) || 0) + n);
  }
  const ledger = ledgerRows.map((r) => ({ keys: nameKeys(r.name), r }));
  const memberByKey = new Map();
  for (const m of members) for (const k of nameKeys(m.nickname)) if (!memberByKey.has(k)) memberByKey.set(k, m);

  const seen = new Set();
  const rows = [];
  for (const s of schedule) {
    if (!isCheckedTitle(s.jobName)) continue;
    const keys = nameKeys(s.name);
    if (!keys.length || seen.has(keys[0])) continue;
    seen.add(keys[0]);
    const hit = ledger.find((l) => l.keys.some((k) => keys.includes(k)));
    const behind = hit ? hit.r.behind : 0;
    const doneToday = Math.max(0, ...keys.map((k) => todayCounts.get(k) || 0));
    const member = keys.map((k) => memberByKey.get(k)).find(Boolean) || null;
    rows.push({
      name: titleCase(s.name), jobName: s.jobName, shiftStart: s.shiftStart, shiftEnd: s.shiftEnd,
      overnight: crossesMidnight(s),
      behind, doneToday, owe: Math.max(0, behind + minPerDay - doneToday),
      member: member ? { userId: String(member.userId), nickname: member.nickname } : null,
    });
  }
  rows.sort((a, b) => b.owe - a.owe || a.name.localeCompare(b.name));
  return { rows, behind: rows.filter((r) => r.behind > 0 && r.owe > 0) };
}

/**
 * Today's count per person from several sources that can hold the same
 * observation (a suite submission shows up in Field_Dashboard after its next
 * refresh): the larger count per person wins, never the sum.
 * @param {...Array<{name:string, count?:number}>} lists
 * @returns {Array<{name:string, count:number}>}
 */
export function mergeTodayCounts(...lists) {
  const best = new Map();   // first name key → { name, count }
  for (const list of lists) {
    const sums = new Map();
    for (const o of list || []) {
      const k = nameKeys(o.name)[0];
      if (!k) continue;
      const n = Math.max(1, Math.round(Number(o.count) || 1));
      sums.set(k, { name: o.name, count: (sums.get(k)?.count || 0) + n });
    }
    for (const [k, v] of sums) if (!best.has(k) || best.get(k).count < v.count) best.set(k, v);
  }
  return [...best.values()];
}

/**
 * The morning post. Null when no leader on today is behind.
 * @param {Array} behind        buildCatchUp().behind
 * @param {object} o
 * @param {string} o.throughLabel   last day the counts cover, e.g. "Wed 10/7"
 * @param {string} o.sinceLabel     ledger start, e.g. "8/22"
 * @returns {{text:string, mentionedUserIds:string[]}|null}
 */
export function buildCatchUpMessage(behind, { throughLabel, sinceLabel, reportNote = null, minPerDay = MIN_PER_DAY } = {}) {
  if (!behind.length) return null;
  const lines = behind.map((c) => {
    const who = c.member ? `@[${c.member.nickname}](person:${c.member.userId})` : c.name;
    const done = c.doneToday ? `, ${c.doneToday} done so far` : "";
    const when = c.overnight ? "tonight" : "today";
    return `• ${who}: complete ${c.owe}${c.doneToday ? " more" : ""} ${when} (${c.behind} behind + ${when}'s ${minPerDay}${done})`;
  });
  return {
    text: [
      `Safety observations: ${minPerDay} per scheduled day since ${sinceLabel}, counted through ${throughLabel}.`,
      ...(reportNote ? [reportNote] : []),
      `To catch up:`,
      ...lines,
      `Everyone else on today: your usual ${minPerDay}.`,
    ].join("\n"),
    mentionedUserIds: behind.filter((c) => c.member).map((c) => c.member.userId),
  };
}

/**
 * The post's line on how far Field_Dashboard reaches (the user, 2026-10-25:
 * the 10/25 post went out at 11:33 with nothing past 8 PM 10/24, and two
 * observations from that evening read as not done).
 * @param {{localIso:string, before:number}|null} dataThrough   recognition.js::dataThrough
 * @param {string} todayIso                     a response dated today means yesterday is all in
 * @param {string} throughLabel                 e.g. "Sat 10/24"
 */
export function buildReportNote(dataThrough, { todayIso, throughLabel }) {
  if (!dataThrough?.before) return null;
  if (dataThrough.localIso >= todayIso) {
    return `Field_Dashboard has all of ${throughLabel}'s observations; anything logged today shows up after its next refresh.`;
  }
  const t = new Date(dataThrough.before);
  const day = t.toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" }).replace(",", "");
  const time = t.getHours() === 0 && t.getMinutes() === 0
    ? "midnight"
    : t.toLocaleTimeString("en-US", { hour: "numeric", ...(t.getMinutes() ? { minute: "2-digit" } : {}) });
  return `Field_Dashboard was last updated with observations up to ${day} ${time}. Anything logged after that isn't counted yet and will show up after its next refresh.`;
}
