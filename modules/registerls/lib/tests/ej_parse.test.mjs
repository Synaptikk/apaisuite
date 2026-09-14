import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseReceipt, parseRecords, timeIntToHms, centsFromMoney } from "../ej_parse.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "ej_records.json"), "utf8"));
const day = parseRecords(fixture.records);
const byTr = (tr) => day.transactions.find((t) => t.transNum === tr);

test("centsFromMoney handles trailing/leading minus, commas, and junk", () => {
  assert.equal(centsFromMoney("150.00-"), -15000);
  assert.equal(centsFromMoney("-4.00"), -400);
  assert.equal(centsFromMoney("1,234.56"), 123456);
  assert.equal(centsFromMoney("766.00"), 76600);
  assert.equal(centsFromMoney("0.00"), 0);
  assert.equal(centsFromMoney("150.00-H\u0000\u0000"), -15000);
  assert.equal(centsFromMoney("abc"), null);
  assert.equal(centsFromMoney(""), null);
});

test("timeIntToHms pads short HHMMSS integers", () => {
  assert.equal(timeIntToHms(21144), "02:11:44");
  assert.equal(timeIntToHms(112707), "11:27:07");
  assert.equal(timeIntToHms(0), "00:00:00");
  assert.equal(timeIntToHms("x"), null);
  assert.equal(timeIntToHms(undefined), null);
});

test("parseReceipt returns null for non-receipt text and strips NULs", () => {
  assert.equal(parseReceipt("*** TERMINAL IDLE ***\n08/16/26 11:18:10"), null);
  assert.equal(parseReceipt(""), null);
  assert.equal(parseReceipt(undefined), null);
  const tx = parseReceipt("ST# 1458 OP# 00001234 TE# 63 TR# 00042\nWIDGET 000000000001  S    1.00 H\u0000\u0000\n TOTAL 1.00\n CASH TEND 1.00\n CHANGE DUE 0.00\n TC# 1111 2222\n 08/16/26     09:00:00\n");
  assert.ok(tx);
  assert.equal(tx.raw.includes("\u0000"), false);
  assert.deepEqual([tx.transNum, tx.opNum, tx.termNum, tx.tcNum, tx.time, tx.timeInt], ["42", "1234", "63", "11112222", "09:00:00", 90000]);
});

test("parseRecords counts the fixture correctly", () => {
  assert.equal(day.dayStats.recordCount, 30);
  assert.equal(day.dayStats.transactionCount, 11);
  assert.equal(day.dayStats.cashTransactionCount, 9);
  assert.equal(day.dayStats.refundCount, 1);
  assert.equal(day.dayStats.voidedLineCount, 2);
  assert.equal(day.dayStats.noSaleCount, 0);
  assert.equal(day.dayStats.postVoidCount, 0);
  assert.equal(day.signons.length, 13);
  assert.equal(day.events.length, 6);
});

test("money-order transaction sums multiple CASH TEND lines", () => {
  const tx = byTr("9975");
  assert.ok(tx);
  assert.equal(tx.totalCents, 76600);
  assert.equal(tx.cashTendCents, 77000);
  assert.equal(tx.changeDueCents, 400);
  assert.deepEqual(tx.tenders.map((t) => [t.kind, t.cents]), [["cash", 71000], ["cash", 6000]]);
  assert.deepEqual(tx.items.map((i) => [i.desc, i.code, i.cents]), [
    ["WU MONEY ORD", "068113144910", 76500],
    ["WU MO FEE", "068113144911", 100],
  ]);
  assert.equal(tx.isRefund, false);
});

test("RIA receive (TR# 09973) is a negative-total refund", () => {
  const tx = byTr("9973");
  assert.ok(tx);
  assert.equal(tx.totalCents, -15000);
  assert.equal(tx.subtotalCents, -15000);
  assert.equal(tx.isRefund, true);
  assert.equal(tx.changeDueCents, 15000);
  assert.equal(tx.cashTendCents, 0);
  assert.equal(tx.items[0].cents, -15000);
  assert.equal(tx.time, "11:27:07");
  assert.equal(tx.timeInt, 112707);
});

