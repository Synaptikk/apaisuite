// Per-day pick-hours ledger: what the board planned, then every deduction —
// call-ins, task swaps, late arrival into pick hours, early departures, long
// lunches over pick hours, and present-but-not-picking — reconciled to the
// metrics' actual pick time. GTA punches (cached by dm-day-audit) are the
// ground truth for presence.
// Usage: node dev/dm-pick-ledger.mjs [store] [fromISO] [toISO]
import fs from "node:fs";
import puppeteer from "puppeteer-core";
import { effectiveAssignedHours, findAssignmentMatch, dateKey } from "../modules/digitalmetrics/lib/data/adherence.js";

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

// Metrics: per-name per-day pick hours.
const weekKeys = await call("list_weeks", { store });
const metric = new Map();  // "NAME|iso" -> { hours }
for (const wk of weekKeys.slice(-3)) {
  const doc = await call("get_week", { store, weekKey: wk });
  let last = null;
  for (const row of doc?.rawData || []) {
    if (row["Pick Date"]) last = dateKey(row["Pick Date"]);
    if (!last || !row.Associate) continue;
    metric.set(`${row.Associate}|${last}`, row["Pick Hours"] || 0);
  }
}

const dates = [];
for (let d = new Date(`${from}T12:00:00`); ; d.setDate(d.getDate() + 1)) {
  const iso = d.toISOString().slice(0, 10);
  if (iso > to) break;
  dates.push(iso);
}

// GTA punches from the audit's cache (run dm-day-audit first if missing).
const cacheFile = new URL(`./.gta-cache-${store}-${from}-${to}.json`, import.meta.url);
const gta = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")) : { byName: {}, unmatched: [] };
const unmatched = new Set(gta.unmatched || []);

const SLOT0 = 5 * 60;
const r1 = (v) => Math.round(v * 10) / 10;
const mins = (at) => { const m = /^(\d{2}):(\d{2})$/.exec(at || ""); return m ? +m[1] * 60 + +m[2] : null; };
const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

for (const iso of dates) {
  const doc = await call("get_assignments", { store, date: iso }).catch(() => null);
  const day = new Date(`${iso}T12:00:00`).toLocaleDateString([], { weekday: "long" });
  console.log(`\n═══ ${day} ${iso} ═══`);
  if (!doc) { console.log("no assignments saved"); continue; }
  const roster = doc.associates || [];

  let planned = 0, actualTotal = 0;
  const cuts = [];    // { hrs, text }
  const longLunch = [];   // meal windows over 70 minutes, wherever they fall

  for (const row of roster) {
    const pickSlots = Object.entries(row.slots || {})
      .filter(([, t]) => String(t).toLowerCase() === "pick")
      .map(([k]) => +k).sort((x, y) => x - y);
    if (!pickSlots.length) continue;

    // Plan as if present: what this row was supposed to contribute.
    const plan = r1(effectiveAssignedHours({ ...row, status: null }, roster));
    if (!plan) continue;
    planned += plan;

    const name = row.name;
    let actual = metric.get(`${name}|${iso}`);
    if (actual == null) {
      for (const [k, v] of metric) {
        const [mn, md] = k.split("|");
        if (md === iso && findAssignmentMatch(mn, [row])) { actual = v; break; }
      }
    }
    actual = r1(actual || 0);
    actualTotal += actual;

    const g = gta.byName?.[name]?.days?.[iso];
    const punches = g?.punches || [];
    const clockIn = g?.clockIn ?? null, clockOut = g?.clockOut ?? null;
    const mi = punches.findIndex((p) => p.code === "MEAL");
    const meal0 = mi >= 0 ? mins(punches[mi].at) : null;
    const meal1 = mi >= 0 && punches[mi + 1] ? mins(punches[mi + 1].at) : null;
    if (meal0 != null && meal1 != null && meal1 - meal0 > 70)
      longLunch.push({ name, out: punches[mi].at, back: punches[mi + 1].at, min: meal1 - meal0 });

    // 1. Not here at all.
    if (row.status === "absent" || (!punches.length && !unmatched.has(name) && actual === 0)) {
      const why = row.status === "absent"
        ? (punches.length ? "board absent (but GTA HAS punches — check)" : "called in (board absent, no punches)")
        : "called in / no-show (no punches)";
      cuts.push({ hrs: plan, text: `${name} — ${why}` });
      continue;
    }
    if (unmatched.has(name) && actual === 0 && !punches.length) {
      cuts.push({ hrs: plan, text: `${name} — no pick time, GTA lookup failed (likely absent)` });
      continue;
    }

    // 2. Pick slots outside their punch window, by where they fell.
    let late = 0, early = 0, lunch = 0;
    if (clockIn != null && clockOut != null) {
      for (const k of pickSlots) {
        const s0 = SLOT0 + k * 60, s1 = s0 + 60;
        late  += Math.max(0, Math.min(clockIn, s1) - s0);
        early += Math.max(0, s1 - Math.max(clockOut, s0));
        if (meal0 != null && meal1 != null) lunch += overlap(s0, s1, meal0, meal1);
      }
      late = r1(late / 60); early = r1(early / 60); lunch = r1(lunch / 60);
    }
    const missed = Math.min(plan, late + early + lunch);
    if (late  >= 0.5) cuts.push({ hrs: late,  text: `${name} — arrived after pick hours started (in ${punches[0]?.at})` });
    if (early >= 0.5) cuts.push({ hrs: early, text: `${name} — left before pick hours ended (out ${g?.clockOut != null ? `${String(Math.floor(clockOut / 60)).padStart(2, "0")}:${String(clockOut % 60).padStart(2, "0")}` : "?"})` });
    if (lunch >= 0.5) cuts.push({ hrs: lunch, text: `${name} — lunch overlapped assigned pick hours` });

    // 3. Present during pick hours but the time didn't become picks.
    const gap = r1(Math.max(0, plan - missed - actual));
    if (gap >= 0.5) {
      cuts.push({
        hrs: gap,
        text: actual === 0
          ? `${name} — on the clock, never picked (swapped to other work?)`
          : `${name} — present but picked ${actual}h of the ${r1(plan - missed)}h remaining`,
        soft: actual > 0,   // the structural under-pick band
      });
    }
  }

  planned = r1(planned); actualTotal = r1(actualTotal);
  const hard = cuts.filter((c) => !c.soft).sort((a, b2) => b2.hrs - a.hrs);
  const soft = cuts.filter((c) => c.soft).sort((a, b2) => b2.hrs - a.hrs);
  const softSum = r1(soft.reduce((s, c) => s + c.hrs, 0));

  console.log(`${planned}h pick scheduled on the board`);
  for (const c of hard) console.log(`  -${c.hrs}h  ${c.text}`);
  if (soft.length) {
    console.log(`  -${softSum}h  present-but-under-picked, ${soft.length} people; largest:`);
    for (const c of soft.slice(0, 6)) console.log(`        -${c.hrs}h  ${c.text}`);
  }
  const cut = r1(cuts.reduce((s, c) => s + c.hrs, 0));
  console.log(`  = ${r1(planned - cut)}h expected · ${actualTotal}h actually picked (residual ${r1(actualTotal - (planned - cut))}h)`);
  if (longLunch.length) {
    console.log(`  excessive lunches (>1:10):`);
    for (const l of longLunch.sort((a, b2) => b2.min - a.min))
      console.log(`    ${l.name.padEnd(24)} ${l.out}–${l.back}  (${Math.floor(l.min / 60)}:${String(l.min % 60).padStart(2, "0")}, +${l.min - 60}m over)`);
  }
}
b.disconnect();
