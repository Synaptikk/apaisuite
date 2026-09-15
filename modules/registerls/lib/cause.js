// modules/registerls/lib/cause.js
//
// The analyst's call: "that transaction was the cause". The sources rank
// candidates (evidence.js / investigation.js) but never decide; when the
// video settles it, the analyst picks the ticket and this turns the pick
// into the More Information text and a cashier-ledger event.
//
// A cause is { transNum, time, opNum, opName, cashTendCents, totalCents,
// tcNum, at } — copied from the candidate the analyst clicked, so the text
// is reproducible without the journal.

const money = (c) => (c == null ? "?" : `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toFixed(2)}`);
const shortOver = (c) => `${money(Math.abs(c))} ${c < 0 ? "short" : "over"}`;

export function normalizeCause(raw = {}) {
  const num = (v) => (v === "" || v == null || Number.isNaN(Number(v)) ? null : Math.round(Number(v)));
  const c = {
    transNum: String(raw.transNum ?? "").trim(),
    time:     String(raw.time ?? "").trim(),
    opNum:    String(raw.opNum ?? "").trim(),
    opName:   String(raw.opName ?? "").trim(),
    tcNum:    String(raw.tcNum ?? "").trim(),
    cashTendCents: num(raw.cashTendCents),
    totalCents:    num(raw.totalCents),
    note:     String(raw.note ?? "").trim(),
    at:       raw.at || new Date().toISOString(),
  };
  return c.transNum ? c : null;
}

export function whoText(c) {
  return c.opNum && c.opName ? `operator ${c.opNum} ${c.opName}` : c.opName ? c.opName : c.opNum ? `operator ${c.opNum}` : "operator unknown";
}

// The paragraph that leads the More Information text once a cause is picked.
export function causeText(item, c) {
  const amt = item.amountCents ?? 0;
  const cash = c.cashTendCents != null ? `${money(c.cashTendCents)} cash tendered` : "cash tendered";
  const ticket = c.totalCents != null ? ` on a ${money(c.totalCents)} ticket` : "";
  const tc = c.tcNum ? ` (TC# ${c.tcNum})` : "";
  const what = amt < 0
    ? "the cash recorded on that transaction did not reach the drawer"
    : "the cash taken on that transaction was not recorded";
  return `Cause: TR# ${c.transNum}${c.time ? ` at ${c.time}` : ""} — ${cash}${ticket}${tc}, ${whoText(c)}. Register ${item.register} ${shortOver(amt)} on ${item.date}: ${what}. Video reviewed.${c.note ? ` ${c.note}` : ""}`;
}

// One line for the cashier ledger.
export function causeDetail(item, c) {
  return `TR# ${c.transNum}${c.time ? ` at ${c.time}` : ""}: ${c.cashTendCents != null ? money(c.cashTendCents) + " cash" : "cash"} recorded, register ${shortOver(item.amountCents ?? 0)} — confirmed by the analyst as the cause`;
}

// The ledger is keyed by WIN (till-log associate id, "CDH00BJ"); the
// journal only knows the operator number ("193") and a name. Match the
// name against the till log to land on the WIN; otherwise key on the
// operator number so the event is still recorded and visibly so.
export function resolveAssociate(tillRows, c) {
  const name = String(c.opName || "").trim().toUpperCase();
  if (name) {
    const hit = (tillRows || []).find((r) => String(r.associate || "").trim().toUpperCase() === name && r.associateId);
    if (hit) return { id: hit.associateId, name: hit.associate };
  }
  if (c.opNum) return { id: `op${c.opNum}`, name: c.opName || "" };
  return { id: null, name: c.opName || "" };
}
