// modules/vizpick/lib/tests/card_report.test.mjs
//
// Run with: node --test modules/vizpick/lib/tests/card_report.test.mjs
//
// The two printouts are not the same data in two skins, and the difference is
// the sort. Performance ranks by severity ("where is the problem"); the pick
// list runs in walk order ("what do I do next"). Getting that backwards would
// still produce a plausible-looking page — and send whoever is holding it
// back and forth across the backroom. So the orders are pinned here.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pickList, cardDepts, cardStamp, buildCardEmail,
  buildPerformanceHtml, buildPickListHtml, MAILTO_MAX,
} from "../card_report.js";

const ROW = {
  store: "1458", market: "120", vizpick: 71,
  casesSeenPct: 96, casesSeen: 480, casesExpected: 500,
  locationPct: 88,
  pickPct: 42, picksCompleted: 173, picksSuggested: 568,
  overstockPct: 91,
  depts: [
    { dept: "80", pickPct: 20, suggestedPicksCompleted: 2, suggestedPicks: 10, casesSeen: 5, casesExpected: 10 },
    { dept: "4",  pickPct: 95, suggestedPicksCompleted: 19, suggestedPicks: 20 },
    { dept: "1",  pickPct: 55, suggestedPicksCompleted: 11, suggestedPicks: 20 },
  ],
  locations: {
    gaps: [
      { locGroup: "9",  location: "009/012", picksSeen: 4, picksDone: 0, skipped: 4, win: "aaa", lastSeenAt: "8/22/2026 6:12:55 AM" },
      { locGroup: "1",  location: "001/010", picksSeen: 3, picksDone: 1, skipped: 2, win: "bbb", lastSeenAt: "8/22/2026 7:00:00 AM" },
      { locGroup: "1",  location: "001/002", picksSeen: 9, picksDone: 0, skipped: 9, win: "aaa", lastSeenAt: null },
      { locGroup: "10", location: "010/001", picksSeen: 1, picksDone: 0, skipped: 1, win: null, lastSeenAt: null },
    ],
  },
};

// ── Pick list: walk order, not severity ───────────────────────────────────

test("bin groups run in NUMERIC order, the order the bins are numbered", () => {
  // Not lexicographic: "10" must not sort between "1" and "9".
  const { groups } = pickList(ROW);
  assert.deepEqual(groups.map((g) => g.group), ["1", "9", "10"]);
});

test("locations within a bin group run in walk order, NOT worst-first", () => {
  // 001/002 has 9 picks left and 001/010 has 2. Severity order would put
  // 001/002 first here too — by luck. Location order is what is asserted, and
  // this fixture is built so the two disagree at the group level above.
  const { groups } = pickList(ROW);
  const d1 = groups.find((g) => g.group === "1");
  assert.deepEqual(d1.bins.map((b) => b.location), ["001/002", "001/010"]);
});

test("location sort is numeric-aware, so 002/009 precedes 002/010", () => {
  const r = { locations: { gaps: [
    { locGroup: "2", location: "002/010", skipped: 1 },
    { locGroup: "2", location: "002/009", skipped: 1 },
    { locGroup: "2", location: "002/100", skipped: 1 },
  ] } };
  const { groups } = pickList(r);
  assert.deepEqual(groups[0].bins.map((b) => b.location), ["002/009", "002/010", "002/100"]);
});

test("only bins with something left to pull are listed", () => {
  // A bin whose picks are done is not actionable. Printing it wastes a walk.
  const r = { locations: { gaps: [
    { locGroup: "1", location: "001/001", picksSeen: 5, picksDone: 5, skipped: 0 },
    { locGroup: "1", location: "001/002", picksSeen: 5, picksDone: 4, skipped: 1 },
  ] } };
  const { groups, totalBins, totalPicks } = pickList(r);
  assert.equal(totalBins, 1);
  assert.equal(totalPicks, 1);
  assert.deepEqual(groups[0].bins.map((b) => b.location), ["001/002"]);
});

test("totals are summed from the bins, not from a stored figure", () => {
  const { totalPicks, totalBins } = pickList(ROW);
  assert.equal(totalPicks, 4 + 2 + 9 + 1);
  assert.equal(totalBins, 4);
});

test("an unscanned bin is still on the pull list", () => {
  // Nobody scanned 010/001, so it belongs to no associate — but the picks in
  // it still need pulling. Attribution is the OTHER report's problem.
  const { groups } = pickList(ROW);
  const d10 = groups.find((g) => g.group === "10");
  assert.equal(d10.bins[0].location, "010/001");
});

