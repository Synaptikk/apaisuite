// node modules/boblisa/lib/tests/misses.test.mjs
import assert from "node:assert/strict";
import { buildRecord, draftNote, rollupByCashier, missesCsv, missedCents, pairFromRecord, CAUSES, OUTCOMES, VIDEO_REVIEW, CSV_COLUMNS } from "../misses.js";

const pair = {
  key: "2026-08-16|17|4587|98|9391", date: "2026-08-16", category: "manned",
  t1: { time: "12:44:12", reg: 17, type: "Manned", op: "2920", tr: "4587", items: 44, total: 27533, tender: "DEBIT TEND" },
  t2: { time: "12:47:54", reg: 98, type: "Vision", op: "6527", tr: "9391", total: 5279, tender: "DEBIT TEND",
        items: [{ desc: "COORS LIGHT", code: "007199000123", cents: 2467, onT1: false }, { desc: "COORS LIGHT", code: "007199000123", cents: 2467, onT1: false }] },
  gapSec: 222, gapMin: 4, repeat: 0, training: true, vision: true,
  trainingRef: { time: "12:46:10", reg: 98, op: "6527", tr: "9390" }, sameCashier: false, token: "abc123", score: 5,
};

assert.equal(missedCents(pair), 4934, "missed $ = sum of second-transaction items");
const note = draftNote(pair);
assert.equal(note, "08/16/26 cashier op 2920 missed COORS LIGHT $24.67, COORS LIGHT $24.67 from BoB.", note);
assert.equal(draftNote(pair, { cause: "inside_item", name: "Jane D" }), "08/16/26 cashier Jane D op 2920 missed COORS LIGHT $24.67, COORS LIGHT $24.67 from Lisa.");
assert.equal(draftNote(pair, { cause: "other" }), "08/16/26 cashier op 2920 missed COORS LIGHT $24.67, COORS LIGHT $24.67.");

const by = { win: "ses008s.s01458", displayName: "S Smith" };
const now = new Date("2026-09-15T10:00:00Z");
const rec = buildRecord(pair, "1458", { cause: "bottom_of_basket", outcome: "training_receipt", cashierName: "Jane D", note: "Did not check the bottom of the buggy." }, by, null, now);
assert.equal(rec.key, pair.key); assert.equal(rec.storeNbr, "1458"); assert.equal(rec.cashier.op, "2920"); assert.equal(rec.cashier.name, "Jane D");
assert.equal(rec.missedCents, 4934); assert.equal(rec.cause, "bottom_of_basket"); assert.equal(rec.outcome, "training_receipt");
assert.equal(rec.createdAt, "2026-09-15T10:00:00.000Z"); assert.equal(rec.createdBy, by.win); assert.equal(rec.createdByName, "S Smith");
assert.deepEqual(rec.flags, { training: true, vision: true, repeat: false });
assert.equal(rec.t2.items.length, 2); assert.equal(rec.t2.items[0].desc, "COORS LIGHT");

// Unknown cause / outcome fall back; outcome defaults from the training flag.
const d = buildRecord(pair, "1458", { cause: "nope" }, {}, null, now);
assert.equal(d.cause, "other"); assert.equal(d.outcome, "training_receipt"); assert.equal(d.video, "not_reviewed"); assert.equal(d.videoIds, null);
const withVideo = buildRecord(pair, "1458", { video: "confirmed", videoIds: { t1: { transactionId: "abc", cctvUrl: "https://x/abc", receiptUrl: "https://x/r/abc", byTime: false }, t2: null } }, by, null, now);
assert.equal(withVideo.video, "confirmed"); assert.equal(withVideo.videoIds.t1.transactionId, "abc");
assert.equal(buildRecord(pair, "1458", { video: "bogus" }, by, withVideo, later0()).videoIds.t1.cctvUrl, "https://x/abc", "video links survive an edit that omits them");
function later0() { return new Date("2026-09-16T09:00:00Z"); }
// pairFromRecord gives buildRecord and draftNote enough to run from a stored record alone.
const pfr = pairFromRecord(rec);
assert.equal(pfr.key, rec.key); assert.equal(pfr.training, true); assert.equal(pfr.trainingRef.tr, "9390");
assert.equal(draftNote(pfr), draftNote(pair));
assert.equal(buildRecord({ ...pair, training: false }, "1458", {}, {}, null, now).outcome, "door_paid");

