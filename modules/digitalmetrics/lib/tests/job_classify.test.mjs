// modules/digitalmetrics/lib/tests/job_classify.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classificationForJob, deriveClassifications, isValidClassification, MANUAL_ONLY,
  leadershipForJob, byLeadershipFirst, isDigitalJob,
} from "../data/job_classify.js";

// Real job titles from the store 1458 roster, 2026-08-25.
const DIGITAL   = "Digital Personal Shopper 1-936-1451";
const FASHION_J = "Fashion TL 1-625-7200";
const STOCKING  = "Stocking ON TA 1-635-7440";
const AUTO      = "Auto Care Ctr Serv Tech 6-37-823";
// In Home Delivery, and the raw code the scheduler stores when its title map
// fails to resolve that job. Both are digital work.
const IHD       = "In Home Delivery";
const IHD_CODE  = "1-930-1481";

test("a digital job title means Digital", () => {
  assert.equal(classificationForJob(DIGITAL), "Digital");
  assert.equal(classificationForJob("DIGITAL PERSONAL SHOPPER"), "Digital");
});

test("In Home Delivery is Digital, not Store Help", () => {
  assert.equal(classificationForJob(IHD), "Digital");
  assert.equal(classificationForJob("IN HOME DELIVERY"), "Digital");
  assert.equal(classificationForJob("In-Home Delivery"), "Digital");
});

test("an unresolved In Home Delivery job code is still Digital", () => {
  // The scheduler stores the raw code whenever its title map misses the entry,
  // and that map comes back incomplete on some pulls. Without this, the same
  // person flips between Digital and Store Help depending on the pull.
  assert.equal(classificationForJob(IHD_CODE), "Digital");
  assert.ok(isDigitalJob(IHD_CODE));
});

test("an unresolved NON-digital job code stays Store Help", () => {
  // 1-990-7410 is Front End Checkout — 15 people carried it unresolved on
  // 2026-09-15. Only verified digital codes may promote.
  assert.equal(classificationForJob("1-990-7410"), "Store Help");
  assert.equal(classificationForJob("1-695-7550"), "Store Help");
});

test("every other job title means Store Help", () => {
  for (const j of [FASHION_J, STOCKING, AUTO, "Cashier"]) {
    assert.equal(classificationForJob(j), "Store Help", j);
  }
});

test("no job title implies nothing", () => {
  assert.equal(classificationForJob(""), null);
  assert.equal(classificationForJob(null), null);
});

test("'digital' must be a whole word, not a substring", () => {
  // Guards against a future title like "Digitalis" quietly counting as digital.
  assert.equal(classificationForJob("Digitalis Handler"), "Store Help");
});

test("derived values are all real classifications", () => {
  for (const j of [DIGITAL, STOCKING]) assert.ok(isValidClassification(classificationForJob(j)));
});

// ── deriveClassifications ─────────────────────────────────────────────────

const sched = (rows) => rows.map(([name, jobName]) => ({ name, jobName }));

test("Store Help is only assigned to people who actually picked", () => {
  // The rule as stated: "anyone with picks not digital will be store help".
  const r = deriveClassifications(
    sched([["ADA LOVELACE", STOCKING], ["GRACE HOPPER", STOCKING]]),
    { pickers: ["ADA LOVELACE"] },
  );
  assert.equal(r.map["ADA LOVELACE"], "Store Help");
  assert.equal(r.map["GRACE HOPPER"], undefined, "a non-picker must not be classified");
});

test("Digital is assigned from the title alone, picks or not", () => {
  const r = deriveClassifications(sched([["ADA LOVELACE", DIGITAL]]), { pickers: [] });
  assert.equal(r.map["ADA LOVELACE"], "Digital");
});

test("an In Home Delivery week is Digital, however the scheduler spelled it", () => {
  // Real shape from store 1458: the same person reads "In Home Delivery" on
  // the days the title map resolved and "1-930-1481" on the days it did not.
  // Either spelling alone, and the mix, must all land on Digital.
  const r = deriveClassifications(
    sched([["ADA LOVELACE", IHD], ["ADA LOVELACE", IHD_CODE],
           ["GRACE HOPPER", IHD_CODE]]),
    { pickers: ["ADA LOVELACE", "GRACE HOPPER"] },
  );
  assert.equal(r.map["ADA LOVELACE"], "Digital");
  assert.equal(r.map["GRACE HOPPER"], "Digital");
});

test("digital wins over a store shift covered in the same week", () => {
  // Someone who covered one stocking shift is not thereby store help — and
  // that precedence has to see In Home Delivery as digital too, whichever
  // order the shifts arrive in.
  for (const rows of [[["ADA LOVELACE", STOCKING], ["ADA LOVELACE", IHD]],
                      [["ADA LOVELACE", IHD], ["ADA LOVELACE", STOCKING]]]) {
    const r = deriveClassifications(sched(rows), { pickers: ["ADA LOVELACE"] });
    assert.equal(r.map["ADA LOVELACE"], "Digital", JSON.stringify(rows));
  }
});

