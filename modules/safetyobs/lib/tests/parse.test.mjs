// node --test modules/safetyobs/lib/tests/parse.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { parseObservation, hourFromText, mergeAiPick } from "../parse.js";
import { missingAnswers, shiftForHour } from "../form_schema.js";

const morning = new Date(2026, 9, 8, 10, 30);
const evening = new Date(2026, 9, 8, 19, 0);

test("the user's recognition example", () => {
  const r = parseObservation("Shane was observed in fresh cleaning a spill with a mop", { now: morning });
  assert.deepEqual(r.answers, {
    shift: "First", type: "Recognition", location: "Fresh", process: "Cleaning", tool: "Cleaning supplies",
    description: "Shane was observed in fresh cleaning a spill with a mop.",
  });
  assert.deepEqual(r.missing, []);
});

test("the user's engagement example: time picks the shift, no description", () => {
  const r = parseObservation("A coke vendor was climbing on a pallet at 11am", { now: evening });
  assert.equal(r.hour, 11);
  assert.equal(r.answers.shift, "First");
  assert.equal(r.answers.type, "Engagement");
  assert.equal(r.answers.process, "Climbing");
  assert.equal(r.answers.tool, "Merchandise");
  assert.equal(r.answers.location, "Food");
  assert.equal(r.answers.description, "");
});

test("climbing a ladder is not an engagement on its own", () => {
  const r = parseObservation("Maria was climbing a ladder safely in hardware", { now: morning });
  assert.equal(r.answers.type, "Recognition");
  assert.equal(r.answers.tool, "Ladder");
  assert.equal(r.answers.location, "Hardlines");
});

test("missing PPE is an engagement", () => {
  const r = parseObservation("associate in the backroom using a box cutter without gloves", { now: morning });
  assert.equal(r.answers.type, "Engagement");
  assert.equal(r.answers.location, "Backroom");
  assert.equal(r.answers.process, "Cutting");
  assert.equal(r.answers.tool, "Box Cutter");
});

test("no location named → missing, so the panel asks", () => {
  const r = parseObservation("someone lifting a heavy box with bent knees", { now: morning });
  assert.deepEqual(r.missing, ["location"]);
  assert.equal(r.answers.process, "Lifting");
  assert.equal(r.answers.tool, "Box-case");
});

test("hours and shifts", () => {
  assert.equal(hourFromText("at 11am"), 11);
  assert.equal(hourFromText("around 3:15 PM"), 15);
  assert.equal(hourFromText("12am"), 0);
  assert.equal(hourFromText("12pm"), 12);
  assert.equal(hourFromText("no time here"), null);
  assert.equal(shiftForHour(5), "Third");
  assert.equal(shiftForHour(6), "First");
  assert.equal(shiftForHour(14), "Second");
  assert.equal(shiftForHour(22), "Third");
});

test("AI overlay keeps only values on the form's list", () => {
  const base = parseObservation("A coke vendor was climbing on a pallet at 11am", { now: morning }).answers;
  const { answers, changed } = mergeAiPick(base, { location: "food", tool: "Pallet", process: "Climbing" });
  assert.equal(answers.location, "Food");
  assert.equal(answers.tool, "Merchandise");
  assert.deepEqual(changed, []);
  const flip = mergeAiPick(base, { type: "Recognition", description: "Vendor used a ladder." });
  assert.equal(flip.answers.type, "Recognition");
  assert.equal(flip.answers.description, "Vendor used a ladder.");
});

test("missingAnswers follows the branch", () => {
  const a = { store: "1458", role: "Coach", shift: "First", type: "Engagement", location: "Food", process: "Climbing", tool: "Merchandise" };
  assert.deepEqual(missingAnswers(a), []);
  assert.deepEqual(missingAnswers({ ...a, type: "Recognition" }), ["description"]);
  assert.deepEqual(missingAnswers({ ...a, tool: "Pallet" }), ["tool"]);
});

test("work area beats the product department, misspelt or not", () => {
  for (const t of [
    "jamie price was properly shrink wrapping pallets in grocery recieving at 9:15am",
    "unloading the grocery truck",
    "working freight in grocery receiving",
  ]) assert.equal(parseObservation(t, { now: morning }).answers.location, "Backroom", t);
  const r = parseObservation("jamie price was properly shrink wrapping pallets in grocery recieving at 9:15am", { now: evening });
  assert.equal(r.answers.type, "Recognition");
  assert.equal(r.answers.shift, "First");  assert.equal(r.answers.process, "Stocking");
});
