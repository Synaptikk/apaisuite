// Root-cause audit of assigned vs actual pick hours, one day at a time, with
// GTA punches as the ground truth: called out vs clocked in, lunch windows,
// clock-in → first-scan gaps, and time on the clock that never became picks.
// Usage: node dev/dm-day-audit.mjs [store] [fromISO] [toISO]
import puppeteer from "puppeteer-core";
import { effectiveAssignedHours, findAssignmentMatch, dateKey, actualPickHoursByName } from "../modules/digitalmetrics/lib/data/adherence.js";
import { hhmm } from "../modules/digitalmetrics/lib/data/gta_parse.js";

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
const classifications = (await call("get_classifications", { store })) || {};

// Week docs covering the range → per-name per-day metrics rows.
const weekKeys = await call("list_weeks", { store });
const metricByNameDate = new Map();  // "NAME|iso" -> row
const actualByName = {};
for (const wk of weekKeys.slice(-3)) {
  const doc = await call("get_week", { store, weekKey: wk });
  if (!doc?.rawData?.length) continue;
  Object.assign(actualByName, actualPickHoursByName(doc.rawData));
  let last = null;
  for (const row of doc.rawData) {
    if (row["Pick Date"]) last = dateKey(row["Pick Date"]);
    if (!last || !row.Associate) continue;
    metricByNameDate.set(`${row.Associate}|${last}`, row);
  }
}

// Assignments for each date in range.
const dates = [];
for (let d = new Date(`${from}T12:00:00`); ; d.setDate(d.getDate() + 1)) {
  const iso = d.toISOString().slice(0, 10);
  if (iso > to) break;
  dates.push(iso);
}
const byDate = {};
for (const iso of dates) {
  const a = await call("get_assignments", { store, date: iso }).catch(() => null);
  if (a) byDate[iso] = a;
}

// People worth auditing: on a board with any Pick slot, or with pick time.
const names = new Set();
for (const iso of Object.keys(byDate)) {
  for (const row of byDate[iso].associates || []) {
    const hasPick = Object.values(row.slots || {}).some((t) => String(t).toLowerCase() === "pick");
    if (hasPick || row.status === "absent") names.add(row.name);
  }
}
console.log(`store ${store} · ${from}..${to} · ${names.size} associates to verify against GTA`);
// GTA pulls are slow and punches for past days never change — cache per range.
const fs = await import("node:fs");
const cacheFile = new URL(`./.gta-cache-${store}-${from}-${to}.json`, import.meta.url);
let gta;
if (fs.existsSync(cacheFile)) {
  gta = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  console.log("using cached punches (delete dev/.gta-cache-*.json to re-pull)");
} else {
  console.log("pulling punches from the timesheet (needs a signed-in tab)…");
  gta = await call("pull_punches", { from, to, people: [...names] });
  fs.writeFileSync(cacheFile, JSON.stringify(gta));
}
if (gta.unmatched?.length) console.log(`GTA could not match: ${gta.unmatched.join(", ")}`);
if (gta.errors?.length) console.log(`GTA errors: ${gta.errors.join("; ")}`);

// "9/19/26 5:08 AM" → minutes since midnight.
const scanMin = (v) => {
  const m = /(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)/i.exec(String(v ?? ""));
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return h * 60 + parseInt(m[2], 10);
};
const t = (min) => (min == null ? "?" : hhmm(min));
const SLOT0 = 5 * 60;
const r1 = (v) => Math.round(v * 10) / 10;

