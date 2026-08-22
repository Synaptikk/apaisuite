// modules/digitallocks/lib/tests/risk_calibration.test.mjs
//
// Pins the base-rate + per-associate calibration added 2026-08-22.
//
// The scenario every test here is built from is the real one that motivated
// the change: store 1458's 500-event export is entirely one high-risk zone
// (72-ELECTRONICS DESK-TIER 2), worked by the Entertainment associates whose
// job that case is. Under absolute scoring every row scored >= 20 for
// "high-risk zone/lock" alone and the entire store landed in the review queue.

import test from "node:test";
import assert from "node:assert/strict";

import { scoreEvents } from "../riskScoring.js";

const RULES = {
  weights: {
    AFTERHOURS_DEEP: 50, AFTERHOURS_EDGE: 35, AFTERHOURS_EDGE_EXPECTED: 10,
    AFTERHOURS_EDGE_HABITUAL: 0,
    ROLE_MISMATCH: 25, HIGH_RISK_ZONE: 20, HIGH_VOLUME: 15,
    MULTI_ZONE_WINDOW: 15, REPEATED_SAME_LOCK: 10, UNUSUAL_SOURCE: 10,
    DAY_HOUR_SPIKE: 10,
  },
  bands: [
    { min: 0, label: "Normal" }, { min: 25, label: "Watch" },
    { min: 50, label: "High" }, { min: 75, label: "Critical" },
  ],
  timeWindows: {
    deepAfterHours: { fromHour: 0, toHour: 5 },
    edgeAfterHours: [{ fromHour: 23, toHour: 24 }, { fromHour: 5, toHour: 7 }],
  },
  thresholds: {
    volumePercentile: 0.95, volumeAbsoluteFloor: 15,
    multiZoneWindowMinutes: 30, multiZoneCountThreshold: 3,
    repeatedLockWindowMinutes: 5, repeatedLockMinOpens: 3,
    hourSpikeStdDevs: 2,
  },
  calibration: {
    enabled: true,
    baseRate: { suppressAbove: 0.60, zeroAt: 0.90, minEvents: 50 },
    pinnedRules: { rules: ["AFTERHOURS_DEEP"] },
    userBaseline: {
      minDaysForBaseline: 3, minEventsForBaseline: 8,
      volumeMultiple: 1.75, shiftPadHours: 1,
    },
    observedRolePairing: { minEvents: 20, minUsers: 2 },
  },
  highRiskKeywords: ["electronics", "cage", "drawer"],
  roleZone: {
    broadAccessPositions: ["asset protection", "operations coach"],
    expectedEdgeHourPositions: ["overnight", "stocking"],
    roleZoneMap: [
      { position: "entertainment ta", allowedZoneKeywords: ["electronics"] },
      { position: "hardlines ta",     allowedZoneKeywords: ["hardlines"] },
      { position: "seasonal ta",      allowedZoneKeywords: ["seasonal"] },
    ],
  },
};

const ZONE = "72-ELECTRONICS DESK-TIER 2";

let seq = 0;
function ev({ user, position, hour, date = "2026-08-18", lock = "Cage1", zone = ZONE }) {
  const h = String(hour).padStart(2, "0");
  return {
    id: `e${seq++}`, userId: user, fullName: user, position,
    zoneName: zone, lockName: lock, unlockSource: "MyWalmart",
    eventTime: `${date}T${h}:30:00`, eventHour: hour, eventDate: date,
  };
}

// A week of the store's ordinary traffic: the Entertainment crew working the
// electronics case through normal daytime hours.
function ordinaryStore() {
  const out = [];
  const days = ["2026-08-14", "2026-08-15", "2026-08-16", "2026-08-17",
                "2026-08-18", "2026-08-19", "2026-08-20"];
  const crew = [
    ["ahbeatt", "Entertainment TL"],
    ["cmc00kl", "Entertainment TA"],
    ["q0v004d", "Entertainment TA"],
    ["z0c06wp", "Entertainment TA"],
  ];
  for (const date of days) {
    for (const [user, position] of crew) {
      for (let i = 0; i < 12; i++) {
        // 9am-8pm, one per hour, different locks — nothing unusual at all.
        out.push(ev({ user, position, hour: 9 + i, date, lock: `Drawer ${i + 1}` }));
      }
    }
  }
  return out;   // 7 × 4 × 12 = 336 events
}

