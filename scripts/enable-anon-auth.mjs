#!/usr/bin/env node
// scripts/enable-anon-auth.mjs
//
// Enable (or just inspect) Firebase Anonymous auth on a project, without the
// Firebase console.
//
// WHY THIS EXISTS. Every write in the suite's Firebase databases requires
// `request.auth != null`, which for the extension means Anonymous auth being
// enabled on the project. `backend/README.md` long listed that as a manual
// console step "not scriptable with the Firebase CLI" — true of the CLI, but
// the Identity Toolkit *admin* API exposes it directly, and that matters here:
// the corp network blocks Google web sign-in for personal accounts, so the
// console is unreachable from a work machine while the API is not
// (`firebase projects:list` works fine).
//
// CREDENTIALS. This reads the refresh token your `firebase` CLI already
// stored at ~/.config/configstore/firebase-tools.json and exchanges it for a
// short-lived access token in memory. Nothing is written anywhere, nothing is
// printed, and no token leaves your machine except to Google's own OAuth
// endpoint. If you are not logged in, run `firebase login` first — though note
// that also needs a browser, so on a blocked network use a machine where the
// CLI is already authenticated.
//
// USAGE
//   node scripts/enable-anon-auth.mjs                  # report current state
//   node scripts/enable-anon-auth.mjs --enable         # turn Anonymous on
//   node scripts/enable-anon-auth.mjs --project=other  # default: apaisuite
//
// Reporting is the default on purpose: this changes an auth provider on a live
// project, so seeing the current state should not require asking for a write.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// firebase-tools' own OAuth client. Both values are public constants compiled
// into the published CLI — this is the same identity `firebase login` uses,
// not a secret of yours.
const CLIENT_ID     = "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi";

const args     = process.argv.slice(2);
const doEnable = args.includes("--enable");
const project  = (args.find((a) => a.startsWith("--project=")) || "--project=apaisuite").split("=")[1];

function die(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

function readRefreshToken() {
  const p = path.join(os.homedir(), ".config", "configstore", "firebase-tools.json");
  if (!fs.existsSync(p)) die(`No firebase-tools config at ${p}. Run \`firebase login\` first.`);
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { die(`Could not parse ${p}.`); }
  const rt = cfg?.tokens?.refresh_token;
  if (!rt) die("No refresh token stored. Run `firebase login` first.");
  return rt;
}

async function accessToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    new URLSearchParams({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: readRefreshToken(),
      grant_type:    "refresh_token",
    }),
  });
  if (!res.ok) {
    die(`Token exchange failed (${res.status}). Your CLI login may have expired — try \`firebase login --reauth\`.\n  ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()).access_token;
}

const CONFIG_URL = `https://identitytoolkit.googleapis.com/admin/v2/projects/${project}/config`;

async function getConfig(token) {
  const res = await fetch(CONFIG_URL, { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.text();
  if (!res.ok) {
    if (res.status === 403) {
      die(`403 on ${project}. Either your account lacks Firebase Admin on this project, or the Identity Platform API is not enabled for it.\n  ${body.slice(0, 300)}`);
    }
    if (res.status === 404) die(`Project "${project}" not found, or Authentication was never initialised on it.`);
    die(`GET config failed (${res.status}).\n  ${body.slice(0, 300)}`);
  }
  return JSON.parse(body);
}

async function main() {
  console.log(`\nProject: ${project}`);
  const token = await accessToken();
  const cfg   = await getConfig(token);
  const on    = cfg?.signIn?.anonymous?.enabled === true;

  console.log(`Anonymous auth: ${on ? "ENABLED" : "disabled"}`);

  if (!doEnable) {
    if (!on) console.log("\nRe-run with --enable to turn it on.");
    console.log("");
    return;
  }
  if (on) {
    console.log("\nNothing to do — already enabled.\n");
    return;
  }

  const res = await fetch(`${CONFIG_URL}?updateMask=signIn.anonymous.enabled`, {
    method:  "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body:    JSON.stringify({ signIn: { anonymous: { enabled: true } } }),
  });
  if (!res.ok) die(`PATCH failed (${res.status}).\n  ${(await res.text()).slice(0, 300)}`);

  // Read it back rather than trusting the 200 — the whole point is to leave
  // no doubt about whether the provider is actually on.
  const after = await getConfig(token);
  if (after?.signIn?.anonymous?.enabled === true) {
    console.log("Anonymous auth: ENABLED ✔ (verified by read-back)\n");
  } else {
    die("PATCH returned 200 but the provider still reads as disabled. Check the console.");
  }
}

main().catch((e) => die(e?.message ?? String(e)));
