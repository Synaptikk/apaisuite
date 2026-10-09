// modules/orcmonitor/report.js
// Runs inside report.html (an extension page, so no inline scripts).
// Builds the market ORC brief from what view.js::_openReport saved in the
// module's IndexedDB (lib/cache.js), waits for photos, then opens the print
// dialog (Save as PDF).
//
// Layout, top to bottom:
//   header · bottom line (plain sentences) · key numbers · impacts table
//   (market stores in the forecast) · map · one dossier per group (photos,
//   heading + route driven, next stores, what they take, when they hit,
//   vehicles/trespass) · other people in range · footer.

import { loadReport } from "./lib/cache.js";

const GROUP_LIMIT = 10;
const IMPACT_HEAD = `<colgroup><col style="width:34px"><col style="width:22%"><col style="width:12%"><col><col style="width:12%"><col style="width:9%"><col style="width:22%"></colgroup>
  <thead><tr><th></th><th>Store</th><th>Risk index</th><th>Groups heading there</th><th class="r">Nearest</th><th class="r">Expected</th><th>What they take</th></tr></thead>`;
const DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
const riskColor = s => s >= 70 ? "#B91C1C" : s >= 45 ? "#B45309" : "#A16207";
const money = v => "$" + Math.round(v ?? 0).toLocaleString("en-US");
const shortDate = iso => {
  if (!iso) return "";
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00`);
  return isNaN(d) ? iso : d.toLocaleDateString("en-US", { weekday:"short", month:"short", day:"numeric" });
};
/** "Walmart 3660 - 3550 Cummings Hwy, Chattanooga, TN" / "1458 - …" / "Store 1458" → "1458" */
function storeNum(name) {
  const s = String(name ?? "");
  const m = s.match(/^\s*walmart\s+(\d{1,5})\b/i) || s.match(/^\s*(\d{1,5})\b/) ||
            s.match(/#\s*(\d{1,5})\b/) || s.match(/\bstore\s*(\d{1,5})\b/i);
  return m ? String(Number(m[1])) : null;
}
/** → "3660 · Chattanooga, TN" (store number + city, state when the name has them) */
function storeLabel(name) {
  const s = String(name ?? "").trim();
  const num = storeNum(s);
  if (!num) return s || "?";
  const parts = s.split(",").map(x => x.trim()).filter(x => x && !/^(\d{5}(-\d{4})?|USA?|United States)$/i.test(x));
  if (parts.length >= 3) return `${num} · ${parts[parts.length - 2]}, ${parts[parts.length - 1].split(" ")[0]}`;
  const rest = s.replace(/^\s*(walmart\s+)?\d{1,5}\s*[-–:]\s*/i, "").split(",")[0].trim();
  return rest && rest !== s && !/^store\b/i.test(s) ? `${num} · ${rest}` : `Store ${num}`;
}

(async () => {
  const data = await loadReport().catch(err => { console.error("[orcmonitor report]", err); return null; });
  if (!data) {
    document.getElementById("loading").innerHTML =
      "<p style='color:#B91C1C;padding:20px'>Report data not found.<br>Click Export PDF again from the ORC Monitor.</p>";
    return;
  }

  const { threats = [], target = {}, storeNum: homeStore = "?", generatedAt, mapPng,
          atRisk = [], groups = [], lookbackDays = 30, market = null } = data;
  const now = new Date(generatedAt || Date.now());
  const marketSet = new Set((market?.stores ?? []).map(String));
  const inMarket = num => marketSet.has(String(num));
  const scopeName = market?.label ?? `Store ${homeStore}`;

  // Market stores in the forecast (the list the brief is for), then the rest.
  const marketRisk = atRisk.filter(s => inMarket(s.num));
  const otherRisk  = atRisk.filter(s => !inMarket(s.num)).slice(0, 5);

  // Groups whose forecast touches the market first.
  const touches = g => (g.next ?? []).filter(s => inMarket(storeNum(s.name)));
  const ordered = [...groups].sort((a, b) =>
    (touches(b).length ? 1 : 0) - (touches(a).length ? 1 : 0) ||
    (b.risk ?? 0) - (a.risk ?? 0) || (b.weight ?? 0) - (a.weight ?? 0)).slice(0, GROUP_LIMIT);
  const headedIn = ordered.filter(g => touches(g).length);

  const people = ordered.flatMap(g => g.members);
  const highPeople = threats.filter(t => t.riskScore >= 70).length;
  const valueOnFile = people.reduce((s, m) => s + (m.totalValue ?? 0), 0);
  const allItems = tallyItems(people);

  // ── Bottom line ────────────────────────────────────────────────────────────
  const lines = [];
  if (headedIn.length) {
    lines.push(`<b>${headedIn.length} group${headedIn.length === 1 ? " is" : "s are"}</b> projected to reach ${esc(scopeName)} stores based on their route over the last ${lookbackDays} days.`);
    const top = marketRisk[0];
    if (top) {
      const g = top.groups[0];
      lines.push(`Most exposed: <b>${esc(storeLabel(top.name))}</b> — ${esc(g.label)}${g.heading ? `, ${esc(g.heading)}` : ""}, about <b>${g.routeMiles} route miles</b> from their last hit${g.due ? ", <b>next hit due any day</b>" : g.etaDate ? `, next hit expected around <b>${esc(shortDate(g.etaDate))}</b>` : ""}.`);
    }
  } else {
    lines.push(`No group's current route points into ${esc(scopeName)}. ${ordered.length} group${ordered.length === 1 ? " is" : "s are"} active within 300 miles and ${ordered.length === 1 ? "is" : "are"} listed below for awareness.`);
  }
  if (allItems.length) lines.push(`Most-taken merchandise across these groups: <b>${allItems.slice(0, 4).map(i => esc(i.name)).join(", ")}</b>.`);
  const agg = sumGrids(people);
  const peak = peakText(agg);
  if (peak) lines.push(`Activity peaks <b>${esc(peak)}</b> — staff and watch accordingly.`);

  // ── Sections ───────────────────────────────────────────────────────────────
  const impactRows = (list, dim) => list.map((s, i) => {
    const g0 = s.groups[0] ?? {};
    const groupsTxt = s.groups.slice(0, 3).map(g => esc(g.label)).join("<br>");
    const items = tallyItems(ordered.filter(g => s.groups.some(x => x.id === g.id)).flatMap(g => g.members))
      .slice(0, 3).map(i => esc(i.name)).join(", ");
    return `<tr${dim ? ' class="dim"' : ""}>
      <td class="c"><span class="rank">${i + 1}</span></td>
      <td><b>${esc(storeLabel(s.name))}</b>${String(s.num) === String(Number(homeStore)) ? ' <span class="you">YOUR STORE</span>' : ""}</td>
      <td class="c"><div class="idx"><i style="width:${s.index}%"></i></div><span class="mut">${s.index}</span></td>
      <td>${groupsTxt}</td>
      <td class="r">${g0.routeMiles ?? "—"} mi${g0.heading ? `<br><span class="mut">${esc(g0.heading)}</span>` : ""}</td>
      <td class="r">${g0.due ? "Due now" : g0.etaDate ? esc(shortDate(g0.etaDate)) : "—"}</td>
      <td>${items || '<span class="mut">—</span>'}</td>
    </tr>`;
  }).join("");

  const impacts = marketRisk.length
    ? `<table class="tbl imp">${IMPACT_HEAD}
       <tbody>${impactRows(marketRisk)}</tbody></table>`
    : `<p class="mut">None of ${esc(scopeName)}'s stores are in any group's forecast right now.</p>`;
  const nearby = otherRisk.length
    ? `<h3>Just outside ${esc(scopeName)}</h3><table class="tbl imp">${IMPACT_HEAD}<tbody>${impactRows(otherRisk, true)}</tbody></table>` : "";

  const dossiers = ordered.map(g => dossier(g, inMarket, homeStore)).join("");

  const inGroups = new Set(people.map(m => String(m.personId)));
  const others = threats.filter(t => !inGroups.has(String(t.personId))).slice(0, 25);
  const othersTbl = others.length ? `
    <section class="blk"><h2>Other ORC subjects within 300 miles</h2>
    <table class="tbl"><thead><tr><th>Name</th><th>Last seen</th><th class="r">Miles</th><th>MO</th><th>Takes</th><th class="r">Risk</th></tr></thead><tbody>
    ${others.map(t => `<tr><td><a href="${esc(t.aurorUrl)}">${esc(t.name)}</a></td>
      <td>${esc(storeLabel(t.lastSeenStore))} <span class="mut">${esc(shortDate(t.lastSeenDate))}</span></td>
      <td class="r">${t.currentDist ?? ""}</td><td>${esc(t.primaryMo ?? "")}</td>
      <td>${(t.products ?? []).slice(0, 3).map(p => esc(p.name)).join(", ") || (t.productsTargeted ?? []).slice(0, 3).map(esc).join(", ")}</td>
      <td class="r" style="color:${riskColor(t.riskScore)};font-weight:700">${t.riskScore}</td></tr>`).join("")}
    </tbody></table></section>` : "";

  document.title = `ORC Market Brief — ${scopeName} — ${now.toLocaleDateString("en-US")}`;
  document.head.insertAdjacentHTML("beforeend", `<style>${CSS}</style>`);
  document.body.innerHTML = `
<div class="page">
  <header class="hdr">
    <div>
      <div class="kicker">Walmart Asset Protection · Internal use only</div>
      <h1>ORC Market Brief</h1>
      <div class="sub">${esc(scopeName)} · prepared from ${esc(storeLabel(`${homeStore}`))} · last ${lookbackDays} days of Auror ORC events</div>
    </div>
    <div class="hdr-r">
      <div class="date">${now.toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric", year:"numeric" })}</div>
      <div>${now.toLocaleTimeString("en-US", { hour:"numeric", minute:"2-digit" })}</div>
    </div>
  </header>

  <section class="bl">
    <div class="bl-t">Bottom line</div>
    ${lines.map(l => `<p>${l}</p>`).join("")}
  </section>

  <div class="kpis">
    ${kpi(headedIn.length, `group${headedIn.length === 1 ? "" : "s"} headed into ${esc(market?.short ?? "the area")}`, "#5B21B6")}
    ${kpi(marketRisk.length, `${esc(market?.short ?? "area")} store${marketRisk.length === 1 ? "" : "s"} in forecast`, "#B91C1C")}
    ${kpi(highPeople, "high-risk subjects in range", "#B45309")}
    ${kpi(money(valueOnFile), "loss on file, these groups", "#0F766E")}
  </div>

  <section class="blk">
    <h2>Impacts headed your way</h2>
    <p class="note">Risk index 100 = the most exposed store in this brief.</p>
    ${impacts}
    ${nearby}
  </section>

  ${mapPng ? `<section class="blk keep"><h2>Route map</h2>
    <img class="map" src="${mapPng}" alt="Map of ORC group positions and at-risk stores">
    <div class="cap">Numbered purple circles = at-risk stores (rank) · coloured dots = each group's last hit (red high, amber medium) · blue = ${esc(storeLabel(homeStore))} with 50/100/200-mile rings. Basemap USGS The National Map.</div>
  </section>` : ""}

  <h2 class="sec-h">Group dossiers</h2>
  ${dossiers || '<p class="mut">No groups within range.</p>'}

  ${othersTbl}

  <footer class="ftr">
    <div>Forecasts are projections from past movement, not confirmed intelligence. Verify in Auror before acting. Internal AP distribution only.</div>
  </footer>

  <div class="no-print actions">
    <button id="btn-print">Print / Save as PDF</button>
    <p>In the print dialog choose <b>Save as PDF</b>, then attach it to your market email.</p>
  </div>
</div>`;

  document.getElementById("btn-print")?.addEventListener("click", () => window.print());

  // Print once photos have loaded (or failed), so the PDF isn't full of blanks.
  const imgs = [...document.images];
  await Promise.race([
    Promise.all(imgs.map(img => img.complete ? null : new Promise(r => {
      img.addEventListener("load", r, { once:true });
      img.addEventListener("error", () => { img.classList.add("broken"); r(); }, { once:true });
    }))),
    new Promise(r => setTimeout(r, 10_000)),
  ]);
  await new Promise(r => setTimeout(r, 300));
  // dev/orcmonitor-e2e.mjs sets this to render the brief without a dialog.
  const np = await chrome.storage.session.get("orcmonitor.report_noprint").catch(() => ({}));
  if (np?.["orcmonitor.report_noprint"]) { await chrome.storage.session.remove("orcmonitor.report_noprint"); document.body.dataset.ready = "1"; return; }
  document.body.dataset.ready = "1";
  window.print();
})();

