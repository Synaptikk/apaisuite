// modules/stockingplan/lib/render.js
// Pure output generators — no DOM, no chrome.*.
//
// Output follows the shape store 1458's stocking plans are actually written in:
// a block per shift (Stock 2 → Overnight → Mod Team → Stock 1 the next
// morning), each line an area or department with its hours, because that is
// what the overnight coach reads off at shift start.

import { formatShiftRange } from "./compute.js";
import { verdictLine } from "./shifts.js";
import { lineText } from "./suggest.js";

const SHIFT_BLOCKS = [
  { key: "stock2", title: "STOCK 2",   group: "stock2" },
  { key: "stock3", title: "OVERNIGHT", group: "stock3" },
  { key: "stock1", title: "STOCK 1",   group: null     },  // tomorrow morning
];

// Collapse the plan's three breakdown levels into one flat, non-overlapping
// list of rows. A department row wins over its area; an aisle row wins over
// D92/95. Only rows the user actually touched (shift chosen or names assigned)
// count as "finer detail" — otherwise an area row would vanish the moment the
// dept view was rendered with its defaults.
export function flattenRows(plan, assignments) {
  const get = (key) => assignments?.get(key) || null;
  const touched = (a) => !!a && (!!a.shift || (a.names && a.names.length));

  const rows = [];

  for (const area of plan.areaSections || []) {
    const deptRows = (area.depts || [])
      .map((d) => ({ d, a: get(`dept:${d.key}`) }))
      .filter((x) => touched(x.a));

    if (deptRows.length) {
      for (const { d, a } of deptRows) {
        rows.push({
          key:   `dept:${d.key}`,
          label: d.label,
          area:  area.name,
          isFC:  d.isFC,
          cases: d.cases,
          bps:   d.breakpacks,
          hours: d.hours,
          shift: a.shift,
          names: a.names || [],
        });
      }
      continue;
    }

    const a = get(`area:${area.name}`);
    rows.push({
      key:   `area:${area.name}`,
      label: area.name,
      area:  area.name,
      isFC:  area.isFC,
      cases: area.cases,
      bps:   area.breakpacks,
      hours: area.hours,
      shift: a?.shift || area.defaultShift || null,
      names: a?.names || [],
    });
  }

  for (const sec of plan.aisleSections || []) {
    for (const pair of sec.pairs || []) {
      const key = `aisle:${sec.deptNbr}:${pair.label}`;
      const a   = get(key);
      if (!touched(a)) continue;   // aisles only appear once someone plans them
      rows.push({
        key,
        label: `Aisle ${pair.label}`,
        area:  "D92/95",
        isFC:  true,
        cases: pair.totalCases,
        bps:   pair.totalBps,
        hours: pair.hours,
        shift: a.shift,
        names: a.names || [],
        aisle: true,
      });
    }
  }

  return rows;
}

function headline(plan) {
  const cap = plan.capacity;
  const lines = [];
  lines.push(`Stocking Plan — Store ${plan.storeNbr} — ${plan.dateLabel || plan.businessDate}`);
  lines.push("");
  lines.push(
    `Freight: ${plan.requiredHours}h` +
    (plan.requiredBasis === "cv" ? " (CaseVisibility estimate)" : " (our case rates)")
  );
  lines.push(
    `Labour:  Stock 2 ${cap.stock2Hours}h (${cap.stock2Count}) + Overnight ${cap.stock3Hours}h (${cap.stock3Count}) = ${cap.capacity}h` +
    (cap.modCount ? ` · Mod team ${cap.modHours}h (${cap.modCount})` : " · no mod team tonight")
  );
  if (cap.nextStock1Hours != null) {
    lines.push(`         Stock 1 ${plan.nextDateLabel}: ${cap.nextStock1Hours}h (${cap.nextStock1Count})`);
  }
  if (cap.calledOut) {
    lines.push(`         ${cap.calledOut} call-out${cap.calledOut !== 1 ? "s" : ""} — ${cap.calledOutHours}h off the floor`);
  }
  lines.push("");
  lines.push(verdictLine(cap));
  return lines;
}

