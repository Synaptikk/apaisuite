// modules/licenseintake/lib/license_parser.js
//
// Parse the raw text emitted by a USB barcode scanner (HID keyboard
// wedge) into a normalized LicensePerson model. Handles AAMVA PDF417
// payloads from US driver's licenses.
//
// Parser approach (hard-won from the donor scanner_capture.py):
// walk the payload byte-by-byte and ONLY advance 3 chars when the
// candidate triplet is in a known-tag whitelist. A naive regex split
// (or "advance on any [DZ][A-Z]{2}") falls into address-text false
// positives — e.g. "DESOTA DR" contains "DES" which matches the
// pattern; the regex would consume it and skip past the real tag
// right after.
//
// PII: this module NEVER logs the raw payload. The returned
// `redactedPreview` is the only safe-to-log derivative.
//
// Public:
//   parseLicensePayload(rawText) → LicensePerson
//   detectFormat(rawText) → "PDF417 / AAMVA driver license" | "1D numeric" | ...

import { buildRedactedPreview } from "./redaction.js";

// AAMVA element labels (v9/2016 spec). Subset that covers all common DL
// fields plus state-specific extensions seen in the wild.
const AAMVA_LABELS = {
  DAQ: "License number",
  DCS: "Last name",
  DAC: "First name",
  DAD: "Middle name",
  DBB: "Date of birth",
  DBA: "Expiration",
  DBD: "Issue date",
  DBC: "Sex",
  DAU: "Height",
  DAW: "Weight",
  DAY: "Eye color",
  DAZ: "Hair color",
  DAG: "Street",
  DAH: "Street 2",
  DAI: "City",
  DAJ: "State",
  DAK: "Postal",
  DCA: "Vehicle class",
  DCB: "Restrictions",
  DCD: "Endorsements",
  DCF: "Document discriminator",
  DCG: "Country",
  DCK: "Inventory control",
  DDA: "REAL ID compliance",
  DDB: "Card revision",
  DDK: "Organ donor",
  DDL: "Veteran",
  DDE: "Last-name truncation",
  DDF: "First-name truncation",
  DDG: "Middle-name truncation",
};

// Known tags whitelist for the byte-walk parser.
const KNOWN_TAGS = new Set([
  ...Object.keys(AAMVA_LABELS),
  "DAA", "DAB", "DAE", "DAF", "DBN", "DCT", "DCU",
  // State-specific Z-subfile extensions observed in the wild
  "ZGA", "ZGB", "ZGC", "ZGD", "ZGE", "ZGF", "ZGG",
  "ZGH", "ZGI", "ZGJ", "ZGK", "ZGL", "ZGM", "ZGN",
]);

const SEX_LABEL = { "1": "M", "2": "F", "9": "X" };

/**
 * @typedef {Object} LicensePerson
 * @property {string|null} firstName
 * @property {string|null} lastName
 * @property {string|null} middleName
 * @property {string|null} fullName
 * @property {string|null} dob                ISO YYYY-MM-DD or null
 * @property {string|null} licenseNumber
 * @property {string|null} address1           street
 * @property {string|null} address2           street 2 (apt, suite)
 * @property {string|null} city
 * @property {string|null} state
 * @property {string|null} postalCode
 * @property {string|null} expirationDate     ISO YYYY-MM-DD or null
 * @property {string|null} issueDate          ISO YYYY-MM-DD or null
 * @property {string|null} sex                "M" | "F" | "X" | raw | null
 * @property {string|null} issuingState       USPS state code (from DAJ or country/state context)
 * @property {number}      parseConfidence    0..1
 * @property {string[]}    parseWarnings      human-readable strings; safe to log
 * @property {"barcode_scanner"|"manual_entry"|"camera_pdf417"} source
 * @property {string}      redactedPreview    safe-to-log one-liner
 */

/**
 * Parse a raw scanner payload into a normalized LicensePerson.
 *
 * @param {string} rawText
 * @returns {LicensePerson}
 */