test("pickList tolerates a row with no location capture", () => {
  for (const bad of [null, undefined, {}, { locations: null }, { locations: { gaps: null } }, { locations: { gaps: [null] } }]) {
    const r = pickList(bad);
    assert.deepEqual(r.groups, []);
    assert.equal(r.totalPicks, 0);
  }
});

// ── Performance: severity order ───────────────────────────────────────────

test("departments rank worst pick % FIRST", () => {
  assert.deepEqual(cardDepts(ROW).map((d) => d.dept), ["80", "1", "4"]);
});

test("a department with no pick % sorts last, not first", () => {
  // null must not read as 0% and top the "worst" list.
  const r = { depts: [{ dept: "5", pickPct: null }, { dept: "6", pickPct: 30 }] };
  assert.deepEqual(cardDepts(r).map((d) => d.dept), ["6", "5"]);
});

// ── The two pages differ in the ways that matter ──────────────────────────

test("the pick list carries no associate names", () => {
  // It goes to whoever is pulling now. Who missed them earlier is a separate
  // conversation on a separate page.
  const html = buildPickListHtml(ROW, { market: "120" }, { autoPrint: false });
  for (const win of ["aaa", "bbb"]) assert.ok(!html.includes(win), `leaked ${win}`);
  assert.ok(!/Associate/i.test(html));
});

test("the performance page marks what is below goal", () => {
  const html = buildPerformanceHtml(ROW, {}, { autoPrint: false });
  assert.match(html, /Below goal/);
  assert.match(html, /Picks 42%/);          // 42 < 90
  assert.ok(!/Cases Seen 96%<\/span>/.test(html), "96% is above its 95 goal");
});

test("a store at goal everywhere says so rather than showing an empty banner", () => {
  const good = { ...ROW, casesSeenPct: 99, locationPct: 99, pickPct: 99, overstockPct: 99 };
  assert.match(buildPerformanceHtml(good, {}, { autoPrint: false }), /at or above goal/);
});

test("a store with nothing outstanding gets a clear pick list, not an empty table", () => {
  const html = buildPickListHtml({ store: "1", locations: { gaps: [] } }, {}, { autoPrint: false });
  assert.match(html, /No outstanding picks/);
  assert.ok(!html.includes("<tbody>"));
});

test("autoPrint is opt-out, so tests never trigger a print dialog", () => {
  assert.ok(!buildPickListHtml(ROW, {}, { autoPrint: false }).includes("window.print"));
  assert.ok(buildPickListHtml(ROW, {}).includes("window.print"));
});

test("store numbers and group labels are escaped into the page", () => {
  const evil = { store: `1<script>alert(1)</script>`, locations: { gaps: [
    // Deliberately the OLD `dept` key: it exercises the back-compat path for
    // snapshots written before the rename, which a stored row can still carry.
    { dept: `<img onerror=x>`, location: `A"B`, skipped: 1 },
  ] } };
  const html = buildPickListHtml(evil, {}, { autoPrint: false });
  assert.ok(!html.includes("<script>alert"), "store number was not escaped");
  assert.ok(!html.includes("<img onerror"), "group label was not escaped");
});

// ── Provenance ────────────────────────────────────────────────────────────

test("the stamp prefers Tableau's own publish time and says so", () => {
  const s = cardStamp({ sourceUpdate: { raw: "8/22/2026 10:04 AM" }, capturedAt: "2026-08-22T18:00:00Z" });
  assert.match(s, /10:04 AM/);
  assert.match(s, /Tableau/);
});

test("with no source stamp it falls back to capture time and says THAT", () => {
  // A printed page outlives the screen. It must never be ambiguous about
  // which moment it is describing.
  const s = cardStamp({ capturedAt: "2026-08-22T18:00:00Z" });
  assert.match(s, /Captured/);
  assert.ok(!/Tableau/.test(s));
});

test("with neither, it admits it rather than printing a blank line", () => {
  assert.match(cardStamp({}), /unknown/);
  assert.match(cardStamp(), /unknown/);
});

// ── Email length ──────────────────────────────────────────────────────────

test("a normal card fits and is not marked truncated", () => {
  const { body, truncated } = buildCardEmail(ROW, { market: "120" });
  assert.equal(truncated, false);
  assert.match(body, /Store 1458/);
  assert.match(body, /Dept 80/);
});

