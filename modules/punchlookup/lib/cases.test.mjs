// node --test modules/punchlookup/lib/cases.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { caseFolderName, notesFileName, newCaseFile, emptyNotes, setMyDay, mergeCase, asReviews, casePunch } from "./cases.js";

const ann = { name: "Ann Brown", login: "i:0#.f|membership|abrown@us.example.com" };
const bob = { name: "Bob Cole", login: "i:0#.f|membership|bcole@us.example.com" };
const person = { gtaName: "DOE, JANE M", win: "123456789", empId: 55 };
const P = (kind, time, extra = {}) => ({ kind, time, date: "2026-10-07", label: kind, gps: { lat: 1, lon: 2 }, other: "W=N", ...extra });

test("folder and notes file names are SharePoint-safe and per person", () => {
  assert.equal(caseFolderName(person, "WH:12/3", "2026-10-08"), "DOE JANE - WH 12 3");
  assert.equal(caseFolderName(person, "", "2026-10-08"), "DOE JANE - 2026-10-08");
  assert.equal(notesFileName(ann), "notes-abrown.json");
  assert.notEqual(notesFileName(ann), notesFileName(bob));
});

test("case file keeps punches but not device GPS / raw flags", () => {
  const c = newCaseFile({ person, days: [{ date: "2026-10-07", punches: [P("in", "07:00", { accessPoint: "AP-9", app: "Allspark" })], worked: "8:00" }],
    from: "2026-10-07", to: "2026-10-07", owner: ann, now: 1 });
  const p = c.days["2026-10-07"].punches[0];
  assert.equal(p.accessPoint, "AP-9"); assert.equal(p.time, "07:00");
  assert.equal(p.gps, undefined); assert.equal(p.other, undefined);
  assert.equal(c.person.empId, "55"); assert.equal(c.owner.login, ann.login);
  assert.deepEqual(Object.keys(casePunch(P("out", "15:30"))).sort(), ["accessPoint", "app", "code", "date", "exact", "keyed", "kind", "label", "system", "time"]);
});

test("each investigator's notes merge with authorship; done flags; feed newest first", () => {
  const c = newCaseFile({ person, days: [{ date: "2026-10-07", punches: [P("in", "07:00"), P("out", "15:30")] }, { date: "2026-10-08", punches: [] }],
    from: "2026-10-07", to: "2026-10-08", owner: ann, now: 1 });
  let a = setMyDay(emptyNotes(ann), "2026-10-07", [{ id: "1", start: 435, end: 460, type: "Non-work", text: "on phone", at: 10 }], false, 10);
  let b = setMyDay(emptyNotes(bob), "2026-10-07", [{ id: "2", start: 600, end: 615, type: "Non-work", text: "smoking", at: 20 }], true, 20);
  b = setMyDay(b, "2026-10-08", [], false, 21);   // empty + not done → no entry for that day
  assert.deepEqual(Object.keys(b.days), ["2026-10-07"]);
  const m = mergeCase(c, [a, b], ann);
  const d = m.days[0];
  assert.deepEqual(d.entries.map((e) => [e.text, e.byName, e.byInitials, e.mine]), [["on phone", "Ann Brown", "AB", true], ["smoking", "Bob Cole", "BC", false]]);
  assert.deepEqual(d.doneBy, ["Bob Cole"]);
  assert.deepEqual(m.feed.map((e) => e.text), ["smoking", "on phone"]);
  assert.deepEqual(m.authors.map((x) => [x.name, x.lines]), [["Bob Cole", 1], ["Ann Brown", 1]]);
  const r = asReviews(m);
  assert.equal(r.length, 2); assert.equal(r[0].reviewer, "Ann Brown, Bob Cole"); assert.equal(r[0].person.win, "123456789");
});
