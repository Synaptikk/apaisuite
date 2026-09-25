// modules/boblisa/lib/appriss_people.js
//
// Full operator names (and WIN) from APPRISS. The journal only prints a
// truncated sign-on banner (`****** 5638    MALEIGHA CLO******`); the APPRISS
// receipt viewer shows "OP: MALEIGHA CLOWDUS  WIN: 233359383" because its
// journal-event call joins the associate table. Probed 2026-09-16 on store
// 1458 reg 63 TR 9978:
//
//   POST {APPRISS_BASE}/platform/viewer/store/api/v1/journal/event/<transactionId>?connectionName=pos-data
//   (empty body, same-origin cookies)
//   → { data: { storecashierno: "5638", employee: { employeeid: "233359383",
//        operatorid: "M0C19P6", firstname, lastname, operatorrole, cashierno: "001458005638" } } }
//
// The transaction id is APPRISS's own; registerls' Open Drawer search lists
// every drawer-opening transaction on a register-day with its id AND its
// cashier number, so one Open Drawer page names every cashier who took cash
// on that register that day. Card-only operators need a drawer open somewhere
// in APPRISS's ~60-day window.
//
//   journalEventUrl(tid)          → URL
//   parseEmployee(json)           → { op, first, last, name, win, userId, role } | null   (pure)
//   fetchEmployee(tid)            → { ok: true, employee } | { ok: false, errorClass, error, loginUrl? }

import { APPRISS_BASE, APPRISS_HOME } from "../../../shared/appriss.js";

export const journalEventUrl = (tid) => `${APPRISS_BASE}/platform/viewer/store/api/v1/journal/event/${encodeURIComponent(tid)}?connectionName=pos-data`;

const stripZeros = (v) => (v == null ? "" : String(v).replace(/^0+(?=\d)/, ""));
const clean = (v) => String(v ?? "").trim();

export function parseEmployee(json) {
  const d = json?.data;
  const e = d?.employee;
  if (!e || (!e.firstname && !e.lastname)) return null;
  const first = clean(e.firstname), last = clean(e.lastname);
  return {
    op: stripZeros(e.x_storecashierno || d.storecashierno || String(e.cashierno || "").slice(-6)),
    first, last,
    name: [first, last].filter(Boolean).join(" "),
    win: clean(e.employeeid || d.x_employeeid),
    userId: clean(e.operatorid),
    role: clean(e.operatorrole),
  };
}

export async function fetchEmployee(tid, { timeoutMs = 30_000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(journalEventUrl(tid), {
      method: "POST", credentials: "include", signal: ctrl.signal,
      headers: { accept: "application/json, text/plain, */*", "x-requested-with": "XMLHttpRequest" },
    });
    const ct = r.headers.get("content-type") || "";
    if (r.status === 401 || r.status === 403 || /text\/html/.test(ct)) {
      return { ok: false, errorClass: "AUTH", error: "APPRISS session expired — open Secure, complete SSO, then look up names again.", loginUrl: APPRISS_HOME };
    }
    if (!r.ok) return { ok: false, errorClass: "HTTP", error: `APPRISS journal event HTTP ${r.status}` };
    const json = await r.json();
    return { ok: true, employee: parseEmployee(json) };
  } catch (e) {
    return { ok: false, errorClass: "NETWORK", error: `APPRISS journal event failed: ${e?.name === "AbortError" ? "timed out" : e?.message || e}` };
  } finally {
    clearTimeout(timer);
  }
}
