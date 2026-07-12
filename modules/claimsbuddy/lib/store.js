// Store-number normalization. The three sources expect different formats:
//   CAS         — bare number, no padding (e.g. "9999.html")
//   VEE         — zero-padded to 5 digits inside the hostname (e.g. "s09999")
//   ClearSight  — TBD; will likely use whatever shape its API expects
//
// Validation matches `_validate_store()` in vee_dashboard/app.py: 1–5
// digits after stripping non-numeric characters.

export function normalizeStore(raw) {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length < 1 || digits.length > 5) {
    throw new Error("Enter a store number (1–5 digits).");
  }
  return {
    short:   digits,                    // e.g. "9999"
    padded5: digits.padStart(5, "0"),   // e.g. "09999"
  };
}
