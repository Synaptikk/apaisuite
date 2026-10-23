// modules/doorcatch/lib/store_sync.js
//
// Store-wide sharing for other modules' records (BoB and Lisa, Register L/S),
// behind the store's Door Catches review key: whoever can open Door Catches
// for the store shares these records with everyone else who can.
//
// A module describes each shared collection as
//   { ns, read(store) → { [id]: record }, write(store, { [id]: record | null }) }
// and calls syncCollections(store, defs). Per collection this browser keeps
// `storesync.<ns>.<store>` = { rev, base: { [id]: hash } }: the server cursor
// and the hash of every record as last agreed with the server. A sync
//   1. diffs the local records against `base` → puts (new, changed, deleted),
//   2. sends them to /api/door/sync and pulls everything written since `rev`
//      (newest `at` wins per record on the server),
//   3. writes back only the remote records whose hash differs from `base`.
// The first sync for a collection pulls first (the store's copy wins), then
// pushes whatever only this browser had. Only the human-made records travel;
// each browser still pulls EJ / Power BI / WorkView itself.

import { getIdentity } from "../../../shared/identity.js";
import { ready } from "./access.js";
import { syncShared } from "./api.js";

const OVERLAP_MS = 120_000;     // re-read 2 min behind the cursor: server write times from different instances can land out of order
const MAX_ITEM = 400_000;       // the server's cap for one record
const MAX_BODY = 1_500_000;
const MAX_PUTS = 200;
const TAG = "[store_sync]";

const stateKey = (ns, store) => `storesync.${ns}.${store}`;

export function stableJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : stableJson(x))).join(",")}]`;
  return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(",")}}`;
}

