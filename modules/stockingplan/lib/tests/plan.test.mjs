// node --test modules/stockingplan/lib/tests/
//
// Fixtures are shaped exactly like live CaseVisibility payloads (job codes,
// timestamp format, H:MM durations) but every name is invented — this repo is
// public and the real payload is a store roster.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyJob, rollUpShifts, capacityReport, netHours,
  TIGHT_RATIO, SHORT_RATIO,
} from "../shifts.js";
import {
  buildPlan, pairAisles, minsToHours, nextIsoDate,
  displayName, parseTimestamp, isCallOut, buildTrucks,
} from "../compute.js";
import { flattenRows, toPlaintext } from "../render.js";

const deps = { displayName, parseTimestamp, isCallOut };

function assoc(name, code, desc, start, end, mins, meal = 60) {
  return {
    preferred_name: name,
    shift_start_ts: start,
    shift_end_ts:   end,
    shift_minutes:  mins,
    meal_minutes:   meal,
    shift1_job_code: code,
    shift1_job_desc: desc,
  };
}

// One night's stocking crew: 2 on Stock 2, 3 overnight, 1 mod, 1 lead.
const TONIGHT = [
  assoc("Ada Pike",   "1-695-7540", "Stocking 2 TA",  "2026-09-18 14:00", "2026-09-18 23:00", 540),
  assoc("Ben Orr",    "1-695-7540", "Stocking 2 TA",  "2026-09-18 14:00", "2026-09-18 23:00", 540),
  assoc("Cal Reed",   "1-635-7440", "Stocking ON TA", "2026-09-18 22:00", "2026-09-19 07:00", 540),
  assoc("Dee Nunn",   "1-635-7440", "Stocking ON TA", "2026-09-18 22:00", "2026-09-19 07:00", 540),
  assoc("Eli Vance",  "1-635-7440", "Stocking ON TA", "2026-09-18 22:00", "2026-09-19 05:00", 420, 0),
  assoc("Fay Lowe",   "1-635-7240", "Stocking ON TL", "2026-09-18 21:00", "2026-09-19 06:00", 540),
  assoc("Gus Hale",   "1-635-7441", "Modular ON TA",  "2026-09-18 22:00", "2026-09-19 07:00", 540),
  assoc("Hal Crane",  "1-995-710",  "Maint Assoc ON", "2026-09-18 22:00", "2026-09-19 07:00", 540),
  assoc("Ivy Sloan",  "1-936-1451", "Digital Personal Shopper", "2026-09-18 05:00", "2026-09-18 14:00", 540),
];

const TOMORROW = [
  assoc("Jo Park",    "1-695-7550", "Stocking 1 TA",  "2026-09-19 06:00", "2026-09-19 15:00", 540),
  assoc("Kit Bram",   "1-695-7550", "Stocking 1 TA",  "2026-09-19 06:00", "2026-09-19 15:00", 540),
  assoc("Lou Tate",   "1-640-7412", "Seasonal TA",    "2026-09-19 09:00", "2026-09-19 18:00", 540),
  assoc("Moe Pryor",  "1-640-7411", "Hardlines TA",   "2026-09-19 07:00", "2026-09-19 16:00", 540),
  assoc("Nia Fox",    "1-615-7400", "Food & Consumables TA", "2026-09-19 07:00", "2026-09-19 15:00", 480),
];

