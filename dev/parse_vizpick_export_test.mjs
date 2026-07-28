// Verify parse_vizpick_export.js against the REAL exported sample rows.
import { mapLocationDetails, mapDepartmentBreakout }
  from "../modules/metricshot/lib/sources/parse_vizpick_export.js";

// Pretend "now" is just after the latest scan so hours are small + sane.
const NOW = Date.parse("7/28/2026 11:00:00 AM");

const locHeader = ["Status , Location , Seen Today (Combined)","Status ","Location ","Pallets ","Seen Today ","Status ","Location ","Status (copy 2)","Location 123","Status","Max. last_seen_timestamp","Max. user_id","Total Picked ","Cases Seen %","sorting order","loc color","Location Age ","Location Age","Total Picked","Total Picked ","ZN(SUM([cases_expected]))","ZN(SUM([cases_seen]))","ZN(SUM([clearance_tags]))","ZN(SUM([deleted_tags]))","ZN(SUM([pick_anyway_picked_tags]))"];
const locRow1 = ["In Use, 001/002, Yes","In Use","001/002","0/1","Yes","In Use","001/002","In Use","001/002/999","In Use","7/28/2026 10:41:14 AM","cshagga","0","6%","-1,002","Green","1","1","0","0","159","10","0","0","0"];
const locRow2 = ["In Use, 002/002, Yes","In Use","002/002","2/2","Yes","In Use","002/002","In Use","002/002/999","In Use","7/28/2026 3:00:00 AM","l0b06y5","0","67%","-2,002","Green","2","2","0","0","55","37","0","0","0"];

const locRows = [locHeader, locRow1, locRow2];
const locs = mapLocationDetails(locRows, NOW);
console.log("locations:", JSON.stringify(locs, null, 2));

const deptHeader = ["Dept","Suggested Picks ","Suggested Picks Completed ","Pick %","Total Picked","Cases Seen ","Cases Expected ","Cases Seen %","Overstock Exceptions","Clearance Cases","Modular Deleted Cases"];
const deptRows = [
  deptHeader,
  ["Total","771","382","0.49546044098573283","481","5213","8989","0.5799310268105462","170","507","203"],
  ["1","12","11","0.91666666666666663","17","85","85","1","0","0","21"],
  ["3","14","3","0.21428571428571427","6","0","754","0","","0","0"],
];
const depts = mapDepartmentBreakout(deptRows);
console.log("depts:", JSON.stringify(depts, null, 2));

// Assertions.
let ok = true;
function chk(cond, msg) { if (!cond) { ok = false; console.error("FAIL:", msg); } }

chk(locs.length === 2, "2 location rows");
chk(locs[0].location === "001/002", "loc0 bin");
chk(locs[0].status === "In Use", "loc0 status");
chk(locs[0].casesSeenPct === 6, "loc0 cases seen % = 6");
chk(locs[0].pickedTotal === 0, "loc0 picked = 0");
chk(Math.abs(locs[0].hoursSinceLastScan - 0.3128) < 0.05, "loc0 hours ~0.31 (got " + locs[0].hoursSinceLastScan + ")");
chk(Math.abs(locs[1].hoursSinceLastScan - 8.0) < 0.05, "loc1 hours ~8 (got " + locs[1].hoursSinceLastScan + ")");

chk(depts.length === 3, "3 dept rows");
chk(depts[0].dept === "Total", "dept0 Total");
chk(Math.abs(depts[1].pickPct - 0.91666) < 0.001, "dept1 pick %");
chk(depts[1].totalPicked === 17, "dept1 total picked");
chk(depts[1].casesSeen === 85, "dept1 cases seen");
chk(depts[1].casesExpected === 85, "dept1 cases expected");
chk(depts[2].dept === "3", "dept2 = 3");
chk(depts[2].pickPct !== null && Math.abs(depts[2].pickPct - 0.2142) < 0.001, "dept2 pick %");

console.log(ok ? "PASS ✅" : "FAIL ❌");
process.exit(ok ? 0 : 1);