const reasonsOf = (e) => (e.riskReasons || []).join(" | ");

test("a rule firing on every event scores nothing and becomes context", () => {
  const events = scoreEvents(ordinaryStore(), RULES);

  // Every event is in the high-risk zone, so the reason is true of all of them.
  assert.equal(events._meta.fireRate.HIGH_RISK_ZONE, 1);
  assert.equal(events._meta.weightScale.HIGH_RISK_ZONE, 0);

  for (const e of events) {
    assert.ok(!reasonsOf(e).includes("high-risk zone"),
      "ubiquitous reason must not be scored");
    assert.ok(e.baselineReasons.includes("high-risk zone/lock"),
      "but it must still be visible as context");
  }
});

test("the ordinary week produces an empty review queue", () => {
  const events = scoreEvents(ordinaryStore(), RULES);
  const flagged = events.filter((e) => e.riskScore > 0);
  assert.equal(flagged.length, 0,
    `expected no findings in a week of normal work, got: ${
      flagged.slice(0, 3).map((e) => `${e.userId} ${e.riskScore} [${reasonsOf(e)}]`).join("; ")}`);
});

test("without calibration the same week flags every single event", () => {
  const events = scoreEvents(ordinaryStore(), { ...RULES, calibration: { enabled: false } });
  assert.equal(events.filter((e) => e.riskScore >= 20).length, events.length);
  // This is the behaviour that put 500/500 events in the queue.
  assert.ok(events.every((e) => e.riskLevel !== "Normal" || e.riskScore >= 20));
});

test("an associate's own early shift is not after-hours for them", () => {
  // Christina stocks electronics freight from 5-6am, every day, all week.
  const base = ordinaryStore();
  for (const date of ["2026-08-14", "2026-08-15", "2026-08-16", "2026-08-17", "2026-08-18"]) {
    base.push(ev({ user: "cmc00kl", position: "Entertainment TA", hour: 6, date, lock: "Cage 5" }));
  }
  const events = scoreEvents(base, RULES);
  const early = events.filter((e) => e.userId === "cmc00kl" && e.eventHour === 6);

  assert.equal(early.length, 5);
  for (const e of early) {
    assert.equal(e.riskScore, 0, `6am should be normal for her: [${reasonsOf(e)}]`);
    assert.ok(reasonsOf(e).includes("their usual hours") || e.riskReasons.length === 0);
  }
});

test("a genuinely new overnight opener still scores full weight", () => {
  const base = ordinaryStore();
  // Same associate, one 3am event — deep after-hours, pinned so it can never
  // be calibrated away, and one event can never establish a pattern.
  base.push(ev({ user: "cmc00kl", position: "Entertainment TA", hour: 3, date: "2026-08-19" }));
  const events = scoreEvents(base, RULES);
  const night = events.find((e) => e.eventHour === 3);

  assert.equal(night.riskScore, 50);
  assert.equal(night.riskLevel, "High");
  assert.ok(reasonsOf(night).includes("after-hours 12am-5am"));
});

test("deep after-hours stays scored even when it is the store's whole pattern", () => {
  // A store where every event is at 2am: base-rate would otherwise zero it.
  const events = [];
  for (let d = 14; d <= 20; d++) {
    for (const user of ["u1", "u2", "u3", "u4"]) {
      for (let i = 0; i < 12; i++) {
        events.push(ev({ user, position: "Entertainment TA", hour: 2,
                         date: `2026-08-${d}`, lock: `Drawer ${i + 1}` }));
      }
    }
  }
  const scored = scoreEvents(events, RULES);
  assert.equal(scored._meta.fireRate.AFTERHOURS_DEEP, 1);
  assert.equal(scored._meta.weightScale.AFTERHOURS_DEEP, 1, "pinned rules ignore fire-rate");
  assert.ok(scored.every((e) => e.riskScore >= 50));
});

