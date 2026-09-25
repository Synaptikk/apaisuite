// modules/digitalmetrics/lib/data/board_sync.js
//
// Live sync of the store's "Daily Board" workbook into assignment documents.
// Pure — the service worker does the fetching and storage (service.js,
// lib/sources/daily_board_source.js).
//
// ── What the live workbook actually is (checked 2026-09-23, store 1458) ────
//
// One sheet per WEEKDAY, reused every week. The header says "WEDNESDAY" with
// no date, and the store overwrites a sheet the night before its day. So on a
// Wednesday the WEDNESDAY sheet is today's plan, the THURSDAY sheet is either
// tomorrow's (once tonight's update lands) or still LAST Thursday's, and every
// other sheet is last week's. The date therefore comes from the day we pull,
// and staleness from whether a sheet changed since we applied it a week ago.
//
// ── Who wins when the board and the app disagree ──────────────────────────
//
// The user's rule (2026-09-23): the NEWEST edit wins, for the whole of the
// day; after midnight the day is locked, and next week's Wednesday is a new
// date. Implemented per cell: a cell the board CHANGED since our last pull is
// a newer edit than anything in the app and replaces it; a cell the board did
// not change leaves whatever the app holds, because any app edit to it is
// newer than the board's. Dates before today are never written.
//
// ── Names ───────────────────────────────────────────────────────────────
//
// The board is typed by hand: "marla f", "stellan ki", "kj". The schedule for
// that day has full names ("MARLA FINCH"), so resolution only ever chooses
// among people actually scheduled that day, which is what makes first names
// usable at all. Anything that does not resolve to exactly one person stays
// unmatched and is reported, never guessed.

import { dayName } from "./grid.js";
import { sheetRows } from "./daily_board.js";
import { leadershipForJob } from "./job_classify.js";

const WEEKDAYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];

/**
 * Hours take precedence over names (the user, 2026-09-23): a person counts
 * as a board row only when their scheduled shift covers at least this share
 * of the hours the board gives them. A nickname scheduled 1–10 is never the
 * "ALEX" the board has working 7–4, however well the name fits.
 */
export const HOURS_FIT = 0.95;

/** Snapshots older than this are useless: only D-7 is ever compared. */
export const SNAPSHOT_KEEP_DAYS = 15;

// ── share link ───────────────────────────────────────────────────────────

/**
 * A OneDrive/SharePoint share link → where to fetch it from.
 *
 *   https://my.wal-mart.com/:x:/r/personal/<acct>/_layouts/15/Doc.aspx
 *     ?sourcedoc={1A2B3C4D-…}&file=Daily%20Board%202.xlsx
 *
 * → { site: "https://my.wal-mart.com/personal/<acct>", uniqueId: "1A2B3C4D-…" }
 */
export function parseShareLink(link) {
  let u;
  try { u = new URL(String(link || "").trim()); } catch { return null; }
  if (u.protocol !== "https:") return null;

  const m = /\/(personal|sites|teams)\/([^/]+)/i.exec(u.pathname);
  const doc = u.searchParams.get("sourcedoc") || u.searchParams.get("UniqueId") || "";
  const id = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(doc)?.[0];
  if (!m || !id) return null;

  return {
    site: `${u.origin}/${m[1].toLowerCase()}/${m[2]}`,
    uniqueId: id.toUpperCase(),
    fileName: u.searchParams.get("file") || null,
  };
}

// ── workbook → weekday sheets ──────────────────────────────────────────────

/**
 * Parsed workbook sheets → { [weekdayIndex]: { [boardName]: { slot: task } } }.
 *
 * Sheets whose first cell is not a bare weekday (the blank template, the
 * oversize rotation, the signature sheet) are skipped.
 */
