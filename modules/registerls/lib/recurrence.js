// modules/registerls/lib/recurrence.js
//
// Who keeps turning up on shortages nobody can explain. Pure.
//
//   recurringOperators({ items, verdicts, discrepancies, tillRows, analyses })
//     → { people: [{ id, name, roles, count, roundCount, soleCount, totalCents,
//                    seenDays, days: [{ itemId, register, date, amountCents, round, sole, roles }] }],
//         byItem: { [itemId]: [{ id, name, count, roundCount, soleCount, round, sole, others: [...] }] },
//         open: n, openRound: n }
//
// An "open shortage" is a register short with no offset found (unmatched,
// weak offset, no grid cell, outside the window). The people on it come from
// three sources: the Power BI shift query (who signed on to the register that
// day), the EJ operator timeline when the item has been analyzed, and the
// till log (who checked the till in or out). Someone on `minDays` or more
// open shortages is flagged; someone who was the ONLY cashier signed on is
// flagged harder, and a round amount (whole dollars, multiple of $5 — bills,
// not a keying error) counts against them too. Analyst rule 2026-09-16:
// "highlight any obvious recurring operators, potential theft, especially
// for even numbers".
//
// This is a pattern to look at, not a finding: a cashier who works every
// shift is on every register-day, good or bad. `seenDays` (all register-days
// with any discrepancy the person appears on) is shown next to `count` so the
// analyst can see whether the share is unusual.

import { normOp } from "./evidence.js";

export const RECUR_CFG = {
  minDays: 2,
  openVerdicts: ["unmatched", "suspect_flip", "no_grid", "outside_window", "suspect_combo"],
  roundCents: 500,   // multiples of $5 are "round" (a $20, $40, $100 short is bills)
};

export function isRoundAmount(cents, cfg = RECUR_CFG) {
  const abs = Math.abs(cents || 0);
  return abs >= cfg.roundCents && abs % cfg.roundCents === 0;
}

const keyOf = (r, d) => `${r}|${d}`;

// People on one register-day, deduplicated by operator number / WIN.
function peopleOn(register, date, { discrepancy, analysis, tillRows }) {
  const out = new Map();
  const add = (id, name, role) => {
    const k = normOp(id);
    if (!k) return;
    const cur = out.get(k) || { id: k, name: null, roles: new Set() };
    if (name && !cur.name) cur.name = name;
    cur.roles.add(role);
    out.set(k, cur);
  };
  for (const o of discrepancy?.operators || []) add(o.operatorId ?? o.opNum, o.operatorName, "cashier");
  for (const o of analysis?.operators || []) add(o.opNum, o.name, "cashier");
  for (const r of tillRows || []) {
    if (String(r.register) !== String(register) || r.date !== date) continue;
    if (!/^TILLCHECK(IN|OUT)/.test(String(r.action || ""))) continue;
    add(r.associateId || r.associate, r.associate, "till");
  }
  return [...out.values()].map((p) => ({ ...p, roles: [...p.roles] }));
}

export function recurringOperators({ items = [], verdicts = {}, discrepancies = [], tillRows = [], analyses = {}, cfg = RECUR_CFG } = {}) {
  const disc = new Map((discrepancies || []).map((d) => [keyOf(d.registerNbr, d.date), d]));
  const people = new Map();
  const touch = (p) => { if (!people.has(p.id)) people.set(p.id, { id: p.id, name: p.name || null, roles: new Set(), days: [], seen: new Set() }); const cur = people.get(p.id); if (p.name && !cur.name) cur.name = p.name; for (const r of p.roles) cur.roles.add(r); return cur; };

  // Every register-day with a discrepancy the person appears on, for the denominator.
  for (const d of discrepancies || []) for (const p of peopleOn(d.registerNbr, d.date, { discrepancy: d, tillRows })) touch(p).seen.add(keyOf(d.registerNbr, d.date));

  const open = [];
  for (const it of items) {
    const v = verdicts[it.id]?.verdict ?? verdicts[it.id];
    if (!it.register || !it.date || !(it.amountCents < 0) || !cfg.openVerdicts.includes(v)) continue;
    const k = keyOf(it.register, it.date);
    const d = disc.get(k);
    const ppl = peopleOn(it.register, it.date, { discrepancy: d, analysis: analyses[it.id], tillRows });
    const cashiers = ppl.filter((p) => p.roles.includes("cashier"));
    const round = isRoundAmount(it.amountCents, cfg);
    open.push({ itemId: it.id, round });
    for (const p of ppl) {
      const cur = touch(p);
      cur.seen.add(k);
      if (cur.days.some((x) => x.itemId === it.id)) continue;
      cur.days.push({ itemId: it.id, register: String(it.register), date: it.date, amountCents: it.amountCents, round, sole: p.roles.includes("cashier") && cashiers.length === 1, roles: p.roles });
    }
  }

  const list = [...people.values()]
    .filter((p) => p.days.length >= cfg.minDays)
    .map((p) => ({ id: p.id, name: p.name, roles: [...p.roles], count: p.days.length, roundCount: p.days.filter((x) => x.round).length, soleCount: p.days.filter((x) => x.sole).length, totalCents: p.days.reduce((s, x) => s + x.amountCents, 0), seenDays: p.seen.size, days: p.days.sort((a, b) => a.date.localeCompare(b.date)) }))
    .sort((a, b) => b.soleCount - a.soleCount || b.count - a.count || b.roundCount - a.roundCount || a.totalCents - b.totalCents);

  const byItem = {};
  for (const p of list) for (const d of p.days) {
    (byItem[d.itemId] = byItem[d.itemId] || []).push({ id: p.id, name: p.name, count: p.count, roundCount: p.roundCount, soleCount: p.soleCount, seenDays: p.seenDays, round: d.round, sole: d.sole, roles: d.roles, others: p.days.filter((x) => x.itemId !== d.itemId) });
  }
  return { people: list, byItem, open: open.length, openRound: open.filter((o) => o.round).length };
}

const money = (c) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toFixed(2)}`;

// One plain sentence per recurring person, for the item's "Why" list.
export function recurrenceText(entry) {
  const who = entry.name ? `${entry.name} (op ${entry.id})` : `Operator ${entry.id}`;
  const how = entry.roles.includes("cashier") ? (entry.sole ? "was the only cashier signed on here" : "was signed on here") : "handled the till here";
  const others = entry.others.map((o) => `reg ${o.register} ${money(o.amountCents)} on ${o.date}${o.round ? " (round)" : ""}${o.sole ? " (only cashier)" : ""}`).join(", ");
  const round = entry.roundCount ? ` ${entry.roundCount} of the ${entry.count} are round amounts — bills, not keying errors.` : "";
  const sole = entry.soleCount > 1 ? ` The only cashier on ${entry.soleCount} of them.` : "";
  return `${who} ${how} and on ${entry.others.length} other open shortage${entry.others.length === 1 ? "" : "s"}: ${others}.${round}${sole} Seen on ${entry.seenDays} register-days with a discrepancy in total. Pull their transactions and video before treating this as a till error.`;
}
