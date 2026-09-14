// node --test modules/registerls/lib/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { decodeOpenDrawer, buildOpenDrawerBody, tradingDay, linkVideo, cctvUrl } from "../open_drawer.js";
import { decodeCft, buildFilteredBody, normalizeRow, cftFor, dsrColumnOrder } from "../cft.js";
import { buildEvidence, cftMatches, cftForTransactions } from "../evidence.js";
import { storeUseBasket } from "../investigation.js";
import { pantryMatch, normUpc, DEFAULT_PANTRY } from "../pantry.js";
import { parseRecords } from "../ej_parse.js";

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

test("cft: a cash ticket that looks like a store purchase with no CFT keyed is flagged as a CFT never completed; with a CFT it is a process error to confirm", () => {
  const line = (desc, cents) => ({ desc, cents, voided: false });
  const basket = [line("BANANAS", 141), line("BANANAS", 120), line("BANANAS", 134), line("FOAM PLATES", 596), line("VARIETY PAC", 756), line("VARIETY PAC", 756), line("VARIETY PAC", 756), line("GV 20OZ BWL", 497), line("GV 20OZ BWL", 497), line("GV 20OZ BWL", 497)];
  const tx = { transNum: "4273", time: "09:55:26", opNum: "353", totalCents: 22204, cashTendCents: 22204, changeDueCents: 0, items: basket };
  assert.ok(storeUseBasket(tx), "repeated lines + plates/bowls = store-use basket");
  assert.equal(storeUseBasket({ ...tx, items: [line("TV 55IN", 39800), line("HDMI CABLE", 1200)] }), null);
  const item = { id: "13", register: "13", date: "2026-07-20", amountCents: -22100, amountAbsCents: 22100, sourceAppId: "mel" };
  const ej = { transactions: [tx], events: [] };
  const none = buildEvidence({ item, ej, cft: [] });
  const miss = none.why.find((w) => w.kind === "cft_missing");
  assert.ok(miss && /No CFT for that amount was keyed/.test(miss.text));
  // the pantry basket + no CFT IS the cause: verdict, reason and a ready disposition
  assert.equal(none.verdict, "pantry_cft");
  assert.equal(none.why[1].kind, "cft_missing", "the cause sits right after the offset check");
  assert.ok(!none.why.some((w) => w.kind === "video"), "no 'watch the video' bullet when the cause is the CFT");
  assert.equal(none.suggestion.safe, true);
  assert.equal(none.suggestion.reasonLabel, "Process Errors");
  assert.match(none.suggestion.text, /Process error — CFT not completed\. Register 13 .* TR# 4273 .* \$222\.04 cash was the associate pantry run/);
  assert.equal(buildEvidence({ item: { ...item, sourceAppId: "overshort" }, ej, cft: [] }).suggestion.reasonLabel, "Process Error - CFT");
  // a store-use basket that is not on the pantry list does NOT become a verdict
  const crayons = buildEvidence({ item, ej: { transactions: [{ ...tx, items: [line("CRAYON", 100), line("CRAYON", 100), line("CRAYON", 100), line("CLRPEN", 200), line("CLRPEN", 200), line("CLRPEN", 200), line("PLATES", 500)] }], events: [] }, cft: [] });
  assert.notEqual(crayons.verdict, "pantry_cft"); assert.equal(crayons.suggestion.safe, false);
  const keyed = [{ businessDate: "2026-07-20", inputDate: "2026-07-20", inputTime: "13:10:00", amountCents: 22204, accountDesc: "ASSOCIATE RELATIONS", recipient: "Associate Relations", reason: "snacks", system: false, keyedLate: false }];
  const withCft = buildEvidence({ item, ej, cft: keyed });
  assert.ok(withCft.why.some((w) => w.kind === "cft_keyed"));
  assert.equal(cftForTransactions(keyed, ej, withCft.cashMatches, "2026-07-20")[0].cft.amountCents, 22204);
  // an ordinary customer sale with no CFT is not flagged
  const plain = buildEvidence({ item, ej: { transactions: [{ ...tx, items: [line("TV 55IN", 22204)] }], events: [] }, cft: [] });
  assert.ok(!plain.why.some((w) => w.kind === "cft_missing" || w.kind === "cft_keyed"));
});

test("pantry: the associate-pantry ticket is recognised from its UPCs, including two-letter item flags and PLU bananas", () => {
  const text = [
    "ST# 1458 OP# 00000353 TE# 13 TR# 04273",
    "BANANAS      064312604011  SF      1.41 B", " 2.94 LBS  AT 1 FOR   0.48      1.41 B",
    "BANANAS      000000004011  KF      1.20 B", "  2.5 LBS  AT 1 FOR   0.48      1.20 B",
    "FOAM PLATES  007874208830  S      5.96 AD",
    "VARIETY PAC  007874200871  SF      7.56 BD", "VARIETY PAC  007874200871  SF      7.56 BD", "VARIETY PAC  007874200871  SF      7.56 BD",
    "GV 20OZ BWL  007874234937  S      4.97 AD",
    "NISSIN CUP   007066203003  SF      0.50 BD", "NISSIN CUP   007066203003  SF      0.50 BD",
    "GV SPAG RING 060538818792  SF      1.08 BD",
    "GV CHWY 48   007874202459  SF      7.48 BD",
    "TV 55IN      012345678901  N    398.00 A",
    "            SUBTOTAL   447.26", "              TOTAL   447.26", "     CASH  TEND    447.26", "  CHANGE DUE     0.00", "07/20/26  09:55:26",
  ].join("\n");
  const { transactions } = parseRecords([{ transTime: 95526, opNum: 353, transNum: 4273, record: text }]);
  const tx = transactions[0];
  assert.ok(tx, "receipt parsed");
  assert.equal(tx.items.length, 12, "weight sub-lines are not items; SF/KF lines are");
  assert.equal(normUpc("064312604011"), "64312604011");
  const pm = pantryMatch(tx.items);
  assert.equal(pm.lines, 11); assert.equal(pm.total, 12);
  assert.ok(pm.products[0].startsWith("VARIETY PAC ×3") || pm.products.some((p) => /BANANAS ×2/.test(p)));
  assert.equal(storeUseBasket(tx).kind, "pantry");
  assert.equal(pantryMatch([{ desc: "TV 55IN", code: "012345678901" }, { desc: "HDMI", code: "1" }]), null);
  assert.ok(DEFAULT_PANTRY.length >= 9);
});
