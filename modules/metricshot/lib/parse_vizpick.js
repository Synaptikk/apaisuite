// modules/metricshot/lib/parse_vizpick.js
//
// Parse Tableau VizQL bootstrap-session response for VizPick's
// "VizPick Details" dashboard to extract:
//   1. Location Details table  → per-location rows including Location Age
//   2. Department Breakout     → per-dept rows including Pick %
//
// Tableau's bootstrap-session payload is a length-prefixed multipart of JSON
// chunks. The relevant chunk contains per-worksheet "presModel" blocks with:
//   - vizData.paneColumnsData.paneColumnsList[i].vizPaneColumns[j].tuples[]
//   - dataDictionary.dataSegments['<id>'].dataColumns['<measure>'].dataValues[]
//
// Rather than decode the full internal format (version-fragile), we take a
// pragmatic approach: extract the two `dataValues` string arrays that carry
// (a) formatted numbers and (b) their labels, then zip them into rows by
// matching known column-name signatures.
//
// The parser is intentionally permissive: it stops at the first plausible
// interpretation and returns what it found. Missing worksheets → empty array
// for that worksheet, not an error. Callers decide what to do with partial data.

/**
 * @param {string|null} respBody   Raw response body (may include Tableau's
 *                                 chunk-length envelope).
 * @returns {{
 *   ok: boolean,
 *   locationDetails: Array<{ location: string, hoursSinceLastScan: number|null,
 *                            casesSeenPct: number|null, pickedTotal: number|null,
 *                            status: string|null }>,
 *   departmentBreakout: Array<{ dept: string, pickPct: number|null,
 *                               totalPicked: number|null, casesSeen: number|null,
 *                               casesExpected: number|null }>,
 *   reason?: string,
 * }}
 */
export function parseVizPickResponse(respBody) {
  const empty = { ok: false, locationDetails: [], departmentBreakout: [] };
  if (!respBody || typeof respBody !== "string") {
    return { ...empty, reason: "empty response body" };
  }

  const chunks = _stripEnvelope(respBody);
  if (!chunks.length) return { ...empty, reason: "no JSON chunks found" };

  // The Location Details worksheet lives in the presModel of the pane whose
  // fieldCaptions include "Location" + "Location Age" (or similar). Instead
  // of decoding the whole presModel we scan the joined text and extract the
  // dataSegments' string arrays. Tableau's payload always contains the
  // formatted values in dataDictionary.dataSegments[<n>].dataColumns —
  // arrays of {dataType, dataValues}.

  const haystack = chunks.join("\n");

  // Extract every "dataValues": [ ... ] array along with its dataType and
  // rough context (nearest column caption above it, if any).
  const arrays = _extractDataValuesArrays(haystack);

  // Location details: find columns for Location + Location Age.
  const locationDetails = _zipLocationDetails(arrays);

  // Department breakout: find columns for Dept + Pick % + Total Picked.
  const departmentBreakout = _zipDepartmentBreakout(arrays);

  const ok = locationDetails.length > 0 || departmentBreakout.length > 0;
  return {
    ok,
    locationDetails,
    departmentBreakout,
    reason: ok ? undefined : "no recognizable table columns found",
  };
}

// ── Envelope stripping ────────────────────────────────────────────────────

function _stripEnvelope(body) {
  // Tableau's bootstrap-session uses `<byteLength>;<json>` chunk framing.
  const chunks = [];
  const re = /(?:^|\n)(\d+);/g;
  const found = [];
  let m;
  while ((m = re.exec(body)) != null) {
    found.push({ len: Number(m[1]), start: m.index + m[0].length });
  }
  if (!found.length) {
    // Not envelope-framed — treat whole body as one chunk.
    return [body];
  }
  for (const f of found) chunks.push(body.slice(f.start, f.start + f.len));
  return chunks;
}

// ── dataValues extraction ─────────────────────────────────────────────────

/**
 * Scan the haystack for `"dataValues":[...]` arrays. For each hit, capture:
 *   - the array's parsed JS value (parsed lazily on demand — we keep the raw
 *     slice for now to avoid parse cost on non-matching hits)
 *   - the surrounding string context (300 chars before) so callers can
 *     identify what the array represents
 */
function _extractDataValuesArrays(haystack) {
  const out = [];
  const marker = `"dataValues"`;
  let cursor = 0;
  while (true) {
    const idx = haystack.indexOf(marker, cursor);
    if (idx < 0) break;
    // Find opening `[` after the marker.
    let i = idx + marker.length;
    while (i < haystack.length && haystack[i] !== "[" && haystack[i] !== "]") i++;
    if (haystack[i] !== "[") { cursor = i + 1; continue; }
    // Find balanced closing `]`. Naive because values can contain `[`/`]`
    // inside strings — track string state.
    const end = _findBalancedEnd(haystack, i);
    if (end < 0) { cursor = i + 1; continue; }
    const arrText = haystack.slice(i, end + 1);
    let arr = null;
    try { arr = JSON.parse(arrText); } catch { /* skip */ }
    if (Array.isArray(arr)) {
      const context = haystack.slice(Math.max(0, idx - 400), idx);
      out.push({ arr, context, at: idx });
    }
    cursor = end + 1;
  }
  return out;
}

