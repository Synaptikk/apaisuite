// modules/registerls/lib/evidence.js
//
// Pure: turn one WorkView item plus whatever sources answered into a verdict,
// the disposition text to paste, and the evidence the analyst reads before
// deciding to pull video.
//
//   buildEvidence({ item, finding, discrepancy, ledger, ej, cfg }) →
//     { verdict, verdictLabel, severity, reason, dispositionText,
//       videoCandidates, cashMatches, operators, ledgerRows, ledgerFlags,
//       redFlags, sections, missing }
//
// `finding` / `discrepancy` come from the Live Dashboard register engine
// (runMatching output / its input) for the same (register, date). `ledger`
// is decodeLedger().rows, `ej` is ej_parse.parseRecords() output. Any of
// them may be absent — the verdict degrades and `missing` says what was not
// available.

import { completedCash, investigate } from "./investigation.js";

import { safeReasonFor } from "./reasons.js";
import { linkVideo } from "./open_drawer.js";

export const DEFAULT_CFG = {
  toleranceSmallCents:  500,    // ±$5 when |amount| ≤ $100 (matches the register engine)
  toleranceSmallMaxAmt: 10000,
  tolerancePct:         0.05,   // ±5% above $100
  trustFlipAt:          0.70,   // engine's high-confidence band
  repeatLsCents:        1000,   // another |L/S| ≥ $10 in the ledger window = repeat pattern
};

export function tolerance(absCents, cfg = DEFAULT_CFG) {
  return absCents <= cfg.toleranceSmallMaxAmt ? cfg.toleranceSmallCents : Math.round(absCents * cfg.tolerancePct);
}

export function withinTolerance(cents, targetAbsCents, cfg = DEFAULT_CFG) {
  if (cents == null || targetAbsCents == null) return false;
  return Math.abs(Math.abs(cents) - targetAbsCents) <= tolerance(targetAbsCents, cfg);
}

// Auto-file only when the two amounts cancel within the strict tolerance
// (±$5 under $100, ±5% over). Candidates admitted by the looser matching
// tolerance that miss this are shown as weak offsets for the analyst.
export function amountsCancel(aCents, bCents, cfg = DEFAULT_CFG) {
  const gap = Math.abs(Math.abs(aCents) - Math.abs(bCents));
  return gap <= tolerance(Math.max(Math.abs(aCents), Math.abs(bCents)), cfg);
}

export function findFindingFor(findings, item) {
  return (findings || []).find((f) => String(f.primaryRegister) === String(item.register) && f.primaryDate === item.date) || null;
}

// The overage side of a pair: the finding whose matched entry is this item.
export function findCounterpartFinding(findings, item) {
  return (findings || []).find((f) => (f.matchedAgainst || []).some((m) => String(m.registerNbr) === String(item.register) && m.date === item.date)) || null;
}

