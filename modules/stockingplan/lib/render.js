// modules/stockingplan/lib/render.js
// Pure output generators — no DOM, no chrome.*.

import { formatTime12h, formatShiftRange } from "./compute.js";
import { decToHHMM } from "./cvRates.js";

// --- Plaintext (email) -------------------------------------------------------

export function toPlaintext(plan, assignments) {
  // assignments: Map<rowKey, {shift, names}> where rowKey = "dept:<n>" or "aisle:<deptN>:<label>"
  const lines = [];
  lines.push(`Stocking Plan — Store ${plan.storeNbr} — ${plan.businessDate}`);
  lines.push("");

  // Group associates by role
  const byRole = {
    stock2: plan.associates.filter(a => a.role === 'stock2'),
    stock3: plan.associates.filter(a => a.role === 'stock3'),
    modteam: plan.associates.filter(a => a.role === 'modteam'),
    maintenance: plan.associates.filter(a => a.role === 'maintenance'),
    other: plan.associates.filter(a => !['stock2', 'stock3', 'modteam', 'maintenance'].includes(a.role)),
  };

  const roleLabels = {
    stock2: 'STOCK 2 TA',
    stock3: 'OVERNIGHT TA',
    modteam: 'OVERNIGHT MOD TEAM',
    maintenance: 'OVERNIGHT MAINTENANCE',
    other: 'OTHER',
  };

  // Associates grouped by role
  Object.entries(byRole).forEach(([role, assocs]) => {
    if (assocs.length === 0) return;
    const callOuts = assocs.filter(a => a.calledOut).length;
    lines.push(`${roleLabels[role]} (${assocs.length}${callOuts ? `, ${callOuts} call-outs` : ''})`);
    for (const a of assocs) {
      const callTag = a.calledOut ? "  [CALL OUT]" : "";
      lines.push(`  ${a.name}: ${formatShiftRange(a.start, a.end)}${callTag}`);
    }
    lines.push("");
  });

  if (!plan.freightCaptured) {
    lines.push("(Freight data not captured — click Collect to retry)");
    return lines.join("\n");
  }

  lines.push("=".repeat(60));
  lines.push("");
  lines.push("FREIGHT PLAN");
  lines.push("");

  // Stock 2 tasks
  const stock2Tasks = [];
  const stock3Tasks = [];
  const unassignedTasks = [];

  // Dept tasks (92/95 excluded upstream — covered by aisles)
  for (const t of plan.deptTasks) {
    const key = `dept:${t.key}`;
    const assignment = assignments?.get(key) || { shift: null, names: [], note: "" };
    const tag = t.isFC ? "F&C" : "GM";
    const taskLine = `  ${t.label} (${tag})   ${t.cases} cases / ${t.innerPacks} inner packs = ${decToHHMM(t.hours)}`;
    const assignLine = assignment.names.length ? `    Assigned: ${assignment.names.join(", ")}` : "";
    const noteLine = assignment.note ? `    Note: ${assignment.note}` : "";
    
    if (assignment.shift === 'stock2') {
      stock2Tasks.push(taskLine);
      if (assignLine) stock2Tasks.push(assignLine);
      if (noteLine) stock2Tasks.push(noteLine);
    } else if (assignment.shift === 'stock3') {
      stock3Tasks.push(taskLine);
      if (assignLine) stock3Tasks.push(assignLine);
      if (noteLine) stock3Tasks.push(noteLine);
    } else {
      unassignedTasks.push(taskLine);
      if (assignLine) unassignedTasks.push(assignLine);
      if (noteLine) unassignedTasks.push(noteLine);
    }
  }

  // Aisle tasks
  for (const sec of plan.aisleSections) {
    for (const pair of sec.pairs) {
      const key = `aisle:${sec.deptNbr}:${pair.label}`;
      const assignment = assignments?.get(key) || { shift: null, names: [], note: "" };
      const taskLine = `    Aisle ${pair.label}   ${pair.totalCases} cases / ${pair.totalInnerPacks} inner packs = ${decToHHMM(pair.hours)}`;
      const assignLine = assignment.names.length ? `      Assigned: ${assignment.names.join(", ")}` : "";
      const noteLine = assignment.note ? `      Note: ${assignment.note}` : "";
      
      if (assignment.shift === 'stock2') {
        stock2Tasks.push(taskLine);
        if (assignLine) stock2Tasks.push(assignLine);
        if (noteLine) stock2Tasks.push(noteLine);
      } else if (assignment.shift === 'stock3') {
        stock3Tasks.push(taskLine);
        if (assignLine) stock3Tasks.push(assignLine);
        if (noteLine) stock3Tasks.push(noteLine);
      } else {
        unassignedTasks.push(taskLine);
        if (assignLine) unassignedTasks.push(assignLine);
        if (noteLine) unassignedTasks.push(noteLine);
      }
    }
  }

  if (stock2Tasks.length > 0) {
    lines.push("STOCK 2 FREIGHT");
    lines.push(...stock2Tasks);
    lines.push("");
  }

  if (stock3Tasks.length > 0) {
    lines.push("STOCK 3 FREIGHT");
    lines.push(...stock3Tasks);
    lines.push("");
  }

  if (unassignedTasks.length > 0) {
    lines.push("UNASSIGNED FREIGHT");
    lines.push(...unassignedTasks);
    lines.push("");
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

  function freightRows() {
    const stock2Rows = [];
    const stock3Rows = [];
    const unassignedRows = [];

    for (const t of plan.deptTasks) {
      const assignment = assignments?.get(`dept:${t.key}`) || { shift: null, names: [], note: "" };
      const tag    = t.isFC ? "F&amp;C" : "GM";
      const assign = assignment.names.map(escaped).join(", ")
        + (assignment.note ? `<div class="note">📝 ${escaped(assignment.note)}</div>` : "");
      const row = `<tr class="dept-row${t.isFC ? " fc" : ""}">
        <td><strong>${escaped(t.label)}</strong> <span class="tag">${tag}</span></td>
        <td class="num">${t.cases}</td>
        <td class="num">${t.innerPacks}</td>
        <td class="num hrs">${decToHHMM(t.hours)}</td>
        <td>${assign}</td>
      </tr>`;
      
      if (assignment.shift === 'stock2') stock2Rows.push(row);
      else if (assignment.shift === 'stock3') stock3Rows.push(row);
      else unassignedRows.push(row);
    }

    for (const sec of plan.aisleSections) {
      const tag = sec.isFC ? "F&amp;C" : "GM";
      const header = `<tr class="dept-header">
        <td colspan="5"><strong>Dept ${sec.deptNbr}</strong> <span class="tag">${tag}</span> — by aisle</td>
      </tr>`;
      
      const aisleRows = [];
      for (const pair of sec.pairs) {
        const key    = `aisle:${sec.deptNbr}:${pair.label}`;
        const assignment = assignments?.get(key) || { shift: null, names: [], note: "" };
        const assign = assignment.names.map(escaped).join(", ")
          + (assignment.note ? `<div class="note">📝 ${escaped(assignment.note)}</div>` : "");
        aisleRows.push({
          shift: assignment.shift,
          html: `<tr class="aisle-row">
            <td>&nbsp;&nbsp;Aisle ${escaped(pair.label)}</td>
            <td class="num">${pair.totalCases}</td>
            <td class="num">${pair.totalInnerPacks}</td>
            <td class="num hrs">${decToHHMM(pair.hours)}</td>
            <td>${assign}</td>
          </tr>`
        });
      }

      // Group aisles by shift too
      const stock2Aisles = aisleRows.filter(r => r.shift === 'stock2');
      const stock3Aisles = aisleRows.filter(r => r.shift === 'stock3');
      const unassignedAisles = aisleRows.filter(r => !r.shift);

      if (stock2Aisles.length) {
        stock2Rows.push(header);
        stock2Rows.push(...stock2Aisles.map(r => r.html));
      }
      if (stock3Aisles.length) {
        stock3Rows.push(header);
        stock3Rows.push(...stock3Aisles.map(r => r.html));
      }
      if (unassignedAisles.length) {
        unassignedRows.push(header);
        unassignedRows.push(...unassignedAisles.map(r => r.html));
      }
    }

    const allRows = [];
    
    if (stock2Rows.length) {
      allRows.push(`<tr class="shift-header"><td colspan="5"><h3>Stock 2 Freight</h3></td></tr>`);
      allRows.push(...stock2Rows);
    }
    
    if (stock3Rows.length) {
      allRows.push(`<tr class="shift-header"><td colspan="5"><h3>Stock 3 Freight</h3></td></tr>`);
      allRows.push(...stock3Rows);
    }
    
    if (unassignedRows.length) {
      allRows.push(`<tr class="shift-header"><td colspan="5"><h3>Unassigned Freight</h3></td></tr>`);
      allRows.push(...unassignedRows);
    }

    if (!allRows.length) {
      allRows.push(`<tr><td colspan="5"><em>Freight data not captured.</em></td></tr>`);
    }
    return allRows.join("\n");
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Stocking Plan — Store ${escaped(plan.storeNbr)} — ${escaped(plan.businessDate)}</title>
<style>
  body { font-family: Arial, sans-serif; font-size: 9pt; margin: 1cm; }
  h1 { font-size: 13pt; margin: 0 0 0.1em; }
  .subtitle { color: #555; font-size: 9pt; margin-bottom: 0.6em; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 0.5em; }
  th { background: #1a237e; color: #fff; text-align: left; padding: 2px 6px; font-size: 8.5pt; }
  td { padding: 1px 6px; border-bottom: 1px solid #ddd; font-size: 8.5pt; }
  .num { text-align: right; }
  .hrs { font-weight: bold; }
  .dept-row td:first-child { font-weight: bold; }
  .dept-header td { background: #e8eaf6; font-weight: bold; padding: 2px 6px; }
  .aisle-row td:first-child { padding-left: 1.2em; }
  .shift-header h3 { margin: 0.4em 0 0.1em; font-size: 10pt; color: #0053e2; }
  .tag { font-size: 7pt; background: #e3f2fd; padding: 1px 3px; border-radius: 3px; }
  .fc .tag { background: #e8f5e9; }
  .note { font-size: 8pt; font-style: italic; color: #995213; }
  @media print {
    body { margin: 0.8cm; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    @page { size: portrait; margin: 0.8cm; }
    tr, .dept-header, .shift-header { page-break-inside: avoid; }
  }
</style>
</head>
<body>
<h1>Stocking Plan</h1>
<p class="subtitle">Store ${escaped(plan.storeNbr)} &mdash; ${escaped(plan.businessDate)}</p>

<table>
  <thead>
    <tr><th>Dept / Aisle</th><th class="num">Cases</th><th class="num">Inner Packs</th><th class="num">Hours</th><th>Assigned</th></tr>
  </thead>
  <tbody>
    ${freightRows()}
  </tbody>
</table>

<script>window.onload = () => window.print();<\/script>
</body>
</html>`;
}
