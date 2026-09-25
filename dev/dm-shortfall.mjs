// Where digital failed, per day: the gap between the board's pick plan and
// what digital delivered, split into buckets — call-outs still on the board,
// reassigned (clocked in, zero picks), tardy into pick hours, left early,
// lunch over pick hours, and under-picked while present. Also memos the
// call-ins that were erased from the board before the plan was written.
// Usage: node dev/dm-shortfall.mjs [store] [fromISO] [toISO]
import fs from "node:fs";
import puppeteer from "puppeteer-core";
import { effectiveAssignedHours, findAssignmentMatch, dateKey } from "../modules/digitalmetrics/lib/data/adherence.js";
import { isDigitalJob, leadershipForJob } from "../modules/digitalmetrics/lib/data/job_classify.js";

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

const metric = new Map();
for (const wk of (await call("list_weeks", { store })).slice(-3)) {
  const doc = await call("get_week", { store, weekKey: wk });
  let last = null;
  for (const row of doc?.rawData || []) {
    if (row["Pick Date"]) last = dateKey(row["Pick Date"]);
    if (!last || !row.Associate) continue;
    metric.set(`${row.Associate}|${last}`, row["Pick Hours"] || 0);
  }
}

const cacheFile = new URL(`./.gta-cache-${store}-${from}-${to}.json`, import.meta.url);
const gta = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")) : { byName: {}, unmatched: [] };
const unmatched = new Set(gta.unmatched || []);

const SLOT0 = 5 * 60;
const r1 = (v) => Math.round(v * 10) / 10;
const mins = (a) => { const m = /^(\d{2}):(\d{2})$/.exec(a || ""); return m ? +m[1] * 60 + +m[2] : null; };
const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const dates = [];
for (let d = new Date(`${from}T12:00:00`); ; d.setDate(d.getDate() + 1)) {
  const iso = d.toISOString().slice(0, 10);
  if (iso > to) break;
  dates.push(iso);
}

const CATS = ["callin", "reassigned", "tardy", "leftEarly", "underPick"];
const LABEL = {
  callin: "call-ins (erased from board + boarded no-shows)",
  reassigned: "reassigned (worked, 0 picks)",
  tardy: "tardy into pick hours", leftEarly: "left before pick hours ended",
  underPick: "under-picked while present",
};
const week = Object.fromEntries(CATS.map((c) => [c, 0]));
const whoWeek = Object.fromEntries(CATS.map((c) => [c, new Map()]));

