import test from "node:test";
import assert from "node:assert/strict";
import { noteWalks, walkMixByName, mixText } from "../walk_log.js";

const hours = (walks) => [{ slot: "7pm - 8pm", walks }];

test("walks are logged once, with first/last seen across readings", () => {
  const w = { name: "Cooper Arnold", section: "Oversized", qty: 6, due: "06:30pm", status: "On time" };
  let log = noteWalks(null, hours([w]), 1000, "2026-10-09");
  log = noteWalks(log, hours([{ ...w, status: "4 min late" }]), 3000, "2026-10-09");
  const all = Object.values(log.walks);
  assert.equal(all.length, 1);
  assert.equal(all[0].firstSeen, 1000);
  assert.equal(all[0].lastSeen, 3000);
  assert.equal(all[0].status, "4 min late");
});

test("cut-off cards (no due time) are skipped; a new day starts a new log", () => {
  let log = noteWalks(null, hours([{ name: "A B", section: "Ambient", qty: 5, due: null }]), 1, "2026-10-09");
  assert.equal(Object.keys(log.walks).length, 0);
  log = noteWalks(log, hours([{ name: "A B", section: "Ambient", qty: 5, due: "06:30pm" }]), 2, "2026-10-09");
  log = noteWalks(log, hours([{ name: "C D", section: "Ambient", qty: 5, due: "06:30am" }]), 3, "2026-10-10");
  assert.equal(log.day, "2026-10-10");
  assert.deepEqual(Object.values(log.walks).map((w) => w.name), ["C D"]);
});

test("mix per picker: sections biggest first", () => {
  let log = null;
  const mk = (section, due, qty) => ({ name: "Cooper Arnold", section, qty, due });
  log = noteWalks(log, hours([mk("Oversized", "01:30pm", 4), mk("Oversized", "02:30pm", 3), mk("Ambient", "03:30pm", 40)]), 1, "d");
  const m = walkMixByName(log)["Cooper Arnold"];
  assert.equal(m.walks, 3);
  assert.equal(m.items, 47);
  assert.equal(mixText(m), "Oversized 2, Ambient 1");
});