export function weekdaySheets(sheets) {
  const out = {};
  for (const sheet of sheets || []) {
    const head = String(sheet?.rows?.[0]?.[0] ?? "").trim().toUpperCase();
    const weekday = WEEKDAYS.indexOf(head.split(/\s+/)[0]);
    if (weekday === -1) continue;

    const rows = sheetRows(sheet.rows);
    if (!rows) continue;

    const byName = {};
    for (const r of rows) {
      const key = boardKey(r.name);
      // Two rows with the same typed name is a typo on the board; keep the
      // first rather than letting the second silently replace it.
      if (key && !byName[key]) byName[key] = r.slots;
    }
    out[weekday] = byName;
  }
  return out;
}

/** "  marla  f " → "MARLA F". The identity of a board row. */
export function boardKey(name) {
  return String(name || "").trim().replace(/\s+/g, " ").toUpperCase();
}

/** Order-independent fingerprint of one sheet's assignments. */
export function fingerprint(cells) {
  const names = Object.keys(cells || {}).sort();
  return JSON.stringify(names.map((n) => {
    const s = cells[n] || {};
    return [n, Object.keys(s).sort((a, b) => a - b).map((k) => [Number(k), s[k]])];
  }));
}

// ── which sheet is which date ───────────────────────────────────────────────

