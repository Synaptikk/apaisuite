// modules/vizpick/lib/card_report.js
//
// Turn one store card into something that leaves the screen: a printable page
// or the body of an email.
//
// Pure builders — no DOM, no window, no chrome.*. view.js does the opening and
// printing; everything here is a string in, a string out, which is what makes
// the truncation rules and the "what does a missing value print as" decisions
// testable. Those are the parts that get quietly wrong otherwise.
//
// THREE OUTPUTS, DELIBERATELY NOT ONE
// -----------------------------------
// buildPerformanceHtml — what is bad and who. Ranked by severity, everything
//   under goal marked. A sheet to be READ, in a meeting or on a wall. Needs an
//   opts.names resolver to show names rather than WINs — see cardAssociates().
// buildPickListHtml — the bins that still hold picks, grouped by bin group and
//   ordered by location. A sheet to be WALKED, with a tick box per bin and no
//   names on it.
// buildCardEmail — plain text, because a mailto: body cannot carry markup and
//   half the recipients read it on a phone.
//
// The first two are NOT the same data in two skins. They sort differently on
// purpose: severity answers "where is the problem", walk order answers "what
// do I do next". Handing someone a severity-ranked pull list would send them
// back and forth across the backroom.
//
// ON mailto: LENGTH
// -----------------
// Windows caps a mailto: URL somewhere around 2 KB and silently truncates past
// it — the mail client opens with a body that just stops. A card with 30
// departments and 10 associates blows through that easily, so buildCardEmail()
// trims to fit and SAYS it trimmed, rather than letting the client cut a
// sentence in half.

import { gaugeSvg } from "./charts.js";
import { rollUpSkippedByAssociate } from "./parse_vizpick_stores_csv.js";

// Practical ceiling for the whole encoded mailto: URL. Below the ~2000 the
// shell actually enforces, leaving room for the subject and the scheme.
export const MAILTO_MAX = 1900;

const pct = (v) => (Number.isFinite(v) ? `${Math.round(v)}%` : "—");
const ratio = (a, b) =>
  Number.isFinite(a) && Number.isFinite(b) && b > 0 ? `${a} / ${b}` : null;

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/**
 * The four rings, in the dashboard's own order, with their real
 * numerator/denominator where the export publishes one.
 *
 * Cases and Picks are the only two with a genuine pair behind them — see the
 * note at the top of parse_vizpick_stores_csv.js. A ratio is never derived by
 * dividing a rounded percentage back out.
 */
export function cardRings(r) {
  return [
    { label: "Cases Seen", value: r?.casesSeenPct, goal: 95, ratio: ratio(r?.casesSeen, r?.casesExpected) },
    { label: "Locations",  value: r?.locationPct,  goal: 95, ratio: null },
    { label: "Picks",      value: r?.pickPct,      goal: 90, ratio: ratio(r?.picksCompleted, r?.picksSuggested) },
    { label: "Overstock",  value: r?.overstockPct, goal: 90, ratio: null },
  ];
}

/** Departments worst-pick-first, the same order the card shows them in. */
export function cardDepts(r, limit = Infinity) {
  const depts = Array.isArray(r?.depts) ? r.depts : [];
  return [...depts]
    .filter((d) => d && d.dept)
    .sort((a, b) => (a.pickPct ?? 101) - (b.pickPct ?? 101))
    .slice(0, limit);
}

/**
 * Associates with picks left behind, worst first, with real names attached.
 *
 * `names` is REQUIRED to get names at all, and that is the whole point of it
 * being a parameter. The roll-up works off the location export, which carries
 * only a WIN — the display name lives in shared/associateDirectory.js, resolved
 * asynchronously by the view. Without a resolver these builders literally
 * cannot know anyone's name, which is why the first version of this printed a
 * column of ids: it took the row and nothing else, and `a.name` was never
 * going to be defined on it.
 *
 * Falling back to the WIN stays correct when a lookup genuinely failed —
 * better an id than a confidently wrong name on a list about who is not doing
 * their picks.
 *
 * @param {object} r
 * @param {object} [opts]
 * @param {number} [opts.limit=10]
 * @param {(win:string)=>string|null|undefined} [opts.names]  WIN → display name.
 */