test("a manual Exceptions classification is never overwritten", () => {
  const existing = { "ADA LOVELACE": "Exceptions" };
  const r = deriveClassifications(
    sched([["ADA LOVELACE", DIGITAL]]),
    { existing, pickers: ["ADA LOVELACE"] },
  );
  assert.equal(r.map["ADA LOVELACE"], "Exceptions");
  assert.equal(r.skippedManual, 1);
  assert.equal(r.changes.length, 0);
});

test("an apparel job title classifies as Store Help now that Fashion is retired", () => {
  const r = deriveClassifications(
    sched([["GRACE HOPPER", FASHION_J]]),
    { pickers: ["GRACE HOPPER"] },
  );
  assert.equal(r.map["GRACE HOPPER"], "Store Help");
});

test("MANUAL_ONLY is the one category a job title cannot express", () => {
  assert.deepEqual([...MANUAL_ONLY], ["Exceptions"]);
});

test("a previously auto-set Store Help can be upgraded to Digital", () => {
  const r = deriveClassifications(
    sched([["ADA LOVELACE", DIGITAL]]),
    { existing: { "ADA LOVELACE": "Store Help" }, pickers: ["ADA LOVELACE"] },
  );
  assert.equal(r.map["ADA LOVELACE"], "Digital");
  assert.deepEqual(r.changes, [{ name: "ADA LOVELACE", from: "Store Help", to: "Digital" }]);
});

test("Digital wins when someone covered a non-digital shift that week", () => {
  // The roster carries a title PER SHIFT. Covering one stocking shift does not
  // make a digital associate store help.
  const r = deriveClassifications(
    sched([["ADA LOVELACE", STOCKING], ["ADA LOVELACE", DIGITAL], ["ADA LOVELACE", STOCKING]]),
    { pickers: ["ADA LOVELACE"] },
  );
  assert.equal(r.map["ADA LOVELACE"], "Digital");
});

test("names are matched case-insensitively against the picker list", () => {
  const r = deriveClassifications(
    sched([["Ada Lovelace", STOCKING]]),
    { pickers: ["ADA LOVELACE"] },
  );
  assert.equal(r.map["ADA LOVELACE"], "Store Help");
});

test("no change means nothing to write", () => {
  const r = deriveClassifications(
    sched([["ADA LOVELACE", DIGITAL]]),
    { existing: { "ADA LOVELACE": "Digital" }, pickers: ["ADA LOVELACE"] },
  );
  assert.equal(r.changes.length, 0);
});

test("pickers with no scheduled shift are reported as unresolved", () => {
  const r = deriveClassifications(sched([["ADA LOVELACE", DIGITAL]]), { pickers: ["ADA LOVELACE", "ALAN TURING"] });
  assert.deepEqual(r.unresolved, ["ALAN TURING"]);
});

test("rows without a name or a title are ignored", () => {
  const r = deriveClassifications(
    [{ name: "", jobName: DIGITAL }, { name: "ADA LOVELACE", jobName: null }],
    { pickers: ["ADA LOVELACE"] },
  );
  assert.equal(r.derivedFrom, 0);
  assert.equal(r.changes.length, 0);
});

// ── leadership roles ─────────────────────────────────────────────────────
//
// Titles taken from store 1458's real schedule for 2026-08-27 (57 distinct).

test("real leadership titles map to a role", () => {
  assert.equal(leadershipForJob("Digital TL"), "TL");
  assert.equal(leadershipForJob("Digital Coach"), "COACH");
  assert.equal(leadershipForJob("Fashion TL"), "TL");
  assert.equal(leadershipForJob("AP Team Lead"), "TL");
  assert.equal(leadershipForJob("Overnight Stocking Coach"), "COACH");
});

test("coach wins over lead, so a Digital Coach is not filed as a TL", () => {
  assert.equal(leadershipForJob("Stocking 1 Coach"), "COACH");
});

test("ordinary titles have no role", () => {
  assert.equal(leadershipForJob("Digital Personal Shopper"), null);
  assert.equal(leadershipForJob("Stocking ON TA"), null);
  assert.equal(leadershipForJob(""), null);
  assert.equal(leadershipForJob(null), null);
});

test("the pattern stays tight enough to leave People Lead alone", () => {
  // A loose \blead\b would claim it; it is not a digital floor role, and
  // widening the pattern until it catches something it should not is exactly
  // how this kind of rule rots.
  assert.equal(leadershipForJob("People Lead"), null);
});

test("a role is not a classification — a Digital TL is still Digital", () => {
  assert.equal(classificationForJob("Digital TL"), "Digital");
  assert.equal(classificationForJob("Digital Coach"), "Digital");
});

test("sorting floats coach above lead above everyone else", () => {
  const rows = [{ role: null }, { role: "TL" }, { role: "COACH" }, { role: null }];
  assert.deepEqual([...rows].sort(byLeadershipFirst).map((r) => r.role),
    ["COACH", "TL", null, null]);
});