test("voided VNLLADPAY transaction marks void lines and nets to zero", () => {
  const tx = byTr("9977");
  assert.ok(tx);
  assert.ok(tx.voidedLineCount >= 1);
  assert.equal(tx.voidedLineCount, 2);
  assert.equal(tx.totalCents, 0);
  const voided = tx.items.filter((i) => i.voided);
  assert.equal(voided.length, 2);
  assert.equal(voided[0].cents, -3000);
  assert.equal(tx.items.reduce((s, i) => s + i.cents, 0), 0);
});

test("canceled transaction tolerates missing TOTAL / TC#", () => {
  const tx = byTr("9982");
  assert.ok(tx);
  assert.equal(tx.isCanceled, true);
  assert.equal(tx.totalCents, null);
  assert.equal(tx.subtotalCents, 22000);
  assert.equal(tx.tcNum, null);
  assert.equal(tx.tenders.length, 0);
  assert.equal(tx.isRefund, false);
});

test("sign-on banners produce signons with kind and anonymized name", () => {
  const kinds = new Set(day.signons.map((s) => s.kind));
  assert.deepEqual([...kinds].sort(), ["auto_signoff", "signon"]);
  for (const s of day.signons) {
    assert.equal(s.opNum, "1234");
    assert.equal(s.name, "JANE DOE");
    assert.match(s.time, /^\d\d:\d\d:\d\d$/);
  }
  assert.equal(day.signons[0].time, "11:16:22");
  assert.equal(day.signons[0].kind, "signon");
  assert.equal(day.signons[1].kind, "auto_signoff");
});

test("events classify idle / eod / config", () => {
  assert.deepEqual(day.events.map((e) => e.kind), ["config", "config", "eod", "idle", "idle", "other"]);
  assert.equal(day.events[0].time, "02:11:44");
  assert.equal(day.events[0].timeInt, 21144);
});

test("operators roll up from sign-ons and transactions", () => {
  assert.equal(day.dayStats.operators.length, 1);
  const op = day.dayStats.operators[0];
  assert.equal(op.opNum, "1234");
  assert.equal(op.name, "JANE DOE");
  assert.ok(op.transactionCount > 0);
  assert.equal(op.transactionCount, 11);
  assert.equal(op.firstSeen, "11:16:22");
  assert.equal(op.lastSeen, "12:56:13");
  for (const t of day.transactions) assert.equal(t.opName, "JANE DOE");
});

test("transactions are sorted by timeInt and carry record ids", () => {
  const times = day.transactions.map((t) => t.timeInt);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.equal(day.transactions[0].transNum, "9973");
  assert.equal(day.transactions[0].tcNum, "012345678901234567890");
  assert.equal(day.transactions[0].index, 7);
  assert.equal(day.transactions[0].termNum, "63");
});

test("card / ebt / no-sale / post-void receipts parse tolerantly", () => {
  const text = [
    "ST# 1458 OP# 00000007 TE# 12 TR# 00100",
    "GV MILK      007874200001  F      3.48 N",
    "**  VOIDED ENTRY  **",
    "GV MILK      007874200001  F     3.48 -N",
    "BREAD        007874200002  F      2.00 N",
    "               SUBTOTAL      2.00",
    "                     TOTAL      2.00",
    "                  VISA TEND      1.00",
    "              EBT FOOD TEND      0.50",
    "             GIFT CARD TEND      0.25",
    "                 CHECK TEND      0.25",
    "                CHANGE DUE       0.00",
    "*** NO SALE ***",
    "POST VOID",
    "    TC# 1234 5678 9012",
    "        08/16/26     13:05:09        ",
  ].join("\n");
  const tx = parseReceipt(text);
  assert.ok(tx);
  assert.deepEqual(tx.tenders.map((t) => t.kind), ["card", "ebt", "gift", "check"]);
  assert.equal(tx.cashTendCents, 0);
  assert.equal(tx.totalCents, 200);
  assert.equal(tx.voidedLineCount, 1);
  assert.equal(tx.items.length, 3);
  assert.equal(tx.items[1].voided, true);
  assert.equal(tx.isNoSale, true);
  assert.equal(tx.isPostVoid, true);
  assert.equal(tx.opNum, "7");

  const out = parseRecords([{ transTime: 130509, opNum: 7, transNum: 100, record: text }, null, {}]);
  assert.equal(out.dayStats.noSaleCount, 1);
  assert.equal(out.dayStats.postVoidCount, 1);
  assert.equal(out.dayStats.cashTransactionCount, 0);
  assert.equal(out.dayStats.recordCount, 3);
  assert.equal(out.transactions[0].opName, null);
});
