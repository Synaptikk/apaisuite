// Smoke test: import the parser + scorer as Node ES modules and run them
// against the real xlsx file. Catches regressions before manual extension
// reload. Run with:  node modules/digitallocks/dev/smoke.mjs <path-to.xlsx>

import { readFile } from "node:fs/promises";
import { readXlsxFile }     from "../lib/xlsx.js";
import { parseLockEventsFile, parseCsv, resolveHeaders, parseTimestamp, makeEventId } from "../lib/parseLockEvents.js";
import { scoreEvents, groupIntoEpisodes } from "../lib/riskScoring.js";

const path = process.argv[2] || "C:/Users/ses008s.s01458/Documents/digitallocks.xlsx";
const buf  = await readFile(path);

// readXlsxFile in the browser accepts File/Blob/ArrayBuffer/Uint8Array.
// In Node we pass the Buffer's underlying ArrayBuffer slice.
const arrBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const sheet = await readXlsxFile(arrBuf);
console.log(`Parsed ${sheet.rows.length} rows · ${sheet.headers.length} headers`);
console.log("Headers:", sheet.headers.join(" | "));

const { map, unknown } = resolveHeaders(sheet.headers);
console.log("Header map:", map);
if (unknown.length) console.log("Unknown headers:", unknown);

// Mock the parseLockEventsFile flow without a File. Inline the normalize logic:
const required = ["store","lockName","zoneName","userId","eventTime"];
const missing = required.filter((f) => !map[f]);
if (missing.length) { console.error("MISSING required:", missing); process.exit(1); }

const rows = [];
let rowIndex = 0;
for (const raw of sheet.rows) {
  rowIndex++;
  const get = (canon) => { const h = map[canon]; const v = h ? raw[h] : ""; return v == null ? "" : String(v).trim(); };
  const store=get("store"), lockName=get("lockName"), zoneName=get("zoneName"), unlockSource=get("unlockSource");
  const userId=get("userId"), firstName=get("firstName"), lastName=get("lastName"), position=get("position");
  const eventTimeRaw = get("eventTime");
  if (!store && !lockName && !zoneName && !userId && !eventTimeRaw) continue;
  const { date, hour, day } = parseTimestamp(eventTimeRaw);
  rows.push({
    id: makeEventId({ store, userId, lockName, zoneName, eventTimeRaw, rowIndex }),
    store, lockName, zoneName, unlockSource, userId, firstName, lastName,
    fullName: [firstName,lastName].filter(Boolean).join(" "),
    position,
    eventTime: date ? date.toISOString() : eventTimeRaw,
    eventTimeRaw, eventDate: day, eventHour: hour,
    riskScore: 0, riskLevel: "Normal", riskReasons: [],
    reviewStatus: "active", reviewerNotes: "",
  });
}
console.log(`Normalized ${rows.length} events`);

// Load rules JSON (the same way view.js does, but from disk).
const weights  = JSON.parse(await readFile(new URL("../data/risk_weights.json",    import.meta.url), "utf8"));
const keywords = JSON.parse(await readFile(new URL("../data/high_risk_keywords.json", import.meta.url), "utf8"));
const roleZone = JSON.parse(await readFile(new URL("../data/role_zone_rules.json", import.meta.url), "utf8"));

const rules = {
  weights: weights.weights, bands: weights.bands,
  timeWindows: weights.timeWindows, thresholds: weights.thresholds,
  highRiskKeywords: keywords.keywords,
  roleZone,
};
scoreEvents(rows, rules);

const buckets = { Critical:0, High:0, Watch:0, Normal:0 };
for (const e of rows) buckets[e.riskLevel] = (buckets[e.riskLevel]||0) + 1;
console.log("Score bands:", buckets);

const top20 = [...rows].sort((a,b) => b.riskScore - a.riskScore).slice(0, 20);
console.log("\nTop 20 events:");
for (const e of top20) {
  console.log(`  ${e.riskScore} [${e.riskLevel}] ${e.eventTime} ${e.fullName||"(unattributed)"} [${e.userId}] ${e.position} → ${e.zoneName}/${e.lockName} :: ${e.riskReasons.join(" | ")}`);
}

const eps = groupIntoEpisodes(rows.filter((e) => e.riskScore >= 25), { windowMinutes: 30 });
console.log(`\nEpisode count (events with score>=25): ${eps.length}`);
for (const ep of eps.slice(0, 10)) {
  console.log(`  max=${ep.maxScore} ${ep.name} [${ep.userId}] zone=${ep.zoneName} ${ep.startTime} → ${ep.endTime} · ${ep.eventCount} events · ${ep.locks.length} locks · reasons=${ep.reasons.join(",")}`);
}