export function parseLicensePayload(rawText) {
  const warnings = [];
  if (typeof rawText !== "string" || rawText.length === 0) {
    warnings.push("empty input");
    return emptyPerson(0, warnings);
  }

  // Tolerate scanner-prepended noise before the AAMVA magic '@'.
  const at = rawText.indexOf("@");
  let body = at > 0 ? rawText.slice(at) : rawText;
  if (at > 0) warnings.push(`stripped ${at} prefix char(s)`);

  // Strip line/record separators — the whitelist walk doesn't need them.
  body = body.replace(/[\r\n\x1c\x1d\x1e\x1f]+/g, "");

  // Hard sanity: the AAMVA header should contain "ANSI " near the start.
  // Without it, this isn't a driver's license barcode.
  const headHasAnsi = body.slice(0, 30).includes("ANSI ");
  if (!headHasAnsi) {
    warnings.push("header missing 'ANSI ' marker — not a driver's license barcode");
    return emptyPerson(0, warnings);
  }

  // Walk byte-by-byte, advancing 3 chars only on a known tag.
  /** @type {Array<[number, string]>} */
  const positions = [];
  for (let i = 0; i <= body.length - 3; ) {
    const cand = body.substr(i, 3);
    if (KNOWN_TAGS.has(cand)) {
      positions.push([i, cand]);
      i += 3;
    } else {
      i += 1;
    }
  }

  if (positions.length === 0) {
    warnings.push("no AAMVA field tags found");
    return emptyPerson(0, warnings);
  }

  /** @type {Record<string, string>} */
  const fields = {};
  for (let k = 0; k < positions.length; k++) {
    const [start, tag] = positions[k];
    const valStart = start + 3;
    const valEnd = k + 1 < positions.length ? positions[k + 1][0] : body.length;
    const value = body.slice(valStart, valEnd).trim();
    if (fields[tag] === undefined && value !== "") {
      fields[tag] = value;
    }
  }

  const get = (code) => (fields[code] !== undefined ? fields[code] : null);

  // Legacy DAA = "LAST,FIRST,MIDDLE" packed name fallback.
  let firstName = get("DAC") || get("DCT");
  let lastName = get("DCS") || get("DAB");
  let middleName = get("DAD");
  const daa = get("DAA");
  if (!lastName && daa) {
    const parts = daa.split(/[,\s]+/).filter(Boolean);
    if (parts.length >= 1) lastName = parts[0];
    if (parts.length >= 2) firstName = firstName || parts[1];
    if (parts.length >= 3) middleName = middleName || parts[2];
    warnings.push("name reconstructed from legacy DAA field");
  }
  if (firstName) firstName = titleCase(firstName);
  if (lastName) lastName = titleCase(lastName);
  if (middleName) middleName = titleCase(middleName);
  const fullName = [firstName, middleName, lastName].filter(Boolean).join(" ") || null;

  const dob = parseAamvaDate(get("DBB"));
  const expirationDate = parseAamvaDate(get("DBA"));
  const issueDate = parseAamvaDate(get("DBD"));
  if (get("DBB") && !dob) warnings.push("DOB field did not parse as date");
  if (get("DBA") && !expirationDate) warnings.push("expiration field did not parse as date");

  const licenseNumber = get("DAQ");
  const address1 = get("DAG");
  const address2 = get("DAH");
  const city = get("DAI");
  const state = get("DAJ");
  const postalCode = get("DAK");
  const sex = SEX_LABEL[get("DBC")] || get("DBC") || null;
  const issuingState = state || null;
  // Height/weight: AAMVA stores these in DAU/DAW with varied formatting
  // across states ("069 in", "5'09\"", "175 cm", "180", "180 lb", "082 kg").
  // We normalize to total inches / pounds so downstream code (the Auror
  // build/height bucket mapper) doesn't have to re-parse.
  const heightInches = parseHeightToInches(get("DAU"));
  const weightPounds = parseWeightToPounds(get("DAW"));

  // Confidence heuristic: 1.0 if we have name + DOB + DL#; 0.7 if 2 of 3;
  // 0.4 if only one; 0 if we got nothing structural.
  const haveName = !!(firstName && lastName);
  const haveDob = !!dob;
  const haveDl = !!licenseNumber;
  const score = (haveName ? 1 : 0) + (haveDob ? 1 : 0) + (haveDl ? 1 : 0);
  let parseConfidence;
  if (score === 3) parseConfidence = 1.0;
  else if (score === 2) parseConfidence = 0.7;
  else if (score === 1) parseConfidence = 0.4;
  else parseConfidence = 0;

  const person = {
    firstName,
    lastName,
    middleName,
    fullName,
    dob,
    licenseNumber,
    address1,
    address2,
    city,
    state,
    postalCode,
    expirationDate,
    issueDate,
    sex,
    heightInches,
    weightPounds,
    issuingState,
    parseConfidence,
    parseWarnings: warnings,
    source: /** @type {const} */ ("barcode_scanner"),
    redactedPreview: "",
  };
  person.redactedPreview = buildRedactedPreview(person);
  return person;
}

