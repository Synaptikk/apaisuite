// modules/registerls/lib/registers.js
//
// What each register IS at a store — self-checkout, front end, service desk,
// money center, pharmacy, a department register — because the matching
// rules depend on it (the service desk offsets any register store-wide) and
// the layout differs store to store (analyst, 2026-09-17: at 1458 92/93/94
// are the service desk and 61–64 the money center; elsewhere they are not).
//
// Sources, in order of trust:
//   1. the analyst's own override for this store (registerls.registers.<store>)
//   2. the Cash Recycler till log's Register_Desc when it names a SPECIFIC
//      kind — SCO, FRONT END, CUSTOMER SERVICE, MONEY CENTER, PHARMACY. At
//      1458 the log labels every register the Power BI grid knows.
//   3. the number-range defaults below (money center 61–64, service desk
//      92–94) for registers the log does not label or labels UNKNOWN.
//   4. a department label from the log (ELECTRONICS, GARDEN CENTER…). It
//      ranks BELOW the range defaults because the log's description is the
//      register's configured department and goes stale when a register is
//      moved: 1458's reg 63 is "COSMETIC" in the log but sits in the money
//      center. The UI shows both so the disagreement is visible.
//
// Pure: no chrome.* here. The service worker feeds it the cached till rows,
// the registers the grid/queue know, and the stored overrides.

export const ROLES = Object.freeze({
  sco:          "Self-checkout",
  front_end:    "Front end",
  service_desk: "Service desk",
  money_center: "Money center",
  pharmacy:     "Pharmacy",
  department:   "Department register",
  unknown:      "Unknown",
});

export const DEFAULT_RANGES = Object.freeze([
  { from: 61, to: 64, role: "money_center" },
  { from: 92, to: 94, role: "service_desk" },
]);

const SPECIFIC = new Set(["sco", "front_end", "service_desk", "money_center", "pharmacy"]);

export function isRole(role) { return Object.prototype.hasOwnProperty.call(ROLES, role); }

// The till log's Register_Desc → a role, or null when it says nothing.
export function roleFromDesc(desc) {
  const d = String(desc || "").trim().toUpperCase();
  if (!d || d === "UNKNOWN" || d === "N/A") return null;
  if (d === "SCO" || /SELF.?CHECK/.test(d)) return "sco";
  if (/FRONT ?END/.test(d)) return "front_end";
  if (/CUSTOMER ?SERVICE|SERVICE ?DESK/.test(d)) return "service_desk";
  if (/MONEY ?(CENTER|CENTRE|SERVICES?)/.test(d)) return "money_center";
  if (/PHARMACY/.test(d)) return "pharmacy";
  return "department";
}

export function defaultRole(register, ranges = DEFAULT_RANGES) {
  const n = Number(register);
  if (!Number.isFinite(n)) return null;
  return ranges.find((r) => n >= r.from && n <= r.to)?.role || null;
}

// Majority Register_Desc per register from the till log.
export function descsFromTillRows(rows = []) {
  const counts = new Map();
  for (const r of rows || []) {
    const reg = String(r.register || "").replace(/^0+(?=\d)/, "");
    if (!reg) continue;
    const d = String(r.registerDesc || "").trim();
    const m = counts.get(reg) || new Map();
    m.set(d, (m.get(d) || 0) + 1);
    counts.set(reg, m);
  }
  const out = {};
  for (const [reg, m] of counts) {
    const [desc, n] = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    out[reg] = { desc, rows: [...m.values()].reduce((s, x) => s + x, 0), descRows: n };
  }
  return out;
}

// { [register]: { register, role, label, desc, rows, source } }, sorted by
// register number. `registers` adds registers the grid / queue know even when
// the till log has no rows for them. `overrides` is { [register]: role }.
export function buildRegisterMap({ tillRows = [], registers = [], overrides = {} } = {}) {
  const descs = descsFromTillRows(tillRows);
  const regs = new Set([...Object.keys(descs), ...(registers || []).map((r) => String(r).replace(/^0+(?=\d)/, "")).filter(Boolean), ...Object.keys(overrides || {})]);
  const map = {};
  for (const reg of regs) {
    const d = descs[reg] || { desc: "", rows: 0 };
    const logRole = roleFromDesc(d.desc);
    const over = overrides?.[reg];
    let role, source;
    if (over && isRole(over))              { role = over;                 source = "analyst"; }
    else if (logRole && SPECIFIC.has(logRole)) { role = logRole;          source = "log"; }
    else if (defaultRole(reg))              { role = defaultRole(reg);     source = "default"; }
    else if (logRole)                       { role = logRole;              source = "log"; }
    else                                    { role = "unknown";            source = "none"; }
    map[reg] = { register: reg, role, label: ROLES[role], desc: d.desc, rows: d.rows, source, logRole };
  }
  return Object.fromEntries(Object.entries(map).sort((a, b) => Number(a[0]) - Number(b[0])));
}

// Registers the matcher lets pair store-wide: the service desk.
export function wideRegistersOf(map) {
  return Object.values(map || {}).filter((e) => e.role === "service_desk").map((e) => e.register);
}

export function roleOf(map, register) {
  return map?.[String(register).replace(/^0+(?=\d)/, "")] || null;
}

// "Reg 63 (money center)" for prose; empty suffix for a plain front-end lane.
export function roleSuffix(map, register) {
  const e = roleOf(map, register);
  if (!e || e.role === "front_end" || e.role === "unknown") return "";
  return e.role === "department" && e.desc ? ` (${e.desc.toLowerCase()})` : ` (${e.label.toLowerCase()})`;
}