// --- Suggested draft (email) -------------------------------------------------
//
// Paste-ready: the four blocks, nothing else. The reasoning behind the moves
// stays on screen — a plan that argues with itself is not a plan.

export function toSuggestionText(plan, suggestion) {
  const out = [];
  const blocks = [suggestion.blocks.stock2, suggestion.blocks.stock3,
                  suggestion.blocks.modteam, suggestion.blocks.stock1];

  for (const b of blocks) {
    if (b.key === "modteam") {
      if (!b.scheduled) continue;          // no mod associates, no mod block
      out.push("Mod Team");
      out.push(`  (${b.crew.count} scheduled, ${b.crew.workingHours}h — add tonight's mods)`);
      out.push("");
      continue;
    }

    out.push(b.title);
    for (const s of b.standing) out.push(`  ${s}`);
    for (const l of b.lines)    out.push(`  ${lineText(l)}`);
    if (!b.standing.length && !b.lines.length) out.push("  (nothing outstanding)");
    out.push("");
  }

  return out.join(String.fromCharCode(10)).trimEnd();
}

// --- Plaintext (email) -------------------------------------------------------

export function toPlaintext(plan, assignments) {
  const lines = headline(plan);
  lines.push("");

  if (!plan.freightCaptured) {
    lines.push("(Freight data not captured — click Collect to retry)");
    return lines.join("\n");
  }

  const rows = flattenRows(plan, assignments);

  for (const block of SHIFT_BLOCKS) {
    const mine = rows.filter((r) => r.shift === block.key);
    const grp  = block.group ? plan.shifts?.[block.group] : (plan.nextShifts?.stock1 || null);

    const head = block.key === "stock1"
      ? `${block.title} — ${plan.nextDateLabel}` + (grp ? ` (${grp.count} scheduled, ${grp.workingHours}h)` : "")
      : `${block.title}` + (grp ? ` (${grp.count} scheduled, ${grp.workingHours}h)` : "");

    lines.push(head);
    if (block.key === "stock2") lines.push("  Unload/downstack trucks");

    if (!mine.length) {
      lines.push("  (nothing assigned)");
    } else {
      for (const r of mine) {
        lines.push(`  ${r.label} — ${r.cases.toLocaleString()} cases / ${r.bps.toLocaleString()} IP = ${r.hours}h`);
        if (r.names.length) lines.push(`      ${r.names.join(", ")}`);
      }
      const total = Math.round(mine.reduce((s, r) => s + r.hours, 0) * 10) / 10;
      lines.push(`  — ${total}h of freight on this block`);
    }
    lines.push("");
  }

  const mod = plan.shifts?.modteam;
  lines.push("MOD TEAM" + (mod && mod.count ? ` (${mod.count} scheduled, ${mod.workingHours}h)` : " — none scheduled tonight"));
  lines.push("");

  const unassigned = rows.filter((r) => !r.shift);
  if (unassigned.length) {
    lines.push("NOT YET ASSIGNED");
    for (const r of unassigned) {
      lines.push(`  ${r.label} — ${r.cases.toLocaleString()} cases / ${r.bps.toLocaleString()} IP = ${r.hours}h`);
    }
    lines.push("");
  }

  if (plan.capacity.backup.length) {
    lines.push(`BACKUP — ${plan.nextDateLabel} salesfloor teams`);
    for (const b of plan.capacity.backup) {
      lines.push(`  ${b.job}: ${b.count} assoc, ${b.hours}h${b.area ? ` — ${b.area}` : ""}`);
    }
    lines.push("");
  }

  if (plan.trucks.length) {
    lines.push("TRUCKS");
    for (const t of plan.trucks) {
      lines.push(`  ${t.type} ${t.eta} — ${t.totalCases.toLocaleString()} cases (load ${t.loadId})`);
    }
    lines.push("");
  }

  lines.push("ASSOCIATES ON TONIGHT");
  for (const key of ["stock2", "stock3", "modteam"]) {
    const g = plan.shifts?.[key];
    if (!g || !g.members.length) continue;
    lines.push(`  ${g.label}:`);
    for (const m of g.members) {
      lines.push(`    ${m.name}: ${formatShiftRange(m.start, m.end)}${m.calledOut ? "  [CALL OUT]" : ""}`);
    }
  }

  return lines.join("\n");
}

