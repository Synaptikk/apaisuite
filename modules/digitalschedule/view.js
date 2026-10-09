// modules/digitalschedule/view.js
//
// Digital Schedule — shell page. Load a week (service.js::week/read), draw the
// coverage grid and the roster from that read, keep a queue of shift changes
// (hand edits from the roster, or lib/suggest.js's fit to guidance), preview
// them locally (lib/coverage.js::applyChanges), check them with the scheduler's
// validator, save after an explicit confirm, undo a save from its history entry.
//
// Kept in browser storage: the queue (per store + week), the people rules,
// the fitter options and the role/jobs choice. The schedule itself is re-read
// from the scheduler every time.

import { ROLES, ROLE_JOBS, DOW, toMin, fmt12, coverage, summarize, hourState, applyChanges, describe, paidHours, IN_HOME_JOB } from "./lib/coverage.js";
import { parseRules, unknownNames } from "./lib/rules.js";
import { suggest } from "./lib/suggest.js";
import { mountChat } from "./chat_view.js";
import { chartSvg, hourTip, movesFromQueue, tally, offBy, totals, dayLabel, f2 } from "./lib/graph.js";

const LONG = { timeoutMs: 330_000 };
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
    where: $("where"), bar: $("bar"), wk: $("wk"), go: $("go"), reload: $("reload"), show: $("show"), role: $("role"), jobs: $("jobs"),
    msg: $("msg"), main: $("main"), days: $("days"), cov: $("cov"), preview: $("preview"),
    qcount: $("qcount"), queue: $("queue"), check: $("check"), validate: $("validate"), save: $("save"), revert: $("revert"), submitState: $("submit-state"), exportBtn: $("export"), clear: $("clear"),
    floor: $("floor"), bonus: $("bonus"), daymoves: $("daymoves"), extend: $("extend"), rules: $("rules"), rulesState: $("rules-state"),
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
  for (const [id, name] of Object.entries(ROLES)) els.role.insertAdjacentHTML("beforeend", `<option value="${id}">${esc(name)}</option>`);
  const prefs = (await host.storage.local.get("prefs").catch(() => null)) || {};
  els.role.value = String(prefs.roleId || 1000271);
  els.jobs.value = prefs.jobs || (ROLE_JOBS[els.role.value] || []).join(",");
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
    roleId: +els.role.value, jobs: els.jobs.value.trim(), floor: +els.floor.value, bonus: +els.bonus.value,
    daymoves: els.daymoves.checked, extend: els.extend.checked }).catch(() => {});

  const roleId = () => +els.role.value;
  const jobs = () => els.jobs.value.split(",").map((s) => s.trim()).filter(Boolean);
  const qKey = () => data ? `queue.${data.ctx.store}.${data.ctx.wk}` : null;
  const persistQueue = () => { if (qKey()) host.storage.local.set(qKey(), queue).catch(() => {}); };

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
  async function load({ wk = null } = {}) {
    if (busy) return;
    setBusy(true, wk ? `Selecting WK ${wk} in the scheduler…` : "Reading the week from the scheduler (can take a minute)…");
    try {
      if (wk) { const r = await send("week", { wk }); if (!r.ok) throw new Error(r.error); }
      if (wk) status("Reading the week from the scheduler…", "busy");
      const r = await send("read"); if (!r.ok) throw new Error(r.error);
      if (!alive) return;
      data = r.data;
      els.wk.value = data.ctx.wk;
      queue = (await host.storage.local.get(qKey()).catch(() => null)) || [];
      check = null;
      status("");
      render();
    } catch (e) { status(e.message, "error"); }
    finally { if (alive) setBusy(false); }
  }

  // ── render ────────────────────────────────────────────────────────────────
  const preview = () => (queue.length ? applyChanges(data, queue) : { data, problems: [] });

  function render() {
    if (!data) { els.main.hidden = true; return; }
    els.main.hidden = false;
    const c = data.ctx;
    els.where.innerHTML = `<b>Store ${esc(c.store)}</b> · WK ${esc(c.wk)} · ${esc(c.weekStart)} – ${esc(c.weekEnd)}`;
    renderCoverage(); renderQueue(); renderRoster(); renderHistory(); renderRulesState();
  }

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

  function renderCoverage() {
    renderGraph();
    const now = coverage(data, roleId(), jobs());
    const pv = preview();
    const next = els.preview.checked && queue.length ? coverage(pv.data, roleId(), jobs()) : now;
    const sNow = summarize(now), sNext = summarize(next);
    const delta = (a, b, dp = 0, good = 1) => a === b ? "" : `<span class="ds-delta ${(b - a) * good > 0 ? "up" : "down"}">${b > a ? "+" : ""}${(b - a).toFixed(dp)}</span>`;
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
    if (hi < 0) { els.cov.innerHTML = `<tr><td class="ds-muted">No guidance or shifts for this role — check the role and job codes.</td></tr>`; return; }
    let html = `<thead><tr><th></th>${DOW.map((d, i) => `<th class="${i < 2 ? "is-weekend" : ""}">${d}</th>`).join("")}</tr></thead><tbody>`;
    for (let h = lo; h <= hi; h++) {
      html += `<tr><th class="${h >= 12 && h < 16 ? "is-peak" : ""}">${fmt12(h * 60)}</th>`;
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
      queue.forEach((ch, i) => { const w = data.workers.find((x) => x.name === ch.name || x.workerId === ch.workerId); const v = w && byW.get(w.workerId); if (v && !flagged.has(i)) flagged.set(i, v.join(" · ")); });
    }
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
    const rows = pv.workers.filter((w) => (els.all.checked || w.shifts.some((s) => js.includes(s.job)) || touched.has(w.name.toLowerCase()))
      && (!q || w.name.toLowerCase().includes(q))).sort((a, b) => a.name.localeCompare(b.name));
    let html = `<thead><tr><th>Associate</th>${DOW.map((d, i) => `<th class="${i < 2 ? "is-weekend" : ""}">${d} <small>${esc(data.dates[i].slice(5))}</small></th>`).join("")}<th>Paid h</th></tr></thead><tbody>`;
    for (const w of rows) {
      const inHome = String(w.job || "").includes(IN_HOME_JOB) || w.shifts.some((s) => s.job === IN_HOME_JOB);
      const tags = [w.payType && `<span class="ds-tag">${esc(w.payType)}</span>`, /minor/i.test(String(w.minor ?? "")) && `<span class="ds-tag warn">minor</span>`, inHome && `<span class="ds-tag">In Home</span>`].filter(Boolean).join("");
      html += `<tr><th><div class="ds-name">${esc(w.name)}</div>${tags}</th>`;
      for (let di = 0; di < 7; di++) {
        const day = data.dates[di];
        const ss = w.shifts.filter((s) => s.day === day).sort((a, b) => toMin(a.start) - toMin(b.start));
        const other = (w.otherEvents || []).filter((e) => e.day === day).map((e) => `<span class="ds-tag">${esc(e.type)}</span>`).join("");
        const cells = ss.map((s) => {
          const brk = (s.breaks || []).filter((b) => !b.paid).map((b) => `lunch ${fmt12(toMin(b.start))}`).join(", ");
          return `<button type="button" class="ds-shift ${js.includes(s.job) ? "" : "is-other"} ${s.changed ? "is-changed" : ""}" data-w="${esc(w.workerId)}" data-day="${di}" data-from="${esc(s.start)}" data-job="${esc(s.job)}" ${s.qIdx != null ? `data-q="${s.qIdx}"` : ""}
            title="${esc(`${s.job}${brk ? " · " + brk : ""}`)}">${fmt12(toMin(s.start))}–${fmt12(toMin(s.end))}${brk ? `<small>${esc(brk)}</small>` : ""}${js.includes(s.job) ? "" : `<small>${esc(s.job)}</small>`}</button>`; }).join("");
        html += `<td class="ds-cell ${di < 2 ? "is-weekend" : ""}" data-w="${esc(w.workerId)}" data-day="${di}">${cells}${other}${!ss.length && !other ? `<span class="ds-add">+</span>` : ""}<div class="ds-avail">${esc(availText(w, di))}</div></td>`;
      }
      const total = w.shifts.reduce((a, s) => a + paidHours(s), 0);
      html += `<td class="ds-num-cell">${total.toFixed(2)}</td></tr>`;
    }
    els.roster.innerHTML = html + (rows.length ? "" : `<tr><td colspan="9" class="ds-muted">Nobody with ${esc(js.join(", ") || "these jobs")} shifts this week.</td></tr>`) + "</tbody>";
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
  function setQueue(next) { queue = next; check = null; persistQueue(); renderCoverage(); renderQueue(); renderRoster(); }

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
        ${isCreate ? `<label class="ds-field">Job <input class="input ds-jobs" data-f="job" value="${esc(existingQ?.job || jobs()[0] || "")}"></label>` : ""}
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
      if (isCreate) ch = { ...base, action: "create", day, job: f("job").value.trim() || jobs()[0], ...t };
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
      + (result.newWarnings || []).map((x) => `<li class="is-flagged"><b>${esc(x.name || x.workerId)}</b> — ${esc(x.message)}</li>`).join("");
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
      if (bad.length || miss.length) console.warn("[digitalschedule] save detail", { saveStatus: bad, misses: miss });
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
    if (!check || check.sig !== sig()) { const r = await validate(); if (!r || r.error) return; }
    if (!canSave()) { status("The scheduler flagged some changes — see the marked lines, fix or remove them, then Submit again.", "error"); return; }
    const list = queue.slice();
    if (await save(list, { result: check.result, what: `${list.length} change(s) to store ${data.ctx.store}, WK ${data.ctx.wk}. An undo entry is kept under Saved changes.` })) {
      setQueue([]); await load();
    }
  }

  async function undo(id) {
    const h = history.find((x) => x.id === id); if (!h) return;
    if (!data || String(data.ctx.wk) !== String(h.wk)) { await load({ wk: h.wk }); if (!data || String(data.ctx.wk) !== String(h.wk)) return; }
    const result = await validate(h.undo); if (!result || result.error) return;
    if (result.hard?.length || result.skipped?.length) {
      status(`Undo can't be built cleanly: ${[...(result.skipped || []).map((s) => s.why), ...(result.hard || []).map((x) => `${x.name}: ${x.code} ${x.message}`)].join(" · ")}. The schedule may have been changed since.`, "error");
      return;
    }
    if (await save(h.undo, { result, what: `Put back the ${h.applied.length} change(s) saved ${new Date(h.at).toLocaleString()} (WK ${h.wk}).`, undoOf: id })) await load();
  }

  function download(name, obj) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 1)], { type: "application/json" }));
    a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ── suggest ───────────────────────────────────────────────────────────────
  function runSuggest() {
    const rules = parseRules(els.rules.value);
    if (rules.errors.length) { status(`People rules: ${rules.errors.join(" · ")}`, "error"); return; }
    status("Fitting shifts to guidance…", "busy");
    setTimeout(() => {   // let the status paint before the CPU-bound run
      try {
        const t0 = performance.now();
        const out = suggest(data, { roleId: roleId(), jobs: jobs(), rules, floorPct: (+els.floor.value || 85) / 100, matchBonus: +els.bonus.value,
          allowDayMoves: els.daymoves.checked, allowExtend: els.extend.checked, editableFrom: tomorrow() });
        const replaced = queue.length;
        setQueue(out.changes);
        const s = out.stats;
        els.suggestOut.textContent = `${out.changes.length} change(s) · blue hours ${s.blueBefore} → ${s.blueAfter} · ${s.dayMoves} day move(s) · ${s.stretched} stretched · ${Math.round(performance.now() - t0)} ms${replaced ? ` · replaced ${replaced} queued` : ""}`;
        const unk = unknownNames(rules, data.workers);
        els.notes.innerHTML = [...unk.map((u) => `<li>rule names “${esc(u)}”, who isn't on this week's roster</li>`),
          ...out.notes.map((n) => `<li><b>${esc(n.names.join(" + "))}</b> ${esc(DOW[data.dates.indexOf(n.day)])} ${esc(n.shift)}: ${esc(n.why)}</li>`)].join("");
        status(out.changes.length ? "Suggestion queued. Review it in the grid, then Verify or Submit changes." : "No change improves the fit under these rules.");
      } catch (e) { status(`Fit failed: ${e.message}`, "error"); }
    }, 30);
  }

  // ── events ────────────────────────────────────────────────────────────────
  els.bar.addEventListener("submit", (e) => { e.preventDefault(); const wk = els.wk.value.trim(); load(wk && (!data || String(data.ctx.wk) !== wk) ? { wk } : {}); });
  els.reload.addEventListener("click", () => load());
  els.show.addEventListener("click", async () => { const r = await send("open_tab"); if (!r.ok) status(r.error, "error"); });
  els.role.addEventListener("change", () => { const j = ROLE_JOBS[els.role.value]; if (j) els.jobs.value = j.join(","); savePrefs(); if (data) render(); });
  els.jobs.addEventListener("change", () => { savePrefs(); if (data) render(); });
  for (const x of [els.floor, els.bonus, els.daymoves, els.extend]) x.addEventListener("change", savePrefs);
  els.rules.addEventListener("input", () => { host.storage.local.set("rules", els.rules.value).catch(() => {}); renderRulesState(); });
  els.preview.addEventListener("change", renderCoverage);
  els.filter.addEventListener("input", renderRoster);
  els.all.addEventListener("change", renderRoster);
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
    roleId, jobs,
    rulesText: () => els.rules.value,
    fitOpts: () => ({ roleId: roleId(), jobs: jobs(), floorPct: (+els.floor.value || 85) / 100, matchBonus: +els.bonus.value,
      allowDayMoves: els.daymoves.checked, allowExtend: els.extend.checked, editableFrom: tomorrow() }),
    validate: async () => (busy ? { error: "the page is busy with another scheduler call" } : validate()),
  });

  // ── boot ──────────────────────────────────────────────────────────────────
  send("history").then((r) => { if (alive && r.ok) { history = r.entries; if (data) renderHistory(); } });
  status("Type a WK number and press Load week, or Reload to read the week the scheduler tab is on.");

  return () => { alive = false; closeChat(); link.remove(); };
}
