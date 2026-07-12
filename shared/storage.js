// shared/storage.js
//
// Namespaced chrome.storage wrapper. Every read/write is prefixed with the
// caller's module id so storage keys can't collide across modules.
//
// Usage:
//   const store = createStorage("closinglist");
//   await store.sync.set("storeNbr", "9999");
//   // Actually writes chrome.storage.sync["closinglist.storeNbr"] = "9999"
//
// A reserved "shell" namespace is used by the shell itself for suite-level
// state (current route, sidebar collapsed, telemetry).
//
// Migration helper at the bottom lets a module copy values from old
// unnamespaced keys into namespaced ones on first run.

const SEP = ".";

function makeArea(area, prefix) {
  const fullKey = (k) => `${prefix}${SEP}${k}`;

  return {
    async get(key) {
      if (key == null) {
        // get-all-for-this-prefix
        const all = await chrome.storage[area].get(null);
        const out = {};
        const pfx = `${prefix}${SEP}`;
        for (const k of Object.keys(all)) {
          if (k.startsWith(pfx)) out[k.slice(pfx.length)] = all[k];
        }
        return out;
      }
      const result = await chrome.storage[area].get(fullKey(key));
      return result[fullKey(key)];
    },

    async set(key, value) {
      if (typeof key === "object" && key !== null && value === undefined) {
        // set(object) form
        const mapped = {};
        for (const [k, v] of Object.entries(key)) mapped[fullKey(k)] = v;
        return chrome.storage[area].set(mapped);
      }
      return chrome.storage[area].set({ [fullKey(key)]: value });
    },

    async remove(keys) {
      const arr = Array.isArray(keys) ? keys : [keys];
      return chrome.storage[area].remove(arr.map(fullKey));
    },

    // Listen for changes to keys in this namespace.
    onChange(handler) {
      const listener = (changes, areaName) => {
        if (areaName !== area) return;
        const pfx = `${prefix}${SEP}`;
        const scoped = {};
        let any = false;
        for (const [k, change] of Object.entries(changes)) {
          if (k.startsWith(pfx)) {
            scoped[k.slice(pfx.length)] = change;
            any = true;
          }
        }
        if (any) handler(scoped);
      };
      chrome.storage.onChanged.addListener(listener);
      return () => chrome.storage.onChanged.removeListener(listener);
    },
  };
}

export function createStorage(moduleId) {
  if (!moduleId || typeof moduleId !== "string") {
    throw new Error("createStorage: moduleId required");
  }
  // NOTE: `session` is available in service workers and extension pages
  // (popup, options, full-page). It is NOT available in content scripts —
  // attempting to use it there throws. Modules that need state shared with
  // a content script should use `local` (persistent) or pass state via
  // messaging.
  return {
    local:   makeArea("local",   moduleId),
    sync:    makeArea("sync",    moduleId),
    session: makeArea("session", moduleId),
  };
}

// One-time migration from legacy unnamespaced keys.
// Pass { sync: ["storeNbr", "recipient"], local: ["ivrFlowState"], ... } and
// each present legacy key is copied to its namespaced equivalent and removed.
// Idempotent — safe to call on every module register().
export async function migrateLegacyKeys(moduleId, plan) {
  for (const area of ["local", "sync", "session"]) {
    const keys = plan[area];
    if (!keys?.length) continue;
    const found = await chrome.storage[area].get(keys);
    const mapped = {};
    const toRemove = [];
    for (const k of keys) {
      if (k in found) {
        mapped[`${moduleId}${SEP}${k}`] = found[k];
        toRemove.push(k);
      }
    }
    if (toRemove.length) {
      await chrome.storage[area].set(mapped);
      await chrome.storage[area].remove(toRemove);
      console.log(`[APAISuite storage] migrated ${toRemove.length} legacy ${area} key(s) for ${moduleId}:`, toRemove);
    }
  }
}
