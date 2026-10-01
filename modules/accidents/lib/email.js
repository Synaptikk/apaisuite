// modules/accidents/lib/email.js
//
// Email-ready list of the store's OPEN, NOT-DENIED accident charges and what
// each claim's situation is. Pure: takes the cached pull (pnl refs + the
// lazily resolved Clearsight details) and returns { text, html, rows }.
//
// Selection: every Ref # with money actually charged in the chosen FY
// (net of credits > 0). Dropped: claims Clearsight marks `Denied`, and
// charges fully reversed (net <= 0 — the credit back means the dispute was
// won). Open AND closed claims are listed — a closed claim still hit the
// P&L — with the CAS status on the line (user, 2026-09-27: "not showing
// all incidents with charges").
// "Situation" = who, what happened and when: the composed "what happened"
// summary (claimant, cause, where, loss date/time, the claim description,
// reported injury). Deliberately nothing else — no evidence state, status,
// case manager or attachment count (user, 2026-09-27).

const money = (n) => (n == null ? "–" : (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString());

const MONTH_ORDER = (m) => Number(String(m).split("-")[0]) || 0;
// Claim descriptions arrive with hard line breaks; one line per paragraph
// keeps the indented plain-text list readable.
const oneLine = (s) => String(s).replace(/\s*[\r\n]+\s*/g, " ").replace(/\s{2,}/g, " ").trim();

function netFor(r, fy) {
  let net = 0;
  for (const c of r.charges) { if ((fy && c.fy !== fy) || c.amount == null) continue; net += c.amount; }
  return net;
}

// Which refs the email needs details for (the caller resolves the ones
// missing from data.refDetails before composing).
export function chargedRefs(data, { fy = "" } = {}) {
  return (data?.pnl?.refs || []).filter((r) => netFor(r, fy) > 0).map((r) => r.ref);
}

export function selectRows(data, { fy = "" } = {}) {
  const rows = [];
  for (const r of data?.pnl?.refs || []) {
    const charges = r.charges.filter((c) => !fy || c.fy === fy);
    if (!charges.length || netFor(r, fy) <= 0) continue;
    const det = data.refDetails?.[r.ref] || data.claims?.[r.ref] || null;
    const d = det?.digest || null;
    if (d?.denied) continue;
    let charged = 0, credited = 0;
    for (const c of charges) { if (c.amount == null) continue; if (c.amount >= 0) charged += c.amount; else credited += -c.amount; }
    const months = [...new Set(charges.map((c) => `${c.fy} ${c.pnlMonth}`))];
    const lastMonth = charges.slice().sort((a, b) => a.fy.localeCompare(b.fy) || MONTH_ORDER(a.pnlMonth) - MONTH_ORDER(b.pnlMonth)).pop();
    rows.push({
      ref: r.ref,
      claimant: d?.claimant || r.claimant || "",
      category: r.category,
      months,
      lastMonth: lastMonth ? `${lastMonth.fy} ${lastMonth.pnlMonth}` : "",
      charged, credited, net: charged - credited,
      casStatus: r.status,
      clearsightStatus: d?.status || "",
      detail: det,
      digest: d,
      evidence: data.evidence?.find((e) => e.referenceNbr === r.ref) || null,
    });
  }
  rows.sort((a, b) => b.net - a.net || a.ref.localeCompare(b.ref));
  return rows;
}

// One paragraph of "situation" per row. Statements are optional — they run
// long, and the store email usually only needs what happened.
export function situationLines(row, { includeStatements = false } = {}) {
  const det = row.detail;
  const out = [];
  if (!det) { out.push("Situation: Clearsight details not loaded."); return out; }
  if (det.error) { out.push(`Situation: Clearsight lookup failed (${det.error}).`); return out; }
  if (det.notFound) { out.push("Situation: not found in Clearsight quick search."); return out; }

  const summary = String(det.summary || "");
  const paras = summary.split(/\n\n+/).filter(Boolean);
  const stmtIdx = paras.findIndex((p) => /^(Customer|Witness) statement/.test(p));
  const core = stmtIdx >= 0 ? paras.slice(0, stmtIdx) : paras;
  const stmts = stmtIdx >= 0 ? paras.slice(stmtIdx) : [];
  if (core.length) out.push(`What happened: ${oneLine(core.join(" "))}`);
  if (includeStatements) for (const s of stmts) out.push(oneLine(s));
  return out;
}

export function composeEmail(data, opts = {}) {
  const { fy = "", includeStatements = false } = opts;
  const rows = selectRows(data, { fy });
  const asOf = data?.sourceUpdatedOn ? ` (CAS data as of ${data.sourceUpdatedOn})` : "";
  const scope = fy ? `${fy} ` : "";
  const subject = `Store ${data?.store} — accident charges${fy ? ` ${fy}` : ""} (${rows.length})`;
  const totalNet = rows.reduce((s, r) => s + r.net, 0);
  const intro = `Store ${data?.store} — ${rows.length} ${scope}accident charge${rows.length === 1 ? "" : "s"} (denied and reversed excluded), ${money(totalNet)} net charged${asOf}.`;

  const text = [];
  text.push(intro, "");
  rows.forEach((r, i) => {
    text.push(`${i + 1}. ${r.ref} — ${r.claimant || "(no claimant)"} — ${r.category} — ${r.casStatus}`);
    text.push(`   Charged ${money(r.charged)}${r.credited ? `, credited back ${money(r.credited)}, net ${money(r.net)}` : ""} · P&L ${r.months.join(", ")}`);
    for (const line of situationLines(r, { includeStatements })) text.push(`   ${line}`);
    text.push("");
  });
  if (!rows.length) text.push("No charges to list.");

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const html = [];
  html.push(`<p>${esc(intro)}</p>`);
  if (rows.length) {
    html.push(`<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:Calibri,Arial,sans-serif;font-size:11pt">`);
    html.push(`<tr style="background:#f2f2f2"><th align="left">Ref #</th><th align="left">Claimant</th><th align="left">Category</th><th align="left">Status</th><th align="left">P&amp;L month</th><th align="right">Net charged</th><th align="left">Situation</th></tr>`);
    for (const r of rows) {
      const lines = situationLines(r, { includeStatements }).map(esc).join("<br>");
      const amt = r.credited ? `${esc(money(r.net))}<br><span style="color:#666">(${esc(money(r.charged))} − ${esc(money(r.credited))} credit)</span>` : esc(money(r.net));
      html.push(`<tr valign="top"><td>${esc(r.ref)}</td><td>${esc(r.claimant)}</td><td>${esc(r.category)}</td><td>${esc(r.casStatus)}</td><td>${esc(r.months.join(", "))}</td><td align="right">${amt}</td><td>${lines}</td></tr>`);
    }
    html.push(`</table>`);
  } else {
    html.push(`<p>No charges to list.</p>`);
  }
  return { subject, text: text.join("\n"), html: html.join("\n"), rows };
}
