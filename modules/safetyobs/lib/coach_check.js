// modules/safetyobs/lib/coach_check.js
//
// The 4:45 PM check: which scheduled coaches have fewer than 2 safety
// observations today, and the Workvivo message that @mentions them. Pure;
// tested in lib/tests/coach_check.test.mjs.
//
// Who is checked (the user's rule, 2026-10-08): every schedule title with
// "Coach" in it, plus Store Manager and Ops Manager, whose shift today starts
// before the check time. An overnight coach starting at 9 PM has not worked
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

const LEADER_TITLE_RE = /\bcoach\b|^store manager\b|\bops manager\b|\boperations manager\b|\bstore lead\b/i;

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
      const row = people.get(k) || { name: titleCase(s.name), keys, jobName: s.jobName, scheduledDays: 0, lastScheduled: null, done: 0, today: 0, scheduledToday: false };
      row.scheduledDays++;
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
        if (o.dateIso === todayIso) row.today += n;
        break;
      }
    }
  }
  const rows = [...people.values()].map((r) => {
    const expected = r.scheduledDays * minPerDay;
    const { keys, ...rest } = r;
    return { ...rest, expected, behind: Math.max(0, expected - r.done), ahead: Math.max(0, r.done - expected), pct: expected ? Math.round((100 * r.done) / expected) : null };
  }).sort((a, b) => b.behind - a.behind || a.name.localeCompare(b.name));
  return { rows, excludedDays: excludedDays.sort(), days: good.map((d) => d.dateIso).sort() };
}
