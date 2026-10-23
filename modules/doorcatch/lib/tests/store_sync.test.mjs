// node modules/doorcatch/lib/tests/store_sync.test.mjs
//
// Two browsers sharing one collection through a fake /api/door/sync that
// follows the server's rules (newest `at` wins, stale puts come back, pages
// by write time). Checks: first sync merges both sides, edits and deletes
// travel, an own echo is not re-applied, paging past one page works.
import assert from "node:assert/strict";

// ── fake server ───────────────────────────────────────────────────
const server = new Map();   // id → { id, at, by, deleted, json, rev }
let clock = 1_000_000;
const PAGE = 300;
function serverSync(b) {
  const stale = [];
  const rev = ++clock;
  for (const p of b.puts || []) {
    const old = server.get(p.id);
    if (old && old.at > p.at) { stale.push(old); continue; }
    server.set(p.id, { id: p.id, at: p.at, by: b.by, deleted: !!p.deleted, json: p.deleted ? null : JSON.stringify(p.data), rev });
  }
  const docs = [...server.values()].filter((d) => d.rev >= (b.since || 0)).sort((a, c) => a.rev - c.rev).slice(0, PAGE);
  const out = (d) => ({ id: d.id, at: d.at, by: d.by, deleted: d.deleted, data: d.json ? JSON.parse(d.json) : null });
  return { ok: true, items: [...docs.map(out), ...stale.map(out)], rev: docs.length ? docs.at(-1).rev : b.since, more: docs.length === PAGE };
}

// ── fake browsers: swap chrome.storage per browser ──────────────────
function makeStorage(init = {}) {
  const data = { ...init };
  return {
    data,
    local: {
      async get(keys) {
        if (keys == null) return { ...data };
        const out = {};
        for (const k of [].concat(keys)) if (k in data) out[k] = structuredClone(data[k]);
        return out;
      },
      async set(obj) { Object.assign(data, structuredClone(obj)); },
      async remove(keys) { for (const k of [].concat(keys)) delete data[k]; },
      async getKeys() { return Object.keys(data); },
    },
    onChanged: { addListener() {} },
  };
}
const settings = { "doorcatch.settings": { storeNbr: "1458", reviewKey: "k".repeat(20) } };
const A = makeStorage(settings), B = makeStorage(settings);
globalThis.chrome = { storage: A, runtime: { sendMessage: async () => {} } };
globalThis.fetch = async (url, init) => {
  assert.match(String(url), /\/api\/door\/sync$/);
  const body = serverSync(JSON.parse(init.body));
  return { ok: true, status: 200, json: async () => body };
};
const use = (s) => { globalThis.chrome.storage = s; };

const { syncCollections, prefixCollection } = await import("../store_sync.js");
const col = [prefixCollection("test_notes", "t.note.")];
const sync = async (s, opts) => { use(s); const r = await syncCollections("1458", col, opts); assert.equal(r.ok, true, r.error); return r; };

// First syncs: A has a, B has b → both end with a + b.
A.data["t.note.a"] = { text: "from A" };
B.data["t.note.b"] = { text: "from B" };
await sync(A);
await sync(B);
await sync(A);
assert.deepEqual(A.data["t.note.b"], { text: "from B" });
assert.deepEqual(B.data["t.note.a"], { text: "from A" });

// Edit on B travels to A; A's own echo is not counted as applied.
B.data["t.note.a"] = { text: "edited on B" };
let r = await sync(B, { pushOnly: true });
assert.equal(r.pushed, 1);
r = await sync(A);
assert.deepEqual(A.data["t.note.a"], { text: "edited on B" });
assert.deepEqual(r.applied, { test_notes: 1 });
r = await sync(A);
assert.deepEqual(r.applied, {});

// pushOnly with nothing changed makes no call.
const before = clock;
r = await sync(B, { pushOnly: true });
assert.equal(r.skipped, true);
assert.equal(clock, before);

// Delete on A removes it on B.
delete A.data["t.note.b"];
await sync(A);
await sync(B);
assert.equal("t.note.b" in B.data, false);

// A stale write loses: B edits with an older clock than A's newer edit.
A.data["t.note.a"] = { text: "A newest" };
await sync(A);
B.data["t.note.a"] = { text: "B older" };
const realNow = Date.now;
Date.now = () => realNow() - 3600_000;
await sync(B);
Date.now = realNow;
assert.deepEqual(B.data["t.note.a"], { text: "A newest" });

// Many records: paging past one server page.
for (let i = 0; i < 700; i++) A.data[`t.note.n${i}`] = { i };
await sync(A);
await sync(B);
assert.equal(Object.keys(B.data).filter((k) => k.startsWith("t.note.n")).length, 700);

console.log("store_sync: all checks passed");
