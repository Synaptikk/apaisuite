// modules/market120/test/isa_review.test.mjs — node modules/market120/test/isa_review.test.mjs
import {
  aggregateStolenItems, aggregateStoreItems, buildReview, fiscalYearStart,
  latestDataDate, storeSummary, summarize, windowFromMaxDate, ymd,
} from "../lib/isa_review.js";

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail !== undefined ? " — " + JSON.stringify(detail) : ""}`); }
}
const D = (s) => Date.parse(`${s}T00:00:00Z`);

console.log("dates");
check("ymd from epoch", ymd(1787356800000) === "2026-08-22");
check("latest date ignores zero-dollar days", latestDataDate([{ Date: D("2026-09-05"), Dollars: -3 }, { Date: D("2026-09-09"), Dollars: 0 }]) === D("2026-09-05"));
const w = windowFromMaxDate(D("2026-09-05"), 14);
check("14-day window ends after data-through", w.from === "2026-08-23" && w.to === "2026-09-06", w);
check("fiscal year Feb 1", fiscalYearStart(D("2026-09-15")) === "2026-02-01" && fiscalYearStart(D("2027-01-10")) === "2026-02-01");

console.log("buildReview + summarize");
const review = buildReview({
  window: w, dataThrough: "2026-09-05", fyFrom: "2026-02-01",
  trend: [
    { Store: "1458", Reason: "RFID", Date: D("2026-09-01"), Dollars: -100 },
    { Store: "1458", Reason: "ISA", Date: D("2026-09-01"), Dollars: -10 },
    { Store: "1215", Reason: "RFID", Date: D("2026-09-02"), Dollars: -50 },
  ],
  rollup: [
    { Store: "1458", Reason: "RFID", Dept: "10", Cat: "AUTO", Dollars: -80, Qty: -8, Lines: 4 },
    { Store: "1458", Reason: "RFID", Dept: "1", Cat: "CANDY", Dollars: -20, Qty: -5, Lines: 2 },
    { Store: "1458", Reason: "ISA", Dept: "1", Cat: "CANDY", Dollars: -10, Qty: -1, Lines: 1 },
    { Store: "1215", Reason: "RFID", Dept: "10", Cat: "AUTO", Dollars: -50, Qty: -2, Lines: 1 },
  ],
  sources: [{ Store: "1458", Reason: "RFID", Source: "RFID", Dollars: -100 }, { Store: "1458", Reason: "ISA", Source: "ISA", Dollars: -10 }],
  brFy: [{ Store: "1458", Type: "Stolen", Dollars: -44186.56, Qty: -900 }, { Store: "1458", Type: "Shortage", Dollars: -10, Qty: -1 }, { Store: "1215", Type: "Stolen", Dollars: -35444, Qty: -500 }],
  brWindow: [{ Store: "1458", Type: "Stolen", Dollars: -300, Qty: -9 }],
});
check("reasons ordered by largest shrink", review.reasons.join() === "RFID,ISA", review.reasons);
check("stores sorted numerically", review.stores.join() === "1215,1458");
check("store×reason rolled up", JSON.stringify(review.byStoreReason.find((x) => x[0] === "1458" && x[1] === "RFID")) === JSON.stringify(["1458", "RFID", -100, -13, 6]));

const all = summarize(review);
check("market total all reasons", all.total === -160, all.total);
check("largest store first + rank", all.stores[0].store === "1458" && all.stores[0].rank === 1 && all.stores[0].dollars === -110);
check("stolen FY joined to store", all.stores[0].stolenFy === -44186.56 && all.stores[1].stolenFy === -35444);
check("stolen window joined", all.stores[0].stolenWindow === -300 && all.stores[1].stolenWindow === null);
check("top category across stores", all.topCats[0].cat === "AUTO" && all.topCats[0].dollars === -130, all.topCats[0]);
check("trend by date", all.trend.length === 2 && all.trend[0].dollars === -110);
check("BR FY by type", all.brFyByType[0].type === "Stolen" && all.brFyByType[0].dollars === -79630.56, all.brFyByType);

const isaOnly = summarize(review, { reasons: ["ISA"] });
check("reason filter narrows total", isaOnly.total === -10);
check("reason chips keep all reasons with selection flag", isaOnly.byReason.length === 2 && isaOnly.byReason.find((r) => r.reason === "RFID").selected === false);
check("filtered store list drops stores with no selected reason", isaOnly.stores.length === 1);

const s = storeSummary(review, "1458", { reasons: ["RFID"] });
check("store trend filtered", s.trend.length === 1 && s.trend[0].dollars === -100);
check("store categories", s.topCats[0].cat === "AUTO" && s.topDepts[0].dept === "10");
check("store sources filtered", s.sources.length === 1 && s.sources[0].source === "RFID");
check("store BR types", s.brFyByType.length === 2 && s.brFyByType[0].dollars === -44186.56);

console.log("aggregateStoreItems");
const items = aggregateStoreItems([
  { Date: D("2026-09-01"), Reason: "ISA", Source: "ISA", Rule: "STZ", Dept: "10", Cat: "AUTO", Item: "1072418", UPC: 60538800458, Desc: "ES MAXX H6", ItemRetail: 150, Qty: -6, Dollars: -899.04, Lines: 1 },
  { Date: D("2026-09-03"), Reason: "ISA", Source: "Phantom Inventory", Rule: "STZ", Dept: "10", Cat: "AUTO", Item: "1072418", UPC: 60538800458, Desc: "ES MAXX H6", ItemRetail: 150, Qty: -1, Dollars: -149.84, Lines: 1 },
  { Date: D("2026-09-02"), Reason: "RFID", Source: "RFID", Rule: "", Dept: "1", Cat: "CANDY", Item: "5", UPC: "7825405111.000001", Desc: "MINT", ItemRetail: 2, Qty: -1, Dollars: -2, Lines: 3 },
], { perReason: 1 });
check("totals kept across all rows", items.total === -1050.88 && items.lines === 5, items);
check("same item+reason merged", items.items.find((i) => i.item === "1072418").qty === -7);
check("date span + sources", items.items[0].firstDate === "2026-09-01" && items.items[0].lastDate === "2026-09-03" && items.items[0].sources === "ISA, Phantom Inventory", items.items[0]);
check("UPC float cleaned", items.items.find((i) => i.item === "5").upc === "7825405111");
check("per-reason cap keeps each reason", items.items.length === 2);

console.log("aggregateStolenItems");
const st = aggregateStolenItems([
  { Date: D("2026-03-20"), Dept: "10", Category: "AUTO CHEMICALS", Item: 564310216, UPC: "7825405111.000001", Desc: "CRC", User: "PCONEAL", Qty: -1, Dollars: -9.92 },
  { Date: D("2026-04-01"), Dept: "10", Category: "AUTO CHEMICALS", Item: 564310216, UPC: "7825405111.000001", Desc: "CRC", User: "SRELDER", Qty: -2, Dollars: -19.84 },
  { Date: D("2026-05-01"), Dept: "5", Category: "PHONES", Item: 9, UPC: 1, Desc: "PHONE", User: "SRELDER", Qty: -1, Dollars: -300 },
]);
check("stolen total", st.total === -329.76 && st.lines === 3, st.total);
check("users ranked by $", st.byUser[0].user === "SRELDER" && st.byUser[0].dollars === -319.84);
check("items merged with users", st.items.find((i) => i.item === "564310216").users === "PCONEAL, SRELDER");
check("last date", st.lastDate === "2026-05-01");

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed) process.exitCode = 1;
