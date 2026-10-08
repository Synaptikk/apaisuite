import test from 'node:test';
import assert from 'node:assert/strict';
import { nameKeys, clockToMin, workedIntervals, buildDay, scheduleMatches, offeredTo, rollupPeople, analyzeOncall, teamForJob } from './oncall.js';
import { decodeClocks } from './gta_store.js';
import { parseCamList } from './camteams.js';
import { COL } from './aggregate.js';

test('names line up across SafeIQ, schedule and GTA spellings', () => {
  const k = (s) => new Set(nameKeys(s));
  assert.ok(k('PRICE, DANA J').has('DANA|PRICE'));
  assert.ok(k('DANA PRICE').has('DANA|PRICE'));
  assert.ok(k('GARCIA RAMOS, LUIS').has('LUIS|GARCIA RAMOS'));
  assert.ok(k('LUIS GARCIA RAMOS').has('LUIS|GARCIA RAMOS'));
  assert.equal(clockToMin('12:30pm'), 750);
  assert.equal(clockToMin('12:05am'), 5);
});

test('meal switches split the worked time; an open shift runs to now', () => {
  const p = [{ kind: 'in', min: 420 }, { kind: 'switch', min: 720, code: 'MEAL' }, { kind: 'switch', min: 780, code: 'WRK' }, { kind: 'out', min: 960 }];
  assert.deepEqual(workedIntervals(p), [[420, 720], [780, 960]]);
  assert.deepEqual(workedIntervals([{ kind: 'in', min: 600 }], 700), [[600, 700]]);
  assert.deepEqual(workedIntervals([{ kind: 'in', min: 600 }]), []);
});

test('GTA clocks decode to minutes of the work day, past midnight beyond 1440', () => {
  const d = decodeClocks([[1, '20260930215800', ''], [2, '20261001003000', '']], '2026-09-30');
  assert.deepEqual(d.map((x) => [x.kind, x.min]), [['in', 1318], ['out', 1470]]);
});

const sched = [
  { name: 'ANA LOPEZ', jobName: 'Seasonal TA', shiftStart: '7:00am', shiftEnd: '4:00pm' },
  { name: 'BEN COLE', jobName: 'Seasonal TA', shiftStart: '1:00pm', shiftEnd: '10:00pm' },
  { name: 'CARL DIAZ', jobName: 'Front End TL', shiftStart: '6:00am', shiftEnd: '3:00pm' },
  { name: 'DEB FOX', jobName: 'GM Coach', shiftStart: '8:00am', shiftEnd: '5:00pm' },   // salaried: never punches
];
const punches = [
  { gtaName: 'LOPEZ, ANA M', punches: [{ kind: 'in', min: 420 }, { kind: 'switch', min: 600, code: 'MEAL' }, { kind: 'switch', min: 630, code: 'WRK' }, { kind: 'out', min: 960 }] },
  { gtaName: 'COLE, BEN', punches: [{ kind: 'in', min: 780 }, { kind: 'out', min: 1320 }] },
  { gtaName: 'DIAZ, CARL', punches: [{ kind: 'in', min: 360 }, { kind: 'out', min: 900 }] },
];
// ts, camera, dept, reason, assoc, ack, action, type, ttc, date, aisle, ops, id, hold
const row = (hhmm, assoc, ack, action = 'ACCEPTED') => [`2026-09-30 ${hhmm}`, 'SAL_TOYS', 'Toys', 'no_hazard_found', assoc, ack, action, 'object', null, '2026-09-30', '', true, '', null];