/**
 * Lightweight format probe for UI hints. Mirrors scanner_capture.py.
 * @param {string} rawText
 */
export function detectFormat(rawText) {
  if (!rawText) return "Empty";
  const p = String(rawText).trimStart();
  const at = p.indexOf("@");
  if (at >= 0 && p.slice(at, at + 30).includes("ANSI ")) {
    return "PDF417 / AAMVA driver license";
  }
  if (/^\d{8,18}$/.test(p.trim())) {
    return `1D numeric (likely Code 128/UPC/EAN) — ${p.trim().length} digits`;
  }
  if (/^[A-Z0-9\-]{1,30}$/.test(p.trim())) {
    return "1D alphanumeric (Code 39 / Code 128)";
  }
  return "Unknown / partial";
}

/**
 * AAMVA US driver's license dates are MMDDYYYY. Non-US implementations
 * sometimes use CCYYMMDD; we try MMDDYYYY first.
 * @param {string|null} s
 * @returns {string|null}
 */
function parseAamvaDate(s) {
  if (!s) return null;
  if (!/^\d{8}$/.test(s)) return null;
  const mm = +s.slice(0, 2);
  const dd = +s.slice(2, 4);
  const yyyy = +s.slice(4, 8);
  if (yyyy >= 1900 && yyyy <= 2100 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
    return `${pad4(yyyy)}-${pad2(mm)}-${pad2(dd)}`;
  }
  const ccYY = +s.slice(0, 4);
  const mm2 = +s.slice(4, 6);
  const dd2 = +s.slice(6, 8);
  if (ccYY >= 1900 && ccYY <= 2100 && mm2 >= 1 && mm2 <= 12 && dd2 >= 1 && dd2 <= 31) {
    return `${pad4(ccYY)}-${pad2(mm2)}-${pad2(dd2)}`;
  }
  return null;
}

function titleCase(s) {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((p) => (p ? p.charAt(0).toUpperCase() + p.slice(1) : p))
    .join(" ");
}

function pad2(n) { return String(n).padStart(2, "0"); }
function pad4(n) { return String(n).padStart(4, "0"); }

/**
 * Normalize an AAMVA DAU height string to total inches.
 * Handles "069", "069 in", "069 IN", "5'09\"", "5'9\"", "175 cm".
 * Returns null when no usable value is parsed.
 */
function parseHeightToInches(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Feet-inches: "5'09\"" or "5'9"
  const fi = s.match(/^(\d)\D+(\d{1,2})/);
  if (fi && /['′]/.test(s)) {
    return Number(fi[1]) * 12 + Number(fi[2]);
  }
  // cm: "175 cm"
  const cm = s.match(/^(\d{2,3})\s*cm/i);
  if (cm) return Math.round(Number(cm[1]) / 2.54);
  // Plain inches: "069", "69", "069 in", "69 IN"
  const inches = s.match(/^(\d{2,3})/);
  if (inches) {
    const n = Number(inches[1]);
    // Sanity: human heights are between 36 and 90 inches.
    if (n >= 36 && n <= 90) return n;
  }
  return null;
}

/**
 * Normalize an AAMVA DAW weight string to pounds.
 * Handles "180", "180 lb", "180 lbs", "082 kg".
 */
function parseWeightToPounds(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const kg = s.match(/^(\d{2,3})\s*kg/i);
  if (kg) return Math.round(Number(kg[1]) * 2.2046);
  const lbs = s.match(/^(\d{2,3})/);
  if (lbs) {
    const n = Number(lbs[1]);
    if (n >= 50 && n <= 700) return n;
  }
  return null;
}

/**
 * @param {number} confidence
 * @param {string[]} warnings
 * @returns {LicensePerson}
 */
function emptyPerson(confidence, warnings) {
  return {
    firstName: null, lastName: null, middleName: null, fullName: null,
    dob: null, licenseNumber: null,
    address1: null, address2: null, city: null, state: null, postalCode: null,
    expirationDate: null, issueDate: null,
    sex: null, heightInches: null, weightPounds: null, issuingState: null,
    parseConfidence: confidence,
    parseWarnings: warnings,
    source: "barcode_scanner",
    redactedPreview: "(no parse)",
  };
}
