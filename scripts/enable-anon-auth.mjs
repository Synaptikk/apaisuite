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
// TWO PROVIDERS, TWO CONSUMERS. Both are needed on `apaisuite` and they are
// easy to conflate:
//   anonymous — the EXTENSION. Every module's Firestore client signs in this
//               way; without it every write fails.
//   email     — the DASHBOARD. It signs in with email/password against both
//               projects. Without it, sign-in fails `auth/operation-not-allowed`
//               and the page silently shows legacy data only — which reads as
//               "the migration did not work" when the data is fine and the
//               provider is just off.
//
// USAGE
//   node scripts/enable-anon-auth.mjs                       # report both
//   node scripts/enable-anon-auth.mjs --enable              # anonymous
//   node scripts/enable-anon-auth.mjs --enable=email        # email/password
//   node scripts/enable-anon-auth.mjs --enable=both
//   node scripts/enable-anon-auth.mjs --project=other       # default: apaisuite
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

const args    = process.argv.slice(2);
const project = (args.find((a) => a.startsWith("--project=")) || "--project=apaisuite").split("=")[1];

// --enable (bare) keeps its original meaning: anonymous.
const enableArg = args.find((a) => a === "--enable" || a.startsWith("--enable="));
const enableWhat = !enableArg ? null
  : enableArg === "--enable" ? "anonymous"
  : enableArg.split("=")[1];
if (enableWhat && !["anonymous", "email", "both"].includes(enableWhat)) {
  console.error(`\n✖ --enable must be anonymous, email or both (got "${enableWhat}")\n`);
  process.exit(1);
}

const PROVIDERS = {
  anonymous: {
    label: "Anonymous       (the extension)",
    read:  (cfg) => cfg?.signIn?.anonymous?.enabled === true,
    mask:  "signIn.anonymous.enabled",
    body:  { signIn: { anonymous: { enabled: true } } },
  },
  email: {
    label: "Email/password  (the dashboard)",
    read:  (cfg) => cfg?.signIn?.email?.enabled === true,
    mask:  "signIn.email.enabled,signIn.email.passwordRequired",
    body:  { signIn: { email: { enabled: true, passwordRequired: true } } },
  },
};

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

function report(cfg) {
  for (const p of Object.values(PROVIDERS)) {
    console.log(`  ${p.label}  ${p.read(cfg) ? "ENABLED" : "disabled"}`);
  }
}

async function enableOne(token, key) {
  const p = PROVIDERS[key];
  const res = await fetch(`${CONFIG_URL}?updateMask=${p.mask}`, {
    method:  "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body:    JSON.stringify(p.body),
  });
  if (!res.ok) die(`PATCH ${key} failed (${res.status}).\n  ${(await res.text()).slice(0, 300)}`);
}

async function main() {
  console.log(`\nProject: ${project}\n`);
  const token = await accessToken();
  const cfg   = await getConfig(token);
  report(cfg);

  if (!enableWhat) {
    const off = Object.entries(PROVIDERS).filter(([, p]) => !p.read(cfg)).map(([k]) => k);
    console.log(off.length
      ? `\nRe-run with --enable=${off.length > 1 ? "both" : off[0]} to turn ${off.length > 1 ? "them" : "it"} on.`
      : "\nBoth providers are on; nothing to do.");
    console.log("");
    return;
  }

  const wanted = enableWhat === "both" ? Object.keys(PROVIDERS) : [enableWhat];
  const todo   = wanted.filter((k) => !PROVIDERS[k].read(cfg));
  if (!todo.length) { console.log("\nNothing to do — already enabled.\n"); return; }

  console.log("");
  for (const k of todo) {
    await enableOne(token, k);
    console.log(`  enabling ${k}…`);
  }

  // Read back rather than trusting the 200s — the point of this script is to
  // leave no doubt about whether a provider is actually on.
  const after = await getConfig(token);
  console.log("");
  report(after);
  const stillOff = todo.filter((k) => !PROVIDERS[k].read(after));
  if (stillOff.length) die(`PATCH returned 200 but ${stillOff.join(", ")} still reads as disabled.`);
  console.log("\nVerified by read-back ✔\n");
}

main().catch((e) => die(e?.message ?? String(e)));
