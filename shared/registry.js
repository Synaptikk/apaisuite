// shared/registry.js
//
// Module registry — loads modules from modules/_registry.js and exposes them
// to the shell. The registry is the only file that knows the list of modules;
// adding a new module is two lines (an import + an array entry) in
// modules/_registry.js, never an edit here.

import modulesArray from "../modules/_registry.js";

// Module IDs become storage-key prefixes AND CSS class names (.module-<id>),
// so they must be safe in both contexts. Lowercase letters, digits, hyphen,
// underscore. Must start with a letter.
const ID_RE = /^[a-z][a-z0-9_-]*$/;

const modules = new Map();   // id -> { manifest, register, _mod }

for (const mod of modulesArray) {
  const id = mod?.manifest?.id;
  if (!id) {
    console.warn("[APAISuite registry] skipping malformed module:", mod);
    continue;
  }
  if (!ID_RE.test(id)) {
    console.error(`[APAISuite registry] invalid module id "${id}" — must match ${ID_RE}. Skipping.`);
    continue;
  }
  if (modules.has(id)) {
    console.warn(`[APAISuite registry] duplicate module id "${id}" — keeping first`);
    continue;
  }
  modules.set(id, mod);
}

export function listModules() {
  return [...modules.values()];
}

export function getModule(id) {
  return modules.get(id) ?? null;
}

export function moduleIds() {
  return [...modules.keys()];
}
