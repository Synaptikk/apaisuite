// modules/vizpick/lib/tests/parse_vizpick_stores_csv.test.mjs
//
// Pure-function tests for the VizPick crosstab parsers. Every fixture below
// is a verbatim excerpt of a real Tableau export captured on 2026-08-16 by
// dev/probe-vizpick-source.mjs and dev/probe-vizpick-details-scope.mjs, so
// these tests pin the parsers to the actual source layout rather than to an
// invented one.
//
// Run with: node --test modules/vizpick/lib/tests/parse_vizpick_stores_csv.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseVizpickStoresCsv,
  parseGrandTotal,
  parseLastUpdate,
  parseDeptBreakout,
  parseDonutHealth,
} from "../parse_vizpick_stores_csv.js";
import { BANDS, bandFor } from "../charts.js";

// ── Fixtures (real rows, tab-separated) ───────────────────────────────────
const STORES_HEADERS = [
  "Store", "BU", "Region", "Market", "VizPick", "Cases Seen %", "Location %",
  "Total Picked", "Overstock %", "Pick %", "Cases Seen", "Cases Expected",
  "pallets_seen", "pallets_expected", "clearance_picked_tags",
  "deleted_picked_tags", "Pallets %",
].join("\t");

const STORES_CSV = [
  STORES_HEADERS,
  ["Grand Total","Total","Total","Total","96.70","95%","97%","3,401,771","90%","80%","31,725,132","33,369,757","269,086","324,404","56,226","91,719","82.95%"].join("\t"),
  ["1","A","42","323","98.14","95%","98%","1,740","95%","84%","10,658","11,164","282","294","18","21","95.92%"].join("\t"),
  ["2","A","42","322","96.52","95%","97%","1,133","91%","80%","9,613","10,119","53","59","11","20","89.83%"].join("\t"),
].join("\r\n");

// ── parseVizpickStoresCsv ─────────────────────────────────────────────────
test("parses per-store rows and skips the Grand Total row", () => {
  const r = parseVizpickStoresCsv(STORES_CSV);
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.rows.map((x) => x.store), ["1", "2"]);
});

test("captures the raw numerator/denominator columns", () => {
  const { rows } = parseVizpickStoresCsv(STORES_CSV);
  const s1 = rows[0];
  assert.equal(s1.casesSeen, 10658);
  assert.equal(s1.casesExpected, 11164);
  assert.equal(s1.palletsSeen, 282);
  assert.equal(s1.palletsExpected, 294);
  assert.equal(s1.palletsPct, 95.92);
  assert.equal(s1.totalPicked, 1740);
});

test("the raw columns actually reproduce the rounded percentages", () => {
  // This is the property that lets the UI show a real "x / y" instead of a
  // derived guess. If Tableau ever changes these column meanings, this fails.
  const { rows } = parseVizpickStoresCsv(STORES_CSV);
  for (const r of rows) {
    const casesPct = (r.casesSeen / r.casesExpected) * 100;
    assert.equal(Math.round(casesPct), Math.round(r.casesSeenPct),
      `store ${r.store}: ${r.casesSeen}/${r.casesExpected} = ${casesPct.toFixed(2)}% but Cases Seen % = ${r.casesSeenPct}`);

    const palletsPct = (r.palletsSeen / r.palletsExpected) * 100;
    assert.ok(Math.abs(palletsPct - r.palletsPct) < 0.01,
      `store ${r.store}: pallets ${palletsPct.toFixed(2)} vs ${r.palletsPct}`);
  }
});

test("market filter narrows to one market", () => {
  const r = parseVizpickStoresCsv(STORES_CSV, { market: "322" });
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].store, "2");
});

test("rejects a wrong sheet instead of returning junk rows", () => {
  const wrong = "Dept\tSuggested Picks\nTotal\t739";
  const r = parseVizpickStoresCsv(wrong);
  assert.equal(r.ok, false);
  assert.match(r.reason, /unexpected columns/);
});

