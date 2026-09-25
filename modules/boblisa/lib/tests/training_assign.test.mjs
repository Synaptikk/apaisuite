// node modules/boblisa/lib/tests/training_assign.test.mjs
//
// A paid training receipt documented against the first transaction's cashier
// (misses.js::pairFromTraining), with and without a same-card earlier sale.
import assert from "node:assert/strict";
import { pairFromTraining, buildRecord, buildCashierLedger, draftNote, missedCents } from "../misses.js";

const training = { key: "2026-09-16|train|92|1201", date: "2026-09-16", time: "12:46:10", reg: 92, op: "9052", tr: "1201",
  items: [{ desc: "COORS LIGHT", code: "007199000123", cents: 2467 }] };
const paidWithPrev = { time: "12:47:54", reg: 31, type: "Self-checkout", op: "31", tr: "9391", items: 1, total: 2467, tender: "DEBIT TEND", hasToken: true,
  prev: { time: "12:40:00", reg: 17, type: "Manned", op: "2920", tr: "4587", items: 44, total: 27533, tender: "DEBIT TEND" } };

// Same-card earlier sale known: charged to that operator, keyed like findPairs.
const p = pairFromTraining(training, paidWithPrev);
assert.equal(p.key, "2026-09-16|17|4587|31|9391", "key matches findPairs so the row and the card share one record");
assert.equal(p.category, "manned"); assert.equal(p.t1.op, "2920"); assert.equal(p.manualCashier, false);
assert.equal(p.gapMin, 8); assert.equal(p.training, true);
assert.deepEqual(p.trainingRef, { time: "12:46:10", reg: 92, op: "9052", tr: "1201" });
assert.equal(missedCents(p), 2467, "what was missed = the training receipt lines");
assert.equal(p.t2.prev, undefined); assert.equal(p.t2.items.length, 1);
assert.equal(draftNote(p, { name: "Jane D" }), "09/16/26 cashier Jane D op 2920 missed COORS LIGHT $24.67 from BoB.");

// No earlier sale in the journal: the analyst names the operator (and maybe the register).
const noPrev = { ...paidWithPrev, hasToken: false, prev: null };
const m = pairFromTraining(training, noPrev, { op: "4321", reg: "" });
assert.equal(m.manualCashier, true); assert.equal(m.key, "2026-09-16|train|92|1201|31|9391");
assert.equal(m.t1.op, "4321"); assert.equal(m.t1.reg, ""); assert.equal(m.gapMin, null);
assert.equal(m.category, "manned", "no register given counts as a manned lane");
assert.equal(pairFromTraining(training, noPrev, { op: "4321", reg: 31 }).category, "unmanned");
assert.equal(pairFromTraining(training, noPrev, { op: "4321", reg: 12 }).t1.type, "Manned");

// The record and the cashier ledger charge the named operator.
const rec = buildRecord(m, "1458", { cause: "bottom_of_basket" }, {}, null, new Date("2026-09-17T10:00:00Z"));
assert.equal(rec.cashier.op, "4321"); assert.equal(rec.outcome, "training_receipt"); assert.equal(rec.missedCents, 2467);
assert.equal(rec.flags.training, true);
const ledger = buildCashierLedger({ [rec.key]: rec });
assert.equal(ledger["4321"].count, 1); assert.equal(ledger["4321"].cents, 2467);

assert.equal(pairFromTraining(null, noPrev), null);
assert.equal(pairFromTraining(training, null), null);
console.log("boblisa training assign test: ok");
