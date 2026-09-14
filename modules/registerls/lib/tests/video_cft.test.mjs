// node --test modules/registerls/lib/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { decodeOpenDrawer, buildOpenDrawerBody, tradingDay, linkVideo, cctvUrl } from "../open_drawer.js";
import { decodeCft, buildFilteredBody, normalizeRow, cftFor, dsrColumnOrder } from "../cft.js";
import { buildEvidence, cftMatches } from "../evidence.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n) => JSON.parse(readFileSync(join(here, "fixtures", n), "utf8"));
const tx = (id, extra = {}) => ({ transNum: id, time: "13:05:01", totalCents: 81876, cashTendCents: 82000, changeDueCents: 124, ...extra });

test("open drawer: rows decode with TR#, end time and APPRISS transaction id → viewer links", () => {
  const { rows, totalRows } = decodeOpenDrawer(fx("open_drawer.json"));
  assert.equal(totalRows, 6); assert.equal(rows.length, 6);
  const r = rows.find((x) => x.transNum === "335");
  assert.equal(r.time, "13:05:01"); assert.equal(r.date, "2026-08-27"); assert.equal(r.register, "63");
  assert.equal(r.cashTendCents, 82000); assert.equal(r.changeCents, 124);
  assert.match(r.transactionId, /^\d{15,}$/);
  assert.equal(r.cctvUrl, cctvUrl(r.transactionId));
  assert.match(r.receiptUrl, /viewer\?hidechrome=true#\/store\/ardm\/event\/\d+$/);
});

test("open drawer: search body carries the work item's store / register / trading day", () => {
  const b = buildOpenDrawerBody("1458", "63", "2026-08-27", { startIndex: 20 });
  assert.equal(b.parameters.tradingday, "8/27/2026 12:00:00 AM");
  assert.equal(tradingDay("2026-12-03"), "12/3/2026 12:00:00 AM");
  assert.equal(b.startIndex, 20); assert.equal(b.parameters.posno, "63");
});

test("linkVideo: by TR# first, by end time within 90 s when the TR# is missing", () => {
  const { rows } = decodeOpenDrawer(fx("open_drawer.json"));
  const list = [{ transNum: "335", time: "13:05:01" }, { transNum: null, time: "13:05:30" }, { transNum: "9999", time: "01:00:00" }];
  linkVideo(list, rows);
  assert.ok(list[0].video?.cctvUrl.includes(rows.find((r) => r.transNum === "335").transactionId));
  assert.equal(list[0].video.byTime, false);
  assert.equal(list[1].video?.transactionId, list[0].video.transactionId); assert.equal(list[1].video.byTime, true);
  assert.equal(list[2].video, undefined);
});

test("evidence: cash matches and investigation candidates carry the video link; the drawer table is offered", () => {
  const drawer = { rows: decodeOpenDrawer(fx("open_drawer.json")).rows, explorerUrl: "x" };
  const item = { id: "1", register: "63", date: "2026-08-27", amountCents: -82000, amountAbsCents: 82000, sourceAppId: "mel" };
  const ev = buildEvidence({ item, ej: { transactions: [tx("335")], events: [] }, drawer });
  assert.ok(ev.cashMatches[0].video?.cctvUrl);
  assert.ok(ev.investigation.candidates[0].video?.receiptUrl);
  assert.ok(ev.lookAt.includes("drawer"));
  assert.ok(ev.drawer.rows.find((r) => r.transNum === "335").near);
});

test("cft: report rows decode from the DSR with business/input dates, keyed time and amount", () => {
  const order = dsrColumnOrder(fx("cft_dsr.json")).map((c) => c.Name);
  assert.equal(order[0], "CFT_Data.BUSINESS_DATE"); assert.equal(order.at(-2), "Sum(CFT_Data.CFT_AMOUNT)"); assert.equal(order.at(-1), "Sum(CFT_Data.ACCOUNT_NBR)");
  const { rows } = decodeCft(fx("cft_dsr.json"));
  assert.ok(rows.length >= 5);
  assert.equal(rows[0].store, "1458"); assert.equal(rows[0].accountNbr, "2046"); assert.equal(rows[0].amountCents, -24540); assert.equal(rows[0].inputTime, "03:30:15"); assert.equal(rows[0].cftId, "333334");
  for (const r of rows) { assert.match(r.businessDate, /^\d{4}-\d{2}-\d{2}$/); assert.ok(Number.isInteger(r.amountCents)); }
  const sys = rows.find((r) => r.system);
  assert.ok(sys && sys.amountCents < 0, "system-generated recycler postings are negative and flagged");
  assert.ok(rows.some((r) => /^\d{2}:\d{2}:\d{2}$/.test(r.inputTime)));
  assert.ok(rows.some((r) => r.keyedLate), "the fixture has a CFT keyed the day after its business date");
});

test("cft: replay body keeps the report's Exclude Resets slicer and adds store + business-date floor", () => {
  const body = JSON.parse(buildFilteredBody(JSON.stringify(fx("cft_body.json")), "1458", "2026-07-15"));
  const cmd = body.queries[0].Query.Commands[0].SemanticQueryDataShapeCommand;
  const w = JSON.stringify(cmd.Query.Where);
  assert.ok(w.includes("Exclude Resets")); assert.ok(w.includes('"Property":"STORE"')); assert.ok(w.includes("1458L")); assert.ok(w.includes("datetime'2026-07-15T00:00:00'"));
  assert.equal(cmd.Binding.DataReduction.Primary.Window.Count, 5000);
  assert.equal(body.queries[0].CacheKey, undefined);
});

test("cft: a transfer near the amount is listed for reference, never offered as a cause or a safe disposition", () => {
  const rows = [
    normalizeRow({ "CFT_Data.BUSINESS_DATE": Date.UTC(2026, 8, 12), "CFT_Data.INPUT_DATE": Date.UTC(2026, 8, 13), "CFT_Data.INPUT_TIME": "1899-12-30T09:15:00", "CountNonNull(CFT_Data.CFT_ID)": 333334, "Sum(CFT_Data.CFT_AMOUNT)": 50, "CFT_Data.RECIPIENT_NAME": "A. Person", "CFT_Data.CFT_REASON": "Customer satisfaction", "CFT_Data.ACCOUNT_DESC": "CUSTOMER SATISFACTION", "Sum(CFT_Data.ACCOUNT_NBR)": 1061, "Sum(CFT_Data.STORE)": 1458 }),
    normalizeRow({ "CFT_Data.BUSINESS_DATE": Date.UTC(2026, 8, 12), "CFT_Data.INPUT_DATE": Date.UTC(2026, 8, 13), "CFT_Data.INPUT_TIME": "1899-12-30T03:30:00", "CountNonNull(CFT_Data.CFT_ID)": 333335, "Sum(CFT_Data.CFT_AMOUNT)": -50, "CFT_Data.RECIPIENT_NAME": "System Generated", "CFT_Data.CFT_REASON": "System Generated", "CFT_Data.ACCOUNT_DESC": "System Generated", "Sum(CFT_Data.ACCOUNT_NBR)": 2046, "Sum(CFT_Data.STORE)": 1458 }),
    normalizeRow({ "CFT_Data.BUSINESS_DATE": Date.UTC(2026, 7, 1), "CFT_Data.INPUT_DATE": Date.UTC(2026, 7, 1), "CFT_Data.INPUT_TIME": "1899-12-30T10:00:00", "CountNonNull(CFT_Data.CFT_ID)": 1, "Sum(CFT_Data.CFT_AMOUNT)": 50, "CFT_Data.RECIPIENT_NAME": "Old", "CFT_Data.CFT_REASON": "x", "CFT_Data.ACCOUNT_DESC": "y", "Sum(CFT_Data.ACCOUNT_NBR)": 1, "Sum(CFT_Data.STORE)": 1458 }),
  ];
  assert.equal(rows[0].keyedLate, true); assert.equal(rows[0].inputTime, "09:15:00"); assert.equal(rows[1].system, true);
  const item = { id: "2", register: "15", date: "2026-09-12", amountCents: -5000, amountAbsCents: 5000, sourceAppId: "overshort" };
  assert.equal(cftFor(rows, item).length, 2, "the August transfer is outside the ±10 day window");
  const near = cftMatches(rows, item, 5000);
  assert.deepEqual(near.map((c) => c.cftId), ["333334"]);
  const ev = buildEvidence({ item, cft: cftFor(rows, item) });
  assert.ok(!ev.why.some((w) => w.kind === "cft"), "a CFT is reference only — recycler cash, not register cash");
  assert.equal(ev.cftNear[0].keyedLate, true);
  assert.ok(ev.lookAt.includes("cft"));
  assert.equal(ev.suggestion.safe, false);
  const over = buildEvidence({ item: { ...item, amountCents: 5000 }, cft: cftFor(rows, item) });
  assert.equal(over.cftNear.length, 0, "an overage is not explained by cash leaving the register");
});

test("evidence: a drawer open with nothing tendered and the shortage amount paid out is flagged as a cash-out to watch", () => {
  const drawer = { rows: decodeOpenDrawer(fx("open_drawer.json")).rows.map((r) => r.transNum === "336" ? { ...r, cashTendCents: 0, changeCents: 29528 } : r) };
  const item = { id: "3", register: "63", date: "2026-08-27", amountCents: -29528, amountAbsCents: 29528, sourceAppId: "mel" };
  const ev = buildEvidence({ item, ej: { transactions: [], events: [] }, drawer });
  assert.equal(ev.cashOut.length, 1); assert.equal(ev.cashOut[0].transNum, "336"); assert.equal(ev.cashOut[0].nearKind, "out");
  assert.ok(ev.why.some((w) => w.kind === "cashout" && /paid out \$295\.28/.test(w.text)));
  assert.match(ev.suggestion.text, /cash-out on TR# 336/);
  assert.equal(ev.drawer.rows.find((r) => r.transNum === "335").nearKind, null, "an $820 cash sale is not near a $295 shortage");
});
