// node --test modules/registerls/lib/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRegisterMap, roleFromDesc, wideRegistersOf, roleSuffix, descsFromTillRows, ROLES } from "../registers.js";
import { tieredMatching, pairingOf } from "../matching.js";
import { ERROR_TYPES, eventKey, aggregateEvents, cashierCsv } from "../cashiers.js";

const row = (register, registerDesc, n = 1) => Array.from({ length: n }, () => ({ register, registerDesc, action: "TILLCHECKIN", date: "2026-09-01" }));

test("roleFromDesc: the till log's labels map to roles; UNKNOWN says nothing", () => {
  assert.equal(roleFromDesc("SCO"), "sco");
  assert.equal(roleFromDesc("FRONT END"), "front_end");
  assert.equal(roleFromDesc("CUSTOMER SERVICE"), "service_desk");
  assert.equal(roleFromDesc("MONEY CENTER"), "money_center");
  assert.equal(roleFromDesc("PHARMACY"), "pharmacy");
  assert.equal(roleFromDesc("GARDEN CENTER"), "department");
  assert.equal(roleFromDesc("UNKNOWN"), null);
  assert.equal(roleFromDesc(""), null);
});

test("buildRegisterMap: store 1458 shape — log labels, range defaults, department below defaults", () => {
  const tillRows = [...row("92", "CUSTOMER SERVICE", 5), ...row("62", "UNKNOWN", 3), ...row("63", "COSMETIC", 4), ...row("67", "ELECTRONICS", 2), ...row("1", "SCO", 9), ...row("11", "FRONT END", 7)];
  const map = buildRegisterMap({ tillRows, registers: ["94", "61", "40"] });
  assert.equal(map["92"].role, "service_desk"); assert.equal(map["92"].source, "log");
  assert.equal(map["94"].role, "service_desk"); assert.equal(map["94"].source, "default");   // grid knows it, log has no rows
  assert.equal(map["62"].role, "money_center"); assert.equal(map["62"].source, "default");   // UNKNOWN in the log
  assert.equal(map["63"].role, "money_center"); assert.equal(map["63"].source, "default");   // COSMETIC is a stale department label
  assert.equal(map["63"].desc, "COSMETIC");                                                   // but the label is still shown
  assert.equal(map["61"].role, "money_center");
  assert.equal(map["67"].role, "department"); assert.equal(map["67"].desc, "ELECTRONICS");
  assert.equal(map["1"].role, "sco"); assert.equal(map["11"].role, "front_end");
  assert.equal(map["40"].role, "unknown"); assert.equal(map["40"].source, "none");
  assert.deepEqual(Object.keys(map), ["1", "11", "40", "61", "62", "63", "67", "92", "94"]);
  assert.deepEqual(wideRegistersOf(map), ["92", "94"]);
});

test("buildRegisterMap: the analyst's override wins over the log and the defaults", () => {
  const map = buildRegisterMap({ tillRows: row("92", "CUSTOMER SERVICE", 3), registers: ["63"], overrides: { "92": "front_end", "63": "department", "5": "pharmacy" } });
  assert.equal(map["92"].role, "front_end"); assert.equal(map["92"].source, "analyst");
  assert.equal(map["63"].role, "department"); assert.equal(map["63"].source, "analyst");
  assert.equal(map["5"].role, "pharmacy");                     // an override alone puts the register on the map
  assert.deepEqual(wideRegistersOf(map), []);                  // no service desk left at this store
  const bad = buildRegisterMap({ overrides: { "7": "nonsense" } });
  assert.equal(bad["7"].role, "unknown");                      // an unknown role is ignored, not trusted
});

test("descsFromTillRows: majority label per register, rows counted", () => {
  const d = descsFromTillRows([...row("9", "FRONT END", 3), ...row("9", "SCO", 1), ...row("09", "FRONT END", 1)]);
  assert.equal(d["9"].desc, "FRONT END"); assert.equal(d["9"].rows, 5);
});

test("roleSuffix: prose gets the role, plain lanes get nothing", () => {
  const map = buildRegisterMap({ tillRows: [...row("63", "COSMETIC"), ...row("67", "ELECTRONICS"), ...row("11", "FRONT END")], registers: ["92"] });
  assert.equal(roleSuffix(map, "63"), " (money center)");
  assert.equal(roleSuffix(map, "67"), " (electronics)");
  assert.equal(roleSuffix(map, "92"), " (service desk)");
  assert.equal(roleSuffix(map, "11"), "");
  assert.equal(roleSuffix(map, "5"), "");
  assert.ok(Object.keys(ROLES).includes("money_center"));
});

test("tieredMatching: the store's own service desk pairs store-wide; the built-in 92 does not when the map says otherwise", () => {
  const d = (registerNbr, amountCents) => ({ storeNbr: "1458", date: "2026-08-09", registerNbr, amountCents, type: amountCents < 0 ? "short" : "over", amountAbsCents: Math.abs(amountCents), operators: [] });
  // Store where 50 is the service desk and 92 is an ordinary lane.
  const wide = tieredMatching([d("50", -6018), d("12", 5965)], undefined, { wideRegisters: ["50"] });
  const f = wide.find((x) => String(x.primaryRegister) === "50");
  assert.equal(f.matchType, "nearby-register-offset"); assert.equal(f.pairing, "service_desk"); assert.equal(f.tier, 1);
  const plain = tieredMatching([d("92", -6018), d("12", 5965)], undefined, { wideRegisters: ["50"] });
  const g = plain.find((x) => String(x.primaryRegister) === "92");
  assert.equal(g.pairing, "same_day_far");                     // far pair on the same day: review only, never tier 1
  assert.equal(g.tier, 3);
  assert.equal(pairingOf(g, ["92"]), "service_desk");           // the same finding read with 92 wide
});

test("training receipt: a manual ledger event aggregates, labels and exports like the derived ones", () => {
  assert.equal(ERROR_TYPES.training_receipt, "Unpaid training receipt");
  const e = { associateId: "1234567", associate: "DOE, JANE", type: "training_receipt", date: "2026-09-10", register: "15", cents: 4312, workItemId: "receipt:TC 9988", detail: "Training receipt TC 9988 — walked out", manual: true, storeNbr: "1458" };
  assert.equal(eventKey(e), "1234567|training_receipt|2026-09-10|15|receipt:TC 9988");
  const [c] = aggregateEvents([e, { ...e, workItemId: "receipt:TC 9989", cents: 1000 }]);
  assert.equal(c.count, 2); assert.equal(c.totalCents, 5312); assert.equal(c.byType.training_receipt.count, 2);
  const csv = cashierCsv(c, []);
  assert.match(csv, /Unpaid training receipt"?,"?43\.12"?,"?receipt:TC 9988/);
});