export function cardAssociates(r, opts = {}) {
  // Tolerate the old positional signature (a bare limit) so a stale caller
  // degrades to "no names" rather than crashing on opts.limit of a number.
  const { limit = 10, names = null } = typeof opts === "number" ? { limit: opts } : opts;
  const gaps = r?.locations?.gaps;
  if (!Array.isArray(gaps) || !gaps.length) return [];
  return rollUpSkippedByAssociate(gaps).associates
    .slice(0, limit)
    .map((a) => {
      const resolved = typeof names === "function" ? names(a.win) : null;
      return { ...a, name: (resolved && String(resolved).trim()) || a.name || null };
    });
}

/**
 * A one-line provenance stamp.
 *
 * Reports outlive the screen they were made on, so a printed card with no "as
 * of" is worse than no card — someone will read yesterday's numbers as today's
 * next week. This is Tableau's OWN publish time where we have it, falling back
 * to when we captured, and it says which.
 */
export function cardStamp({ sourceUpdate, capturedAt, isToday } = {}) {
  const src = sourceUpdate?.iso
    ? new Date(sourceUpdate.iso).toLocaleString()
    : sourceUpdate?.raw || null;
  if (src) return `Data as of ${src} (Tableau's last update)`;
  if (capturedAt) return `Captured ${new Date(capturedAt).toLocaleString()}`;
  return isToday ? "Current day — capture time unknown" : "Capture time unknown";
}

/**
 * Plain-text body for an email. Also the fallback if printing is blocked.
 *
 * @param {object} r      A vizpick store row.
 * @param {object} [meta] { sourceUpdate, capturedAt, isToday, market }
 * @param {object} [opts] { maxLen, names }. `names` is a WIN → display-name
 *   resolver; without it the associate lines print bare WINs, because the row
 *   itself carries no names. See cardAssociates().
 * @returns {{subject:string, body:string, truncated:boolean}}
 */
export function buildCardEmail(r, meta = {}, opts = {}) {
  const { maxLen = MAILTO_MAX } = opts;
  const store = String(r?.store ?? "?");
  const subject = `VizPick — Store ${store}${meta.isToday ? " (current day)" : ""}`;

  const head = [
    `VizPick — Store ${store}${meta.market ? ` · Market ${meta.market}` : ""}`,
    cardStamp(meta),
    "",
    `Overall: ${pct(r?.vizpick)}`,
    ...cardRings(r).map((g) =>
      `  ${g.label}: ${pct(g.value)}${g.ratio ? ` (${g.ratio})` : ""}  goal ${g.goal}%`),
  ];

  const deptLines = cardDepts(r).map((d) =>
    `  Dept ${d.dept}: ${pct(d.pickPct)} pick` +
    (ratio(d.suggestedPicksCompleted, d.suggestedPicks) ? ` (${ratio(d.suggestedPicksCompleted, d.suggestedPicks)})` : ""));

  const assoc = cardAssociates(r, { names: opts.names });
  const assocLines = assoc.map((a) =>
    `  ${a.name || a.win}: ${a.skipped} left in ${a.bins.length} bin${a.bins.length === 1 ? "" : "s"}`);

  // Sections in the order they get DROPPED when the body will not fit:
  // associates first (the longest and the most sensitive), then departments.
  // The header always survives — a mail with only the four rings is still
  // useful; one that stops mid-department list is not.
  const sections = [
    { title: "Departments (worst pick % first):", lines: deptLines },
    { title: "Associates with picks left behind:", lines: assocLines },
  ];

  const assemble = (keep) => {
    const parts = [...head];
    for (const s of sections.slice(0, keep)) {
      if (!s.lines.length) continue;
      parts.push("", s.title, ...s.lines);
    }
    return parts.join("\n");
  };

  for (let keep = sections.length; keep >= 0; keep--) {
    const body = assemble(keep);
    const len = encodeURIComponent(body).length + encodeURIComponent(subject).length;
    if (len <= maxLen || keep === 0) {
      const truncated = keep < sections.length && sections.slice(keep).some((s) => s.lines.length);
      return {
        subject,
        body: truncated
          ? `${body}\n\n(Some sections were left out to fit the email length limit — print the card for the full detail.)`
          : body,
        truncated,
      };
    }
  }
  // Unreachable: the keep === 0 branch above always returns.
  return { subject, body: assemble(0), truncated: true };
}

