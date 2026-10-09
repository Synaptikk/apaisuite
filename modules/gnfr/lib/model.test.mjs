// node --test modules/gnfr/lib/model.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  sapDay, compactCart, compactApprovals, lineStage, cartState, isLate, isStale, parseApprovalLog, areaOf, nameKey,
  flatLines, regulars, duplicates, people, trackingUrl, personOf,
} from "./model.js";

const T = (day, h = 12) => Date.parse(`${day}T${String(h).padStart(2, "0")}:00:00Z`);
const line = (o) => ({ pr: "1", item: "10", po: "", art: "100", desc: "PAPER CENTERPULL TOWEL 1=6", status: "Delivered", qty: 1, uom: "EA", price: 10, net: 10, type: "SUPP", eta: "", shipDay: "", arrDay: "", trk: "", carrier: "", delivered: true, del: false, ...o });
const cart = (id, win, day, lines) => ({ id, win, at: T(day), total: lines.reduce((s, l) => s + l.net, 0), lines });

test("SAP date fields", () => {
  assert.equal(sapDay("/Date(1792108800000)/"), "2026-10-16");
  assert.equal(sapDay(null), "");
  assert.equal(sapDay("/Date(0)/"), "");
});

test("compactCart reads a real OT_RESULTS shape", () => {
  const c = compactCart({
    cartID: "014581005973487", userID: "224655347", cartName: "01458_224655347_20261008", price: "555.100",
    submitTimeStamp: "1791450458000", cartComments: "|Cody Howard (10/01/2026 at 09:41:13 CST) - Ap and claims supplies",
    to_Details: { results: [{ purReq: "5001206988", itemNo: "00020", articleNumber: "100603801", articleDescr: "LABEL SFS PUT OGP 3X3 ORG BORDER 1=36", itemStatus: "Submitted", quantity: "10", price: "55.510", netPrice: "555.10", priceUom: "EA", itemType: "SUPP", deliveryDate: "/Date(1792108800000)/", delivered: false }] },
  });
  assert.equal(c.total, 555.1);
  assert.equal(c.lines[0].qty, 10);
  assert.equal(c.lines[0].eta, "2026-10-16");
  assert.equal(c.comment, "Cody Howard (10/01/2026 at 09:41:13 CST) - Ap and claims supplies");
  assert.equal(areaOf(c.lines[0]), "Digital / OPD");
});

test("old open POs are 'no delivery record', not late", () => {
  const old = line({ status: "PO Created", delivered: false, po: "8", eta: "2026-06-01" });
  assert.equal(isLate(old, "2026-10-08"), false);
  assert.equal(isStale(old, "2026-10-08"), true);
  assert.equal(cartState(cart("c", "w", "2026-05-25", [line(), old]), "2026-10-08").stage, "stale");
});

test("approval comment log", () => {
  const log = parseApprovalLog("Tom Scott-NOV 01 2025 at 07:59:57 EST-Rejected-Duplicate material | Tom Scott-NOV 01 2025 at 07:56:14 EST-Approved-Cases needed");
  assert.deepEqual(log.map((e) => [e.who, e.action, e.note]), [["Tom Scott", "Approved", "Cases needed"], ["Tom Scott", "Rejected", "Duplicate material"]]);
  assert.equal(parseApprovalLog("NMP002B - 20260525 205834 - R - Anthony Travis-MAY 25 2026 at 14:19:56 EST-Approved-old IMZ cart is broken")[0].who, "Anthony Travis");
});

test("stages, lateness and cart roll-up", () => {
  assert.equal(lineStage(line({ status: "Pending Approval", delivered: false })), "approval");
  assert.equal(lineStage(line({ status: "PO Created", delivered: false, po: "8015" })), "ordered");
  assert.equal(lineStage(line({ status: "Rejected", delivered: false })), "rejected");
  const ordered = line({ status: "PO Created", delivered: false, po: "8", eta: "2026-10-01" });
  assert.equal(isLate(ordered, "2026-10-08"), true);
  assert.equal(isLate(line(), "2026-10-08"), false);
  const st = cartState(cart("c", "w", "2026-10-01", [line(), ordered, line({ status: "Rejected", delivered: false })]), "2026-10-08");
  assert.deepEqual([st.stage, st.delivered, st.open, st.rejected, st.late], ["ordered", 1, 1, 1, 1]);
  assert.equal(cartState(cart("c", "w", "2026-10-01", [line(), line({ status: "Pending Approval", delivered: false })]), "2026-10-08").stage, "approval");
});

