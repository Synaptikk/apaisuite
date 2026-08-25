// modules/digitalmetrics/lib/names.js
//
// Canonicalisation — the frozen half of the privacy layer.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ THESE RULES ARE FROZEN. Read before changing anything below.         │
// │                                                                      │
// │ A name is tokenised as HMAC(canonical(name)). The token is the join  │
// │ key for every historical record. If canonical() ever returns a       │
// │ different string for a name it previously handled, that associate's  │
// │ entire history orphans — silently. There is no migration short of    │
// │ decrypting and rewriting every document.                             │
// │                                                                      │
// │ To change behaviour: add a NEW rule version, keep the old one, and   │
// │ tokenise under both during a dual-read window.                       │
// └──────────────────────────────────────────────────────────────────────┘

export const CANON_VERSION = 1;

/**
 * Fold a raw name from any source (Tableau export, scheduler scrape, manual
 * entry) into one canonical form.
 *
 * Deliberately aggressive, because the donor app's six reconciliation scripts
 * exist precisely because these sources disagree: the metrics export emits
 * "SMITH, JOHN A", the scheduler emits "John Smith - Digital Assoc".
 */
export function canonical(raw) {
  if (raw == null) return "";
  let s = String(raw);

  // Strip a trailing job title after a SPACED dash/pipe ("John Smith - Cap 2 Assoc").
  // The surrounding whitespace is load-bearing: an unspaced hyphen is part of a
  // surname ("Smith-Jones"), and an earlier version of this rule silently
  // truncated every hyphenated name to its first element.
  s = s.replace(/\s+[-|–—]\s+.*$/u, "");

  // Unicode fold: accents, curly punctuation, non-breaking spaces.
  s = s.normalize("NFKD").replace(/[̀-ͯ]/gu, "");
  s = s.replace(/[‘’ʼ]/gu, "'").replace(/ /gu, " ");

  // "LAST, FIRST" -> "FIRST LAST".
  const comma = s.indexOf(",");
  if (comma > -1) {
    const last  = s.slice(0, comma);
    const first = s.slice(comma + 1);
    s = `${first} ${last}`;
  }

  s = s.toUpperCase();

  // Drop generational suffixes and honorifics — they appear inconsistently.
  s = s.replace(/\b(JR|SR|II|III|IV|MR|MRS|MS|DR)\b\.?/gu, " ");

  // Keep letters, digits, apostrophes and spaces. Hyphenated surnames become
  // spaced ("SMITH-JONES" -> "SMITH JONES") so both spellings converge.
  s = s.replace(/['']/gu, "").replace(/[^A-Z0-9 ]+/gu, " ");

  // NOTE: middle initials are deliberately KEPT. Dropping them would merge
  // "<FIRST> K" into "<FIRST> M" — two different people who share a first
  // name, which the donor's mapping table distinguishes by hand. The cost is that
  // "SMITH, JOHN A" and "John Smith" canonicalise differently; that pairing is
  // an alias-table job, not a canonicalisation job.

  return s.replace(/\s+/gu, " ").trim();
}

/**
 * Aliases resolve nicknames and truncations that canonical() cannot:
 * e.g. a nickname or a truncated badge name that maps to a full name.
 * (No real examples here — see the warning below.)
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ THE ALIAS TABLE IS PII AND IS NEVER COMMITTED.                       │
 * │                                                                      │
 * │ It maps a real name to a real name, so a checked-in table would put  │
 * │ the roster into git — exactly what this module exists to prevent.    │
 * │ (The donor does this today: functions/index.js hardcodes ~70 real    │
 * │ names in NAME_MAPPINGS, committed.)                                  │
 * │                                                                      │
 * │ It lives in chrome.storage.local under "digitalmetrics.aliases",     │
 * │ is entered/imported by the user, never syncs, never leaves the       │
 * │ device, and never reaches Firestore.                                 │
 * └──────────────────────────────────────────────────────────────────────┘
 */
let aliasTable = new Map();

export function loadAliases(map) {
  aliasTable = new Map(
    Object.entries(map || {}).map(([k, v]) => [canonical(k), canonical(v)])
  );
}

export function resolve(raw) {
  const c = canonical(raw);
  return aliasTable.get(c) ?? c;
}

export function aliasCount() {
  return aliasTable.size;
}