for (const iso of dates) {
  const doc = byDate[iso];
  console.log(`\n═══ ${iso} (${new Date(`${iso}T12:00:00`).toLocaleDateString([], { weekday: "long" })}) ═══`);
  if (!doc) { console.log("no assignments saved"); continue; }
  const roster = doc.associates || [];
  const lines = [];

  for (const name of names) {
    const row = roster.find((a) => a.name === name)
      || findAssignmentMatch(name, roster);
    const assigned = row ? r1(effectiveAssignedHours(row, roster)) : 0;
    const boardAbsent = row?.status === "absent";
    if (!row) continue;

    // Metrics row (metrics names are full names; roster may differ) — try both.
    let met = metricByNameDate.get(`${name}|${iso}`) || null;
    if (!met) {
      for (const [k, v] of metricByNameDate) {
        const [mn, md] = k.split("|");
        if (md === iso && findAssignmentMatch(mn, [row])) { met = v; break; }
      }
    }
    const actual = r1(met?.["Pick Hours"] || 0);
    const picks  = (met?.["Picked As Req Qty"] || 0) + (met?.["Exception Picked As Req Qty"] || 0);
    const first  = scanMin(met?.["Min. First Scan"]);

    const day = gta.byName?.[name]?.days?.[iso];
    const punches = day?.punches || [];
    const meal = punches.findIndex((p) => p.code === "MEAL");
    const mealBack = meal >= 0 ? punches[meal + 1] : null;
    const punchTxt = punches.length
      ? `in ${punches[0]?.at ?? "?"}${meal >= 0 ? `, lunch ${punches[meal].at}${mealBack ? `–${mealBack.at}` : ""}` : ""}, out ${day.clockOut != null ? t(day.clockOut) : "?"}`
      : "NO PUNCHES";

    // Cause, most specific first.
    const unmatched = new Set(gta.unmatched || []);
    let cause = "";
    if (boardAbsent) cause = punches.length ? "board says ABSENT but GTA has punches — check" : "called out (board absent, GTA confirms no punches)";
    else if (unmatched.has(name)) cause = "GTA name lookup failed — punches unknown, not a verified no-show";
    else if (!day || !punches.length) cause = assigned > 0 ? "NO-SHOW for assigned pick — no GTA punches" : "";
    else if (assigned > 0 && actual === 0) cause = "on the clock, zero pick time — reassigned/other work";
    else if (assigned > 0) {
      const bits = [];
      // The gap that matters starts when picking was supposed to: the first
      // assigned PICK slot — not clock-in, which may open on STAGE/Dispense —
      // and after lunch when lunch sits between clock-in and that slot.
      const pickSlots = Object.entries(row.slots || {})
        .filter(([, task]) => String(task).toLowerCase() === "pick")
        .map(([k]) => parseInt(k, 10)).sort((a2, b2) => a2 - b2);
      const firstPickStart = pickSlots.length ? SLOT0 + pickSlots[0] * 60 : null;
      // punch .at is 24h "HH:MM" (gta_parse hhmm), not the metrics' AM/PM.
      const hb = mealBack && /^(\d{2}):(\d{2})$/.exec(mealBack.at);
      const mealBackMin = hb ? parseInt(hb[1], 10) * 60 + parseInt(hb[2], 10) : null;
      let expected = Math.max(day.clockIn ?? 0, firstPickStart ?? 0);
      if (mealBackMin != null && firstPickStart != null && mealBackMin <= firstPickStart + 30 && mealBackMin > expected)
        expected = mealBackMin;
      if (first != null && expected > 0 && first - expected > 20)
        bits.push(`pick block from ${t(firstPickStart)} (in ${t(day.clockIn)}${mealBackMin != null ? `, lunch back ${t(mealBackMin)}` : ""}), first scan ${t(first)} (+${first - expected}m)`);
      const worked = day.clockOut != null && day.clockIn != null
        ? (day.clockOut - day.clockIn) / 60 - (meal >= 0 && mealBack ? 1 : 0) : null;
      if (worked != null && actual < assigned - 0.5)
        bits.push(`worked ${r1(worked)}h, picked ${actual}h of ${assigned}h assigned`);
      cause = bits.join("; ");
    }
    if (!assigned && !actual) continue;
    lines.push({ name, assigned, actual, picks, punchTxt, cause, short: assigned - actual });
  }

  lines.sort((a, b2) => b2.short - a.short);
  for (const l of lines) {
    console.log(`${l.name.padEnd(24)} ${String(l.assigned).padStart(5)}h asg ${String(l.actual).padStart(5)}h picked ${String(l.picks).padStart(5)} items · ${l.punchTxt}${l.cause ? `\n${"".padEnd(24)}   ↳ ${l.cause}` : ""}`);
  }
}
b.disconnect();
