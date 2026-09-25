// node modules/boblisa/lib/tests/pairs.test.mjs
import assert from "node:assert/strict";
import { analyzeDay, compactRecords, DEFAULT_OPTS, paysForTraining } from "../pairs.js";
import { registerType } from "../registers.js";

const TOKEN_A = "3DFBDA6D37D897579380E51A04208603818105780416";
const TOKEN_B = "F9DCC6CE6C5CF624DA4C2620CA458295450921704416";

function receipt({ reg, op, tr, items, total, tender = "DEBIT TEND", token = null, training = false, stamp = "09/03/26     14:32:09" }) {
  const lines = [`ST# 1458 OP# ${String(op).padStart(8, "0")} TE# ${reg} TR# ${String(tr).padStart(5, "0")}`, ""];
  if (training) lines.push("****  INVALID RECEIPT - TRAINING  ****");
  for (const [desc, code, price, flag = "S"] of items) lines.push(`${desc.padEnd(12)} ${code}  ${flag}     ${price} AD`);
  lines.push(`               SUBTOTAL        ${total}`);
  if (token) lines.push(`TOKEN: ${token}`);
  lines.push(`                     TOTAL    ${total} `, `                ${tender}     ${total}`, `                CHANGE DUE       0.00`, `        ${stamp}        `);
  return lines.join("\n");
}
const rec = (transTime, o) => ({ transTime, opNum: o.op, transNum: o.tr, termNum: o.reg, record: receipt(o) });