export function addDays(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Local calendar date, not UTC — the store's day ends at local midnight. */
export function localIsoDate(now = new Date()) {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

/**
 * Decide which weekday sheet belongs to which date right now.
 *
 * Each sheet is overwritten only the night before its day, so at any moment
 * the seven sheets hold today's plan, the plans of the six days before it,
 * and — for tomorrow's weekday — either tomorrow's plan (once tonight's update
 * lands) or still the plan from six days ago. Concretely, on a Wednesday:
 *
 *   WEDNESDAY → today            (mode "today": newest edit wins until midnight)
 *   FRI … TUE → the past 5 days  (mode "backfill")
 *   THURSDAY  → tomorrow OR last Thursday — ambiguous
 *
 * Backfill fills a past day ONCE: a date we have already applied is never
 * applied again, so the midnight lock holds (and the service also refuses a
 * day the grid already treats as finalized).
 *
 * The ambiguous sheet is settled by what we applied last time: identical to
 * our copy of the past date → still the old plan; different → tomorrow's. On
 * a first run there is no copy, so `chooseAmbiguous(cells, pastDate,
 * futureDate)` decides (the service compares how well the names and hours fit
 * each day's schedule) and may return null to leave it alone.
 *
 * A sheet identical to what we applied to the same weekday a week earlier was
 * never updated that week, and is skipped rather than written as a new day.
 *
 * @param {object} sheets     weekdaySheets() output
 * @param {string} today      local ISO date
 * @param {(date:string)=>object|null} snapshotFor  stored snapshot for a date
 * @param {(cells, pastDate, futureDate)=>string|null} [chooseAmbiguous]
 * @returns {Array<{date, mode, cells, fp} | {date, skip}>}  newest first
 */
export function planDates(sheets, today, snapshotFor, chooseAmbiguous = () => null) {
  const out = [];
  const tomorrow = addDays(today, 1);
  const weekdayOf = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();

  const consider = (date, mode, cells) => {
    const fp = fingerprint(cells);
    const weekAgo = snapshotFor(addDays(date, -7));
    if (weekAgo && weekAgo.fp === fp) {
      out.push({ date, skip: `the ${WEEKDAYS[weekdayOf(date)]} sheet was not updated for this day` });
      return;
    }
    if (mode === "backfill" && snapshotFor(date)) {
      out.push({ date, skip: "already filled from the board; past days are locked" });
      return;
    }
    out.push({ date, mode, cells, fp });
  };

  // Today.
  const todayCells = sheets[weekdayOf(today)];
  if (todayCells) consider(today, "today", todayCells);
  else out.push({ date: today, skip: `no ${WEEKDAYS[weekdayOf(today)]} sheet` });

  // Tomorrow, or six days ago — the same sheet.
  const sixAgo = addDays(today, -6);
  const shared = sheets[weekdayOf(tomorrow)];
  if (!shared) {
    out.push({ date: tomorrow, skip: `no ${WEEKDAYS[weekdayOf(tomorrow)]} sheet` });
  } else {
    const fp = fingerprint(shared);
    const past = snapshotFor(sixAgo);
    let date;
    if (snapshotFor(tomorrow)) date = tomorrow;              // already tomorrow's
    else if (past) date = past.fp === fp ? null : tomorrow;  // unchanged → still the old plan
    else date = chooseAmbiguous(shared, sixAgo, tomorrow);
    if (date === tomorrow) consider(tomorrow, "tomorrow", shared);
    else if (date === sixAgo) consider(sixAgo, "backfill", shared);
    else out.push({ date: tomorrow, skip: past
      ? "tomorrow's sheet has not been updated yet"
      : "can't tell yet whether that sheet is tomorrow's plan or last week's" });
  }

  // The five days in between.
  for (let k = 1; k <= 5; k++) {
    const date = addDays(today, -k);
    const cells = sheets[weekdayOf(date)];
    if (cells) consider(date, "backfill", cells);
  }

  return out;
}

/**
 * How well one sheet fits one date's schedule: the share of its rows that
 * resolve to someone scheduled that day whose shift covers most of the hours
 * the board gives them. Used to tell tomorrow's plan from last week's.
 */
export function scheduleFit(cells, schedule, opts = {}) {
  const keys = Object.keys(cells || {});
  if (!keys.length || !schedule?.length) return 0;
  const { matched } = resolveBoardNames(cells, schedule, opts);
  const byName = new Map(schedule.map((s) => [String(s.name).toUpperCase(), s]));
  const good = keys.filter((k) => {
    const s = byName.get(matched[k]?.name);
    return s && matched[k].how !== "hours match" && shiftFit(cells[k], s) >= HOURS_FIT;
  });
  return good.length / keys.length;
}

// ── names ───────────────────────────────────────────────────────────────

function splitName(full) {
  const parts = String(full || "").trim().toUpperCase().split(/\s+/).filter(Boolean);
  return { first: parts[0] || "", last: parts.slice(1).join("") };
}

/**
 * The grid slots a scheduled shift touches, [start, end).
 *
 * A shift ending on the half hour (4:00–8:30pm) is stored with the slot its
 * end falls in EXCLUDED (endSlot = the 8–9pm slot), but the board plans that
 * half hour — as a "30" cell in the 8–9pm column. Counting only whole slots
 * scored a perfect match at 80%, which the 95% hours rule then rejected
 * (2026-09-23). A start on the half hour is already in its slot.
 */
function shiftSpan(s) {
  if (s?.startSlot == null || s?.endSlot == null) return null;
  const minutes = /:(\d{2})/.exec(String(s.shiftEnd || ""))?.[1];
  return [s.startSlot, s.endSlot + (minutes && minutes !== "00" ? 1 : 0)];
}

/** Fraction of a board row's filled slots that fall inside a scheduled shift. */
function shiftFit(slots, sched) {
  const filled = Object.keys(slots || {}).map(Number);
  const span = shiftSpan(sched);
  if (!filled.length || !span) return 0;
  return filled.filter((s) => s >= span[0] && s < span[1]).length / filled.length;
}

// Common short forms seen on hand-typed boards → the formal first names a
// schedule carries. Only consulted when no scheduled first name matches as
// typed, so a real "NICK" on the schedule always wins over NICHOLAS.
const NICKNAMES = {
  ABBY: ["ABIGAIL", "ABBIGALE", "ABIGALE"], ABBI: ["ABIGAIL", "ABBIGALE", "ABIGALE"], ALEX: ["ALEXANDER", "ALEXANDRA", "ALEXIS", "ALEXANDRIA"],
  ANDY: ["ANDREW"], ANNIE: ["ANN", "ANNA", "ANNE", "ANNABELLE", "ANNETTE"], BEN: ["BENJAMIN"],
  BETH: ["ELIZABETH", "BETHANY"], BILL: ["WILLIAM"], BOB: ["ROBERT"], BOBBY: ["ROBERT"],
  CHRIS: ["CHRISTOPHER", "CHRISTIAN", "CHRISTINA", "CHRISTINE"], CINDY: ["CYNTHIA"],
  DAN: ["DANIEL"], DANNY: ["DANIEL"], DAVE: ["DAVID"], DEB: ["DEBORAH", "DEBRA"], DEBBIE: ["DEBORAH", "DEBRA"],
  DREW: ["ANDREW"], ED: ["EDWARD"], GREG: ["GREGORY"], JAKE: ["JACOB"], JEN: ["JENNIFER"],
  JENN: ["JENNIFER"], JIM: ["JAMES"], JIMMY: ["JAMES"], JOE: ["JOSEPH"], JOEY: ["JOSEPH"],
  JON: ["JONATHAN"], KATE: ["KATHERINE", "KATHRYN", "KATELYN"], KATIE: ["KATHERINE", "KATHRYN", "KAITLYN", "KATELYN"],
  LIZ: ["ELIZABETH"], LUCY: ["LUCERO", "LUCIA", "LUCILLE"], MAGGIE: ["MARGARET"], MANDY: ["AMANDA"],
  MATT: ["MATTHEW"], MIKE: ["MICHAEL"], NATE: ["NATHAN", "NATHANIEL"], NICK: ["NICHOLAS", "NICOLAS"],
  PAT: ["PATRICK", "PATRICIA"], RICH: ["RICHARD"], RICK: ["RICHARD"], SAM: ["SAMUEL", "SAMANTHA"],
  STEVE: ["STEVEN", "STEPHEN"], SUE: ["SUSAN"], TOM: ["THOMAS"], TOMMY: ["THOMAS"], TONY: ["ANTHONY"],
  VICKY: ["VICTORIA"], WILL: ["WILLIAM"], ZACH: ["ZACHARY"], ZACK: ["ZACHARY"],
};

/**
 * At most one insertion, deletion, substitution or swap of two neighbouring
 * letters apart ("QUINN" / "QUIN", "GUAGE" / "GAUGE").
 */
function oneEditApart(a, b) {
  if (a === b) return true;
  if (a.length === b.length) {
    const diff = [...a].map((c, i) => (c !== b[i] ? i : -1)).filter((i) => i >= 0);
    if (diff.length === 2 && diff[1] === diff[0] + 1 &&
        a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]]) return true;
  }
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * Everyone in `people` this board name could plausibly mean, from the most to
 * the least specific rule; the first rule with any hit decides.
 */
function candidatesFor(key, people, { loose = false } = {}) {
  const [first, ...rest] = key.split(" ");
  const suffix = rest.join("");
  const surnameOk = (p) => !suffix || p.last.startsWith(suffix);
  const rules = [
    // "MARLA F", "STELLAN KI": first name plus the start of the surname.
    ["first name", (p) => p.first === first && surnameOk(p)],
    // "KJ": initials.
    ["initials", (p) => !suffix && /^[A-Z]{2}$/.test(first) && p.first[0] === first[0] && p.last[0] === first[1]],
    // A shortened first name. 3+ letters, or everything matches. Ahead of
    // the nickname table: "ZACK" on the board was ZACKARY, and the table's
    // ZACHARY grabbed the wrong person (2026-09-23).
    ["short name", (p) => first.length >= 3 && p.first.startsWith(first) && surnameOk(p)],
    // "NICK" → NICHOLAS.
    ["nickname", (p) => (NICKNAMES[first] || []).includes(p.first) && surnameOk(p)],
    // "QUINN" typed for QUIN. Four letters minimum, or short names collide.
    ["spelling", (p) => first.length >= 4 && oneEditApart(first, p.first) && surnameOk(p)],
  ];
  if (loose) {
    // Suggestions only, never auto-applied: a surname used as a nickname
    // ("ALEX" for KELVIN ALEXANDER), or a shared first three letters.
    rules.push(["surname", (p) => !suffix && first.length >= 3 && p.last.startsWith(first)]);
    rules.push(["similar", (p) => first.length >= 3 && p.first.slice(0, 3) === first.slice(0, 3)]);
  }
  for (const [how, test] of rules) {
    const hits = people.filter(test);
    if (hits.length) return { how, people: hits.map((p) => p.s) };
  }
  return { how: null, people: [] };
}

/** The board's hours inside the shift (HOURS_FIT), or no shift to check. */
function hoursOverlap(slots, s) {
  if (s?.startSlot == null || s?.endSlot == null || !Object.keys(slots || {}).length) return true;
  return shiftFit(slots, s) >= HOURS_FIT;
}

const peopleOf = (list) => list.map((s) => ({ s, ...splitName(s.name) }));
const upper = (s) => String(s.name).toUpperCase();

/**
 * Board names → scheduled full names for one date.
 *
 * Only people SCHEDULED that date are ever auto-matched. A single candidate
 * off the digital team is accepted only when their shift covers the hours the
 * board gives them; otherwise it is left for a person to confirm — a unique
 * first name is not proof when the whole store is on the schedule.
 *
 * @param {object} cells        { boardName: slots } for the date
 * @param {Array}  schedule     that date's schedule associates ({name, startSlot, endSlot})
 * @param {object} opts.aliases { boardName: FULL NAME } fixed by hand, device-local
 * @param {(name)=>boolean} opts.isDigital  classification lookup
 * @param {string[]} opts.roster  digital team names, scheduled or not — suggestions only
 * @returns {{ matched: {[boardName]: {name, how}}, unmatched: Array<{boardName, candidates}> }}
 */
export function resolveBoardNames(cells, schedule, {
  aliases = {}, isDigital = () => false, roster = [], learned = null, noHours = false,
} = {}) {
  const sched = Array.isArray(schedule) ? schedule : [];
  const people = peopleOf(sched);
  const byFull = new Map(sched.map((s) => [upper(s), s]));
  const classified = sched.some((s) => isDigital(s.name));
  const matched = {};
  const taken = new Set();
  const pending = [];

  for (const key of Object.keys(cells || {})) {
    const alias = aliases[key];
    if (alias) { matched[key] = { name: alias.toUpperCase(), how: "alias" }; taken.add(alias.toUpperCase()); continue; }
    if (byFull.has(key)) { matched[key] = { name: key, how: "exact" }; taken.add(key); continue; }
    const c = candidatesFor(key, people);
    pending.push({ key, how: c.how, cands: c.people });
  }

  const decide = (row, s, how) => {
    matched[row.key] = { name: upper(s), how };
    // Matched on hours alone: keep the people the NAME pointed to (rejected
    // for their shift) so a person can pick one in one click.
    if (how.startsWith("hours")) {
      const alt = row.cands.map(upper).filter((n) => n !== upper(s)).slice(0, 3);
      if (alt.length) matched[row.key].alt = alt;
    }
    taken.add(upper(s));
  };
  const plausible = (row, s) =>
    !classified || isDigital(s.name) || shiftFit(cells[row.key], s) >= HOURS_FIT;

  // Narrow by elimination, then by tie-breaks, one decision at a time so each
  // resolution can remove a candidate from the rows still waiting.
  let progress = true;
  while (progress) {
    progress = false;
    for (const row of pending) {
      if (matched[row.key]) continue;
      // Hours first: a namesake working a different shift is not the person
      // the board means; without this "ZACK" (11–5) took a 6am Zachary.
      const free = row.cands.filter((c) => !taken.has(upper(c)) && hoursOverlap(cells[row.key], c));
      if (free.length === 1) {
        if (plausible(row, free[0])) { decide(row, free[0], row.how); progress = true; }
        continue;
      }
      if (free.length < 2) continue;

      // Several people fit the name. Prefer the digital team, then whoever's
      // shift actually covers the hours the board gives them — but only on a
      // clear winner.
      const digital = free.filter((c) => isDigital(c.name));
      const pool = digital.length ? digital : free;
      if (pool.length === 1) { decide(row, pool[0], `${row.how}, digital team`); progress = true; continue; }
      const scored = pool.map((c) => ({ c, fit: shiftFit(cells[row.key], c) })).sort((a, b) => b.fit - a.fit);
      if (scored[0].fit >= HOURS_FIT && scored[0].fit - scored[1].fit >= 0.25) {
        decide(row, scored[0].c, `${row.how}, shift fit`); progress = true;
      }
    }
  }

  // Learned across the week (learnFromHistory): the one person whose hours
  // fit this board name on (nearly) every day it appears. Applied only when
  // that person is scheduled today and today's hours broadly agree.
  for (const row of pending) {
    const l = learned?.[row.key];
    if (matched[row.key] || !l || taken.has(l.name)) continue;
    const s = byFull.get(l.name);
    if (s && shiftFit(cells[row.key], s) >= HOURS_FIT) decide(row, s, `hours, ${l.fits} of ${l.days} days`);
  }

  // Last resort: the leftover pool. A board name that matches nobody is very
  // often someone who goes by a middle name or a nickname the schedule's legal
  // name does not show (2026-09-23: all four unresolved rows at 1458 had
  // exactly one unboarded digital associate with identical hours). So match on
  // shift start AND end, among scheduled digital associates no board row has
  // claimed, leaders excluded (the board does not plan the TLs and coach).
  // Only a one-to-one exact fit counts; "hours match" keeps it reviewable.
  const leftover = sched.filter((s) =>
    isDigital(s.name) && !taken.has(upper(s)) && !leadershipForJob(s.jobName) &&
    s.startSlot != null && s.endSlot != null);
  const exact = new Map();
  for (const row of pending) {
    if (matched[row.key]) continue;
    const filled = Object.keys(cells[row.key] || {}).map(Number).sort((a, b) => a - b);
    if (!filled.length) continue;
    const [a, b] = [filled[0], filled.at(-1) + 1];
    exact.set(row, leftover.filter((s) => { const [x, y] = shiftSpan(s); return x === a && y === b; }));
  }
  if (noHours) exact.clear();
  const claims = new Map();
  for (const hits of exact.values()) for (const s of hits) claims.set(upper(s), (claims.get(upper(s)) || 0) + 1);
  for (const [row, hits] of exact) {
    if (hits.length === 1 && claims.get(upper(hits[0])) === 1) decide(row, hits[0], "hours match");
  }

  // Whatever is left is flagged, with who it might be: the scheduled people
  // who fit, then anyone on the digital team (scheduled or not) who loosely
  // fits — someone added to the board after the schedule was pulled, or a
  // surname used as a nickname.
  const wider = peopleOf([
    ...sched.filter((s) => isDigital(s.name)),
    ...roster.filter((n) => !byFull.has(String(n).toUpperCase())).map((name) => ({ name })),
  ]);
  const unmatched = pending
    .filter((r) => !matched[r.key])
    .map((r) => {
      const names = new Set(r.cands.map(upper));
      for (const s of candidatesFor(r.key, wider, { loose: true }).people) names.add(upper(s));
      return { boardName: r.key, candidates: [...names].filter((n) => !taken.has(n)).slice(0, 6) };
    });
  return { matched, unmatched };
}

/**
 * Learn board names that match nobody by name, from a week of days.
 *
 * Someone who goes by a middle name or a nickname ("ALEX", "TUCKER") is on
 * the schedule under their legal name, working the same hours the board gives
 * them, every day they appear. One day's exact-hours fit can be a coincidence;
 * the same person fitting on (nearly) every day is not. Verified 2026-09-23 on
 * 1458's backfilled week: five recurring names each had exactly one such person.
 *
 * Accepted only with 2+ days of evidence, hours fitting on every day (or all
 * but one, from 4 days up), exact on most of them, and a clear margin over the
 * runner-up. A person claimed by two board names is dropped for both.
 *
 * @param {Array<{cells, schedule}>} days
 * @returns {{[boardName]: {name, days, fits, exact}}}
 */
export function learnFromHistory(days, opts = {}) {
  const isDigital = opts.isDigital || (() => false);
  const per = {};
  for (const { cells, schedule } of days) {
    if (!cells || !schedule?.length) continue;
    const { matched } = resolveBoardNames(cells, schedule, { ...opts, learned: null, noHours: true });
    const taken = new Set(Object.values(matched).map((m) => m.name));
    const leftover = schedule.filter((s) => isDigital(s.name) && !taken.has(upper(s)) &&
      !leadershipForJob(s.jobName) && s.startSlot != null && s.endSlot != null);
    for (const key of Object.keys(cells)) {
      if (matched[key]) continue;
      const filled = Object.keys(cells[key]).map(Number).sort((a, b) => a - b);
      if (!filled.length) continue;
      const [a, b] = [filled[0], filled.at(-1) + 1];
      const cands = new Map();
      for (const s of leftover) {
        if (shiftFit(cells[key], s) >= HOURS_FIT) {
          const [x, y] = shiftSpan(s);
          cands.set(upper(s), Math.abs(x - a) + Math.abs(y - b));
        }
      }
      (per[key] ||= []).push(cands);
    }
  }

  const out = {};
  for (const [key, list] of Object.entries(per)) {
    const n = list.length;
    if (n < 2) continue;   // one day is the single-day hours rule's job
    const scored = [...new Set(list.flatMap((c) => [...c.keys()]))]
      .map((name) => ({
        name,
        fits:  list.filter((c) => c.has(name)).length,
        exact: list.filter((c) => c.get(name) === 0).length,
      }))
      .sort((x, y) => y.fits - x.fits || y.exact - x.exact);
    const [best, next] = scored;
    if (!best) continue;
    const enoughDays = best.fits === n || (n >= 4 && best.fits === n - 1);
    const mostlyExact = best.exact >= Math.ceil(n * 0.6);
    const clear = !next || best.fits - next.fits >= 2 || (best.fits > next.fits && best.exact > next.exact);
    if (enoughDays && mostlyExact && clear) out[key] = { name: best.name, days: n, fits: best.fits, exact: best.exact };
  }

  const claimed = {};
  for (const l of Object.values(out)) claimed[l.name] = (claimed[l.name] || 0) + 1;
  for (const [k, l] of Object.entries(out)) if (claimed[l.name] > 1) delete out[k];
  return out;
}

// ── merge into the assignment document ─────────────────────────────────────

/**
 * Apply one date's board to its assignment document, newest edit winning.
 *
 * @param {object|null} doc        current assignments doc (decoded), or null
 * @param {object} p.cells         { boardName: slots } from the board now
 * @param {object} p.matched       resolveBoardNames().matched
 * @param {object|null} p.previous snapshot cells from our last pull of this date
 * @param {object|null} p.previousNames  { boardName: name it was filed under } from that pull
 * @param {string} p.boardModifiedAt  the workbook's last-modified time (ISO)
 * @param {Array}  p.schedule      that date's schedule associates, for shifts
 * @returns {{ associates, changedCells, addedRows, renamedRows }}
 */
export function mergeBoard(doc, { cells, matched, previous, previousNames = null, boardModifiedAt, schedule }) {
  const associates = (doc?.associates || []).map((a) => ({ ...a, slots: { ...(a.slots || {}) } }));
  const byName = new Map(associates.map((a) => [String(a.name).toUpperCase(), a]));
  const sched = new Map((schedule || []).map((s) => [String(s.name).toUpperCase(), s]));

  // First sight of this date: nothing to diff against, so fall back to
  // timestamps. If the app was edited after the workbook was last saved the
  // app is newer and the board only fills gaps; otherwise the board wins.
  const boardIsNewer = !doc?.updatedAt || !boardModifiedAt || boardModifiedAt >= doc.updatedAt;

  let changedCells = 0, addedRows = 0, renamedRows = 0;

  // An earlier pull filed a board row under someone else: the name as typed
  // (before a fix resolved it), or a different person (the match changed).
  // Its board-given cells move to the right person — usually a row the
  // schedule already created, empty. Two passes, all lifts before any drops:
  // one person's cells can leave a row another board name is moving INTO
  // ("ZACK" out of a row, "TUCKER" into it, same hours), and interleaving
  // them dropped the overlap. Cells edited in the app since stay put.
  const pendingMoves = new Map();
  for (const key of Object.keys(cells)) {
    const name = matched[key]?.name || key;
    const oldName = previousNames?.[key] ?? (name !== key && byName.has(key) ? key : null);
    if (!oldName || oldName === name || !byName.has(oldName)) continue;
    const old = byName.get(oldName);
    const given = previous?.[key] || old.slots;   // the typed-name row is all board
    const lifted = {};
    for (const [k, v] of Object.entries(given)) {
      if (old.slots[k] !== v) continue;
      lifted[k] = v;
      delete old.slots[k];
    }
    pendingMoves.set(key, { cells: lifted, template: old });
    // A typed-name row exists only to hold the board's cells.
    if (oldName === key && !Object.keys(old.slots).length) {
      associates.splice(associates.indexOf(old), 1);
      byName.delete(oldName);
    }
  }

  for (const [key, slots] of Object.entries(cells)) {
    const name = matched[key]?.name || key;

    let row = byName.get(name);

    const moved = pendingMoves.get(key);
    if (moved) {
      if (!row) {
        row = { ...moved.template, name, slots: {} };
        associates.push(row);
        byName.set(name, row);
      }
      for (const [k, v] of Object.entries(moved.cells)) if (!row.slots[k]) row.slots[k] = v;
      renamedRows++;
    }
    if (!row) {
      const s = sched.get(name);
      const filled = Object.keys(slots).map(Number).sort((a, b) => a - b);
      row = {
        name,
        slots: {},
        status: null,
        shiftStart: s?.startSlot ?? filled[0],
        shiftEnd:   s?.endSlot ?? filled.at(-1) + 1,
        shiftLabel: s?.shiftStart && s?.shiftEnd ? `${s.shiftStart}-${s.shiftEnd}` : null,
      };
      associates.push(row);
      byName.set(name, row);
      addedRows++;
    }

    const prev = previous ? previous[key] || {} : null;
    const keys = new Set([...Object.keys(slots), ...Object.keys(prev || {})]);
    for (const k of keys) {
      const now = slots[k];
      let apply;
      if (prev) apply = now !== prev[k];                 // the board changed it
      else apply = boardIsNewer ? true : !row.slots[k];  // first sight
      if (!apply || row.slots[k] === now) continue;
      if (now) row.slots[k] = now; else delete row.slots[k];
      changedCells++;
    }
  }

  // A row the board dropped since last pull loses the cells the board gave it
  // but keeps any the app added.
  if (previous) {
    for (const [key, prevSlots] of Object.entries(previous)) {
      if (cells[key]) continue;
      const row = byName.get(matched[key]?.name || key) || byName.get(key);
      if (!row) continue;
      for (const [k, v] of Object.entries(prevSlots)) {
        if (row.slots[k] === v) { delete row.slots[k]; changedCells++; }
      }
    }
  }

  return { associates, changedCells, addedRows, renamedRows, unchanged: !changedCells && !addedRows && !renamedRows };
}
