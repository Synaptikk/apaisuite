import test from "node:test";
import assert from "node:assert/strict";
import { responseBreakdown, leadArea, skipKeys } from "./response.js";
import { compactActions } from "./sql.js";
import { COL } from "./aggregate.js";

const row = (ts, camera, id) => {
  const r = []; r[COL.ts] = ts; r[COL.camera] = camera; r[COL.date] = ts.slice(0, 10); r[COL.id] = id; return r;
};
const day = (sched, punch) => ({ at: 0, sched, punch });
const shift = (name) => [name, [["in", 480, ""], ["out", 1020, ""]]];   // in 08:00, out 17:00

const oncall = {
  camTeam: { "CAM_FASH": { team: "Fashion" }, "CAM_FE": { team: "Front End" } },
  days: {
    "2026-10-05": day(
      [["ANNA ALPHA", "Fashion TA", "08:00", "17:00"], ["BEN BRAVO", "Fashion TA", "08:00", "17:00"],
       ["CARA COACH", "GM Coach", "08:00", "17:00"], ["DAN DELTA", "Fashion TL", "08:00", "17:00"],
       ["EVE ECHO", "Front End TL", "08:00", "17:00"]],
      [shift("ALPHA, ANNA"), shift("BRAVO, BEN"), shift("COACH, CARA"), shift("DELTA, DAN"), shift("ECHO, EVE")]),
  },
};
const log = (id, rows) => rows.map(([ts, action_type, associate_name = null]) =>
  ({ hzd_id: id, hzd_dt_lcl: "2026-10-05", action_ts_lcl: `2026-10-05T${ts}Z`, action_type, associate_name }));

test("own-area alerts only: accepted, declined, ignored; coaches and other-area leads not counted", () => {
  const rows = [row("2026-10-05 10:00", "CAM_FASH", "a1"), row("2026-10-05 11:00", "CAM_FASH", "a2"), row("2026-10-05 12:00", "CAM_FE", "a3")];
  const actions = { byDate: compactActions([
    ...log("a1", [["10:00:00", "CREATE"], ["10:00:05", "DECLINE", "BEN BRAVO"], ["10:00:40", "RESERVE", "ANNA ALPHA"]]),
    ...log("a2", [["11:00:00", "CREATE"], ["11:01:20", "ESCALATE"], ["11:02:30", "RESERVE", "CARA COACH"]]),
    ...log("a3", [["12:00:00", "CREATE"], ["12:00:10", "RESERVE", "EVE ECHO"]]),
  ]) };
  const { people, summary } = responseBreakdown(rows, actions, oncall, COL);
  const p = Object.fromEntries(people.map((x) => [x.name, x]));
  assert.equal(summary.counted, 3);
  // a1 taken at 40 s → nobody else ignored it; a2 sat 2.5 min → ignored by the team + their lead
  assert.deepEqual([p["ANNA ALPHA"].sent, p["ANNA ALPHA"].acc, p["ANNA ALPHA"].ign], [2, 1, 1]);
  assert.deepEqual([p["BEN BRAVO"].dec, p["BEN BRAVO"].ign], [1, 1]);
  assert.deepEqual([p["DAN DELTA"].sent, p["DAN DELTA"].ign, p["DAN DELTA"].lead], [2, 1, true]);
  assert.equal(p["EVE ECHO"].sent, 1);            // Front End lead: only the Front End camera
  assert.equal(p["CARA COACH"], undefined);       // coaches are never counted
});

test("skip list and lead areas", () => {
  assert.equal(leadArea("Food & Consumables TL"), "Food and Consumables");
  assert.equal(leadArea("Stocking 1 TL"), null);
  const rows = [row("2026-10-05 10:00", "CAM_FASH", "a1")];
  const actions = { byDate: compactActions(log("a1", [["10:00:00", "CREATE"], ["10:03:00", "COMPLETE"]])) };
  const { people } = responseBreakdown(rows, actions, oncall, COL, { skip: skipKeys("Dan Delta, Ben Bravo") });
  assert.deepEqual(people.map((x) => x.name).sort(), ["ANNA ALPHA"]);
});

test("a TA promoted to TL mid-range is listed as a lead (newest title)", () => {
  const promo = { camTeam: oncall.camTeam, days: {
    "2026-10-06": day([["BEN BRAVO", "Fashion TL", "08:00", "17:00"]], [shift("BRAVO, BEN")]),
    "2026-10-05": day([["BEN BRAVO", "Fashion TA", "08:00", "17:00"]], [shift("BRAVO, BEN")]),
  } };
  const at = (d, id) => { const r = row(`${d} 10:00`, "CAM_FASH", id); return r; };
  const lg = (d, id) => [["10:00:00", "CREATE"], ["10:03:00", "COMPLETE"]].map(([ts, action_type]) =>
    ({ hzd_id: id, hzd_dt_lcl: d, action_ts_lcl: `${d}T${ts}Z`, action_type, associate_name: null }));
  const actions = { byDate: compactActions([...lg("2026-10-05", "b1"), ...lg("2026-10-06", "b2")]) };
  for (const rows of [[at("2026-10-05", "b1"), at("2026-10-06", "b2")], [at("2026-10-06", "b2"), at("2026-10-05", "b1")]]) {
    const [ben] = responseBreakdown(rows, actions, promo, COL).people;
    assert.deepEqual([ben.job, ben.lead, ben.since, ben.sent, ben.ign], ["Fashion TL", true, "2026-10-06", 2, 2]);
  }
});
