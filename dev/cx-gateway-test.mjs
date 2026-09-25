// Can we reach the Walmart AI gateway with a plain fetch (extension-style)?
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const home = os.homedir();
const cfg = fs.readFileSync(path.join(home, ".code_puppy", "puppy.cfg"), "utf8");
const tok = /^puppy_token\s*=\s*(.+)$/m.exec(cfg)?.[1]?.trim();
if (!tok) { console.log("no token"); process.exit(1); }
const payload = JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString());
console.log("token exp:", new Date(payload.exp * 1000).toISOString(), "valid:", payload.exp * 1000 > Date.now());

const CA = path.join(home, ".code-puppy-venv/Lib/site-packages/code_puppy/plugins/walmart_specific/certs/walmart-bundle.pem");
if (fs.existsSync(CA)) process.env.NODE_EXTRA_CA_CERTS = CA;

const body = {
  model: "claude-sonnet-5",
  max_tokens: 200,
  messages: [{ role: "user", content: "Reply with exactly: GATEWAY OK" }],
};
const t0 = Date.now();
const r = await fetch("https://puppy-backend.walmart.com/anthropic/v1/messages", {
  method: "POST",
  headers: { "content-type": "application/json", "X-Api-Key": tok, "anthropic-version": "2023-06-01" },
  body: JSON.stringify(body),
});
const text = await r.text();
console.log("status", r.status, `${Date.now()-t0}ms`);
console.log("cors headers:", JSON.stringify({ allowOrigin: r.headers.get("access-control-allow-origin") }));
console.log(text.slice(0, 900));
