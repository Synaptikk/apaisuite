// modules/boblisa/lib/registers.js
//
// Register classification for the second-transaction search. Ranges are
// inclusive [lo, hi] pairs. Observed on store 1458 (2026-09-14):
//   1-8 and 27-34  self-checkout (op = 9000 + register)
//   9-25           manned lanes (the user's rule)
//   62-63, 92-94   Money Center (bill pay, debit loads, money orders, stamps)
//   82             OPD dispense (op 9998)
//   95             Automotive (tires, oil)
//   98             Vision Center — the ONLY Vision register (user, 2026-09-14).
//                  Training-mode receipts for missed items print on 92-94
//                  and 98 (ops 9025/9052/9053), not on a dedicated device.
// Pure — no DOM, no chrome.*, safe in the SW, the shell and node.

export const DEFAULT_REGISTERS = Object.freeze({
  manned:      [[9, 25]],
  vision:      [[98, 98]],
  automotive:  [[95, 95]],
  sco:         [[1, 8], [27, 34]],
  moneyCenter: [[62, 63], [92, 94]],
  pickup:      [[82, 82]],
});

export const TYPES = Object.freeze(["Manned", "Self-checkout", "Vision", "Automotive", "Pickup", "Money Center", "Other"]);

const inRanges = (n, ranges) => Array.isArray(ranges) && ranges.some(([lo, hi]) => n >= lo && n <= hi);

export function isManned(reg, cfg = DEFAULT_REGISTERS) { return inRanges(Number(reg), cfg.manned); }
export function isVision(reg, cfg = DEFAULT_REGISTERS) { return inRanges(Number(reg), cfg.vision); }

export function registerType(reg, cfg = DEFAULT_REGISTERS) {
  const n = Number(reg);
  if (!Number.isFinite(n)) return "Other";
  if (inRanges(n, cfg.manned)) return "Manned";
  if (inRanges(n, cfg.vision)) return "Vision";
  if (inRanges(n, cfg.automotive)) return "Automotive";
  if (inRanges(n, cfg.sco)) return "Self-checkout";
  if (inRanges(n, cfg.moneyCenter)) return "Money Center";
  if (inRanges(n, cfg.pickup)) return "Pickup";
  return "Other";
}
