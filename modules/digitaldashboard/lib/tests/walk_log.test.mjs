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
  log = noteWalks(log, hours([mk("Oversized", "01:30pm", 4)]), 1, "d");
  log = noteWalks(log, hours([mk("Oversized", "02:30pm", 3)]), 2, "d");
  log = noteWalks(log, hours([mk("Ambient", "03:30pm", 40)]), 3, "d");
  const m = walkMixByName(log)["Cooper Arnold"];
  assert.equal(m.walks, 3);
  assert.equal(m.items, 47);
  assert.equal(m.lastSeen, 3);
  assert.equal(mixText(m), "Oversized 2, Ambient 1");
});

// 2026-10-23: Deborah Greene showed "walks seen: Ambient 26" for GIF's 1 walk —
// the card's qty is items LEFT (counts down every reading) and one walk shows
// one card per hour slot it has orders due in.
test("a counting-down card and its other-slot card are one walk", () => {
  let log = null;
  const at = (t, cards) => { log = noteWalks(log, cards, t, "d"); };
  const g = (due, qty) => ({ name: "Deborah Greene", section: "Ambient", qty, due, status: "On time" });
  at(1, [{ slot: "9am - 10am", walks: [g("07:55am", 35)] }]);
  at(2, [{ slot: "8am - 9am", walks: [g("07:30am", 53)] }, { slot: "9am - 10am", walks: [g("07:55am", 35)] }]);
  at(3, [{ slot: "8am - 9am", walks: [g("07:30am", 51)] }, { slot: "9am - 10am", walks: [g("07:55am", 34)] }]);
  at(4, [{ slot: "8am - 9am", walks: [g("07:30am", 20)] }, { slot: "9am - 10am", walks: [g("07:55am", 9)] }]);
  at(5, [{ slot: "8am - 9am", walks: [g("07:30am", 1)] }]);
  const m = walkMixByName(log)["Deborah Greene"];
  assert.equal(m.walks, 1);
  assert.equal(m.items, 88);
  assert.equal(mixText(m), "Ambient 1");
});

test("the same card key counting up again is a new walk; non-overlapping walks stay apart", () => {
  let log = null;
  const at = (t, qty, section = "Cold Chain") => { log = noteWalks(log, [{ slot: "10am - 11am", walks: [{ name: "A B", section, qty, due: "09:30am" }] }], t, "d"); };
  at(1, 14); at(2, 9); at(3, 2);      // walk 1
  at(4, 31); at(5, 20); at(6, 1);     // walk 2, same slot + due
  at(7, 5, "Ambient");                // walk 3
  const m = walkMixByName(log)["A B"];
  assert.equal(m.walks, 3);
  assert.equal(m.items, 50);
  assert.equal(mixText(m), "Cold Chain 2, Ambient 1");
});
