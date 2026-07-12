// modules/digitallocks/lib/normalize.js
//
// Lightweight string normalization for fuzzy matching against rule keywords.
// Kept separate from parseLockEvents so the rules engine (riskScoring.js)
// can canonicalize on its own without re-running CSV/XLSX parsing.
//
// Intentionally small — V1 only needs lowercase + collapse-whitespace +
// strip punctuation. A real normalization table (mapping "ENT ASSOC" →
// "Entertainment TA", etc.) belongs in a future per-store config file.

/** Lowercase, trim, collapse whitespace, strip surrounding punctuation. */
export function canon(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[–—]/g, "-")     // en/em dashes → hyphen
    .replace(/\s+/g, " ")
    .trim();
}

/** True if `haystack` contains any of the (already-lowercased) keywords. */
export function containsAny(haystack, keywords) {
  const h = canon(haystack);
  for (const k of keywords) {
    if (!k) continue;
    if (h.includes(canon(k))) return true;
  }
  return false;
}
