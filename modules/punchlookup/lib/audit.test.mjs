// node --test modules/punchlookup/lib/audit.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyClock, analyzeStore, nameKey, parseShiftStart, auditCsv } from "./audit.js";

// Real data strings from store 1458, 2026-10-06 (GPS trimmed).
const LIVE = "Actiontime=20261006051544&Dst=T&O=N&PN=Allspark&TZNAME=GMT-04:00Y&VL=Y&W=Y&DKT=01458&VA=N&AP=APUS-1458-016&TZ=0";
const APP = "Dst=T&DKT=01458&TZNAME=GMT-04:00Y&PN=Allspark&Actiontime=20261006111347&AP=APUS-1458-224";

test("sources", () => {
  assert.equal(classifyClock(1, "20261006051500", LIVE).source, "device");
  assert.equal(classifyClock(1, "20261006110000", APP).source, "app-set");
  assert.equal(classifyClock(2, "20261006160000", "ClockTag=E&ActionTime=20261007171103").source, "edited");
  assert.equal(classifyClock(2, "20261007000001", "ClockTag=P&ActionTime=20261006225858").source, "system");
  assert.equal(classifyClock(2, "20261006165500", "ActionTime=20261006142354&DKT=01458").source, "entered");
  assert.equal(classifyClock(1, "20261006135500", "DKT=01458&TZ=0").source, "keyed");
  assert.equal(classifyClock(1, "20261006215100", "Dst=T&DKT=01458&TZNAME=GMT-04:00Y&PN=D^&Actiontime=20261006215558&AP=NA").source, "app-set");
});

test("names and shift starts", () => {
  assert.equal(nameKey("STAMPER, DUANE R"), nameKey("Duane Stamper"));
  assert.equal(parseShiftStart("11:00am"), 660);
  assert.equal(parseShiftStart("12:30pm"), 750);
  assert.equal(parseShiftStart("12:15am"), 15);
});

test("late clock-in set back inside grace, on-the-hour counts", () => {
  const c = (t, time, data) => classifyClock(t, time, data);
  const days = [
    { date: "2026-10-06", rows: [
      { name: "STAMPER, DUANE", punches: [c(1, "20261006110000", APP), c(2, "20261006193000", "Dst=T&TZNAME=GMT-04:00Y&PN=Allspark&Actiontime=20261006193300&AP=APUS-1458-016&DKT=01458")] },
      { name: "ABRAHAM, STEYSHAWN", punches: [c(1, "20261006051500", LIVE)] },
      { name: "KEYED, KAY", punches: [c(1, "20261006060000", "DKT=01458&TZ=0")] },
    ] },
  ];
  const starts = { "2026-10-06": { [nameKey("Duane Stamper")]: 660, [nameKey("Steyshawn Abraham")]: 300, [nameKey("Kay Keyed")]: 360 } };
  const r = analyzeStore(days, starts);
  const s = r.people.find((p) => p.name === "STAMPER, DUANE");
  assert.equal(s.lateRescued, 1);
  assert.equal(s.lateRescuedBig, 0);
  assert.equal(s.rescuedMinutes, 14);
  assert.equal(s.insOnHour, 1);
  const a = r.people.find((p) => p.name.startsWith("ABRAHAM"));
  assert.equal(a.lateKept, 1);              // 5:15 vs 5:00 live = a real late
  assert.equal(a.lateRescued, 0);
  assert.equal(r.people.find((p) => p.name.startsWith("KEYED")).insEditedInGrace, 1);
  const ev = r.events.find((e) => e.name === "STAMPER, DUANE" && e.type === 1);
  assert.equal(ev.pressedLate, 13);
  assert.equal(ev.keptLate, 0);
  assert.match(auditCsv(r), /STAMPER, DUANE/);
});

test("early clock-ins are never counted (only lates matter)", () => {
  const c = (t, time, data) => classifyClock(t, time, data);
  const early = "Dst=T&DKT=01458&TZNAME=GMT-04:00Y&PN=Allspark&Actiontime=20261006045500&AP=APUS-1458-224";
  const live = "Actiontime=20261006045512&Dst=T&O=N&PN=Allspark&TZNAME=GMT-04:00Y&VL=Y&W=Y&DKT=01458&VA=N&AP=APUS-1458-016&TZ=0";
  const days = [{ date: "2026-10-06", rows: [
    { name: "EARLY, APP", punches: [c(1, "20261006050000", early)] },   // pressed 4:55, kept 5:00
    { name: "EARLY, LIVE", punches: [c(1, "20261006045500", live)] },   // clocked 4:55 at the clock
    { name: "EARLY, KEYED", punches: [c(1, "20261006045000", "DKT=01458&TZ=0")] },
  ] }];
  const sched = { "2026-10-06": { [nameKey("App Early")]: 300, [nameKey("Live Early")]: 300, [nameKey("Keyed Early")]: 300 } };
  const unsched = analyzeStore(days, {});
  for (const r of [analyzeStore(days, sched), unsched]) {
    for (const p of r.people) {
      if (p.name === "EARLY, KEYED" && r === unsched) continue;   // no schedule, no press time: can't tell
      assert.equal(p.insOnHour, 0, p.name);
      assert.equal(p.insChanged + p.insEditedInGrace + p.lateRescued + p.lateKept, 0, p.name);
    }
    assert.equal(r.events.filter((e) => e.type === 1 && e.name !== "EARLY, KEYED").length, 0);
  }
});
