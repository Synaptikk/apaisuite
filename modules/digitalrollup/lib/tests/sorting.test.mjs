// modules/digitalrollup/lib/tests/sorting.test.mjs
//
// Run with: node --test modules/digitalrollup/lib/tests/sorting.test.mjs
//
// Five metrics in two directions, plus missing values and two tie-breaks, is
// more behaviour than "it looked right in the screenshot" can cover — and a
// sort that is quietly backwards for one metric is the kind of bug a reader
// trusts rather than notices.

import test from "node:test";
import assert from "node:assert/strict";
import {
  METRIC_SORTS, byMetric, cardStatus, cardSeverity, isKnownSort, sortCards,
} from "../sorting.js";

/** Minimal card carrying only the fields the sorts read. */
const card = (store, o = {}) => ({
  store_nbr: store,
  picking: {
    status: o.pickStatus ?? "green", status_label: o.pickLabel ?? "On track",
    on_time_pct: o.onTime, pick_rate: o.pickRate,
  },
  staging: { totes_to_stage: o.totes, totes_to_stage_status: o.totesStatus ?? "green" },
  dispense: {
    status: o.dispStatus ?? "green", status_label: o.dispLabel ?? "On track",
    wait_time: o.wait,
  },
  quality: { pre_sub_pct: o.preSub },
});

const nums = (cards) => cards.map((c) => c.store_nbr);

test("every headline metric is sortable in both directions", () => {
  // The guard against adding a figure to the card and forgetting the sort.
  for (const m of METRIC_SORTS) {
    assert.ok(isKnownSort(`${m.key}-asc`), `${m.key}-asc should be a known sort`);
    assert.ok(isKnownSort(`${m.key}-desc`), `${m.key}-desc should be a known sort`);
  }
  assert.equal(METRIC_SORTS.length, 5);
});

test("each metric sorts on its raw numeric field, both ways", () => {
  const cards = [
    card(1, { onTime: 95, pickRate: 80, totes: 10, wait: 9.5, preSub: 90 }),
    card(2, { onTime: 99, pickRate: 120, totes: 200, wait: 2.0, preSub: 99 }),
    card(3, { onTime: 97, pickRate: 100, totes: 50, wait: 10.0, preSub: 95 }),
  ];
  assert.deepEqual(nums(sortCards(cards, "ontime-asc")), [1, 3, 2]);
  assert.deepEqual(nums(sortCards(cards, "ontime-desc")), [2, 3, 1]);
  assert.deepEqual(nums(sortCards(cards, "pickrate-asc")), [1, 3, 2]);
  assert.deepEqual(nums(sortCards(cards, "totes-desc")), [2, 3, 1]);
  assert.deepEqual(nums(sortCards(cards, "presub-asc")), [1, 3, 2]);
  // 10.0 vs 9.5 is the case a string sort gets wrong.
  assert.deepEqual(nums(sortCards(cards, "wait-desc")), [3, 1, 2]);
});

test("missing values sort last in BOTH directions", () => {
  // Not coerced to 0 (which would make a no-data store the "worst") and not to
  // Infinity (which would make it the "best"). It is simply not ranked.
  const cards = [card(1, { wait: 5 }), card(2, {}), card(3, { wait: 1 })];
  assert.deepEqual(nums(sortCards(cards, "wait-desc")), [1, 3, 2]);
  assert.deepEqual(nums(sortCards(cards, "wait-asc")), [3, 1, 2]);
});

test("byMetric treats a non-finite value as missing", () => {
  const cmp = byMetric("dispense.wait_time", "desc");
  assert.equal(cmp(card(1, { wait: 5 }), card(2, { wait: null })), -1);
  assert.equal(cmp(card(1, { wait: null }), card(2, { wait: 5 })), 1);
  assert.equal(cmp(card(1, { wait: null }), card(2, { wait: null })), 0);
});

test("store sorts are numeric, not lexicographic", () => {
  const cards = [card(1089), card(658), card(5173)];
  assert.deepEqual(nums(sortCards(cards, "store-asc")), [658, 1089, 5173]);
  assert.deepEqual(nums(sortCards(cards, "store-desc")), [5173, 1089, 658]);
});

test("cardStatus takes colour and wording from the SAME group", () => {
  // The bug this prevents: an amber chip reading "On track", because the
  // colour came from dispense and the label from picking.
  const c = card(1, {
    pickStatus: "green", pickLabel: "On track",
    dispStatus: "yellow", dispLabel: "Watch",
  });
  assert.deepEqual(cardStatus(c), { status: "yellow", label: "Watch" });
});

test("staging is shown but never weighted into the card's status", () => {
  // A deliberate decision, not an oversight: totes to stage is a backlog, and
  // a backlog is context for judging the figures that measure service rather
  // than a verdict on its own. It also has no `status_label` in the API, so
  // folding it in would have meant putting our words in the board's mouth.
  const backlog = card(1, { pickStatus: "green", dispStatus: "green", totesStatus: "red" });
  assert.deepEqual(cardStatus(backlog), { status: "green", label: "On track" });
  assert.equal(cardSeverity(backlog), "green");
});

test("a card with no statuses at all is gray, not green", () => {
  const bare = { store_nbr: 7 };
  assert.deepEqual(cardStatus(bare), { status: "gray", label: "—" });
});

test("'needs attention' orders by severity, then by wait — not by totes", () => {
  const cards = [
    card(1, { pickStatus: "green",  dispStatus: "green",  totes: 10,  wait: 2 }),
    card(2, { pickStatus: "red",    dispStatus: "green",  totes: 5,   wait: 1 }),
    card(3, { pickStatus: "yellow", dispStatus: "green",  totes: 300, wait: 1 }),
    card(4, { pickStatus: "yellow", dispStatus: "green",  totes: 20,  wait: 9 }),
  ];
  // Red first; then the two yellows by wait (9 before 1), so the 300-tote
  // store sorts BELOW the 20-tote one. That is the intended behaviour — the
  // backlog is visible on both cards and has its own sort when it is what you
  // are looking for.
  assert.deepEqual(nums(sortCards(cards, "attention")), [2, 4, 3, 1]);
});

test("gray sorts after green — no data is not a bad score", () => {
  const cards = [
    card(1, { pickStatus: "gray", dispStatus: "gray", totesStatus: "gray" }),
    card(2, { pickStatus: "green", dispStatus: "green" }),
  ];
  assert.deepEqual(nums(sortCards(cards, "attention")), [2, 1]);
  assert.equal(cardSeverity(cards[0]), "gray");
});

test("an unrecognised sort falls back to attention, not to arbitrary order", () => {
  // A mode persisted by an older build must not leave the grid in whatever
  // order the API happened to return.
  const cards = [
    card(1, { pickStatus: "green", dispStatus: "green" }),
    card(2, { pickStatus: "red",   dispStatus: "green" }),
  ];
  assert.deepEqual(nums(sortCards(cards, "sortBySomethingRemoved")), [2, 1]);
  assert.equal(isKnownSort("sortBySomethingRemoved"), false);
});

test("sortCards does not mutate its input", () => {
  const cards = [card(3), card(1), card(2)];
  const before = nums(cards);
  sortCards(cards, "store-asc");
  assert.deepEqual(nums(cards), before);
});