const records = [
  // big manned order, paid by card A
  rec(143209, { reg: 25, op: 155, tr: 2419, token: TOKEN_A, total: "399.45", items: [["MILK", "007874201234", "3.48"], ["CHRM 12XXL", "003077216563", "23.83"], ["PED ADULT", "002310014347", "25.97"], ["EGGS 12CT", "007874200001", "1.67"], ["BREAD", "007874200002", "0.88"]] }),
  // same card, one Charmin at self-checkout 3.5 min later — a second unit missed (repeat UPC)
  rec(143544, { reg: 31, op: 9031, tr: 2381, token: TOKEN_A, total: "25.50", items: [["CHRM 12XXL", "003077216563", "23.83"]] }),
  // door-host training receipt for the same item
  rec(143618, { reg: 98, op: 9025, tr: 9670, training: true, total: "0.00", items: [["CHRM 12XXL", "003077216563", "23.83"]] }),
  // card B: two small sales at self-checkout, $2.48 — under the $3 floor
  rec(120000, { reg: 30, op: 9030, tr: 700, token: TOKEN_B, total: "18.00", items: [["SODA", "004900000764", "18.00"]] }),
  rec(120300, { reg: 30, op: 9030, tr: 702, token: TOKEN_B, total: "2.48", items: [["GUM", "002200012345", "2.48"]] }),
  // card B again 40 minutes later — outside the window
  rec(124500, { reg: 30, op: 9030, tr: 760, token: TOKEN_B, total: "9.99", items: [["CANDY", "002200099999", "9.99"]] }),
  // cash customer: no token; training receipt names their item, paid at reg 92 (Money Center) for cash
  rec(160000, { reg: 94, op: 9025, tr: 925, training: true, total: "0.00", items: [["DOG FOOD", "002310099999", "31.00"]] }),
  rec(160130, { reg: 92, op: 353, tr: 7609, tender: "CASH TEND", total: "33.00", items: [["DOG FOOD", "002310099999", "31.00"]] }),
  // a puppy training pad is NOT a training receipt
  rec(170000, { reg: 13, op: 4150, tr: 3873, token: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", total: "9.92", items: [["TRAINING PAD", "068113100001", "9.92"]] }),
];

const tx = compactRecords(records);
assert.equal(tx.length, 9, "every record with a header becomes a transaction");
assert.equal(tx.filter((x) => x.isTraining).length, 2, "only the two real training-mode receipts are flagged");
assert.equal(tx.find((x) => x.tr === "2419").token, TOKEN_A, "token extracted from the receipt");

const day = analyzeDay(records, "2026-09-03");
assert.equal(day.stats.sales, 7, "training receipts do not count as sales");
assert.equal(day.pairs.length, 1, "one token pair survives the window, item and $3 rules");
const p = day.pairs[0];
assert.equal(p.category, "manned");
assert.equal(p.t1.reg, 25); assert.equal(p.t2.reg, 31); assert.equal(p.t2.type, "Self-checkout");
assert.equal(p.gapMin, 4);
assert.equal(p.repeat, 1, "a UPC repeated from T1 stays a hit");
assert.equal(p.training, true, "matched to the door-host training receipt by UPC");
assert.equal(p.trainingRef.reg, 98);
assert.equal(p.t2.items[0].onT1, true);
assert.equal(p.vision, false);

assert.equal(day.trainings.length, 2);
const cashCase = day.trainings.find((t) => t.reg === 94);
assert.equal(cashCase.paid.length, 1, "training receipt traced to the cash sale by UPC");
assert.equal(cashCase.paid[0].reg, 92); assert.equal(cashCase.paid[0].hasToken, false); assert.equal(cashCase.paid[0].type, "Money Center");

// Paying for a training receipt means the sale's lines ARE the receipt's lines, not one shared UPC.
const longTrain = { items: [["PENS", "1", 447], ["LASHES", "2", 897], ["SPRAY", "3", 1098], ["BRUSH", "4", 800]].map(([desc, code, cents]) => ({ desc, code, cents })) };
assert.equal(paysForTraining({ items: [{ desc: "PENS", code: "1", cents: 447 }, { desc: "SODA", code: "9", cents: 199 }] }, longTrain), false, "a basket with other items is a different customer");
assert.equal(paysForTraining({ items: [{ desc: "PENS", code: "1", cents: 447 }] }, longTrain), false, "one line of four, 14% of the dollars, is not the payment");
assert.equal(paysForTraining({ items: [{ desc: "SPRAY", code: "3", cents: 1098 }, { desc: "LASHES", code: "2", cents: 897 }] }, longTrain), true, "two of four lines pays");
assert.equal(paysForTraining({ items: [{ desc: "SPRAY", code: "3", cents: 1098 }, { desc: "BRUSH", code: "4", cents: 800 }, { desc: "DEBIT LOAD", code: "s", cents: 3500, service: true }] }, longTrain), true, "money-service lines on the sale are ignored");
assert.equal(paysForTraining({ items: [] }, longTrain), false);
assert.equal(paysForTraining({ items: [{ desc: "PENS", code: "1", cents: 447 }] }, longTrain, { ...DEFAULT_OPTS, trainingMinCoverage: 0.2 }), true, "coverage threshold is an option");

// Options are honoured
const loose = analyzeDay(records, "2026-09-03", { ...DEFAULT_OPTS, minT2Cents: 0 });
assert.equal(loose.pairs.length, 2, "dropping the $3 floor admits the gum");
assert.equal(loose.pairs.find((x) => x.t2.tr === "702").category, "unmanned");

// Same register, under 2 minutes apart: one customer ringing twice, not a miss.
const TOKEN_C = "C0C0C0C0C0C0C0C0C0C0C0C0C0C0C0C0C0C0C0C0C0C0";
const sameReg = [
  rec(101000, { reg: 12, op: 500, tr: 100, token: TOKEN_C, total: "40.00", items: [["MILK", "007874201234", "3.48"], ["CHRM 12XXL", "003077216563", "23.83"]] }),
  rec(101130, { reg: 12, op: 500, tr: 101, token: TOKEN_C, total: "12.00", items: [["SODA", "004900000764", "12.00"]] }),
  rec(103000, { reg: 12, op: 500, tr: 110, token: TOKEN_C, total: "40.00", items: [["MILK", "007874201234", "3.48"]] }),
  rec(103300, { reg: 12, op: 500, tr: 111, token: TOKEN_C, total: "12.00", items: [["SODA", "004900000764", "12.00"]] }),
];
const sr = analyzeDay(sameReg, "2026-09-03");
assert.equal(sr.pairs.length, 1, "90 s apart on the same register is skipped; 3 min apart still pairs");
assert.equal(sr.pairs[0].t2.tr, "111");
assert.equal(analyzeDay(sameReg, "2026-09-03", { ...DEFAULT_OPTS, sameRegisterMinGapSec: 0 }).pairs.length, 2, "rule is an option");

// Money services are not merchandise: a second sale that is only a bill pay,
// card load or gift card never pairs; on a mixed receipt only the goods count.
const TOKEN_D = "D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0";
const big = (t, tr) => rec(t, { reg: 14, op: 600, tr, token: TOKEN_D, total: "120.00", items: [["MILK", "007874201234", "3.48"], ["CHRM 12XXL", "003077216563", "23.83"], ["PED ADULT", "002310014347", "25.97"]] });
const services = [
  big(90000, 200), rec(90400, { reg: 63, op: 1234, tr: 201, token: TOKEN_D, total: "35.00", items: [["DEBIT LOAD", "060538802945", "35.00", "K"]] }),
  big(100000, 210), rec(100400, { reg: 92, op: 353, tr: 211, token: TOKEN_D, total: "35.00", items: [["ARBYS DEBIT", "079936123456", "35.00"]] }),
  big(110000, 220), rec(110400, { reg: 30, op: 9030, tr: 221, token: TOKEN_D, total: "7.84", items: [["VISA", "076750123456", "7.84"]] }),
  big(120000, 230), rec(120400, { reg: 92, op: 353, tr: 231, token: TOKEN_D, total: "53.00", items: [["VNLLADPAYAMT", "060538819035", "50.00"], ["VNLLADPAYFEE", "060538819036", "3.00"]] }),
  // mixed: a $265 card load plus one $8.97 item — the item still pairs, valued at its own price
  big(130000, 240), rec(130400, { reg: 63, op: 1234, tr: 241, token: TOKEN_D, total: "273.97", items: [["DEBIT LOAD", "060538802945", "265.00", "K"], ["DOG TOY", "002310055555", "8.97"]] }),
  // mixed but the goods are under the $3 floor
  big(140000, 250), rec(140400, { reg: 63, op: 1234, tr: 251, token: TOKEN_D, total: "267.48", items: [["DEBIT LOAD", "060538802945", "265.00", "K"], ["GUM", "002200012345", "2.48"]] }),
];
const svcTx = compactRecords(services);
assert.equal(svcTx.filter((x) => x.isService).length, 4, "load, gift cards and bill pay are service-only transactions");
assert.equal(svcTx.find((x) => x.tr === "241").isService, false, "a mixed receipt is still a sale");
const sv = analyzeDay(services, "2026-09-03");
assert.deepEqual(sv.pairs.map((p) => p.t2.tr), ["241"], "only the mixed receipt with a real item pairs");
assert.equal(sv.pairs[0].t2.items.find((i) => i.service).desc, "DEBIT LOAD", "service lines are marked for the view");
assert.equal(analyzeDay(services, "2026-09-03", { ...DEFAULT_OPTS, skipServices: false }).pairs.length, 6, "rule is an option: without it every money-service receipt pairs");

assert.equal(registerType(9), "Manned"); assert.equal(registerType(25), "Manned"); assert.equal(registerType(26), "Other");
assert.equal(registerType(98), "Vision"); assert.equal(registerType(94), "Money Center"); assert.equal(registerType(95), "Automotive"); assert.equal(registerType(82), "Pickup"); assert.equal(registerType(62), "Money Center");

console.log("boblisa pairs.test: ok");

// video.js — time-window CCTV link
const { videoUrl } = await import("../video.js");
const vu = videoUrl("1458", 25, "2026-09-07", "14:07:58");
assert.ok(vu.includes("/video/react#/cameras?"), "viewer route");
assert.ok(vu.includes("storeNo=1458") && vu.includes("posNo=25"), "store + register");
assert.ok(vu.includes("startTime=2026-09-07T14%3A05%3A58") && vu.includes("endTime=2026-09-07T14%3A08%3A13"), "window: 120 s before the receipt time to 15 s after");
assert.equal(videoUrl("1458", 25, "2026-09-07", "bad"), null);
assert.equal(videoUrl("1458", 25, "2026-09-07", "00:01:00").includes("2026-09-06T23%3A59%3A00"), true, "crosses midnight backwards");
console.log("boblisa video.test: ok");

// Operator names come from the day's sign-on banners, not from receipts.
const signon = { transTime: 60000, opNum: 155, record: "****** 155    JANE DOE  ******\n   SIGN ON   06:00:00" };
const named = analyzeDay([signon, ...records], "2026-09-03");
assert.deepEqual(named.operators, { 155: "JANE DOE" });
assert.deepEqual(analyzeDay(records, "2026-09-03").operators, {}, "no banner, no names");
console.log("boblisa operators test: ok");
