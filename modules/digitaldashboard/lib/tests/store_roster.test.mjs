// node --test modules/digitaldashboard/lib/tests/store_roster.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyRoster, mergeSnapshot, needsCheck, applyDetails, rosterRows, rosterTotals,
} from "../store_roster.js";

const snap = (day, seen) => ({ day, seen });
const t0 = 1_000_000;

test("merge adds associates with status and first/last seen", () => {
  const r = mergeSnapshot(null, snap("2026-10-03", [
    { name: "Avery Sample", status: "picking" },
    { name: "Blake Sample", status: "notactive" },
  ]), t0);
  assert.equal(Object.keys(r.associates).length, 2);
  assert.equal(r.associates["Avery Sample"].status, "picking");
  assert.equal(r.associates["Blake Sample"].firstSeen, t0);
});

test("a name that leaves the All list becomes offclock but keeps its count", () => {
  let r = mergeSnapshot(null, snap("D", [{ name: "Avery Sample", status: "picking" }]), t0);
  r = applyDetails(r, { "Avery Sample": { picks: 40 } }, t0);
  r = mergeSnapshot(r, snap("D", []), t0 + 1000); // dropped off
  assert.equal(r.associates["Avery Sample"].status, "offclock");
  assert.equal(r.associates["Avery Sample"].picks, 40);
});

test("inactive → active clears settled so the moving count is re-read", () => {
  let r = mergeSnapshot(null, snap("D", [{ name: "Avery Sample", status: "notactive" }]), t0);
  r = applyDetails(r, { "Avery Sample": { picks: 10 } }, t0);          // 1st inactive check
  r = applyDetails(r, { "Avery Sample": { picks: 10 } }, t0 + 1000);   // 2nd → settled
  assert.equal(r.associates["Avery Sample"].settled, true);
  r = mergeSnapshot(r, snap("D", [{ name: "Avery Sample", status: "picking" }]), t0 + 2000);
  assert.equal(r.associates["Avery Sample"].settled, false);
  assert.equal(r.associates["Avery Sample"].inactiveChecks, 0);
});

test("settle after two inactive checks; then never re-queued", () => {
  let r = mergeSnapshot(null, snap("D", [{ name: "Dana Sample", status: "notactive" }]), t0);
  // never checked → queued
  assert.deepEqual(needsCheck(r, { now: t0, budget: 5 }), ["Dana Sample"]);
  r = applyDetails(r, { "Dana Sample": { picks: 22 } }, t0);
  assert.equal(r.associates["Dana Sample"].settled, false);           // one check only
  assert.deepEqual(needsCheck(r, { now: t0 + 10, budget: 5 }), ["Dana Sample"]); // still needs confirm
  r = applyDetails(r, { "Dana Sample": { picks: 22 } }, t0 + 20);
  assert.equal(r.associates["Dana Sample"].settled, true);
  assert.deepEqual(needsCheck(r, { now: t0 + 999_999, budget: 5 }), []); // settled → skipped forever
});

test("active associates are re-checked, but only past the min gap", () => {
  let r = mergeSnapshot(null, snap("D", [{ name: "Avery Sample", status: "picking" }]), t0);
  r = applyDetails(r, { "Avery Sample": { picks: 5 } }, t0);
  assert.deepEqual(needsCheck(r, { now: t0 + 1000, budget: 5, activeMinGapMs: 90_000 }), []); // too soon
  assert.deepEqual(needsCheck(r, { now: t0 + 100_000, budget: 5, activeMinGapMs: 90_000 }), ["Avery Sample"]);
});

test("needsCheck priority: just-stopped > active > never-seen, capped at budget", () => {
  let r = mergeSnapshot(null, snap("D", [
    { name: "Stopped", status: "picking" },
    { name: "Working", status: "picking" },
    { name: "NewIdle", status: "notactive" },
  ]), t0);
  r = applyDetails(r, { "Stopped": { picks: 30 }, "Working": { picks: 20 } }, t0);
  // Stopped goes inactive (just stopped — needs the final count), Working still active & aged
  r = mergeSnapshot(r, snap("D", [
    { name: "Stopped", status: "notactive" },
    { name: "Working", status: "picking" },
    { name: "NewIdle", status: "notactive" },
  ]), t0 + 200_000);
  const order = needsCheck(r, { now: t0 + 200_000, budget: 3, activeMinGapMs: 90_000 });
  assert.equal(order[0], "Stopped");   // prio 0: capture the stopped count
  assert.ok(order.includes("Working") && order.includes("NewIdle"));
});

test("rows sort by picks desc and carry the code", () => {
  let r = mergeSnapshot(null, snap("D", [
    { name: "Avery Sample", status: "picking" },
    { name: "Blake Sample", status: "picking" },
  ]), t0);
  r = applyDetails(r, { "Avery Sample": { picks: 10 }, "Blake Sample": { picks: 50 } }, t0);
  const code = (n) => (n === "Blake Sample" ? "Digital" : "Grocery");
  const rows = rosterRows(r, code);
  assert.equal(rows[0].name, "Blake Sample");
  assert.equal(rows[0].code, "Digital");
});

test("totals split store-help, and infer digital from the store total", () => {
  let r = mergeSnapshot(null, snap("D", [
    { name: "Dig One", status: "picking" },
    { name: "Help A", status: "notactive" },
    { name: "Help B", status: "notactive" },
  ]), t0);
  r = applyDetails(r, { "Help A": { picks: 30 }, "Help B": { picks: 20 } }, t0);
  const isDigital = (n) => n.startsWith("Dig");
  const tot = rosterTotals(r, isDigital, 500);
  assert.equal(tot.storeHelpAssociates, 2);
  assert.equal(tot.storeHelpPicks, 50);
  assert.equal(tot.storeHelpPending, 0);
  assert.equal(tot.digitalPicks, 450);   // 500 - 50
});

test("digitalPicks is null while any store-help count is still pending", () => {
  let r = mergeSnapshot(null, snap("D", [
    { name: "Help A", status: "picking" },
    { name: "Help B", status: "picking" },
  ]), t0);
  r = applyDetails(r, { "Help A": { picks: 30 } }, t0); // B unknown
  const tot = rosterTotals(r, () => false, 500);
  assert.equal(tot.storeHelpPending, 1);
  assert.equal(tot.digitalPicks, null);
});