// Shaped like the casesByDept / summaryTableByArea / casesByAisle scrape.
const FREIGHT = {
  areas: [
    { area_name: "General Merchandise", is_fc: false, case_qty: 1085, bp_qty: 482 },
    { area_name: "Food (Non-FDD)",      is_fc: true,  case_qty: 2389, bp_qty: 28 },
  ],
  areaTimes: [
    { area_name: "General Merchandise", case_qty: 1085, case_min: 1517, bp_qty: 482,  bp_min: 727, total_min: 2244 },
    { area_name: "Food (Non-FDD)",      case_qty: 2389, case_min: 3055, bp_qty: 28,   bp_min: 40,  total_min: 3095 },
  ],
  depts: [
    { area_name: "General Merchandise", is_fc: false, dept_nbr: 9,  dept_name: "Sporting Goods", case_qty: 122, case_min: 183, bp_qty: 32, bp_min: 48, total_min: 230 },
    { area_name: "General Merchandise", is_fc: false, dept_nbr: 10, dept_name: "Automotive",     case_qty: 176, case_min: 207, bp_qty: 25, bp_min: 29, total_min: 236 },
    { area_name: "Food (Non-FDD)",      is_fc: true,  dept_nbr: 92, dept_name: "Dry Grocery",    case_qty: 1329, case_min: 1696, bp_qty: 16, bp_min: 20, total_min: 1717 },
  ],
  aisles: [
    { aisle_nbr: 8,  aisle_label: "A8",  case_qty: 141, total_min: 179, bp_qty: 0, dept_nbr: 92, by_trailer: [{ trailer: "RDC 153857", case_qty: 88, min: 112 }] },
    { aisle_nbr: 9,  aisle_label: "A9",  case_qty: 284, total_min: 362, bp_qty: 0, dept_nbr: 92, by_trailer: [{ trailer: "RDC 153857", case_qty: 86, min: 109 }] },
    { aisle_nbr: 25, aisle_label: "A25", case_qty: 102, total_min: 130, bp_qty: 0, dept_nbr: 92, by_trailer: [] },
    { aisle_nbr: null, aisle_label: "Unknown", unknown: true, case_qty: 35, total_min: 44, bp_qty: 0, dept_nbr: 92, by_trailer: [] },
  ],
  trailers: ["RDC 153857", "HVDC 209858"],
};

const SCHEDULE = {
  schedule: { store_nbr: 1458, business_date: "2026-09-18", scheduled_associates: TONIGHT },
  sdl: [
    { shipment_type: "RDC", trailer_id: 6006, load_id: 153857, est_delivery_ts: "2026-09-18 17:19",
      groc_cases: 2623, gm_cases: 637, breakpack_boxes: 14, total_cases: 3274 },
    { shipment_type: "HVDC", trailer_id: 6095, load_id: 209858, sched_delivery_ts: "2026-09-18 09:43",
      actual_delivery_ts: "2026-09-18 09:51", groc_cases: 582, gm_cases: 0, breakpack_boxes: 0, total_cases: 582 },
  ],
};

const NEXT_SCHEDULE = {
  schedule: { store_nbr: 1458, business_date: "2026-09-19", scheduled_associates: TOMORROW },
};

// ── job classification ──────────────────────────────────────────────

test("known stocking codes land in their own group", () => {
  assert.equal(classifyJob("1-695-7550", "", 6).group,  "stock1");
  assert.equal(classifyJob("1-695-7540", "", 14).group, "stock2");
  assert.equal(classifyJob("1-635-7440", "", 22).group, "stock3");
  assert.equal(classifyJob("1-635-7441", "", 22).group, "modteam");
  assert.equal(classifyJob("1-995-710",  "", 22).group, "maintenance");
  assert.equal(classifyJob("1-640-7412", "", 9).group,  "deptstock");
});

test("leads and coaches are tagged but are not assoc rank", () => {
  assert.equal(classifyJob("1-635-7240", "", 21).rank, "lead");
  assert.equal(classifyJob("1-0-40407",  "", 20).rank, "coach");
  assert.equal(classifyJob("1-635-7440", "", 22).rank, "assoc");
});

test("an unmapped code goes to other, flagged, with the shift it looks like", () => {
  const c = classifyJob("9-99-999", "Some New TA", 22);
  assert.equal(c.group, "other");
  assert.equal(c.inferred, true);
  assert.equal(c.inferredGroup, "stock3");
});

test("netHours subtracts the scheduled meal", () => {
  assert.equal(netHours({ shift_minutes: 540, meal_minutes: 60 }), 8);
  assert.equal(netHours({ shift_minutes: 420, meal_minutes: 0 }),  7);
});

// ── roll-up ─────────────────────────────────────────────────────────

