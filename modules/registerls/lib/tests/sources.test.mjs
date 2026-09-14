// node --test modules/registerls/lib/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { normalizeWorkItems, normalizeWorkItem, toIsoDate, moneyToCents, buildListBody, nextStartIndex, PAGE_SIZE } from "../workview.js";
import { decodeLedger, cellMoneyToCents, buildCashResearchBody } from "../cash_research.js";
import { noCheckinText, buildEvidence, cashMatches, withinTolerance, tolerance, normOp, operatorTimeline, ledgerFlags, unionDiscrepancies, findCounterpartFinding, findFindingFor } from "../evidence.js";
import { MATCH_OPTS } from "../match_opts.js";
import { tieredMatching } from "../matching.js";
import { reasonsFor, safeReasonFor } from "../reasons.js";
import { buildLedger, cashierCsv, safeFileName, eventKey, aggregateEvents } from "../cashiers.js";
import { decodeCashRecycler, buildFilteredBody, timeToInt } from "../cash_recycler.js";
import { wrongRegisterMoves, advanceExplanations, tillsFor, eventsFor, tillFlags, flipCheckins, registerKind } from "../till_events.js";
import { runMatching, swapDateWindow, widenRowWindow } from "../../../livedashboard/lib/sources/register.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n) => JSON.parse(readFileSync(join(here, "fixtures", n), "utf8"));

// ── WorkView ───────────────────────────────────────────────────────

test("workview: only mel/overshort items become queue items; others counted", () => {
  const { items, others, otherCount, total } = normalizeWorkItems(fx("workview_items.json"));
  assert.equal(total, 5);
  assert.equal(otherCount, 1);
  assert.equal(items.length, 4);
  assert.equal(others.length, 1);
  assert.equal(others[0].kind, "other");
  assert.equal(others[0].category, "Refunds SASC");
  assert.equal(others[0].potentialValueCents, 6416);
  assert.match(others[0].detailUrl, /detail\/14684256/);
});

