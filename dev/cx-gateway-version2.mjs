// Is the gate "this version is blacklisted" or "below a floor"? Knowing which
// tells the user what to install, and tells us what to send.
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const home = os.homedir();
const tok = /^puppy_token\s*=\s*(.+)$/m.exec(fs.readFileSync(path.join(home, ".code_puppy", "puppy.cfg"), "utf8"))?.[1]?.trim();
process.env.NODE_EXTRA_CA_CERTS = path.join(home, ".code-puppy-venv/Lib/site-packages/code_puppy/plugins/walmart_specific/certs/walmart-bundle.pem");

const probe = async (version) => {
  const headers = { "content-type": "application/json", "X-Api-Key": tok, "anthropic-version": "2023-06-01" };
  if (version) headers["x-puppy-version"] = version;
  const r = await fetch("https://puppy-backend.walmart.com/anthropic/v1/messages", {
    method: "POST", headers,
    body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 32, messages: [{ role: "user", content: "Reply with exactly: OK" }] }),
  });
  const text = await r.text();
  return /out of date|temporarily blocked/i.test(text) ? "BLOCKED" : "passes";
};

for (const v of ["0.1.61", "0.1.70", "0.1.99", "0.2.0", "0.3.0", "1.0.0", "99.99.99"]) {
  console.log(`x-puppy-version: ${String(v).padEnd(10)} -> ${await probe(v)}`);
}
