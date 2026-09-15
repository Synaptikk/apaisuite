// modules/registerls/lib/till_events.js
//
// Pure rules over Cash Recycler rows (see cash_recycler.js::normalizeRow):
//
//   tillsFor(rows, item, discrepancies, cfg) → what the till log says about
//   one register-day: the timeline, cash advances that could explain the
//   amount (and whether the money surfaced as an overage elsewhere), wrong-
//   register moves by the associates involved, and flags.
//
//   wrongRegisterMoves(rows) → store-wide list of "checked out of X, checked
//   in to Y" by the same associate — the people who handle tills improperly.
//
// Amounts are integer cents; registers are strings.

// ADVANCECASH is bills from the recycler to a till — the amount that can go
// missing. VAULTFUNDADVANCECASH is the change-fund (coin) top-up that rides
// along with it in the morning sweep: median $10.50, 95% under $26, half of
// them with cents, register after register seconds apart (profiled
// 2026-09-12 on 1,069 events). It is shown in the timeline but never used to
// explain a shortage.
const ADVANCE = new Set(["ADVANCECASH"]);
const CHANGE_FUND = "VAULTFUNDADVANCECASH";
const CHECKIN = new Set(["TILLCHECKIN", "TILLCHECKINOVERRIDE"]);

export const TILL_CFG = {
  toleranceSmallCents: 500, toleranceSmallMaxAmt: 10000, tolerancePct: 0.05,
  moveWindowSec:   3 * 3600,   // check-out → check-in on another register within 3 h
  moveAmountCents: 5000,       // …and amounts within $50
  overageWindowDays: 1,        // an advance that surfaces as an overage within ±1 day
};