// Discrepancies the engine should score: Power BI cells plus the WorkView
// items themselves (every long/short work item IS a register-day amount, and
// WorkView reaches further back than the report's ~60-day retention). Grid
// cells win on a key collision because they carry operator shifts.
export function unionDiscrepancies(gridDiscrepancies, queueItems, storeNbr) {
  const out = [];
  const seen = new Set();
  for (const d of gridDiscrepancies || []) {
    const k = `${d.registerNbr}|${d.date}`;
    if (seen.has(k)) continue;
    seen.add(k); out.push(d);
  }
  for (const q of queueItems || []) {
    if (!q.register || !q.date || q.amountCents == null || q.amountCents === 0) continue;
    const k = `${q.register}|${q.date}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ storeNbr: String(q.store || storeNbr || ""), date: q.date, registerNbr: String(q.register), amountCents: q.amountCents, type: q.amountCents < 0 ? "short" : "over", amountAbsCents: Math.abs(q.amountCents), operators: [], _source: { module: "registerls", sourceMethod: "workview-item", workItemId: q.id } });
  }
  return out;
}

export function findDiscrepancyFor(discrepancies, item) {
  return (discrepancies || []).find((d) => String(d.registerNbr) === String(item.register) && d.date === item.date) || null;
}

function daysApart(aIso, bIso) {
  return Math.round((new Date(aIso) - new Date(bIso)) / 86_400_000);
}

export function fmtMoney(cents) {
  if (cents == null) return "?";
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function fmtShortOver(cents) {
  return cents == null ? "?" : `${fmtMoney(Math.abs(cents))} ${cents < 0 ? "short" : "over"}`;
}

// ── Cash-tender matching ───────────────────────────────────────────

// A shortage is cash the register RECORDED as received that never reached the
// drawer — a fraudulent card keyed as cash, a short-change scam, cash pocketed
// at the tender. So the candidate is a transaction whose cash tender (or net
// cash after change) is near the amount. Change due is cash going out that
// the register also expects to be gone; it cannot explain a shortage, and a
// cash refund is recorded as cash out too. Neither is matched.
export function cashMatches(ej, targetAbsCents, cfg = DEFAULT_CFG) {
  if (!ej?.transactions?.length || !targetAbsCents) return [];
  const out = [];
  for (const t of ej.transactions) {
    if (!completedCash(t)) continue;
    const hits = [];
    const net = t.cashTendCents - (t.changeDueCents || 0);
    if (withinTolerance(t.cashTendCents, targetAbsCents, cfg))            hits.push(`cash tendered ${fmtMoney(t.cashTendCents)}`);
    else if (net > 0 && withinTolerance(net, targetAbsCents, cfg))        hits.push(`net cash ${fmtMoney(net)} (tendered ${fmtMoney(t.cashTendCents)}, change ${fmtMoney(t.changeDueCents)})`);
    if (hits.length) out.push({ transNum: t.transNum, tcNum: t.tcNum, time: t.time, opNum: t.opNum, opName: t.opName || null, totalCents: t.totalCents, cashTendCents: t.cashTendCents, changeDueCents: t.changeDueCents, tenders: t.tenders || [], why: hits });
  }
  return out;
}

// ── Operators on the register ──────────────────────────────────────

// Power BI pads operator numbers ("0193"); EJ does not ("193"). Same person.
export function normOp(v) {
  const s = String(v ?? "").trim();
  return s.replace(/^0+(?=\d)/, "") || s;
}

export function operatorTimeline(ej, discrepancy) {
  const byOp = new Map();
  for (const o of ej?.dayStats?.operators || []) {
    const k = normOp(o.opNum);
    byOp.set(k, { opNum: k, name: o.name || null, firstSeen: o.firstSeen || null, lastSeen: o.lastSeen || null, transactionCount: o.transactionCount || 0, sources: ["ej"] });
  }
  for (const o of discrepancy?.operators || []) {
    const k = normOp(o.operatorId ?? o.opNum ?? "");
    if (!k) continue;
    const cur = byOp.get(k) || { opNum: k, name: null, firstSeen: null, lastSeen: null, transactionCount: 0, sources: [] };
    cur.name = cur.name || o.operatorName || null;
    if (!cur.sources.includes("powerbi")) cur.sources.push("powerbi");
    byOp.set(k, cur);
  }
  return [...byOp.values()].sort((a, b) => (a.firstSeen || "").localeCompare(b.firstSeen || ""));
}

// ── Red flags from the journal ─────────────────────────────────────

export function redFlags(ej, cfg = DEFAULT_CFG) {
  const flags = [];
  if (!ej) return flags;
  for (const t of ej.transactions || []) {
    if (t.voidedLineCount > 0) flags.push({ kind: "void", time: t.time, transNum: t.transNum, opNum: t.opNum, text: `${t.voidedLineCount} voided line${t.voidedLineCount > 1 ? "s" : ""} on TR# ${t.transNum}` });
    if (t.isPostVoid)          flags.push({ kind: "postvoid", time: t.time, transNum: t.transNum, opNum: t.opNum, text: `post-void TR# ${t.transNum}` });

  }
  for (const e of ej.events || []) {
    if (e.kind === "nosale")   flags.push({ kind: "nosale", time: e.time, opNum: e.opNum || null, text: `no-sale / drawer open ${e.time}` });
    if (e.kind === "postvoid") flags.push({ kind: "postvoid", time: e.time, opNum: e.opNum || null, text: `post-void ${e.time}` });
  }
  return flags.sort((a, b) => (a.time || "").localeCompare(b.time || ""));
}

// ── Ledger flags ───────────────────────────────────────────────────

