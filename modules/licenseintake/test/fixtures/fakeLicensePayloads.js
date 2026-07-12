// modules/licenseintake/test/fixtures/fakeLicensePayloads.js
//
// SYNTHETIC AAMVA PDF417 payloads for unit / integration tests.
//
// EVERY value here is invented. Names, DOBs, addresses, and DL numbers
// are all fabricated. Do NOT add real license data to this file under
// any circumstance — see ../docs/LICENSE_INTAKE_PII_HANDLING.md.
//
// Names borrowed from US public-figure aliases that are deliberately
// implausible (no real person matches the full combo). Addresses use
// non-existent street numbers in real cities to avoid collisions.

// ---------------------------------------------------------------------
// Synthesizers — build well-formed AAMVA payloads programmatically so
// it's obvious from the call site what fake values were used.
// ---------------------------------------------------------------------

/**
 * @param {Object} f
 * @param {string} f.last
 * @param {string} f.first
 * @param {string=} f.middle
 * @param {string=} f.dl              license number
 * @param {string=} f.dob             MMDDYYYY
 * @param {string=} f.expiration      MMDDYYYY
 * @param {string=} f.issue           MMDDYYYY
 * @param {string=} f.sex             "1" | "2" | "9"
 * @param {string=} f.address1
 * @param {string=} f.address2
 * @param {string=} f.city
 * @param {string=} f.state           USPS code
 * @param {string=} f.postal
 * @param {string=} f.country         "USA"
 * @param {string=} f.eyeColor        "BRO" | "BLU" | "GRN" | ...
 * @param {string=} f.height          "069 in"
 */
export function buildFakePayload(f) {
  const lines = [];
  lines.push("@");
  lines.push("\x1eANSI 636026100002DL00410260ZN03010120");
  if (f.dl)         lines.push("DAQ" + f.dl);
  if (f.last)       lines.push("DCS" + f.last.toUpperCase());
  if (f.first)      lines.push("DAC" + f.first.toUpperCase());
  if (f.middle)     lines.push("DAD" + f.middle.toUpperCase());
  if (f.dob)        lines.push("DBB" + f.dob);
  if (f.expiration) lines.push("DBA" + f.expiration);
  if (f.issue)      lines.push("DBD" + f.issue);
  if (f.sex)        lines.push("DBC" + f.sex);
  if (f.address1)   lines.push("DAG" + f.address1.toUpperCase());
  if (f.address2)   lines.push("DAH" + f.address2.toUpperCase());
  if (f.city)       lines.push("DAI" + f.city.toUpperCase());
  if (f.state)      lines.push("DAJ" + f.state.toUpperCase());
  if (f.postal)     lines.push("DAK" + f.postal);
  if (f.country)    lines.push("DCG" + f.country.toUpperCase());
  if (f.eyeColor)   lines.push("DAY" + f.eyeColor.toUpperCase());
  if (f.height)     lines.push("DAU" + f.height);
  return lines.join("\n");
}

// ---------------------------------------------------------------------
// Canonical fakes (every value fabricated)
// ---------------------------------------------------------------------

/**
 * Happy path — all common fields populated. Use as the baseline for
 * parser tests and UI screenshots.
 */
export const FAKE_FULL = buildFakePayload({
  last: "QUILLEN",
  first: "ATTICUS",
  middle: "BARNABY",
  dl: "GA999000001",
  dob: "03151985",
  expiration: "03152030",
  issue: "03152020",
  sex: "1",
  address1: "9999 DESOTA DR",
  city: "ATLANTA",
  state: "GA",
  postal: "30303",
  country: "USA",
  eyeColor: "BRO",
  height: "071 in",
});

/**
 * Edge case: a long address that contains "DES" — the trap that broke
 * the naive regex parser before the byte-walk fix. Parser MUST extract
 * DAI correctly here.
 */
export const FAKE_ADDRESS_TRAP = buildFakePayload({
  last: "FOSSWORTH",
  first: "HARRIET",
  dl: "GA999000002",
  dob: "07041977",
  address1: "1234 DESOTA DR",
  city: "SAVANNAH",
  state: "GA",
  postal: "31401",
});

/**
 * Legacy DAA packed-name payload. No DCS/DAC; reconstructor must split
 * "LAST,FIRST,MIDDLE".
 */
export const FAKE_LEGACY_DAA = (() => {
  const lines = [
    "@",
    "\x1eANSI 636026100002DL00410260ZN03010120",
    "DAQ" + "GA999000003",
    "DAA" + "PEMBERTON,EUGENIA,MARGUERITE",
    "DBB" + "12121990",
    "DAG" + "555 NEVERSUCH AVE",
    "DAI" + "AUGUSTA",
    "DAJ" + "GA",
    "DAK" + "30901",
  ];
  return lines.join("\n");
})();

/**
 * No-LF payload (some scanners strip line feeds). All fields jammed
 * together. Tests the byte-walk's resilience.
 */
export const FAKE_NO_LF = (() => {
  return [
    "@",
    "\x1eANSI 636026100002DL00410260ZN03010120",
    "DAQ" + "GA999000004",
    "DCS" + "VANTASSEL",
    "DAC" + "INIGO",
    "DAD" + "P",
    "DBB" + "08081999",
    "DAG" + "77 MERMAID LN",
    "DAI" + "ATHENS",
    "DAJ" + "GA",
    "DAK" + "30601",
  ].join("");
})();

/**
 * Scanner prepended "X" before the @ (occasionally seen with certain
 * scanner config bits). Parser must tolerate.
 */
export const FAKE_PREFIX_NOISE = "X" + FAKE_FULL;

/**
 * Junk: not AAMVA at all. detectFormat should classify, parser should
 * return parseConfidence=0 with a warning.
 */
export const FAKE_NOT_AAMVA = "1234567890123";

/**
 * Empty.
 */
export const FAKE_EMPTY = "";

/**
 * Minimal: only last name and DOB. Tests partial confidence scoring.
 */
export const FAKE_MINIMAL = buildFakePayload({
  last: "ZWICKERSHIM",
  first: "OLIVE",
  dob: "01011980",
});

// ---------------------------------------------------------------------
// Fake Auror person candidate fixtures for match-scoring tests
// ---------------------------------------------------------------------

/**
 * Synthetic Auror search results shaped like
 * `personIdentitySearch?searchString=` returns. All names + IDs invented.
 */
export const FAKE_AUROR_CANDIDATES_FOR_QUILLEN = [
  {
    identityGroupId: "ig_fake_001",
    displayName: "Atticus B. Quillen",
    pNumber: "P9990001",
    dob: "1985-03-15",
    lastEventDate: "2026-04-10",
  },
  {
    identityGroupId: "ig_fake_002",
    displayName: "Atticus Quillen",
    pNumber: "P9990002",
    dob: "1985-03-15",
    lastEventDate: "2024-11-22",
  },
  {
    identityGroupId: "ig_fake_003",
    displayName: "A. Quillen",
    pNumber: "P9990003",
    dob: null,
    lastEventDate: null,
  },
];

export const FAKE_AUROR_CANDIDATES_EMPTY = [];

/**
 * Synthetic APPRISS lookup result rows.
 */
export const FAKE_APPRISS_HITS_FOR_QUILLEN = {
  cards:        [{ id: "card_fake_1", maskedPan: "************1234", surname: "QUILLEN" }],
  transactions: [
    { id: "txn_fake_1", date: "2026-05-30", store: "1234", amount: 49.99, surname: "QUILLEN" },
    { id: "txn_fake_2", date: "2026-05-29", store: "1234", amount: 12.40, surname: "QUILLEN" },
  ],
};
