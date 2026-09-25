// modules/stockingplan/lib/shifts.js
// Pure functions — no DOM, no chrome.*.
//
// Turns CaseVisibility's `schedule.scheduled_associates` rows into the labour
// picture a stocking plan is actually written against: who is on each stocking
// shift and how many hours they add up to.
//
// ── Where the job codes came from ──────────────────────────────────────────
// Every code below was observed in live Main.ashx?func=init responses for
// store 1458 across 44 consecutive business dates (2026-08-08 … 2026-09-20).
// That window covers the whole job-code universe the store schedules, so an
// unmapped code is either new or another store's — `classifyJob` falls back to
// shift-start time rather than dropping the row.
//
// ── The shift day ─────────────────────────────────────────────────────────
// For CV business date D:
//   Stock 1     06:00 D      → 15:00 D
//   Stock 2     14:00 D      → 23:00 D
//   Overnight   22:00 D      → 07:00 D+1   (verified on shift_start_ts)
// A plan written on D therefore covers Stock 2 on D, Overnight on D, and
// Stock 1 on **D+1** — the morning crew that inherits whatever the night
// crew could not reach. That is why the module pulls two business dates.

// ── Job-code table ────────────────────────────────────────────────────────
// group: which bucket the associate's hours land in
// rank:  "coach" | "lead" | "assoc"  (leads/coaches are shown but excluded
//        from stocking capacity — they run the shift, they don't work freight)
// area:  free-text hint used when offering a group as next-day backup

const JOBS = {
  // --- Stock 1 (first shift stocking, 6a–3p) -------------------------------
  "1-695-7550": { group: "stock1", rank: "assoc", desc: "Stocking 1 TA" },
  "1-695-7530": { group: "stock1", rank: "lead",  desc: "Stocking 1 TL" },
  "1-0-40406":  { group: "stock1", rank: "coach", desc: "Stocking 1 Coach" },

  // --- Stock 2 (second shift stocking, 2p–11p) ----------------------------
  "1-695-7540": { group: "stock2", rank: "assoc", desc: "Stocking 2 TA" },
  "1-615-7210": { group: "stock2", rank: "lead",  desc: "Stocking 2 TL" },
  "1-0-40419":  { group: "stock2", rank: "coach", desc: "Stocking 2 Coach" },

  // --- Overnight / Stock 3 (10p–7a) ---------------------------------------
  "1-635-7440": { group: "stock3", rank: "assoc", desc: "Stocking ON TA" },
  "1-635-7240": { group: "stock3", rank: "lead",  desc: "Stocking ON TL" },
  "1-0-40407":  { group: "stock3", rank: "coach", desc: "Overnight Stocking Coach" },
  "1-600-7443": { group: "stock3", rank: "assoc", desc: "O/N Meat/Produce TA", area: "Meat/Produce" },

  // --- Overnight modular team ---------------------------------------------
  "1-635-7441": { group: "modteam", rank: "assoc", desc: "Modular ON TA" },
  "1-998-151":  { group: "modteam", rank: "assoc", desc: "Setup Assoc Temp ON" },

  // --- Overnight maintenance (not freight capacity) -----------------------
  "1-995-710":  { group: "maintenance", rank: "assoc", desc: "Maint Assoc ON" },
  "1-635-7230": { group: "maintenance", rank: "lead",  desc: "Clean Team Lead" },

  // --- Salesfloor stocking teams — the next-day backup pool ---------------
  "1-615-7400": { group: "deptstock", rank: "assoc", desc: "Food & Consumables TA", area: "Grocery / 4-8-13-79 / 2-40-46" },
  "1-615-7200": { group: "deptstock", rank: "lead",  desc: "Food & Consumables TL", area: "Grocery" },
  "1-600-7400": { group: "deptstock", rank: "assoc", desc: "Meat/Produce TA",       area: "Meat / Produce / 82" },
  "1-600-7200": { group: "deptstock", rank: "lead",  desc: "Meat/Produce TL",       area: "Meat / Produce" },
  "1-600-7420": { group: "deptstock", rank: "assoc", desc: "Deli/Bakery TA",        area: "Deli / Bakery / FDD" },
  "1-600-7220": { group: "deptstock", rank: "lead",  desc: "Deli/Bakery TL",        area: "Deli / Bakery" },
  "1-640-7412": { group: "deptstock", rank: "assoc", desc: "Seasonal TA",           area: "D18 seasonal / garden" },
  "1-610-7210": { group: "deptstock", rank: "lead",  desc: "Seasonal TL",           area: "D18 seasonal / garden" },
  "1-640-7411": { group: "deptstock", rank: "assoc", desc: "Hardlines TA",          area: "Hardware / automotive / sporting goods / toys" },
  "1-640-7200": { group: "deptstock", rank: "lead",  desc: "Hardlines TL",          area: "Hardware / automotive" },
  "1-640-7410": { group: "deptstock", rank: "assoc", desc: "Entertainment TA",      area: "D5 / D72 entertainment" },
  "1-640-7210": { group: "deptstock", rank: "lead",  desc: "Entertainment TL",      area: "Entertainment" },
  "1-660-7400": { group: "deptstock", rank: "assoc", desc: "Home TA",               area: "Home 14 / 74" },
  "1-620-7200": { group: "deptstock", rank: "lead",  desc: "Home TL",               area: "Home" },
  "1-655-7400": { group: "deptstock", rank: "assoc", desc: "Health & Beauty TA",    area: "HBA / 3-19-67" },
  "1-615-7310": { group: "deptstock", rank: "lead",  desc: "Health & Beauty TL",    area: "HBA / 3-19-67" },
  "1-625-7420": { group: "deptstock", rank: "assoc", desc: "Fashion Stocking TA",   area: "Apparel" },
  "1-625-7400": { group: "deptstock", rank: "assoc", desc: "Fashion TA",            area: "Apparel" },
  "1-625-7200": { group: "deptstock", rank: "lead",  desc: "Fashion TL",            area: "Apparel" },
};