export function ledgerFlags(ledger, item, cfg = DEFAULT_CFG) {
  const flags = [];
  const rows = ledger || [];
  const day = rows.find((r) => r.date === item.date);
  if (day) {
    if (day.tillCheckins === 0 && day.tillCheckouts > 0) flags.push({ kind: "no_checkin", text: `till checked out but never checked in on ${item.date} (finalized ${fmtMoney(day.finalizedLsCents)})` });
    if (day.tillCheckins > 1 || day.tillCheckouts > 1)   flags.push({ kind: "multi_till", text: `${day.tillCheckins} check-ins / ${day.tillCheckouts} check-outs on ${item.date} — more than one till on this register` });
    if (day.advancesCents > 0) flags.push({ kind: "advances", text: `cash advances ${fmtMoney(day.advancesCents)} on ${item.date}` });
    if (day.pickupsCents > 0)  flags.push({ kind: "pickups",  text: `cash pickups ${fmtMoney(day.pickupsCents)} on ${item.date}` });
  }
  // A till checked out one day and checked in the next shows as an exact
  // short/over reversal on consecutive days — reconciliation timing, not a
  // pattern. Drop both halves of any equal-and-opposite pair within 3 days.
  const reversed = new Set();
  for (const a of rows) for (const b of rows) {
    if (a === b || a.finalizedLsCents === 0) continue;
    if (a.finalizedLsCents === -b.finalizedLsCents && Math.abs(daysApart(a.date, b.date)) <= 3) { reversed.add(a.date); reversed.add(b.date); }
  }
  const repeats = rows.filter((r) => r.date !== item.date && !reversed.has(r.date) && Math.abs(r.finalizedLsCents) >= cfg.repeatLsCents && r.tillCheckins > 0);
  if (repeats.length) flags.push({ kind: "repeat", text: `${repeats.length} other day${repeats.length > 1 ? "s" : ""} in the window with |L/S| ≥ ${fmtMoney(cfg.repeatLsCents)}: ${repeats.map((r) => `${r.date} ${fmtShortOver(r.finalizedLsCents)}`).join(", ")}`, dates: repeats.map((r) => r.date) });
  return flags;
}

// ── Verdict ────────────────────────────────────────────────────────