test("empty / non-string input is rejected", () => {
  assert.equal(parseVizpickStoresCsv("").ok, false);
  assert.equal(parseVizpickStoresCsv(null).ok, false);
  assert.equal(parseVizpickStoresCsv(STORES_HEADERS).ok, false); // header only
});

// ── parseGrandTotal ───────────────────────────────────────────────────────
test("extracts the Grand Total rollup with its raw columns", () => {
  const g = parseGrandTotal(STORES_CSV);
  assert.equal(g.ok, true);
  assert.equal(g.national.casesSeen, 31725132);
  assert.equal(g.national.casesExpected, 33369757);
  assert.equal(g.national.vizpick, 96.7);
  assert.equal(Math.round((g.national.casesSeen / g.national.casesExpected) * 100), 95);
});

test("Grand Total absent → ok:false, not a thrown error", () => {
  const noTotal = [STORES_HEADERS, ["1","A","42","323","98.14","95%","98%","1,740","95%","84%","10,658","11,164","282","294","18","21","95.92%"].join("\t")].join("\n");
  assert.equal(parseGrandTotal(noTotal).ok, false);
});

// ── parseLastUpdate ───────────────────────────────────────────────────────
test("parses the VizPickDetails full timestamp", () => {
  const r = parseLastUpdate("2026-08-16 10:26:07\t\n");
  assert.equal(r.ok, true);
  assert.equal(r.hasTime, true);
  assert.equal(r.raw, "2026-08-16 10:26:07");
  const d = new Date(r.iso);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 7); // August
  assert.equal(d.getDate(), 16);
  assert.equal(d.getHours(), 10);
  assert.equal(d.getMinutes(), 26);
});

test("parses the VizPick date-only stamp and flags it as timeless", () => {
  const r = parseLastUpdate("8/16/2026\t\n");
  assert.equal(r.ok, true);
  assert.equal(r.hasTime, false);
  assert.equal(r.raw, "8/16/2026");
  assert.equal(new Date(r.iso).getDate(), 16);
});

test("parses US datetime with AM/PM", () => {
  const r = parseLastUpdate("8/16/2026 9:43:02 AM");
  assert.equal(r.ok, true);
  assert.equal(r.hasTime, true);
  assert.equal(new Date(r.iso).getHours(), 9);

  const pm = parseLastUpdate("8/16/2026 1:05:00 PM");
  assert.equal(new Date(pm.iso).getHours(), 13);

  const noon = parseLastUpdate("8/16/2026 12:30:00 PM");
  assert.equal(new Date(noon.iso).getHours(), 12);

  const midnight = parseLastUpdate("8/16/2026 12:30:00 AM");
  assert.equal(new Date(midnight.iso).getHours(), 0);
});

test("garbage input never throws and never invents a date", () => {
  for (const bad of ["", null, undefined, "\t\t\n", "not a date", "99/99/9999x"]) {
    const r = parseLastUpdate(bad);
    assert.equal(r.ok, false, `expected failure for ${JSON.stringify(bad)}`);
  }
});

// ── parseDeptBreakout ─────────────────────────────────────────────────────
const DEPT_CSV = [
  ["Dept","Suggested Picks","Suggested Picks Completed","Pick %","Total Picked","Cases Seen","Cases Expected","Cases Seen %","Overstock Exceptions","Clearance Cases","Modular Deleted Cases"].join("\t"),
  ["Total","739","343","46%","452","5,953","10,816","55%","39","76","124"].join("\t"),
  ["1","7","0","0%","0","62","68","91%","","0","0"].join("\t"),
  ["2","12","5","42%","9","104","150","69%","3","1","2"].join("\t"),
].join("\r\n");