// Groups whose hours count as "stocking capacity" for tonight's freight.
export const FREIGHT_GROUPS = ["stock2", "stock3"];

// Display order + labels for every group we bucket into.
export const GROUP_META = {
  stock1:      { label: "Stock 1",          order: 1 },
  stock2:      { label: "Stock 2",          order: 2 },
  stock3:      { label: "Overnight",        order: 3 },
  modteam:     { label: "Mod Team",         order: 4 },
  maintenance: { label: "Overnight Maint",  order: 5 },
  deptstock:   { label: "Salesfloor teams", order: 6 },
  other:       { label: "Other",            order: 7 },
};

// Codes that are unmapped fall back to the shift they start on. Nothing here
// claims to be stocking capacity — an unmapped code lands in "other" unless
// its start hour clearly puts it on a stocking shift, and even then it is
// flagged `inferred` so the UI can say so.
function inferGroupFromStart(startHour) {
  if (startHour >= 21 || startHour <= 2) return "stock3";
  if (startHour >= 13 && startHour <= 17) return "stock2";
  if (startHour >= 4  && startHour <= 8)  return "stock1";
  return "other";
}

/**
 * Classify one schedule row's job.
 * @returns {{group:string, rank:string, desc:string, area:?string, inferred:boolean}}
 */
export function classifyJob(jobCode, jobDesc, startHour) {
  const hit = JOBS[String(jobCode || "").trim()];
  if (hit) return { ...hit, desc: hit.desc || jobDesc || "", area: hit.area || null, inferred: false };
  return {
    group:    "other",
    rank:     "assoc",
    desc:     jobDesc || String(jobCode || "unknown"),
    area:     null,
    inferred: true,
    // kept separate so an unmapped overnight body is visible without being
    // silently counted as capacity
    inferredGroup: inferGroupFromStart(Number(startHour)),
  };
}

// Paid floor hours for one row: scheduled minutes less the scheduled meal.
// CV gives meal_minutes as 0 for shifts short enough not to carry one.
export function netHours(row) {
  const mins = Number(row?.shift_minutes || 0);
  const meal = Number(row?.meal_minutes  || 0);
  return Math.max(0, mins - meal) / 60;
}

