// The SW run came back `stop_reason: max_tokens, blocks: thinking` — the gateway
// spent the whole budget thinking. Which knob fixes it?
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const home = os.homedir();
const tok = /^puppy_token\s*=\s*(.+)$/m.exec(fs.readFileSync(path.join(home, ".code_puppy", "puppy.cfg"), "utf8"))?.[1]?.trim();
process.env.NODE_EXTRA_CA_CERTS = path.join(home, ".code-puppy-venv/Lib/site-packages/code_puppy/plugins/walmart_specific/certs/walmart-bundle.pem");

const box = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const { buildAnalysis } = await import("../modules/cx/lib/aggregate.js");
const narr = await import("../modules/cx/lib/narrative.js");
const analysis = buildAnalysis(box.records, { filters: {}, windowDays: 28 });
const facts = narr.promptFacts(analysis, { storeNbr: "1458", scores: null });
const user = "Store 1458. Write the Cx read-out from the figures below.\n\n```json\n" + JSON.stringify(facts, null, 1) + "\n```";

const variants = [
  { name: "max_tokens 2000 (current)",           extra: { max_tokens: 2000 } },
  { name: "max_tokens 2000 + thinking disabled", extra: { max_tokens: 2000, thinking: { type: "disabled" } } },
  { name: "max_tokens 8000",                     extra: { max_tokens: 8000 } },
  { name: "max_tokens 8000 + thinking disabled", extra: { max_tokens: 8000, thinking: { type: "disabled" } } },
];

for (const v of variants) {
  const t0 = Date.now();
  const r = await fetch("https://puppy-backend.walmart.com/anthropic/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Api-Key": tok, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-5", system: "You write short Cx read-outs. Use the figures given; do not derive any.", messages: [{ role: "user", content: user }], ...v.extra }),
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { console.log(`${v.name}: unparseable ${r.status}`); continue; }
  const blocks = (j.content ?? []).map(b => b.type).join(",") || "none";
  const txt = (j.content ?? []).filter(b => b.type === "text").map(b => b.text).join("");
  console.log(`${v.name.padEnd(38)} ${r.status} ${String(Math.round((Date.now()-t0)/1000)).padStart(3)}s  stop=${String(j.stop_reason).padEnd(10)} blocks=${blocks.padEnd(14)} text=${txt.length}  think=${j.usage?.output_tokens_details?.thinking_tokens ?? "?"}  out=${j.usage?.output_tokens ?? "?"}`);
  if (j.error) console.log("    error:", JSON.stringify(j.error).slice(0, 250));
}
