import test from "node:test";
import assert from "node:assert/strict";
import { mealNameKey, mealHash, hashMeals, mealsForNames, mealRow, punchFromRow, validMealRow, MEAL_HASH_HEX } from "../meal_hash.js";
import { withMeals } from "../break_log.js";

const KEY = "0f".repeat(32);
const OTHER = "a1".repeat(32);

test("the hash covers exactly what sameName compares", async () => {
  assert.equal(mealNameKey("Mary Ann  Smith-Jones"), "mary smith-jones");
  assert.equal(mealNameKey("MARY SMITH-JONES"), "mary smith-jones");
  const a = await mealHash(KEY, "Mary Ann Smith-Jones");
  assert.equal(a.length, MEAL_HASH_HEX);
  assert.equal(a, await mealHash(KEY, "mary smith-jones"));
  assert.notEqual(a, await mealHash(KEY, "Mary Smith"));
  assert.notEqual(a, await mealHash(OTHER, "Mary Ann Smith-Jones"), "a different key gives a different hash");
  assert.equal(await mealHash(KEY, ""), "");
  assert.equal(await mealHash("short", "Mary Smith"), "", "a malformed key never hashes");
});

test("upload carries no names and only the four numbers", async () => {
  const up = await hashMeals(KEY, {
    "JANE DOE": { clockIn: 420, clockOut: null, mealOut: 720, mealIn: 750, _at: 1000, win: "123", app: "MyWalmart" },
    "BOB ROE": { clockIn: 360, clockOut: 900, mealOut: null, mealIn: null, _at: 2000 },
  });
  const text = JSON.stringify(up);
  assert.ok(!/jane|doe|bob|roe|123|MyWalmart|420|360/i.test(text), text);
  assert.deepEqual(Object.values(up).sort(), [[null, 720, 750, 1000], [900, null, null, 2000]].sort());
  for (const row of Object.values(up)) assert.ok(validMealRow(row));
});

test("GIF names find their punches; the lunch rule gives the same answer as with names", async () => {
  const punches = { "JANE DOE": { clockIn: 420, clockOut: null, mealOut: 720, mealIn: 755, _at: Date.UTC(2026, 9, 24, 23) } };
  const stored = await hashMeals(KEY, punches);
  const got = await mealsForNames(KEY, stored, ["Jane Q Doe", "Somebody Else"]);
  assert.deepEqual(Object.keys(got), ["Jane Q Doe"]);
  assert.deepEqual(got["Jane Q Doe"], { clockOut: null, mealOut: 720, mealIn: 755, _at: punches["JANE DOE"]._at });
  const day = "2026-10-24";
  const start = new Date(2026, 9, 24, 11, 58).getTime();
  const ep = [{ name: "Jane Q Doe", lastSeenActiveAt: start, firstFlaggedAt: start + 18 * 60_000, lastFlaggedAt: start + 60 * 60_000,
    longestMin: 62, status: "cleared", cleared: start + 62 * 60_000 }];
  const byName = withMeals(ep, punches, day, { now: start + 70 * 60_000 });
  const byHash = withMeals(ep, got, day, { now: start + 70 * 60_000 });
  assert.equal(byHash[0].kind, byName[0].kind);
  assert.equal(byHash[0].mealMin, byName[0].mealMin);
});

test("row round trip and validation", () => {
  assert.deepEqual(punchFromRow(mealRow({ clockOut: 900, mealOut: "720", mealIn: undefined, _at: 5 })), { clockOut: 900, mealOut: 720, mealIn: null, _at: 5 });
  assert.equal(punchFromRow("x"), null);
  assert.ok(!validMealRow([1, 2, 3]));
  assert.ok(!validMealRow([1.5, null, null, 0]));
  assert.ok(!validMealRow(["720", null, null, 0]));
  assert.ok(!validMealRow([null, -1, null, 0]));
  assert.ok(validMealRow([null, null, null, 0]));
});