// cyrb53: small and fast; collisions only cost a skipped re-sync of one record.
function hashStr(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
const hashOf = (v) => hashStr(stableJson(v));

// One sync at a time per store + collection set; a second caller waits.
const chains = new Map();
function serial(key, fn) {
  const next = (chains.get(key) || Promise.resolve()).catch(() => {}).then(fn);
  chains.set(key, next);
  return next;
}

/** The Door Catches key, when it is for this store. */
export async function storeAccess(storeNbr) {
  const { s, error } = await ready();
  if (error) return { ok: false, shared: false, noAccess: !!error.noAccess, error: error.error || "Couldn't reach the door catch service." };
  if (String(s.storeNbr) !== String(storeNbr)) {
    return { ok: false, shared: false, error: `Sharing uses the Door Catches key, which is for store ${s.storeNbr}, not ${storeNbr}.` };
  }
  return { ok: true, s };
}

function diff(local, base) {
  const puts = [], at = Date.now();
  for (const [id, data] of Object.entries(local)) {
    const json = stableJson(data);
    if (json.length > MAX_ITEM) { console.warn(TAG, `record ${id} is ${json.length} bytes; not shared`); continue; }
    if (base[id] !== hashStr(json)) puts.push({ id, at, data, size: json.length });
  }
  for (const id of Object.keys(base)) if (!(id in local)) puts.push({ id, at, deleted: true, size: 50 });
  return puts;
}

function takeChunk(queue) {
  const out = [];
  let bytes = 0;
  while (queue.length && out.length < MAX_PUTS && (!out.length || bytes + queue[0].size < MAX_BODY)) {
    const p = queue.shift();
    bytes += p.size;
    out.push(p);
  }
  return out.map(({ size, ...p }) => p);
}

async function syncOne(def, storeNbr, s, by, st, local, puts) {
  const first = !st;
  const base = { ...(st?.base || {}) };
  let rev = st?.rev || 0;
  let since = Math.max(0, rev - OVERLAP_MS);
  const queue = puts.slice();
  const remote = new Map();
  let pushed = 0, more = true;
  while (queue.length || more) {
    const chunk = takeChunk(queue);
    const res = await syncShared({ storeNbr, reviewKey: s.reviewKey, ns: def.ns, since, puts: chunk, by });
    if (!res.ok) return { ok: false, error: res.error };
    for (const p of chunk) { if (p.deleted) delete base[p.id]; else base[p.id] = hashOf(p.data); }
    pushed += chunk.length;
    for (const it of res.items || []) remote.set(it.id, it);
    rev = Math.max(rev, res.rev || 0);
    const stuck = res.more && res.rev === since;   // a page of one write time; can't page past it
    more = !!res.more && !stuck;
    if (more) since = res.rev;
  }

  const changes = {};
  for (const it of remote.values()) {
    if (it.deleted) {
      if (it.id in base || it.id in local) changes[it.id] = null;
      delete base[it.id];
      continue;
    }
    const h = hashOf(it.data);
    if (base[it.id] === h) continue;                                   // ours, or already have it
    base[it.id] = h;
    if (first && it.id in local && hashOf(local[it.id]) === h) continue;
    changes[it.id] = it.data;
  }
  const applied = Object.keys(changes).length;
  if (applied) await def.write(storeNbr, changes);
  await chrome.storage.local.set({ [stateKey(def.ns, storeNbr)]: { rev, base, at: Date.now() } });
  return { ok: true, applied, pushed, first };
}

/**
 * Sync each collection with the store's shared copy.
 * pushOnly: called after a local save; skips the network when nothing here changed.
 * → { ok, shared, applied: { [ns]: n }, pushed, error }
 */
export function syncCollections(storeNbr, defs, { pushOnly = false } = {}) {
  if (!storeNbr) return Promise.resolve({ ok: false, shared: false, error: "No store number." });
  return serial(`${storeNbr}:${defs.map((d) => d.ns).join(",")}`, async () => {
    const states = await chrome.storage.local.get(defs.map((d) => stateKey(d.ns, storeNbr)));
    const plans = [];
    for (const def of defs) {
      const st = states[stateKey(def.ns, storeNbr)] || null;
      const local = await def.read(storeNbr);
      plans.push({ def, st, local, puts: st ? diff(local, st.base) : [] });
    }
    if (pushOnly && !plans.some((p) => p.puts.length)) return { ok: true, shared: true, skipped: true, applied: {}, pushed: 0 };

    const acc = await storeAccess(storeNbr);
    if (!acc.ok) return acc;
    const me = await getIdentity().catch(() => ({}));
    const by = me.displayName || me.win || "";
    const out = { ok: true, shared: true, applied: {}, pushed: 0, at: Date.now() };
    for (const p of plans) {
      let r = await syncOne(p.def, storeNbr, acc.s, by, p.st, p.local, p.puts);
      if (r.ok && r.first) {
        // The store's copy is in; now push what only this browser had.
        const st = (await chrome.storage.local.get(stateKey(p.def.ns, storeNbr)))[stateKey(p.def.ns, storeNbr)];
        const local = await p.def.read(storeNbr);
        const applied = r.applied;
        r = await syncOne(p.def, storeNbr, acc.s, by, st, local, diff(local, st.base));
        r.applied += applied;
      }
      if (!r.ok) return { ...out, ok: false, error: r.error };
      if (r.applied) out.applied[p.def.ns] = r.applied;
      out.pushed += r.pushed;
    }
    return out;
  });
}

/** Calls fn (debounced) after any chrome.storage.local change to a key `match` accepts. */
export function watchStorage(match, fn, delayMs = 3000) {
  let timer = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !Object.keys(changes).some(match)) return;
    clearTimeout(timer);
    timer = setTimeout(fn, delayMs);
  });
}

export async function keysWithPrefix(prefix) {
  const keys = chrome.storage.local.getKeys ? await chrome.storage.local.getKeys() : Object.keys(await chrome.storage.local.get(null));
  return keys.filter((k) => k.startsWith(prefix));
}

/** A collection where each record is its own storage key: `${prefix}${id}`. */
export function prefixCollection(ns, prefix) {
  return {
    ns,
    async read() {
      const keys = await keysWithPrefix(prefix);
      const got = keys.length ? await chrome.storage.local.get(keys) : {};
      const out = {};
      for (const [k, v] of Object.entries(got)) if (v != null) out[k.slice(prefix.length)] = v;
      return out;
    },
    async write(_store, changes) {
      const set = {}, remove = [];
      for (const [id, v] of Object.entries(changes)) { if (v == null) remove.push(prefix + id); else set[prefix + id] = v; }
      if (Object.keys(set).length) await chrome.storage.local.set(set);
      if (remove.length) await chrome.storage.local.remove(remove);
    },
  };
}