test("areas", () => {
  assert.equal(areaOf({ desc: "BAKERY DONUT BOX 6 COUNT" }), "Bakery & Deli");
  assert.equal(areaOf({ desc: "ACC TBC TIRE VALVE STEM 413" }), "Auto Care");
  assert.equal(areaOf({ desc: "TENN T500ET600E 44IN REAR SQUEEGEE BLADE" }), "Cleaning & Janitorial");
  assert.equal(areaOf({ desc: "SOMETHING ODD", type: "FIXS" }), "Fixtures & Equipment");
  assert.equal(areaOf({ desc: "SOMETHING ODD", type: "SUPP" }), "Other supplies");
});

test("regulars: overdue vs on rhythm vs lapsed", () => {
  const weekly = ["2026-09-01", "2026-09-08", "2026-09-15", "2026-09-22"].map((d, i) => cart(`a${i}`, "w1", d, [line({ art: "1" })]));
  const steady = ["2026-09-10", "2026-09-17", "2026-09-24", "2026-10-01"].map((d, i) => cart(`b${i}`, "w2", d, [line({ art: "2" })]));
  const old = ["2026-01-01", "2026-01-08", "2026-01-15", "2026-01-22"].map((d, i) => cart(`c${i}`, "w3", d, [line({ art: "3" })]));
  const thrice = ["2026-09-01", "2026-09-10", "2026-09-20"].map((d, i) => cart(`d${i}`, "w4", d, [line({ art: "4" })]));
  const lines = flatLines([...weekly, ...steady, ...old, ...thrice], "2026-10-08");
  const r = Object.fromEntries(regulars(lines, "2026-10-08").map((x) => [x.art, x]));
  assert.equal(r["1"].state, "overdue");
  assert.equal(r["1"].gap, 7);
  assert.equal(r["2"].state, "due");
  assert.equal(r["3"].state, "lapsed");
  assert.equal(r["4"], undefined, "three orders is not yet a rhythm");
});

test("regulars: orders within 3 days are one occasion", () => {
  const cs = ["2026-08-18", "2026-09-01", "2026-09-02", "2026-09-15", "2026-09-29"].map((d, i) => cart(`x${i}`, "w", d, [line({ art: "9", qty: 2 })]));
  const [r] = regulars(flatLines(cs, "2026-10-01"), "2026-10-01");
  assert.equal(r.occasions, 4);
  assert.equal(r.gap, 14);
});

test("duplicates need same person or same quantity", () => {
  const cs = [
    cart("1", "w1", "2026-10-06", [line({ art: "5", qty: 2 })]),
    cart("2", "w2", "2026-10-07", [line({ art: "5", qty: 2 })]),   // same qty → flagged
    cart("3", "w3", "2026-10-07", [line({ art: "6", qty: 1 })]),
    cart("4", "w4", "2026-10-07", [line({ art: "6", qty: 4 })]),   // other dept, other qty → not flagged
  ];
  const d = duplicates(flatLines(cs, "2026-10-08"));
  assert.equal(d.length, 1);
  assert.equal(d[0].art, "5");
});

test("people roll-up ignores rejected lines", () => {
  const cs = [cart("1", "w1", "2026-10-06", [line({ net: 5 }), line({ net: 50, status: "Rejected", delivered: false })])];
  const [p] = people(cs, flatLines(cs, "2026-10-08"));
  assert.equal(p.spend, 5);
  assert.equal(p.carts, 1);
});

test("people: name + job from user search and schedule roster", () => {
  const data = { users: { 1: { name: "CHRISTIAN YOUNG" } }, roster: { map: { [nameKey("Christian Young")]: "Digital TA" } }, approvals: {} };
  assert.deepEqual([personOf("1", data).name, personOf("1", data).job], ["Christian Young", "Digital TA"]);
  const approver = { users: { 2: { name: "TOM SCOTT" } }, roster: { map: {} }, approvals: { p: compactApprovals([{ approver: "2", jobTitle: "Store Manager Supercenter" }]) } };
  assert.equal(personOf("2", approver).job, "Store Manager Supercenter");
  assert.equal(personOf("3", { users: {} }).name, "WIN 3");
});

test("tracking links skip vendor phone numbers", () => {
  assert.equal(trackingUrl({ trk: "(888) 233-5267", carrier: "VENTK" }), null);
  assert.match(trackingUrl({ trk: "123456789012", carrier: "FXFE" }), /fedex/);
  assert.match(trackingUrl({ trk: "1Z999AA10123456784", carrier: "" }), /ups/);
});
