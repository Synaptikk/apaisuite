// modules/boblisa/lib/video.js
//
// APPRISS CCTV link for a register at a moment, with no transaction id.
// The viewer (/walmart-usa/video/react#/cameras) accepts either
// ?transactionId=<id> or ?storeNo=&posNo=&startTime=&endTime= (ISO local
// store time, no zone). Verified 2026-09-14 on store 1458 / register 25:
// the server pads the window 30 s before and 120 s after, then plays.
// An EJ receipt's timestamp is when the transaction ENDED, so the window
// starts two minutes earlier to cover the scanning.
//
// Pure — no chrome.*, safe in the shell and node.

import { APPRISS_BASE } from "../../../shared/appriss.js";

export const BEFORE_SEC = 120;
export const AFTER_SEC = 15;

function shift(dateIso, hms, deltaSec) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateIso || ""));
  const t = /^(\d{2}):(\d{2}):(\d{2})/.exec(String(hms || ""));
  if (!m || !t) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +t[1], +t[2], +t[3]) + deltaSec * 1000);
  return d.toISOString().slice(0, 19);   // treated as store-local by the viewer
}

/** @returns {string|null} viewer URL, or null when the inputs are unusable */
export function videoUrl(storeNbr, register, dateIso, hms, { beforeSec = BEFORE_SEC, afterSec = AFTER_SEC } = {}) {
  const start = shift(dateIso, hms, -beforeSec), end = shift(dateIso, hms, afterSec);
  if (!start || !end || !storeNbr || register == null) return null;
  const q = new URLSearchParams({ storeNo: String(storeNbr), posNo: String(register), startTime: start, endTime: end });
  return `${APPRISS_BASE}/video/react#/cameras?${q}`;
}