export function buildEvidence({ item, finding = null, discrepancy = null, ledger = null, ej = null, tills = null, drawer = null, cft = null, cfg = DEFAULT_CFG }) {
  const missing = [];
  if (!finding && !discrepancy) missing.push("powerbi");
  if (!ledger) missing.push("cash_research");
  if (!ej) missing.push("ej");
  if (!tills) missing.push("tills");
  // A cash advance near the shortage that surfaced as an overage on another
  // register is the one legitimate far-register flip; one that never
  // surfaced points at whoever carried it.
  const advFlip    = tills?.advances?.find((a) => a.kind === "advance_flip") || null;
  const advMissing = tills?.advances?.find((a) => a.kind === "advance_missing") || null;

  const abs = item.amountAbsCents ?? (discrepancy ? discrepancy.amountAbsCents : null);
  const amtText = fmtShortOver(item.amountCents ?? discrepancy?.amountCents ?? null);
  const reg = item.register, date = item.date;

  const matches = cashMatches(ej, abs, cfg);
  const ops     = operatorTimeline(ej, discrepancy);
  const flags   = redFlags(ej, cfg);
  const lflags  = ledgerFlags(ledger, item, cfg);
  const repeat  = lflags.find((f) => f.kind === "repeat");
  // APPRISS "Open Drawer" rows carry the transaction id the CCTV and receipt
  // viewers key on: attach ▶ links to every journal-derived transaction.
  // near: cash IN near the amount (what a keyed-as-cash scam looks like) or,
  // with nothing tendered, cash OUT near the amount (a refund or payout of
  // exactly the shortage — the drawer opened and the money left).
  const drawerRows = drawer?.rows?.length ? drawer.rows.map((r) => {
    const nearIn  = r.cashTendCents > 0 && (withinTolerance(r.cashTendCents, abs, cfg) || withinTolerance(r.cashTendCents - r.changeCents, abs, cfg));
    const nearOut = !(r.cashTendCents > 0) && r.changeCents > 0 && withinTolerance(r.changeCents, abs, cfg);
    return { ...r, near: nearIn || nearOut, nearKind: nearIn ? "in" : nearOut ? "out" : null };
  }) : null;
  if (drawerRows) { linkVideo(matches, drawerRows); linkVideo(flags, drawerRows); }
  const cashOut = drawerRows ? drawerRows.filter((r) => r.nearKind === "out") : [];
  const cftNear = isOverAmount(item, discrepancy) ? [] : cftMatches(cft, item, abs, cfg);

  let verdict, verdictLabel, severity, reason, dispositionText;
  const isOver = (item.amountCents ?? discrepancy?.amountCents ?? 0) > 0;
  const m = finding?.matchedAgainst?.[0];
  const conf = finding?.flipConfidence ?? 0;

  if (!isOver && advFlip) {
    const a = advFlip.advance, o = advFlip.landedOn;
    verdict = "flip"; verdictLabel = "Advance carried to another till — nothing found"; severity = "low";
    reason = `${a.associate || a.associateId} advanced ${fmtMoney(a.amountCents)} to reg ${reg} at ${a.time} on ${date}; reg ${o.registerNbr} is ${fmtShortOver(o.amountCents)} on ${o.date}. The cash went to the wrong till.`;
    dispositionText = `Nothing found — cash advance taken to the wrong register. ${a.associate || a.associateId} advanced ${fmtMoney(a.amountCents)} to register ${reg} at ${a.time} on ${date}; the same amount shows as register ${o.registerNbr} ${fmtShortOver(o.amountCents)} on ${o.date}. Offsetting entries, no loss. Coach on till handling.`;
  } else if (isOver && finding && finding.matchType !== "none") {
    // `finding` is the shortage's finding whose match is this overage.
    const p = { registerNbr: finding.primaryRegister, date: finding.primaryDate, amountCents: finding.primaryAmountCents };
    const same = finding.matchType === "same-register-bounceback";
    const tight = amountsCancel(item.amountCents ?? discrepancy?.amountCents ?? 0, p.amountCents, cfg) && finding.tier !== 2;
    if (conf >= cfg.trustFlipAt && tight) {
      verdict = same ? "bounceback" : "flip"; verdictLabel = same ? "Bounceback (overage side) — nothing found" : "Till flip (overage side) — nothing found"; severity = "low";
      reason = `This ${amtText} on reg ${reg} is the other half of reg ${p.registerNbr} ${fmtShortOver(p.amountCents)} on ${p.date} (${Math.round(conf * 100)}% confidence).`;
      dispositionText = same
        ? `Nothing found — drawer count corrected. Register ${reg} ${amtText} on ${date} reverses register ${p.registerNbr} ${fmtShortOver(p.amountCents)} on ${p.date}. Same register, offsetting entries, no loss.`
        : `Nothing found — till flip. Register ${reg} ${amtText} on ${date} offsets register ${p.registerNbr} ${fmtShortOver(p.amountCents)} on ${p.date}; tills checked in against each other. Offsetting entries, no loss.`;
    } else {
      const gap = Math.abs(Math.abs(item.amountCents ?? discrepancy?.amountCents ?? 0) - Math.abs(p.amountCents));
      verdict = "suspect_flip"; verdictLabel = "Weak offset (overage) — review"; severity = "medium";
      reason = `Reg ${p.registerNbr} ${fmtShortOver(p.amountCents)} on ${p.date} may be the other half of this overage${!tight ? `, but the amounts are ${fmtMoney(gap)} apart` : `, but confidence is only ${Math.round(conf * 100)}%`}.`;
      dispositionText = "";
    }
  } else if (isOver) {
    verdict = "unmatched_over"; verdictLabel = "Unmatched overage — review"; severity = abs >= 100000 ? "high" : abs >= 10000 ? "medium" : "low";
    reason = (finding || discrepancy || (item.amountCents != null)) ? `No shortage on a neighbouring register or on this register nearby offsets this ${amtText} on ${date}.` : `No data to match this overage against.`;
    dispositionText = "";
  } else if (finding && finding.matchType === "nearby-register-offset" && conf >= cfg.trustFlipAt && finding.tier !== 2 && amountsCancel(item.amountCents ?? discrepancy?.amountCents ?? 0, m.amountCents, cfg)) {
    verdict = "flip"; verdictLabel = "Till flip — nothing found"; severity = "low";
    reason = `Reg ${reg} ${amtText} on ${date} is offset by reg ${m.registerNbr} ${fmtShortOver(m.amountCents)} on ${m.date} (${Math.round(conf * 100)}% confidence).`;
    dispositionText = `Nothing found — till flip. Register ${reg} ${amtText} on ${date} offsets register ${m.registerNbr} ${fmtShortOver(m.amountCents)} on ${m.date}; tills checked in against each other. Offsetting entries, no loss.`;
  } else if (finding && finding.matchType === "same-register-bounceback" && conf >= cfg.trustFlipAt && finding.tier !== 2 && amountsCancel(item.amountCents ?? discrepancy?.amountCents ?? 0, m.amountCents, cfg)) {
    verdict = "bounceback"; verdictLabel = "Bounceback — nothing found"; severity = "low";
    reason = `Reg ${reg} ${amtText} on ${date} reverses on ${m.date} (${fmtShortOver(m.amountCents)}, ${Math.round(conf * 100)}% confidence).`;
    dispositionText = `Nothing found — drawer count corrected. Register ${reg} ${amtText} on ${date}, ${fmtShortOver(m.amountCents)} on ${m.date}. Same register, offsetting entries, no loss.`;
  } else if (finding && finding.matchType !== "none") {
    const gap = Math.abs(Math.abs(item.amountCents ?? discrepancy?.amountCents ?? 0) - Math.abs(m.amountCents));
    const tight = amountsCancel(item.amountCents ?? discrepancy?.amountCents ?? 0, m.amountCents, cfg) && finding.tier !== 2;
    verdict = "suspect_flip"; verdictLabel = "Weak offset — review"; severity = "medium";
    reason = !tight
      ? `Reg ${m.registerNbr} ${fmtShortOver(m.amountCents)} on ${m.date} looks like the other half, but the amounts are ${fmtMoney(gap)} apart — if it is the same pair, ${fmtMoney(gap)} is still unexplained.`
      : `A candidate offset exists (reg ${m.registerNbr} ${fmtShortOver(m.amountCents)} on ${m.date}) but confidence is only ${Math.round(conf * 100)}%: ${String(finding.reason || "amount or timing does not line up cleanly").replace(/\.+$/, "")}.`;
    dispositionText = "";
  } else if (finding || discrepancy) {
    verdict = "unmatched"; verdictLabel = "Unmatched shortage — review"; severity = finding?.severity || (abs >= 10000 ? "high" : abs >= 2500 ? "medium" : "low");
    reason = `No offsetting over/short within the engine's window for reg ${reg} ${amtText} on ${date}.`;
    dispositionText = "";
  } else {
    verdict = "no_grid"; verdictLabel = "No Power BI cell — review"; severity = abs >= 10000 ? "high" : "medium";
    reason = `Power BI has no long/short cell for reg ${reg} on ${date} (grid not pulled or the day is outside the report window). Offset detection could not run.`;
    dispositionText = "";
  }

  if (!isOver && advMissing && verdict !== "flip" && verdict !== "bounceback") {
    const a = advMissing.advance;
    severity = "high";
    reason += ` ${a.associate || a.associateId} advanced ${fmtMoney(a.amountCents)} to this register at ${a.time} and no register shows it as an overage — the advance may never have reached the till.`;
  }

  // Video signal: exactly one cash transaction explains the amount (shortages only —
  // an overage is cash the register did not record, and no receipt shows that).
  const videoCandidates = !isOver && !["flip", "bounceback"].includes(verdict) ? matches : [];
  const investigation = !isOver && !["flip", "bounceback"].includes(verdict) ? investigate(ej, abs, tolerance(abs || 0, cfg)) : null;
  if (investigation && drawerRows) linkVideo(investigation.candidates, drawerRows);
  if (!isOver && (verdict === "unmatched" || verdict === "suspect_flip" || verdict === "no_grid")) {
    if (videoCandidates.length === 1) {
      const v = videoCandidates[0];
      reason += ` One transaction recorded cash near the amount: TR# ${v.transNum} at ${v.time} (${v.why.join(", ")})${v.opNum ? `, operator ${v.opNum}${v.opName ? ` ${v.opName}` : ""}` : ""} — pull that video and confirm the cash went in.`;
      severity = severity === "low" ? "medium" : "high";
    } else if (ej && matches.length === 0) {
      reason += ` No transaction recorded a cash tender near the amount.`;
    } else if (matches.length > 1) {
      reason += ` ${matches.length} cash transactions are near the amount — see the list.`;
    }
    if (repeat) { reason += ` Repeat pattern: ${repeat.text}.`; severity = "high"; }
  }

  const sections = [];
  sections.push({ key: "video", title: "Transactions that recorded cash near the amount", lines: matches.length ? matches.slice(0, 8).map((x) => `${x.time}  TR# ${x.transNum}  op ${x.opNum}${x.opName ? ` ${x.opName}` : ""}  ${x.why.join("; ")}  (TC# ${x.tcNum || "?"})`) : [ej ? "none" : "EJ not pulled"] });
  sections.push({ key: "operators", title: "Who was on the register", lines: ops.length ? ops.map((o) => `${o.opNum}${o.name ? ` ${o.name}` : ""}  ${o.firstSeen || "?"} → ${o.lastSeen || "?"}  ${o.transactionCount} txns  [${o.sources.join("+")}]`) : ["no sign-on or shift data"] });
  sections.push({ key: "ledger", title: "Cash Research — last 10 days", lines: ledger ? (ledger.length ? ledger.map((r) => `${r.date}${r.date === date ? " ◀" : ""}  L/S ${fmtMoney(r.finalizedLsCents)}  adv ${fmtMoney(r.advancesCents)}  pick ${fmtMoney(r.pickupsCents)}  in/out ${r.tillCheckins}/${r.tillCheckouts}`) : ["no rows"]) : ["Cash Research not pulled"] });
  if (lflags.length) sections.push({ key: "ledgerFlags", title: "Ledger flags", lines: lflags.map((f) => f.text) });
  if (cftNear.length) sections.push({ key: "cft", title: "Cash fund transfers near the amount (reference)", lines: cftNear.map((c) => `${c.businessDate}  keyed ${c.inputDate || "?"} ${c.inputTime || ""}  ${fmtMoney(c.amountCents)}  ${c.recipient || "?"}  ${c.accountDesc || ""}${c.reason ? ` — ${c.reason}` : ""}`) });
  sections.push({ key: "redFlags", title: "Journal red flags", lines: flags.length ? flags.map((f) => `${f.time || ""}  ${f.text}${f.opNum ? `  (op ${f.opNum})` : ""}`) : [ej ? "none" : "EJ not pulled"] });
  if (ej?.dayStats) sections.push({ key: "day", title: "Register day", lines: [`${ej.dayStats.transactionCount} transactions, ${ej.dayStats.cashTransactionCount} with cash, ${ej.dayStats.refundCount} refunds, ${ej.dayStats.voidedLineCount} voided lines, ${ej.dayStats.noSaleCount} no-sales`] });

  // Who checked the two tills in (flip pairs only).
  const fc = tills?.flip || null;
  const who = fc ? (fc.same ? (fc.associates[0].name || fc.associates[0].id) : fc.associates.map((a) => a.name || a.id).join(" and ")) : "";
  if (fc && (verdict === "flip") && !advFlip && who) {
    const detail = [...fc.mine, ...fc.theirs].map((c) => `reg ${c.registerNbr || c.register} ${c.time}`).join(", ");
    dispositionText = dispositionText.replace(/\.$/, "") + (fc.same ? `. Tills checked in by ${who} (${detail}).` : `. Tills checked in by ${who} (${detail}); each till was checked in to the other's register.`);
  }

  // Structured "why" bullets, the disposition suggestion, and what to look at.
  const why = [];
  if (isOver && finding && finding.matchType !== "none") {
    why.push({ kind: "offset", text: `Register ${finding.primaryRegister} was ${fmtShortOver(finding.primaryAmountCents)} on ${finding.primaryDate}${finding.primaryDate === date ? " (same day)" : ""} — this overage is its other half (${Math.round(conf * 100)}% confidence).` });
    if (conf < cfg.trustFlipAt) why.push({ kind: "weak", text: `Confidence is below ${Math.round(cfg.trustFlipAt * 100)}%: ${String(finding.reason || "amount, register distance or timing does not line up cleanly").replace(/\.+$/, "")}.` });
  } else if (isOver) {
    why.push({ kind: "nooffset", text: `No shortage on a neighbouring register or on this register within the window offsets this overage.` });
  } else if (finding && finding.matchType !== "none" && m) {
    why.push({ kind: "offset", text: `${finding.matchType === "same-register-bounceback" ? "Same register" : `Register ${m.registerNbr}`} was ${fmtShortOver(m.amountCents)} on ${m.date}${m.date === date ? " (same day)" : ""} — offsets this ${fmtShortOver(item.amountCents ?? discrepancy?.amountCents)} (${Math.round(conf * 100)}% confidence).` });
    if (conf < cfg.trustFlipAt) why.push({ kind: "weak", text: `Confidence is below ${Math.round(cfg.trustFlipAt * 100)}%: ${String(finding.reason || "amount, register distance or timing does not line up cleanly").replace(/\.+$/, "")}.` });
  } else if (finding || discrepancy) {
    why.push({ kind: "nooffset", text: `No neighbouring register or same-register entry offsets this amount within the engine's window.` });
  } else {
    why.push({ kind: "nogrid", text: `No long/short data to match this register-day against.` });
  }
  if (ej && !isOver) {
    if (matches.length === 1) why.push({ kind: "video", text: `Exactly one transaction recorded cash near the amount: TR# ${matches[0].transNum} at ${matches[0].time} (${matches[0].why.join(", ")})${matches[0].opNum ? `, operator ${matches[0].opNum}${matches[0].opName ? ` ${matches[0].opName}` : ""}` : ""}. Video must establish actual cash movement before this can explain the shortage.` });
    else if (matches.length === 0) why.push({ kind: "nocash", text: `No transaction recorded a cash tender within ${fmtMoney(tolerance(abs || 0, cfg))} of the amount, partial cash loss, excess change or several related transactions remain possible.` });
    else why.push({ kind: "manycash", text: `${matches.length} transactions recorded cash near the amount — none stands out on its own.` });
    if (ops.length) why.push({ kind: "ops", text: `${ops.length === 1 ? "One operator" : `${ops.length} operators`} on the register that day: ${ops.map((o) => `${o.opNum}${o.name ? ` ${o.name}` : ""}`).join(", ")}.` });
  }
  for (const f of lflags) if (f.kind === "repeat" || f.kind === "no_checkin" || f.kind === "multi_till") why.push({ kind: f.kind, text: f.text + "." });
  if (tills) {
    const otherReg = isOver ? finding?.primaryRegister : m?.registerNbr;
    if ((!fc || !who) && (verdict === "flip" || verdict === "suspect_flip") && !advFlip && otherReg) why.push({ kind: "flip_who_none", text: noCheckinText(tills, reg, otherReg, date) });
    if (fc && (verdict === "flip" || verdict === "suspect_flip") && !advFlip && who) why.push({ kind: fc.same ? "flip_who" : "flip_who_unsure", text: fc.same ? `${who} checked in both tills that day (${[...fc.mine, ...fc.theirs].map((c) => `reg ${c.register} at ${c.time}`).join(", ")}) — the check-in error is theirs.` : `${who} each checked a till in that day (${[...fc.mine, ...fc.theirs].map((c) => `reg ${c.register} at ${c.time}`).join(", ")}) and each till landed on the other's register — both check-ins are charged.` });
    if (advFlip) why.push({ kind: "advance_flip", text: `Cash advance ${fmtMoney(advFlip.advance.amountCents)} by ${advFlip.advance.associate || advFlip.advance.associateId} at ${advFlip.advance.time} — the same amount is over on reg ${advFlip.landedOn.registerNbr} (${advFlip.landedOn.date}). Taken to the wrong till.` });
    else if (advMissing && verdict !== "flip" && verdict !== "bounceback") why.push({ kind: "advance_missing", text: `Cash advance ${fmtMoney(advMissing.advance.amountCents)} to this register by ${advMissing.advance.associate || advMissing.advance.associateId} at ${advMissing.advance.time} never surfaced as an overage anywhere.` });
    for (const m of tills.moves || []) why.push({ kind: "move", text: `${m.associate || m.associateId} checked a till out of reg ${m.fromRegister} at ${m.outTime} and into reg ${m.toRegister} at ${m.inTime} on ${m.date}${m.override ? " (override)" : ""}.` });
    for (const f of tills.flags || []) if (f.kind === "override" || f.kind === "unbalanced" || f.kind === "many_hands" || f.kind === "quick_recheck") why.push({ kind: "till_" + f.kind, text: f.text.charAt(0).toUpperCase() + f.text.slice(1) + "." });
    if (tills.people?.length && !isOver) why.push({ kind: "till_people", text: `Till handled by ${tills.people.map((p) => p.name || p.id).join(", ")} on ${date} (check-in/out log).` });
  }
  if (!isOver) for (const r of cashOut.slice(0, 3)) why.push({ kind: "cashout", text: `Cash paid out ${fmtMoney(r.changeCents)} at ${r.time} on TR# ${r.transNum} (cashier ${r.cashier || "?"}) with nothing tendered — a refund or payout of the shortage amount. Check the receipt and watch the video: was there a customer, and did the cash leave the drawer?` });
  // CFT cash is dispensed by the recycler, not taken from a register, so a
  // CFT near the amount is shown for reference (lookAt "cft") but is not a
  // cause of a register shortage. Rule pending: how a late CFT surfaces.
  if (flags.length) why.push({ kind: "flags", text: `${flags.length} journal red flag${flags.length > 1 ? "s" : ""}: ${flags.slice(0, 3).map((f) => f.text).join("; ")}${flags.length > 3 ? "; …" : ""}.` });

  // Reasons offered by WorkView for long/short items (mel): Cash Card Scam,
  // Counterfeit Bills, Internal Theft, Multiple Reasons, Not Identified,
  // Phone Scam, Process Errors, Quick Change, Robbery.
  let suggestion;
  if (verdict === "flip" || verdict === "bounceback") {
    const reasonLabel = safeReasonFor(item.sourceAppId, verdict, { advance: !!advFlip });
    suggestion = { reasonLabel, text: dispositionText, safe: true, action: `Fill in APPRISS as ${reasonLabel}` };
  } else {
    const lines = [
      `Register ${reg} ${amtText} on ${date}.`,
      ...why.filter((w) => w.kind !== "ops").map((w) => w.text),
    ];
    if (videoCandidates.length) lines.push(`Review video of TR# ${videoCandidates[0].transNum} at ${videoCandidates[0].time} before closing.`);
    else if (cashOut.length) lines.push(`Review video of the ${fmtMoney(cashOut[0].changeCents)} cash-out on TR# ${cashOut[0].transNum} at ${cashOut[0].time} before closing.`);
    // Nothing gets dispositioned without a found cause. Notes only; the
    // analyst picks the reason (Internal Theft, Process Errors, …) after review.
    suggestion = { reasonLabel: null, text: lines.join(" "), safe: false, action: videoCandidates.length ? "Watch the video; disposition only once the cause is known" : "Review; disposition only once the cause is known" };
  }

  const lookAt = investigation ? ["investigation"] : [];
  if (cftNear.length) lookAt.push("cft");
  if (tills && (advFlip || advMissing || tills.moves?.length || tills.flags?.some((f) => f.kind === "quick_recheck"))) lookAt.unshift("tills");
  if (videoCandidates.length && !investigation) lookAt.push("video");
  if (matches.length > 1) lookAt.push("cash");
  if (drawerRows && !isOver) lookAt.push("drawer");
  if (ops.length) lookAt.push("operators");
  if (flags.length) lookAt.push("redFlags");
  if (lflags.length) lookAt.push("ledgerFlags");
  if (tills && !lookAt.includes("tills")) lookAt.push("tills");
  lookAt.push("ledger");

  return {
    verdict, verdictLabel, severity, reason, dispositionText,
    why, suggestion, lookAt, investigation,
    flipConfidence: finding?.flipConfidence ?? null,
    matchType: finding?.matchType ?? null,
    matchedAgainst: finding?.matchedAgainst ?? [],
    videoCandidates, cashMatches: matches, operators: ops,
    drawer: drawerRows ? { rows: drawerRows, count: drawerRows.length, explorerUrl: drawer.explorerUrl || null } : null,
    cashOut,
    cftNear,
    tills: tills ? { events: tills.events, advances: tills.advances, moves: tills.moves, flags: tills.flags, people: tills.people, flip: tills.flip } : null,
    ledgerRows: ledger || [], ledgerFlags: lflags, redFlags: flags,
    sections, missing,
  };
}