function _findBalancedEnd(s, openIdx) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ── Column identification via context ────────────────────────────────────

// A dataValues array is preceded by its `dataType` field and often by the
// column's caption (in `fieldCaption`/`aliasedFieldCaption` above). The
// context slice we captured contains that neighborhood — good enough for
// signature matching.

function _typeOf(entry) {
  const m = /"dataType"\s*:\s*"([^"]+)"/.exec(entry.context);
  return m ? m[1] : null;
}
function _looksLike(entry, ...needles) {
  const s = entry.context.toLowerCase();
  return needles.every((n) => s.includes(n.toLowerCase()));
}

// ── Location Details zipping ─────────────────────────────────────────────

function _zipLocationDetails(arrays) {
  // Signatures: an array of strings whose values look like "###/###" (bin
  // locations e.g. "003/006") + a numeric array of "Location Age" hours.
  const locations = arrays.find((a) =>
    Array.isArray(a.arr) &&
    a.arr.length > 5 &&
    a.arr.filter((v) => typeof v === "string" && /^\d{2,4}\/\d{2,4}$/.test(v.trim())).length / a.arr.length > 0.5
  );
  if (!locations) return [];

  // Location Age: nearest integer array of the same length (or half-length
  // if Tableau split visible vs invisible rows).
  const ageCandidates = arrays.filter((a) =>
    a.arr !== locations.arr &&
    Array.isArray(a.arr) &&
    a.arr.every((v) => typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)))
  );
  // Prefer one whose context contains "Age" / "age".
  const age = ageCandidates.find((a) => /age/i.test(a.context) && Math.abs(a.arr.length - locations.arr.length) <= 2)
           || ageCandidates.find((a) => a.arr.length === locations.arr.length);

  // Cases Seen % + Pallets + Total Picked: optional, best-effort.
  const casesSeenPct = arrays.find((a) => /Cases Seen ?%/i.test(a.context) && a.arr.length === locations.arr.length);
  const totalPicked  = arrays.find((a) => /Total Picked/i.test(a.context) && a.arr.length === locations.arr.length);
  const status       = arrays.find((a) => /Location Status/i.test(a.context) && a.arr.length === locations.arr.length);

  const rows = [];
  for (let i = 0; i < locations.arr.length; i++) {
    const loc = String(locations.arr[i] ?? "").trim();
    if (!loc) continue;
    rows.push({
      location: loc,
      hoursSinceLastScan: age ? _toNumber(age.arr[i]) : null,
      casesSeenPct: casesSeenPct ? _toNumber(casesSeenPct.arr[i]) : null,
      pickedTotal:  totalPicked ? _toNumber(totalPicked.arr[i]) : null,
      status:       status ? String(status.arr[i] ?? "").trim() : null,
    });
  }
  return rows;
}

// ── Department Breakout zipping ──────────────────────────────────────────

function _zipDepartmentBreakout(arrays) {
  // Department numbers — 1..~120 integers, arranged small array (~30 rows).
  // Look for an array where 70%+ of values are small non-negative integers or
  // the token "Total".
  const deptCand = arrays.find((a) =>
    Array.isArray(a.arr) &&
    a.arr.length >= 3 && a.arr.length <= 200 &&
    a.arr.filter((v) =>
      (typeof v === "number" && v >= 0 && v <= 999) ||
      (typeof v === "string" && (v === "Total" || /^\d{1,3}$/.test(v.trim())))
    ).length / a.arr.length > 0.7 &&
    /dept/i.test(a.context)
  );
  if (!deptCand) return [];

  const sameLen = (a) => a.arr.length === deptCand.arr.length;

  const pickPct = arrays.find((a) => sameLen(a) && /Pick ?%/i.test(a.context));
  const totalPicked = arrays.find((a) => sameLen(a) && /Total Picked/i.test(a.context));
  const casesSeen = arrays.find((a) => sameLen(a) && /Cases Seen(?! %)/i.test(a.context));
  const casesExpected = arrays.find((a) => sameLen(a) && /Cases Expected/i.test(a.context));

  const rows = [];
  for (let i = 0; i < deptCand.arr.length; i++) {
    const rawDept = deptCand.arr[i];
    const dept = String(rawDept ?? "").trim();
    if (!dept) continue;
    rows.push({
      dept,
      pickPct:       pickPct ? _toNumber(pickPct.arr[i]) : null,
      totalPicked:   totalPicked ? _toNumber(totalPicked.arr[i]) : null,
      casesSeen:     casesSeen ? _toNumber(casesSeen.arr[i]) : null,
      casesExpected: casesExpected ? _toNumber(casesExpected.arr[i]) : null,
    });
  }
  return rows;
}

function _toNumber(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  const s = String(v).trim().replace(/,/g, "").replace(/%$/, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
