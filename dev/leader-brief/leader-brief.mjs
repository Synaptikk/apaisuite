// dev/leader-brief/leader-brief.mjs [store] [YYYY-MM-DD] [market] — today's team leads and
// coaches, each with their area's turnover (now vs 30/60/90 days ago and the
// fiscal-year start) and the top 10 nil-picked items in their departments over
// 30/60/90 days. Writes ~/Downloads/leader-brief-<store>-<date>.html.
//
// Drives the debug Edge (port 9222) over raw CDP; nothing is written anywhere
// but the local HTML file.
//
// Sources:
//   Schedule  — Digital Metrics' Firestore WFM import (stores/<s>/schedules/<d>),
//               read from an extension page so the codec decodes the names.
//   Turnover  — Hoops ops-portal tRPC metric.overview.retention.drilldown.turnover
//               (the Retention block on /metrics/overview). The lowest level Hoops
//               has is store x area (total, new hire, stocking, digital, front end,
//               GM, food), and every figure is a ROLLING 12-month rate per pay
//               period — there is no per-team-lead or per-window turnover. So
//               "30/60/90/YTD" = the area's rate now vs ~30/60/90 days ago and at
//               FY start (PP01).
//   Nil picks — ISA Detail Power BI, Adj Reason "Nil Pick", per store x dept x item
//               x day (queries built with shared/pbi_query.js; transport captured
//               by market120's ISA source). No associate on these lines — items
//               are tied to a lead by the departments they own (DEPTS below).
//               ISA loads lag: windows end on the latest date with data.

