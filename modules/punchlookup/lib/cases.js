// modules/punchlookup/lib/cases.js
//
// Shared case model. A case is a folder in the owner's OneDrive:
//
//   Punch Lookup Cases/<LAST FIRST> - <case# or date>/
//     case.json             written by the owner only: associate, days and
//                           their punches (from GTA), case #, owner, range
//     notes-<user>.json     one per investigator, written only by that person:
//                           { author, days: { iso: { entries: [...], done } } }
//
// One file per writer means two investigators typing at once can never
// overwrite each other; readers merge every notes file. Pure.

export const CASES_DIR = "Punch Lookup Cases";
export const CASE_FILE = "case.json";
export const caseRoot = (site) => `${site}/Documents/${CASES_DIR}`;

// SharePoint refuses " * : < > ? / \ | # % and leading/trailing dots/spaces.
const clean = (s) => String(s || "").replace(/["*:<>?/\\|#%~&{}]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+|\.+$/g, "");

export function caseFolderName(person, caseNo, today) {
  const [last = "", first = ""] = String(person?.gtaName || "ASSOCIATE").split(",").map((x) => x.trim());
  return clean(`${last} ${first.split(" ")[0] || ""} - ${caseNo || today}`).slice(0, 80);
}

export function notesFileName(user) {
  const id = String(user?.login || user?.email || "user").split("|").pop().split("@")[0].toLowerCase().replace(/[^a-z0-9.]+/g, "-");
  return `notes-${id}.json`;
}

/**
 * What a shared case keeps of a punch: when, what kind, and the app / access
 * point it came from. Device GPS and the raw device flags stay out of OneDrive
 * (the lookup screen still shows them to the person with GTA access).
 */
export function casePunch(p) {
  return { kind: p.kind, label: p.label, code: p.code ?? null, system: !!p.system, keyed: !!p.keyed,
    date: p.date, time: p.time, exact: p.exact ?? null, app: p.app ?? null, accessPoint: p.accessPoint ?? null };
}
export const caseDay = (d) => ({ punches: (d.punches || []).map(casePunch), scheduled: d.scheduled || null, worked: d.worked || null });

export function newCaseFile({ person, days, from, to, caseNo, owner, store, now = Date.now() }) {
  return {
    v: 1, kind: "punchlookup-case", caseNo: caseNo || "", store: store || "",
    person: { gtaName: person.gtaName, win: person.win, empId: String(person.empId) },
    owner: { name: owner.name, login: owner.login },
    from, to, createdAt: now, punchesPulledAt: now,
    days: Object.fromEntries(days.map((d) => [d.date, caseDay(d)])),
  };
}

export function emptyNotes(user) {
  return { v: 1, kind: "punchlookup-notes", author: { name: user.name, login: user.login }, updatedAt: 0, days: {} };
}

/** Put my entries for a day into my notes file (returns a new object). */
export function setMyDay(notes, date, entries, done, now = Date.now()) {
  const days = { ...notes.days };
  const clean = entries.map((e) => ({ id: e.id, start: e.start, end: e.end, type: e.type, text: e.text || "", source: e.source || "", at: e.at || now }));
  if (clean.length || done) days[date] = { entries: clean, done: !!done };
  else delete days[date];
  return { ...notes, days, updatedAt: now };
}

// "Ann Brown" → "AB": only letter-led words count, so a trailing " - abr001a.s01458" id doesn't.
const shortName = (name) => String(name || "").replace(/\s+-\s+[\w.]+$/, "").trim();
const initials = (name) => shortName(name).split(/\s+/).filter((w) => /^[A-Za-z]/.test(w))
  .map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";

/**
 * case.json + every notes file → what the screens show.
 * Returns { meta, days: [{ date, punches, scheduled, worked, entries, doneBy }],
 *           authors: [{ login, name, initials, lines, updatedAt }], feed }
 * Each merged entry carries { by, byName, byInitials }.
 */
export function mergeCase(caseFile, notesFiles, me = null) {
  const authors = [];
  const byDay = new Map();
  for (const n of notesFiles || []) {
    if (!n?.author) continue;
    const a = { login: n.author.login, name: shortName(n.author.name), initials: initials(n.author.name), lines: 0, updatedAt: n.updatedAt || 0, mine: !!me && n.author.login === me.login };
    authors.push(a);
    for (const [date, d] of Object.entries(n.days || {})) {
      const slot = byDay.get(date) || { entries: [], doneBy: [] };
      for (const e of d.entries || []) { slot.entries.push({ ...e, by: a.login, byName: a.name, byInitials: a.initials, mine: a.mine }); a.lines++; }
      if (d.done) slot.doneBy.push(a.name);
      byDay.set(date, slot);
    }
  }
  const dates = Object.keys(caseFile?.days || {}).sort();
  const days = dates.map((date) => ({
    date, ...caseFile.days[date],
    entries: byDay.get(date)?.entries || [],
    doneBy: byDay.get(date)?.doneBy || [],
  }));
  const feed = days.flatMap((d) => d.entries.map((e) => ({ ...e, date: d.date })))
    .sort((x, y) => (y.at || 0) - (x.at || 0));
  return { meta: caseFile, days, authors: authors.sort((x, y) => y.updatedAt - x.updatedAt), feed };
}

/** Days → the { date, punches, entries, person } reviews the report/export code takes. */
export function asReviews(merged) {
  const m = merged.meta;
  return merged.days.map((d) => ({
    empId: m.person.empId, person: m.person, date: d.date, punches: d.punches || [],
    entries: d.entries, caseNo: m.caseNo, reviewer: [...new Set(d.entries.map((e) => e.byName))].join(", "),
  }));
}
