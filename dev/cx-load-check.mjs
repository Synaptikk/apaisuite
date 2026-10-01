// dev/cx-load-check.mjs
//
// Import every cx module with a stubbed `chrome`, to catch the failure class
// `node --check` cannot see: code that PARSES but throws at evaluation time.
//
// This exists because a deleted constant left one dangling reference in
// lib/puppy_auth.js. That is a ReferenceError the moment the module is
// evaluated, which fails the import in modules/_registry.js, which takes down
// the whole shell — the extension simply would not open. Every syntax check
// passed the whole time.
//
//   node dev/cx-load-check.mjs
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const noop = () => {};
const listener = { addListener: noop, removeListener: noop, hasListener: () => false };
const area = { get: async () => ({}), set: async () => {}, remove: async () => {}, clear: async () => {} };

globalThis.chrome = {
  runtime: { getURL: (p) => `chrome-extension://stub/${p}`, sendMessage: noop, onMessage: listener,
             lastError: null, id: "stub", getManifest: () => ({}) },
  storage: { local: area, session: area, sync: area, onChanged: listener },
  tabs: { query: async () => [], create: async () => ({ id: 1 }), get: async () => ({}), remove: async () => {},
          update: async () => ({}), reload: async () => {}, onRemoved: listener, onUpdated: listener },
  scripting: { executeScript: async () => [] },
  alarms: { create: noop, get: async () => null, getAll: async () => [], clear: async () => true, onAlarm: listener },
  webRequest: { onBeforeRequest: listener, onSendHeaders: listener, onBeforeSendHeaders: listener },
  permissions: { getAll: (cb) => cb({ origins: [], permissions: [] }) },
  downloads: { download: noop },
  notifications: { create: noop, onClicked: listener },
  cookies: { getAll: async () => [] },
  windows: { create: async () => ({}) },
};

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)), "modules/cx");
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) { if (name !== "tests") walk(full); continue; }
    if (name.endsWith(".js")) files.push(full);
  }
})(ROOT);

let failed = 0;
for (const f of files.sort()) {
  const rel = path.relative(ROOT, f).split(path.sep).join("/");
  // Content scripts are not ES modules and are not imported by anything.
  if (rel.startsWith("content/")) { console.log(`  skip   ${rel} (content script)`); continue; }
  try {
    await import(pathToFileURL(f).href);
    console.log(`  ok     ${rel}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL   ${rel}\n           ${String(e?.message ?? e).split("\n")[0]}`);
  }
}
console.log(failed ? `\n${failed} module(s) fail to evaluate` : "\nall modules evaluate");
process.exit(failed ? 1 : 0);
