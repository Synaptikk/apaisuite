// modules/licenseintake/lib/redaction.js
//
// PII redaction helpers for LicenseIntake. Used for:
//   - Building safe log messages
//   - Building default-collapsed UI previews
//   - Sanitizing payloads before chrome.storage writes
//
// Hard rule: this module must NEVER emit (return / log / store) the raw
// unmasked license number, full DOB, or full address in a single call
// path unless the explicit "expand" flag is set by an operator gesture.

/**
 * Mask a driver's license number to last 4. "1234567890" → "******7890".
 * Returns "" for nullish input.
 * @param {string | null | undefined} dl
 */
export function maskLicenseNumber(dl) {
  if (!dl) return "";
  const s = String(dl);
  if (s.length <= 4) return "*".repeat(s.length);
  return "*".repeat(s.length - 4) + s.slice(-4);
}

/**
 * Mask a DOB to year only. "1985-03-15" → "1985-**-**".
 * Returns "" for nullish input.
 * @param {string | null | undefined} dob
 */
export function maskDob(dob) {
  if (!dob) return "";
  const m = /^(\d{4})/.exec(String(dob));
  return m ? `${m[1]}-**-**` : "****-**-**";
}

/**
 * Mask DOB to a "decade hint" — even less specific. "1985-03-15" → "1980s".
 * Use for log lines where we want to convey age range but never the date.
 * @param {string | null | undefined} dob
 */
export function maskDobToDecade(dob) {
  if (!dob) return "";
  const m = /^(\d{4})/.exec(String(dob));
  if (!m) return "unknown";
  const yyyy = +m[1];
  const decade = Math.floor(yyyy / 10) * 10;
  return `${decade}s`;
}

/**
 * Replace all but the first letter of each address component with X's.
 * "1234 Main St Apt 5" → "1XXX MXXX SX AXX X".
 * Use only when SOME address signal is needed (e.g., comparing to a search
 * result); for logs, prefer redactAddress() = "[address present]".
 * @param {string | null | undefined} addr
 */
export function maskAddress(addr) {
  if (!addr) return "";
  return String(addr).replace(/\b(\w)(\w*)/g, (_, first, rest) => first + "X".repeat(rest.length));
}

/**
 * Replace an address with a presence marker. Use this on any log path.
 * @param {string | null | undefined} addr
 */
export function redactAddress(addr) {
  return addr ? "[address present]" : "";
}

/**
 * Build a redacted-preview string for the LicensePerson model. Suitable
 * for default UI display and for log messages. Operator must explicitly
 * "expand" to see unmasked values.
 *
 * Example output: "DOE, J. [DL ****7890, DOB 1985-**-**, address present]"
 * @param {{
 *   firstName?: string | null,
 *   lastName?: string | null,
 *   middleName?: string | null,
 *   dob?: string | null,
 *   licenseNumber?: string | null,
 *   address1?: string | null,
 *   addressStreet?: string | null,
 * }} p
 */
export function buildRedactedPreview(p) {
  if (!p) return "";
  const last = (p.lastName || "").toUpperCase() || "?";
  const firstInitial = (p.firstName || "").charAt(0).toUpperCase() || "?";
  const middleInitial = (p.middleName || "").charAt(0).toUpperCase();
  const nameBit = middleInitial
    ? `${last}, ${firstInitial}. ${middleInitial}.`
    : `${last}, ${firstInitial}.`;
  const dlBit = p.licenseNumber ? `DL ${maskLicenseNumber(p.licenseNumber)}` : "";
  const dobBit = p.dob ? `DOB ${maskDob(p.dob)}` : "";
  const addr = p.address1 || p.addressStreet || "";
  const addrBit = redactAddress(addr);
  const extras = [dlBit, dobBit, addrBit].filter(Boolean).join(", ");
  return extras ? `${nameBit} [${extras}]` : nameBit;
}

/**
 * Pre-redact an object before logging. Removes (sets to null) any key that
 * looks like a PII field. Catches caller mistakes where someone forgets
 * to mask before logging.
 *
 * shared/logging.js::sanitize() does similar via regex on key names, but
 * we add LicenseIntake-specific keys it doesn't know about:
 * licenseNumber, dlNumber, dob, dateOfBirth, address1, addressStreet,
 * addressCity, addressPostal, expirationDate, middleName.
 *
 * Pass-through for non-objects and strings.
 *
 * @template T
 * @param {T} obj
 * @returns {T}
 */
export function redactForLog(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return /** @type {any} */ (obj.map(redactForLog));
  const out = /** @type {any} */ ({});
  for (const [k, v] of Object.entries(obj)) {
    if (LICENSE_PII_KEYS.has(k.toLowerCase())) {
      out[k] = v ? "[REDACTED]" : v;
    } else if (v && typeof v === "object") {
      out[k] = redactForLog(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

const LICENSE_PII_KEYS = new Set([
  "licensenumber", "dlnumber", "dl",
  "dob", "dateofbirth", "birthdate",
  "firstname", "lastname", "middlename", "fullname",
  "address1", "address2", "addressstreet", "addressstreet2",
  "addresscity", "addressstate", "addresspostal",
  "city", "state", "postal", "postalcode", "zip",
  "expirationdate", "expiration", "expires", "issued",
  "sex", "height", "weight", "eyecolor", "haircolor",
  "rawpayload", "raw",
]);

/**
 * Regex of additional forbidden keys to pass to
 * `host.logging.extendForbiddenKeys()` during register(). The shell's
 * built-in sanitize() then auto-redacts these in any structured-log
 * payload that flows through host.logging.emit().
 */
export const LOG_FORBIDDEN_KEYS_RE =
  /licensenumber|dlnumber|dateofbirth|^dob$|middlename|address\d|addressstreet|addresscity|addresspostal|expirationdate|rawpayload|^raw$|^sex$|^height$|^weight$|eyecolor|haircolor/i;