for (const iso of dates) {
  const board = await call("get_assignments", { store, date: iso }).catch(() => null);
  const sched = await call("get_schedule", { store, date: iso }).catch(() => null);
  const roster = board?.associates || [];
  const day = new Date(`${iso}T12:00:00`).toLocaleDateString([], { weekday: "short" });

  let planned = 0, delivered = 0;
  const tally = Object.fromEntries(CATS.map((c) => [c, 0]));
  const who = Object.fromEntries(CATS.map((c) => [c, []]));
  const add = (cat, hrs, name) => {
    if (hrs < 0.1) return;
    tally[cat] += hrs; who[cat].push(`${name} ${r1(hrs)}h`);
    week[cat] += hrs;
    whoWeek[cat].set(name, (whoWeek[cat].get(name) || 0) + hrs);
  };

  // Call-ins erased before the board was written are part of the ORIGINAL
  // plan: their shift hours count as plan AND as a call-in deduction.
  for (const a of (sched?.associates || []).filter((x) => isDigitalJob(x.jobName) && !leadershipForJob(x.jobName))) {
    const punched = !!gta.byName?.[a.name]?.days?.[iso]?.punches?.length;
    const onBoard = roster.some((r) => r.name === a.name) || !!findAssignmentMatch(a.name, roster);
    if (!punched && !onBoard && !unmatched.has(a.name)) {
      const h0 = (a.endSlot ?? 0) - (a.startSlot ?? 0) + 1;
      const h = h0 >= 7 ? h0 - 1 : h0;
      planned += h;
      add("callin", h, a.name);
    }
  }

  for (const row of roster) {
    const pickSlots = Object.entries(row.slots || {})
      .filter(([, t]) => String(t).toLowerCase() === "pick").map(([k]) => +k).sort((x, y) => x - y);
    if (!pickSlots.length) {
      // A no-show dispenser/stager still costs pick hours: someone picking
      // gets pulled to cover them. Count their task hours as a call-in.
      const g0 = gta.byName?.[row.name]?.days?.[iso];
      if (row.status === "absent" || (g0 && !g0.punches?.length) || (!g0 && !unmatched.has(row.name) && gta.byName?.[row.name])) {
        const taskHrs = Object.values(row.slots || {})
          .filter((t2) => !["l", "b", ""].includes(String(t2).toLowerCase())).length;
        if (taskHrs && (row.status === "absent" || !g0?.punches?.length)) {
          planned += taskHrs;
          add("callin", taskHrs, `${row.name} (${[...new Set(Object.values(row.slots || {}))].filter((t2) => !["L", "B"].includes(t2)).join("/")})`);
        }
      }
      continue;
    }
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
    delivered += actual;

    const g = gta.byName?.[name]?.days?.[iso];
    const punches = g?.punches || [];
    if (row.status === "absent" || (!punches.length && actual === 0)) {
      add("callin", plan, name);
      continue;
    }
    const mi = punches.findIndex((p) => p.code === "MEAL");
    const meal0 = mi >= 0 ? mins(punches[mi].at) : null;
    const meal1 = mi >= 0 && punches[mi + 1] ? mins(punches[mi + 1].at) : null;
    let late = 0, early = 0, lunch = 0;
    if (g?.clockIn != null && g?.clockOut != null) {
      for (const k of pickSlots) {
        const s0 = SLOT0 + k * 60, s1 = s0 + 60;
        late  += Math.max(0, Math.min(g.clockIn, s1) - s0);
        early += Math.max(0, s1 - Math.max(g.clockOut, s0));
        if (meal0 != null && meal1 != null) lunch += overlap(s0, s1, meal0, meal1);
      }
      late /= 60; early /= 60; lunch /= 60;
    }
    add("tardy", r1(late), name);
    add("leftEarly", r1(early), name);
    // A lunch landing on an assigned pick hour is normal, not a failure:
    // it just means the plan overstated that hour. Reduce the plan quietly.
    planned -= Math.min(plan, r1(lunch));
    const missed = Math.min(plan, late + early + lunch);
    const gap = r1(Math.max(0, plan - missed - actual));
    if (actual === 0) add("reassigned", gap, name);
    else add("underPick", gap, name);
  }

  planned = r1(planned); delivered = r1(delivered);
  console.log(`\n${day} ${iso} — plan ${planned}h, digital delivered ${delivered}h, gap ${r1(planned - delivered)}h`);
  for (const c of CATS) {
    if (tally[c] < 0.1) continue;
    const names = c === "underPick"
      ? `${who[c].length} people; top: ${who[c].sort((a, b2) => parseFloat(b2.split(" ").at(-1)) - parseFloat(a.split(" ").at(-1))).slice(0, 3).join(", ")}`
      : who[c].join(", ");
    console.log(`  -${r1(tally[c])}h`.padStart(9) + `  ${LABEL[c]} — ${names}`);
  }
}

console.log(`\n═══ week totals ═══`);
for (const c of CATS) {
  if (week[c] < 0.1) continue;
  const top = [...whoWeek[c].entries()].sort((a, b2) => b2[1] - a[1]).slice(0, 4)
    .map(([n, h]) => `${n} ${r1(h)}h`).join(", ");
  console.log(`  ${r1(week[c])}h`.padStart(8) + `  ${LABEL[c]} — top: ${top}`);
}
b.disconnect();
