// modules/market120/lib/parse_dax.js
//
// Decode Power BI DSR (DataSet Response) format into { measureName: value }.
//
// The critical insight (learned from CDP probing 2026-07-26): DSR schema
// columns (`S[i].N`) carry OPAQUE codes like "M0", "M1", "G0". The human
// names ("Min(ISA.Adj Date)", "CountNonNull(ISA.Adj Qty)") live one level
// up in `result.descriptor.Select[i].Name`. We must join the two by the
// descriptor's `Value` field which matches the DSR column code.
//
// Example descriptor + DSR pair from an ISA Detail query:
//
//   descriptor.Select = [
//     { Kind: 2, Value: "M0", Format: "D",   Name: "Min(ISA.Adj Date)" },
//     { Kind: 2, Value: "M1", Format: "D",   Name: "Max(ISA.Adj Date)" },
//   ]
//   dsr.DS[0].PH[0].DM0 = [
//     { S: [ { N: "M0", T: 4 } ], M0: -80018 }
//   ]
//
// To pull "Min(ISA.Adj Date)", we look up descriptor Value="M0" → Name,
// then read DSR row property "M0" (or column S[i]="M0" mapped to C[i]).

/**
 * @param {string|null} respBody
 * @param {string[]}    measures  Names to look for in descriptor.Select[*].Name
 * @returns {{ ok: boolean, values: Record<string, number|null>, reason?: string }}
 */
export function decodeDaxKpis(respBody, measures) {
  const out = {};
  for (const m of measures) out[m] = null;

  // Diagnostic: every (descriptorName -> numericValue) pair we decode,
  // matched or not. When a measure comes back null (e.g. Total Adjusted $),
  // this list is the fastest way to discover the REAL descriptor name to add
  // to the alias list — no re-running CDP probes required.
  const seen = {};

  if (!respBody || typeof respBody !== "string") {
    return { ok: false, values: out, seen, reason: "empty response body" };
  }
  let resp;
  try { resp = JSON.parse(respBody); }
  catch (e) { return { ok: false, values: out, seen, reason: "JSON parse failed: " + e.message }; }

  const results = resp?.results;
  if (!Array.isArray(results) || !results.length) {
    return { ok: false, values: out, seen, reason: "no results array" };
  }

  // seenRank[name] = row-count of the DSR block that produced seen[name].
  // Lower is better: a KPI card is a single-row aggregate (rank 1), whereas a
  // detail grid repeats the same measure across many rows. When a report
  // batches BOTH into one response (observed for ISA Detail's "ISA.Adj $":
  // grid first-row = -71, card aggregate = -656048), we must keep the card's
  // aggregate, not the grid's first row. So a smaller block overrides.
  const seenRank = {};

  let anyFound = false;
  for (const result of results) {
    const data = result?.result?.data;
    if (!data) continue;

    // Build code→name map from descriptor.Select
    const descriptor = data.descriptor;
    const select = descriptor?.Select || [];
    const codeToName = {};
    for (const s of select) {
      if (s?.Value) codeToName[s.Value] = s.Name || s.Value;
    }

    // Walk DSR and pull every M*/G* column value we can find.
    const dsList = data.dsr?.DS || [];
    for (const ds of dsList) {
      const ph = ds.PH || [];
      for (const phEntry of ph) {
        const dmKeys = Object.keys(phEntry).filter((k) => /^DM\d+$/.test(k));
        for (const dmKey of dmKeys) {
          const rows = phEntry[dmKey] || [];
          const rank = rows.length || 1;   // block size: 1 = aggregate card
          const record = (name, val) => {
            // Keep the value from the smallest block seen so far (card > grid).
            if (!(name in seen) || rank < seenRank[name]) {
              seen[name] = val;
              seenRank[name] = rank;
            }
          };
          for (const row of rows) {
            // Shape A: named properties on the row object (M0, M1, G0, ...)
            for (const [k, v] of Object.entries(row)) {
              if (!/^[MG]\d+$/.test(k)) continue;
              const name = codeToName[k];
              if (!name) continue;
              const val = typeof v === "string" ? Number(v) : v;
              if (!Number.isFinite(val)) continue;
              record(name, val);
            }

            // Shape B: schema-driven — S[] + C[] value array
            const schema = row?.S;
            const c = row?.C;
            if (Array.isArray(schema) && Array.isArray(c)) {
              for (let i = 0; i < Math.min(schema.length, c.length); i++) {
                const code = schema[i]?.N;
                if (!code) continue;
                const name = codeToName[code];
                if (!name) continue;
                const raw = c[i];
                const val = typeof raw === "string" ? Number(raw) : raw;
                if (!Number.isFinite(val)) continue;
                record(name, val);
              }
            }
          }
        }
      }
    }
  }

  // ── Assignment: EXACT match only (punctuation-preserving) ──────────────
  // WHY exact-only: some reports expose near-identical descriptor names that
  // collapse to the same normalized token — e.g. ISA Detail returns BOTH the
  // real "ISA.Adj $" (Total Adjusted $, ≈-656048) and a decoy "ISA.Adj $..."
  // (≈-2837). Any normalization aggressive enough to absorb punctuation drift
  // also fuses these two, so fuzzy matching WILL grab the wrong value. We
  // instead match on a punctuation-preserving key against a rich alias list
  // (see isa_powerbi.js `measures`). If Power BI renames a measure, it shows
  // up in `seen` (surfaced via the debug panel) so the alias can be added.
  // (Verified via dev/probe-isa-powerbi.mjs, 2026-07-28.)
  const seenEntries = Object.entries(seen);
  for (const m of measures) {
    if (out[m] !== null) continue;
    const me = exactKey(m);
    for (const [name, val] of seenEntries) {
      if (exactKey(name) === me) { out[m] = val; anyFound = true; break; }
    }
  }

  if (!anyFound) {
    return { ok: false, values: out, seen, reason: "no matching measures found in response" };
  }
  return { ok: true, values: out, seen };
}

// Punctuation-preserving normalized key: lowercase + collapse whitespace only.
// Deliberately keeps punctuation so "ISA.Adj $" stays distinct from the decoy
// "ISA.Adj $..." (a full strip would fuse them and pick the wrong value).
function exactKey(s) {
  return String(s).toLowerCase().replace(/\s+/g, " ").trim();
}
