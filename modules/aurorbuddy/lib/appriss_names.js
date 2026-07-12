// lib/appriss_names.js — data extraction, dedup, and name-matching helpers
// ─────────────────────────────────────────────────────────────────────────────
// All functions ported VERBATIM from pipeline/appriss_scraper.py — if behaviour
// here ever diverges from the Python engine, cross-engine result parity breaks.
// Keep these in sync with the Python originals.

// ─── Cell extraction ──────────────────────────────────────────────────────
// pipeline/appriss_scraper.py::_extract_cell
// APPRISS rows are objects whose values are either plain scalars or
// { rawValue, cellValue } wrapper objects. Normalise to a trimmed string.
export function cell(row, field) {
  const c = row?.[field];
  if (c == null) return "";
  if (typeof c === "object") {
    const v = c.rawValue ?? c.cellValue ?? "";
    return String(v).trim();
  }
  return String(c).trim();
}

// ─── Deduplication ────────────────────────────────────────────────────────

// pipeline/appriss_scraper.py::_dedup_cards
// Keep the first card entry per last4 — APPRISS often returns the same card
// under multiple name capitalisations ('John Smith' + 'JOHN SMITH').
export function dedupCards(cards) {
  const seen = new Set();
  const out  = [];
  for (const card of cards) {
    const key = card.last4 || "";
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(card);
    }
  }
  return out;
}

// pipeline/appriss_scraper.py::_dedup_transactions
// Drop duplicate transaction rows by transaction_id. Safety net against
// double-firing during the SPA spy.
export function dedupTransactions(txns) {
  const seen = new Set();
  const out  = [];
  for (const t of txns) {
    const tid = t.transaction_id || "";
    if (!tid || !seen.has(tid)) {
      if (tid) seen.add(tid);
      out.push(t);
    }
  }
  return out;
}

// ─── Name matching ────────────────────────────────────────────────────────

// pipeline/appriss_scraper.py::_NAME_SUFFIXES
// Suffixes stripped from the tail before determining whether the suspect's
// last name is the actual surname token.
const NAME_SUFFIXES = new Set(["JR", "SR", "II", "III", "IV", "V"]);

// pipeline/appriss_scraper.py::_surname_is_last_token
// True iff the suspect's last name is the *actual surname* on the card —
// i.e. the last meaningful token after stripping JR/SR/II/etc.
//   'PARIS' vs 'PARIS S DAVIS' → false  (DAVIS is the surname)
//   'PARIS' vs 'HONESTI PARIS' → true
//   'SMITH' vs 'JOHN SMITH JR' → true   (JR stripped)
export function surnameIsLastToken(suspectLast, apprissName) {
  if (!suspectLast) return false;
  const tokens = (apprissName || "")
    .toUpperCase()
    .split(/\s+/)
    .filter(t => t && !NAME_SUFFIXES.has(t));
  if (!tokens.length) return false;
  return tokens[tokens.length - 1] === suspectLast.toUpperCase();
}

// pipeline/appriss_scraper.py::_first_name_candidates
// First name + every middle token — NO invented diminutives (Python doesn't
// have them and we shouldn't either; better to miss a card than invent a
// false match).
export function firstNameCandidates(suspect) {
  const first = (suspect.first_name ?? "").trim().toUpperCase();
  const last  = (suspect.last_name  ?? "").trim().toUpperCase();
  const full  = (suspect.name       ?? "").trim().toUpperCase();
  const candidates = [];
  if (first) candidates.push(first);

  // Middle tokens = everything in `full` that isn't first or last.
  if (full && first && last) {
    const parts   = full.split(/\s+/);
    const middles = parts.filter(p => p !== first && p !== last);
    candidates.push(...middles);
  }
  // dedup while preserving order
  return [...new Set(candidates)];
}

// pipeline/appriss_scraper.py::_name_matches_any
// True if ANY candidate is a whole word in apprissName.
//
// If candidates is empty → returns TRUE (no first-name info; accept all
// last-name matches). Returning false here would silently drop single-name
// Auror suspects.
//
// Stricter than the Python original to reduce false positives:
//   - multi-char candidates (2+) match as a whole word (normal path)
//   - a single-char candidate ONLY qualifies when it was the Auror FIRST
//     name (candidates[0] is 1 char) AND matches the first letter of the
//     cardholder's first token. This handles 'J Smith → JOHN SMITH' without
//     letting shared middle initials (e.g. 'A') qualify different people
//     (Auror 'Laura A Patterson' vs Secure 'MELISA A PATTERSON').
//
// candidates[0] is always the Auror first name (firstNameCandidates puts
// it there before any middle tokens).
export function nameMatchesAny(candidates, apprissName) {
  if (!candidates.length) return true;
  const words = (apprissName || "").toUpperCase().split(/\s+/).filter(Boolean);
  if (!words.length) return false;

  for (const c of candidates) {
    if (c.length >= 2 && words.includes(c)) return true;
  }
  const firstCand = candidates[0] || "";
  if (firstCand.length === 1 && words[0].startsWith(firstCand)) return true;
  return false;
}