// ── Bins that still need pulling ──────────────────────────────────────────

/**
 * Outstanding picks, grouped by BIN GROUP and ordered for WALKING.
 *
 * "Bin group" is the leading segment of a location code: 002/003, 002/007 and
 * 002/011 are all "the 002s". It is NOT a department — corrected 2026-08-22
 * after this shipped labelled "Dept 002". The Location Details export carries
 * no department column at all, so a location cannot be attributed to a
 * department from this data; only the Department Breakout sheet has real dept
 * numbers, and it has no locations. The two cannot be joined.
 *
 * The grouping itself is still right, because bins sharing a prefix are
 * physically adjacent — which is the whole point of a sheet someone walks.
 * Only the label was wrong.
 *
 * This is also where the two printouts diverge. The performance report sorts
 * by severity, because its question is "where is the problem". This one sorts
 * by location within group, because its question is "what do I do next" — and
 * someone holding it is walking an aisle in order. Handing them a
 * severity-ranked list would send them back and forth across the backroom.
 *
 * @returns {{groups:Array<{group:string,bins:Array,picks:number}>, totalPicks:number, totalBins:number}}
 */
export function pickList(r) {
  const gaps = Array.isArray(r?.locations?.gaps) ? r.locations.gaps : [];
  const byGroup = new Map();
  let totalPicks = 0;
  let totalBins = 0;

  for (const g of gaps) {
    if (!g || !g.location) continue;
    const left = Number.isFinite(g.skipped) ? g.skipped : 0;
    if (left <= 0) continue;              // nothing to pull; not actionable
    // Prefer the parsed field, but fall back to re-deriving it from the
    // location code: snapshots written before the rename still say `dept`,
    // and a stored row outlives the build that wrote it.
    const group = String(
      g.locGroup ?? g.dept ?? String(g.location).split("/")[0] ?? ""
    ).trim().replace(/^0+(?=\d)/, "") || "—";
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push({
      location: String(g.location),
      left,
      picksSeen: Number.isFinite(g.picksSeen) ? g.picksSeen : null,
      lastSeenAt: g.lastSeenAt || null,
    });
    totalPicks += left;
    totalBins++;
  }

  const groups = [...byGroup.entries()]
    // Numeric order where the prefix is numeric — that is the order the bins
    // are physically numbered. Non-numeric labels sort after.
    .sort((a, b) => (Number(a[0]) || 1e9) - (Number(b[0]) || 1e9) || a[0].localeCompare(b[0]))
    .map(([group, bins]) => ({
      group,
      bins: bins.sort((x, y) => x.location.localeCompare(y.location, undefined, { numeric: true })),
      picks: bins.reduce((n, b) => n + b.left, 0),
    }));

  return { groups, totalPicks, totalBins };
}

/** "8/22/2026 6:12:55 AM" -> "6:12 AM". Enough to judge whether it is stale. */
function shortTime(ts) {
  if (!ts) return "not scanned";
  const m = String(ts).match(/(\d{1,2}:\d{2})(?::\d{2})?\s*(AM|PM)?/i);
  return m ? `${m[1]}${m[2] ? ` ${m[2].toUpperCase()}` : ""}` : String(ts);
}

// ── Shared page chrome ────────────────────────────────────────────────────
//
// Both reports are written into a blank window that inherits none of the
// suite's stylesheets, so every rule they need is inline. gaugeSvg()'s colours
// are `var(--x, #fallback)` — with no stylesheet the fallbacks apply, which is
// why the gauges still look right on a bare page.

