// Call-in finder: Digital associates on the WFM schedule for a day who never
// made it onto the Daily Board (or are board-absent), verified against GTA
// punches. Catches call-ins that were ERASED from the board rather than
// marked absent.
// Usage: node dev/dm-callins.mjs [store] [fromISO] [toISO]
import fs from "node:fs";
import puppeteer from "puppeteer-core";
import { isDigitalJob, leadershipForJob } from "../modules/digitalmetrics/lib/data/job_classify.js";
import { findAssignmentMatch } from "../modules/digitalmetrics/lib/data/adherence.js";

const b = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", protocolTimeout: 570000 });
let page = (await b.pages()).find((p) => /\/app\.html/.test(p.url()) && p.url().startsWith("chrome-extension://fchn"));
if (!page) {
  page = await b.newPage();
  await page.goto("chrome-extension://fchnolphfaklbpdgnofhblfhcailkpdb/app.html#/digitalmetrics");
  await new Promise((r) => setTimeout(r, 1500));
}
const call = async (type, payload = {}) => {
  const r = await page.evaluate(
    (type, payload) => chrome.runtime.sendMessage({ module: "digitalmetrics", type, ...payload }),
    type, payload);
  if (!r?.ok) throw new Error(`${type}: ${r?.error || "failed"}`);
  return r.data;
};

const store = process.argv[2] || (await call("get_home_store"))?.store;
const from = process.argv[3] || "2026-09-19";
const to   = process.argv[4] || "2026-09-22";
const dates = [];
for (let d = new Date(`${from}T12:00:00`); ; d.setDate(d.getDate() + 1)) {
  const iso = d.toISOString().slice(0, 10);
  if (iso > to) break;
  dates.push(iso);
}

// Every scheduled Digital shift per day.
const byDate = {};
const allNames = new Set();
for (const iso of dates) {
  const sched = await call("get_schedule", { store, date: iso }).catch(() => null);
  const board = await call("get_assignments", { store, date: iso }).catch(() => null);
  const digital = (sched?.associates || []).filter((a) => isDigitalJob(a.jobName));
  byDate[iso] = { digital, roster: board?.associates || [] };
  for (const a of digital) allNames.add(a.name);
}

// Punches: reuse the audit cache, then top up the names it does not cover.
const cacheFile = new URL(`./.gta-cache-${store}-${from}-${to}.json`, import.meta.url);
const gta = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")) : { byName: {}, unmatched: [] };
const missing = [...allNames].filter((n) => !gta.byName?.[n] && !(gta.unmatched || []).includes(n));
if (missing.length) {
  console.log(`pulling punches for ${missing.length} scheduled names not in the cache…`);
  const extra = await call("pull_punches", { from, to, people: missing });
  Object.assign(gta.byName ||= {}, extra.byName);
  gta.unmatched = [...new Set([...(gta.unmatched || []), ...(extra.unmatched || [])])];
  fs.writeFileSync(cacheFile, JSON.stringify(gta));
}
const unmatched = new Set(gta.unmatched || []);

const shiftHours = (a) => {
  const h = (a.endSlot ?? 0) - (a.startSlot ?? 0) + 1;
  return h >= 7 ? h - 1 : h;   // knock an hour off long shifts for lunch
};

for (const iso of dates) {
  const { digital, roster } = byDate[iso];
  const day = new Date(`${iso}T12:00:00`).toLocaleDateString([], { weekday: "long" });
  console.log(`\n═══ ${day} ${iso} — ${digital.length} Digital associates scheduled ═══`);
  let lost = 0;
  for (const a of digital) {
    // Coaches are salaried (no punches, ever) and TLs oversee rather than
    // work board tasks — neither is pick capacity nor a call-in candidate.
    const lead = leadershipForJob(a.jobName);
    if (lead) { console.log(`  ${lead.padEnd(8)} ${a.name.padEnd(24)} ${a.jobName} — overseer, not counted`); continue; }
    const g = gta.byName?.[a.name]?.days?.[iso];
    const punched = !!g?.punches?.length;
    const onBoard = roster.some((r) => r.name === a.name) || !!findAssignmentMatch(a.name, roster);
    const boardRow = roster.find((r) => r.name === a.name) || findAssignmentMatch(a.name, roster);
    const absent = boardRow?.status === "absent";

    if (!punched && !unmatched.has(a.name)) {
      const hrs = shiftHours(a);
      lost += hrs;
      console.log(`  CALL-IN  ${a.name.padEnd(24)} sched ${a.shiftStart}-${a.shiftEnd} (~${hrs}h)` +
        `${onBoard ? (absent ? " · board: absent" : " · still on board!") : " · removed from board"}`);
    } else if (!punched && unmatched.has(a.name)) {
      console.log(`  ?        ${a.name.padEnd(24)} sched ${a.shiftStart}-${a.shiftEnd} · GTA lookup failed`);
    } else if (punched && !onBoard) {
      console.log(`  worked-unboarded ${a.name.padEnd(20)} in ${g.punches[0]?.at} — punched but never on the board`);
    }
  }
  console.log(`  → ~${lost}h of scheduled Digital shift time lost to call-ins`);
}
b.disconnect();
