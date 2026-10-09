// modules/punchlookup/case_view.js
//
// A shared case on screen. caseController() keeps the case in memory and in
// step with OneDrive: it loads every file, polls every 30 s (only changed
// files are downloaded), and saves MY notes file 1.5 s after I stop typing.
// openCase() draws the case: days with status and who's on them, the people
// working it, a live feed of the latest lines, and — for the owner — case #,
// sharing, refreshing punches and deleting. A day opens the editor
// (review_view.js::openDay) in the same space.

import { mergeCase, setMyDay, emptyNotes, asReviews, CASE_FILE } from "./lib/cases.js";
import { analyzeDay, fmtTime } from "./lib/review.js";
import { totalsOf, words } from "./lib/review_export.js";
import { dayLabel } from "./lib/report.js";
import { openDay, openWhReport, downloadWorkbook } from "./review_view.js";

// The owner's AP team ([{ key, name, title }], browser storage): every new
// case is shared with them on creation (case_create teamKeys).
export const AP_TEAM = "apTeam";

const POLL_MS = 30_000, SAVE_MS = 1500, RETRY_MS = 10_000;
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function caseController(host, ref) {
  const { site, folder } = ref;
  const known = {}, files = {};
  const subs = new Set();
  let me = null, myName = null, myNotes = null, url = "";
  let dirty = false, saving = false, saveTimer = null, pollTimer = null;
  let savedAt = null, syncedAt = null, saveErr = null, syncErr = null;
  let merged = null;

  const notify = () => subs.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
  function remerge() {
    const others = Object.entries(files).filter(([n]) => n !== CASE_FILE && n !== myName).map(([, d]) => d);
    merged = mergeCase(files[CASE_FILE], [...others, myNotes], me);
  }

  async function load() {
    const res = await host.messaging.sendRaw("case_load", { site, folder, known }, { timeoutMs: 90_000 })
      .catch((e) => ({ ok: false, error: String(e?.message || e) }));
    if (!res.ok) { syncErr = res.error; notify(); throw new Error(res.error); }
    syncErr = null;
    me = res.me; myName = res.myNotesName; url = res.url;
    for (const [name, f] of Object.entries(res.files)) { known[name] = f.etag; if (!f.same) files[name] = f.data; }
    for (const name of Object.keys(files)) if (!res.files[name]) { delete files[name]; delete known[name]; }
    // My own file from OneDrive only replaces my copy when I have nothing unsaved.
    if (!dirty && !saving) myNotes = files[myName] || myNotes || emptyNotes(me);
    syncedAt = res.at;
    remerge(); notify();
  }

  async function save() {
    clearTimeout(saveTimer); saveTimer = null;
    if (!dirty) return;
    if (saving) { saveTimer = setTimeout(save, SAVE_MS); return; }
    saving = true; dirty = false; notify();
    const res = await host.messaging.sendRaw("case_save_notes", { site, folder, notes: myNotes }, { timeoutMs: 90_000 })
      .catch((e) => ({ ok: false, error: String(e?.message || e) }));
    saving = false;
    if (res.ok) { savedAt = res.at; saveErr = null; }
    else { saveErr = res.error; dirty = true; saveTimer = setTimeout(save, RETRY_MS); }
    notify();
  }

  return {
    ref,
    get state() { return { meta: files[CASE_FILE], merged, me, url, isOwner: !!me && files[CASE_FILE]?.owner?.login === me.login }; },
    load,
    start() { clearInterval(pollTimer); pollTimer = setInterval(() => { if (!saving) load().catch(() => {}); }, POLL_MS); },
    stop() { clearInterval(pollTimer); pollTimer = null; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    day(date) { return merged?.days.find((d) => d.date === date) || { date, punches: [], entries: [], doneBy: [] }; },
    myDay(date) { return myNotes?.days?.[date] || { entries: [], done: false }; },
    setMyDay(date, entries, done) {
      myNotes = setMyDay(myNotes || emptyNotes(me), date, entries, done);
      dirty = true; remerge(); notify();
      clearTimeout(saveTimer); saveTimer = setTimeout(save, SAVE_MS);
    },
    flush: () => save(),
    saveStatus() {
      if (saving) return "Saving…";
      if (saveErr) return `Not saved — retrying (${saveErr})`;
      if (dirty) return "Unsaved changes…";
      if (syncErr) return `Offline: ${syncErr}`;
      return savedAt ? `Saved ${hhmm(savedAt)}` : syncedAt ? `Live · synced ${hhmm(syncedAt)}` : "";
    },
    syncLine() { return syncErr ? `Can't reach OneDrive: ${syncErr}` : syncedAt ? `Live · synced ${hhmm(syncedAt)}` : "Loading…"; },
  };
}

/** Draw the case in `root`. Returns a cleanup function. */
export async function openCase(host, root, ref, onBack) {
  const esc = host.ui.escapeHtml;
  root.innerHTML = `<div class="pc"><div class="pl-status">Opening the case…</div></div>`;
  const ctl = caseController(host, ref);
  try { await ctl.load(); } catch (e) {
    root.innerHTML = `<div class="pc"><button type="button" class="btn btn-sm btn-secondary" data-act="back">← Cases</button>
      <div class="pl-status error">${esc(e.message)}</div></div>`;
    root.querySelector('[data-act="back"]').addEventListener("click", onBack);
    return () => {};
  }
  ctl.start();

  let dayCleanup = null, unsub = null, peopleTimer = null;

  function showCase() {
    dayCleanup?.(); dayCleanup = null;
    const { meta, isOwner } = ctl.state;
    root.innerHTML = `
    <div class="pc">
      <div class="pc-bar">
        <button type="button" class="btn btn-sm btn-secondary" data-act="back">← Cases</button>
        <div class="pc-title"><b>${esc(meta.person.gtaName)}</b> <span>WIN ${esc(meta.person.win || "")}</span></div>
        <span class="pc-live" data-el="live"></span>
      </div>
      <div class="pc-meta">
        <label>Case # ${isOwner ? `<input class="input" data-el="caseno" value="${esc(meta.caseNo || "")}" placeholder="optional">` : `<b>${esc(meta.caseNo || "—")}</b>`}</label>
        <span>Owner <b>${esc(meta.owner?.name || "")}</b></span>
        <span>Punches pulled <b>${esc(new Date(meta.punchesPulledAt).toLocaleString())}</b></span>
        <span class="pl-spacer"></span>
        <button type="button" class="btn btn-sm btn-secondary" data-act="wh">W&amp;H report</button>
        <button type="button" class="btn btn-sm btn-secondary" data-act="xlsx">Excel</button>
        <button type="button" class="btn btn-sm btn-secondary" data-act="link">Copy case link</button>
        ${isOwner ? `<button type="button" class="btn btn-sm btn-primary" data-act="share">Share…</button>
        <button type="button" class="btn btn-sm btn-secondary" data-act="refresh">Refresh punches</button>
        <button type="button" class="btn btn-sm btn-ghost pr-danger" data-act="delete">Delete case</button>` : ""}
      </div>
      <div class="pc-share" data-el="share" hidden>
        <div class="pc-share-row"><input class="input" data-el="who" placeholder="Name of an AP associate at your store…"><span class="pc-muted" title="☆ = share every new case with them automatically.">They get edit access to this case.</span></div>
        <div data-el="people"></div>
        <div class="pc-share-row"><button type="button" class="btn btn-sm btn-secondary" data-el="findap">Find my store's AP team</button></div>
        <div data-el="apfound"></div>
        <div class="pc-share-row" data-el="apteam"></div>
      </div>
      <div class="pc-team" data-el="team"></div>
      <div class="pc-grid">
        <table class="pc-days">
          <thead><tr><th>Day</th><th>Punches</th><th>On clock</th><th>Non-work</th><th>Lines</th><th>Who</th><th>Status</th></tr></thead>
          <tbody data-el="days"></tbody>
        </table>
        <div class="pc-feed"><h3>Latest lines</h3><div data-el="feed"></div></div>
      </div>
    </div>`;
    const $ = (s) => root.querySelector(s);

    function draw() {
      const { merged } = ctl.state;
      $('[data-el="live"]').textContent = ctl.syncLine();
      $('[data-el="team"]').innerHTML = merged.authors.length
        ? `<span>Working this case:</span> ${merged.authors.map((a) => `<b class="pr-chip${a.mine ? " is-me" : ""}">${esc(a.initials)}</b> ${esc(a.name)} <small>${a.lines} lines</small>`).join(" · ")}` : "";
      $('[data-el="days"]').innerHTML = merged.days.map((d) => {
        const t = totalsOf(analyzeDay(d.entries, d.punches || [], d.date));
        const who = [...new Map(d.entries.map((e) => [e.by, e])).values()];
        const status = d.doneBy.length ? `<span class="pc-ok">✓ ${esc(d.doneBy.join(", "))}</span>` : d.entries.length ? `<span class="pc-prog">In progress</span>` : `<span class="pc-none">Not started</span>`;
        const first = (d.punches || []).find((p) => !p.system && p.kind === "in"), last = [...(d.punches || [])].reverse().find((p) => !p.system && p.kind === "out");
        return `<tr data-day="${esc(d.date)}" tabindex="0">
          <td><b>${esc(dayLabel(d.date))}</b></td>
          <td>${first ? esc(first.time) : "—"} → ${last ? esc(last.time) : "—"}</td>
          <td class="num">${esc(words(t.onClock))}</td>
          <td class="num">${t.nonworkOn ? esc(words(t.nonworkOn)) : ""}</td>
          <td class="num">${d.entries.length || ""}</td>
          <td>${who.map((e) => `<b class="pr-chip${e.mine ? " is-me" : ""}" title="${esc(e.byName)}">${esc(e.byInitials)}</b>`).join(" ")}</td>
          <td>${status}</td></tr>`;
      }).join("") || `<tr><td colspan="7" class="pc-muted">No days in this case.</td></tr>`;
      const feed = merged.feed.slice(0, 15);
      $('[data-el="feed"]').innerHTML = feed.length ? feed.map((e) => `<div class="pc-feed-row">
          <b class="pr-chip${e.mine ? " is-me" : ""}" title="${esc(e.byName)}">${esc(e.byInitials)}</b>
          <div><div class="pc-feed-when">${esc(dayLabel(e.date))} · ${esc(fmtTime(e.start))}–${esc(fmtTime(e.end))} · <span class="t-${(e.type || "").toLowerCase().replace(/[^a-z]/g, "")}">${esc(e.type)}</span></div>
          <div>${esc(e.text || "")}</div><div class="pc-muted">${esc(e.byName)} · ${e.at ? esc(new Date(e.at).toLocaleString([], { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" })) : ""}</div></div></div>`).join("")
        : `<div class="pc-muted">Nothing yet. Open a day and type the first line.</div>`;
    }
    unsub?.(); unsub = ctl.subscribe(draw);
    draw();

    $('[data-el="days"]').addEventListener("click", (e) => { const tr = e.target.closest("tr[data-day]"); if (tr) showDay(tr.dataset.day); });
    $('[data-el="days"]').addEventListener("keydown", (e) => { const tr = e.target.closest("tr[data-day]"); if (tr && e.key === "Enter") showDay(tr.dataset.day); });

    const caseNo = $('[data-el="caseno"]');
    caseNo?.addEventListener("change", async () => {
      const res = await host.messaging.sendRaw("case_save_meta", { ...ref, caseNo: caseNo.value.trim() }).catch((e) => ({ ok: false, error: e.message }));
      host.ui.toast(res.ok ? "Case # saved." : res.error, { kind: res.ok ? "ok" : "error" });
      if (res.ok) ctl.load().catch(() => {});
    });

    // Share: search people as you type, add with one click.
    const who = $('[data-el="who"]'), people = $('[data-el="people"]');
    who?.addEventListener("input", () => {
      clearTimeout(peopleTimer);
      const q = who.value.trim();
      if (q.length < 3) { people.innerHTML = ""; return; }
      peopleTimer = setTimeout(async () => {
        people.innerHTML = `<div class="pc-muted">Searching…</div>`;
        const res = await host.messaging.sendRaw("case_people", { site: ref.site, query: q }).catch((e) => ({ ok: false, error: e.message }));
        if (who.value.trim() !== q) return;
        people.innerHTML = !res.ok ? `<div class="pl-status error">${esc(res.error)}</div>`
          : (res.people || []).map((p) => `<div class="pc-person"><div><b>${esc(p.name)}</b> <span class="pc-muted">${esc([p.title, p.department].filter(Boolean).join(" · "))}</span></div>
              <span><button type="button" class="btn btn-sm btn-ghost" data-star="${esc(p.key)}" data-name="${esc(p.name)}" data-title="${esc(p.title)}" title="☆ = share every new case with them automatically.">${team.some((t) => t.key === p.key) ? "★ Team" : "☆ Team"}</button>
              <button type="button" class="btn btn-sm btn-secondary" data-key="${esc(p.key)}" data-name="${esc(p.name)}">Add</button></span></div>`).join("") || `<div class="pc-muted">No one found.</div>`;
      }, 350);
    });
    // AP team: kept in browser storage, drawn under the search.
    let team = [];
    const teamEl = $('[data-el="apteam"]');
    const saveTeam = () => host.storage.local.set(AP_TEAM, team).catch(() => {});
    function drawTeam() {
      if (!teamEl) return;
      teamEl.innerHTML = team.length
        ? `<span>AP team:</span> ${team.map((t) => `<span class="pr-chip">${esc(t.name)} <button type="button" class="btn btn-sm btn-ghost" data-unstar="${esc(t.key)}" title="Remove from AP team">×</button></span>`).join(" ")}
           <button type="button" class="btn btn-sm btn-primary" data-act="shareteam">Share this case with the team</button>`
        : `<span class="pc-muted">No AP team yet: ☆ people above to share every new case with them.</span>`;
    }
    host.storage.local.get(AP_TEAM).then((v) => { team = v || []; drawTeam(); }).catch(() => drawTeam());
    // Find my store's AP team: schedule AP titles → OneDrive people, tick and save.
    const findBtn = $('[data-el="findap"]'), foundEl = $('[data-el="apfound"]');
    let found = [];
    findBtn?.addEventListener("click", async () => {
      findBtn.disabled = true; findBtn.textContent = "Looking up schedules and sign-ins…";
      const res = await host.messaging.sendRaw("ap_team_find", {}, { timeoutMs: 3 * 60_000 }).catch((err) => ({ ok: false, error: err.message }));
      findBtn.disabled = false; findBtn.textContent = "Find my store's AP team";
      if (!res.ok) { foundEl.innerHTML = `<div class="pl-status error">${esc(res.error)}</div>`; return; }
      found = res.people;
      const preset = (p) => team.some((t) => t.key === p.key) || /investigator|team lead/i.test(p.jobName);
      foundEl.innerHTML = `<div class="pc-muted">Store ${esc(res.store)}: ${found.length} AP associates found${res.unmatched.length ? ` · no sign-in match for ${esc(res.unmatched.join(", "))}` : ""}</div>`
        + found.map((p, i) => `<label class="pc-person"><span><input type="checkbox" data-i="${i}" ${preset(p) ? "checked" : ""}> <b>${esc(p.name)}</b> <span class="pc-muted">${esc(p.jobName)}</span></span></label>`).join("")
        + `<div class="pc-share-row"><button type="button" class="btn btn-sm btn-secondary" data-el="saveteam">Save ticked as my AP team</button>
           <button type="button" class="btn btn-sm btn-primary" data-el="saveshare">Save and share this case with them</button></div>`;
    });
    foundEl?.addEventListener("click", async (e) => {
      const save = e.target.closest('[data-el="saveteam"],[data-el="saveshare"]');
      if (!save) return;
      const picked = [...foundEl.querySelectorAll("input[data-i]:checked")].map((c) => found[+c.dataset.i]);
      if (!picked.length) { host.ui.toast("Tick at least one person.", { kind: "error" }); return; }
      team = picked.map((p) => ({ key: p.key, name: p.name, title: p.jobName }));
      saveTeam(); drawTeam();
      if (save.dataset.el === "saveteam") { host.ui.toast(`AP team saved (${team.length}). New cases are shared with them automatically.`, { kind: "ok" }); return; }
      save.disabled = true; save.textContent = "Sharing…";
      const res = await host.messaging.sendRaw("case_share", { ...ref, keys: team.map((t) => t.key) }, { timeoutMs: 90_000 }).catch((err) => ({ ok: false, error: err.message }));
      save.disabled = false; save.textContent = "Save and share this case with them";
      host.ui.toast(res.ok ? `AP team saved and this case shared with ${team.map((t) => t.name).join(", ")}.` : res.error, { kind: res.ok ? "ok" : "error" });
    });
    teamEl?.addEventListener("click", async (e) => {
      const x = e.target.closest("[data-unstar]");
      if (x) { team = team.filter((t) => t.key !== x.dataset.unstar); saveTeam(); drawTeam(); return; }
      const b = e.target.closest('[data-act="shareteam"]');
      if (!b) return;
      e.stopPropagation();
      b.disabled = true; b.textContent = "Sharing…";
      const res = await host.messaging.sendRaw("case_share", { ...ref, keys: team.map((t) => t.key) }, { timeoutMs: 90_000 }).catch((err) => ({ ok: false, error: err.message }));
      b.disabled = false; b.textContent = "Share this case with the team";
      host.ui.toast(res.ok ? `Shared with ${team.map((t) => t.name).join(", ")}.` : res.error, { kind: res.ok ? "ok" : "error" });
    });
    people?.addEventListener("click", async (e) => {
      const st = e.target.closest("[data-star]");
      if (st) {
        const k = st.dataset.star;
        team = team.some((t) => t.key === k) ? team.filter((t) => t.key !== k) : [...team, { key: k, name: st.dataset.name, title: st.dataset.title }];
        st.textContent = team.some((t) => t.key === k) ? "★ Team" : "☆ Team";
        saveTeam(); drawTeam(); return;
      }
      const b = e.target.closest("[data-key]");
      if (!b) return;
      b.disabled = true; b.textContent = "Adding…";
      const res = await host.messaging.sendRaw("case_share", { ...ref, keys: [b.dataset.key] }, { timeoutMs: 90_000 }).catch((err) => ({ ok: false, error: err.message }));
      b.textContent = res.ok ? "Added ✓" : "Add";
      b.disabled = !!res.ok;
      host.ui.toast(res.ok ? `${b.dataset.name} can open the case now. Send them the case link (Copy case link).` : res.error, { kind: res.ok ? "ok" : "error" });
    });

    root.querySelector(".pc").addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-act]");
      const act = btn?.dataset.act;
      if (!act) return;
      if (act === "back") { await ctl.flush(); onBack(); }
      else if (act === "wh") openWhReport(asReviews(ctl.state.merged));
      else if (act === "xlsx") downloadWorkbook(asReviews(ctl.state.merged));
      else if (act === "link") {
        await navigator.clipboard.writeText(ctl.state.url).catch(() => {});
        host.ui.toast("Case link copied.", { kind: "ok" });
      } else if (act === "share") { const p = $('[data-el="share"]'); p.hidden = !p.hidden; if (!p.hidden) who.focus(); }
      else if (act === "refresh") {
        btn.disabled = true; btn.textContent = "Refreshing…";
        const res = await host.messaging.sendRaw("case_refresh_punches", ref, { timeoutMs: 4 * 60_000 }).catch((err) => ({ ok: false, error: err.message }));
        btn.disabled = false; btn.textContent = "Refresh punches";
        host.ui.toast(res.ok ? "Punches refreshed." : res.error, { kind: res.ok ? "ok" : "error" });
        if (res.ok) await ctl.load().catch(() => {});
        if (res.ok) showCase();
      } else if (act === "delete") {
        // Two clicks, no dialog: a modal blocks the shell.
        if (btn.dataset.armed !== "1") { btn.dataset.armed = "1"; btn.textContent = "Click again to delete for everyone"; setTimeout(() => { btn.dataset.armed = ""; btn.textContent = "Delete case"; }, 4000); return; }
        const res = await host.messaging.sendRaw("case_delete", ref, { timeoutMs: 90_000 }).catch((err) => ({ ok: false, error: err.message }));
        if (!res.ok) { host.ui.toast(res.error, { kind: "error" }); return; }
        host.ui.toast("Case moved to your OneDrive recycle bin.", { kind: "ok" });
        ctl.stop(); onBack({ deleted: true });
      }
    });
  }

  function showDay(date) {
    unsub?.(); unsub = null;
    dayCleanup = openDay(host, root, ctl, date, showCase);
  }

  showCase();
  return () => { unsub?.(); dayCleanup?.(); ctl.flush(); ctl.stop(); clearTimeout(peopleTimer); };
}