const tol = (abs, cfg) => (abs <= cfg.toleranceSmallMaxAmt ? cfg.toleranceSmallCents : Math.round(abs * cfg.tolerancePct));
const near = (a, b, cfg) => Math.abs(Math.abs(a) - Math.abs(b)) <= tol(Math.abs(b), cfg);
const daysApart = (a, b) => Math.round((new Date(a) - new Date(b)) / 86_400_000);
const secs = (t) => (t == null ? null : Math.floor(t / 10000) * 3600 + Math.floor((t % 10000) / 100) * 60 + (t % 100));
export const fmtMoney = (c) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toFixed(2)}`;

export function eventsFor(rows, register, dateIso, daysAround = 0) {
  return (rows || [])
    .filter((r) => String(r.register) === String(register) && Math.abs(daysApart(r.date, dateIso)) <= daysAround)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.timeInt ?? 0) - (b.timeInt ?? 0));
}

// A till checked in to the wrong register leaves two orphans on the day:
// register X has a check-out that never came back, and register Y has a
// check-in that was never checked out. Only such orphan pairs count — a
// cash-office associate issuing and collecting many tills in a row is doing
// their job, not moving tills. The move is charged to whoever did the
// check-in on Y (they put the till on the wrong register); the check-out
// associate is recorded alongside.
export function wrongRegisterMoves(rows, cfg = TILL_CFG) {
  const byDate = new Map();
  for (const r of rows || []) { if (!byDate.has(r.date)) byDate.set(r.date, []); byDate.get(r.date).push(r); }
  const moves = [];
  for (const [date, list] of byDate) {
    const outsBy = new Map(), insBy = new Map();
    for (const e of list) {
      if (e.action === "TILLCHECKOUT") { if (!outsBy.has(e.register)) outsBy.set(e.register, []); outsBy.get(e.register).push(e); }
      else if (CHECKIN.has(e.action)) { if (!insBy.has(e.register)) insBy.set(e.register, []); insBy.get(e.register).push(e); }
    }
    const orphanOuts = [], orphanIns = [];
    for (const [reg, outs] of outsBy) { const ins = insBy.get(reg) || []; if (outs.length > ins.length) orphanOuts.push(...outs.sort((a, b) => (b.timeInt ?? 0) - (a.timeInt ?? 0)).slice(0, outs.length - ins.length)); }
    for (const [reg, ins] of insBy) { const outs = outsBy.get(reg) || []; if (ins.length > outs.length) orphanIns.push(...ins.sort((a, b) => (a.timeInt ?? 0) - (b.timeInt ?? 0)).slice(0, ins.length - outs.length)); }
    const used = new Set();
    for (const back of orphanIns.sort((a, b) => (a.timeInt ?? 0) - (b.timeInt ?? 0))) {
      const cands = orphanOuts.filter((o) => !used.has(o) && String(o.register) !== String(back.register) && secs(back.timeInt) - secs(o.timeInt) >= 0 && secs(back.timeInt) - secs(o.timeInt) <= cfg.moveWindowSec && Math.abs(back.amountCents - o.amountCents) <= cfg.moveAmountCents)
        .sort((a, b) => (a.associateId === back.associateId ? 0 : 1) - (b.associateId === back.associateId ? 0 : 1) || Math.abs(a.amountCents - back.amountCents) - Math.abs(b.amountCents - back.amountCents));
      const out = cands[0];
      if (!out) continue;
      used.add(out);
      moves.push({ date, associateId: back.associateId, associate: back.associate, checkoutBy: out.associateId, checkoutByName: out.associate, fromRegister: String(out.register), toRegister: String(back.register), outTime: out.time, inTime: back.time, outCents: out.amountCents, inCents: back.amountCents, override: back.action === "TILLCHECKINOVERRIDE" });
    }
  }
  return moves.sort((a, b) => b.date.localeCompare(a.date) || a.associateId.localeCompare(b.associateId));
}

// Cash advances to this register on this day whose amount is near the
// shortage. For each, look for an overage near that amount on ANY register
// within ±overageWindowDays — that is the advance carried to the wrong till
// (a legitimate far-register flip). Otherwise the advance never showed up.
export function advanceExplanations(rows, item, discrepancies, cfg = TILL_CFG) {
  const amt = item.amountCents ?? 0;
  if (!(amt < 0)) return [];
  const abs = Math.abs(amt);
  const out = [];
  for (const a of eventsFor(rows, item.register, item.date, 0)) {
    if (!ADVANCE.has(a.action) || !near(a.amountCents, abs, cfg)) continue;
    // The overage the cash landed on can only be the same day or later —
    // an overage the day before the advance was something else.
    const over = (discrepancies || []).filter((d) => d.amountCents > 0 && String(d.registerNbr) !== String(item.register) && daysApart(d.date, item.date) >= 0 && daysApart(d.date, item.date) <= cfg.overageWindowDays && near(d.amountCents, a.amountCents, cfg))
      .sort((x, y) => Math.abs(daysApart(x.date, item.date)) - Math.abs(daysApart(y.date, item.date)));
    out.push({ kind: over.length ? "advance_flip" : "advance_missing", advance: a, landedOn: over[0] || null, candidates: over.length });
  }
  return out;
}

export function tillFlags(events, item) {
  const flags = [];
  const day = events.filter((e) => e.date === item.date);
  const ins = day.filter((e) => CHECKIN.has(e.action)), outs = day.filter((e) => e.action === "TILLCHECKOUT");
  if (day.some((e) => e.action === "TILLCHECKINOVERRIDE")) flags.push({ kind: "override", text: `till check-in override on ${item.date}` });
  if (ins.length !== outs.length) flags.push({ kind: "unbalanced", text: `${outs.length} check-out${outs.length === 1 ? "" : "s"} vs ${ins.length} check-in${ins.length === 1 ? "" : "s"} on ${item.date}` });
  const people = [...new Set(day.map((e) => e.associateId).filter(Boolean))];
  if (people.length > 2) flags.push({ kind: "many_hands", text: `${people.length} different associates handled this till on ${item.date}` });
  // Same associate checks a till out and back in within minutes with less
  // cash than went out — the drawer lost money between two log lines.
  const byPerson = new Map();
  for (const e of day) { if (!byPerson.has(e.associateId)) byPerson.set(e.associateId, []); byPerson.get(e.associateId).push(e); }
  for (const list of byPerson.values()) {
    list.sort((a, b) => (a.timeInt ?? 0) - (b.timeInt ?? 0));
    for (let i = 0; i + 1 < list.length; i++) {
      const out = list[i], back = list[i + 1];
      if (out.action !== "TILLCHECKOUT" || !CHECKIN.has(back.action)) continue;
      const dt = secs(back.timeInt) - secs(out.timeInt);
      if (dt < 0 || dt > 15 * 60 || back.amountCents >= out.amountCents) continue;
      flags.push({ kind: "quick_recheck", text: `${out.associate || out.associateId} checked out ${fmtMoney(out.amountCents)} at ${out.time} and checked in ${fmtMoney(back.amountCents)} at ${back.time} — ${fmtMoney(out.amountCents - back.amountCents)} less within ${Math.round(dt / 60)} min`, deltaCents: out.amountCents - back.amountCents, associateId: out.associateId });
    }
  }
  const pick = day.filter((e) => e.action === "CASHPICKUP").reduce((s, e) => s + e.amountCents, 0);
  const adv = day.filter((e) => ADVANCE.has(e.action)).reduce((s, e) => s + e.amountCents, 0);
  const coin = day.filter((e) => e.action === CHANGE_FUND).reduce((s, e) => s + e.amountCents, 0);
  if (adv) flags.push({ kind: "advances", text: `cash advances ${fmtMoney(adv)} on ${item.date}` });
  if (coin) flags.push({ kind: "change_fund", text: `change-fund (coin) advances ${fmtMoney(coin)} on ${item.date}` });
  if (pick) flags.push({ kind: "pickups", text: `pickups ${fmtMoney(pick)} on ${item.date}` });
  return flags;
}

// For a flip pair (this register and its counterpart): who checked the two
// tills in that day. One person doing both check-ins is the one who put the
// tills on the wrong registers; two different people each checked a till in
// to the other's register, so both check-ins are wrong.
export function flipCheckins(rows, item, counterpart) {
  if (!counterpart?.register || !counterpart?.date) return null;
  const pick = (register, date) => eventsFor(rows, register, date, 0).filter((e) => CHECKIN.has(e.action)).map((e) => ({ id: e.associateId, name: e.associate, register: String(register), date, time: e.time, amountCents: e.amountCents }));
  const mine = pick(item.register, item.date), theirs = pick(counterpart.register, counterpart.date);
  if (!mine.length && !theirs.length) return null;
  const ids = [...new Set([...mine, ...theirs].map((c) => c.id).filter(Boolean))];
  // both: each side has a check-in. A flip means each till landed on the
  // other's register, so with two closers both check-ins were wrong.
  return { mine, theirs, associates: ids.map((id) => ({ id, name: [...mine, ...theirs].find((c) => c.id === id)?.name || "" })), same: ids.length === 1 && mine.length > 0 && theirs.length > 0, both: mine.length > 0 && theirs.length > 0 };
}

// Every report we pull keeps ~60 days (Cash Recycler, Power BI long/short,
// Cash Fund Transfers), so anything older than that loses its evidence for
// good unless the rows were kept. Each pull is authoritative for the range
// it returned: stored rows inside that range are replaced, rows outside it
// (older pulls) are kept. Works for any rows carrying `date` (ISO).
export function mergeDatedRows(stored, fresh, { dateMin = null, dateMax = null } = {}) {
  const inRange = (d) => (!dateMin || d >= dateMin) && (!dateMax || d <= dateMax);
  const kept = (stored || []).filter((r) => r?.date && !inRange(r.date));
  const rows = [...kept, ...(fresh || [])].sort((a, b) => a.date.localeCompare(b.date) || (a.timeInt ?? 0) - (b.timeInt ?? 0));
  const dates = rows.map((r) => r.date).filter(Boolean).sort();
  return { rows, dateMin: dates[0] || null, dateMax: dates.at(-1) || null, kept: kept.length };
}
export const mergeTillRows = mergeDatedRows;

export function tillsFor(rows, item, discrepancies, cfg = TILL_CFG, counterpart = null) {
  if (!rows?.length || !item?.register || !item?.date) return null;
  const events = eventsFor(rows, item.register, item.date, 1);
  const day = events.filter((e) => e.date === item.date);
  const advances = advanceExplanations(rows, item, discrepancies, cfg);
  const people = [...new Set(day.map((e) => e.associateId).filter(Boolean))];
  const moves = wrongRegisterMoves(rows.filter((r) => Math.abs(daysApart(r.date, item.date)) <= 1), cfg)
    .filter((m) => m.fromRegister === String(item.register) || m.toRegister === String(item.register) || people.includes(m.associateId));
  const kinds = { [String(item.register)]: registerKind(rows, item.register) };
  if (counterpart?.register) kinds[String(counterpart.register)] = registerKind(rows, counterpart.register);
  const dates = rows.map((r) => r.date).filter(Boolean).sort();
  return { events, day, advances, moves, flags: tillFlags(events, item), people: people.map((id) => ({ id, name: day.find((e) => e.associateId === id)?.associate || "" })), flip: flipCheckins(rows, item, counterpart), kinds, logRange: { min: dates[0] || null, max: dates.at(-1) || null } };
}

// What kind of lane a register is, from the till log itself. Self-checkouts
// never check a till in or out — their cash lives in the recycler — so a
// register with rows but no TILLCHECKIN/TILLCHECKOUT is treated as SCO even
// when the report's description does not say so.
export function registerKind(rows, register) {
  const reg = String(register);
  const mine = (rows || []).filter((r) => String(r.register) === reg);
  const desc = mine.map((r) => r.registerDesc).filter(Boolean).sort((a, b) => mine.filter((r) => r.registerDesc === b).length - mine.filter((r) => r.registerDesc === a).length)[0] || "";
  const hasCheckins = mine.some((r) => /^TILLCHECK(IN|OUT)/.test(r.action));
  return { register: reg, desc, hasRows: mine.length > 0, hasCheckins, sco: desc.toUpperCase() === "SCO" || (mine.length > 0 && !hasCheckins) };
}