test("roll-up counts bodies per group and keeps leads out of working hours", () => {
  const { groups } = rollUpShifts(TONIGHT, deps);
  assert.equal(groups.stock2.count, 2);
  assert.equal(groups.stock2.workingHours, 16);            // 2 × 8h
  assert.equal(groups.stock3.count, 4);                    // 3 TA + 1 TL
  assert.equal(groups.stock3.workingHours, 23);            // 8 + 8 + 7, lead excluded
  assert.equal(groups.modteam.workingHours, 8);
  assert.equal(groups.maintenance.workingHours, 8);
  assert.equal(groups.other.count, 1);                     // the personal shopper
});

test("a call-out's hours leave working hours and land in calledOutHours", () => {
  const rows = TONIGHT.map((r, i) => (i === 2 ? { ...r, call_off: "Y" } : r));
  const { groups } = rollUpShifts(rows, deps);
  assert.equal(groups.stock3.calledOut, 1);
  assert.equal(groups.stock3.calledOutHours, 8);
  assert.equal(groups.stock3.workingHours, 15);
});

// ── capacity ────────────────────────────────────────────────────────

test("capacity verdicts follow the ratios the real plans calibrated", () => {
  const { groups } = rollUpShifts(TONIGHT, deps);
  const cap = (required) => capacityReport(groups, null, required).verdict;
  const capHours = 16 + 23;                                 // 39h of stocking
  assert.equal(cap(capHours / (SHORT_RATIO - 0.01)), "short");
  assert.equal(cap(capHours / ((SHORT_RATIO + TIGHT_RATIO) / 2)), "tight");
  assert.equal(cap(capHours / (TIGHT_RATIO + 0.2)), "ok");
  assert.equal(cap(0), "unknown");
});

test("the next-day backup pool only appears when tonight can't absorb the freight", () => {
  const tonight  = rollUpShifts(TONIGHT, deps).groups;
  const tomorrow = rollUpShifts(TOMORROW, deps).groups;

  const comfy = capacityReport(tonight, tomorrow, 10);
  assert.equal(comfy.verdict, "ok");
  assert.deepEqual(comfy.backup, []);

  const tight = capacityReport(tonight, tomorrow, 38);
  assert.equal(tight.verdict, "short");
  assert.ok(tight.backup.length >= 3);
  assert.ok(tight.backup.some((b) => b.job === "Seasonal TA"));
  // Stock 1 is reported separately — it is not part of the salesfloor pool.
  assert.ok(!tight.backup.some((b) => /Stocking 1/.test(b.job)));
  assert.equal(tight.nextStock1Hours, 16);
  assert.equal(tight.nextStock1Count, 2);
});

// ── freight shaping ─────────────────────────────────────────────────

test("H:MM minutes convert to the hours a plan is written in", () => {
  assert.equal(minsToHours(2244), 37.4);
  assert.equal(minsToHours(750), 12.5);
  assert.equal(minsToHours(0), 0);
});

test("consecutive aisles pair up and specials stay singletons", () => {
  const pairs = pairAisles(FREIGHT.aisles);
  const labels = pairs.map((p) => p.label);
  assert.deepEqual(labels, ["8/9", "25", "Unknown"]);
  const a89 = pairs[0];
  assert.equal(a89.totalCases, 425);
  assert.equal(a89.hours, minsToHours(179 + 362));
  assert.equal(a89.byTrailer[0].case_qty, 174);            // both sides merged
  assert.equal(pairs[2].unknown, true);
});

test("buildTrucks sorts by ETA and marks the ones already here", () => {
  const trucks = buildTrucks(SCHEDULE);
  assert.equal(trucks.length, 2);
  assert.equal(trucks[0].type, "HVDC");                     // 09:51 before 17:19
  assert.equal(trucks[0].arrived, true);
  assert.equal(trucks[1].arrived, false);
  assert.equal(trucks[1].loadId, "153857");
});

// ── whole plan ──────────────────────────────────────────────────────

