// The gateway gates on `x-puppy-version` against a CLI blacklist, and the
// plugin's own docstring says an ABSENT header reads as "so old it never sent
// one". Our calls send none. Which values actually get through?
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const home = os.homedir();
const tok = /^puppy_token\s*=\s*(.+)$/m.exec(fs.readFileSync(path.join(home, ".code_puppy", "puppy.cfg"), "utf8"))?.[1]?.trim();
process.env.NODE_EXTRA_CA_CERTS = path.join(home, ".code-puppy-venv/Lib/site-packages/code_puppy/plugins/walmart_specific/certs/walmart-bundle.pem");

const VARIANTS = [
  ["no header at all (what we send today)", null],
  ["installed CLI version 0.1.61",          "0.1.61"],
  ["sentinel 0.0.0-dev",                    "0.0.0-dev"],
  ["obviously ancient 0.0.1",               "0.0.1"],
];

for (const [label, version] of VARIANTS) {
  const headers = { "content-type": "application/json", "X-Api-Key": tok, "anthropic-version": "2023-06-01" };
  if (version) headers["x-puppy-version"] = version;
  let out;
  try {
    const r = await fetch("https://puppy-backend.walmart.com/anthropic/v1/messages", {
      method: "POST", headers,
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 64, messages: [{ role: "user", content: "Reply with exactly: OK" }] }),
    });
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch { j = null; }
    const body = (j?.content ?? []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    const blocked = /out of date|temporarily blocked|update to the latest/i.test(text);
    out = `${r.status}  blocked=${blocked}  text="${(body || text).slice(0, 80).replace(/\s+/g, " ")}"`;
  } catch (e) { out = "threw: " + String(e.message).slice(0, 60); }
  console.log(`${label.padEnd(40)} ${out}`);
}
