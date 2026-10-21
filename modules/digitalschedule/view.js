// modules/digitalschedule/view.js
//
// ScheduleRight (module id digitalschedule) — shell page. Load a week (service.js::week/read), draw the
// coverage grid and the roster from that read, keep a queue of shift changes
// (hand edits from the roster, or lib/suggest.js's fit to guidance), preview
// them locally (lib/coverage.js::applyChanges), check them with the scheduler's
// validator, save after an explicit confirm, undo a save from its history entry.
//
// Scope: Workgroup → Team → Role → Jobs, from the scheduler's own job tree
// (read → workgroups). Guidance is summed over the chosen role (or every role of
// the checked jobs); shifts count when their job code is checked.
//
// Week cache: every read is kept (rolling 6 weeks per store, newest weekStart
// wins) and shown straight away on the next open or Load week; Reload pulls the
// scheduler again. Submit and undo always re-pull first, so they never act on a
// saved copy.
//
// Open-to-close areas (lib/areas.js): Electronics / Sporting Goods / Jewelry
// must have somebody on the floor from open to close; gaps are shown per day,
// with the queue, in the Submit confirm, and the fitter never opens one.
//
// Kept in browser storage: the week cache, the queue (per store + week), the
// people rules, the areas, the fitter options, the scope, and the last job tree.

import { DOW, toMin, fmt12, coverage, summarize, hourState, applyChanges, describe, paidHours, IN_HOME_JOB, isMinor, isPeak, PEAK_LABEL, shiftSpan } from "./lib/coverage.js";
import { parseRules, unknownNames } from "./lib/rules.js";
import { fitClean } from "./lib/fitclean.js";
import { mountChat } from "./chat_view.js";
import { getUserHomeStore } from "../../shared/userStore.js";
import { DEFAULT_AREAS, GAP_LABEL, areaGaps, areaDelta, isSetUp, normalizeAreas, staggerLunches } from "./lib/areas.js";
import { chartSvg, hourTip, movesFromQueue, tally, offBy, totals, dayLabel, f2 } from "./lib/graph.js";

const LONG = { timeoutMs: 330_000 };
const CACHE_WEEKS = 6;
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// The fitter leaves today and earlier alone: those shifts are worked or under way.
const tomorrow = () => { const d = new Date(); d.setDate(d.getDate() + 1); return isoDay(d); };