// ── Dossier ─────────────────────────────────────────────────────────────────

function dossier(g, inMarket, homeStore) {
  const members = g.members ?? [];
  const items = tallyItems(members);
  const grid = sumGrids(members);
  const peak = peakText(grid);
  const mo = tally(members.flatMap(m => Object.entries(m.moBreakdown ?? {})));
  const vehicles = [...new Set(members.flatMap(m => m.vehicles ?? []))].slice(0, 4);
  const trespass = [...new Set(members.flatMap(m => m.trespassNotices ?? []))].slice(0, 4);
  const threatening = members.some(m => m.threatening);
  const value = members.reduce((s, m) => s + (m.totalValue ?? 0), 0);

  const photos = members.slice(0, 4).map(m => `
    <figure class="ph">
      ${m.photo ? `<img src="${esc(m.photo)}" alt="">` : `<div class="noph">No photo</div>`}
      <figcaption><b>${esc(m.name && m.name !== "Name Unknown" ? m.name : "Unidentified")}</b><br><span class="mut">${esc(m.physicalDesc ?? "")}</span>
        <br><span style="color:${riskColor(m.riskScore)};font-weight:700">Risk ${m.riskScore}</span> · <a href="${esc(m.aurorUrl)}">Auror</a></figcaption>
    </figure>`).join("");
  const moreMembers = members.length > 4
    ? `<div class="mut small">+ ${members.length - 4} more: ${members.slice(4).map(m => esc(m.name)).join(", ")}</div>` : "";

  const next = (g.next ?? []).slice(0, 6).map((s, i) => {
    const mk = inMarket(storeNum(s.name));
    return `<span class="chip${mk ? " mk" : ""}">${i + 1}. <b>${esc(storeLabel(s.name))}</b> · ${s.routeMiles} mi${s.due ? " · due now" : s.etaDate ? ` · ~${esc(shortDate(s.etaDate))}` : ""}${s.repeat ? " · hit before" : ""}</span>`;
  }).join("");

  const legs = (g.legs ?? []).map(l => `<tr><td>${esc(shortDate(l.date))}</td>
    <td>${esc(storeLabel(l.from))} → <b>${esc(storeLabel(l.to))}</b></td>
    <td class="route">${esc(l.summary)}</td><td class="r">${l.miles} mi</td><td class="r">${l.days} d</td></tr>`).join("");

  const tr = g.directional ? g.targetRoute : null;
  const toHome = tr ? (tr.ahead
      ? `${esc(storeLabel(homeStore))} is <b>${tr.miles} route miles ahead</b> of their last hit.`
      : tr.mode === "traveling"
        ? `${esc(storeLabel(homeStore))} is behind their direction of travel (${tr.crowMiles} mi straight line).`
        : `${esc(storeLabel(homeStore))} is outside their usual area (${tr.crowMiles} mi straight line).`) : "";

  const maxItem = items[0]?.count || 1;
  return `
<section class="dos keep">
  <div class="dos-h" style="border-left-color:${riskColor(g.risk)}">
    <div>
      <div class="dos-t">${esc(g.label)} <span class="mode ${g.mode}">${{ traveling:"On the move", circuit:"Local circuit", single:"Single hit" }[g.mode] ?? ""}</span>${threatening ? ' <span class="warn">⚠ Threatening behavior on file</span>' : ""}</div>
      <div class="mut">${esc(g.modeLine)} · last hit ${esc(shortDate(g.lastDate))} at ${esc(storeLabel(g.lastSite))} (${g.recencyDays ?? "?"} days ago) · ${members.length} ${members.length === 1 ? "person" : "people"} · ${money(value)} on file</div>
    </div>
    <div class="dos-risk" style="color:${riskColor(g.risk)}">${g.risk}<small>risk</small></div>
  </div>
  ${(g.riskWhy ?? []).length ? `<div class="why"><b>Why risk ${g.risk}:</b> ${g.riskWhy.map(esc).join(" · ")}</div>` : ""}
  <div class="phs">${photos}</div>${moreMembers}
  <div class="cols">
    <div>
      <h4>${g.directional ? "Likely next stores" : "Nearest stores (no direction yet)"} <span class="legend-mk">red = your market</span></h4>
      ${next ? `<div class="chips">${next}</div>` : '<p class="mut small">Not enough route history to project.</p>'}
      ${toHome ? `<p class="small">${toHome}</p>` : ""}
      <h4>What they take</h4>
      ${items.length ? `<table class="items">${items.slice(0, 8).map(i => `<tr><td>${esc(i.name)}</td><td class="bar"><i style="width:${Math.round(i.count / maxItem * 100)}%"></i></td><td class="r mut">${i.count}</td></tr>`).join("")}</table>`
        : '<p class="mut small">No products recorded.</p>'}
      ${mo.length ? `<p class="small"><b>MO:</b> ${mo.slice(0, 4).map(([k, v]) => `${esc(k)} ×${v}`).join(" · ")}</p>` : ""}
    </div>
    <div>
      <h4>When they hit${peak ? ` — <span class="peak">${esc(peak)}</span>` : ""}</h4>
      ${heatmap(grid)}
      ${vehicles.length ? `<h4>Vehicles</h4><p class="small">🚗 ${vehicles.map(esc).join(" · ")}</p>` : ""}
      ${trespass.length ? `<h4>Trespass notices</h4><p class="small">${trespass.map(esc).join("<br>")}</p>` : ""}
    </div>
  </div>
  ${legs ? `<h4>Route driven (oldest first)</h4><table class="tbl legs"><tbody>${legs}</tbody></table>` : ""}
</section>`;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function kpi(v, label, color) {
  return `<div class="kpi"><div class="kv" style="color:${color}">${v}</div><div class="kl">${label}</div></div>`;
}

function tally(pairs) {
  const m = new Map();
  for (const [k, v] of pairs) m.set(k, (m.get(k) ?? 0) + (Number(v) || 0));
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
function tallyItems(people) {
  const pairs = people.flatMap(m => (m.products?.length ? m.products.map(p => [p.name, p.count])
                                                          : (m.productsTargeted ?? []).map(n => [n, 1])));
  return tally(pairs).map(([name, count]) => ({ name, count }));
}

function sumGrids(people) {
  const g = Array.from({ length: 7 }, () => new Array(24).fill(0));
  let anyDay = false;
  for (const m of people) {
    const dh = m.dayHour;
    if (dh && dh.some(r => r.some(v => v))) {
      anyDay = true;
      dh.forEach((row, d) => row.forEach((v, h) => { g[d][h] += v; }));
    }
  }
  if (!anyDay) {   // no weekday split recorded: hours only, one row
    const hours = new Array(24).fill(0);
    for (const m of people) (m.hourCounts ?? []).forEach((v, h) => { hours[h] += v; });
    return { hoursOnly: true, rows: [hours] };
  }
  return { hoursOnly: false, rows: g };
}

function peakText(grid) {
  const hours = new Array(24).fill(0), days = new Array(7).fill(0);
  grid.rows.forEach((row, d) => row.forEach((v, h) => { hours[h] += v; if (!grid.hoursOnly) days[d] += v; }));
  const total = hours.reduce((a, b) => a + b, 0);
  if (!total) return "";
  // Best 3-hour window.
  let best = 0, at = 0;
  for (let h = 0; h < 24; h++) {
    const s = hours[h] + hours[(h + 1) % 24] + hours[(h + 2) % 24];
    if (s > best) { best = s; at = h; }
  }
  const win = `${fmtH(at)}–${fmtH((at + 3) % 24)}`;
  if (grid.hoursOnly) return win;
  const topDays = days.map((v, d) => [v, d]).sort((a, b) => b[0] - a[0]).filter(([v]) => v > 0).slice(0, 2).map(([, d]) => DAYS[d]);
  return `${topDays.join(" & ")}, ${win}`;
}
const fmtH = h => h === 0 ? "12am" : h < 12 ? `${h}am` : h === 12 ? "12pm" : `${h - 12}pm`;

function heatmap(grid) {
  const max = Math.max(1, ...grid.rows.flat());
  const labels = grid.hoursOnly ? ["All days"] : DAYS;
  const head = `<tr><th></th>${Array.from({ length: 24 }, (_, h) => `<th>${h % 3 === 0 ? fmtH(h).replace("am", "a").replace("pm", "p") : ""}</th>`).join("")}</tr>`;
  const body = grid.rows.map((row, d) => `<tr><th>${labels[d]}</th>${row.map(v => {
    const a = v ? 0.15 + 0.85 * (v / max) : 0;
    return `<td style="background:${v ? `rgba(185,28,28,${a.toFixed(2)})` : "#F3F4F6"}" title="${v}"></td>`;
  }).join("")}</tr>`).join("");
  return `<table class="hm">${head}${body}</table>`;
}

const CSS = `
  *{box-sizing:border-box}
  body{font-family:'Segoe UI',Arial,sans-serif;margin:0;background:#fff;color:#111827;font-size:12px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  a{color:#0053A0}
  .page{max-width:880px;margin:0 auto;padding:26px}
  @media print{@page{size:letter;margin:0.4in}.page{padding:0;max-width:none}.no-print{display:none!important}.keep{break-inside:avoid}}
  .hdr{background:#002D72;color:#fff;border-radius:8px;padding:16px 22px;display:flex;justify-content:space-between;gap:16px}
  .kicker{font-size:9.5px;letter-spacing:1.2px;text-transform:uppercase;color:#A8C7FA}
  h1{font-size:22px;margin:3px 0 2px}
  .sub{font-size:12px;color:#CFE0FB}
  .hdr-r{text-align:right;font-size:11px;color:#CFE0FB}.hdr-r .date{font-size:14px;font-weight:700;color:#fff}
  .bl{margin:14px 0;border:1px solid #FCD34D;background:#FFFBEB;border-radius:8px;padding:10px 16px}
  .bl-t{font-size:10px;font-weight:800;letter-spacing:.8px;text-transform:uppercase;color:#92400E;margin-bottom:4px}
  .bl p{margin:4px 0;line-height:1.45;font-size:12.5px}
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px}
  .kpi{border:1px solid #E5E7EB;border-radius:8px;padding:9px 10px;text-align:center}
  .kv{font-size:24px;font-weight:800;line-height:1.1}.kl{font-size:10px;color:#4B5563;text-transform:uppercase;letter-spacing:.3px;margin-top:3px}
  h2{font-size:14px;margin:0 0 6px;padding-bottom:4px;border-bottom:2px solid #002D72;color:#002D72}
  h3{font-size:12px;margin:10px 0 4px;color:#374151}
  h4{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#4B5563;margin:10px 0 4px}
  .sec-h{margin-top:18px}
  .blk{margin-bottom:16px}
  .note{font-size:11px;color:#4B5563;margin:0 0 8px;line-height:1.4}
  .mut{color:#6B7280}.small{font-size:11px}
  .tbl{width:100%;border-collapse:collapse}
  .tbl th{font-size:9.5px;text-transform:uppercase;letter-spacing:.3px;color:#6B7280;text-align:left;padding:4px 6px;border-bottom:1px solid #D1D5DB}
  .tbl td{padding:5px 6px;border-bottom:1px solid #EEF0F3;vertical-align:top;font-size:11.5px}
  .tbl tr.dim td{color:#4B5563}
  .r{text-align:right}.c{text-align:center}
  .rank{display:inline-block;width:22px;height:22px;line-height:18px;border-radius:50%;border:2px solid #7C3AED;color:#5B21B6;font-weight:800;text-align:center}
  .you{font-size:9px;font-weight:800;color:#166534;background:#DCFCE7;border-radius:3px;padding:1px 4px}
  .idx{height:6px;width:70px;background:#E5E7EB;border-radius:3px;overflow:hidden;margin:4px auto 2px}.idx i{display:block;height:100%;background:#7C3AED}
  .map{width:100%;display:block;border:1px solid #D1D5DB;border-radius:6px}
  .cap{font-size:9.5px;color:#6B7280;margin-top:4px}
  .dos{border:1px solid #D1D5DB;border-radius:8px;padding:0 14px 12px;margin-bottom:14px}
  .dos-h{display:flex;justify-content:space-between;gap:10px;border-left:5px solid;margin:0 -14px 10px;padding:10px 14px;background:#F9FAFB;border-radius:8px 8px 0 0}
  .dos-t{font-size:14px;font-weight:800}
  .dos-risk{font-size:26px;font-weight:800;text-align:center;line-height:1}.dos-risk small{display:block;font-size:9px;color:#6B7280;text-transform:uppercase}
  .mode{font-size:9.5px;font-weight:800;text-transform:uppercase;border-radius:999px;padding:2px 7px;vertical-align:middle}
  .mode.traveling{background:#EDE9FE;color:#5B21B6}.mode.circuit{background:#DBEAFE;color:#1E40AF}.mode.single{background:#F3F4F6;color:#4B5563}
  .warn{font-size:10px;color:#B91C1C;font-weight:800}
  .why{font-size:10.5px;color:#4B5563;margin:-4px 0 8px}
  .phs{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
  .ph{margin:0}.ph img,.ph .noph{width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:6px;border:1px solid #E5E7EB;display:block;background:#F3F4F6}
  .ph img.broken{visibility:hidden}
  .ph .noph{display:flex!important;align-items:center;justify-content:center;color:#9CA3AF;font-size:11px;aspect-ratio:auto;height:64px}
  .legend-mk{font-size:9px;font-weight:600;color:#B91C1C;text-transform:none;letter-spacing:0;margin-left:6px}
  .tbl.imp{table-layout:fixed}
  .ph figcaption{font-size:10.5px;margin-top:4px;line-height:1.35}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .chips{display:flex;flex-wrap:wrap;gap:4px}
  .chip{font-size:10.5px;border:1px solid #DDD6FE;background:#F5F3FF;color:#3B0764;border-radius:5px;padding:2px 6px}
  .chip.mk{border-color:#B91C1C;background:#FEF2F2;color:#7F1D1D}
  .items{width:100%;border-collapse:collapse}.items td{padding:2px 4px;font-size:11px}
  .items .bar{width:40%}.items .bar i{display:block;height:7px;background:#0F766E;border-radius:3px}
  .hm{border-collapse:separate;border-spacing:1px;width:100%}
  .hm th{font-size:8px;color:#6B7280;font-weight:600;text-align:left;padding:0 2px}
  .hm td{height:11px;border-radius:2px}
  .peak{color:#B91C1C;text-transform:none;letter-spacing:0}
  .legs td{font-size:10.5px}.legs .route{color:#0053A0;font-weight:600}
  .ftr{margin-top:18px;padding-top:8px;border-top:1px solid #E5E7EB;font-size:9.5px;color:#6B7280;line-height:1.5}
  .actions{text-align:center;margin:20px 0}
  .actions button{background:#002D72;color:#fff;border:none;border-radius:6px;padding:11px 30px;font-size:14px;font-weight:600;cursor:pointer}
  .actions p{font-size:11px;color:#6B7280}
`;