test("workview: MEL item parses store|register|date|amount and the signed card amount", () => {
  const { items } = normalizeWorkItems(fx("workview_items.json"));
  const it = items.find((i) => i.id === "14671175");
  assert.equal(it.store, "1458");
  assert.equal(it.register, "63");
  assert.equal(it.date, "2026-08-16");
  assert.equal(it.amountCents, -3000);
  assert.equal(it.type, "short");
  assert.equal(it.sourceAppId, "mel");
  assert.match(it.detailUrl, /workview#\/detail\/14671175\?id=14671175$/);
  assert.equal(it.isOverDue, true);
});

test("workview: overshort item takes register + finalized amount from card sections", () => {
  const { items } = normalizeWorkItems(fx("workview_items.json"));
  const it = items.find((i) => i.sourceAppId === "overshort");
  assert.equal(it.register, "6");
  assert.equal(it.amountCents, -9999);
  assert.equal(it.date, "2026-09-02");
});

test("workview: helpers", () => {
  assert.equal(toIsoDate("8/9/2026"), "2026-08-09");
  assert.equal(toIsoDate("2026-08-27T00:00:00"), "2026-08-27");
  assert.equal(moneyToCents("-81.00"), -8100);
  assert.equal(moneyToCents("$30.00"), 3000);
  assert.equal(moneyToCents("60.18"), 6018);
  assert.equal(normalizeWorkItem({ sourceAppId: "store", id: 1 }), null);
  const body = buildListBody("1458", { days: 30, now: new Date("2026-09-12T12:00:00Z") });
  assert.equal(body.locationHierarchy.levelCode, "1458");
  assert.equal(body.fromDate, "2026-08-13T00:00:00");
  assert.equal(body.toDate, "2026-09-12T23:59:59");
});

// ── Cash Research ──────────────────────────────────────────────────

test("cash research: decodes the ledger rows", () => {
  const { rows, columns } = decodeLedger(fx("cash_research.json").data);
  assert.equal(rows.length, 2);
  assert.equal(columns.filter((c) => c.known).length, 14);
  const r = rows.find((x) => x.date === "2026-09-09");
  assert.equal(r.store, "1458");
  assert.equal(r.register, "63");
  assert.equal(r.finalizedLsCents, -374471);
  assert.equal(r.advancesCents, 630000);
  assert.equal(r.pickupsCents, 0);
  assert.equal(r.tillCheckins, 1);
  assert.equal(r.tillCheckouts, 1);
});

test("cash research: money cells and body", () => {
  assert.equal(cellMoneyToCents("-3,744.71"), -374471);
  assert.equal(cellMoneyToCents(""), 0);
  assert.equal(cellMoneyToCents("6,300.00"), 630000);
  const b = buildCashResearchBody("1458", "63", 10);
  assert.equal(b.parameters.dailyreconciliation_posno, "63");
  assert.equal(b.parameters.dailyreconciliation_tradingday, "10");
  assert.match(b.searchVirtualFilePath, /cash research search\.search$/);
});

// ── Evidence ───────────────────────────────────────────────────────

const item = { id: "1", store: "1458", register: "63", date: "2026-08-27", amountCents: -8100, amountAbsCents: 8100, type: "short", category: "Action Required: Long/Short Item" };

test("evidence: high-confidence nearby offset → flip with paste-ready text", () => {
  const finding = { primaryRegister: "63", primaryDate: "2026-08-27", matchType: "nearby-register-offset", flipConfidence: 0.92, matchedAgainst: [{ registerNbr: "62", date: "2026-08-27", amountCents: 8300 }] };
  const ev = buildEvidence({ item, finding });
  assert.equal(ev.verdict, "flip");
  assert.equal(ev.severity, "low");
  assert.match(ev.dispositionText, /Nothing found/);
  assert.match(ev.dispositionText, /Register 63 \$81\.00 short/);
  assert.match(ev.dispositionText, /register 62 \$83\.00 over/);
});

test("evidence: same-register bounceback → bounceback", () => {
  const finding = { primaryRegister: "63", primaryDate: "2026-08-27", matchType: "same-register-bounceback", flipConfidence: 0.8, matchedAgainst: [{ registerNbr: "63", date: "2026-08-28", amountCents: 8100 }] };
  const ev = buildEvidence({ item, finding });
  assert.equal(ev.verdict, "bounceback");
  assert.match(ev.dispositionText, /drawer count corrected/i);
});

test("evidence: unmatched with exactly one cash transaction near the amount → video candidate, high severity", () => {
  const finding = { primaryRegister: "63", primaryDate: "2026-08-27", matchType: "none", flipConfidence: 0, matchedAgainst: [], severity: "medium" };
  const ej = {
    transactions: [
      { transNum: "9975", tcNum: "1", time: "11:44:50", opNum: "1234", totalCents: 76600, cashTendCents: 77000, changeDueCents: 400, isRefund: false, voidedLineCount: 0 },
      { transNum: "9980", tcNum: "2", time: "13:02:10", opNum: "1234", totalCents: 8050, cashTendCents: 10000, changeDueCents: 1950, isRefund: false, voidedLineCount: 0 },
    ],
    events: [],
    dayStats: { transactionCount: 2, cashTransactionCount: 2, refundCount: 0, voidedLineCount: 0, noSaleCount: 0, operators: [{ opNum: "1234", name: "JANE DOE", firstSeen: "11:16:22", lastSeen: "13:02:10", transactionCount: 2 }] },
  };
  const ev = buildEvidence({ item, finding, ej, ledger: [] });
  assert.equal(ev.verdict, "unmatched");
  assert.equal(ev.videoCandidates.length, 1);
  assert.equal(ev.videoCandidates[0].transNum, "9980");
  assert.equal(ev.severity, "high");
  assert.match(ev.reason, /TR# 9980 at 13:02:10/);
  assert.equal(ev.operators[0].name, "JANE DOE");
  assert.equal(ev.dispositionText, "");
});

test("evidence: no grid and no sources → no_grid with missing list", () => {
  const ev = buildEvidence({ item });
  assert.equal(ev.verdict, "no_grid");
  assert.deepEqual(ev.missing, ["powerbi", "cash_research", "ej", "tills"]);
});

test("evidence: tolerance is ±$5 under $100 and 5% above; ledger repeat pattern bumps severity", () => {
  assert.equal(tolerance(8100), 500);
  assert.equal(tolerance(40000), 2000);
  assert.equal(withinTolerance(-7650, 8100), true);
  assert.equal(withinTolerance(9000, 8100), false);
  const finding = { primaryRegister: "63", primaryDate: "2026-08-27", matchType: "none", flipConfidence: 0, matchedAgainst: [], severity: "low" };
  const ledger = [
    { date: "2026-08-27", finalizedLsCents: -8100, advancesCents: 0, pickupsCents: 0, tillCheckins: 1, tillCheckouts: 1 },
    { date: "2026-08-25", finalizedLsCents: -4000, advancesCents: 0, pickupsCents: 0, tillCheckins: 1, tillCheckouts: 1 },
  ];
  const ev = buildEvidence({ item, finding, ledger, ej: { transactions: [], events: [], dayStats: { operators: [] } } });
  assert.equal(ev.severity, "high");
  assert.ok(ev.ledgerFlags.some((f) => f.kind === "repeat"));
  assert.equal(cashMatches(null, 8100).length, 0);
});

test("evidence: Power BI's zero-padded operator ids merge with EJ's", () => {
  assert.equal(normOp("0193"), "193");
  assert.equal(normOp("193"), "193");
  const ej = { dayStats: { operators: [{ opNum: "193", name: "JANE DOE", firstSeen: "12:09:14", lastSeen: "19:57:01", transactionCount: 53 }] } };
  const disc = { operators: [{ operatorId: "0193", operatorName: null }, { operatorId: "0353" }] };
  const ops = operatorTimeline(ej, disc);
  assert.equal(ops.length, 2);
  assert.deepEqual(ops.find((o) => o.opNum === "193").sources, ["ej", "powerbi"]);
});

test("evidence: consecutive-day exact reversals in the ledger are not a repeat pattern", () => {
  const it = { register: "63", date: "2026-08-27" };
  const ledger = [
    { date: "2026-09-10", finalizedLsCents: 374471, advancesCents: 0, pickupsCents: 0, tillCheckins: 1, tillCheckouts: 1 },
    { date: "2026-09-09", finalizedLsCents: -374471, advancesCents: 0, pickupsCents: 0, tillCheckins: 1, tillCheckouts: 1 },
    { date: "2026-08-27", finalizedLsCents: -8100, advancesCents: 0, pickupsCents: 0, tillCheckins: 1, tillCheckouts: 1 },
  ];
  assert.equal(ledgerFlags(ledger, it).some((f) => f.kind === "repeat"), false);
});

test("matching: with the module's options a far register is not an offset, a neighbour is", () => {
  const d = (registerNbr, date, amount) => ({ storeNbr: "1458", registerNbr, date, amountCents: amount, type: amount < 0 ? "short" : "over", amountAbsCents: Math.abs(amount), operators: [] });
  const far = runMatching([d("63", "2026-08-27", -8100), d("12", "2026-08-28", 7600)], MATCH_OPTS);
  assert.equal(far.find((f) => f.primaryRegister === "63").matchType, "none");
  const near = runMatching([d("63", "2026-08-27", -8100), d("62", "2026-08-27", 8300)], MATCH_OPTS);
  assert.equal(near.find((f) => f.primaryRegister === "63").matchType, "nearby-register-offset");
});

test("evidence: suggestion maps flips to Process Errors (safe) and unmatched to Not Identified with the evidence text", () => {
  const flip = buildEvidence({ item, finding: { primaryRegister: "63", primaryDate: "2026-08-27", matchType: "nearby-register-offset", flipConfidence: 0.92, matchedAgainst: [{ registerNbr: "62", date: "2026-08-27", amountCents: 8300 }] } });
  assert.equal(flip.suggestion.reasonLabel, "Process Errors");
  assert.equal(flip.suggestion.safe, true);
  assert.equal(flip.suggestion.text, flip.dispositionText);
  assert.ok(flip.why.some((w) => w.kind === "offset"));
  const ej = { transactions: [{ transNum: "9980", tcNum: "2", time: "13:02:10", opNum: "1234", totalCents: 8050, cashTendCents: 10000, changeDueCents: 1950, isRefund: false, voidedLineCount: 0 }], events: [], dayStats: { transactionCount: 1, cashTransactionCount: 1, refundCount: 0, voidedLineCount: 0, noSaleCount: 0, operators: [{ opNum: "1234", name: "JANE DOE", firstSeen: "11:16:22", lastSeen: "13:02:10", transactionCount: 1 }] } };
  const un = buildEvidence({ item, finding: { primaryRegister: "63", primaryDate: "2026-08-27", matchType: "none", flipConfidence: 0, matchedAgainst: [], severity: "medium" }, ej, ledger: [] });
  assert.equal(un.suggestion.reasonLabel, null);   // no cause found → nothing to file yet
  assert.equal(un.suggestion.safe, false);
  assert.match(un.suggestion.text, /TR# 9980/);
  assert.equal(un.lookAt[0], "investigation");
  assert.ok(un.why.some((w) => w.kind === "video"));
});

test("evidence: only cash coming IN can explain a shortage — change due and refunds never match", () => {
  const ej = { transactions: [
    { transNum: "371", tcNum: "a", time: "18:56:31", opNum: "193", totalCents: 400, cashTendCents: 0, changeDueCents: 7600, isRefund: false, voidedLineCount: 0 },
    { transNum: "380", tcNum: "b", time: "19:10:00", opNum: "193", totalCents: -8100, cashTendCents: 0, changeDueCents: 8100, isRefund: true, voidedLineCount: 0 },
    { transNum: "390", tcNum: "c", time: "19:20:00", opNum: "193", totalCents: 12000, cashTendCents: 8000, changeDueCents: 0, isRefund: false, voidedLineCount: 0, tenders: [{ kind: "cash", label: "CASH TEND", cents: 8000 }, { kind: "card", label: "DEBIT TEND", cents: 4000 }] },
    { transNum: "395", tcNum: "d", time: "19:30:00", opNum: "193", totalCents: 7900, cashTendCents: 10000, changeDueCents: 2100, isRefund: false, voidedLineCount: 0 },
  ], events: [], dayStats: { operators: [] } };
  const m = cashMatches(ej, 8100);
  assert.deepEqual(m.map((x) => x.transNum), ["390", "395"]);
  assert.match(m[0].why[0], /cash tendered \$80\.00/);
  assert.match(m[1].why[0], /net cash \$79\.00/);
  const ev = buildEvidence({ item, finding: { primaryRegister: "63", primaryDate: "2026-08-27", matchType: "none", flipConfidence: 0, matchedAgainst: [], severity: "medium" }, ej, ledger: [] });
  assert.equal(ev.videoCandidates.length, 2);   // competing candidates remain reviewable
  assert.equal(ev.redFlags.some((f) => f.kind === "cash_and_card"), false);
  assert.equal(ev.redFlags.some((f) => f.kind === "big_change" || f.kind === "cash_refund"), false);
});

test("power bi: swapDateWindow with days rebuilds the action_date In-clause to that many days", () => {
  const lit = (d) => `[{"Literal":{"Value":"datetime'${d}T00:00:00'"}}]`;
  const body = `{"Where":[{"Condition":{"In":{"Expressions":[{"Column":{"Expression":{"SourceRef":{"Source":"q1"}},"Property":"action_date"}}],"Values":[${lit("2026-09-11")},${lit("2026-09-10")}]}}}]}`;
  const out = swapDateWindow(body, "2026-09-12", 60);
  const lits = out.match(/datetime'(\d{4}-\d{2}-\d{2})T00:00:00'/g);
  assert.equal(lits.length, 60);
  assert.equal(lits[0], "datetime'2026-09-12T00:00:00'");
  assert.equal(lits[59], "datetime'2026-07-15T00:00:00'");
  assert.ok(JSON.parse(out));
  // without days: same count as captured, shifted to end at endIso
  const shifted = swapDateWindow(body, "2026-09-12");
  assert.deepEqual(shifted.match(/\d{4}-\d{2}-\d{2}/g), ["2026-09-12", "2026-09-11"]);
});

test("workview: paging follows endIndex until the page is short or the total is reached", () => {
  const page = (n, endIndex, totalResults) => ({ items: Array.from({ length: n }, (_, i) => ({ id: i })), endIndex, totalResults });
  assert.equal(nextStartIndex(page(20, 19, 86), 20), 19);
  assert.equal(nextStartIndex(page(20, 39, 0), 40), 39);       // later pages omit the total
  assert.equal(nextStartIndex(page(6, 6, 6), 6), null);        // short page → done
  assert.equal(nextStartIndex(page(20, 99, 20), 20), null);    // total reached
  assert.equal(nextStartIndex({ items: [] }, 0), null);
  assert.equal(PAGE_SIZE, 20);
  assert.equal(buildListBody("1458", { startIndex: 19 }).startIndex, 19);
});

test("union: WorkView items become discrepancies and the overage side of a pair is scored too", () => {
  const q = (id, register, date, amountCents) => ({ id, store: "1458", register, date, amountCents, amountAbsCents: Math.abs(amountCents), type: amountCents < 0 ? "short" : "over" });
  const queue = [q("1", "8", "2026-07-09", -395300), q("2", "6", "2026-07-09", 395300), q("3", "7", "2026-07-10", -142643), q("4", "7", "2026-07-11", 142617), q("5", "18", "2026-07-23", 3881200)];
  const disc = unionDiscrepancies([{ storeNbr: "1458", registerNbr: "8", date: "2026-07-09", amountCents: -395300, type: "short", amountAbsCents: 395300, operators: [{ operatorId: "0193" }] }], queue, "1458");
  assert.equal(disc.length, 5);                       // grid cell wins the 8|2026-07-09 key
  assert.equal(disc.find((d) => d.registerNbr === "8").operators.length, 1);
  const findings = runMatching(disc, MATCH_OPTS);
  const short8 = findFindingFor(findings, queue[0]);
  assert.equal(short8.matchType, "nearby-register-offset");
  const over6 = findCounterpartFinding(findings, queue[1]);
  assert.equal(over6, short8);
  const evOver = buildEvidence({ item: queue[1], finding: over6, discrepancy: disc.find((d) => d.registerNbr === "6") });
  assert.equal(evOver.verdict, "flip");
  assert.equal(evOver.suggestion.reasonLabel, "Process Errors");
  assert.match(evOver.dispositionText, /register 8 \$3953\.00 short/);
  const bounce = findCounterpartFinding(findings, queue[3]);
  assert.equal(bounce.matchType, "same-register-bounceback");
  const evBig = buildEvidence({ item: queue[4], finding: null, discrepancy: disc.find((d) => d.registerNbr === "18") });
  assert.equal(evBig.verdict, "unmatched_over");
  assert.equal(evBig.videoCandidates.length, 0);
});

test("cash recycler: decodes the detail block (not the subtotal) into normalised events", () => {
  const { rows, restartTokens } = decodeCashRecycler(fx("cash_recycler_dsr.json"));
  assert.equal(rows.length, 6);
  assert.ok(Array.isArray(restartTokens));
  const r = rows[0];
  assert.equal(r.store, "1458");
  assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(r.register, "63");
  assert.equal(r.action, "TILLCHECKOUT");
  assert.equal(r.amountCents, 146200);
  assert.equal(r.timeInt, 130513);
  assert.equal(timeToInt("12:06:04 PM"), 120604);
  assert.equal(timeToInt("12:30:00 AM"), 3000);
});

test("cash recycler: the replay body gets a store + date filter and a wide window", () => {
  const body = JSON.stringify({ queries: [{ Query: { Commands: [{ SemanticQueryDataShapeCommand: { Query: { From: [{ Name: "c", Entity: "Cash_Recycler" }], Select: [] }, Binding: { DataReduction: { DataVolume: 3, Primary: { Window: { Count: 500 } } } } } }] }, CacheKey: "x" }] });
  const out = JSON.parse(buildFilteredBody(body, "1458", "2026-07-14"));
  const cmd = out.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand;
  assert.equal(cmd.Query.Where.length, 2);
  assert.equal(cmd.Query.Where[0].Condition.Contains.Right.Literal.Value, "'1458'");
  assert.match(cmd.Query.Where[1].Condition.Comparison.Right.Literal.Value, /^datetime'2026-07-14/);
  assert.equal(cmd.Binding.DataReduction.Primary.Window.Count, 5000);
  assert.equal(out.queries[0].CacheKey, undefined);
  const paged = JSON.parse(buildFilteredBody(body, "1458", "2026-07-14", { restartTokens: [["a"]] }));
  assert.deepEqual(paged.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand.Binding.DataReduction.Primary.Window.RestartTokens, [["a"]]);
});

test("till events: a cash advance that surfaces as an overage elsewhere is a far-register flip; one that doesn't is missing", () => {
  const ev = (register, date, time, action, dollars, associateId = "A1", associate = "ONE") => ({ store: "1458", register, date, time, timeInt: Number(time.replace(/:/g, "")), registerDesc: "", associateId, associate, action, amountCents: Math.round(dollars * 100), cashLsCents: 0 });
  const rows = [ev("75", "2026-08-03", "10:15:00", "ADVANCECASH", 600), ev("75", "2026-08-03", "10:16:00", "TILLCHECKIN", 1462)];
  const item = { register: "75", date: "2026-08-03", amountCents: -60000 };
  const flip = advanceExplanations(rows, item, [{ registerNbr: "12", date: "2026-08-03", amountCents: 60000 }]);
  assert.equal(flip[0].kind, "advance_flip");
  assert.equal(flip[0].landedOn.registerNbr, "12");
  const missing = advanceExplanations(rows, item, [{ registerNbr: "12", date: "2026-08-03", amountCents: 12000 }]);
  assert.equal(missing[0].kind, "advance_missing");
  const evFlip = buildEvidence({ item: { ...item, amountAbsCents: 60000 }, finding: { primaryRegister: "75", primaryDate: "2026-08-03", matchType: "none", flipConfidence: 0, matchedAgainst: [] }, tills: tillsFor(rows, item, [{ registerNbr: "12", date: "2026-08-03", amountCents: 60000 }]) });
  assert.equal(evFlip.verdict, "flip");
  assert.match(evFlip.dispositionText, /wrong register/);
  assert.match(evFlip.dispositionText, /ONE advanced \$600\.00/);
  const evMiss = buildEvidence({ item: { ...item, amountAbsCents: 60000 }, finding: { primaryRegister: "75", primaryDate: "2026-08-03", matchType: "none", flipConfidence: 0, matchedAgainst: [] }, tills: tillsFor(rows, item, []) });
  assert.equal(evMiss.verdict, "unmatched");
  assert.equal(evMiss.severity, "high");
  assert.match(evMiss.reason, /never have reached the till/);
  assert.equal(evMiss.lookAt[0], "tills");
});

test("till events: only orphan pairs are moves — a cash-office associate issuing many tills is not flagged", () => {
  const ev = (register, date, time, action, dollars, associateId, associate) => ({ store: "1458", register, date, time, timeInt: Number(time.replace(/:/g, "")), registerDesc: "", associateId, associate, action, amountCents: Math.round(dollars * 100), cashLsCents: 0 });
  // real move: reg 62 checked out, never checked in; reg 63 checked in, never checked out
  const rows = [
    ev("62", "2026-08-05", "090000", "TILLCHECKOUT", 1462, "A1", "ONE"), ev("63", "2026-08-05", "091500", "TILLCHECKIN", 1462, "A9", "NINE"),
    ev("20", "2026-08-05", "100000", "TILLCHECKOUT", 300, "A2", "TWO"), ev("20", "2026-08-05", "180000", "TILLCHECKIN", 900, "A2", "TWO"),
  ];
  const moves = wrongRegisterMoves(rows);
  assert.equal(moves.length, 1);
  assert.deepEqual([moves[0].fromRegister, moves[0].toRegister, moves[0].associateId, moves[0].checkoutBy], ["62", "63", "A9", "A1"]);
  // Kenneth's pattern: checks out 15 and 16, checks in 26 — but 15, 16 and 26 all balance on the day
  const office = [
    ev("15", "2026-08-05", "182805", "TILLCHECKOUT", 182, "K", "KEN"), ev("16", "2026-08-05", "183813", "TILLCHECKOUT", 182, "K", "KEN"),
    ev("26", "2026-08-05", "184940", "TILLCHECKIN", 182, "K", "KEN"),
    ev("26", "2026-08-05", "080000", "TILLCHECKOUT", 182, "M", "MORNING"), ev("15", "2026-08-05", "210000", "TILLCHECKIN", 190, "L", "LATE"), ev("16", "2026-08-05", "210500", "TILLCHECKIN", 185, "L", "LATE"),
  ];
  assert.equal(wrongRegisterMoves(office).length, 0);
  assert.equal(eventsFor(rows, "20", "2026-08-05").length, 2);
});

test("power bi: widenRowWindow raises small Primary windows and leaves the body alone when off", () => {
  const body = '{"Binding":{"DataReduction":{"DataVolume":3,"Primary":{"Window":{"Count":500}}}}}';
  assert.match(widenRowWindow(body, 5000), /"Count":5000/);
  assert.equal(widenRowWindow(body, 0), body);
  assert.match(widenRowWindow('{"Primary":{"Window":{"Count":9000}}}', 5000), /"Count":9000/);
});

test("till events: check-out then check-in minutes later with less cash is flagged", () => {
  const ev = (register, date, time, action, dollars, associateId, associate) => ({ store: "1458", register, date, time, timeInt: Number(time.replace(/:/g, "")), registerDesc: "", associateId, associate, action, amountCents: Math.round(dollars * 100), cashLsCents: 0 });
  const rows = [ev("63", "2026-08-27", "203259", "TILLCHECKOUT", 1462, "K1", "KEN"), ev("63", "2026-08-27", "203430", "TILLCHECKIN", 1362, "K1", "KEN")];
  const flags = tillFlags(rows, { register: "63", date: "2026-08-27" });
  const q = flags.find((f) => f.kind === "quick_recheck");
  assert.ok(q);
  assert.equal(q.deltaCents, 10000);
  assert.match(q.text, /\$100\.00 less within 2 min/);
  const ev2 = buildEvidence({ item: { register: "63", date: "2026-08-27", amountCents: -8100, amountAbsCents: 8100 }, finding: { primaryRegister: "63", primaryDate: "2026-08-27", matchType: "none", flipConfidence: 0, matchedAgainst: [] }, tills: tillsFor(rows, { register: "63", date: "2026-08-27", amountCents: -8100 }, []) });
  assert.ok(ev2.why.some((w) => w.kind === "till_quick_recheck"));
  assert.equal(ev2.lookAt[0], "tills");
});

test("till events: a vault-fund (coin) advance never explains a shortage", () => {
  const ev = (register, date, time, action, dollars) => ({ store: "1458", register, date, time, timeInt: Number(time.replace(/:/g, "")), registerDesc: "", associateId: "S1", associate: "SHAINA", action, amountCents: Math.round(dollars * 100), cashLsCents: 0 });
  const rows = [ev("28", "2026-08-03", "094014", "VAULTFUNDADVANCECASH", 5.5), ev("28", "2026-08-03", "094010", "ADVANCECASH", 64)];
  assert.deepEqual(advanceExplanations(rows, { register: "28", date: "2026-08-03", amountCents: -550 }, [{ registerNbr: "29", date: "2026-08-03", amountCents: 550 }]), []);
  const flags = tillFlags(rows, { register: "28", date: "2026-08-03" });
  assert.ok(flags.some((f) => f.kind === "change_fund" && /\$5\.50/.test(f.text)));
  assert.ok(flags.some((f) => f.kind === "advances" && /\$64\.00/.test(f.text)));
});

test("reasons: the fill uses each work-item source's own reason list", () => {
  assert.equal(safeReasonFor("mel", "flip"), "Process Errors");
  assert.equal(safeReasonFor("overshort", "flip"), "Process Error - Till Check-Ins");
  assert.equal(safeReasonFor("overshort", "bounceback"), "Process Error - Content Out of Balance");
  assert.equal(safeReasonFor("overshort", "flip", { advance: true }), "Process Error - Cash Advances");
  assert.ok(reasonsFor("overshort").includes("Process Error - Cash Pickups"));
  assert.ok(reasonsFor("mel").includes("Internal Theft"));
  const flip = buildEvidence({ item: { ...item, sourceAppId: "overshort" }, finding: { primaryRegister: "63", primaryDate: "2026-08-27", matchType: "nearby-register-offset", flipConfidence: 0.92, matchedAgainst: [{ registerNbr: "62", date: "2026-08-27", amountCents: 8300 }] } });
  assert.equal(flip.suggestion.reasonLabel, "Process Error - Till Check-Ins");
});

test("cashiers: the ledger attributes till moves, wrong-till advances and exposure on short tills", () => {
  const ev = (register, date, time, action, dollars, associateId, associate) => ({ store: "1458", register, date, time, timeInt: Number(time.replace(/:/g, "")), registerDesc: "", associateId, associate, action, amountCents: Math.round(dollars * 100), cashLsCents: 0 });
  const rows = [
    ev("62", "2026-08-05", "090000", "TILLCHECKOUT", 1462, "A1", "ONE"), ev("63", "2026-08-05", "091500", "TILLCHECKIN", 1462, "A1", "ONE"),
    ev("75", "2026-08-03", "101500", "ADVANCECASH", 600, "A2", "TWO"), ev("75", "2026-08-03", "101600", "TILLCHECKIN", 1462, "A3", "THREE"),
  ];
  const items = [{ id: "9", register: "75", date: "2026-08-03", amountCents: -60000, sourceAppId: "overshort" }];
  const discrepancies = [{ registerNbr: "12", date: "2026-08-03", amountCents: 60000 }];
  const led = buildLedger({ items, verdicts: { 9: { verdict: "flip" } }, tillRows: rows, discrepancies });
  const one = led.cashiers.find((c) => c.id === "A1"), two = led.cashiers.find((c) => c.id === "A2");
  assert.equal(one.byType.till_moved.count, 1);
  assert.equal(two.byType.advance_wrong_till.count, 1);
  assert.equal(two.totalCents, 60000);
  const led2 = buildLedger({ items, verdicts: { 9: { verdict: "unmatched" } }, tillRows: rows, discrepancies: [] });
  assert.equal(led2.cashiers.find((c) => c.id === "A3"), undefined);   // handled the till, did nothing wrong → not in the ledger
  assert.equal(led2.cashiers.find((c) => c.id === "A2").byType.advance_missing.count, 1);
  const csv = cashierCsv(two, [{ date: "2026-08-04", action: "Retrained", note: "cash advance handling", by: "shane" }]);
  assert.match(csv, /"Cash advance to the wrong register"/);
  assert.match(csv, /"Retrained","cash advance handling"/);
  assert.equal(safeFileName({ id: "A2", name: "TWO O'NEIL" }), "A2_TWO_O_NEIL.csv");
});

test("cashiers: an advance is not 'missing' when the shortage is already explained as a flip or bounceback", () => {
  const ev = (register, date, time, action, dollars, associateId, associate) => ({ store: "1458", register, date, time, timeInt: Number(time.replace(/:/g, "")), registerDesc: "", associateId, associate, action, amountCents: Math.round(dollars * 100), cashLsCents: 0 });
  const rows = [ev("62", "2026-07-20", "101500", "ADVANCECASH", 464, "S1", "SHAINA")];
  const items = [{ id: "5", register: "62", date: "2026-07-20", amountCents: -46400, sourceAppId: "overshort" }];
  assert.equal(buildLedger({ items, verdicts: { 5: { verdict: "bounceback" } }, tillRows: rows, discrepancies: [] }).cashiers.length, 0);
  assert.equal(buildLedger({ items, verdicts: { 5: { verdict: "unmatched" } }, tillRows: rows, discrepancies: [] }).cashiers[0].byType.advance_missing.count, 1);
});

test("flip pairs: one person checking in both tills is charged the pair; two closers are each charged their own check-in", () => {
  const ev = (register, date, time, action, dollars, associateId, associate) => ({ store: "1458", register, date, time, timeInt: Number(time.replace(/:/g, "")), registerDesc: "", associateId, associate, action, amountCents: Math.round(dollars * 100), cashLsCents: 0 });
  const rows = [ev("28", "2026-07-15", "200100", "TILLCHECKIN", 1390, "C1", "CSM ONE"), ev("29", "2026-07-15", "200300", "TILLCHECKIN", 1534, "C1", "CSM ONE")];
  const item = { id: "7", register: "28", date: "2026-07-15", amountCents: -7239, amountAbsCents: 7239, sourceAppId: "overshort" };
  const finding = { primaryRegister: "28", primaryDate: "2026-07-15", matchType: "nearby-register-offset", flipConfidence: 1, matchedAgainst: [{ registerNbr: "29", date: "2026-07-15", amountCents: 7250 }] };
  const fc = flipCheckins(rows, item, { register: "29", date: "2026-07-15" });
  assert.equal(fc.same, true);
  const ev1 = buildEvidence({ item, finding, tills: tillsFor(rows, item, [], undefined, { register: "29", date: "2026-07-15" }) });
  assert.equal(ev1.verdict, "flip");
  assert.match(ev1.dispositionText, /Tills checked in by CSM ONE \(reg 28 200100, reg 29 200300\)/);
  assert.ok(ev1.why.some((w) => w.kind === "flip_who"));
  const led = buildLedger({ items: [item], verdicts: { 7: { verdict: "flip" } }, tillRows: rows, discrepancies: [], counterparts: { 7: { register: "29", date: "2026-07-15" } } });
  assert.equal(led.cashiers[0].id, "C1");
  assert.equal(led.cashiers[0].byType.flip_checkin.count, 1);
  const two = [ev("28", "2026-07-15", "200100", "TILLCHECKIN", 1390, "C1", "CSM ONE"), ev("29", "2026-07-15", "200300", "TILLCHECKIN", 1534, "C2", "CSM TWO")];
  const ev2 = buildEvidence({ item, finding, tills: tillsFor(two, item, [], undefined, { register: "29", date: "2026-07-15" }) });
  assert.match(ev2.dispositionText, /CSM ONE and CSM TWO/);
  assert.match(ev2.dispositionText, /each till was checked in to the other's register/);
  const led2 = buildLedger({ items: [item], verdicts: { 7: { verdict: "flip" } }, tillRows: two, discrepancies: [], counterparts: { 7: { register: "29", date: "2026-07-15", amountCents: 7250 } } });
  assert.deepEqual(led2.cashiers.map((c) => c.id).sort(), ["C1", "C2"], "two closers: each is charged their own wrong check-in");
  assert.equal(led2.cashiers.find((c) => c.id === "C1").byType.flip_checkin.count, 1);
  assert.match(led2.cashiers.find((c) => c.id === "C2").events[0].detail, /checked reg 29 in at 200300; the other till went to reg 28, checked in by CSM ONE/);
  // one side has no check-in row at all (self-checkout or missing): nobody is charged
  const one = [ev("28", "2026-07-15", "200100", "TILLCHECKIN", 1390, "C1", "CSM ONE")];
  assert.equal(buildLedger({ items: [item], verdicts: { 7: { verdict: "flip" } }, tillRows: one, discrepancies: [], counterparts: { 7: { register: "29", date: "2026-07-15" } } }).cashiers.length, 0);
});

test("grid-only flip pairs charge the double check-in and nothing else on the register-day", () => {
  const ev = (register, date, time, action, dollars, associateId, associate) => ({ store: "1458", register, date, time, timeInt: Number(time.replace(/:/g, "")), registerDesc: "", associateId, associate, action, amountCents: Math.round(dollars * 100), cashLsCents: 0 });
  // Same CSM checks both tills in an hour apart; an override on the short register would be chargeable for a work item.
  const rows = [
    ev("93", "2026-09-02", "070000", "TILLCHECKOUT", 2578, "V1", "VAULT ONE"), ev("92", "2026-09-02", "070100", "TILLCHECKOUT", 1187, "V1", "VAULT ONE"),
    ev("93", "2026-09-02", "221221", "TILLCHECKINOVERRIDE", 1450, "C1", "CSM ONE"), ev("92", "2026-09-02", "231231", "TILLCHECKIN", 2200, "C1", "CSM ONE"),
  ];
  const item = { id: "grid:93|2026-09-02", register: "93", date: "2026-09-02", amountCents: -5300, amountAbsCents: 5300, sourceAppId: "grid", gridOnly: true };
  const led = buildLedger({ items: [item], verdicts: {}, tillRows: rows, discrepancies: [], counterparts: { [item.id]: { register: "92", date: "2026-09-02" } } });
  assert.equal(led.cashiers.length, 1);
  assert.equal(led.cashiers[0].id, "C1");
  assert.deepEqual(Object.keys(led.cashiers[0].byType), ["flip_checkin"]);
  assert.equal(led.events[0].workItemId, "grid:93|2026-09-02");
  // The same register-day as a real work item also charges the override.
  const real = buildLedger({ items: [{ ...item, id: "9", sourceAppId: "overshort", gridOnly: false }], verdicts: { 9: { verdict: "flip" } }, tillRows: rows, discrepancies: [], counterparts: { 9: { register: "92", date: "2026-09-02" } } });
  assert.deepEqual(Object.keys(real.cashiers[0].byType).sort(), ["flip_checkin", "override"]);
  // Two different closers: each is charged their own wrong check-in, grid-only or not — and still nothing else.
  const two = rows.map((r) => (r.register === "92" && r.action === "TILLCHECKIN" ? { ...r, associateId: "C2", associate: "CSM TWO" } : r));
  const led2 = buildLedger({ items: [item], verdicts: {}, tillRows: two, discrepancies: [], counterparts: { [item.id]: { register: "92", date: "2026-09-02" } } });
  assert.deepEqual(led2.cashiers.map((c) => c.id).sort(), ["C1", "C2"]);
  assert.ok(led2.cashiers.every((c) => Object.keys(c.byType).join() === "flip_checkin"));
});

test("near-miss pairs are candidates but not auto-filed: $331 short vs $350 over two registers apart", () => {
  const d = (registerNbr, date, amount) => ({ storeNbr: "1458", registerNbr, date, amountCents: amount, type: amount < 0 ? "short" : "over", amountAbsCents: Math.abs(amount), operators: [] });
  const findings = tieredMatching([d("17", "2026-07-13", -33100), d("15", "2026-07-13", 35000)]);
  const f = findings.find((x) => x.primaryRegister === "17");
  assert.equal(f.matchType, "nearby-register-offset");
  assert.equal(f.tier, 2);                                        // only the near-miss tier admits it
  assert.ok(f.flipConfidence >= 0.7);
  const short = buildEvidence({ item: { register: "17", date: "2026-07-13", amountCents: -33100, amountAbsCents: 33100, sourceAppId: "overshort" }, finding: f });
  assert.equal(short.verdict, "suspect_flip");
  assert.match(short.reason, /\$19\.00 apart/);
  const over = buildEvidence({ item: { register: "15", date: "2026-07-13", amountCents: 35000, amountAbsCents: 35000, sourceAppId: "overshort" }, finding: f });
  assert.equal(over.verdict, "suspect_flip");
  const exact = tieredMatching([d("62", "2026-08-27", -8300), d("63", "2026-08-27", 8300)]);
  assert.equal(exact[0].tier, 1);
  assert.equal(buildEvidence({ item: { register: "62", date: "2026-08-27", amountCents: -8300, amountAbsCents: 8300 }, finding: exact[0] }).verdict, "flip");
});

test("tiers: an exact partner is claimed first, so a near-miss cannot steal it", () => {
  const d = (registerNbr, date, amount) => ({ storeNbr: "1458", registerNbr, date, amountCents: amount, type: amount < 0 ? "short" : "over", amountAbsCents: Math.abs(amount), operators: [] });
  // reg 63 short $81; reg 62 over $81 (exact); reg 64 short $89 (within the near-miss tier only)
  const f = tieredMatching([d("63", "2026-08-27", -8100), d("62", "2026-08-27", 8100), d("64", "2026-08-27", -8900)]);
  const f63 = f.find((x) => x.primaryRegister === "63"), f64 = f.find((x) => x.primaryRegister === "64");
  assert.equal(f63.tier, 1);
  assert.equal(f63.matchedAgainst[0].registerNbr, "62");
  assert.equal(f64.matchType, "none");                            // its only candidate was already claimed
  assert.equal(f64.tier, null);
});


test("ledger: events have stable keys and aggregate back into cashiers after a date filter", () => {
  const e1 = { associateId: "A1", associate: "ONE", type: "till_moved", date: "2026-08-05", register: "62→63", cents: 146200, workItemId: null, detail: "" };
  const e2 = { associateId: "A1", associate: "ONE", type: "quick_recheck", date: "2026-09-01", register: "63", cents: 10000, workItemId: "9", detail: "" };
  assert.equal(eventKey(e1), eventKey({ ...e1, detail: "changed", cents: 1 }));   // identity ignores mutable text
  const agg = aggregateEvents([e1, e2]);
  assert.equal(agg[0].count, 2);
  assert.equal(agg[0].totalCents, 156200);
  const inRange = aggregateEvents([e1, e2].filter((e) => e.date >= "2026-08-15"));
  assert.equal(inRange[0].count, 1);
  assert.equal(inRange[0].byType.quick_recheck.count, 1);
});

test("self-checkouts: a lane with recycler rows but no till check-ins is SCO, and a flip between two of them names nobody", () => {
  const row = (register, registerDesc, action, date = "2026-09-02") => ({ date, time: "09:00:00 AM", timeInt: 90000, register, registerDesc, associateId: "A001", associate: "ASSOC 1", action, amountCents: 5000, cashLsCents: 0 });
  const rows = [row("7", "SCO", "ADVANCECASH"), row("8", "", "VAULTFUNDADVANCECASH"), row("15", "FRONT END", "TILLCHECKIN"), row("15", "FRONT END", "TILLCHECKOUT")];
  assert.equal(registerKind(rows, "7").sco, true);
  assert.equal(registerKind(rows, "8").sco, true, "no description, rows but never a check-in → SCO");
  assert.equal(registerKind(rows, "15").sco, false);
  assert.equal(registerKind(rows, "99").sco, false, "unknown register is not assumed SCO");
  const item = { id: "x", register: "7", date: "2026-09-02", amountCents: -7050, amountAbsCents: 7050, sourceAppId: "overshort" };
  const tills = tillsFor(rows, item, [], undefined, { register: "8", date: "2026-09-02" });
  assert.match(noCheckinText(tills, "7", "8", "2026-09-02"), /self-checkouts.*nobody to charge/);
  assert.match(noCheckinText(tills, "7", "15", "2026-09-02"), /Reg 7 is a self-checkout/);
  assert.match(noCheckinText(tills, "15", "17", "2026-08-01"), /starts 2026-09-02; 2026-08-01 is before it/);
});
