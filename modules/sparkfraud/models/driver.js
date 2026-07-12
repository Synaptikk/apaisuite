// Driver — normalized Spark driver identity.
//
// Source: raw Dispatcher response trip.driver shape (notes/api_endpoints.md:52-59).
// Normalizations:
//   - email lowercased
//   - phone normalized to E.164 when 10 or 11 digits (US)
//   - empty fields become null (NOT empty string)
//
// Sensitive — do NOT serialize unredacted in telemetry or persisted artifacts.
// A future Driver.publicSummary() should return only { hasPhone, hasEmail, uuid }
// for non-investigator-facing surfaces.

export function toDriver(raw) {
  if (!raw || typeof raw !== "object") raw = {};
  const first = raw.firstName || "";
  const last  = raw.lastName  || "";
  return {
    fullName: `${first} ${last}`.trim() || "<unassigned>",
    preferredName: raw.preferredName || null,
    email: ((raw.driverUserId || "").toLowerCase()) || null,
    phoneE164: normalizePhone((raw.contact || {}).phoneNumber),
    uuid: raw.driverUuid || null,
  };
}

function normalizePhone(s) {
  if (!s) return null;
  const digits = String(s).replace(/\D/g, "");
  if (digits.length === 10)                    return "+1" + digits;
  if (digits.length === 11 && digits[0] === "1") return "+"  + digits;
  return String(s);  // pass through unrecognised formats untouched
}
