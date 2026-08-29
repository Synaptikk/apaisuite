#!/usr/bin/env node
// scripts/auth-hash-config.mjs
//
// Print a Firebase project's password hash parameters, and the ready-to-run
// `firebase auth:import` command built from them.
//
// WHY. Migrating dashboard accounts between projects is auth:export followed
// by auth:import, and the import needs the SOURCE project's hash parameters or
// every imported password silently fails to verify. Nothing warns you: the
// accounts import cleanly, and the breakage only appears when a human tries to
// sign in.
//
// docs/AURORBUDDY_PROJECT_MIGRATION.md §4 says those parameters "are only in
// the console". They are not — the Identity Toolkit admin config resource
// carries them as `hashConfig`, from the same endpoint scripts/enable-anon-auth.mjs
// already reads. That matters here because the console is unreachable from a
// Walmart machine: the corp proxy blocks Google web sign-in for personal
// accounts while leaving the API alone.
//
// CREDENTIALS. Uses the OAuth token your `firebase` CLI already holds. Nothing
// is written and nothing leaves the machine except to Google's own endpoints.
//
// THE SIGNER KEY IS A SECRET. It is the key the project uses to hash
// passwords. Redacted by default; --reveal prints it because auth:import
// needs it. Do not paste a revealed key into a ticket, a chat, or a commit.
//
// USAGE
//   node scripts/auth-hash-config.mjs                      # redacted
//   node scripts/auth-hash-config.mjs --reveal             # runnable command
//   node scripts/auth-hash-config.mjs --from=X --to=Y

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLIENT_ID     = "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi";

const args   = process.argv.slice(2);
const reveal = args.includes("--reveal");
const arg    = (n, d) => (args.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${d}`).split("=").slice(1).join("=");
const FROM   = arg("from", "aurorbuddy");   // source of both accounts and hash params
const TO     = arg("to",   "apaisuite");

const die = (m) => { console.error(`\n✖ ${m}\n`); process.exit(1); };

async function accessToken() {
  const p = path.join(os.homedir(), ".config", "configstore", "firebase-tools.json");
  if (!fs.existsSync(p)) die(`No firebase-tools config at ${p}. Run \`firebase login\` first.`);
  let rt;
  try { rt = JSON.parse(fs.readFileSync(p, "utf8"))?.tokens?.refresh_token; }
  catch { die(`Could not parse ${p}.`); }
  if (!rt) die("No refresh token stored. Run `firebase login` first.");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      refresh_token: rt, grant_type: "refresh_token",
    }),
  });
  if (!res.ok) die(`Token exchange failed (${res.status}). Try \`firebase login --reauth\`.`);
  return (await res.json()).access_token;
}

async function hashConfigOf(token, project) {
  const res = await fetch(`https://identitytoolkit.googleapis.com/admin/v2/projects/${project}/config`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.text();
  if (!res.ok) {
    if (res.status === 403) die(`403 on ${project} — your account may lack Firebase Admin there.\n  ${body.slice(0, 200)}`);
    if (res.status === 404) die(`Project "${project}" not found, or Authentication was never initialised on it.`);
    die(`GET config failed (${res.status}).\n  ${body.slice(0, 200)}`);
  }
  return JSON.parse(body)?.signIn?.hashConfig ?? null;
}

const mask = (s) => (!s ? "" : s.length <= 12 ? "…" : `${s.slice(0, 6)}…${s.slice(-4)}  (${s.length} chars)`);

async function main() {
  const token = await accessToken();
  const hc    = await hashConfigOf(token, FROM);

  console.log(`\nPassword hash parameters — project "${FROM}"\n`);

  if (!hc || !hc.algorithm) {
    die(`No hashConfig returned for "${FROM}".\n` +
        `  That usually means no password users exist yet, so there is nothing to\n` +
        `  migrate — or the project uses a provider without a local hash. If you are\n` +
        `  certain password accounts exist, the console remains the fallback:\n` +
        `  Authentication → Users → ⋮ → Password hash parameters.`);
  }

  console.log(`  algorithm       ${hc.algorithm}`);
  console.log(`  rounds          ${hc.rounds ?? "(none)"}`);
  console.log(`  memoryCost      ${hc.memoryCost ?? "(none)"}`);
  console.log(`  saltSeparator   ${hc.saltSeparator ?? "(none)"}`);
  console.log(`  signerKey       ${reveal ? hc.signerKey : mask(hc.signerKey)}`);

  const flags = [
    `--hash-algo=${hc.algorithm}`,
    `--hash-key=${reveal ? hc.signerKey : "<run with --reveal>"}`,
    hc.saltSeparator ? `--salt-separator=${hc.saltSeparator}` : null,
    hc.rounds     != null ? `--rounds=${hc.rounds}`      : null,
    hc.memoryCost != null ? `--mem-cost=${hc.memoryCost}` : null,
  ].filter(Boolean);

  console.log(`\nTo copy the accounts from "${FROM}" into "${TO}":\n`);
  console.log(`  firebase auth:export users.json --project ${FROM}`);
  console.log(`  firebase auth:import users.json --project ${TO} \\`);
  console.log(flags.map((f, i) => `    ${f}${i < flags.length - 1 ? " \\" : ""}`).join("\n"));

  if (!reveal) console.log(`\n(re-run with --reveal to fill in the signer key)`);

  console.log(`
Notes:
  · auth:import PRESERVES uids, which is load-bearing — users/{uid} in
    Firestore is keyed by auth uid, and those docs are already copied.
  · It is a COPY. Accounts must exist in BOTH projects while the dashboard
    signs in to both.
  · users.json contains password hashes. Keep it out of git and delete it
    when the import succeeds.
  · The signer key above is a secret; do not paste a revealed one anywhere.
`);
}

main().catch((e) => die(e?.message ?? String(e)));
