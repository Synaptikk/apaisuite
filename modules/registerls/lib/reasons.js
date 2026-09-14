// modules/registerls/lib/reasons.js
//
// WorkView disposition reasons, per work-item source (recorded 2026-09-12
// from /system/workview/search/abandonreasonsselect.search — see
// dev/REGISTER_LS_FINDINGS.md §1). The two register sources have DIFFERENT
// lists, which is why a "Process Errors" fill silently did nothing on a
// "Long/Short - Cash" item.

export const REASONS = {
  // sourceAppId "mel" — "Action Required: Long/Short Item"
  mel: ["Internal Theft", "Process Errors", "Cash Card Scam", "Counterfeit Bills", "Phone Scam", "Quick Change", "Robbery", "Multiple Reasons", "Not Identified"],
  // sourceAppId "overshort" — "Long/Short - Cash" rules
  overshort: [
    "Process Error - Till Check-Ins", "Process Error - Cash Advances", "Process Error - Cash Pickups",
    "Process Error - Drop Vault", "Process Error - Content Out of Balance", "Process Error - Lottery",
    "Process Error - Cashier", "Process Error - CFT", "Process Error - SCO Down", "Process Error - Recycler Down/Connectivity",
  ],
};

export function reasonsFor(sourceAppId) {
  return REASONS[String(sourceAppId || "").toLowerCase()] || REASONS.mel;
}

// The reason the module files for each nothing-found verdict.
export function safeReasonFor(sourceAppId, verdict, { advance = false } = {}) {
  const src = String(sourceAppId || "").toLowerCase();
  if (verdict === "pantry_cft") return src === "overshort" ? "Process Error - CFT" : "Process Errors";
  if (src === "overshort") {
    if (advance) return "Process Error - Cash Advances";
    if (verdict === "bounceback") return "Process Error - Content Out of Balance";
    return "Process Error - Till Check-Ins";
  }
  return "Process Errors";
}