// Editing keeps who created it and when; the name survives when the edit omits it.
const later = new Date("2026-09-16T10:00:00Z");
const edit = buildRecord(pair, "1458", { cause: "skipped_scan", note: "changed" }, { win: "other.w" }, rec, later);
assert.equal(edit.createdAt, rec.createdAt); assert.equal(edit.createdBy, by.win); assert.equal(edit.updatedBy, "other.w"); assert.equal(edit.updatedAt, "2026-09-16T10:00:00.000Z");
assert.equal(edit.cashier.name, "Jane D"); assert.equal(edit.cause, "skipped_scan");

// Rollup by cashier op.
const pair2 = { ...pair, key: "2026-08-20|17|100|31|200", date: "2026-08-20", training: false, trainingRef: null, t2: { ...pair.t2, reg: 31, type: "Self-checkout", items: [{ desc: "DOG FOOD", code: "1", cents: 3100 }] } };
const pair3 = { ...pair, key: "2026-08-21|12|300|31|400", date: "2026-08-21", t1: { ...pair.t1, reg: 12, op: "777" } };
const records = { [rec.key]: rec, [pair2.key]: buildRecord(pair2, "1458", { cause: "inside_item" }, by, null, now), [pair3.key]: buildRecord(pair3, "1458", {}, by, null, now) };
const roll = rollupByCashier(records);
assert.equal(roll.length, 2); assert.equal(roll[0].op, "2920"); assert.equal(roll[0].count, 2); assert.equal(roll[0].cents, 4934 + 3100);
assert.equal(roll[0].first, "2026-08-16"); assert.equal(roll[0].last, "2026-08-20"); assert.equal(roll[0].name, "Jane D");
assert.deepEqual(roll[0].causes, { bottom_of_basket: 1, inside_item: 1 }); assert.deepEqual(roll[0].registers, [17]);
assert.equal(roll[1].op, "777");

// CSV: header + one line per record, sorted by date, quotes escaped.
const csv = missesCsv({ ...records, x: { ...rec, key: "x", note: 'He said "no"' } });
const lines = csv.split("\r\n");
assert.equal(lines[0], CSV_COLUMNS.map((c) => `"${c}"`).join(","));
assert.equal(lines.length, 5);
assert.ok(lines[1].includes('"2026-08-16","12:44:12","17 Manned","2920","Jane D","44","275.33","12:47:54","98 Vision","4","COORS LIGHT 24.67; COORS LIGHT 24.67","49.34","yes","yes"'), lines[1]);
assert.ok(lines[1].includes(`"${CAUSES.bottom_of_basket}","${OUTCOMES.training_receipt}","${VIDEO_REVIEW.not_reviewed}","",`), lines[1]);
assert.ok(missesCsv([withVideo]).includes(`"${VIDEO_REVIEW.confirmed}","https://x/abc"`));
assert.ok(csv.includes('"He said ""no"""'));
console.log("boblisa misses.test: ok");