// NOTE: emits NO <script>. A window opened from an extension page inherits the
// extension's CSP (MV3 default: script-src 'self'), so the
// `<script>setTimeout(window.print)</script>` this used to carry was blocked on
// every single print — the report rendered and the dialog never appeared. The
// OPENER calls w.print() instead, which runs in its own context and is allowed.
function pageShell({ title, heading, stamp, body }) {
  return `<!doctype html><html><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; color: #1a1a1a; margin: 0.5in; }
  h1 { margin: 0 0 2px 0; font-size: 20px; }
  h2 { margin: 20px 0 6px 0; font-size: 13px; text-transform: uppercase;
       letter-spacing: 0.4px; color: #444; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  .stamp { font-size: 12px; color: #666; margin-bottom: 14px; }
  .overall { font-size: 13px; margin-bottom: 12px; }
  .overall strong { font-size: 22px; }
  .rings { display: flex; gap: 18px; flex-wrap: wrap; margin-bottom: 4px; }
  .ring { text-align: center; }
  .ring-sub, .ring-label { font-size: 11px; color: #555; margin-top: 2px; }
  .na { font-size: 22px; color: #9ca3af; line-height: 96px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { padding: 4px 8px; text-align: left; border-bottom: 1px solid #eee; }
  th { background: #f5f5f5; font-size: 10px; text-transform: uppercase; letter-spacing: 0.3px; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .bad { color: #c53030; font-weight: 600; }
  .none { font-size: 12px; color: #666; font-style: italic; }
  .box { display: inline-block; width: 11px; height: 11px; border: 1.5px solid #555; border-radius: 2px; }
  .group-head { background: #eef1f5; font-weight: 700; font-size: 11px; }
  .lead { font-size: 12px; color: #333; margin: 0 0 12px 0; }
  /* Chrome and Edge add their own URL/timestamp headers to "Save as PDF" and
     there is no way to suppress them from here — see the note in
     modules/claimsdisposition/styles.css. These pages are designed to read
     fine with them present rather than pretending they are not there. */
  @media print {
    body { margin: 0.4in; }
    h2 { break-after: avoid; }
    tr { break-inside: avoid; }
    thead { display: table-header-group; }   /* repeat headers across pages */
  }
</style></head><body>
<h1>${heading}</h1>
<div class="stamp">${escapeHtml(stamp)}</div>
${body}
</body></html>`;
}

function headingFor(store, market, suffix) {
  return `VizPick — Store ${escapeHtml(String(store))}` +
    (market ? ` <span style="font-weight:400;color:#666">· Market ${escapeHtml(String(market))}</span>` : "") +
    `<span style="font-weight:400;color:#666"> · ${escapeHtml(suffix)}</span>`;
}

/**
 * PERFORMANCE report — what is bad, and who.
 *
 * Ranked by severity throughout, and everything under goal is marked. The
 * point of this sheet is to be read, not walked: it answers "where is this
 * store losing it" and "whose picks are being left".
 *
 * @param {object} r
 * @param {object} [meta] { sourceUpdate, capturedAt, isToday, market }
 * @param {object} [opts] { names }. `names` is a WIN → display-name resolver;
 *   without it every associate prints as a bare id. The caller triggers the
 *   print dialog — see pageShell().
 */
