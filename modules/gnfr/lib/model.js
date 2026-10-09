// modules/gnfr/lib/model.js
//
// Supply Orders — compaction of MyGNFR OData rows and every derived view:
// line/cart status, supply area, who ordered what, regular items that have
// not been reordered, possible duplicates, late deliveries, spend roll-ups.
//
// Pure: no chrome.*, Node-testable (model.test.mjs). Dates are kept as ms
// (submit time, a real UTC timestamp) or "YYYY-MM-DD" (date-only SAP fields,
// which arrive as UTC midnight).

const DAY = 86_400_000;

// ── parsing ───────────────────────────────────────────────────────────────
/** "/Date(1792108800000)/" → "2026-10-16" (date-only SAP field), else "". */
export function sapDay(v) {
  const m = /\/Date\((-?\d+)/.exec(String(v || ""));
  if (!m || Number(m[1]) <= 0) return "";
  return new Date(Number(m[1])).toISOString().slice(0, 10);
}
/** "/Date(1791368754000+0000)/" → ms, else null. */
export function sapMs(v) {
  const m = /\/Date\((-?\d+)/.exec(String(v || ""));
  return m && Number(m[1]) > 0 ? Number(m[1]) : null;
}
const num = (v) => { const n = Number(String(v ?? "").trim()); return Number.isFinite(n) ? n : 0; };
const trimNum = (v) => String(v || "").replace(/^0+(?=\d)/, "");

/** One raw ZMPU_C_IPRO_OT_RESULTS cart (with to_Details) → compact cart. */
export function compactCart(c) {
  const lines = (c.to_Details?.results || []).map((l) => ({
    pr: l.purReq || "", item: l.itemNo || "", po: l.poNumber || "",
    art: trimNum(l.articleNumber), desc: String(l.articleDescr || "").trim(),
    status: String(l.itemStatusTranslation || l.itemStatus || "").trim(),
    qty: num(l.quantity), uom: l.priceUom || "", price: num(l.price), net: num(l.netPrice),
    type: l.itemType || "", doc: l.docType || "", mcc: l.mcc || "",
    eta: sapDay(l.deliveryDate), poDay: sapDay(l.poDate), shipDay: sapDay(l.shippingDate), arrDay: sapDay(l.arrivalDate),
    trk: String(l.trackingNo || "").trim(), carrier: l.carrierCode || "", delivered: l.delivered === true,
    del: l.delInd === "X", img: l.articleImage || "", supplier: l.supplierNumber || l.lifnr || "",
    lead: num(l.leadTime), week: l.weekNumber || "", note: String(l.itemComments || "").trim(),
  }));
  const comment = String(c.cartComments || "").replace(/^\|/, "").split("|").map((s) => s.trim()).filter(Boolean)[0] || "";
  return {
    id: c.cartID, win: c.userID || "", name: c.cartName || "",
    at: num(c.submitTimeStamp) || sapMs(c.submitDate) || 0,
    total: num(c.price), comment, ship: String(c.shipInstructions || "").trim(),
    lines,
  };
}

/** Raw APR_TRACK rows for one PR → compact approval steps. */
export function compactApprovals(rows = []) {
  return rows.map((a) => ({
    by: a.approver || "", name: [a.apprFname, a.apprLname].filter(Boolean).join(" "), title: a.jobTitle || "",
    status: a.status || "", role: a.agentType || "",
    at: sapMs(a.creatimestamp), doneAt: sapMs(a.compltimestamp),
    comment: String(a.apprComments || "").replace(/\|\s*$/, "").trim(),
  })).sort((x, y) => (x.at || 0) - (y.at || 0));
}

// ── line + cart status ────────────────────────────────────────────────────
// MyGNFR's itemStatus vocabulary seen at 1458 (1,230 lines, 100 days):
// Delivered, PO Created, Pending Approval, Submitted, Shipped, Rejected.
export const STAGES = ["submitted", "approval", "ordered", "shipped", "delivered"];
export function lineStage(l) {
  const s = String(l.status || "").toLowerCase();
  if (l.del || /reject|cancel|delet/.test(s)) return "rejected";
  if (l.delivered || /deliver|received|complete/.test(s)) return "delivered";
  if (/pending|approval|await/.test(s)) return "approval";
  if (/ship|transit/.test(s) || l.shipDay) return "shipped";
  if (/po created|ordered|confirm/.test(s) || l.po) return "ordered";
  return "submitted";
}
export const STAGE_LABEL = {
  submitted: "Submitted", approval: "Awaiting approval", ordered: "Ordered",
  shipped: "Shipped", delivered: "Delivered", rejected: "Rejected", late: "Late", stale: "No delivery record",
};

// D-99 supply POs often never get a delivered flag (at 1458, 89 of 141
// "past due" lines were >90 days old with no tracking). So an expected date
// that passed within LATE_WINDOW days is LATE; older than that, the line has
// NO DELIVERY RECORD — worth a check that it arrived, not an alarm.
export const LATE_WINDOW = 21;
const openish = (st) => st === "ordered" || st === "shipped" || st === "submitted";
const ageDays = (day, today) => Math.round((Date.parse(today) - Date.parse(day)) / DAY);

/** Expected-by passed (within the last LATE_WINDOW days) and it hasn't arrived. */
export function isLate(l, today) {
  return openish(lineStage(l)) && !!l.eta && l.eta < today && ageDays(l.eta, today) <= LATE_WINDOW;
}
/** Expected more than LATE_WINDOW days ago and never marked delivered. */
export function isStale(l, today) {
  return openish(lineStage(l)) && !!l.eta && ageDays(l.eta, today) > LATE_WINDOW;
}

/** Cart roll-up: the stage most of its open lines are stuck at. */
export function cartState(cart, today) {
  const st = cart.lines.map(lineStage);
  const live = st.filter((s) => s !== "rejected");
  const delivered = live.filter((s) => s === "delivered").length;
  let stage;
  if (!live.length) stage = st.length ? "rejected" : "submitted";
  else if (live.includes("approval")) stage = "approval";
  else if (delivered === live.length) stage = "delivered";
  else stage = STAGES.find((s) => live.includes(s)) || "ordered";
  const late = cart.lines.filter((l) => isLate(l, today)).length;
  const stale = cart.lines.filter((l) => isStale(l, today)).length;
  if (stage !== "approval" && stage !== "delivered" && stage !== "rejected" && stale && stale === live.length - delivered) stage = "stale";
  return { stage, delivered, open: live.length - delivered, rejected: st.length - live.length, late, stale, lines: st.length };
}

// ── supply area ───────────────────────────────────────────────────────────
// MCC codes are too loose to name an area (24141501 holds bakery rack covers
// AND cake kits AND bun bags), but MyGNFR descriptions lead with a department
// word. First matching rule wins; then item type; then "Other supplies".
const AREA_RULES = [
  ["Bakery & Deli",        /\b(BAKERY|DELI|DONUT|CAKE|ROTISSERIE|FRYER|HAWK|FOOD ?SERVICE|FOOD STORAGE|FOOD WIPER|WYPALL|RINGS|CHICKEN|DEMO FORK|PASTRY|CROISSANT|APRON|SUGAR|MEAL SOLUTION)\b/],
  ["Meat & Produce",       /\b(MEAT|PRODUCE)\b/],
  ["Pharmacy",             /\b(PHARMACY|HIPAA|RX\b|SYRINGE|IMMUNIZ)/],
  ["Vision Center",        /\b(VISION|OPTICAL|LENS|ZEISS|NOSE PAD|A\/R PEN)/],
  ["Photo",                /\bD85\b|PHOTOBOOK|EPSON/],
  ["Auto Care",            /\b(ACC\b|ACC ONLY|TIRE|WHEEL WEIGHT|BEAD LEVELER|HOSE REEL|APD ONLY|DRAIN PLUG|OIL PAD|WHL WEIGHT|BATTERY SERVICE)/],
  ["Digital / OPD",        /\b(OPD|OGP|SFS|GMD|VIZPICK|PICKING CART|TOTE|MAILER)\b/],
  ["Asset Protection",     /\b(SPIDERWRAP|ALARM|SAFETACHER|SAFE TACHER|DEPOSIT BAG|EAS|CVP|KEEPER|SECURITY|AP AND CLAIMS)\b/],
  ["Front End",            /\b(RECEIPT|REGISTER|RIBBON|SHOPPING CARD|BAG(S)? PLASTIC|BELT LANE|LANE CLOSED)\b/],
  ["Restroom & Paper",     /\b(TOILET|TISSUE|TOWEL|RESTROOM|URINAL|SOAP|HAND SANIT)/],
  ["Cleaning & Janitorial",/\b(CLEAN|MOP|BROOM|JANITORIAL|DELIMER|SANITIZER|CAN LINER|TRASH|TENNANT|TENN|SQUEEGEE|PAD DRIVER|BUCKET|ABSORBENT|AIR FRESHENER)/],
  ["Safety & PPE",         /\b(GLOVE|NITRILE|PPE|FIRST.AID|BANDAGE|SAFETY|CONE|VEST|GOGGLE|EYEWASH|HAZMAT|THERMAL SLEEVE)/],
  ["Labels & Signage",     /\b(LABEL|SIGN|SHELF TAG|FLATSTOCK|STICKER|BARCODE)/],
  ["Backroom & Freight",   /\b(PALLET|STRETCH|FILM|BALE|BOX CUTTER|BOX RETURN|RETURN BOX|DOLLY|FORKL|PROPANE|SLIP SHEET|CARDBOARD|TSACK|HOOK COVER|WACO|GAYLORD|SHIPPING TAPE|SEALING|STRETCH)/],
  ["Uniforms & Badges",    /\b(BADGE|UNI\b|UNIFORM|NAME TAG|LANYARD)/],
  ["Office & Tech",        /\b(OFFICE|PAPER ROLL|TONER|INK|PRINTER|MONITOR|DELL|LAPTOP|ZEBRA|LEXMARK|BUSINESS CARD|PEN\b|STAPLE|GLUE|PAPER COPY|TAPE)/],
  ["Fixtures & Equipment", /\b(FIXTURE|CART\b|SHELF|HOSE|HAMMER|TOOL)/],
  ["Breakroom",            /\b(COFFEE|BREAKROOM|CREAMER|CUPS?)\b/],
];
const TYPE_AREA = { FIXS: "Fixtures & Equipment", SAFE: "Safety & PPE", ASPR: "Asset Protection", SYST: "Office & Tech", PRNT: "Office & Tech" };
export const AREAS = [...AREA_RULES.map(([a]) => a), "Other supplies"];

export function areaOf(line) {
  const d = String(line.desc || "").toUpperCase();
  for (const [area, re] of AREA_RULES) if (re.test(d)) return area;
  return TYPE_AREA[line.type] || "Other supplies";
}

// ── people ────────────────────────────────────────────────────────────────
/** Name key for matching a GNFR name ("CHRISTIAN YOUNG") to a schedule name. */
export function nameKey(raw) {
  const w = String(raw || "").toUpperCase().replace(/[^A-Z\s'-]/g, " ").split(/\s+/).filter(Boolean);
  return w.length >= 2 ? `${w[0]}|${w.at(-1)}` : "";
}

const titleCase = (s) => String(s || "").toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());

/**
 * Who a WIN is: name from MyGNFR's user search, job title from the store's
 * WFM schedule (roster by name key), or from an approval row (approvers carry
 * their own title), or — for the signed-in user — their bootstrap profile.
 */
export function personOf(win, data) {
  const u = data.users?.[win] || {};
  const me = data.me?.win === win ? data.me : null;
  // Approval rows carry the PREFERRED name ("Tom Scott") where user search
  // has the legal one ("JAMES SCOTT"); prefer it when there is one.
  let appr = null;
  for (const steps of Object.values(data.approvals || {})) {
    appr = steps.find((s) => s.by === win && (s.name || s.title));
    if (appr) break;
  }
  const legal = titleCase(u.name || me?.name || "");
  const name = appr?.name || legal;
  const roster = data.roster?.map || {};
  const job = roster[nameKey(name)] || roster[nameKey(legal)] || appr?.title || (me ? me.job || "" : "");
  return { win, name: name || `WIN ${win}`, known: !!name, job, sam: u.sam || "", legal: legal !== name ? legal : "" };
}

/**
 * MyGNFR approval comments are a log in one string, newest first, " | "-separated:
 *   "Tom Scott-NOV 01 2025 at 07:59:57 EST-Rejected-Duplicate material | Tom Scott-…-Approved-Cases needed…"
 *   "NMP002B - 20260525 205834 - R - Anthony Travis-MAY 25 2026 at 14:19:56 EST-Approved-old IMZ cart is broken"
 * → [{ who, when, action, note }] oldest first.
 */
export function parseApprovalLog(text) {
  const out = [];
  for (const part of String(text || "").split("|")) {
    const m = /([A-Za-z][A-Za-z .'-]*?)-([A-Z]{3} \d{1,2} \d{4} at [\d:]+(?: [A-Z]{2,4})?)-([A-Za-z ]+?)-(.*)$/.exec(part.trim());
    if (m) out.push({ who: m[1].replace(/^.*\s-\s/, "").trim(), when: m[2], action: m[3].trim(), note: m[4].trim() });
  }
  return out.reverse();
}

// ── derived views ─────────────────────────────────────────────────────────
const dayOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
export const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mode = (xs) => { const c = new Map(); for (const x of xs) c.set(x, (c.get(x) || 0) + 1); return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]; };

/** Flatten carts → lines with cart context. Rejected/deleted lines kept, flagged by stage. */
export function flatLines(carts, today) {
  const out = [];
  for (const c of carts) {
    for (const l of c.lines) {
      out.push({ ...l, cart: c.id, win: c.win, at: c.at, day: dayOf(c.at), area: areaOf(l), stage: lineStage(l), late: isLate(l, today), stale: isStale(l, today) });
    }
  }
  return out;
}

/**
 * Items the store orders on a rhythm and hasn't reordered.
 * An item counts as regular with ≥4 separate order occasions (orders within
 * 3 days of each other are one occasion) whose median gap is ≤ 60 days.
 *   overdue   days since last > max(1.5 × gap, gap + 7), up to 3 × gap
 *   due       within 3 days of (or past) last + gap
 *   lapsed    > 3 × gap and > 30 days: the rhythm stopped — probably no
 *             longer needed, or ordered under another item number
 * Tuned on 1458's year (2026-10-08): 285 regular items, ~45 overdue.
 */
export function regulars(lines, today, { minOccasions = 4, maxGap = 60 } = {}) {
  const byArt = new Map();
  for (const l of lines) {
    if (l.stage === "rejected" || !l.art) continue;
    if (!byArt.has(l.art)) byArt.set(l.art, []);
    byArt.get(l.art).push(l);
  }
  const out = [];
  for (const [art, ls] of byArt) {
    ls.sort((a, b) => a.at - b.at);
    const occ = [];
    for (const l of ls) {
      const last = occ.at(-1);
      if (last && daysBetween(last.day, l.day) <= 3) { last.qty += l.qty; last.wins.push(l.win); continue; }
      occ.push({ day: l.day, qty: l.qty, wins: [l.win] });
    }
    if (occ.length < minOccasions) continue;
    const gaps = occ.slice(1).map((o, i) => daysBetween(occ[i].day, o.day));
    const gap = Math.max(1, Math.round(median(gaps)));
    if (gap > maxGap) continue;
    const lastDay = occ.at(-1).day;
    const since = daysBetween(lastDay, today);
    const dueDay = new Date(Date.parse(lastDay) + gap * DAY).toISOString().slice(0, 10);
    let state = "ok";
    if (since > 3 * gap && since > 30) state = "lapsed";
    else if (since > Math.max(1.5 * gap, gap + 7)) state = "overdue";
    else if (since >= gap - 3) state = "due";
    const latest = ls.at(-1);
    out.push({
      art, desc: latest.desc, area: latest.area, img: latest.img, price: latest.price, uom: latest.uom,
      occasions: occ.length, gap, qty: median(occ.map((o) => o.qty)), lastDay, since, dueDay, state,
      usualWin: mode(occ.flatMap((o) => o.wins)), lastWin: occ.at(-1).wins.at(-1),
      open: ls.some((l) => ["submitted", "approval", "ordered", "shipped"].includes(l.stage)),
    });
  }
  const rank = { overdue: 0, due: 1, lapsed: 2, ok: 3 };
  return out.sort((a, b) => rank[a.state] - rank[b.state] || b.since / b.gap - a.since / a.gap);
}

/**
 * Possible double orders: the same item in two different carts within `days`
 * of each other, neither rejected, AND the same person or the same quantity.
 * (Different departments ordering the same towels the same week is normal —
 * at 1458 a plain 7-day window flagged 173 pairs; this rule flags ~6/100 days,
 * the shape of the store manager's "Duplicate material" rejections.)
 */
export function duplicates(lines, { days = 2, sinceDay = "" } = {}) {
  const byArt = new Map();
  for (const l of lines) {
    if (l.stage === "rejected" || !l.art) continue;
    if (!byArt.has(l.art)) byArt.set(l.art, []);
    byArt.get(l.art).push(l);
  }
  const out = [];
  for (const ls of byArt.values()) {
    ls.sort((a, b) => a.at - b.at);
    for (let i = 1; i < ls.length; i++) {
      const a = ls[i - 1], b = ls[i];
      if (a.cart === b.cart || (sinceDay && b.day < sinceDay)) continue;
      if ((b.at - a.at) / DAY <= days && (a.win === b.win || a.qty === b.qty)) out.push({ art: b.art, desc: b.desc, area: b.area, a, b, sameWin: a.win === b.win });
    }
  }
  return out.sort((x, y) => y.b.at - x.b.at);
}

/** Per-orderer roll-up. */
export function people(carts, lines) {
  const m = new Map();
  for (const c of carts) {
    if (!m.has(c.win)) m.set(c.win, { win: c.win, carts: 0, lines: 0, spend: 0, last: 0, first: Infinity, areas: {}, open: 0 });
    const p = m.get(c.win);
    p.carts++; p.last = Math.max(p.last, c.at); p.first = Math.min(p.first, c.at);
  }
  for (const l of lines) {
    const p = m.get(l.win);
    if (!p || l.stage === "rejected") continue;
    p.lines++; p.spend += l.net;
    p.areas[l.area] = (p.areas[l.area] || 0) + l.net;
    if (l.stage !== "delivered") p.open++;
  }
  return [...m.values()].map((p) => ({ ...p, topAreas: Object.entries(p.areas).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a]) => a) }))
    .sort((a, b) => b.spend - a.spend);
}

/** Spend by key (area / month / person) over non-rejected lines. */
export function spendBy(lines, keyFn) {
  const m = new Map();
  for (const l of lines) {
    if (l.stage === "rejected") continue;
    const k = keyFn(l);
    const e = m.get(k) || { key: k, spend: 0, lines: 0 };
    e.spend += l.net; e.lines++;
    m.set(k, e);
  }
  return [...m.values()];
}

/** Tracking link for a line, or null. Vendor "tracking numbers" that are phone numbers are not links. */
export function trackingUrl(l) {
  const t = String(l.trk || "").replace(/\s+/g, "");
  if (!t || /^\(?\d{3}\)?-?\d{3}-?\d{4}$/.test(t) || /[()]/.test(l.trk)) return null;
  if (/^(FXFE|FDE|FDEG|FEDEX)/i.test(l.carrier) || /^\d{12,15}$/.test(t)) return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(t)}`;
  if (/^UPS/i.test(l.carrier) || /^1Z/i.test(t)) return `https://www.ups.com/track?tracknum=${encodeURIComponent(t)}`;
  if (/^USPS/i.test(l.carrier)) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(t)}`;
  return null;
}

export const CARRIER = { FXFE: "FedEx Express", FDE: "FedEx", FDEG: "FedEx Ground", VENTK: "Vendor truck" };
