// modules/accidents/lib/summary.js
//
// Deterministic "what happened" summary composed from the Clearsight claim
// digest + statements. No AI involved — this is a re-arrangement of the
// claim's own words so the analyst can read one paragraph per claim.

export function composeSummary(digest, stmts = []) {
  if (!digest) return "";
  const bits = [];

  const who = titleCase(digest.claimant) || "The claimant";
  const kind = [digest.cause, digest.causeDetail && digest.causeDetail !== digest.cause ? `(${cleanDetail(digest.causeDetail)})` : ""]
    .filter(Boolean).join(" ");
  const where = [digest.spot, digest.area].filter(Boolean).join(", ");
  const when = [digest.lossDate, digest.lossTime].filter(Boolean).join(" at ");

  let lead = who;
  if (kind) lead += ` — ${kind}`;
  if (where) lead += ` — ${where}`;
  if (when) lead += ` — ${when}`;
  bits.push(lead + ".");

  if (digest.description) bits.push(digest.description.trim());

  const injury = [digest.injury && cleanDetail(digest.injury), digest.bodyPart && `to the ${digest.bodyPart.toLowerCase()}`]
    .filter(Boolean).join(" ");
  if (injury) bits.push(`Reported injury: ${injury}.`);

  for (const s of stmts) {
    if (!s.text) continue;
    const name = [s.first, s.last].filter(Boolean).join(" ");
    const label = s.type === "WIT" ? "Witness statement" : "Customer statement";
    bits.push(`${label}${name ? ` (${titleCase(name)})` : ""}: ${s.text.trim()}`);
  }
  return bits.join("\n\n");
}

// "Fall/Slip/Trip-Misc (31)" → "Fall/Slip/Trip-Misc"
function cleanDetail(s) { return String(s || "").replace(/\s*\(\d+\)\s*$/, ""); }

function titleCase(s) {
  return String(s || "").toLowerCase().replace(/(^|[\s,.-])([a-z])/g, (m, a, b) => a + b.toUpperCase()).trim();
}