test("extracts the current-day store rollup from the Total row", () => {
  const r = parseDeptBreakout(DEPT_CSV);
  assert.equal(r.ok, true);
  assert.equal(r.deptCount, 2);
  assert.equal(r.total.suggestedPicks, 739);
  assert.equal(r.total.suggestedPicksCompleted, 343);
  assert.equal(r.total.totalPicked, 452);
  assert.equal(r.total.casesSeen, 5953);
  assert.equal(r.total.casesExpected, 10816);
});

test("Pick % really is Completed / Suggested — NOT Total Picked / Pick %", () => {
  // The whole reason the UI does not derive a Pick denominator. Guarding it
  // as a test so nobody "optimises" the derivation back in.
  const { total } = parseDeptBreakout(DEPT_CSV);
  const realPct = (total.suggestedPicksCompleted / total.suggestedPicks) * 100;
  assert.equal(Math.round(realPct), total.pickPct); // 343/739 = 46.4% → 46%

  const naiveDenominator = total.totalPicked / (total.pickPct / 100); // 452/0.46
  assert.ok(Math.abs(naiveDenominator - total.suggestedPicks) > 200,
    "the naive derivation should be badly wrong — that is why it is not used");
});

test("Cases Seen % really is Cases Seen / Cases Expected", () => {
  const { total } = parseDeptBreakout(DEPT_CSV);
  assert.equal(Math.round((total.casesSeen / total.casesExpected) * 100), total.casesSeenPct);
});

test("department breakout with no Total row is rejected", () => {
  const noTotal = DEPT_CSV.split("\r\n").filter((l) => !l.startsWith("Total")).join("\r\n");
  const r = parseDeptBreakout(noTotal);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no Total row/);
});

test("wrong sheet handed to parseDeptBreakout is rejected", () => {
  assert.equal(parseDeptBreakout(STORES_CSV).ok, false);
  assert.equal(parseDeptBreakout("").ok, false);
});

// ── numeric coercion ──────────────────────────────────────────────────────
test("blank and malformed numeric cells coerce to 0 rather than NaN", () => {
  const csv = [
    STORES_HEADERS,
    ["7","A","42","323","","","","","","","","","","","","",""].join("\t"),
  ].join("\n");
  const { rows } = parseVizpickStoresCsv(csv);
  for (const [k, v] of Object.entries(rows[0])) {
    if (typeof v === "number") assert.ok(Number.isFinite(v), `${k} became ${v}`);
  }
});

// ── parseDonutHealth ──────────────────────────────────────────────────────
// Real shape from VizPickDetails "VizPick Donut Health" (2026-08-16). The
// first row is a spacer: its percentage cells are blank and only the
// composite/remaining columns are filled.
const DONUT_CSV = [
  ["Cases Seen %","New Location %","New Overstock %","New Pick %","New VizPick","New VizPick Remaining"].join("\t"),
  ["","","","","73","26.522104830"].join("\t"),
  ["59%","73%","87%","66%","73",""].join("\t"),
].join("\r\n");

test("donut health: skips the spacer row and reads the populated one", () => {
  const r = parseDonutHealth(DONUT_CSV);
  assert.equal(r.ok, true);
  assert.equal(r.health.casesSeenPct, 59);
  assert.equal(r.health.locationPct, 73);
  assert.equal(r.health.overstockPct, 87);
  assert.equal(r.health.pickPct, 66);
  assert.equal(r.health.vizpick, 73);
});

test("donut health: wrong sheet / empty input rejected, never thrown", () => {
  assert.equal(parseDonutHealth(STORES_CSV).ok, false);
  assert.equal(parseDonutHealth(DEPT_CSV).ok, false);
  assert.equal(parseDonutHealth("").ok, false);
  assert.equal(parseDonutHealth(null).ok, false);
});

test("donut health: header-only or all-spacer input is rejected", () => {
  const headerOnly = DONUT_CSV.split("\r\n")[0];
  assert.equal(parseDonutHealth(headerOnly).ok, false);
  const allSpacer = [DONUT_CSV.split("\r\n")[0], ["","","","","73","26.5"].join("\t")].join("\r\n");
  const r = parseDonutHealth(allSpacer);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no populated/);
});