// --- Print HTML -------------------------------------------------------------

export function toPrintHtml(plan, assignments) {
  const escaped = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  const rows = flattenRows(plan, assignments);
  const cap  = plan.capacity;

  function labourTable() {
    const cells = [
      ["Stock 2",          cap.stock2Hours, cap.stock2Count],
      ["Overnight",        cap.stock3Hours, cap.stock3Count],
      ["Mod Team",         cap.modHours,    cap.modCount],
      ["Freight required", plan.requiredHours, null],
      [`Stock 1 ${escaped(plan.nextDateLabel)}`, cap.nextStock1Hours, cap.nextStock1Count],
    ];
    return cells.map(([label, hrs, n]) => `<tr>
      <td>${label}</td>
      <td class="num hrs">${hrs == null ? "—" : hrs + "h"}</td>
      <td class="num">${n == null ? "" : n}</td>
    </tr>`).join("\n");
  }

  function blockRows() {
    const out = [];
    for (const block of SHIFT_BLOCKS) {
      const mine = rows.filter((r) => r.shift === block.key);
      const grp  = block.group ? plan.shifts?.[block.group] : (plan.nextShifts?.stock1 || null);
      const title = block.key === "stock1"
        ? `${block.title} — ${escaped(plan.nextDateLabel)}`
        : block.title;
      out.push(`<tr class="dept-header"><td colspan="5"><strong>${title}</strong>${
        grp ? ` <span class="tag">${grp.count} scheduled · ${grp.workingHours}h</span>` : ""
      }</td></tr>`);
      if (!mine.length) {
        out.push(`<tr><td colspan="5"><em>Nothing assigned.</em></td></tr>`);
        continue;
      }
      for (const r of mine) {
        out.push(`<tr class="${r.aisle ? "aisle-row" : "dept-row"}${r.isFC ? " fc" : ""}">
          <td>${escaped(r.label)} <span class="tag">${r.isFC ? "F&amp;C" : "GM"}</span></td>
          <td class="num">${r.cases.toLocaleString()}</td>
          <td class="num">${r.bps.toLocaleString()}</td>
          <td class="num hrs">${r.hours}h</td>
          <td>${r.names.map(escaped).join(", ")}</td>
        </tr>`);
      }
    }
    const unassigned = rows.filter((r) => !r.shift);
    if (unassigned.length) {
      out.push(`<tr class="dept-header"><td colspan="5"><strong>NOT YET ASSIGNED</strong></td></tr>`);
      for (const r of unassigned) {
        out.push(`<tr>
          <td>${escaped(r.label)}</td>
          <td class="num">${r.cases.toLocaleString()}</td>
          <td class="num">${r.bps.toLocaleString()}</td>
          <td class="num hrs">${r.hours}h</td>
          <td></td>
        </tr>`);
      }
    }
    if (!out.length) out.push(`<tr><td colspan="5"><em>Freight data not captured.</em></td></tr>`);
    return out.join("\n");
  }

  function assocRows() {
    const out = [];
    for (const key of ["stock2", "stock3", "modteam", "maintenance"]) {
      const g = plan.shifts?.[key];
      if (!g || !g.members.length) continue;
      out.push(`<tr class="dept-header"><td colspan="3"><strong>${escaped(g.label)}</strong> <span class="tag">${g.count} · ${g.workingHours}h</span></td></tr>`);
      for (const m of g.members) {
        out.push(`<tr>
          <td>${escaped(m.name)}</td>
          <td>${escaped(formatShiftRange(m.start, m.end))}</td>
          <td>${m.calledOut ? `<span class="badge callout">CALL OUT</span>` : ""}</td>
        </tr>`);
      }
    }
    if (!out.length) out.push(`<tr><td colspan="3"><em>None matched.</em></td></tr>`);
    return out.join("\n");
  }

  function backupSection() {
    if (!cap.backup.length) return "";
    return `
<h2>Backup — ${escaped(plan.nextDateLabel)} salesfloor teams</h2>
<table>
  <thead><tr><th>Job group</th><th>Covers</th><th class="num">Assoc</th><th class="num">Hours</th></tr></thead>
  <tbody>
    ${cap.backup.map((b) => `<tr>
      <td>${escaped(b.job)}</td><td>${escaped(b.area || "")}</td>
      <td class="num">${b.count}</td><td class="num hrs">${b.hours}h</td>
    </tr>`).join("\n")}
  </tbody>
</table>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Stocking Plan — Store ${escaped(plan.storeNbr)} — ${escaped(plan.businessDate)}</title>
<style>
  body { font-family: Arial, sans-serif; font-size: 11pt; margin: 1.5cm; }
  h1 { font-size: 14pt; margin-bottom: 0.2em; }
  .subtitle { color: #555; font-size: 10pt; margin-bottom: 1em; }
  .verdict { border-left: 4px solid #1a237e; padding: 6px 10px; background: #f4f5fb;
             font-size: 10pt; margin-bottom: 1em; }
  .verdict.short { border-color: #b71c1c; background: #fdecea; }
  .verdict.tight { border-color: #e65100; background: #fff4e5; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 1.2em; }
  th { background: #1a237e; color: #fff; text-align: left; padding: 4px 8px; font-size: 10pt; }
  td { padding: 3px 8px; border-bottom: 1px solid #ddd; font-size: 10pt; }
  .num { text-align: right; }
  .hrs { font-weight: bold; }
  .dept-row td:first-child { font-weight: bold; }
  .dept-header td { background: #e8eaf6; font-weight: bold; padding: 4px 8px; }
  .aisle-row td:first-child { padding-left: 1.5em; }
  .tag { font-size: 8pt; background: #e3f2fd; padding: 1px 4px; border-radius: 3px; font-weight: normal; }
  .fc .tag { background: #e8f5e9; }
  .badge { font-size: 8pt; padding: 1px 5px; border-radius: 3px; font-weight: bold; }
  .badge.callout { background: #ffcdd2; color: #b71c1c; }
  h2 { font-size: 12pt; margin: 0.8em 0 0.3em; }
  .half { width: 48%; display: inline-table; vertical-align: top; }
  @media print {
    body { margin: 1cm; }
    @page { margin: 1cm; }
  }
</style>
</head>
<body>
<h1>Stocking Plan</h1>
<p class="subtitle">Store ${escaped(plan.storeNbr)} &mdash; ${escaped(plan.dateLabel || plan.businessDate)}
  &middot; morning crew ${escaped(plan.nextDateLabel)}</p>

<div class="verdict ${escaped(cap.verdict)}">${escaped(verdictLine(cap))}</div>

<h2>Labour vs freight</h2>
<table class="half">
  <thead><tr><th>Block</th><th class="num">Hours</th><th class="num">Assoc</th></tr></thead>
  <tbody>
    ${labourTable()}
  </tbody>
</table>

<h2>The plan</h2>
<table>
  <thead>
    <tr><th>Area / Dept / Aisle</th><th class="num">Cases</th><th class="num">IP</th><th class="num">Hours</th><th>Assigned</th></tr>
  </thead>
  <tbody>
    ${blockRows()}
  </tbody>
</table>
${backupSection()}
<h2>Associates on tonight</h2>
<table>
  <thead>
    <tr><th>Name</th><th>Shift</th><th>Status</th></tr>
  </thead>
  <tbody>
    ${assocRows()}
  </tbody>
</table>

</body>
</html>`;
}
