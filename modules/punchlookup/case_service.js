// modules/punchlookup/case_service.js
//
// Service-worker handlers for shared cases (spread into service.js handlers).
// A case lives in its owner's OneDrive; see lib/cases.js for the files and
// lib/onedrive.js for how they're read (straight from here) and written (in a
// my.wal-mart.com tab). Access is whatever OneDrive sharing allows — the owner
// adds people, everyone else gets OneDrive's 403.

import { whoAmI, displayName, listFiles, listFolders, readJson, resolveCaseLink, caseUrl, odWrite } from "./lib/onedrive.js";
import { schedules } from "../digitalmetrics/lib/firestore.js";
import { caseRoot, caseFolderName, notesFileName, newCaseFile, emptyNotes, caseDay, CASE_FILE } from "./lib/cases.js";

const fail = (e) => ({ ok: false, error: String(e?.message || e) });
const isNotes = (name) => /^notes-.*\.json$/.test(name);
const writeJson = (site, folder, name, obj) => odWrite({ op: "write", site, folder, name, text: JSON.stringify(obj) });
const today = () => new Date().toISOString().slice(0, 10);

let meCache = null;
async function me() { return meCache || (meCache = await whoAmI()); }

async function ownCase(msg) {
  const u = await me();
  const cur = await readJson(msg.site, `${msg.folder}/${CASE_FILE}`);
  return { u, cur, owner: cur.owner?.login === u.login };
}