test("volume is judged against the associate's own median, not the store's", () => {
  const base = ordinaryStore();
  // Ashley works the case hardest all week (12/day above) — that is her job.
  // One day she opens 30 times. Only that day should surface.
  for (let i = 0; i < 18; i++) {
    base.push(ev({ user: "ahbeatt", position: "Entertainment TL", hour: 10,
                   date: "2026-08-19", lock: `Drawer ${i + 1}` }));
  }
  const events = scoreEvents(base, RULES);

  const spikeDay  = events.filter((e) => e.userId === "ahbeatt" && e.eventDate === "2026-08-19");
  const normalDay = events.filter((e) => e.userId === "ahbeatt" && e.eventDate === "2026-08-18");

  assert.ok(spikeDay.every((e) => reasonsOf(e).includes("high volume for this user")),
    "her outlier day should flag");
  assert.ok(normalDay.every((e) => !reasonsOf(e).includes("high volume")),
    "her ordinary days must not flag just for being the busiest person");
});

test("a role/zone pairing the store actually runs on is not a mismatch", () => {
  const base = ordinaryStore();
  // Hardlines TAs cover the electronics desk constantly: 2 people, 24 events.
  for (const user of ["c0l0r33", "gwmoria"]) {
    for (let i = 0; i < 12; i++) {
      base.push(ev({ user, position: "Hardlines TA", hour: 14,
                     date: `2026-08-1${(i % 5) + 4}`, lock: `Drawer ${i + 1}` }));
    }
  }
  const events = scoreEvents(base, RULES);
  const hardlines = events.filter((e) => e.position === "Hardlines TA");

  assert.equal(hardlines.length, 24);
  assert.ok(hardlines.every((e) => !reasonsOf(e).includes("role/zone mismatch")),
    "an established cross-cover pattern should not read as an exception");
});

test("a rare cross-zone visit still scores as a mismatch", () => {
  const base = ordinaryStore();
  // One Seasonal TA, twice — below the observed-pairing floor.
  base.push(ev({ user: "t0s0mo5", position: "Seasonal TA", hour: 11 }));
  base.push(ev({ user: "t0s0mo5", position: "Seasonal TA", hour: 12 }));
  const events = scoreEvents(base, RULES);
  const seasonal = events.filter((e) => e.position === "Seasonal TA");

  assert.equal(seasonal.length, 2);
  assert.ok(seasonal.every((e) => reasonsOf(e).includes("role/zone mismatch")));
  assert.ok(seasonal.every((e) => e.riskScore >= 25));
});

test("one person repeatedly going somewhere they shouldn't is not normalised", () => {
  const base = ordinaryStore();
  // 30 events, but a SINGLE user — fails the minUsers test on purpose.
  for (let i = 0; i < 30; i++) {
    base.push(ev({ user: "loner1", position: "Seasonal TA", hour: 15,
                   date: `2026-08-1${(i % 5) + 4}`, lock: `Drawer ${(i % 12) + 1}` }));
  }
  const events = scoreEvents(base, RULES);
  const loner = events.filter((e) => e.userId === "loner1");
  assert.ok(loner.every((e) => reasonsOf(e).includes("role/zone mismatch")),
    "volume from one person must not turn a mismatch into a store pattern");
});

test("two opens of the same lock in five minutes is not an event", () => {
  const base = ordinaryStore();
  base.push(ev({ user: "cmc00kl", position: "Entertainment TA", hour: 13, lock: "Drawer 15" }));
  base.push(ev({ user: "cmc00kl", position: "Entertainment TA", hour: 13, lock: "Drawer 15" }));
  const events = scoreEvents(base, RULES);
  const pair = events.filter((e) => e.lockName === "Drawer 15" && e.userId === "cmc00kl");

  assert.ok(pair.length >= 2);
  assert.ok(pair.every((e) => !reasonsOf(e).includes("same lock repeated")),
    "stocking a drawer twice is routine; the floor is 3 opens");
});

test("the store's busiest hour is not itself a finding", () => {
  const events = scoreEvents(ordinaryStore(), RULES);
  assert.ok(events.every((e) => !reasonsOf(e).includes("store hour spike")),
    "an hour that is normal for the person should never score as a spike");
});

test("a small import is never calibrated — too little evidence", () => {
  const few = ordinaryStore().slice(0, 20);
  const events = scoreEvents(few, RULES);
  assert.equal(Object.keys(events._meta.weightScale).length, 0);
  assert.ok(events.every((e) => reasonsOf(e).includes("high-risk zone")),
    "below baseRate.minEvents the absolute rules apply unchanged");
});
