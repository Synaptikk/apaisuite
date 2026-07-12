// modules/stockingplan/lib/render.js
// Pure output generators — no DOM, no chrome.*.

import { formatTime12h, formatShiftRange } from "./compute.js";

// --- Plaintext (email) -------------------------------------------------------

export function toPlaintext(plan, assignments) {
  // assignments: Map<rowKey, string[]> where rowKey = "dept:<n>" or "aisle:<deptN>:<label>"
  const lines = [];
  lines.push(`Stocking Plan — Store ${plan.storeNbr} — ${plan.businessDate}`);
  lines.push("");

  // Associates
  lines.push("ASSOCIATES (stocking shift)");
  if (plan.associates.length === 0) {
    lines.push("  (none matched)");
  } else {
    for (const a of plan.associates) {
      const callTag = a.calledOut ? "  [CALL OUT]" : "";
      lines.push(`  ${a.name}: ${formatShiftRange(a.start, a.end)}${callTag}`);
    }
  }
  lines.push("");

  if (!plan.freightCaptured) {
    lines.push("(Freight data not captured — click Collect to retry)");
    return lines.join("\n");
  }

  lines.push("FREIGHT PLAN");
  lines.push("");

  // Dept tasks (non-aisle view or GM departments).
  if (plan.deptTasks.length > 0) {
    for (const t of plan.deptTasks) {
      const tag    = t.isFC ? "F&C" : "GM";
      const assign = assignments?.get(`dept:${t.key}`) || [];
      lines.push(`  ${t.label} (${tag})   ${t.cases} cases / ${t.breakpacks} BPs = ${t.hours}h`);
      if (assign.length) lines.push(`    Assigned: ${assign.join(", ")}`);
    }
    lines.push("");
  }

  // Aisle sections.
  if (plan.aisleSections.length > 0) {
    for (const sec of plan.aisleSections) {
      const tag = sec.isFC ? "F&C" : "GM";
      lines.push(`  Dept ${sec.deptNbr} (${tag}) — by aisle:`);
      for (const pair of sec.pairs) {
        const key    = `aisle:${sec.deptNbr}:${pair.label}`;
        const assign = assignments?.get(key) || [];
        lines.push(`    Aisle ${pair.label}   ${pair.totalCases} cases / ${pair.totalBps} BPs = ${pair.hours}h`);
        if (assign.length) lines.push(`      Assigned: ${assign.join(", ")}`);
      }
      lines.push("");
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

  function assocRows() {
    if (!plan.associates.length) return `<tr><td colspan="3"><em>None matched.</em></td></tr>`;
    return plan.associates
      .map((a) => {
        const badge = a.calledOut
          ? `<span class="badge callout">CALL OUT</span>`
          : "";
        return `<tr>
          <td>${escaped(a.name)}</td>
          <td>${escaped(formatShiftRange(a.start, a.end))}</td>
          <td>${badge}</td>
        </tr>`;
      })
      .join("\n");
  }

  function freightRows() {
    const rows = [];

    for (const t of plan.deptTasks) {
      const tag    = t.isFC ? "F&amp;C" : "GM";
      const assign = (assignments?.get(`dept:${t.key}`) || []).map(escaped).join(", ");
      rows.push(`<tr class="dept-row${t.isFC ? " fc" : ""}">
        <td><strong>${escaped(t.label)}</strong> <span class="tag">${tag}</span></td>
        <td class="num">${t.cases}</td>
        <td class="num">${t.breakpacks}</td>
        <td class="num hrs">${t.hours}h</td>
        <td>${assign}</td>
      </tr>`);
    }

    for (const sec of plan.aisleSections) {
      const tag = sec.isFC ? "F&amp;C" : "GM";
      rows.push(`<tr class="dept-header">
        <td colspan="5"><strong>Dept ${sec.deptNbr}</strong> <span class="tag">${tag}</span> — by aisle</td>
      </tr>`);
      for (const pair of sec.pairs) {
        const key    = `aisle:${sec.deptNbr}:${pair.label}`;
        const assign = (assignments?.get(key) || []).map(escaped).join(", ");
        rows.push(`<tr class="aisle-row">
          <td>&nbsp;&nbsp;Aisle ${escaped(pair.label)}</td>
          <td class="num">${pair.totalCases}</td>
          <td class="num">${pair.totalBps}</td>
          <td class="num hrs">${pair.hours}h</td>
          <td>${assign}</td>
        </tr>`);
      }
    }

    if (!rows.length) {
      rows.push(`<tr><td colspan="5"><em>Freight data not captured.</em></td></tr>`);
    }
    return rows.join("\n");
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
  table { border-collapse: collapse; width: 100%; margin-bottom: 1.2em; }
  th { background: #1a237e; color: #fff; text-align: left; padding: 4px 8px; font-size: 10pt; }
  td { padding: 3px 8px; border-bottom: 1px solid #ddd; font-size: 10pt; }
  .num { text-align: right; }
  .hrs { font-weight: bold; }
  .dept-row td:first-child { font-weight: bold; }
  .dept-header td { background: #e8eaf6; font-weight: bold; padding: 4px 8px; }
  .aisle-row td:first-child { padding-left: 1.5em; }
  .tag { font-size: 8pt; background: #e3f2fd; padding: 1px 4px; border-radius: 3px; }
  .fc .tag { background: #e8f5e9; }
  .badge { font-size: 8pt; padding: 1px 5px; border-radius: 3px; font-weight: bold; }
  .badge.callout { background: #ffcdd2; color: #b71c1c; }
  h2 { font-size: 12pt; margin: 0.8em 0 0.3em; }
  @media print {
    body { margin: 1cm; }
    @page { margin: 1cm; }
  }
</style>
</head>
<body>
<h1>Stocking Plan</h1>
<p class="subtitle">Store ${escaped(plan.storeNbr)} &mdash; ${escaped(plan.businessDate)}</p>

<h2>Associates (stocking shift)</h2>
<table>
  <thead>
    <tr><th>Name</th><th>Shift</th><th>Status</th></tr>
  </thead>
  <tbody>
    ${assocRows()}
  </tbody>
</table>

<h2>Freight Plan</h2>
<table>
  <thead>
    <tr><th>Dept / Aisle</th><th class="num">Cases</th><th class="num">BPs</th><th class="num">Hours</th><th>Assigned</th></tr>
  </thead>
  <tbody>
    ${freightRows()}
  </tbody>
</table>

<script>window.onload = () => window.print();<\/script>
</body>
</html>`;
}
