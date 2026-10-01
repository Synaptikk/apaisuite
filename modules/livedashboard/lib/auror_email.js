// modules/livedashboard/lib/auror_email.js
//
// The Auror exceptions drill answers "which events are short". This builds the
// emailable version, which has to answer "why" -- the recipient is being asked
// to go add the missing clips, so each event carries the angle account from
// explainVideoGap instead of a bare n/3, and the policy is restated up top.
// Pure: takes the stored auror cache, returns { subject, body }.

import { withWeekday } from "../../../shared/dates.js";
import { explainVideoGap } from "./sources/auror.js";

// ── Auror exceptions, as an email ─────────────────────────────────
//
// The drill answers "which events are short"; the email has to answer "why",
// because the person reading it is being asked to go fix the clips. So each
// event gets the angle account from explainVideoGap rather than the bare
// n/3 count, and the policy is restated at the top so the ask is unambiguous.
export function aurorExceptionsEmail(c) {
  if (!c?.records?.length) return { subject: "", body: "" };
  const flagged = (c.records || [])
    .filter((r) => r.missing.length > 0)
    .sort((a, b) => (b.occurredAt || "").localeCompare(a.occurredAt || ""));
  const store = c.storeNbr || "?";
  const subject = `Auror evidence exceptions — Store ${store} — ${flagged.length} of ${c.records.length} events (last ${c.days ?? "?"} days)`;

  const L = [];
  L.push(subject);
  L.push("");
  L.push(`${flagged.length} of ${c.records.length} events in the last ${c.days ?? "?"} days are missing required evidence.`);
  L.push("");
  L.push("Every event needs, at minimum:");
  L.push("  - 1 evidence photo");
  L.push("  - a statement");
  L.push("  - 3 video clips: the theft, the subject exiting the building, and the office");
  L.push("");
  const roll = c?.counts;
  if (roll) L.push(`Short on: photo ${roll.missingPhoto ?? 0} · statement ${roll.missingStatement ?? 0} · video ${roll.missingVideo ?? 0}`);
  L.push("");
  for (const r of flagged) {
    const date = withWeekday((r.occurredAt || "").slice(0, 10));
    const val = r.totalValue != null ? ` · $${Number(r.totalValue).toFixed(2)}` : "";
    L.push("");
    L.push(`${date} · ${r.title || "e" + r.eventId}${val}`);
    if (r.people) L.push(`  Person: ${r.people}`);
    const want = [];
    if (r.missing.includes("photo")) want.push("an evidence photo");
    if (r.missing.includes("statement")) want.push("a statement");
    if (r.missing.includes("video")) want.push("video clips");
    L.push(`  Needs: ${want.join(", ")}`);
    if (r.missing.includes("video")) L.push(`  Video: ${explainVideoGap(r).text}`);
    L.push(`  https://app.us.auror.co/event/${r.eventId}`);
  }
  L.push("");
  L.push("");
  L.push("Where an angle could not be named, the clip file names in Auror do not");
  L.push("identify the camera, so the event needs a look to say which of the three");
  L.push("is actually absent. Naming clips (theft / door / office) on upload makes");
  L.push("this report exact.");
  return { subject, body: L.join("\n") };
}