test("buildPlan sizes the night against CaseVisibility's own hours", () => {
  const plan = buildPlan(SCHEDULE, FREIGHT, {
    storeNbr: "1458", businessDate: "2026-09-18", nextScheduleJson: NEXT_SCHEDULE,
  });

  assert.equal(plan.nextDate, "2026-09-19");
  assert.equal(plan.requiredBasis, "cv");
  // Area totals only — departments and aisles are breakdowns of the same freight.
  assert.equal(plan.requiredHours, minsToHours(2244 + 3095));

  assert.equal(plan.capacity.stock2Hours, 16);
  assert.equal(plan.capacity.stock3Hours, 23);
  assert.equal(plan.capacity.capacity, 39);
  assert.equal(plan.capacity.nextStock1Hours, 16);
  assert.equal(plan.capacity.verdict, "short");             // 39h against 89h

  // The autocomplete list is the stocking shifts, not the whole store.
  assert.equal(plan.associates.length, 8);
  assert.ok(!plan.associates.some((a) => a.jobDesc === "Digital Personal Shopper"));
  assert.equal(plan.associates.find((a) => a.name === "Ada Pike").role, "stock2");

  // Areas carry their departments; GM defaults to Stock 2, food to overnight.
  const gm = plan.areaSections.find((a) => a.name === "General Merchandise");
  assert.equal(gm.defaultShift, "stock2");
  assert.equal(gm.depts.length, 2);
  assert.equal(plan.areaSections.find((a) => a.name === "Food (Non-FDD)").defaultShift, "stock3");
  assert.equal(plan.aisleSections[0].pairs.length, 3);
});

test("buildPlan still renders when the child windows never opened", () => {
  const plan = buildPlan(SCHEDULE, { areas: [], depts: [], areaTimes: [], aisles: [] }, {
    storeNbr: "1458", businessDate: "2026-09-18",
  });
  assert.equal(plan.freightCaptured, false);
  assert.equal(plan.requiredBasis, "none");
  assert.equal(plan.capacity.verdict, "unknown");
  assert.equal(plan.capacity.stock3Hours, 23);              // labour still works
  assert.equal(plan.nextShifts, null);
});

test("dept rows replace their area row once they are planned, so hours aren't double-counted", () => {
  const plan = buildPlan(SCHEDULE, FREIGHT, {
    storeNbr: "1458", businessDate: "2026-09-18", nextScheduleJson: NEXT_SCHEDULE,
  });

  // Nothing touched: every area shows once, at area level.
  const bare = flattenRows(plan, new Map());
  assert.deepEqual(bare.map((r) => r.label), ["General Merchandise", "Food (Non-FDD)"]);

  // Plan one GM department: GM switches to dept level, Food stays an area.
  const a = new Map([["dept:D9", { shift: "stock2", names: ["Ada Pike"] }]]);
  const rows = flattenRows(plan, a);
  assert.deepEqual(rows.map((r) => r.label), ["D9 (Sporting Goods)", "Food (Non-FDD)"]);
  assert.equal(rows[0].names[0], "Ada Pike");
});

test("the emailed plan keeps the shift blocks the store writes in", () => {
  const plan = buildPlan(SCHEDULE, FREIGHT, {
    storeNbr: "1458", businessDate: "2026-09-18", nextScheduleJson: NEXT_SCHEDULE,
  });
  const a = new Map([
    ["area:General Merchandise", { shift: "stock2", names: ["Ada Pike", "Ben Orr"] }],
    ["area:Food (Non-FDD)",      { shift: "stock3", names: ["Cal Reed"] }],
  ]);
  const text = toPlaintext(plan, a);

  assert.match(text, /^Stocking Plan — Store 1458/m);
  assert.match(text, /^STOCK 2 \(2 scheduled, 16h\)$/m);
  assert.match(text, /^  Unload\/downstack trucks$/m);
  assert.match(text, /^OVERNIGHT \(4 scheduled, 23h\)$/m);
  assert.match(text, /^STOCK 1 — .* \(2 scheduled, 16h\)$/m);
  assert.match(text, /BACKUP — .* salesfloor teams/);
  assert.match(text, /Ada Pike, Ben Orr/);
  assert.match(text, /MOD TEAM \(1 scheduled, 8h\)/);
});

test("nextIsoDate rolls month ends", () => {
  assert.equal(nextIsoDate("2026-09-30"), "2026-10-01");
  assert.equal(nextIsoDate("2026-12-31"), "2027-01-01");
  assert.equal(nextIsoDate(""), "");
});
