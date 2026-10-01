// modules/safetyagent/lib/oncall.js
//
// Who was on the clock when an alert went out, and who let it pass.
//
// SafeIQ names only the associate who ACCEPTED an alert; everyone it was
// offered to and who did nothing is invisible in its table. The routing is
// known, though (store's camera list on the StoreSystemsIDC SharePoint site,
// confirmed by the user 2026-10-01):
//
//   wave 1  the alert goes to the camera's Responsible Team — only the
//           associates of that team who are clocked in;
//   wave 2  after 3 minutes, or when every wave-1 associate taps Not
//           Available, it goes to ALL team leads and coaches on shift.
//
// So with each associate's punches (GTA timesheet) and job title (WFM
// schedule) the offered-to list for every alert can be rebuilt, and an
// alert that crossed the 3-minute line names the people who let it.
//
// Pure: no chrome.*, Node-testable. Inputs are plain JSON.

export const WAVE1_MIN = 3;

/**
 * SharePoint "Responsible Team" → the schedule job titles that make up that
 * team's hourly associates. Leads and coaches are deliberately NOT here: they
 * are wave 2 for every camera.
 */
export const TEAM_JOBS = Object.freeze({
  "Fashion":              /^(Fashion( Stocking)? TA|Fitting Rm Assoc)$/i,
  "Food and Consumables": /^Food & Consumables TA$/i,
  "Front End":            /^(Front End (Checkout|Services) TA|Cosmetics Cashier|Cart Assoc)$/i,
  "Health and Beauty":    /^Health & Beauty TA$/i,
  "Hardlines":            /^Hardlines TA$/i,
  "Seasonal":             /^Seasonal TA$/i,
  "Entertainment":        /^Entertainment TA$/i,
  "Auto Care Center":     /^Auto Care Ctr /i,
  "Meat and Produce":     /^Meat\/Produce TA$/i,
  "Home":                 /^Home TA$/i,
  "Vision":               /^(Optician|Dual Licensed Opt|Vision Center Mgr Hrly)$/i,
  "Bakery and Deli":      /^(Deli\/Bakery TA|Cake Decorator)$/i,
});

/** Team leads and coaches — the wave-2 audience. */
export const LEADER_RE = /\bTL\b|\bTeam Lead\b|\bCoach\b|\bStore Manager\b/i;

export function teamForJob(jobName) {
  const j = String(jobName || "").trim();
  if (!j || LEADER_RE.test(j)) return null;
  for (const [team, re] of Object.entries(TEAM_JOBS)) if (re.test(j)) return team;
  return null;
}

export const isLeader = (jobName) => LEADER_RE.test(String(jobName || ""));

/**
 * Name key that lines up the three spellings in play:
 *   SafeIQ   "DANA PRICE"
 *   schedule "LUIS GARCIA RAMOS"
 *   GTA      "PRICE, DANA J"
 * → "DANA|PRICE" (first given name | surname). A GTA middle initial
 * is dropped; a schedule's multi-word surname is matched on its last word
 * and, failing that, on the whole tail (see matchPeople).
 */
