// modules/market120/lib/parse_tableau.js
//
// Extract KPI values from Tableau VizQL response bodies.
//
// Tableau VizQL responses are semi-structured: a length-prefixed multipart
// envelope wrapping several JSON chunks (bootstrapSession returns a "world"
// with layout + a "layoutRects" section containing "presModelHolder" +
// "presentationLayer" data). Full parsing is complex and version-sensitive.
//
// This parser is INTENTIONALLY permissive: it strips the outer envelope
// framing (if any), then scans the resulting JSON for known measure names
// and extracts the nearest numeric value. Works for the KPI-card visuals on
// the Clearance Deleted view where each measure appears once.
//
// Callers pass the response body plus an array of measure names. Returns
// { measureName: number|null }.

/**
 * @param {string|null} respBody
 * @param {string[]}    measures
 * @returns {{ ok: boolean, values: Record<string, number|null>, reason?: string }}
 */
export function decodeTableauKpis(respBody, measures) {
  const out = {};
  for (const m of measures) out[m] = null;

  if (!respBody || typeof respBody !== "string") {
    return { ok: false, values: out, reason: "empty response body" };
  }

  // Tableau's bootstrapSession envelope prefixes each chunk with `<length>;`.
  // Strip anything before the first `{` in every chunk and concatenate the
  // resulting JSON fragments together into a single searchable haystack.
  const cleaned = stripEnvelope(respBody);

  let anyFound = false;
  for (const measure of measures) {
    const val = findNearestNumber(cleaned, measure);
    if (val !== null) {
      out[measure] = val;
      anyFound = true;
    }
  }

  if (!anyFound) {
    return { ok: false, values: out, reason: "no requested measures found in response" };
  }
  return { ok: true, values: out };
}

// Strip Tableau's `<byteLength>;<json>` chunk framing. Preserves the JSON
// content of every chunk.
function stripEnvelope(body) {
  const chunks = [];
  const re = /(?:^|\n)?(\d+);/g;
  let lastEnd = 0;
  let m;
  const found = [];
  while ((m = re.exec(body)) != null) {
    found.push({ len: Number(m[1]), start: m.index + m[0].length });
  }
  if (!found.length) return body; // Not envelope-framed; return as-is.
  for (const f of found) chunks.push(body.slice(f.start, f.start + f.len));
  return chunks.join("\n");
}

// Given a raw searchable string and a measure label (e.g. "Deleted $"), find
// the nearest numeric value that follows the label. Tolerates encoding
// (quotes, escaped Unicode, currency symbol, thousand separators).
function findNearestNumber(haystack, label) {
  // Build a permissive substring pattern for the label — allow underscore/
  // space, allow $ / $ / literal, allow escaping.
  const escaped = label
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "[\\s_\\-]+")
    .replace(/\\\$/g, "(?:\\$|\\\\u0024|)");
  const labelRe = new RegExp(escaped, "i");
  const m = labelRe.exec(haystack);
  if (!m) return null;

  // Look ahead a SHORT window for a value token. 400 chars was far too
  // greedy — on the Clearance/Deleted view the measure name appears only in
  // schema/descriptor metadata (values are server-side PNG tiles), so a wide
  // window grabbed unrelated layout coordinates (often 0). Require the number
  // to sit in an immediate value position: only value-bearing separators
  // (quotes, colon, brackets, $, whitespace) may stand between label and
  // number. This kills the false-positive zeros; a genuine value-bearing
  // response still matches.
  const tail = haystack.slice(m.index + m[0].length, m.index + m[0].length + 40);
  const numRe = /^[\s"':\[\]{},]*\$?\s*"?\(?\s*(-?[\d,]+(?:\.\d+)?)\s*\)?"?/;
  const n = numRe.exec(tail);
  if (!n) return null;
  const cleaned = n[1].replace(/,/g, "");
  const val = Number(cleaned);
  if (!Number.isFinite(val)) return null;
  // Preserve "(x)" → -x accounting notation
  if (/\(\s*-?[\d.,]+\s*\)/.test(n[0])) return -Math.abs(val);
  return val;
}