// Cashier ledger: manned records only, count + second-transaction dollars per op,
// events in date order, names remembered from the prior ledger.
import { buildCashierLedger, ledgerRows, cashiersCsv, CASHIER_CSV_COLUMNS } from "../misses.js";
const unmannedPair = { ...pair, key: "2026-08-22|31|500|17|600", date: "2026-08-22", category: "unmanned", t1: { ...pair.t1, reg: 31, type: "Self-checkout", op: "31" } };
const ledgerRecords = { ...records, [unmannedPair.key]: buildRecord(unmannedPair, "1458", {}, by, null, now) };
const ledger = buildCashierLedger(ledgerRecords, {}, now);
assert.deepEqual(Object.keys(ledger).sort(), ["2920", "777"], "self-checkout first transactions charge nobody");
assert.equal(ledger["2920"].count, 2); assert.equal(ledger["2920"].cents, 4934 + 3100); assert.equal(ledger["2920"].name, "Jane D");
assert.deepEqual(ledger["2920"].events.map((e) => e.date), ["2026-08-16", "2026-08-20"]);
assert.equal(ledger["2920"].events[0].items, "COORS LIGHT $24.67; COORS LIGHT $24.67"); assert.equal(ledger["2920"].events[0].training, true);
assert.deepEqual(ledger["2920"].registers, [17]); assert.equal(ledger["2920"].updatedAt, now.toISOString());
assert.equal(ledger["777"].name, "", "no name on the record and none remembered");
const remembered = buildCashierLedger(ledgerRecords, { 777: { name: "Sam P" } }, now);
assert.equal(remembered["777"].name, "Sam P", "a name typed once is kept for the op");
assert.equal(buildCashierLedger({}, {}, now)["2920"], undefined, "removing every record empties the ledger");
assert.deepEqual(ledgerRows(ledger).map((c) => c.op), ["2920", "777"]);
const lcsv = cashiersCsv(ledger).split("\r\n");
assert.equal(lcsv[0], CASHIER_CSV_COLUMNS.map((c) => `"${c}"`).join(","));
assert.equal(lcsv.length, 3);
assert.ok(lcsv[1].startsWith('"2920","Jane D","","2","80.34","2026-08-16","2026-08-20","17","1x Bottom of basket not checked; 1x Item inside another item or bag","2026-08-16 reg 17 TR 4587 $49.34 (COORS LIGHT $24.67; COORS LIGHT $24.67) | 2026-08-20'), lcsv[1]);
console.log("boblisa cashier ledger test: ok");

// Money-service lines (DEBIT LOAD, bill pay) are never the missed item: the
// record's missed $, the note, the ledger and the CSV count merchandise only.
import { missedItems } from "../misses.js";
const mixedPair = { ...pair, key: "2026-08-23|17|700|31|800", date: "2026-08-23", training: false, trainingRef: null,
  t2: { ...pair.t2, reg: 31, type: "Self-checkout", total: 10784, items: [{ desc: "MC BLACK", code: "9", cents: 784 }, { desc: "DEBIT LOAD", code: "8", cents: 10000, service: true }] } };
assert.deepEqual(missedItems(mixedPair).map((i) => i.desc), ["MC BLACK"]);
const mixedRec = buildRecord(mixedPair, "1458", { cashierName: "Jane D" }, by, null, now);
assert.equal(mixedRec.missedCents, 784, "DEBIT LOAD is not merchandise");
assert.equal(mixedRec.t2.items[1].service, true, "the service flag survives into the record");
assert.ok(draftNote(mixedPair).includes("missed MC BLACK $7.84 from BoB.") && !draftNote(mixedPair).includes("DEBIT LOAD"), draftNote(mixedPair));
const mixedLedger = buildCashierLedger({ [mixedRec.key]: mixedRec }, {}, now);
assert.equal(mixedLedger["2920"].cents, 784); assert.equal(mixedLedger["2920"].events[0].items, "MC BLACK $7.84");
assert.ok(missesCsv([mixedRec]).split("\r\n")[1].includes('"MC BLACK 7.84","7.84"'));
console.log("boblisa money-service rule test: ok");

// APPRISS employee block → operator name + WIN (lib/appriss_people.js).
import { parseEmployee, journalEventUrl } from "../appriss_people.js";
const ev = { data: { storecashierno: "5638", x_employeeid: "233359383", employee: { employeeid: "233359383", cashierno: "001458005638", operatorid: "M0C19P6", firstname: "MALEIGHA", lastname: "CLOWDUS", operatorrole: "FRONT END TA SERV", x_storecashierno: "5638" } } };
assert.deepEqual(parseEmployee(ev), { op: "5638", first: "MALEIGHA", last: "CLOWDUS", name: "MALEIGHA CLOWDUS", win: "233359383", userId: "M0C19P6", role: "FRONT END TA SERV" });
assert.equal(parseEmployee({ data: { storecashierno: "1" } }), null);
assert.ok(journalEventUrl("2608160458742638422").endsWith("/platform/viewer/store/api/v1/journal/event/2608160458742638422?connectionName=pos-data"));
const withWin = cashiersCsv({ 2920: { ...ledger["2920"], win: "233359383" } }).split("\r\n")[1];
assert.ok(withWin.startsWith('"2920","Jane D","233359383","2"'), withWin);
console.log("boblisa appriss people test: ok");