export function buildPerformanceHtml(r, meta = {}, opts = {}) {
  const store = String(r?.store ?? "?");

  const ringsHtml = cardRings(r).map((g) => `
    <div class="ring">
      ${Number.isFinite(g.value)
        ? gaugeSvg(g.value, { size: 96, thickness: 11, goal: g.goal, label: g.label, fmt: (v) => `${Math.round(v)}%` })
        : `<div class="na">—</div><div class="ring-label">${escapeHtml(g.label)}</div>`}
      ${g.ratio ? `<div class="ring-sub">${escapeHtml(g.ratio)}</div>` : ""}
    </div>`).join("");

  // Under goal is the whole point of this page, so it is called out rather
  // than left for the reader to compare two numbers per row.
  const misses = cardRings(r).filter((g) => Number.isFinite(g.value) && g.value < g.goal);
  const missHtml = misses.length
    ? `<p class="lead">Below goal: ${misses.map((m) =>
        `<span class="bad">${escapeHtml(m.label)} ${pct(m.value)}</span> (goal ${m.goal}%)`).join(" · ")}</p>`
    : `<p class="lead">Every ring at or above goal.</p>`;

  const depts = cardDepts(r);
  const deptsHtml = depts.length ? `
    <h2>Departments — worst pick % first</h2>
    <table>
      <thead><tr><th>Dept</th><th class="num">Pick %</th><th class="num">Picks</th><th class="num">Cases seen</th></tr></thead>
      <tbody>${depts.map((d) => `
        <tr>
          <td>${escapeHtml(d.dept)}</td>
          <td class="num${Number.isFinite(d.pickPct) && d.pickPct < 90 ? " bad" : ""}">${pct(d.pickPct)}</td>
          <td class="num">${escapeHtml(ratio(d.suggestedPicksCompleted, d.suggestedPicks) || "—")}</td>
          <td class="num">${escapeHtml(ratio(d.casesSeen, d.casesExpected) || "—")}</td>
        </tr>`).join("")}</tbody>
    </table>` : "";

  const assoc = cardAssociates(r, { names: opts.names });
  const assocHtml = assoc.length ? `
    <h2>Associates with picks left behind</h2>
    <table>
      <thead><tr><th>Associate</th><th class="num">Picks left</th><th class="num">Bins</th></tr></thead>
      <tbody>${assoc.map((a) => `
        <tr>
          <td>${escapeHtml(a.name || a.win)}</td>
          <td class="num bad">${escapeHtml(String(a.skipped))}</td>
          <td class="num">${escapeHtml(String(a.bins.length))}</td>
        </tr>`).join("")}</tbody>
    </table>
    <p class="none">Attributed to whoever last scanned the bin. A bin nobody scanned is
    counted as work not started, not as anyone's miss.</p>` : "";

  return pageShell({
    title: `VizPick Performance — Store ${store}`,
    heading: headingFor(store, meta.market, "Performance"),
    stamp: cardStamp(meta),
    body: `
<div class="overall">Overall VizPick score: <strong>${pct(r?.vizpick)}</strong></div>
${missHtml}
<div class="rings">${ringsHtml}</div>
${deptsHtml}
${assocHtml}`,
  });
}

/**
 * ACTIONABLE report — the bins that still hold picks, in walk order.
 *
 * A worksheet, not a scorecard: no percentages, no names, a tick box per bin.
 * Names are deliberately absent — this sheet goes to whoever is pulling the
 * picks now, and who missed them earlier is a separate conversation on a
 * separate page.
 */
export function buildPickListHtml(r, meta = {}, opts = {}) {
  const store = String(r?.store ?? "?");
  const { groups, totalPicks, totalBins } = pickList(r);

  const body = groups.length ? `
<p class="lead"><strong>${totalPicks}</strong> pick${totalPicks === 1 ? "" : "s"} still to pull,
across <strong>${totalBins}</strong> bin${totalBins === 1 ? "" : "s"}. Grouped by bin prefix and
listed in location order, so the sheet can be walked front to back.</p>
<table>
  <thead><tr><th style="width:26px"></th><th>Location</th><th class="num">To pull</th><th class="num">Last scanned</th></tr></thead>
  <tbody>
  ${groups.map((g) => `
    <tr class="group-head"><td></td><td>${escapeHtml(g.group)}/&hellip;</td>
        <td class="num">${g.picks}</td><td class="num">${g.bins.length} bin${g.bins.length === 1 ? "" : "s"}</td></tr>
    ${g.bins.map((b) => `
      <tr>
        <td><span class="box"></span></td>
        <td>${escapeHtml(b.location)}</td>
        <td class="num">${escapeHtml(String(b.left))}${b.picksSeen ? ` of ${escapeHtml(String(b.picksSeen))}` : ""}</td>
        <td class="num">${escapeHtml(shortTime(b.lastSeenAt))}</td>
      </tr>`).join("")}`).join("")}
  </tbody>
</table>`
    : `<p class="none">No outstanding picks — every located pick has been pulled.</p>`;

  return pageShell({
    title: `VizPick Pick List — Store ${store}`,
    heading: headingFor(store, meta.market, "Bins to pull"),
    stamp: cardStamp(meta),
    body,
  });
}