/**
 * Roll a day's schedule rows up by group.
 *
 * @param {Array}  rows        schedule.scheduled_associates
 * @param {object} deps        { displayName, parseTimestamp, isCallOut } from compute.js
 * @returns {{groups:object, byJob:Array}}
 *   groups[key] = { key, label, count, hours, workingHours, calledOut,
 *                   calledOutHours, members[], jobs[] }
 *   `hours`        — everyone in the group
 *   `workingHours` — assoc rank only, call-outs removed. This is the number a
 *                    plan is written against.
 */
export function rollUpShifts(rows, deps) {
  const { displayName, parseTimestamp, isCallOut } = deps;
  const groups = {};
  const jobTotals = new Map();

  for (const key of Object.keys(GROUP_META)) {
    groups[key] = {
      key,
      label:          GROUP_META[key].label,
      order:          GROUP_META[key].order,
      count:          0,
      hours:          0,
      workingHours:   0,
      calledOut:      0,
      calledOutHours: 0,
      members:        [],
      jobs:           [],
    };
  }

  for (const row of Array.isArray(rows) ? rows : []) {
    const name  = displayName(row);
    const start = parseTimestamp(row.shift_start_ts);
    const end   = parseTimestamp(row.shift_end_ts);
    if (!name || !start || !end) continue;

    const job  = classifyJob(row.shift1_job_code, row.shift1_job_desc, start.getHours());
    const hrs  = netHours(row);
    const out  = isCallOut(row);
    const g    = groups[job.group] || groups.other;

    g.count += 1;
    g.hours += hrs;
    if (out) { g.calledOut += 1; g.calledOutHours += hrs; }
    else if (job.rank === "assoc") g.workingHours += hrs;

    g.members.push({
      name,
      start,
      end,
      hours:     hrs,
      jobCode:   row.shift1_job_code || "",
      jobDesc:   job.desc,
      rank:      job.rank,
      area:      job.area,
      inferred:  !!job.inferred,
      calledOut: out,
    });

    const jk = job.desc || row.shift1_job_code || "?";
    const jt = jobTotals.get(jk) || { job: jk, group: job.group, rank: job.rank, area: job.area, count: 0, hours: 0, starts: new Set() };
    jt.count += 1;
    jt.hours += hrs;
    jt.starts.add(start.getHours());
    jobTotals.set(jk, jt);
  }

  for (const g of Object.values(groups)) {
    g.members.sort((a, b) => a.start - b.start || a.name.localeCompare(b.name));
    g.hours        = round1(g.hours);
    g.workingHours = round1(g.workingHours);
    g.calledOutHours = round1(g.calledOutHours);
    g.jobs = [...jobTotals.values()]
      .filter((j) => j.group === g.key)
      .map((j) => ({ ...j, hours: round1(j.hours), starts: [...j.starts].sort((a, b) => a - b) }))
      .sort((a, b) => b.hours - a.hours);
  }

  return { groups, byJob: [...jobTotals.values()].map((j) => ({ ...j, hours: round1(j.hours), starts: [...j.starts] })) };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// ── Capacity verdict ──────────────────────────────────────────────────────
//
// Calibrated against 12 stocking plans store 1458 actually sent (2026-08-10 …
// 2026-09-18) joined to that day's schedule. Capacity/required ratios ran
// 1.09 → 1.71 across the window. The two plans that visibly ran out of night
// — 9-17 (D18 seasonal pushed to the morning crew) and 9-18 ("catch up on the
// 4 unworked home pallets", 3/19/67 and Halloween handed to Stock 1 with
// named associate counts) — sat at 1.10 and 1.09. Every plan above ~1.25 had
// room for mod sets, topstock rounds and reworking existing backroom pallets.
//
// So: below 1.10 the night does not cover the freight; 1.10–1.25 it covers
// freight and nothing else; above that there is room for the extras.
export const TIGHT_RATIO = 1.25;
// How many next-day job groups are worth naming as backup before the list
// stops being a plan and starts being the store roster.
export const BACKUP_LIMIT = 8;
export const SHORT_RATIO = 1.10;

/**
 * Compare tonight's stocking capacity to the freight on the floor.
 *
 * @param {object} tonight   rollUpShifts(...).groups for business date D
 * @param {object} tomorrow  rollUpShifts(...).groups for D+1 (may be null)
 * @param {number} requiredHours  freight hours from the CV case counts
 * @param {object} opts      { requiredBasis: "freight"|"trucks" }
 */
export function capacityReport(tonight, tomorrow, requiredHours, opts = {}) {
  const stock2 = tonight?.stock2 || emptyGroup("stock2");
  const stock3 = tonight?.stock3 || emptyGroup("stock3");
  const mod    = tonight?.modteam || emptyGroup("modteam");

  const capacity = round1(stock2.workingHours + stock3.workingHours);
  const required = round1(Number(requiredHours) || 0);
  const ratio    = required > 0 ? capacity / required : null;

  let verdict = "unknown";
  if (ratio !== null) {
    if (ratio < SHORT_RATIO)      verdict = "short";
    else if (ratio < TIGHT_RATIO) verdict = "tight";
    else                          verdict = "ok";
  }

  const nextStock1 = tomorrow?.stock1 || null;
  const nextDept   = tomorrow?.deptstock || null;

  // Backup pool: only offered when tonight is tight or short. These are
  // tomorrow's salesfloor stocking teams — the hours a plan can lean on when
  // freight is going to be left on the floor at 7am.
  const backup = [];
  if ((verdict === "short" || verdict === "tight") && nextDept) {
    for (const j of nextDept.jobs) {
      if (!j.count) continue;
      // Team leads run their own area for the day — they are not hours a
      // stocking plan can borrow, and listing them buried the ones that are.
      if (j.rank !== "assoc") continue;
      backup.push({
        job:    j.job,
        area:   j.area,
        count:  j.count,
        hours:  j.hours,
        starts: j.starts,
      });
    }
    backup.sort((a, b) => b.hours - a.hours);
    backup.length = Math.min(backup.length, BACKUP_LIMIT);
  }

  return {
    stock2Hours:   stock2.workingHours,
    stock2Count:   stock2.count,
    stock3Hours:   stock3.workingHours,
    stock3Count:   stock3.count,
    modHours:      mod.workingHours,
    modCount:      mod.count,
    capacity,
    required,
    requiredBasis: opts.requiredBasis || "freight",
    slack:         round1(capacity - required),
    ratio:         ratio === null ? null : Math.round(ratio * 100) / 100,
    verdict,
    calledOutHours: round1(stock2.calledOutHours + stock3.calledOutHours),
    calledOut:      stock2.calledOut + stock3.calledOut,
    nextStock1Hours: nextStock1 ? nextStock1.workingHours : null,
    nextStock1Count: nextStock1 ? nextStock1.count : null,
    backup,
  };
}

function emptyGroup(key) {
  return {
    key, label: GROUP_META[key]?.label || key, count: 0, hours: 0, workingHours: 0,
    calledOut: 0, calledOutHours: 0, members: [], jobs: [],
  };
}

// Plain-English one-liner for the capacity strip.
export function verdictLine(cap) {
  if (cap.verdict === "unknown") return "Freight hours unknown — can't size the night.";
  const s = cap.slack >= 0 ? `${cap.slack}h spare` : `${Math.abs(cap.slack)}h short`;
  const head = `Stock 2 + Overnight ${cap.capacity}h vs ${cap.required}h of freight (${s})`;
  if (cap.verdict === "short") {
    return `${head} — the night does not cover the freight on its own. Plan what Stock 1 picks up in the morning.`;
  }
  if (cap.verdict === "tight") {
    return `${head} — enough for the freight and little else. Mods, topstock and backroom catch-up will have to wait.`;
  }
  return `${head} — room for mods, topstock and backroom catch-up on top of the freight.`;
}