// ── bandFor: goal-relative colour scale ───────────────────────────────────
test("bandFor: blue at/above goal, orange within 5, RED for a clear miss", () => {
  const cls = (v, g) => bandFor(v, g)?.cls ?? null;
  // Cases / Locations goal 95
  assert.equal(cls(96, 95), "vizpick-met");
  assert.equal(cls(95, 95), "vizpick-met");      // exactly at goal counts as met
  assert.equal(cls(94, 95), "vizpick-near");
  assert.equal(cls(91, 95), "vizpick-near");
  assert.equal(cls(90, 95), "vizpick-missed");   // 5 under -> clear miss
  assert.equal(cls(78, 95), "vizpick-missed");
  // Picks / Overstock goal 90
  assert.equal(cls(91, 90), "vizpick-met");
  assert.equal(cls(86, 90), "vizpick-near");
  assert.equal(cls(85, 90), "vizpick-missed");
  assert.equal(cls(56, 90), "vizpick-missed");
});

test("bandFor: a clear miss is NOT the same colour as an un-judged value", () => {
  // The whole point of moving misses to red: black is the default ink of a
  // metric with no goal, so a 56% Pick used to vanish into the card next to a
  // plain count. These must never resolve to the same colour.
  const miss = bandFor(56, 90);
  const noGoal = bandFor(858, null);
  assert.equal(miss.cls, "vizpick-missed");
  assert.notEqual(miss.color, "#1a1a1a");
  assert.notEqual(miss.color, noGoal.color);
});

test("bandFor: current-day figures are graded exactly like closed ones", () => {
  // Live data was briefly shown black-and-unjudged on the grounds that a
  // mid-day number is incomplete. That made the live tab unreadable — a wall
  // of black says nothing, and the point of the rollup is to see who needs
  // help NOW. A store at 65% against a 90% goal is behind whether or not the
  // day is over. There is no longer a live/closed distinction at all, so the
  // two tabs cannot drift apart again.
  assert.equal(bandFor.length, 2, "bandFor should take only (value, goal)");
  const cls = (v, g) => bandFor(v, g)?.cls ?? null;
  assert.equal(cls(96, 95), "vizpick-met");
  assert.equal(cls(94, 95), "vizpick-near");     // was pending/black
  assert.equal(cls(56, 90), "vizpick-missed");   // was pending/black
  // Assert identity, not the literal colour: the palette moved into CSS custom
  // properties so the gauges could follow the theme, and pinning a hex here
  // would fail on every future palette change while testing nothing about the
  // banding logic this test is actually for.
  assert.equal(bandFor(56, 90).color, BANDS.missed.color);
  assert.notEqual(BANDS.missed.color, BANDS.met.color, "bands must stay visually distinct");
});

test("Total Picked carries no derived denominator", () => {
  // Store 5151 (2026-08-16): Total Picked 611, Pick % 392/603 = 65%.
  // Total Picked is NOT the Pick % numerator, so 611 / 0.65 = 940 is a
  // "total" that describes nothing — yet it was rendered as "611 / ≈940".
  // The real ratio is published on the Pick % row and needs no derivation.
  const picked = 611, pickPct = 65, realNumerator = 392, realDenominator = 603;
  assert.notEqual(picked, realNumerator, "Total Picked is a different measure");
  const bogus = Math.round(picked / (pickPct / 100) / 10) * 10;
  assert.equal(bogus, 940);
  assert.ok(
    (bogus - realDenominator) / realDenominator > 0.5,
    `deriving from Total Picked overstates the true denominator ${realDenominator} by ${bogus - realDenominator}`
  );
});

test("bandFor: a metric with no goal is never judged", () => {
  assert.equal(bandFor(74, null)?.cls, "vizpick-neutral");
  assert.equal(bandFor(74, undefined)?.cls, "vizpick-neutral");
  assert.equal(bandFor(12, NaN)?.cls, "vizpick-neutral");
});