export async function mount(host, container) {
  const esc = host.ui.escapeHtml;
  const link = document.createElement("link");
  link.rel = "stylesheet"; link.href = host.url("styles.css"); link.dataset.module = host.id;
  const cssReady = new Promise((resolve) => { link.addEventListener("load", resolve, { once: true }); link.addEventListener("error", resolve, { once: true }); setTimeout(resolve, 3000); });
  document.head.appendChild(link);
  await cssReady;
  container.innerHTML = await fetch(host.url("view.html")).then((r) => r.text());

  const $ = (id) => container.querySelector("#digitalschedule-" + id);
  const els = {
    where: $("where"), bar: $("bar"), wk: $("wk"), go: $("go"), reload: $("reload"), show: $("show"),
    wg: $("wg"), team: $("team"), role: $("role"), jobpick: $("jobpick"), jobsum: $("jobsum"), joblist: $("joblist"), scopeSum: $("scope-sum"), fitScope: $("fit-scope"),
    saved: $("saved"), stagger: $("stagger"), staggerOut: $("stagger-out"), areasTable: $("areas"), areasEdit: $("areas-edit"), areasState: $("areas-state"), areasPreview: $("areas-preview"), areaAdd: $("area-add"), areaReset: $("area-reset"),
    byRole: $("byrole"), msg: $("msg"), main: $("main"), days: $("days"), totals: $("totals"),
    addN: $("add-n"), addWkend: $("add-wkend"), addPeak: $("add-peak"), qsum: $("qsum"), changedOnly: $("changed"), cov: $("cov"), preview: $("preview"),
    qcount: $("qcount"), queue: $("queue"), check: $("check"), validate: $("validate"), save: $("save"), revert: $("revert"), submitState: $("submit-state"), exportBtn: $("export"), clear: $("clear"),
    floor: $("floor"), bonus: $("bonus"), daymoves: $("daymoves"), extend: $("extend"), rules: $("rules"), rulesState: $("rules-state"), rulesShared: $("rules-shared"),
    suggest: $("suggest"), suggestOut: $("suggest-out"), notes: $("notes"), history: $("history"),
    filter: $("filter"), all: $("all"), editor: $("editor"), roster: $("roster"),
    wkBefore: $("wk-before"), wkAfter: $("wk-after"), tip: $("tip"),
    chBefore: $("ch-before"), chAfter: $("ch-after"), tBefore: $("t-before"), tAfter: $("t-after"), mBefore: $("m-before"), mAfter: $("m-after"),
    dlg: $("confirm"), dlgWhat: $("confirm-what"), dlgList: $("confirm-list"), dlgWarnWrap: $("confirm-warn-wrap"), dlgWarn: $("confirm-warn"), dlgGo: $("confirm-go"),
  };

  let alive = true;
  let data = null;          // last read
  let queue = [];           // changes (lib/page.js format)
  let check = null;         // { sig, result } of the last validate
  let history = [];
  let busy = false;
  let gSel = null;          // selected day in the guidance graph
  let gDays = null;

  // ── persisted prefs ───────────────────────────────────────────────────────
  const prefs = (await host.storage.local.get("prefs").catch(() => null)) || {};
  // ── scope: workgroup → team → role → jobs ─────────────────────────────────
  // scope = { wg, team, role } ids ("" = all) + jobs (codes, null = every job in scope).
  // Old prefs held one roleId; its team is located once the tree is known.
  const DPS_ROLE = 1000271;
  let scope = prefs.scope || { wg: "", team: "", role: String(prefs.roleId || DPS_ROLE), jobs: null, locate: true };
  let cachedTree = (await host.storage.local.get("tree").catch(() => null)) || null;
  const tree = () => data?.workgroups || cachedTree?.workgroups || [];
  const roleInfo = () => new Map((data?.roles || cachedTree?.roles || []).map((r) => [String(r.id), r]));
  const roleName = (id) => roleInfo().get(String(id))?.name || `Role ${id}`;
  const wgSel = () => tree().find((g) => String(g.id) === scope.wg) || null;
  const teamSel = () => wgSel()?.teams.find((t) => String(t.id) === scope.team) || null;
  // every job in the chosen workgroup / team, tagged with its team
  const scopeJobs = () => {
    const groups = scope.wg ? [wgSel()].filter(Boolean) : tree();
    return groups.flatMap((g) => g.teams.filter((t) => !scope.team || String(t.id) === scope.team)
      .flatMap((t) => t.jobs.map((j) => ({ ...j, team: t.name, wg: g.name }))));
  };
  const rolesInScope = () => [...new Set(scopeJobs().flatMap((j) => j.roles.map(String)))].sort((x, y) => roleName(x).localeCompare(roleName(y)));
  const jobsAvailable = () => scopeJobs().filter((j) => !scope.role || j.roles.map(String).includes(scope.role));
  const jobs = () => { const av = jobsAvailable().map((j) => j.code); return scope.jobs ? av.filter((c) => scope.jobs.includes(c)) : av; };
  const roleIds = () => scope.role ? [+scope.role]
    : [...new Set(jobsAvailable().filter((j) => jobs().includes(j.code)).flatMap((j) => j.roles))];
  const roleId = roleIds;   // the fitter and the assistant take one id or an array
  // role → the checked job codes that count toward it (each role is fitted to its own guidance)
  const roleJobs = () => { const on = new Set(jobs()), out = {};
    for (const j of jobsAvailable()) if (on.has(j.code)) for (const r of j.roles) (out[r] ??= []).includes(j.code) || out[r].push(j.code);
    return out; };
  // roles that actually have a guidance line this week (all of them before a read)
  const guidedIds = () => { const info = roleInfo(); return roleIds().filter((id) => !data || info.get(String(id))?.guided); };
  const jobDesc = (code) => { for (const g of tree()) for (const t of g.teams) { const j = t.jobs.find((x) => x.code === code); if (j) return j.desc; } return code; };
  const scopeLabel = () => [wgSel()?.name || "Whole store", teamSel()?.name, scope.role ? roleName(scope.role) : null].filter(Boolean).join(" › ")
    + (scope.role ? "" : ` (${guidedIds().length} role${guidedIds().length === 1 ? "" : "s"} with guidance)`);

  // An old single-role pref: put it under the workgroup + team that hold that role's jobs.
  function locateRole() {
    if (!scope.locate || !tree().length) return;
    for (const g of tree()) for (const t of g.teams) if (t.jobs.some((j) => j.roles.map(String).includes(scope.role))) {
      scope = { ...scope, wg: String(g.id), team: String(t.id) }; delete scope.locate; return;
    }
    delete scope.locate;
  }

  function fillScope() {
    locateRole();
    const opts = (list, all) => `<option value="">${esc(all)}</option>` + list.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join("");
    const t = tree();
    if (scope.wg && !wgSel()) scope.wg = "";
    if (scope.team && !teamSel()) scope.team = "";
    els.wg.innerHTML = opts(t.map((g) => [String(g.id), g.name]), t.length ? "Whole store" : "Load a week to list teams");
    els.wg.value = scope.wg;
    const teams = (scope.wg ? wgSel().teams : t.flatMap((g) => g.teams)).filter((x) => x.jobs.length);
    els.team.innerHTML = opts(teams.map((x) => [String(x.id), x.name]), "All teams");
    els.team.value = scope.team; els.team.disabled = !t.length;
    const info = roleInfo(), rs = rolesInScope();
    if (scope.role && t.length && !rs.includes(scope.role)) scope.role = "";
    // roles with guidance this week first, the rest under their own heading
    const off = data ? rs.filter((id) => !info.get(id)?.guided) : [], on = rs.filter((id) => !off.includes(id));
    els.role.innerHTML = opts(on.map((id) => [id, roleName(id)]), `All roles (${on.length})`)
      + (off.length ? `<optgroup label="No guidance this week">${off.map((id) => `<option value="${esc(id)}">${esc(roleName(id))}</option>`).join("")}</optgroup>` : "")
      + (scope.role && !rs.includes(scope.role) ? `<option value="${esc(scope.role)}">${esc(roleName(scope.role))}</option>` : "");
    els.role.value = scope.role;
    fillJobs();
  }

  function fillJobs() {
    const av = jobsAvailable(), on = new Set(jobs());
    let lastTeam = null;
    els.joblist.innerHTML = av.length ? av.map((j) => {
      const head = !scope.team && j.team !== lastTeam ? `<div class="ds-dd-team">${esc(scope.wg ? j.team : `${j.wg} › ${j.team}`)}</div>` : "";
      lastTeam = j.team;
      return head + `<label class="ds-dd-job"><input type="checkbox" value="${esc(j.code)}" ${on.has(j.code) ? "checked" : ""}><span>${esc(j.desc)}</span>
        <small>${esc(j.code)}${j.roles.length ? " · " + esc(j.roles.map(roleName).join(", ")) : " · no labor role"}</small></label>`;
    }).join("") : `<div class="ds-muted">${tree().length ? "No jobs in this scope." : "Load a week first."}</div>`;
    els.jobsum.textContent = !av.length ? "—" : on.size === av.length ? `All ${av.length} job${av.length === 1 ? "" : "s"}` : `${on.size} of ${av.length} jobs`;
    els.scopeSum.textContent = tree().length ? scopeLabel() : "";
    const n = guidedIds().length;
    els.fitScope.hidden = n <= 1;
    els.fitScope.textContent = n > 1 ? `${n} roles: each is fitted to its own guidance line, and a shift only counts toward its own job's role. See “By role” under the day strip.` : "";
  }
  fillScope();
  if (prefs.floor) els.floor.value = prefs.floor;
  if (prefs.bonus != null) els.bonus.value = String(prefs.bonus);
  if (prefs.daymoves != null) els.daymoves.checked = prefs.daymoves;
  if (prefs.extend != null) els.extend.checked = prefs.extend;
  let savedRules = await host.storage.local.get("rules").catch(() => undefined);
  if (savedRules == null) {
    // First open: take the manager's list from the local, never-committed file
    // (dev/people-rules.local.txt; stripped from release builds) if it is there.
    savedRules = await fetch(host.url("dev/people-rules.local.txt")).then((r) => (r.ok ? r.text() : "")).catch(() => "");
    if (savedRules) host.storage.local.set("rules", savedRules).catch(() => {});
  }
  els.rules.value = savedRules || "";
  const savePrefs = () => host.storage.local.set("prefs", {
    scope, lastWk: data ? String(data.ctx.wk) : prefs.lastWk, floor: +els.floor.value, bonus: +els.bonus.value,
    daymoves: els.daymoves.checked, extend: els.extend.checked }).catch(() => {});

  const qKey = () => data ? `queue.${data.ctx.store}.${data.ctx.wk}` : null;
  const ownWrites = [];   // JSON of this page's last few queue writes: their change events are echoes
  const persistQueue = () => { if (!qKey()) return; ownWrites.push(JSON.stringify(queue)); if (ownWrites.length > 8) ownWrites.shift(); host.storage.local.set(qKey(), queue).catch(() => {}); };
  // Another ScheduleRight page in this browser changed the same week's queue: take its copy, so
  // the two pages never write their own versions over each other (removals coming back, 2026-10-21).
  const unwatchQueue = host.storage.local.onChange((changes) => {
    const c = qKey() && changes[qKey()]; if (!c || !alive) return;
    const next = c.newValue || [], j = JSON.stringify(next);
    if (j === JSON.stringify(queue) || ownWrites.includes(j)) return;
    queue = next; check = null; renderCoverage(); renderQueue(); renderRoster(); renderAreas();
  });

  function status(text, kind = "") { els.msg.hidden = !text; els.msg.textContent = text || ""; els.msg.className = `ds-status ${kind}`; }
  function setBusy(on, text) {
    busy = on;
    for (const b of [els.go, els.reload, els.validate, els.suggest, els.clear]) b.disabled = on;
    els.save.disabled = on || !canSubmit();
    els.revert.disabled = on || !lastSubmit();
    if (text !== undefined) status(text, on ? "busy" : "");
  }
  const send = (type, payload = {}) => host.messaging.sendRaw(type, payload, LONG).catch((e) => ({ ok: false, error: e.message }));

  // ── load ──────────────────────────────────────────────────────────────────
  // ── week cache (rolling CACHE_WEEKS per store) ────────────────────────────
  // weeks.index = [{ store, wk, weekStart, weekEnd, savedAt }]; weeks.<store>.<wk> = the read result.
  let weekIndex = (await host.storage.local.get("weeks.index").catch(() => null)) || [];
  const wKey = (store, wk) => `weeks.${store}.${wk}`;
  async function cacheWeek(d) {
    const e = { store: String(d.ctx.store), wk: String(d.ctx.wk), weekStart: d.ctx.weekStart, weekEnd: d.ctx.weekEnd, savedAt: d.savedAt };
    let idx = [e, ...weekIndex.filter((x) => !(x.store === e.store && x.wk === e.wk))];
    // keep the newest CACHE_WEEKS weeks of each store
    const drop = [];
    for (const st of new Set(idx.map((x) => x.store))) idx.filter((x) => x.store === st).sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1)).slice(CACHE_WEEKS).forEach((x) => drop.push(x));
    idx = idx.filter((x) => !drop.includes(x));
    weekIndex = idx;
    try {
      await host.storage.local.set(wKey(e.store, e.wk), d);
      if (drop.length) await host.storage.local.remove(drop.map((x) => wKey(x.store, x.wk)));
      await host.storage.local.set("weeks.index", idx);
    } catch (err) { console.warn("[scheduleright] week cache write failed", err); }
    renderSaved();
  }
  const cachedEntry = (wk, store = data?.ctx.store ?? weekIndex[0]?.store) => weekIndex.find((x) => x.wk === String(wk) && (store == null || x.store === String(store)));
  const ago = (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };

  // Rest across the week edges (store rule: no late close then early open): last week's
  // Friday end / next week's Saturday start per associate, from the cached neighbours.
  let neighbors = {};
  async function loadNeighbors(d) {
    const out = {}, day0 = Date.parse(d.dates[0] + "T00:00:00Z");
    const near = async (days) => { const ws = new Date(day0 + days * 864e5).toISOString().slice(0, 10);
      const e = weekIndex.find((x) => x.store === String(d.ctx.store) && x.weekStart === ws);
      return e ? host.storage.local.get(wKey(e.store, e.wk)).catch(() => null) : null; };
    const [prev, next] = await Promise.all([near(-7), near(7)]);
    const rel = (day, t) => (Date.parse(day + "T00:00:00Z") - day0) / 6e4 + toMin(t);
    for (const w of prev?.workers || []) for (const s of w.shifts) { const a = rel(s.day, s.start); let b = rel(s.day, s.end); if (b <= a) b += 1440;
      if (b > -1440) { const n = (out[w.workerId] ||= {}); n.prevEnd = Math.max(n.prevEnd ?? -Infinity, b); } }
    for (const w of next?.workers || []) for (const s of w.shifts) { const a = rel(s.day, s.start);
      if (a < 8 * 1440) { const n = (out[w.workerId] ||= {}); n.nextStart = Math.min(n.nextStart ?? Infinity, a); } }
    return out;
  }

  async function show(d, { fromCache }) {
    neighbors = await loadNeighbors(d).catch(() => ({}));
    data = d; data.fromCache = !!fromCache;
    if (data.workgroups?.length) { cachedTree = { workgroups: data.workgroups, roles: data.roles.map(({ id, name }) => ({ id, name })) }; host.storage.local.set("tree", cachedTree).catch(() => {}); }
    fillScope();
    els.wk.value = data.ctx.wk;
    queue = (await host.storage.local.get(qKey()).catch(() => null)) || [];
    check = null;
    savePrefs();
    status(fromCache ? `Saved copy from ${new Date(data.savedAt).toLocaleString()} (${ago(data.savedAt)}). Reload pulls the latest from the scheduler.` : "");
    render(); renderSaved();
  }

  /** wk: week to show; fresh: pull from the scheduler even if a saved copy exists. */
  async function load({ wk = null, fresh = false } = {}) {
    if (busy) return;
    if (wk && !fresh) {
      const e = cachedEntry(wk);
      const d = e && await host.storage.local.get(wKey(e.store, e.wk)).catch(() => null);
      if (d?.ctx) { await show(d, { fromCache: true }); return; }
    }
    setBusy(true, wk ? `Selecting WK ${wk} in the scheduler…` : "Reading the week from the scheduler (can take a minute)…");
    try {
      // fresh: the scheduler tab is reloaded first (its grid doesn't follow saves made through the API)
      if (wk) { const r = await send("week", { wk, fresh }); if (!r.ok) throw new Error(r.error); }
      if (wk) status("Reading the week from the scheduler…", "busy");
      const r = await send("read", { fresh: fresh && !wk }); if (!r.ok) throw new Error(r.error);
      if (!alive) return;
      r.data.savedAt = new Date().toISOString();
      await cacheWeek(r.data);
      await show(r.data, { fromCache: false });
    } catch (e) { status(e.message, "error"); }
    finally { if (alive) setBusy(false); }
  }

  function renderSaved() {
    const store = data?.ctx.store ?? weekIndex[0]?.store;
    const list = weekIndex.filter((x) => store == null || x.store === String(store)).sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1));
    els.saved.innerHTML = list.length ? `<span class="ds-muted">Saved:</span>` + list.map((x) => `<button type="button" class="ds-chip" data-wk="${esc(x.wk)}" aria-pressed="${!!data && String(data.ctx.wk) === x.wk}"
      title="${esc(`${x.weekStart} – ${x.weekEnd} · pulled ${new Date(x.savedAt).toLocaleString()}`)}">WK ${esc(x.wk)} <small>${esc(ago(x.savedAt))}</small></button>`).join("") : "";
  }

  // ── render ────────────────────────────────────────────────────────────────
  const preview = () => (queue.length ? applyChanges(data, queue) : { data, problems: [] });

  function render() {
    if (!data) { els.main.hidden = true; return; }
    els.main.hidden = false;
    const c = data.ctx;
    els.where.innerHTML = `<b>Store ${esc(c.store)}</b> · WK ${esc(c.wk)} · ${esc(c.weekStart)} – ${esc(c.weekEnd)}`
      + (data.filtered ? `<div class="ds-flag">Scheduler is filtered to a team: only ${data.filtered.shown} of ${data.filtered.total} associates read. Roles outside that team show 0 scheduled. Pick the whole store in the scheduler, then Reload.</div>` : "");
    renderCoverage(); renderQueue(); renderRoster(); renderHistory(); renderRulesState(); renderAreas();
    if (storeNo(c.store) !== sharedStore) pullShared();
  }

  // ── store-shared rules (people rules + areas) ────────────────────────────
  // stores/{store}/scheduleRules/current (service.js rules_get / rules_put): every
  // install at the store pulls it on open and pushes it back after an edit, so all
  // managers fit with the same rules. Last save wins; the local copy is a cache.
  let sharedStore = null, pushTimer = null;
  const storeNo = (x) => { const n = parseInt(String(x ?? "").replace(/\D/g, ""), 10); return n > 0 ? String(n) : null; };
  const sharedNote = (t, bad = false) => { els.rulesShared.textContent = t; els.rulesShared.className = bad ? "ds-k-under" : "ds-muted"; };
  const editorLine = (doc) => doc?.lastEditor ? ` · last saved by ${doc.lastEditor.label}${doc.lastEditor.at ? `, ${new Date(doc.lastEditor.at).toLocaleString()}` : ""}` : "";
  async function pullShared() {
    const st = storeNo(data?.ctx.store ?? weekIndex[0]?.store ?? await getUserHomeStore().catch(() => null));
    if (!st) { sharedNote("· not shared yet: store unknown — load a week"); return; }
    sharedStore = st;
    const r = await send("rules_get", { store: st });
    if (!r?.ok) { sharedNote(`· not shared: ${r?.error || "offline"} (using this browser's copy)`, true); return; }
    if (!r.doc) { if (els.rules.value.trim()) await pushShared(); else sharedNote(`· shared with store ${st} (none saved yet)`); return; }
    if (r.doc.rules != null && r.doc.rules !== els.rules.value) { els.rules.value = r.doc.rules; host.storage.local.set("rules", r.doc.rules).catch(() => {}); }
    if (Array.isArray(r.doc.areas)) { areas = normalizeAreas(r.doc.areas); host.storage.local.set("areas", areas).catch(() => {}); renderAreaEditor(); }
    renderRulesState(); if (data) renderAreas();
    sharedNote(`· shared with store ${st}${editorLine(r.doc)}`);
  }
  async function pushShared() {
    if (!sharedStore) return;
    const r = await send("rules_put", { store: sharedStore, rules: els.rules.value, areas });
    sharedNote(r?.ok ? `· saved for everyone at store ${sharedStore}` : `· not shared: ${r?.error || "offline"} (kept in this browser)`, !r?.ok);
  }
  function queuePush() { if (!sharedStore) return; clearTimeout(pushTimer); sharedNote("· saving for the store…"); pushTimer = setTimeout(() => { pushTimer = null; pushShared(); }, 1500); }

  // ── open-to-close areas ───────────────────────────────────────────────────
  let areas = normalizeAreas((await host.storage.local.get("areas").catch(() => null)) || DEFAULT_AREAS);
  // Jewelry was saved empty before it defaulted to the Fashion jobs (2026-10-17): fill it once.
  for (const a of areas) { const d = DEFAULT_AREAS.find((x) => x.id === a.id); if (d && !a.jobs.length && !a.people.length) a.jobs = d.jobs.slice(); }
  const activeAreas = () => areas.filter(isSetUp);
  const saveAreas = () => { host.storage.local.set("areas", areas).catch(() => {}); queuePush(); };
  const span = (g) => `${fmt12(toMin(g.from))}–${fmt12(toMin(g.to) || 1440)}`;

  function renderAreas() {
    if (!data) return;
    const withQ = els.areasPreview.checked && queue.length;
    const base = withQ ? preview().data : data;
    const delta = queue.length ? areaDelta(data, preview().data, areas) : [];
    let bad = 0;
    let html = `<thead><tr><th>Area</th>${DOW.map((d, i) => `<th class="${i < 2 ? "is-weekend" : ""}">${d} <small>${esc(data.dates[i].slice(5))}</small></th>`).join("")}</tr></thead><tbody>`;
    for (const a of areas.filter((x) => !x.off)) {
      html += `<tr><th><div class="ds-name">${esc(a.name)}</div><small class="ds-muted">${esc(fmt12(toMin(a.open)))}–${esc(fmt12(toMin(a.close) || 1440))}</small></th>`;
      if (!isSetUp(a)) { html += `<td colspan="7" class="ds-muted">Nobody counts toward ${esc(a.name)} yet. Open “Edit areas” and add its job codes or the associates who work it.</td></tr>`; continue; }
      const days = areaGaps(base, a), dl = delta.find((x) => x.area.id === a.id);
      days.forEach((d, di) => {
        const added = withQ ? dl?.days[di].added || [] : [];
        const isNew = (g) => added.some((x) => x.from === g.from && x.to === g.to && x.kind === g.kind);
        if (d.gaps.length) bad++;
        const thin = d.thin.length ? `only one on: ${d.thin.map(span).join(", ")}` : "";
        html += `<td class="ds-area-cell ${d.gaps.length ? "is-gap" : "is-ok"} ${di < 2 ? "is-weekend" : ""}" title="${esc(thin)}">${d.gaps.length
          ? d.gaps.map((g) => `<div class="${isNew(g) ? "is-new" : ""}">${GAP_LABEL[g.kind]} ${esc(span(g))}${isNew(g) ? " <b>new</b>" : ""}</div>`).join("")
          : "covered"}${thin ? `<small>${d.thin.length} thin stretch${d.thin.length > 1 ? "es" : ""}</small>` : ""}</td>`;
      });
      html += "</tr>";
    }
    els.areasTable.innerHTML = html + "</tbody>";
    const newGaps = delta.reduce((t, x) => t + x.days.reduce((u, d) => u + d.added.length, 0), 0);
    els.areasState.textContent = `· ${bad ? `${bad} day(s) with a gap` : "every open hour covered"}${newGaps ? ` · the queue opens ${newGaps} new gap(s)` : ""}`;
    els.areasState.className = bad || newGaps ? "ds-k-under" : "ds-muted";
  }

  function renderAreaEditor() {
    els.areasEdit.innerHTML = areas.map((a, i) => `<div class="ds-area-row" data-i="${i}">
      <label class="ds-check"><input type="checkbox" data-a="on" ${a.off ? "" : "checked"}></label>
      <input class="input" data-a="name" value="${esc(a.name)}" placeholder="Area" style="width:10em">
      <label class="ds-field">Open <input class="input" type="time" step="900" data-a="open" value="${esc(a.open)}"></label>
      <label class="ds-field">Close <input class="input" type="time" step="900" data-a="close" value="${esc(a.close)}"></label>
      <label class="ds-field ds-grow">Jobs <input class="input" data-a="jobs" value="${esc(a.jobs.join(", "))}" placeholder="job codes, e.g. 1-640-7410" title="${esc(a.jobs.map(jobDesc).join(" · "))}"></label>
      <label class="ds-field ds-grow">People <input class="input" data-a="people" value="${esc(a.people.join(", "))}" placeholder="names, comma separated (any job counts)"></label>
      <button type="button" class="ds-x" data-a="del" title="Remove area">×</button></div>`).join("");
  }
  els.areasEdit.addEventListener("change", (e) => {
    const row = e.target.closest(".ds-area-row"), k = e.target.dataset.a; if (!row || !k) return;
    const a = areas[+row.dataset.i];
    if (k === "on") a.off = !e.target.checked; else a[k] = e.target.value;
    areas = normalizeAreas(areas); saveAreas(); renderAreaEditor(); renderAreas();
  });
  els.areasEdit.addEventListener("click", (e) => {
    if (e.target.dataset.a !== "del") return;
    areas.splice(+e.target.closest(".ds-area-row").dataset.i, 1); saveAreas(); renderAreaEditor(); renderAreas();
  });
  els.areaAdd.addEventListener("click", () => { areas = normalizeAreas([...areas, { name: "New area", open: areas[0]?.open, close: areas[0]?.close }]); saveAreas(); renderAreaEditor(); renderAreas(); });
  els.areaReset.addEventListener("click", () => { areas = normalizeAreas(DEFAULT_AREAS); saveAreas(); renderAreaEditor(); renderAreas(); });
  els.areasPreview.addEventListener("change", renderAreas);
  // Adds lunch-only edits to the queue (shifts already queued are left alone).
  els.stagger.addEventListener("click", () => {
    if (!data || busy) return;
    const out = staggerLunches(preview().data, activeAreas(), { editableFrom: tomorrow() });
    if (out.changes.length) setQueue([...queue, ...out.changes]);
    const h = (m) => (m / 60).toFixed(2).replace(/\.?0+$/, "");
    els.staggerOut.textContent = out.changes.length
      ? `Queued ${out.changes.length} lunch change(s): ${h(out.fixedMin)} h of gap closed${out.leftMin ? `, ${h(out.leftMin)} h left that lunches alone can't fix` : ""}.`
      : out.leftMin ? `No lunch move helps; the ${h(out.leftMin)} h of gaps left need another person on the schedule.` : "No gaps to fix.";
  });
  renderAreaEditor();

  // ── guidance graph (before / with queue) ──────────────────────────────────
  function renderGraph() {
    const now = coverage(data, roleId(), jobs());
    const next = queue.length ? coverage(preview().data, roleId(), jobs()) : now;
    const moves = movesFromQueue(data, queue);
    gDays = data.dates.map((date, di) => ({ date, need: now[di].need, before: now[di].have, after: next[di].have,
      moves: moves.filter((m) => m.fromDay === di || m.toDay === di) }));
    if (gSel == null || gSel > 6) { const t = tomorrow(); const i = data.dates.findIndex((d) => d >= t); gSel = i >= 0 ? i : 0; }
    const yWeek = Math.max(1, Math.ceil(Math.max(...gDays.flatMap((d) => [...d.need, ...d.before, ...d.after])) / 5) * 5);
    for (const [el, key] of [[els.wkBefore, "before"], [els.wkAfter, "after"]]) {
      el.innerHTML = gDays.map((d, i) => { const ty = tally(d, key);
        return `<button type="button" class="ds-mini" data-i="${i}" aria-pressed="${i === gSel}"><b>${esc(dayLabel(d))}</b><small>on target ${ty.blue} h · off by ${f2(offBy(d, key))} h</small>${chartSvg(d, key, { W: 220, H: 84, L: 2, B: 14, yMax: yWeek, axis: false, hover: false })}</button>`; }).join("");
    }
    const d = gDays[gSel];
    const yMax = Math.max(1, Math.ceil(Math.max(...d.need, ...d.before, ...d.after) / 5) * 5);
    for (const [ch, t, m, key, title] of [[els.chBefore, els.tBefore, els.mBefore, "before", "Current schedule"], [els.chAfter, els.tAfter, els.mAfter, "after", "With queued changes"]]) {
      ch.innerHTML = chartSvg(d, key, { W: 640, H: 250, L: 30, B: 20, yMax, axis: true, hover: true });
      const tt = totals(d, key), ty = tally(d, key);
      t.textContent = `${title} · ${dayLabel(d, true)}`;
      m.textContent = `${f2(tt.sched)} / ${f2(tt.need)} h · ${ty.blue} on target, ${ty.under} short, ${ty.over} over · off by ${f2(offBy(d, key))} h`;
    }
  }
  const hideTip = () => { els.tip.style.display = "none"; container.querySelectorAll(".ds-cx").forEach((c) => c.setAttribute("visibility", "hidden")); };
  for (const ch of [els.chBefore, els.chAfter]) {
    ch.addEventListener("mousemove", (e) => {
      const r = e.target.closest?.("rect[data-h]"); if (!r || !gDays) return hideTip();
      const h = +r.dataset.h, cx = ch.querySelector(".ds-cx");
      cx.setAttribute("x1", r.dataset.x); cx.setAttribute("x2", r.dataset.x); cx.setAttribute("visibility", "visible");
      els.tip.innerHTML = hourTip(gDays, gSel, h, esc); els.tip.style.display = "block";
      const tw = els.tip.offsetWidth;
      els.tip.style.left = (e.clientX + 16 + tw > innerWidth ? e.clientX - tw - 12 : e.clientX + 16) + "px";
      els.tip.style.top = Math.min(e.clientY + 14, innerHeight - els.tip.offsetHeight - 8) + "px";
    });
    ch.addEventListener("mouseleave", hideTip);
  }
  for (const el of [els.wkBefore, els.wkAfter]) el.addEventListener("click", (e) => { const b = e.target.closest(".ds-mini"); if (b) { gSel = +b.dataset.i; renderGraph(); } });

  // Several roles: the graph is their total; this shows each role against its own guidance.
  function renderByRole() {
    const ids = guidedIds();
    if (ids.length < 2) { els.byRole.hidden = true; return; }
    const rj = roleJobs(), pv = queue.length ? preview().data : data;
    const rows = ids.map((r) => { const js = rj[r] || []; return { r, now: summarize(coverage(data, [r], js)), next: summarize(coverage(pv, [r], js)) }; })
      .sort((a, b) => roleName(a.r).localeCompare(roleName(b.r)));
    const cell = (s, o) => `<td class="${s.underHrs > 0.001 ? "ds-k-under" : s.overHrs > 0.001 ? "ds-k-over" : ""}" title="${esc(`${s.sched.toFixed(1)} / ${s.guide.toFixed(1)} h`)}"><b>${s.blue}</b>/${s.hours}${s.blue !== o.blue ? ` <span class="ds-delta ${s.blue > o.blue ? "up" : "down"}">${s.blue > o.blue ? "+" : ""}${s.blue - o.blue}</span>` : ""}<small>${s.underHrs > 0.001 ? `−${s.underHrs.toFixed(1)}` : ""}${s.overHrs > 0.001 ? ` +${s.overHrs.toFixed(1)}` : ""}</small></td>`;
    els.byRole.hidden = false;
    els.byRole.innerHTML = `<summary>By role — each against its own guidance (blue hours; −short / +over h)</summary><div class="ds-cov-wrap"><table class="ds-area-table"><thead><tr><th>Role</th>${DOW.map((d, i) => `<th class="${i < 2 ? "is-weekend" : ""}">${d}</th>`).join("")}</tr></thead><tbody>`
      + rows.map(({ r, now, next }) => `<tr><th>${esc(roleName(r))}</th>${next.map((s, i) => cell(s, now[i])).join("")}</tr>`).join("") + "</tbody></table></div>";
  }

  function renderCoverage() {
    renderGraph(); renderByRole();
    const now = coverage(data, roleId(), jobs());
    const pv = preview();
    const next = els.preview.checked && queue.length ? coverage(pv.data, roleId(), jobs()) : now;
    const sNow = summarize(now), sNext = summarize(next);
    const delta = (a, b, dp = 0, good = 1) => a === b ? "" : `<span class="ds-delta ${(b - a) * good > 0 ? "up" : "down"}">${b > a ? "+" : ""}${(b - a).toFixed(dp)}</span>`;
    // week totals: guidance vs scheduled now vs with the queue (FTE-hours on the clock, lunches out)
    const wk = (s, k) => s.reduce((a, x) => a + x[k], 0);
    const G = wk(sNow, "guide"), S = wk(sNow, "sched"), Q = wk(sNext, "sched"), net = (x) => `${x >= G ? "+" : "−"}${Math.abs(x - G).toFixed(1)} vs guidance`;
    const pv2 = queue.length ? pv.data : data, js = jobs();
    const paidScope = (d) => d.workers.reduce((a, w) => a + w.shifts.filter((s) => js.includes(s.job)).reduce((t, s) => t + paidHours(s), 0), 0);
    els.totals.innerHTML = `<div><small>Guidance</small><b>${G.toFixed(1)} h</b></div>
      <div><small>Scheduled now</small><b>${S.toFixed(1)} h</b><span class="ds-muted">${net(S)} · ${paidScope(data).toFixed(1)} paid</span></div>
      <div><small>With queued changes</small><b>${Q.toFixed(1)} h</b>${delta(S, Q, 1)}<span class="ds-muted">${net(Q)} · ${paidScope(pv2).toFixed(1)} paid</span></div>
      <div><small>Short / over</small><b>${wk(sNext, "underHrs").toFixed(1)} / ${wk(sNext, "overHrs").toFixed(1)} h</b><span class="ds-muted">now ${wk(sNow, "underHrs").toFixed(1)} / ${wk(sNow, "overHrs").toFixed(1)}</span></div>
      <div><small>Blue hours</small><b>${wk(sNext, "blue")} / ${wk(sNext, "hours")}</b>${delta(wk(sNow, "blue"), wk(sNext, "blue"))}</div>`;
    els.days.innerHTML = sNext.map((s, i) => {
      const o = sNow[i];
      const short = s.underHrs > 0.001 ? `${s.underHrs.toFixed(2)} h short` : "never short";
      return `<div class="ds-day ${i < 2 ? "is-weekend" : ""}">
        <div class="ds-day-name">${DOW[i]} <small>${esc(s.date.slice(5))}</small></div>
        <div class="ds-day-blue"><b>${s.blue}</b>/${s.hours} blue ${delta(o.blue, s.blue)}</div>
        <div class="${s.underHrs > 0.001 ? "ds-k-under" : ""}">${short}</div>
        <div class="${s.overHrs > 0.001 ? "ds-k-over" : ""}">${s.overHrs > 0.001 ? `${s.overHrs.toFixed(2)} h over` : "never over"}</div>
        <div class="ds-muted">${s.sched.toFixed(1)} / ${s.guide.toFixed(1)} h${s.low ? ` · low ${fmt12(s.low.hour * 60)} ${Math.round(s.low.pct * 100)}%` : ""}</div>
      </div>`; }).join("");

    let lo = 24, hi = -1;
    next.concat(now).forEach((d) => d.need.forEach((n, h) => { if (n > 0 || d.have[h] > 0) { lo = Math.min(lo, h); hi = Math.max(hi, h); } }));
    if (hi < 0) { els.cov.innerHTML = `<tr><td class="ds-muted">No guidance or shifts in this scope — pick another team, role or jobs.</td></tr>`; return; }
    let html = `<thead><tr><th></th>${DOW.map((d, i) => `<th class="${i < 2 ? "is-weekend" : ""}">${d}</th>`).join("")}</tr></thead><tbody>`;
    for (let h = lo; h <= hi; h++) {
      html += `<tr><th class="${isPeak(h) ? "is-peak" : ""}">${fmt12(h * 60)}</th>`;
      for (let di = 0; di < 7; di++) {
        const n = next[di].need[h], v = next[di].have[h], st = hourState(n, v), moved = Math.abs(v - now[di].have[h]) > 1e-9;
        const pct = n > 0 ? v / n : null, low = pct != null && pct < 0.85 ? " is-low" : "";
        html += `<td class="ds-c ${st}${moved ? " is-moved" : ""}${low}" title="${esc(`${DOW[di]} ${fmt12(h * 60)}: scheduled ${v} · guidance ${n.toFixed(2)}${moved ? ` · now ${now[di].have[h]}` : ""}`)}">${n || v ? `${+v.toFixed(2)}<small>/${+n.toFixed(2)}</small>` : ""}</td>`;
      }
      html += "</tr>";
    }
    els.cov.innerHTML = html + "</tbody>";
  }

  const sig = () => JSON.stringify(queue);
  function canSave() {
    if (!data || !queue.length || !check || check.sig !== sig()) return false;
    const r = check.result; return !r.hard?.length && !r.skipped?.length;
  }
  // Submit is offered for any queue; it runs Verify itself when the last check is stale.
  const canSubmit = () => !!(data && queue.length);
  // Newest submit (or revert) for the loaded store + week that hasn't been reverted yet.
  const lastSubmit = () => data ? history.find((h) => String(h.store) === String(data.ctx.store) && String(h.wk) === String(data.ctx.wk) && !h.undoneAt) || null : null;

  function renderQueue() {
    els.qcount.textContent = queue.length;
    const pv = preview();
    const bad = new Map(pv.problems.map((p) => [p.idx, p.why]));
    const r = check && check.sig === sig() ? check.result : null;
    const flagged = new Map();
    if (r) {
      for (const s of r.skipped || []) flagged.set(s.idx, `not built: ${s.why}`);
      const byW = new Map(); for (const x of [...(r.hard || []), ...(r.newWarnings || [])]) { if (!byW.has(x.workerId)) byW.set(x.workerId, []); byW.get(x.workerId).push(`${x.type === "HARD" ? "HARD " : ""}${x.code} ${x.message}`); }
      queue.forEach((ch, i) => { const w = (ch.workerId != null && data.workers.find((x) => x.workerId === ch.workerId)) || data.workers.find((x) => x.name === ch.name); const v = w && byW.get(w.workerId); if (v && !flagged.has(i)) flagged.set(i, v.join(" · ")); });
    }
    const kindOf = (ch) => (ch.action === "edit" && ch.stretched ? "stretch" : ch.action), kinds = {};
    queue.forEach((ch) => { kinds[kindOf(ch)] = (kinds[kindOf(ch)] || 0) + 1; });
    const paidAll = (d) => d.workers.reduce((t, w) => t + w.shifts.reduce((u, s) => u + paidHours(s), 0), 0);
    const dPaid = queue.length ? paidAll(preview().data) - paidAll(data) : 0, nFlag = flagged.size + bad.size;
    els.qsum.innerHTML = !queue.length ? "" : [kinds.create && `${kinds.create} new`, kinds.stretch && `${kinds.stretch} stretched`, kinds.edit && `${kinds.edit} re-timed`,
      kinds.move && `${kinds.move} moved`, kinds.delete && `${kinds.delete} removed`].filter(Boolean).join(" · ")
      + ` · <b>${dPaid >= 0 ? "+" : "−"}${Math.abs(dPaid).toFixed(1)} paid h</b>${nFlag ? ` · <span class="ds-k-under">${nFlag} flagged</span>` : ""} · marked in the Associates grid`;
    if (nFlag) container.querySelector("#digitalschedule-qlist").open = true;
    els.queue.innerHTML = queue.length ? queue.map((ch, i) => `<li class="${flagged.has(i) || bad.has(i) ? "is-flagged" : ""}">
        <b>${esc(ch.name)}</b> — ${esc(describe(ch, data.dates))}
        <button class="ds-x" data-del="${i}" title="Remove from queue" type="button">×</button>
        ${bad.has(i) ? `<div class="ds-flag">${esc(bad.get(i))}</div>` : ""}${flagged.has(i) ? `<div class="ds-flag">${esc(flagged.get(i))}</div>` : ""}</li>`).join("")
      : `<li class="ds-muted ds-empty">Nothing queued. Click a shift below, or use Fit to guidance.</li>`;
    if (r) {
      els.check.hidden = false;
      const clean = !r.hard?.length && !r.newWarnings?.length && !r.skipped?.length;
      els.check.className = `ds-check-out ${clean ? "ok" : r.hard?.length || r.skipped?.length ? "error" : "warn"}`;
      els.check.innerHTML = clean
        ? `Clean: ${r.applied.length} change(s) ready.`
        : `${r.hard?.length ? `<b>${r.hard.length} hard</b> (scheduler will refuse) · ` : ""}${r.newWarnings?.length ? `${r.newWarnings.length} new warning(s) · ` : ""}${r.skipped?.length ? `${r.skipped.length} could not be built · ` : ""}${r.preexistingWarnings || 0} existing warnings ignored. Flagged lines are marked above.`;
      if (r.preexistingHard?.length) els.check.innerHTML += ` <span class="ds-muted">${r.preexistingHard.length} hard error(s) are already on the saved schedule (${esc([...new Set(r.preexistingHard.map((x) => x.name || x.workerId))].join(", "))}), not from these changes.</span>`;
    } else els.check.hidden = true;
    els.save.disabled = busy || !canSubmit();
    els.submitState.textContent = !queue.length ? "" : canSave() ? "Verified — ready to submit."
      : r ? "Fix or remove the flagged lines, then Verify again." : "Not verified yet — Submit will verify first.";
  }

  function availText(w, di) {
    const v = w.availability?.[["sat", "sun", "mon", "tue", "wed", "thu", "fri"][di]];
    if (v == null) return ""; if (v === "off") return "unavailable"; if (v === "any") return "any time";
    return v.split(",").map((r) => r.split("-").map((t) => fmt12(toMin(t))).join("–")).join(", ");
  }

  function renderRoster() {
    const pv = preview().data, js = jobs(), q = els.filter.value.trim().toLowerCase();
    const touched = new Set(queue.map((c) => String(c.name).toLowerCase()));
    // what each queued shift was, and the shifts the queue takes away (removed / moved off a day)
    const orig = new Map(data.workers.map((w) => [w.workerId, w]));
    const findOrig = (ch) => { const w0 = orig.get(ch.workerId) || data.workers.find((x) => x.name === ch.name);
      return [w0, w0?.shifts.find((s) => s.day === ch.day && (!ch.from || toMin(s.start) === toMin(ch.from)))]; };
    const gone = new Map();   // workerId → [{ day, start, end, why }]
    queue.forEach((ch) => { if (ch.action !== "delete" && ch.action !== "move") return;
      const [w0, s0] = findOrig(ch); if (!s0) return;
      const l = gone.get(w0.workerId) || []; l.push({ day: ch.day, start: s0.start, end: s0.end, why: ch.action === "move" ? `moved to ${DOW[data.dates.indexOf(ch.toDay)]}` : "removed" }); gone.set(w0.workerId, l); });
    const span12 = (s) => `${fmt12(toMin(s.start))}–${fmt12(toMin(s.end))}`;
    const wasOf = (s) => { const ch = queue[s.qIdx]; if (!ch) return { cls: "is-changed", note: "" };
      if (ch.action === "create") return { cls: "is-new", note: "new" };
      const [, s0] = findOrig(ch);
      if (ch.action === "move") return { cls: "is-changed", note: `moved from ${DOW[data.dates.indexOf(ch.day)]}${s0 ? " " + span12(s0) : ""}` };
      const longer = s0 && shiftSpan(s)[1] - shiftSpan(s)[0] > shiftSpan(s0)[1] - shiftSpan(s0)[0];
      return { cls: ch.stretched || longer ? "is-stretched" : "is-changed", note: s0 ? `was ${span12(s0)}` : "" }; };
    const rows = pv.workers.filter((w) => (!els.changedOnly.checked || touched.has(w.name.toLowerCase())) && (els.all.checked || w.shifts.some((s) => js.includes(s.job)) || touched.has(w.name.toLowerCase()))
      && (!q || w.name.toLowerCase().includes(q))).sort((a, b) => a.name.localeCompare(b.name));
    let html = `<thead><tr><th>Associate</th>${DOW.map((d, i) => `<th class="${i < 2 ? "is-weekend" : ""}">${d} <small>${esc(data.dates[i].slice(5))}</small></th>`).join("")}<th>Paid h</th></tr></thead><tbody>`;
    for (const w of rows) {
      const inHome = String(w.job || "").includes(IN_HOME_JOB) || w.shifts.some((s) => s.job === IN_HOME_JOB);
      const tags = [w.payType && `<span class="ds-tag">${esc(w.payType)}</span>`, isMinor(w) && `<span class="ds-tag warn">minor</span>`, inHome && `<span class="ds-tag">In Home</span>`].filter(Boolean).join("");
      html += `<tr><th><div class="ds-name">${esc(w.name)}</div>${tags}</th>`;
      for (let di = 0; di < 7; di++) {
        const day = data.dates[di];
        const ss = w.shifts.filter((s) => s.day === day).sort((a, b) => toMin(a.start) - toMin(b.start));
        const other = (w.otherEvents || []).filter((e) => e.day === day).map((e) => `<span class="ds-tag">${esc(e.type)}</span>`).join("");
        const ghosts = (gone.get(w.workerId) || []).filter((g) => g.day === day).map((g) => `<div class="ds-shift is-gone" title="${esc(g.why)}">${span12(g)}<small>${esc(g.why)}</small></div>`).join("");
        const cells = ghosts + ss.map((s) => {
          const brk = (s.breaks || []).filter((b) => !b.paid).map((b) => `lunch ${fmt12(toMin(b.start))}`).join(", ");
          const wv = s.changed ? wasOf(s) : null;
          return `<button type="button" class="ds-shift ${js.includes(s.job) ? "" : "is-other"} ${wv ? wv.cls : ""}" data-w="${esc(w.workerId)}" data-day="${di}" data-from="${esc(s.start)}" data-job="${esc(s.job)}" ${s.qIdx != null ? `data-q="${s.qIdx}"` : ""}
            title="${esc(`${jobDesc(s.job)} · ${s.job}${brk ? " · " + brk : ""}`)}">${fmt12(toMin(s.start))}–${fmt12(toMin(s.end))}${wv?.note ? `<small class="ds-was">${esc(wv.note)}</small>` : ""}${brk ? `<small>${esc(brk)}</small>` : ""}${js.includes(s.job) ? "" : `<small>${esc(jobDesc(s.job))}</small>`}</button>`; }).join("");
        html += `<td class="ds-cell ${di < 2 ? "is-weekend" : ""}" data-w="${esc(w.workerId)}" data-day="${di}">${cells}${other}${!ss.length && !other ? `<span class="ds-add">+</span>` : ""}<div class="ds-avail">${esc(availText(w, di))}</div></td>`;
      }
      const total = w.shifts.reduce((a, s) => a + paidHours(s), 0), was = (orig.get(w.workerId)?.shifts || []).reduce((a, s) => a + paidHours(s), 0);
      html += `<td class="ds-num-cell">${total.toFixed(2)}${Math.abs(total - was) > 1e-9 ? `<small class="ds-was">was ${was.toFixed(2)}</small>` : ""}</td></tr>`;
    }
    els.roster.innerHTML = html + (rows.length ? "" : `<tr><td colspan="9" class="ds-muted">Nobody with ${js.length ? esc(js.length > 3 ? `${js.length} chosen jobs'` : js.map(jobDesc).join(", ")) : "the chosen jobs'"} shifts this week.</td></tr>`) + "</tbody>";
  }

  function renderHistory() {
    els.history.innerHTML = history.length ? history.slice(0, 12).map((h) => `<li>
      <div><b>WK ${esc(h.wk)}</b> · ${esc(new Date(h.at).toLocaleString())} · ${h.applied.length} change(s)${h.undoOf ? " · <i>undo</i>" : ""}${h.undoneAt ? " · <span class=\"ds-muted\">undone</span>" : ""}</div>
      ${h.misses?.length ? `<div class="ds-flag">${h.misses.length} change(s) didn't stick</div>` : ""}
      <div class="ds-hist-actions"><button type="button" class="btn btn-ghost btn-sm" data-undo="${esc(h.id)}" ${h.undoneAt ? "disabled" : ""}>Undo</button>
      <button type="button" class="btn btn-ghost btn-sm" data-hist="${esc(h.id)}">Download</button></div></li>`).join("")
      : `<li class="ds-muted">Nothing saved from here yet.</li>`;
    const last = lastSubmit();
    els.revert.disabled = busy || !last;
    els.revert.title = last ? `Put back the ${last.applied.length} change(s) submitted ${new Date(last.at).toLocaleString()}` : "Nothing submitted for this week yet";
  }

  function renderRulesState() {
    const r = parseRules(els.rules.value);
    const n = r.pairs.length + r.fixed.size + r.daysOnly.size + r.windows.size + r.noDayMove.size + r.keep.size;
    const unk = data ? unknownNames(r, data.workers) : [];
    els.rulesState.textContent = r.errors.length ? `· ${r.errors.length} line(s) not understood` : n ? `· ${n} rule(s)${unk.length ? `, ${unk.length} name(s) not on this week` : ""}` : "· none";
    els.rulesState.title = [...r.errors, ...unk.map((u) => `not on this week's roster: ${u}`)].join("\n");
  }

  // ── queue ops ─────────────────────────────────────────────────────────────
  function setQueue(next) { queue = next; check = null; persistQueue(); renderCoverage(); renderQueue(); renderRoster(); renderAreas(); }

  function openEditor({ w, di, from, job, qIdx }) {
    const worker = data.workers.find((x) => String(x.workerId) === String(w)); if (!worker) return;
    const existingQ = qIdx != null ? queue[qIdx] : null;
    // the original shift this cell stands for
    let orig = null;
    if (existingQ && existingQ.action !== "create") orig = worker.shifts.find((s) => s.day === existingQ.day && toMin(s.start) === toMin(existingQ.from)) || null;
    if (existingQ && existingQ.action !== "create" && !orig) { els.editor.hidden = true; return; }
    if (!existingQ && from) orig = worker.shifts.find((s) => s.day === data.dates[di] && s.start === from && (!job || s.job === job));
    const isCreate = existingQ ? existingQ.action === "create" : !orig;
    const cur = existingQ ? { start: existingQ.start ?? orig?.start, end: existingQ.end ?? orig?.end, day: existingQ.toDay || existingQ.day,
      lunch: existingQ.lunch && existingQ.lunch !== "none" ? existingQ.lunch : (orig?.breaks || []).find((b) => !b.paid)?.start || "" }
      : orig ? { start: orig.start, end: orig.end, day: orig.day, lunch: (orig.breaks || []).find((b) => !b.paid)?.start || "" }
      : { start: "09:00", end: "18:00", day: data.dates[di], lunch: "13:00" };
    const dayOpts = data.dates.map((d, i) => `<option value="${d}" ${d === cur.day ? "selected" : ""}>${DOW[i]} ${d.slice(5)}</option>`).join("");
    els.editor.hidden = false;
    els.editor.innerHTML = `<div class="ds-editor-head"><b>${esc(worker.name)}</b> — ${isCreate ? "add a shift" : `${DOW[data.dates.indexOf(orig.day)]} ${fmt12(toMin(orig.start))}–${fmt12(toMin(orig.end))} (${esc(orig.job)})`}
        ${existingQ ? `<span class="ds-tag">queued</span>` : ""}</div>
      <div class="ds-editor-row">
        <label class="ds-field">Day <select class="input" data-f="day">${dayOpts}</select></label>
        <label class="ds-field">Start <input class="input" type="time" step="900" data-f="start" value="${esc(cur.start)}"></label>
        <label class="ds-field">End <input class="input" type="time" step="900" data-f="end" value="${esc(cur.end)}"></label>
        <label class="ds-field">Lunch (1 h) <input class="input" type="time" step="900" data-f="lunch" value="${esc(cur.lunch)}"></label>
        ${isCreate ? `<label class="ds-field">Job <select class="input" data-f="job">${[...new Set([existingQ?.job, ...jobs(), ...jobsAvailable().map((j) => j.code)].filter(Boolean))]
          .map((c) => `<option value="${esc(c)}" ${c === (existingQ?.job || jobs()[0]) ? "selected" : ""}>${esc(jobDesc(c))} · ${esc(c)}</option>`).join("")}</select></label>` : ""}
      </div>
      <div class="ds-editor-why ds-muted" data-f="why"></div>
      <div class="ds-actions">
        <button type="button" class="btn btn-primary btn-sm" data-act="queue">Queue change</button>
        ${!isCreate ? `<button type="button" class="btn btn-secondary btn-sm" data-act="delete">Delete shift</button>` : ""}
        ${existingQ ? `<button type="button" class="btn btn-ghost btn-sm" data-act="drop">Drop queued change</button>` : ""}
        <span class="ds-spacer"></span>
        <button type="button" class="btn btn-ghost btn-sm" data-act="cancel">Cancel</button>
      </div>`;
    const f = (k) => els.editor.querySelector(`[data-f="${k}"]`);
    const why = (t) => { f("why").textContent = t; };
    const updateWhy = () => {
      const s = toMin(f("start").value); let e = toMin(f("end").value); if (e <= s) e += 1440;
      const len = e - s, l = f("lunch").value ? toMin(f("lunch").value) : null;
      const notes = [`${(len / 60).toFixed(2)} h on the clock`];
      if (len > 360 && l == null) notes.push("over 6 h needs a 1 h lunch");
      if (l != null) { let off = l - s; if (off < 0) off += 1440; if (off < 180) notes.push("lunch starts less than 3 h in"); if (off + 60 > 330) notes.push("lunch ends more than 5.5 h in"); }
      if (s % 60) notes.push("not a whole-hour start");
      if (f("day").value < tomorrow() || (orig && orig.day < tomorrow())) notes.push("today or an earlier day — already worked or under way");
      const d = data.dates.indexOf(f("day").value); if (orig && d !== data.dates.indexOf(orig.day) && data.dates.indexOf(orig.day) < 2) notes.push("moving a shift off a weekend day");
      why(notes.join(" · "));
    };
    els.editor.querySelectorAll("input,select").forEach((x) => x.addEventListener("input", updateWhy)); updateWhy();
    els.editor.onclick = (ev) => {
      const act = ev.target.closest("[data-act]")?.dataset.act; if (!act) return;
      const next = queue.slice(); if (existingQ) next.splice(qIdx, 1);
      if (act === "cancel") { els.editor.hidden = true; return; }
      if (act === "drop") { setQueue(next); els.editor.hidden = true; return; }
      const base = { name: worker.name, workerId: worker.workerId };
      if (act === "delete") { next.push({ ...base, action: "delete", day: orig.day, from: orig.start, expectEnd: orig.end, job: orig.job }); setQueue(next); els.editor.hidden = true; return; }
      const start = f("start").value, end = f("end").value, lunch = f("lunch").value, day = f("day").value;
      if (!start || !end) return why("Start and end are needed.");
      // blank lunch: drop an existing unpaid lunch; otherwise let paid breaks slide with the shift
      const t = { start, end, ...(lunch ? { lunch } : (orig?.breaks || []).some((b) => !b.paid) ? { lunch: "none" } : {}) };
      let ch;
      if (isCreate) ch = { ...base, action: "create", day, job: f("job").value || jobs()[0], ...t };
      else if (day === orig.day) ch = { ...base, action: "edit", day, from: orig.start, expectEnd: orig.end, job: orig.job, ...t };
      else ch = { ...base, action: "move", day: orig.day, from: orig.start, expectEnd: orig.end, job: orig.job, toDay: day, ...t };
      next.push(ch); setQueue(next); els.editor.hidden = true;
    };
    els.editor.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  // ── validate / save / undo ────────────────────────────────────────────────
  async function validate(list = queue) {
    setBusy(true, "Checking with the scheduler's validator…");
    try {
      const r = await send("validate", { changes: list }); if (!r.ok) throw new Error(r.error);
      if (list === queue) { check = { sig: sig(), result: r.result }; status(""); renderQueue(); }
      else status("");
      return r.result;
    } catch (e) { status(e.message, "error"); return { error: e.message }; }
    finally { if (alive) setBusy(false); }
  }

  function confirmSave(list, result, what) {
    els.dlgWhat.textContent = what;
    els.dlgList.innerHTML = list.map((ch) => `<li><b>${esc(ch.name)}</b> — ${esc(describe(ch, data.dates))}</li>`).join("")
      + (result.newWarnings || []).map((x) => `<li class="is-flagged"><b>${esc(x.name || x.workerId)}</b> — ${esc(x.message)}</li>`).join("")
      + (data ? areaDelta(data, applyChanges(data, list).data, areas).flatMap((x) => x.days.flatMap((d) => d.added.map((g) =>
        `<li class="is-flagged"><b>${esc(x.area.name)}</b> — ${esc(DOW[data.dates.indexOf(d.date)])} ${GAP_LABEL[g.kind]} ${esc(span(g))}</li>`))).join("") : "");
    const warn = !!result.newWarnings?.length;
    els.dlgWarnWrap.hidden = !warn; els.dlgWarn.checked = false; els.dlgGo.disabled = warn;
    els.dlgWarn.onchange = () => { els.dlgGo.disabled = !els.dlgWarn.checked; };
    return new Promise((resolve) => {
      els.dlg.addEventListener("close", () => resolve(els.dlg.returnValue === "save" ? { allowWarnings: warn && els.dlgWarn.checked } : null), { once: true });
      els.dlg.returnValue = ""; els.dlg.showModal();
    });
  }

  async function save(list, { result, what, undoOf = null }) {
    const ok = await confirmSave(list, result, what); if (!ok) return false;
    setBusy(true, "Saving to the scheduler, then reading it back…");
    try {
      const r = await send("save", { changes: list, allowWarnings: ok.allowWarnings, undoOf }); if (!r.ok) throw new Error(r.error);
      if (!r.result.saved) throw new Error(`Not saved — ${r.result.why}`);
      const bad = (r.result.saveStatus || []).filter((s) => s.status !== "SUCCESS");
      const miss = r.entry.misses || [];
      if (bad.length || miss.length) console.warn("[scheduleright] save detail", { saveStatus: bad, misses: miss });
      host.ui.toast(`Saved ${r.result.applied.length} change(s)${bad.length || miss.length ? ` — ${bad.length + miss.length} need a look` : ""}.`, { kind: bad.length || miss.length ? "error" : "ok", durationMs: 8000 });
      history = [r.entry, ...history.filter((h) => h.id !== r.entry.id)];
      if (undoOf) { const src = history.find((h) => h.id === undoOf); if (src) src.undoneAt = r.entry.at; }
      renderHistory();
      return true;
    } catch (e) { status(e.message, "error"); return false; }
    finally { if (alive) setBusy(false); }
  }

  async function saveQueue() {
    if (busy || !canSubmit()) return;
    if (data.fromCache) { await load({ wk: data.ctx.wk, fresh: true }); if (!data || data.fromCache || !canSubmit()) return; }
    if (!check || check.sig !== sig()) { const r = await validate(); if (!r || r.error) return; }
    if (!canSave()) { status("The scheduler flagged some changes — see the marked lines, fix or remove them, then Submit again.", "error"); return; }
    const list = queue.slice();
    if (await save(list, { result: check.result, what: `${list.length} change(s) to store ${data.ctx.store}, WK ${data.ctx.wk}. An undo entry is kept under Saved changes.` })) {
      setQueue([]); await load({ wk: data.ctx.wk, fresh: true });
    }
  }

  async function undo(id) {
    const h = history.find((x) => x.id === id); if (!h) return;
    if (!data || String(data.ctx.wk) !== String(h.wk) || data.fromCache) { await load({ wk: h.wk, fresh: true }); if (!data || String(data.ctx.wk) !== String(h.wk) || data.fromCache) return; }
    const result = await validate(h.undo); if (!result || result.error) return;
    if (result.hard?.length || result.skipped?.length) {
      status(`Undo can't be built cleanly: ${[...(result.skipped || []).map((s) => s.why), ...(result.hard || []).map((x) => `${x.name}: ${x.code} ${x.message}`)].join(" · ")}. The schedule may have been changed since.`, "error");
      return;
    }
    if (await save(h.undo, { result, what: `Put back the ${h.applied.length} change(s) saved ${new Date(h.at).toLocaleString()} (WK ${h.wk}).`, undoOf: id })) await load({ wk: h.wk, fresh: true });
  }

  function download(name, obj) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 1)], { type: "application/json" }));
    a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ── suggest ───────────────────────────────────────────────────────────────
  // Fit (+ extra hours), checked with the scheduler before queuing: anyone the validator
  // returns HARD for is left as saved and the fit re-runs (lib/fitclean.js).
  async function runSuggest() {
    if (busy) return;
    const rules = parseRules(els.rules.value);
    if (rules.errors.length) { status(`People rules: ${rules.errors.join(" · ")}`, "error"); return; }
    setBusy(true, "Fitting shifts to guidance…");
    await new Promise((r) => setTimeout(r, 30));   // let the status paint before the CPU-bound run
    let res;
    try {
      const t0 = performance.now();
      const extra = Math.max(0, +els.addN.value || 0);   // extra hours on top of the fitted week (0 = fit only)
      res = await fitClean(data,
        { roleId: roleId(), jobs: jobs(), rules, floorPct: (+els.floor.value || 85) / 100, matchBonus: +els.bonus.value,
          allowDayMoves: els.daymoves.checked, allowExtend: els.extend.checked, editableFrom: tomorrow(), areas: activeAreas(), roleJobs: roleJobs(), neighbors },
        extra > 0 ? { roleId: roleId(), jobs: jobs(), roleJobs: roleJobs(), extra, neighbors, editableFrom: tomorrow(),
          weekendBoost: +els.addWkend.value, peakBoost: +els.addPeak.value, allowExtend: els.extend.checked } : null,
        async (list) => { const r = await send("validate", { changes: list }); return r.ok ? r.result : { error: r.error }; },
        (t) => status(t, "busy"));
      if (!alive) return;
      if (res.error) { status(`Couldn't check the suggestion with the scheduler (${res.error}), so nothing was queued. Try again.`, "error"); return; }
      const { out, add } = res;
      const replaced = queue.length;
      setQueue(res.changes);
      if (res.check && !res.leftover) { check = { sig: sig(), result: res.check }; renderQueue(); }
      {
        const s = out.stats;
        els.suggestOut.textContent = `${res.changes.length} change(s), checked with the scheduler${res.held.length ? ` · ${res.held.length} associate(s) left as saved` : ""}${add ? ` · +${f2(add.stats.added)} of ${extra} extra h (${add.stats.created} new, ${add.stats.extended} stretched)` : ""} · fit: blue hours ${s.blueBefore} → ${s.blueAfter} · ${s.dayMoves} day move(s) · ${s.stretched} stretched · ${s.added} shift(s) added${activeAreas().length && (s.areaGapHrsBefore || s.areaGapHrsAfter) ? ` · area gaps ${f2(s.areaGapHrsBefore)} → ${f2(s.areaGapHrsAfter)} h` : ""} · ${Math.round(performance.now() - t0)} ms${replaced ? ` · replaced ${replaced} queued` : ""}`;
        const unk = unknownNames(rules, data.workers);
        const byRole = out.roles.length > 1 ? out.roles.filter((r) => r.blueBefore !== r.blueAfter).map((r) => `<li>${esc(roleName(r.roleId))}: blue hours ${r.blueBefore} → ${r.blueAfter}</li>`) : [];
        const heldNotes = res.held.map((h) => `<li class="ds-k-under"><b>${esc(h.name || h.workerId)}</b> left as saved — the scheduler refused: ${esc(h.why)}</li>`);
        const addNotes = add ? [`<li>Extra hours by day: ${add.stats.byDay.map((x, i) => `${DOW[i]} +${f2(x)}`).join(" · ")}</li>`, ...(add.stats.stopWhy ? [`<li class="ds-k-under">Extra hours stopped at ${f2(add.stats.added)} of ${extra}: ${esc(add.stats.stopWhy)}</li>`] : [])] : [];
        els.notes.innerHTML = [...heldNotes, ...addNotes, ...byRole, ...unk.map((u) => `<li>rule names “${esc(u)}”, who isn't on this week's roster</li>`),
          ...out.turnarounds.filter((t) => t.restH < 12).map((t) => `<li class="${t.restH < 10 ? "ds-k-under" : "ds-muted"}"><b>${esc(t.name)}</b>: only ${f2(t.restH)} h off before ${t.day === "next week" ? "next week's first shift" : `${esc(DOW[data.dates.indexOf(t.day)])} ${esc(t.start)}`}${t.restH < 8 ? " (under the legal 8 h)" : ""}</li>`),
          ...out.hours.filter((h) => h.after !== h.before).map((h) => `<li><b>${esc(h.name)}</b>: ${f2(h.before)} → ${f2(h.after)} paid h this week</li>`),
          ...out.hours.filter((h) => h.why).map((h) => `<li><b>${esc(h.name)}</b> (full-time) at ${f2(h.after)} h${h.pto ? ` + ${h.pto} PTO day(s)` : ""}, target ${f2(h.target)}: ${esc(h.why)}</li>`),
          ...out.notes.map((n) => `<li><b>${esc(n.names.join(" + "))}</b> ${esc(DOW[data.dates.indexOf(n.day)])} ${esc(n.shift)}: ${esc(n.why)}</li>`)].join("");
        const nNotes = els.notes.children.length, nw = container.querySelector("#digitalschedule-notes-wrap");
        nw.hidden = !nNotes; container.querySelector("#digitalschedule-notes-sum").textContent = `Details (${nNotes})`;
        status(res.leftover ? "Suggestion queued, but the scheduler still flags some lines — they're marked. Remove them before submitting."
          : res.changes.length ? "Suggestion queued and checked with the scheduler: no hard errors. Review it in the grid, then Submit changes."
          : "No change improves the fit under these rules.");
      }
    } catch (e) { status(`Fit failed: ${e.message}`, "error"); }
    finally { if (alive) setBusy(false); }
  }

  // ── events ────────────────────────────────────────────────────────────────
  els.bar.addEventListener("submit", (e) => { e.preventDefault(); const wk = els.wk.value.trim(); if (wk && (!data || String(data.ctx.wk) !== wk)) load({ wk }); else if (!wk) load(); });
  // Reload: the shown week, fresh; with nothing shown, whatever week the scheduler tab is on
  els.reload.addEventListener("click", () => load(data ? { wk: data.ctx.wk, fresh: true } : {}));
  els.saved.addEventListener("click", (e) => { const wk = e.target.closest("[data-wk]")?.dataset.wk; if (wk && !busy) load({ wk }); });
  els.show.addEventListener("click", async () => { const r = await send("open_tab"); if (!r.ok) status(r.error, "error"); });
  const scopeChanged = () => { fillScope(); savePrefs(); if (data) render(); };
  els.wg.addEventListener("change", () => { scope = { wg: els.wg.value, team: "", role: "", jobs: null }; scopeChanged(); });
  els.team.addEventListener("change", () => {
    // picking a team under "Whole store" selects its workgroup too
    const g = tree().find((x) => x.teams.some((t) => String(t.id) === els.team.value));
    scope = { wg: els.team.value && g ? String(g.id) : scope.wg, team: els.team.value, role: "", jobs: null }; scopeChanged(); });
  els.role.addEventListener("change", () => { scope = { ...scope, role: els.role.value, jobs: null }; scopeChanged(); });
  els.joblist.addEventListener("change", () => {
    const on = [...els.joblist.querySelectorAll("input:checked")].map((x) => x.value);
    scope = { ...scope, jobs: on.length === jobsAvailable().length ? null : on }; fillJobs(); savePrefs(); if (data) render(); });
  els.jobpick.addEventListener("click", (e) => {
    const p = e.target.closest("[data-pick]")?.dataset.pick; if (!p) return;
    scope = { ...scope, jobs: p === "all" ? null : [] }; fillJobs(); savePrefs(); if (data) render(); });
  const closeDd = (e) => { if (els.jobpick.open && !els.jobpick.contains(e.target)) els.jobpick.open = false; };
  document.addEventListener("click", closeDd);
  for (const x of [els.floor, els.bonus, els.daymoves, els.extend]) x.addEventListener("change", savePrefs);
  els.rules.addEventListener("input", () => { host.storage.local.set("rules", els.rules.value).catch(() => {}); renderRulesState(); queuePush(); });
  pullShared();
  els.preview.addEventListener("change", renderCoverage);
  els.filter.addEventListener("input", renderRoster);
  els.all.addEventListener("change", renderRoster);
  els.changedOnly.addEventListener("change", renderRoster);
  els.validate.addEventListener("click", () => { if (queue.length) validate(); else status("Nothing queued to check."); });
  els.save.addEventListener("click", saveQueue);
  els.revert.addEventListener("click", () => { const h = lastSubmit(); if (h && !busy) undo(h.id); });
  els.clear.addEventListener("click", () => { setQueue([]); els.suggestOut.textContent = ""; els.notes.innerHTML = ""; });
  els.exportBtn.addEventListener("click", () => { if (data && queue.length) download(`wfm-${data.ctx.store}-WK${data.ctx.wk}-changes.json`, queue); });
  els.suggest.addEventListener("click", () => { if (data && !busy) runSuggest(); });
  els.queue.addEventListener("click", (e) => { const i = e.target.closest("[data-del]")?.dataset.del; if (i != null) { const n = queue.slice(); n.splice(+i, 1); setQueue(n); } });
  els.history.addEventListener("click", (e) => {
    const u = e.target.closest("[data-undo]")?.dataset.undo; if (u && !busy) return undo(u);
    const d = e.target.closest("[data-hist]")?.dataset.hist; const h = d && history.find((x) => x.id === d);
    if (h) download(`wfm-${h.store}-WK${h.wk}-${h.at.replace(/[:.]/g, "-")}.json`, h);
  });
  els.roster.addEventListener("click", (e) => {
    if (busy) return;
    const b = e.target.closest(".ds-shift");
    if (b) return openEditor({ w: b.dataset.w, di: +b.dataset.day, from: b.dataset.from, job: b.dataset.job, qIdx: b.dataset.q != null ? +b.dataset.q : null });
    const td = e.target.closest(".ds-cell"); if (td) openEditor({ w: td.dataset.w, di: +td.dataset.day });
  });

  // ── schedule assistant ────────────────────────────────────────────────────
  const closeChat = mountChat(host, container, {
    data: () => data,
    weekKey: () => (data ? `${data.ctx.store}-${data.ctx.wk}` : null),
    queue: () => queue,
    setQueue: (next) => setQueue(next),
    roleId, jobs, scopeLabel,
    rulesText: () => els.rules.value,
    fitOpts: () => ({ roleId: roleId(), jobs: jobs(), floorPct: (+els.floor.value || 85) / 100, matchBonus: +els.bonus.value,
      allowDayMoves: els.daymoves.checked, allowExtend: els.extend.checked, editableFrom: tomorrow(), areas: activeAreas(), roleJobs: roleJobs(), neighbors }),
    areas: activeAreas,
    pastWeeks: async () => {
      if (!data) return [];
      const ents = weekIndex.filter((x) => x.store === String(data.ctx.store) && x.weekStart < data.ctx.weekStart).sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1));
      return (await Promise.all(ents.map((e) => host.storage.local.get(wKey(e.store, e.wk)).catch(() => null)))).filter(Boolean);
    },
    validate: async () => (busy ? { error: "the page is busy with another scheduler call" } : validate()),
    // a list that isn't the queue (fitClean's proposal): no page busy state, nothing rendered
    validateList: async (list) => { const r = await send("validate", { changes: list }); return r.ok ? r.result : { error: r.error }; },
  });

  // ── boot ──────────────────────────────────────────────────────────────────
  send("history").then((r) => { if (alive && r.ok) { history = r.entries; if (data) renderHistory(); } });
  renderSaved();
  const lastWk = prefs.lastWk && cachedEntry(prefs.lastWk) ? prefs.lastWk : [...weekIndex].sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1))[0]?.wk;
  if (lastWk) await load({ wk: lastWk });
  else status("Type a WK number and press Load week, or Reload to read the week the scheduler tab is on.");

  return () => { alive = false; unwatchQueue(); if (pushTimer) { clearTimeout(pushTimer); pushShared(); } closeChat(); document.removeEventListener("click", closeDd); link.remove(); };
}
