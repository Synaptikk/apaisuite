// dev/accidents-check.mjs — offline checks for the accidents module.
// Fetches the live CAS file (or uses a path argument) and runs both parsers
// plus the summary composer on a canned digest. Run: node dev/accidents-check.mjs
import fs from "node:fs";
import { parseAccidentHtml } from "../modules/livedashboard/lib/sources/accident.js";
import { parsePnl, rollupPnl } from "../modules/accidents/lib/cas.js";
import { composeSummary } from "../modules/accidents/lib/summary.js";
import { claimDigest, evidenceChecklist } from "../modules/accidents/lib/clearsight_read.js";

let html;
if (process.argv[2]) html = fs.readFileSync(process.argv[2], "utf-8");
else html = await fetch("https://storage.googleapis.com/cas_storage/cas_static_html/1458.html").then((r) => r.text());

let fail = 0;
const check = (name, cond, extra = "") => { console.log(`${cond ? "ok " : "FAIL"} ${name}${extra ? " — " + extra : ""}`); if (!cond) fail++; };

const ev = parseAccidentHtml(html, "1458");
check("evidence parse ok", ev.ok && ev.records.length > 0, `${ev.records?.length} records`);

const charges = parsePnl(html);
check("pnl rows parsed", charges.length > 50, `${charges.length} rows`);
check("pnl has credits", charges.some((c) => c.isCredit), String(charges.filter((c) => c.isCredit).length) + " credit rows");
check("pnl amounts numeric", charges.every((c) => c.amount === null || typeof c.amount === "number"));
check("pnl two FYs", new Set(charges.map((c) => c.fy)).size >= 2, [...new Set(charges.map((c) => c.fy))].join(","));

const refs = rollupPnl(charges);
check("rollup refs", refs.length > 20, `${refs.length} refs`);
const credit = refs.find((r) => r.hasCredit);
check("rollup credit math", credit && credit.credited > 0 && credit.total === credit.charged - credit.credited,
  credit ? `${credit.ref}: charged ${credit.charged} credited ${credit.credited} net ${credit.total}` : "no credit ref");

// summary composer on the probe's real claim FormData when present
const probePath = new URL("./.claim-probe/resp-009.json", import.meta.url);
if (fs.existsSync(probePath)) {
  const d = JSON.parse(fs.readFileSync(probePath, "utf-8"));
  const digest = claimDigest(d);
  check("digest claim number", digest.claimNumber === "26299752", digest.claimNumber);
  check("digest decodes", digest.cause === "Fall/Slip/Trip" && digest.bodyPart === "Head", `${digest.cause} / ${digest.bodyPart}`);
  const chk = evidenceChecklist(d);
  check("evidence checklist incomplete", !chk.complete && chk.filled === 0, `${chk.filled}/${chk.total}`);
  const s = composeSummary(digest, [{ type: "CST", first: "RONALD", last: "NASH", text: "Customer left in an ambulance." }]);
  check("summary mentions description", s.includes("Customer fell on front side walk"));
  check("summary mentions statement", s.includes("Customer statement (Ronald Nash)"));
  console.log("\n--- sample summary ---\n" + s + "\n----------------------");
} else {
  console.log("(skip digest checks — dev/.claim-probe/resp-009.json not present)");
}

process.exit(fail ? 1 : 0);