test("an oversized card trims sections and SAYS it trimmed", () => {
  // Windows silently cuts a mailto: past ~2 KB, so the client would open with
  // a body that just stops mid-sentence. Trimming deliberately is the honest
  // version of the same limit.
  const big = { ...ROW, depts: Array.from({ length: 200 }, (_, i) => ({
    dept: String(i), pickPct: i % 100, suggestedPicksCompleted: i, suggestedPicks: i + 50,
  })) };
  const { subject, body, truncated } = buildCardEmail(big, {});
  assert.equal(truncated, true);
  assert.match(body, /left out to fit/);
  assert.ok(
    encodeURIComponent(body).length + encodeURIComponent(subject).length <= MAILTO_MAX + 200,
    "trimmed body still overruns the mailto ceiling",
  );
});

test("the header survives trimming — the rings are never dropped", () => {
  const big = { ...ROW, depts: Array.from({ length: 500 }, (_, i) => ({ dept: `d${i}`, pickPct: 1 })) };
  const { body } = buildCardEmail(big, {});
  assert.match(body, /Overall:/);
  assert.match(body, /Cases Seen:/);
});

test("email tolerates an empty row", () => {
  const { subject, body } = buildCardEmail(null, {});
  assert.match(subject, /Store \?/);
  assert.equal(typeof body, "string");
});

// ── Associate names on the printout ───────────────────────────────────────
//
// The bug this pins: cardAssociates() rolled up from the location export,
// which carries only a WIN, and the builders were called with the row and
// nothing else. `a.name` was therefore never defined and every printed sheet
// showed a column of ids. Names live in shared/associateDirectory.js and are
// resolved asynchronously by the view, so they can only reach these pure
// builders as an injected resolver.

import { cardAssociates } from "../card_report.js";

const NAMES = { aaa: "Jane Doe", bbb: "John Smith" };
const resolver = (win) => NAMES[win] ?? null;

test("without a resolver there is no name to show — only the WIN", () => {
  // Not a defect, but the reason the parameter has to exist: the row simply
  // does not contain names. Asserting it stops anyone "simplifying" the
  // resolver away on the assumption the row carries them.
  const [a] = cardAssociates(ROW);
  assert.equal(a.name, null);
  assert.equal(a.win, "aaa");
});

test("a resolver puts real names on the associates", () => {
  const list = cardAssociates(ROW, { names: resolver });
  assert.deepEqual(list.map((a) => a.name), ["Jane Doe", "John Smith"]);
});

test("the performance page prints names, not ids, when they resolve", () => {
  const html = buildPerformanceHtml(ROW, {}, { autoPrint: false, names: resolver });
  assert.match(html, /Jane Doe/);
  assert.match(html, /John Smith/);
  assert.ok(!/>aaa</.test(html), "printed the WIN even though a name resolved");
});

test("an unresolved WIN still prints as the WIN, not as blank or 'null'", () => {
  // Better an id than a confidently wrong name on a list about who is not
  // doing their picks — and far better than an empty cell.
  const html = buildPerformanceHtml(ROW, {}, { autoPrint: false, names: () => null });
  assert.match(html, />aaa</);
  assert.ok(!/>null</.test(html));
  assert.ok(!/<td><\/td>/.test(html));
});

test("a resolver returning whitespace is treated as unresolved", () => {
  const [a] = cardAssociates(ROW, { names: () => "   " });
  assert.equal(a.name, null);
});

test("a throwing or absent resolver does not take the page down", () => {
  // It runs on a user-initiated print; a directory hiccup must degrade to ids.
  assert.doesNotThrow(() => cardAssociates(ROW, { names: null }));
  assert.doesNotThrow(() => cardAssociates(ROW, { names: "not a function" }));
});

test("the email body uses resolved names too", () => {
  const { body } = buildCardEmail(ROW, {}, { names: resolver });
  assert.match(body, /Jane Doe: 13 left/);
  assert.ok(!/^\s+aaa:/m.test(body));
});

test("the old positional limit still works, so a stale caller degrades safely", () => {
  // cardAssociates(r, 10) was the original signature.
  const list = cardAssociates(ROW, 1);
  assert.equal(list.length, 1);
});

test("the pick list is unaffected — it has no names to resolve", () => {
  const html = buildPickListHtml(ROW, {}, { autoPrint: false, names: resolver });
  assert.ok(!html.includes("Jane Doe"), "a name reached the walk sheet");
  assert.ok(!html.includes("aaa"), "a WIN reached the walk sheet");
});