test('wave 1 = clocked-in team members; a pass needs the alert to cross 3 minutes', () => {
  const days = { '2026-09-30': buildDay({ schedule: sched, punches }) };
  const cam = { SAL_TOYS: 'Seasonal' };
  const alerts = [
    row('09:00', 'ANA LOPEZ', 1.2),     // Ana alone on the clock, takes it
    row('10:10', 'CARL DIAZ', 6.5),     // Ana on meal → nobody in wave 1; escalates
    row('14:00', 'DEB FOX', 9),         // Ana + Ben on the clock, both let it pass
    row('14:30', '', null, 'NO ACTION'),
  ];
  const offers = offeredTo(alerts, cam, days, COL);
  assert.deepEqual(offers.map((o) => o.wave1.map((w) => w.name).sort()), [['ANA LOPEZ'], [], ['ANA LOPEZ', 'BEN COLE'], ['ANA LOPEZ', 'BEN COLE']]);
  assert.deepEqual(offers.map((o) => o.outcome), ['taken', 'escalated', 'escalated', 'unanswered']);
  // Wave 2: Carl by punches, Deb by schedule (she never punches).
  assert.deepEqual(offers[2].wave2.map((w) => [w.name, w.how]).sort(), [['CARL DIAZ', 'clock'], ['DEB FOX', 'sched']]);
  const by = Object.fromEntries(rollupPeople(offers).map((p) => [p.name, p]));
  assert.deepEqual([by['ANA LOPEZ'].offered, by['ANA LOPEZ'].took, by['ANA LOPEZ'].others, by['ANA LOPEZ'].passed], [3, 1, 0, 2]);
  for (const p of Object.values(by)) assert.equal(p.offered, p.took + p.others + p.passed);
  assert.deepEqual([by['BEN COLE'].offered, by['BEN COLE'].passed], [2, 2]);
  assert.equal(by['CARL DIAZ'].escTook, 1);
  assert.equal(by['DEB FOX'].escTook, 1);
  assert.equal(by['CARL DIAZ'].escPassed, 1);   // the never-answered one, on shift at 14:33
});

test("a schedule that is another store's roster is ignored, titles come from other days", () => {
  const wrong = [{ name: 'ZED QUILL', jobName: 'Seasonal TA', shiftStart: '7:00am', shiftEnd: '4:00pm' }];
  assert.equal(scheduleMatches(wrong, punches), false);
  assert.equal(scheduleMatches(sched, punches), true);
  const cache = {
    camTeam: parseCamList({ value: [{ Camera_x0020_NAME: 'SAL_TOYS', Supercenter_x0020_Team: 'Seasonal', InScope: 'Yes' }] }),
    days: {
      '2026-09-29': { sched: sched.map((s) => [s.name, s.jobName, s.shiftStart, s.shiftEnd]), punch: punches.map((p) => [p.gtaName, p.punches.map((x) => [x.kind, x.min, x.code || ''])]) },
      '2026-09-30': { sched: wrong.map((s) => [s.name, s.jobName, s.shiftStart, s.shiftEnd]), punch: punches.map((p) => [p.gtaName, p.punches.map((x) => [x.kind, x.min, x.code || ''])]) },
    },
  };
  const a = analyzeOncall([row('14:00', 'CARL DIAZ', 9)], cache, COL);
  assert.deepEqual(a.schedFallbackDays, ['2026-09-30']);
  assert.deepEqual(a.offers[0].wave1.map((w) => w.name).sort(), ['ANA LOPEZ', 'BEN COLE']);
  assert.equal(a.takenBy.leader, 1);
});

test('team mapping keeps leads out of wave 1', () => {
  assert.equal(teamForJob('Seasonal TA'), 'Seasonal');
  assert.equal(teamForJob('Seasonal TL'), null);
  assert.equal(teamForJob('Front End Checkout TA'), 'Front End');
  assert.equal(teamForJob('Auto Care Ctr Serv Tech'), 'Auto Care Center');
  assert.equal(teamForJob('Digital Personal Shopper'), null);
});

test('a TA promoted to TL counts as team before the promotion and as a lead after', () => {
  const at = (iso, hhmm, assoc, ack) => { const r = row(hhmm, assoc, ack); r[0] = `${iso} ${hhmm}`; r[9] = iso; return r; };
  const day = (benJob) => ({ sched: sched.map((s) => [s.name, s.name === 'BEN COLE' ? benJob : s.jobName, s.shiftStart, s.shiftEnd]), punch: punches.map((p) => [p.gtaName, p.punches.map((x) => [x.kind, x.min, x.code || ''])]) });
  const cache = {
    camTeam: parseCamList({ value: [{ Camera_x0020_NAME: 'SAL_TOYS', Supercenter_x0020_Team: 'Seasonal', InScope: 'Yes' }] }),
    days: { '2026-09-29': day('Seasonal TA'), '2026-09-30': day('Seasonal TL') },
  };
  const a = analyzeOncall([at('2026-09-29', '14:00', 'BEN COLE', 1), at('2026-09-30', '14:00', 'BEN COLE', 1)], cache, COL);
  assert.equal(a.takenBy.team, 1);
  assert.equal(a.takenBy.leader, 1);
  const ben = a.people.find((p) => p.name === 'BEN COLE');
  assert.equal(ben.offered, 1);
  assert.equal(ben.nowJob, 'Seasonal TL');
  assert.equal(ben.nowSince, '2026-09-30');
});
