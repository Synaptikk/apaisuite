// shared/tests/schema_watch.test.mjs
//
// Run with: node --test shared/tests/schema_watch.test.mjs
//
// The case this whole module exists for is the first test: Tableau renamed two
// VizPick columns on 2026-08-22, every capture failed, and nothing noticed for
// two days. A rename must be reported as a rename, not as "something changed".

import { test } from "node:test";
import assert from "node:assert/strict";

function installChromeStub() {
  const local = new Map();
  globalThis.chrome = {
    storage: {
      local: {
        get: async (k) => {
          const keys = Array.isArray(k) ? k : [k];
          const out = {};
          for (const key of keys) if (local.has(key)) out[key] = local.get(key);
          return out;
        },
        set: async (o) => { for (const [k, v] of Object.entries(o)) local.set(k, v); },
        remove: async (k) => { local.delete(k); },
      },
    },
  };
  return local;
}

const load = () => import(`../schema_watch.js?t=${process.hrtime.bigint()}`);

const OLD_DEPT = ["Dept", "Suggested Picks", "Suggested Picks Completed", "Pick %",
                  "Total Picked", "Cases Seen", "Cases Expected", "Cases Seen %",
                  "Overstock Exceptions", "Clearance Cases", "Modular Deleted Cases"];
const NEW_DEPT = ["Dept", "Suggested Picks Seen", "Suggested Picks Done", "Pick %",
                  "Total Picked", "Cases Seen", "Cases Expected", "Cases Seen %",
                  "Overstock Exceptions", "Clearance Cases", "Modular Deleted Cases"];

test("the real 2026-08-22 rename is detected and called a rename", async () => {
  const { diffSchema, describeDrift } = await load();
  const d = diffSchema(NEW_DEPT, OLD_DEPT);
  assert.equal(d.status, "drift");
  assert.deepEqual(d.added, ["Suggested Picks Seen", "Suggested Picks Done"]);
  assert.deepEqual(d.removed, ["Suggested Picks", "Suggested Picks Completed"]);
  const text = describeDrift("vizpick.deptBreakout", d);
  assert.match(text, /likely RENAME/);
  assert.match(text, /Suggested Picks Done/);
});

test("an identical shape is silent", async () => {
  const { diffSchema } = await load();
  assert.equal(diffSchema(OLD_DEPT, OLD_DEPT).status, "ok");
});

test("reordering is NOT drift — parsers resolve by name", async () => {
  const { diffSchema } = await load();
  const shuffled = [...OLD_DEPT].reverse();
  assert.equal(diffSchema(shuffled, OLD_DEPT).status, "ok",
    "a reorder cannot break a by-name lookup, so reporting it would be noise");
});

test("an ADDED column is reported even though it breaks nothing", async () => {
  // The valuable case: still parses, but the source is moving under us.
  const { diffSchema } = await load();
  const d = diffSchema([...OLD_DEPT, "Pick Anyway Picks"], OLD_DEPT);
  assert.equal(d.status, "drift");
  assert.deepEqual(d.added, ["Pick Anyway Picks"]);
  assert.deepEqual(d.removed, []);
});

test("a REMOVED column is reported", async () => {
  const { diffSchema } = await load();
  const d = diffSchema(OLD_DEPT.filter((c) => c !== "Cases Expected"), OLD_DEPT);
  assert.deepEqual(d.removed, ["Cases Expected"]);
});

test("whitespace and empty cells do not fake a drift", async () => {
  const { diffSchema } = await load();
  const padded = OLD_DEPT.map((c) => `  ${c} `).concat(["", "   "]);
  assert.equal(diffSchema(padded, OLD_DEPT).status, "ok");
});

test("no baseline reports 'unbaselined' rather than pretending it is fine", async () => {
  const { diffSchema } = await load();
  for (const empty of [undefined, null, []]) {
    assert.equal(diffSchema(OLD_DEPT, empty).status, "unbaselined");
  }
});

test("the same drift is reported ONCE, however many times it is parsed", async () => {
  installChromeStub();
  const { noteSchema, readPendingDrift } = await load();
  // A ten-store crawl parses ten times, every half hour.
  for (let i = 0; i < 10; i++) {
    await noteSchema({ sourceId: "vizpick.deptBreakout", columns: NEW_DEPT, baseline: OLD_DEPT });
  }
  const pending = await readPendingDrift();
  assert.equal(pending.length, 1, "ten parses of one drift is one fact, not ten");
});

test("a DIFFERENT drift after the first is still reported", async () => {
  installChromeStub();
  const { noteSchema, readPendingDrift } = await load();
  await noteSchema({ sourceId: "s", columns: NEW_DEPT, baseline: OLD_DEPT });
  await noteSchema({ sourceId: "s", columns: [...NEW_DEPT, "Another"], baseline: OLD_DEPT });
  assert.equal((await readPendingDrift()).length, 2);
});

test("the uploaded row carries column NAMES and nothing else", async () => {
  const { buildDriftRow, diffSchema } = await load();
  const row = buildDriftRow({
    sourceId: "vizpick.deptBreakout",
    diff: diffSchema(NEW_DEPT, OLD_DEPT),
    parsed: true,
  });
  // This payload leaves the machine, so assert its whole surface rather than
  // trusting that nobody adds a row value to it later.
  assert.deepEqual(Object.keys(row).sort(), [
    "added", "columnCount", "detectedAt", "fingerprint", "observedColumns",
    "removed", "sourceId", "status", "stillParsed", "summary",
  ]);
  const blob = JSON.stringify(row);
  for (const leak of ["1458", "9,196", "63%", "@", "Bearer"]) {
    assert.ok(!blob.includes(leak), `payload must not contain ${leak}`);
  }
});

test("stillParsed distinguishes a warning from a breakage", async () => {
  const { buildDriftRow, diffSchema } = await load();
  const d = diffSchema(NEW_DEPT, OLD_DEPT);
  assert.equal(buildDriftRow({ sourceId: "s", diff: d, parsed: true }).stillParsed, true);
  assert.equal(buildDriftRow({ sourceId: "s", diff: d, parsed: false }).stillParsed, false);
});

test("noteSchema never throws, even with storage unavailable", async () => {
  installChromeStub();
  const { noteSchema } = await load();
  chrome.storage.local.get = async () => { throw new Error("no storage"); };
  const r = await noteSchema({ sourceId: "s", columns: NEW_DEPT, baseline: OLD_DEPT });
  // A watcher that can break what it watches is worse than no watcher.
  assert.equal(r.error, true);
  assert.equal(r.diff.status, "drift");
});

test("the shipped baseline file matches what the parser expects today", async () => {
  const { readFile } = await import("node:fs/promises");
  const url = new URL("../data/source_schemas.json", import.meta.url);
  const cfg = JSON.parse(await readFile(url, "utf8"));
  const { diffSchema } = await load();
  // Guards the file against drifting from reality unnoticed — the baseline is
  // only useful if it is actually the current shape.
  assert.equal(diffSchema(NEW_DEPT, cfg["vizpick.deptBreakout"].columns).status, "ok");
  assert.equal(cfg["vizpick.summaryByStore"].columns.length, 17);
});