/** `load` is service.js's GTA range loader, reused by case_refresh_punches. */
export function caseHandlers(load) {
  return {
    async me() {
      try { return { ok: true, me: await me() }; } catch (e) { return fail(e); }
    },

    /** My own cases: folders under my "Punch Lookup Cases". */
    async cases_mine() {
      try {
        const u = await me();
        const folders = await listFolders(u.site, caseRoot(u.site));
        // Each case's associate / case # / days, for the list and for spotting
        // that a looked-up associate already has a case. Small files, read in parallel.
        // A case.json that can't be read keeps its row with the reason
        // (silently dropping it hid a real case in the user's normal Edge).
        const metas = await Promise.all(folders.map((f) => readJson(u.site, `${f.path}/${CASE_FILE}`).catch((e) => ({ readError: String(e?.message || e) }))));
        return { ok: true, site: u.site, cases: folders.map((f, i) => ({ site: u.site, folder: f.path, title: f.name, modified: f.modified, mine: true,
          readError: metas[i]?.readError || null,
          meta: metas[i] && !metas[i].readError ? { person: metas[i].person, caseNo: metas[i].caseNo, days: Object.fromEntries(Object.keys(metas[i].days || {}).map((k) => [k, 1])) } : null }))
          .sort((a, b) => String(b.modified).localeCompare(String(a.modified))) };
      } catch (e) { return fail(e); }
    },

    /** A pasted link → the case, checked readable by me. */
    async resolve_link(msg) {
      try {
        const ref = await resolveCaseLink(msg.text);
        const meta = await readJson(ref.site, `${ref.folder}/${CASE_FILE}`);
        if (meta?.kind !== "punchlookup-case") throw new Error("That folder isn't a Punch Lookup case.");
        return { ok: true, ref: { ...ref, title: ref.folder.split("/").pop() }, meta };
      } catch (e) { return fail(e); }
    },

    /** { person, days, from, to, caseNo, store } → a new case folder in my OneDrive. */
    async case_create(msg) {
      try {
        const u = await me();
        const root = caseRoot(u.site);
        const taken = new Set((await listFolders(u.site, root)).map((f) => f.name.toLowerCase()));
        const base = caseFolderName(msg.person, msg.caseNo, today());
        let name = base, k = 2;
        while (taken.has(name.toLowerCase())) name = `${base} (${k++})`;
        const folder = `${root}/${name}`;
        await odWrite({ op: "ensureFolders", site: u.site, paths: [root, folder] });
        await writeJson(u.site, folder, CASE_FILE, newCaseFile({ ...msg, owner: u }));
        await writeJson(u.site, folder, notesFileName(u), emptyNotes(u));
        // Auto-share with the owner's saved AP team. A failed share keeps the
        // case (it's created); the panel says so and Share… can retry.
        const teamKeys = (msg.teamKeys || []).filter(Boolean);
        let shared = 0, shareError = null;
        if (teamKeys.length) {
          try { await odWrite({ op: "share", site: u.site, folder, keys: teamKeys }); shared = teamKeys.length; }
          catch (e) { shareError = String(e?.message || e); }
        }
        return { ok: true, ref: { site: u.site, folder, title: name, mine: true }, url: caseUrl({ site: u.site, folder }), shared, shareError };
      } catch (e) { return fail(e); }
    },

    /**
     * Everything in a case folder. `known` = { fileName: etag } from the last
     * load; unchanged files come back { same: true }, so the 30-second live
     * poll only downloads what someone actually changed.
     */
    async case_load(msg) {
      try {
        const u = await me();
        const files = await listFiles(msg.site, msg.folder);
        const known = msg.known || {};
        const out = {};
        for (const f of files.filter((x) => x.name === CASE_FILE || isNotes(x.name))) {
          out[f.name] = known[f.name] === f.etag ? { etag: f.etag, same: true }
            : { etag: f.etag, data: await readJson(msg.site, `${msg.folder}/${f.name}`) };
        }
        if (!out[CASE_FILE]) throw new Error("This folder has no case.json: it isn't a Punch Lookup case, or it was emptied.");
        return { ok: true, me: u, myNotesName: notesFileName(u), files: out, url: caseUrl(msg), at: Date.now() };
      } catch (e) { return fail(e); }
    },

    /** Save my notes file — the only file a non-owner ever writes. */
    async case_save_notes(msg) {
      try {
        const u = await me();
        await writeJson(msg.site, msg.folder, notesFileName(u), { ...msg.notes, author: { name: u.name, login: u.login } });
        return { ok: true, at: Date.now() };
      } catch (e) { return fail(e); }
    },

    /** Owner: change the case #. */
    async case_save_meta(msg) {
      try {
        const { cur, owner } = await ownCase(msg);
        if (!owner) return { ok: false, error: "Only the case owner can change the case details." };
        await writeJson(msg.site, msg.folder, CASE_FILE, { ...cur, caseNo: String(msg.caseNo ?? cur.caseNo) });
        return { ok: true };
      } catch (e) { return fail(e); }
    },

    /** Owner (with GTA access): re-pull the range and replace the case's punches. */
    async case_refresh_punches(msg) {
      try {
        const { cur, owner } = await ownCase(msg);
        if (!owner) return { ok: false, error: "Only the case owner refreshes punches." };
        const from = msg.from || cur.from, to = msg.to || cur.to;
        const res = await load({ empId: cur.person.empId, from, to });
        if (!res.ok) return res;
        const days = { ...cur.days };
        for (const d of res.days) {
          if (!d.punches.some((p) => !p.system) && !cur.days[d.date]) continue;
          days[d.date] = caseDay(d);
        }
        await writeJson(msg.site, msg.folder, CASE_FILE, { ...cur, days, from, to, punchesPulledAt: Date.now() });
        return { ok: true };
      } catch (e) { return fail(e); }
    },

    /**
     * The store's AP associates from the last 14 days of WFM schedules (Digital
     * Metrics' import carries job titles), each matched to a OneDrive person:
     * the store login (xxx.s01458@) tells the right one from same-named
     * people elsewhere. → { store, people: [{ name, jobName, key, title }], unmatched: [name] }
     */
    async ap_team_find(msg) {
      try {
        const u = await me();
        const m = /\.s0*(\d{3,5})@/i.exec(u.login || "");
        const store = String(msg.store || m?.[1] || "");
        if (!store) return { ok: false, error: "Couldn't tell your store from your sign-in." };
        const tag = `.s${store.padStart(5, "0")}@`;
        const found = new Map();
        for (let i = 0; i < 14; i++) {
          const d = new Date(Date.now() - i * 86_400_000).toLocaleDateString("en-CA");
          const doc = await schedules.get(store, d).catch(() => null);
          for (const a of doc?.associates || []) {
            if (/^AP\b|asset protection/i.test(a.jobName || "") && !found.has(a.name)) found.set(a.name, a.jobName);
          }
        }
        if (!found.size) return { ok: false, error: `No AP associates on store ${store}'s schedules in the last 14 days.` };
        const title = (s) => String(s).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
        const people = [], unmatched = [];
        for (const [name, jobName] of found) {
          const res = await odWrite({ op: "people", site: u.site, query: title(name) }).catch(() => ({ people: [] }));
          const hit = (res.people || []).find((p) => p.key.toLowerCase().includes(tag));
          if (!hit) { unmatched.push(title(name)); continue; }
          if (hit.key === u.login || hit.key.endsWith(`|${u.login.split("|").pop()}`)) continue;   // that's me
          people.push({ name: displayName(hit.name) || title(name), jobName, key: hit.key, title: hit.title });
        }
        const rank = (j) => /investigator/i.test(j) ? 0 : /lead|coach|manager/i.test(j) ? 1 : 2;
        people.sort((a, b) => rank(a.jobName) - rank(b.jobName) || a.name.localeCompare(b.name));
        return { ok: true, store, people, unmatched };
      } catch (e) { return fail(e); }
    },

    async case_people(msg) {
      try { return { ok: true, ...(await odWrite({ op: "people", site: msg.site, query: msg.query })) }; } catch (e) { return fail(e); }
    },

    async case_share(msg) {
      try {
        const { owner } = await ownCase(msg);
        if (!owner) return { ok: false, error: "Only the case owner can add people." };
        await odWrite({ op: "share", site: msg.site, folder: msg.folder, keys: msg.keys });
        return { ok: true };
      } catch (e) { return fail(e); }
    },

    /** Owner: files then folder to the OneDrive recycle bin (recoverable there). */
    async case_delete(msg) {
      try {
        const { owner } = await ownCase(msg);
        if (!owner) return { ok: false, error: "Only the case owner can delete it." };
        const files = await listFiles(msg.site, msg.folder);
        await odWrite({ op: "recycle", site: msg.site, files: files.map((f) => `${msg.folder}/${f.name}`), folders: [msg.folder] });
        return { ok: true };
      } catch (e) { return fail(e); }
    },
  };
}
