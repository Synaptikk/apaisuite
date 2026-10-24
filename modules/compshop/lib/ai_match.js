// modules/compshop/lib/ai_match.js
//
// Claude (through Walmart's AI gateway, the Code Puppy backend) picks our
// comparable item for each competitor ad item from walmart.com's in-store
// search results — the keyword scorer in model.js::pickCandidate can't tell
// "Fresh Raspberries 12 oz" from "6 oz", or a 3 lb bag of onions from one
// onion, as well as a reader can. When nothing fits it proposes a better
// search, which service.js runs before asking once more.
//
// Only public data goes to the model: competitor ad text and walmart.com
// product names/prices. Runs in the service worker; the token is the one the
// Cx module signs in with (via digitalschedule/lib/gateway.js).

import { chatTurn, gatewayStatus } from "../../digitalschedule/lib/gateway.js";

export { gatewayStatus };

const MODEL = "claude-sonnet-5";
// Bump when the prompt changes: cached picks made under an older one are redone.
export const PROMPT_VERSION = 2;
const BATCH = 15;

const TOOL = {
  name: "record_matches",
  description: "Record the comparable Walmart item for every ad row.",
  input_schema: {
    type: "object",
    properties: {
      matches: {
        type: "array",
        items: {
          type: "object",
          properties: {
            row: { type: "integer", description: "The row number from the request." },
            pick: { type: ["integer", "null"], description: "Candidate number of the comparable Walmart item, or null when none is comparable." },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
            same_size: { type: "boolean", description: "True when the pack size / selling unit is the same or close enough to compare prices directly." },
            note: { type: "string", description: "At most 12 words: why this item, or what differs (size, variety, organic)." },
            retry_query: { type: ["string", "null"], description: "When pick is null or same_size is false: a short walmart.com search phrase likely to find the comparable fresh item in the ad's size. Otherwise null." },
          },
          required: ["row", "pick", "confidence", "same_size", "note", "retry_query"],
        },
      },
    },
    required: ["matches"],
  },
};

const SYSTEM = `You match grocery-store produce ads to the comparable Walmart item so a store can compare prices.
For each row you get a competitor ad item (store, name, price, deal text, size line) and numbered Walmart candidates (name, price, unit price).
Pick the candidate a shopper would treat as the same product: same fruit or vegetable, same variety where the ad names one, organic only if the ad says organic, fresh (never canned, frozen, dried, juice, snack, prepared or plants), and the closest pack size or selling unit (each vs. bag vs. per lb).
If the ad lists choices ("16 oz or 6 oz"), pick the candidate whose size equals one of them.
same_size is true only when the candidate's size or selling unit equals the ad's (or one of its listed choices); an unknown ad size counts as the same.
If no candidate is comparable, set pick to null and give a retry_query (for example "fresh navel orange each").
If the right product is there but only in a different size, pick it, set same_size false, and give a retry_query naming the ad's size (for example "fresh raspberries 6 oz").
Call record_matches exactly once with one entry per row.`;

function rowText(r, i) {
  const deal = [r.deal, r.size].filter(Boolean).join(" · ");
  const cands = r.cands.map((c, j) => `  ${j + 1}. ${c.name} — $${c.price.toFixed(2)}${c.unitText ? ` (${c.unitText})` : ""}`).join("\n");
  return `Row ${i + 1}: ${r.comp} ad: "${r.name}" $${r.price.toFixed(2)}${deal ? ` — ${deal}` : ""}\n${cands || "  (no candidates)"}`;
}

async function ask(rows) {
  const res = await chatTurn({
    model: MODEL, system: SYSTEM, tools: [TOOL],
    messages: [{ role: "user", content: rows.map(rowText).join("\n\n") }],
  });
  const call = res.content.find((b) => b.type === "tool_use" && b.name === TOOL.name);
  let list = call?.input?.matches;
  if (!Array.isArray(list)) {
    // A text reply with the JSON inline still counts.
    const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    try { list = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)).matches; } catch { list = null; }
  }
  if (!Array.isArray(list)) throw new Error("The AI didn't return matches.");
  const out = new Map();
  for (const m of list) {
    const r = rows[Number(m.row) - 1];
    if (!r) continue;
    const c = Number.isInteger(m.pick) ? r.cands[m.pick - 1] : null;
    out.set(r.key, {
      id: c?.id || "", confidence: ["high", "medium", "low"].includes(m.confidence) ? m.confidence : "medium", sameSize: m.same_size !== false,
      note: String(m.note || "").slice(0, 120),
      retry: c && m.same_size !== false ? "" : String(m.retry_query || "").slice(0, 60),
    });
  }
  return out;
}

/**
 * @param {Array<{key, comp, name, price, deal, size, cands}>} rows
 * @returns {Promise<Map<key, {id, confidence, sameSize, note, retry}>>}
 */
export async function aiMatch(rows) {
  const all = new Map();
  for (let i = 0; i < rows.length; i += BATCH) {
    for (const [k, v] of await ask(rows.slice(i, i + BATCH))) all.set(k, v);
  }
  return all;
}
