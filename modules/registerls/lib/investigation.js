// Review priority is a transparent heuristic, never a probability of fraud.
import { pantryMatch } from "./pantry.js";
export function completedCash(t) {
  return t.cashTendCents > 0 && !t.isRefund && !t.isCanceled && !t.isPostVoid && Number.isFinite(t.totalCents) && t.totalCents > 0;
}

function seconds(time) {
  const m = /^(\d{2}):(\d{2}):(\d{2})$/.exec(time || "");
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null;
}

export function investigate(ej, shortageCents, toleranceCents) {
  const gaps = [];
  if (!ej) gaps.push("Journal unavailable.");
  else if (!ej.transactions?.length) gaps.push("No parsed transactions; journal coverage is unverified.");
  gaps.push("Journal completeness and till-session boundaries are not verified. Video is needed to establish actual cash movement.");
  const candidates = [];
  for (const t of ej?.transactions || []) {
    if (!completedCash(t) || !(shortageCents > 0)) continue;
    const net = t.cashTendCents - (t.changeDueCents || 0);
    if (!(net > 0)) continue;
    const amounts = [{ cents: net, basis: "net cash" }, { cents: t.cashTendCents, basis: "cash tender" }];
    amounts.sort((a, b) => Math.abs(a.cents - shortageCents) - Math.abs(b.cents - shortageCents));
    const best = amounts[0], differenceCents = Math.abs(best.cents - shortageCents);
    const exact = differenceCents === 0, near = differenceCents <= toleranceCents;
    let score = exact ? 40 : near ? 25 : 0;
    const supporting = [exact ? `Exact ${best.basis} match.` : near ? `Approximate ${best.basis} match.` : "No whole-transaction amount match; partial cash loss remains possible."];
    const conflicting = ["A recorded cash payment does not establish whether cash was received."];
    const service = (t.items || []).some(i => !i.voided && /gift|vnlla|money\s*order|\bria\b|reload/i.test(i.desc || ""));
    if (service) { score += 10; supporting.push("Receipt description suggests gift card or financial service; verify the item type."); }
    const at = seconds(t.time);
    const nearby = (ej.events || []).filter(e => {
      const et = seconds(e.time);
      return at != null && et != null && Math.abs(et - at) <= 180 && ["nosale", "postvoid"].includes(e.kind);
    });
    if (nearby.length) { score += 10; supporting.push("Drawer opening or post-void event within three minutes; association is unconfirmed."); }
    if (t.voidedLineCount > 0) { score += 5; supporting.push("Receipt includes voided items; check the correction sequence."); }
    if ((t.tenders || []).some(x => x.kind === "card")) conflicting.push("Cash plus card may be legitimate split tender; no card decline is established.");
    if (!near) conflicting.push("This receipt alone does not reconcile the shortage amount.");
    candidates.push({ ...t, score, supporting, conflicting, differenceCents,
      possibleLossCents: best.cents, residualCents: shortageCents - best.cents,
      hypothesis: service ? "Cash may not have been received before value was issued" : "Recorded cash may not have been received, or excess cash may have been handed back",
      check: "Watch the entire payment and nearby drawer activity. Establish cash received, change handed back, and whether cash entered the drawer. Compare with the receipt before assigning a cause.",
      nearby: nearby.map(e => ({ time: e.time, kind: e.kind, opNum: e.opNum || null })),
    });
  }
  candidates.sort((a, b) => b.score - a.score || a.differenceCents - b.differenceCents || (a.time || "").localeCompare(b.time || ""));
  return { candidates, gaps, status: "Cause unconfirmed", method: "Priority combines amount proximity, item context and nearby journal activity; it is not fraud confidence." };
}

// The store buying from itself is the associate pantry run: the UPC list in
// pantry.js, paid with CFT cash from the recycler. Paid out of the drawer
// with no CFT keyed, the register is short the whole ticket. Nothing else
// counts — a customer buying candy or crayons in threes is a customer
// (user rule 2026-09-15: the earlier "repeated lines + plates/cups" guess
// flagged $11 candy and $300 site-merch tickets as store purchases).
export function storeUseBasket(t, pantry) {
  const items = (t?.items || []).filter((i) => !i.voided);
  const pm = pantryMatch(items, pantry);
  if (!pm) return null;
  return { kind: "pantry", repeats: pm.products.slice(0, 5), keyword: 0, lines: items.length, pantryLines: pm.lines, pantryCents: pm.cents, share: pm.share };
}