export function nameKeys(raw) {
  const s = String(raw || "").toUpperCase().replace(/[^A-Z,\s'-]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return [];
  if (s.includes(",")) {
    const [last, given = ""] = s.split(",").map((x) => x.trim());
    const first = given.split(" ")[0] || "";
    const lastWords = last.split(" ");
    return [...new Set([`${first}|${last}`, `${first}|${lastWords.at(-1)}`, `${first}|${lastWords[0]}`])];
  }
  const w = s.split(" ");
  if (w.length < 2) return [];
  return [...new Set([`${w[0]}|${w.at(-1)}`, `${w[0]}|${w.slice(1).join(" ")}`, `${w[0]}|${w[1]}`])];
}

/** "9:00am" / "12:30pm" → minutes since midnight. */
export function clockToMin(s) {
  const m = /^(\d{1,2}):(\d{2})\s*([ap])m$/i.exec(String(s || "").trim());
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toLowerCase() === "p") h += 12;
  return h * 60 + Number(m[2]);
}

/**
 * GTA punches for one employee-day → worked intervals [startMin, endMin],
 * minutes since midnight of that day (past 1440 for after midnight).
 * Punch kinds: in (1), out (2), switch (6) carrying TCODE MEAL or WRK.
 * A shift with an IN and no OUT yet (still on the clock) runs to `openEnd`.
 */
export function workedIntervals(punches, openEnd = null) {
  const out = [];
  let start = null;
  for (const p of punches || []) {
    if (p.kind === "in") { if (start == null) start = p.min; }
    else if (p.kind === "out") { if (start != null) { out.push([start, p.min]); start = null; } }
    else if (p.kind === "switch") {
      if (p.code === "MEAL" || p.code === "BREAK") { if (start != null) { out.push([start, p.min]); start = null; } }
      else if (start == null) start = p.min;          // back from meal
    }
  }
  if (start != null && openEnd != null && openEnd > start) out.push([start, openEnd]);
  return out;
}

/**
 * Does this schedule doc belong to the punches' store? Store 1458's docs for
 * 2026-09-06..11 hold store 5151's roster (the shared-store-list bug noted in
 * digitalmetrics/service.js) and match nobody. Half the schedule matching a
 * puncher is the bar; real days match 85–95%.
 */
export function scheduleMatches(schedule = [], punches = []) {
  if (!schedule.length) return false;
  const keys = new Set(punches.filter((g) => g.punches?.length).flatMap((g) => nameKeys(g.gtaName)));
  const hit = schedule.filter((s) => nameKeys(s.name).some((k) => keys.has(k))).length;
  return hit >= schedule.length * 0.5;
}

/** { nameKey: jobName } across many schedule days; later days win. */
export function buildRoster(schedulesByDate = {}) {
  const roster = {};
  for (const date of Object.keys(schedulesByDate).sort()) {
    for (const s of schedulesByDate[date] || []) {
      if (!s?.jobName) continue;
      for (const k of nameKeys(s.name)) roster[k] = s.jobName;
    }
  }
  return roster;
}

const inAny = (ivs, min) => ivs.some(([a, b]) => min >= a && min < b);

/**
 * One store-day: join the schedule (who, which job, planned hours) to the
 * punches (when they were actually working).
 *
 * @param schedule  [{ name, jobName, shiftStart, shiftEnd }]  WFM schedule doc's associates
 * @param punches   [{ gtaName, win, punches:[{ kind, min, code }] }] GTA rows for the day
 * @param roster    { nameKey: jobName } from other days' schedules — titles for
 *                  people who punched but are missing from this day's schedule
 * @param nowMin    minutes since midnight if `date` is today (open shifts run to it), else null
 * @returns [{ name, job, team, leader, worked:[[a,b]], sched:[a,b]|null, punched }]
 */
export function buildDay({ schedule = [], punches = [], roster = {}, nowMin = null }) {
  const byKey = new Map();
  for (const g of punches) {
    if (!g.punches?.length) continue;
    for (const k of nameKeys(g.gtaName)) if (!byKey.has(k)) byKey.set(k, g);
  }
  const used = new Set();
  const people = [];
  for (const s of schedule) {
    const g = nameKeys(s.name).map((k) => byKey.get(k)).find((x) => x && !used.has(x));
    if (g) used.add(g);
    let a = clockToMin(s.shiftStart), b = clockToMin(s.shiftEnd);
    if (a != null && b != null && b <= a) b += 1440;  // overnight
    people.push({
      name: String(s.name || "").toUpperCase(),
      job: s.jobName || "",
      team: teamForJob(s.jobName),
      leader: isLeader(s.jobName),
      worked: g ? workedIntervals(g.punches, nowMin) : [],
      sched: a != null && b != null ? [a, b] : null,
      punched: !!g,
    });
  }
  // Punched but not on this day's schedule (picked up a shift, schedule
  // pulled before a change, or the day's schedule doc is unusable). Their
  // title comes from the roster built off the other days, when it has them.
  for (const g of punches) {
    if (!g.punches?.length || used.has(g)) continue;
    const [last, given = ""] = String(g.gtaName || "").split(",");
    const job = nameKeys(g.gtaName).map((k) => roster[k]).find(Boolean) || "";
    people.push({
      name: `${given.trim().split(" ")[0] || ""} ${last.trim()}`.trim().toUpperCase(),
      job, team: teamForJob(job), leader: isLeader(job),
      worked: workedIntervals(g.punches, nowMin), sched: null, punched: true, fromRoster: !!job,
    });
  }
  return people;
}

/**
 * Is this person working at `min`? Punches decide. A leader with no punches
 * that day (salaried) falls back to their scheduled shift and is flagged so
 * the view can say "scheduled" instead of "clocked in".
 */
export function presence(p, min) {
  if (p.punched) return inAny(p.worked, min) ? "clock" : null;
  if (p.leader && p.sched && min >= p.sched[0] && min < p.sched[1]) return "sched";
  return null;
}

const tsMin = (ts) => { const m = /(\d{2}):(\d{2})$/.exec(ts || ""); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const sameName = (a, b) => { const ka = new Set(nameKeys(a)); return nameKeys(b).some((k) => ka.has(k)); };

/**
 * Rebuild who each alert was offered to.
 *
 * @param alerts   compact rows (lib/sql.js::compactRow)
 * @param camTeam  { cameraName: responsibleTeam }
 * @param days     { "YYYY-MM-DD": people[] from buildDay }
 * @returns per alert: { i, date, min, camera, team, ack, accepter, outcome,
 *                       wave1:[{name, how}], wave2:[{name, job, how}] } or
 *                  { i, skip: "no camera team" | "no punches for the day" }
 *
 * outcome: "taken"     accepted inside 3 minutes
 *          "escalated" accepted after 3 minutes (wave 2 was live)
 *          "unanswered" never accepted (NOT AVAILABLE / NO ACTION)
 */
export function offeredTo(alerts, camTeam, days, COL) {
  const out = [];
  alerts.forEach((r, i) => {
    const date = r[COL.date], min = tsMin(r[COL.ts]), team = camTeam[r[COL.camera]] || null;
    if (!team) { out.push({ i, skip: "no camera team" }); return; }
    const people = days[date];
    if (!people?.length || min == null) { out.push({ i, skip: "no punches for the day" }); return; }
    const ack = r[COL.ack], accepted = String(r[COL.action]).toUpperCase() === "ACCEPTED";
    const accepter = accepted ? r[COL.assoc] || "" : "";
    const outcome = !accepted ? "unanswered" : ack != null && ack > WAVE1_MIN ? "escalated" : "taken";
    const wave1 = [], wave2 = [];
    for (const p of people) {
      if (p.team === team) {
        const how = presence(p, min);
        if (how) wave1.push({ name: p.name, how, took: !!accepter && sameName(p.name, accepter) });
      } else if (p.leader && outcome !== "taken") {
        const how = presence(p, min + WAVE1_MIN);
        if (how) wave2.push({ name: p.name, job: p.job, how, took: !!accepter && sameName(p.name, accepter) });
      }
    }
    out.push({ i, date, min, camera: r[COL.camera], team, ack, accepter, outcome, wave1, wave2 });
  });
  return out;
}

/**
 * Per-person roll-up of offeredTo().
 *   offered    wave-1 alerts they were on the clock for
 *   took       of those, the ones they accepted
 *   others     of those, the ones someone else accepted inside 3 minutes
 *   passed     wave-1 alerts that escalated or went unanswered while they
 *              were on the clock — the "let it go" count
 *   esc        (leaders) escalations that reached them
 *   escTook    (leaders) escalations they accepted
 *   escPassed  (leaders) escalations still open 10+ min after reaching them, or never answered
 */
export const LEAD_SIT_MIN = 10;

export function rollupPeople(offers, people = {}) {
  const by = new Map();
  const get = (name, extra) => {
    if (!by.has(name)) by.set(name, { name, job: "", team: null, offered: 0, took: 0, others: 0, passed: 0, esc: 0, escTook: 0, escPassed: 0, alerts: [], ...extra });
    return by.get(name);
  };
  for (const o of offers) {
    if (o.skip) continue;
    for (const w of o.wave1) {
      const p = get(w.name, { team: o.team, job: people[w.name]?.job || "" });
      p.offered++;
      if (w.took) p.took++;
      else if (o.outcome === "taken") p.others++;
      else { p.passed++; p.alerts.push(o.i); }
    }
    for (const w of o.wave2) {
      const p = get(w.name, { job: w.job });
      p.esc++;
      if (w.took) p.escTook++;
      else if (o.outcome === "unanswered" || (o.ack != null && o.ack > WAVE1_MIN + LEAD_SIT_MIN)) { p.escPassed++; p.alerts.push(o.i); }
    }
  }
  return [...by.values()];
}

/**
 * The whole view-side pipeline over the service's cache.
 *
 * @param rows    compact alert rows (already date-filtered)
 * @param oncall  service cache: { camTeam: { cam: { team } }, days: { iso: { sched, punch } } }
 * @param COL     lib/aggregate.js::COL
 * @param today   { iso, min } — today's date and minutes now; open shifts run to it
 * @returns { offers, people, missingDays, unknownCams, schedFallbackDays, takenBy, summary }
 */
export function analyzeOncall(rows, oncall, COL, today = null) {
  const camTeam = {};
  for (const [cam, v] of Object.entries(oncall?.camTeam || {})) if (v?.team) camTeam[cam] = v.team;

  // Schedules decoded once; a day whose schedule does not match its punches
  // (wrong store's roster) contributes nothing to the roster either.
  const raw = {};
  for (const [iso, d] of Object.entries(oncall?.days || {})) {
    const punches = (d.punch || []).map(([gtaName, ps]) => ({ gtaName, punches: ps.map(([kind, min, code]) => ({ kind, min, code: code || null })) }));
    const schedule = (d.sched || []).map(([name, jobName, shiftStart, shiftEnd]) => ({ name, jobName, shiftStart, shiftEnd }));
    raw[iso] = { punches, schedule, good: scheduleMatches(schedule, punches) };
  }
  const roster = buildRoster(Object.fromEntries(Object.entries(raw).filter(([, v]) => v.good).map(([iso, v]) => [iso, v.schedule])));

  const needed = [...new Set(rows.map((r) => r[COL.date]))];
  const days = {}, missingDays = [], schedFallbackDays = [];
  for (const iso of needed) {
    const v = raw[iso];
    if (!v?.punches.length) { missingDays.push(iso); continue; }
    if (!v.good) schedFallbackDays.push(iso);
    days[iso] = buildDay({ schedule: v.good ? v.schedule : [], punches: v.punches, roster, nowMin: today && iso === today.iso ? today.min : null });
  }

  const offers = offeredTo(rows, camTeam, days, COL);
  const unknownCams = [...new Set(offers.filter((o) => o.skip === "no camera team").map((o) => rows[o.i][COL.camera]))];

  // Who accepted, by role — the routing check: if leaders take most alerts
  // inside 3 minutes, they are being offered alerts before the escalation.
  const jobByKey = {};
  for (const ppl of Object.values(days)) for (const p of ppl) if (p.job) for (const k of nameKeys(p.name)) jobByKey[k] ??= p.job;
  const takenBy = { team: 0, teamLate: 0, leader: 0, leaderEarly: 0, other: 0, unknown: 0 };
  for (const o of offers) {
    if (o.skip || !o.accepter) continue;
    const job = nameKeys(o.accepter).map((k) => jobByKey[k]).find(Boolean) || roster[nameKeys(o.accepter)[0]] || "";
    o.accepterJob = job;
    if (!job) takenBy.unknown++;
    else if (isLeader(job)) { takenBy.leader++; if (o.outcome === "taken") takenBy.leaderEarly++; }
    else if (teamForJob(job) === o.team) { takenBy.team++; if (o.outcome !== "taken") takenBy.teamLate++; }
    else takenBy.other++;
  }

  const jobOf = {};
  for (const ppl of Object.values(days)) for (const p of ppl) if (p.job) jobOf[p.name] = p.job;
  const people = rollupPeople(offers, Object.fromEntries(Object.entries(jobOf).map(([n, job]) => [n, { job }])));
  for (const p of people) { p.key = p.name; p.rows = p.alerts.map((i) => rows[i]); }

  const ok = offers.filter((o) => !o.skip);
  const summary = {
    analysed: ok.length,
    taken: ok.filter((o) => o.outcome === "taken").length,
    escalated: ok.filter((o) => o.outcome === "escalated").length,
    unanswered: ok.filter((o) => o.outcome === "unanswered").length,
    noTeamOnClock: ok.filter((o) => !o.wave1.length).length,
    passedWithTeamOnClock: ok.filter((o) => o.outcome !== "taken" && o.wave1.length).length,
  };
  return { offers, people, missingDays, unknownCams, schedFallbackDays, takenBy, summary };
}