test("bandFor: no value at all has no band, so callers can show 'no data'", () => {
  assert.equal(bandFor(NaN, 95), null);
  assert.equal(bandFor(undefined, 95), null);
  assert.equal(bandFor(null, 95), null);
});

test("bandFor: bands the ROUNDED value so colour matches the digits shown", () => {
  const cls = (v, g) => bandFor(v, g)?.cls ?? null;
  assert.equal(cls(94.6, 95), "vizpick-met");     // prints "95"
  assert.equal(cls(94.4, 95), "vizpick-near");    // prints "94"
  assert.equal(cls(90.4, 95), "vizpick-missed");  // prints "90" -> 5 under
});

// ── The VizPick composite, and why its goal is 100 ───────────────────────
//
// view.js judges the centre ring against GOALS.vizpick = 100. That is a
// derivation, not a guess, and this pins it: the composite is the mean
// ATTAINMENT of each component against its own published goal, capped at
// 100%. It follows that a store at or above all four goals scores exactly
// 100, which is what makes 100 the right threshold.
//
// Established 2026-08-16 over the full stored roster (4,598 stores): median
// error 0.28pp, p95 1.74pp. The residual is the components being published
// rounded to whole percents while Tableau computes from unrounded values,
// which is why the tolerance below is 1.5pp rather than exact.
const COMPOSITE_GOALS = { cases: 95, location: 95, pick: 90, overstock: 90 };
const composite = (r) => {
  const att = (v, g) => Math.min(100, (v / g) * 100);
  return (att(r.cases, COMPOSITE_GOALS.cases) + att(r.location, COMPOSITE_GOALS.location)
        + att(r.pick, COMPOSITE_GOALS.pick) + att(r.overstock, COMPOSITE_GOALS.overstock)) / 4;
};

test("VizPick composite is mean attainment vs each goal, capped at 100", () => {
  // Real rows from the 2026-08-16 summary capture, observed composite included.
  const observed = [
    { store: 1, cases: 95, location: 98, pick: 84, overstock: 95, vizpick: 98.14 },
    { store: 2, cases: 95, location: 97, pick: 80, overstock: 91, vizpick: 96.52 },
    { store: 3, cases: 97, location: 99, pick: 86, overstock: 92, vizpick: 98.72 },
    { store: 4, cases: 95, location: 97, pick: 83, overstock: 95, vizpick: 97.70 },
    { store: 5, cases: 97, location: 100, pick: 69, overstock: 93, vizpick: 92.85 },
    { store: 7, cases: 95, location: 97, pick: 80, overstock: 87, vizpick: 95.93 },
  ];
  for (const r of observed) {
    assert.ok(
      Math.abs(composite(r) - r.vizpick) <= 1.5,
      `store ${r.store}: predicted ${composite(r).toFixed(2)} vs observed ${r.vizpick}`
    );
  }
});

test("VizPick composite: no plain average of the components can produce it", () => {
  // The finding that ruled out the obvious model. Store 1 scores 98.14 while
  // its best component is 98, so the composite exceeds max(components) — no
  // mean, weighted or not, can do that.
  const r = { cases: 95, location: 98, pick: 84, overstock: 95, vizpick: 98.14 };
  assert.ok(r.vizpick > Math.max(r.cases, r.location, r.pick, r.overstock));
});

test("VizPick composite: hitting every goal scores exactly 100", () => {
  // This is the whole justification for GOALS.vizpick = 100.
  assert.equal(composite({ cases: 95, location: 95, pick: 90, overstock: 90 }), 100);
  // And exceeding them cannot push it past 100 — the caps bind.
  assert.equal(composite({ cases: 100, location: 100, pick: 100, overstock: 100 }), 100);
  // One metric short of goal drags it below, so the ring stops being blue.
  assert.ok(composite({ cases: 95, location: 95, pick: 72, overstock: 90 }) < 100);
});