import { targets, openTab, closeTab } from "../_cdp.mjs";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STORE = process.argv[2] || "1458";
const today = new Date();
const MARKET = process.argv[4] || "120";      // the store's market; Hoops' drilldown needs it
const DATE = process.argv[3] || new Date(today - today.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
const WINDOWS = [30, 60, 90];

// ── Who is a lead, and what they own ────────────────────────────────
// Department ownership is the store's own split from stockingplan/lib/shifts.js
// (job-code `area` hints, store 1458: F&C TL = grocery + 4-8-13-79, H&B TL =
// 2-40-46 + 3-19-67, Meat/Produce + 82, Seasonal = D18 + garden), with the rest
// of each group filled from Ops Portal's utils.dept.sbuIdDepts dept groups
// (same source as claimsdisposition/lib/categories.js).
// A title with no departments gets the store-wide top 10.
const DEPTS = {
  fc:        [1, 4, 8, 13, 79, 90, 91, 92, 95, 96],         // grocery + consumables
  hb:        [2, 40, 46, 3, 19, 67],                        // HBA + stationery, crafts, party
  hardlines: [9, 10, 11, 12, 37, 7],                        // sporting, auto, hardware, paint, toys
  ent:       [5, 6, 21, 58, 72, 77, 85, 87],                // entertainment, wireless, books
  seasonal:  [16, 18, 56],                                  // seasonal + garden
  home:      [14, 17, 20, 22, 71, 74],
  fashion:   [23, 24, 25, 26, 27, 29, 30, 31, 32, 33, 34, 35, 36],
  deli:      [80, 81, 97, 98],
  meatprod:  [93, 94, 82],
  acc:       [10],
};

// title regex → { turnover area (Hoops column prefix), dept areas }
const ROLES = [
  [/digital/i,                      { area: "digital",  depts: null }],
  [/stocking|overnight|modular/i,   { area: "stocking", depts: null }],
  [/front end/i,                    { area: "frontend", depts: null }],
  [/food (&|and) consumables coach/i,{ area: "food",    depts: ["fc", "deli", "meatprod"] }],
  [/food (&|and) consumables/i,     { area: "food",     depts: ["fc"] }],
  [/deli|bakery/i,                  { area: "food",     depts: ["deli"] }],
  [/meat|produce/i,                 { area: "food",     depts: ["meatprod"] }],
  [/health/i,                       { area: "gm",       depts: ["hb"] }],
  // No Entertainment TL is scheduled at 1458, so Hardlines carries entertainment.
  [/hardlines/i,                    { area: "gm",       depts: ["hardlines", "ent"] }],
  [/entertainment/i,                { area: "gm",       depts: ["ent"] }],
  [/seasonal/i,                     { area: "gm",       depts: ["seasonal"] }],
  [/fashion coach/i,                { area: "gm",       depts: ["fashion", "home"] }],
  [/home/i,                         { area: "gm",       depts: ["home"] }],
  [/fashion/i,                      { area: "gm",       depts: ["fashion"] }],
  [/\bacc\b/i,                      { area: "gm",       depts: ["acc"] }],
];
const LEAD_RE = /\bTL\b|team lead|\bcoach\b/i;
const roleFor = (title) => ROLES.find(([re]) => re.test(title))?.[1] ?? { area: "total", depts: null };

const AREA_LABEL = { total: "Store total", stocking: "Stocking", digital: "Digital", frontend: "Front End", gm: "GM", food: "Food" };

// ── CDP plumbing ────────────────────────────────────────────────────
async function withTab(url, settleMs, fn) {
  const c = await openTab(url);
  try { await new Promise((r) => setTimeout(r, settleMs)); return await fn(c); }
  finally { c.close(); await closeTab(c.tabId); }
}
const run = (c, fn, arg) => c.evalJs(`(${fn})(${JSON.stringify(arg)})`);

async function extensionId() {
  const sw = (await targets()).find((t) => /^chrome-extension:\/\/\w+\/background\/service_worker\.js$/.test(t.url));
  if (!sw) throw new Error("APAISuite service worker not found in the debug Edge (port 9222)");
  return new URL(sw.url).host;
}

// ── In-page functions (serialized; no closures) ─────────────────────
async function pageSchedule({ store, date }) {
  const { schedules } = await import("/modules/digitalmetrics/lib/firestore.js");
  const d = await schedules.get(store, date);
  return (d?.associates || []).map((a) => ({ name: a.name, jobName: a.jobName, shiftStart: a.shiftStart, shiftEnd: a.shiftEnd }));
}

async function pageNilPicks({ store, from }) {
  const q = await import("/shared/pbi_query.js");
  const key = "market120.pbiTransport";
  let t = (await chrome.storage.session.get(key))[key]?.isa;
  if (!t || Date.now() - (t.cachedAt || 0) > 40 * 60_000) {
    // Any ISA query makes market120 capture and cache a fresh transport.
    const isa = await import("/modules/market120/lib/sources/isa_powerbi.js");
    const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const warm = await isa.fetchIsaStoreDetail(store, { window: { from: day, to: day }, fyFrom: day });
    t = (await chrome.storage.session.get(key))[key]?.isa;
    if (!t) return { error: "No Power BI transport: " + (warm?.error || "capture failed") };
  }
  const body = q.buildQuery({
    modelId: t.modelId,
    from: [{ Name: "i", Entity: "ISA" }, { Name: "a", Entity: "Alignment" }],
    select: [
      ["Date", q.column("i", "Adj Date")], ["Dept", q.column("i", "Dept")], ["Cat", q.column("i", "Cat Desc")],
      ["Item", q.column("i", "Item Nbr")], ["UPC", q.column("i", "UPC")], ["Desc", q.column("i", "Item Desc")],
      ["Qty", q.aggregate("i", "Adj Qty", q.AGG.SUM)], ["Dollars", q.aggregate("i", "Adj $.", q.AGG.SUM)],
      ["Lines", q.aggregate("i", "Adj Qty", q.AGG.COUNT_NON_NULL)],
    ],
    where: [
      q.whereIn(q.column("a", "Store"), [store]),
      q.whereIn(q.column("i", "Adj Reason"), ["Nil Pick"]),
      q.whereDateRange(q.column("i", "Adj Date"), from),
    ],
  });
  const resp = await fetch(t.url, {
    method: "POST",
    headers: { Authorization: t.auth, "Content-Type": "application/json;charset=UTF-8", "X-PowerBI-HostEnv": "Power BI Web App" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) return { error: "Power BI HTTP " + resp.status };
  const json = await resp.json();
  const { complete, error } = q.readResult(json);
  if (error) return { error: "Power BI: " + error };
  if (!complete) return { error: "Power BI row cap hit; refusing a partial result" };
  return { rows: q.decodeRows(json) };
}

async function pageTurnover({ store, market, nowTi, timeInts }) {
  const DRILL = "/ops-portal/v1/trpc/metric.overview.retention.drilldown.turnover?input=";
  const CARD  = "/ops-portal/v1/trpc/metric.overview.retention.megaCard.turnover.turnover?input=";
  const get = async (path, input) => {
    const r = await fetch(path + encodeURIComponent(JSON.stringify({ json: input })));
    if (!r.ok) throw new Error("Hoops HTTP " + r.status + (/soteria|login/.test(r.url) ? " (signed out)" : ""));
    const d = (await r.json()).result.data.json;
    return d.rows.map((row) => Object.fromEntries(d.meta.columns.map((c, i) => [c, row[i]])));
  };
  // Monthly (timeType 302; timeInt = WM year*100 + month, 01 = Feb). The store
  // card lists the last 13 months; the latest with data anchors the windows.
  const card = await get(CARD, { buId: +store, buType: 6, timeType: 302 });
  // The store card lags a month behind the market drilldown (on 10/28 the card's
  // October row was empty while the drilldown had October), so anchor on the
  // calendar month and fall back to the card's latest only when that is empty.
  let latest = { timeInt: nowTi };
  const probe = await get(DRILL, { buId: +market, buType: 5, timeType: 302, timeInt: nowTi, hierarchyLevel: 6 }).catch(() => []);
  if (!probe.some((r) => String(r.storeNbr) === String(store))) {
    latest = card.filter((r) => r.totalTurnoverPct_Ty != null).at(-1);
    if (!latest) return { error: "Hoops has no turnover rows for store " + store };
  }
  // The drilldown (which also carries GM) only answers at market level — a
  // store-level request returns no rows — so ask for the market's stores.
  const byPp = {};
  await Promise.all(timeInts(latest.timeInt).map(async (w) => {
    const rows = await get(DRILL, { buId: +market, buType: 5, timeType: 302, timeInt: w.timeInt, hierarchyLevel: 6 }).catch(() => []);
    const mine = rows.find((r) => String(r.storeNbr) === String(store));
    if (mine) byPp[w.label] = { ...mine, timeInt: w.timeInt, timeText: card.find((c) => c.timeInt === w.timeInt)?.timeTextLong ??
      "WM" + String(Math.floor(w.timeInt / 100)).slice(2) + " " + ["Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec","Jan"][w.timeInt % 100 - 1] };
  }));
  if (!byPp.now) return { error: "Hoops drilldown has no row for store " + store + " in market " + market };
  return { latest: { timeInt: latest.timeInt, timeText: latest.timeText }, byPp };
}

// ── Main ────────────────────────────────────────────────────────────
const ext = await extensionId();
const extUrl = `chrome-extension://${ext}/app.html`;
const nilFrom = new Date(Date.parse(DATE) - 120 * 86_400_000).toISOString().slice(0, 10);

console.log(`[leader-brief] store ${STORE}, ${DATE}`);
const [schedule, nil] = await withTab(extUrl, 3000, async (c) => [
  await run(c, pageSchedule, { store: STORE, date: DATE }),
  await run(c, pageNilPicks, { store: STORE, from: nilFrom }),
]);
const leads = dedupe(schedule.filter((a) => LEAD_RE.test(a.jobName || "")));
console.log(`[leader-brief] ${schedule.length} scheduled, ${leads.length} leads/coaches`);
if (nil.error) console.warn("[leader-brief] nil picks:", nil.error);

const turnover = await withTab("https://hoops.wal-mart.com/ops-portal/", 8000, (c) =>
  c.evalJs(`(${pageTurnover})({ store: ${JSON.stringify(STORE)}, market: ${JSON.stringify(MARKET)}, nowTi: ${wmMonth(DATE)}, timeInts: ${monthWindows} })`));
if (turnover.error) console.warn("[leader-brief] turnover:", turnover.error);

const nilAnalysis = nil.rows ? analyzeNil(nil.rows) : null;
const { share, shareText } = buildShare();
const html = render({ leads, turnover, nil: nilAnalysis, nilError: nil.error });
const out = join(homedir(), "Downloads", `leader-brief-${STORE}-${DATE}.html`);
writeFileSync(out, html);
writeFileSync(out.replace(/\.html$/, ".txt"), shareText + "\n");
console.log("[leader-brief] wrote", out, "(+ .txt)");
console.log("\n" + shareText);

// ── Helpers ─────────────────────────────────────────────────────────
// Hoops months: timeInt = WM year*100 + month, 01 = Feb (202609 = Oct 2026).
// 30/60/90 days = 1/2/3 months back; FY start = month 01. Self-contained: it is
// serialized into the Hoops tab.
// Walmart month for a calendar date: Feb = 01 … Jan = 12 of the prior WM year.
function wmMonth(iso) {
  const [y, m] = iso.split("-").map(Number);
  return m >= 2 ? y * 100 + (m - 1) : (y - 1) * 100 + 12;
}

function monthWindows(latest) {
  const seq = (ti) => Math.floor(ti / 100) * 12 + (ti % 100) - 1;
  const ti = (n) => Math.floor(n / 12) * 100 + (n % 12) + 1;
  const now = seq(latest);
  return [
    { label: "now", timeInt: latest },
    { label: "30", timeInt: ti(now - 1) },
    { label: "60", timeInt: ti(now - 2) },
    { label: "90", timeInt: ti(now - 3) },
    { label: "6mo", timeInt: ti(now - 6) },
    { label: "fy", timeInt: Math.floor(latest / 100) * 100 + 1 },
  ];
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((a) => { const k = a.name + "|" + a.jobName; return seen.has(k) ? false : seen.add(k); })
    .sort((a, b) => a.jobName.localeCompare(b.jobName) || a.name.localeCompare(b.name));
}

function analyzeNil(rows) {
  const asOf = Math.max(...rows.map((r) => r.Date));
  const day = 86_400_000;
  const top = (deptSet, days) => {
    const since = asOf - (days - 1) * day;
    const m = new Map();
    for (const r of rows) {
      if (r.Date < since || (deptSet && !deptSet.has(Number(r.Dept)))) continue;
      const k = r.Item || String(r.UPC);
      const e = m.get(k) || { item: r.Item, upc: r.UPC, desc: r.Desc, dept: r.Dept, cat: r.Cat, nils: 0, units: 0, dollars: 0, days: new Set() };
      e.nils += r.Lines || 1; e.units += -(r.Qty || 0); e.dollars += -(r.Dollars || 0); e.days.add(r.Date);
      m.set(k, e);
    }
    const all = [...m.values()];
    return {
      totalNils: all.reduce((s, e) => s + e.nils, 0),
      items: all.sort((a, b) => b.nils - a.nils || b.units - a.units).slice(0, 10)
        .map((e) => ({ ...e, days: e.days.size, dollars: Math.round(e.dollars * 100) / 100 })),
    };
  };
  const cache = new Map();
  return {
    asOf: new Date(asOf).toISOString().slice(0, 10),
    topFor(deptKeys) {
      const key = deptKeys ? deptKeys.join(",") : "*";
      if (!cache.has(key)) {
        const set = deptKeys ? new Set(deptKeys.flatMap((k) => DEPTS[k])) : null;
        cache.set(key, Object.fromEntries(WINDOWS.map((d) => [d, top(set, d)])));
      }
      return cache.get(key);
    },
    unmappedDepts: [...new Set(rows.map((r) => Number(r.Dept)))]
      .filter((d) => !Object.values(DEPTS).some((l) => l.includes(d))).sort((a, b) => a - b),
  };
}

function printSummary() {
  const now = turnover.byPp?.now;
  for (const l of leads) {
    const role = roleFor(l.jobName);
    const pct = now?.[role.area + "TurnoverPct_Ty"];
    console.log(`  ${l.jobName.padEnd(28)} ${l.name.padEnd(24)} ${l.shiftStart}-${l.shiftEnd}  ${AREA_LABEL[role.area]} turnover ${pct ?? "—"}%`);
  }
}

// ── HTML ────────────────────────────────────────────────────────────
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }
function fmtPct(v) { return v == null ? "—" : v.toFixed(1) + "%"; }
function delta(now, then) {
  if (now == null || then == null) return "";
  const d = now - then;
  const cls = d > 0.05 ? "up" : d < -0.05 ? "down" : "";
  return ` <span class="d ${cls}">${d > 0 ? "+" : ""}${d.toFixed(1)}</span>`;
}

function turnoverTable(area) {
  const by = turnover.byPp || {};
  const col = area + "TurnoverPct_Ty";
  const now = by.now?.[col];
  const cells = [["This month", by.now], ["30 days ago", by["30"]], ["60 days ago", by["60"]], ["90 days ago", by["90"]], ["6 months ago", by["6mo"]], ["FY start", by.fy]];
  const goal = area === "total" ? by.now?.totalTurnoverGoalPct_Ty : null;
  return `<table class="t"><tr>${cells.map(([h, r]) => `<th>${h}${r?.timeText ? `<small>${esc(r.timeText)}</small>` : ""}</th>`).join("")}<th>New hire (now)</th></tr>
    <tr>${cells.map(([, r], i) => `<td>${fmtPct(r?.[col])}${i ? delta(now, r?.[col]) : ""}</td>`).join("")}<td>${fmtPct(by.now?.newHireTurnoverPct_Ty)}</td></tr></table>
    ${goal != null ? `<p class="note">Store goal ${fmtPct(goal)}</p>` : ""}`;
}

function nilTables(role) {
  if (!nilAnalysis) return `<p class="err">Nil picks unavailable: ${esc(state.nilError)}</p>`;
  const t = nilAnalysis.topFor(role.depts);
  const scope = role.depts ? "Depts " + role.depts.flatMap((k) => DEPTS[k]).join(", ") : "Store-wide (no department ownership)";
  return `<p class="note">${esc(scope)}</p><div class="nil">${WINDOWS.map((d) => `
    <div><h4>${d} days <small>${t[d].totalNils} nil picks</small></h4>
    <table class="t items"><tr><th>#</th><th>Item</th><th>Dept</th><th>Nils</th><th>Units</th><th>$</th></tr>
    ${t[d].items.map((e, i) => `<tr><td>${i + 1}</td><td>${esc(e.desc)}<small>${esc(e.item)} · UPC ${esc(e.upc)}</small></td><td>${esc(e.dept)}</td><td>${e.nils}</td><td>${e.units}</td><td>${e.dollars.toFixed(0)}</td></tr>`).join("") || `<tr><td colspan="6">None</td></tr>`}
    </table></div>`).join("")}</div>`;
}

// ── Shareable lines ─────────────────────────────────────────────────
// One sentence per lead, in the words the user asked for ("My current month to
// date turnover is x but it's improved x over the last 6 months"), and the same
// lines ranked best to worst by the 6-month change (a fall in turnover is good).
function MONTH(r) { return (r?.timeText || "").replace(/^WM\d+\s*/, ""); }
function shareFor(p) {
  const role = roleFor(p.jobName);
  const col = role.area + "TurnoverPct_Ty";
  const now = turnover.byPp?.now?.[col], then = turnover.byPp?.["6mo"]?.[col];
  if (now == null) return null;
  const area = role.area === "total" ? "store" : AREA_LABEL[role.area];
    let tail = "";
  if (then != null) {
    const d = now - then;
    tail = Math.abs(d) < 0.05
      ? `, flat over the last 6 months (${then.toFixed(1)}% in ${MONTH(turnover.byPp["6mo"])})`
      : d < 0
        ? ` and it's improved ${(-d).toFixed(1)} points over the last 6 months (down from ${then.toFixed(1)}% in ${MONTH(turnover.byPp["6mo"])})`
        : `, but it's gone up ${d.toFixed(1)} points over the last 6 months (from ${then.toFixed(1)}% in ${MONTH(turnover.byPp["6mo"])})`;
  }
  return { now, then, change: then == null ? null : now - then, text: `My current month-to-date ${area} turnover is ${now.toFixed(1)}%${tail}.` };
}
function buildShare() {
  const share = leads.map((p) => ({ p, ...shareFor(p) })).filter((m) => m.text);
  // Ranked by area (every lead in an area shares its number), best to worst.
  const areas = new Map();
  for (const m of share) {
    const area = roleFor(m.p.jobName).area;
    if (!areas.has(area)) areas.set(area, { area, now: m.now, then: m.then, change: m.change, names: [] });
    areas.get(area).names.push(m.p.name.split(/\s+/)[0].toLowerCase().replace(/^./, (c) => c.toUpperCase()));
  }
  const ranked = [...areas.values()].sort((a, b) => (a.change ?? 1e9) - (b.change ?? 1e9));
  const was = MONTH(turnover.byPp?.["6mo"]);
  const line = (r, i) => {
    const label = r.area === "total" ? "Store total" : AREA_LABEL[r.area];
    const move = r.change == null ? "" : Math.abs(r.change) < 0.05 ? `, flat since ${was}`
      : r.change < 0 ? `, improved ${(-r.change).toFixed(1)} pts since ${was} (${r.then.toFixed(1)}%) ✅`
      : `, up ${r.change.toFixed(1)} pts since ${was} (${r.then.toFixed(1)}%) ⚠️`;
    return `${i + 1}. ${label}: ${r.now.toFixed(1)}%${move} — ${[...new Set(r.names)].join(", ")}`;
  };
  const head = `Store ${STORE} turnover, ${MONTH(turnover.byPp?.now)} month to date vs 6 months ago (best to worst):`;
  const foot = "Rolling 12-month turnover from Hoops (Ops Portal → Retention). Lower is better.";
  return { share, shareText: ranked.length ? [head, ...ranked.map(line), foot].join("\n") : "" };
}

var state;
function render({ leads, turnover, nil, nilError }) {
  state = { nilError };
  const groups = new Map();
  for (const l of leads) {
    const role = roleFor(l.jobName);
    const key = role.area + "|" + (role.depts || []).join(",") + "|" + l.jobName;
    if (!groups.has(key)) groups.set(key, { role, title: l.jobName, people: [] });
    groups.get(key).people.push(l);
  }
  const sections = [...groups.values()].map((g) => `
    <section><h2>${esc(g.title)}</h2>
      <p class="who">${g.people.map((p) => `<b>${esc(p.name)}</b> ${esc(p.shiftStart)}–${esc(p.shiftEnd)}`).join(" · ")}</p>
      <h3>${AREA_LABEL[g.role.area]} turnover <small>rolling 12-month, Hoops Retention</small></h3>${turnoverTable(g.role.area)}
      ${g.people.map((p) => { const m = shareFor(p); return m ? `<p class="say">“${esc(m.text)}”</p>` : ""; }).join("")}
      <h3>Top 10 nil-picked items</h3>${nilTables(g.role)}
    </section>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Leader Brief ${esc(STORE)}</title><style>
:root{--bg:#fff;--fg:#1b1f24;--mut:#5b6470;--line:#d8dde3;--up:#b42318;--down:#067647;--head:#f3f5f7}
@media (prefers-color-scheme:dark){:root{--bg:#15181c;--fg:#e6e8eb;--mut:#9aa3ad;--line:#2d333a;--up:#f97066;--down:#47cd89;--head:#1d2126}}
body{background:var(--bg);color:var(--fg);font:14px/1.4 system-ui,Segoe UI,sans-serif;margin:0;padding:16px;max-width:1200px}
h1{margin:0 0 4px}h2{margin:0 0 4px;font-size:18px}h3{font-size:14px;margin:14px 0 6px}h4{margin:0 0 4px;font-size:13px}
small{display:block;color:var(--mut);font-weight:400;font-size:11px}h3 small,h4 small{display:inline;margin-left:6px}
section{border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:14px 0;break-inside:avoid}
.who,.note,.meta{color:var(--mut);margin:2px 0}.who b{color:var(--fg)}.err{color:var(--up)}
table.t{border-collapse:collapse;width:100%}.t th,.t td{border-bottom:1px solid var(--line);padding:4px 6px;text-align:left;vertical-align:top}
.t th{background:var(--head);font-size:12px}.d{font-size:11px;color:var(--mut)}.d.up{color:var(--up)}.d.down{color:var(--down)}
.share pre{white-space:pre-wrap;font:13px/1.5 system-ui,Segoe UI,sans-serif;margin:6px 0 0}.share button{font-size:12px;margin-left:8px}.say{margin:6px 0;padding:6px 10px;border-left:3px solid var(--line)}
.nil{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}.items td:nth-child(n+3){text-align:right;white-space:nowrap}
@media print{body{max-width:none}section{page-break-inside:avoid}}
</style></head><body>
<h1>Leader Brief — Store ${esc(STORE)}</h1>
<p class="meta">${esc(DATE)} · ${leads.length} team leads and coaches scheduled ·
turnover month ${esc(turnover.byPp?.now?.timeText || turnover.latest?.timeText || "—")} ·
nil picks through ${esc(nil?.asOf || "—")} (ISA Detail)</p>
<p class="meta">Turnover is Hoops' rolling 12-month rate for the lead's area (store-level; Hoops has no per-team split). Deltas are now minus then: red = turnover went up.
Nil-pick items are tied to a lead by department, not by who picked; leads without departments get the store-wide list.
${nil?.unmappedDepts?.length ? `Depts with nil picks not mapped to any area: ${nil.unmappedDepts.join(", ")}.` : ""}</p>
${share.length ? `<section class="share"><h2>Share: turnover, best to worst <button onclick="navigator.clipboard.writeText(document.getElementById('all').innerText)">Copy all</button></h2>
<pre id="all">${esc(shareText)}</pre></section>` : ""}
${turnover.error ? `<p class="err">Turnover unavailable: ${esc(turnover.error)}</p>` : ""}
${sections || "<p>No team leads or coaches on the schedule.</p>"}
</body></html>`;
}