function isOverAmount(item, discrepancy) { return (item.amountCents ?? discrepancy?.amountCents ?? 0) > 0; }

// CFTs whose amount is within tolerance of the shortage and whose business
// date or keyed date sits within a day before to a week after it. A CFT is
// cash physically removed from a register; keyed late or against the wrong
// day it reads as a shortage on the day the cash left.
export function cftMatches(rows, item, abs, cfg = DEFAULT_CFG) {
  if (!rows?.length || !item?.date || !abs) return [];
  const t0 = new Date(item.date).getTime();
  const gap = (d) => (d ? Math.round((new Date(d).getTime() - t0) / 86_400_000) : null);
  const out = [];
  for (const r of rows) {
    if (!(r.amountCents > 0) || r.system) continue;
    if (!withinTolerance(r.amountCents, abs, cfg)) continue;
    const gb = gap(r.businessDate), gi = gap(r.inputDate);
    const ok = (g) => g != null && g >= -1 && g <= 7;
    if (!ok(gb) && !ok(gi)) continue;
    out.push({ ...r, dayGap: gb ?? gi, gapCents: Math.abs(r.amountCents - abs) });
  }
  return out.sort((a, b) => a.gapCents - b.gapCents || Math.abs(a.dayGap) - Math.abs(b.dayGap));
}

// Why the till log cannot name who swapped a flip pair: the day predates the
// log, the lanes are self-checkouts (no till exists to check in), or the log
// simply has no check-in for that register that day.
export function noCheckinText(tills, reg, otherReg, date) {
  const k = tills?.kinds || {};
  const a = k[String(reg)], b = k[String(otherReg)];
  const min = tills?.logRange?.min;
  if (min && date < min) return `The pulled till log starts ${min}; ${date} is before it, so the log cannot say who checked these tills in.`;
  const scoA = !!a?.sco, scoB = !!b?.sco;
  if (scoA && scoB) return `Reg ${reg} and reg ${otherReg} are self-checkouts: their cash lives in the recycler and no till is ever checked in or out, so this offset is a recycler count between two lanes, not a swapped till — nobody to charge.`;
  if (scoA || scoB) { const s = scoA ? reg : otherReg, o = scoA ? otherReg : reg; return `Reg ${s} is a self-checkout (cash in the recycler, no till check-in). Reg ${o} has no matching check-in logged on ${date}, so the log cannot say who is responsible.`; }
  return `No till check-ins are logged for reg ${reg} or reg ${otherReg} on ${date}, so the log cannot say who swapped them.`;
}
