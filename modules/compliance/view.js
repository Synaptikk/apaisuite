// modules/compliance/view.js
//
// Compliance Tasks — shell page. Paints the last pull at once, then refreshes
// from Enviance (service.js::pull). Four views over one data set:
//   Calendar          month grid: due dates, the 10th-of-month "aim" marker,
//                     projected tasks Enviance has not created yet
//   Tasks             the month's tasks; each open one expands into the
//                     fill-in panel (Save to Enviance / Complete and close)
//   What to key in    per form: what changes each time vs the store's
//                     standard answers; paper copy to print
//   Past submissions  the last completions per form, odd answers highlighted

import { buildCalendar, monthGrid } from "./lib/schedule.js";
import { defaultValues, toEnter, deviations, followUps } from "./lib/forms.js";

const STATUS = { done: "Done", late: "Done late", open: "Open", pastTarget: "Past the 10th", overdue: "Overdue", upcoming: "Not created yet" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const parse = (s) => (s ? new Date(String(s).replace(/Z$/, "")) : null);
const fmtDay = (s) => { const d = parse(s); return d ? d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : ""; };
const fmtWhen = (s) => { const d = parse(s); return d ? d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""; };
const join = (v) => (v || []).filter((x) => x !== null && x !== "").join(" / ");

export async function mount(host, container) {
  const esc = host.ui.escapeHtml;
  const link = document.createElement("link");
  link.rel = "stylesheet"; link.href = host.url("styles.css"); link.dataset.module = host.id;
  const cssReady = new Promise((resolve) => {
    link.addEventListener("load", resolve, { once: true });
    link.addEventListener("error", resolve, { once: true });
    setTimeout(resolve, 3000);
  });
  document.head.appendChild(link);
  await cssReady;
  container.innerHTML = await fetch(host.url("view.html")).then((r) => r.text());

  const $ = (sel) => container.querySelector(sel);
  const els = {
    facility: $("#compliance-facility"), refresh: $("#compliance-refresh"), portal: $("#compliance-portal"),
    status: $("#compliance-status"), summary: $("#compliance-summary"), stale: $("#compliance-stale"),
    month: $("#compliance-month"), prev: $("#compliance-prev"), next: $("#compliance-next"), grid: $("#compliance-grid"),
    tasks: $("#compliance-tasks"), forms: $("#compliance-forms"), history: $("#compliance-history"),
  };

  let alive = true;
  let data = null;          // last pull
  let cal = [];             // calendar-decorated tasks
  const today = new Date();
  let view = { y: today.getFullYear(), m: today.getMonth() };
  let openTask = null;      // task id whose fill panel is expanded
  const drafts = new Map(); // task id → values being edited
  let busy = false;         // a refresh (pull) is running
  let saving = false;       // a submit is running; separate so a background
                            // refresh never swallows a click on Complete

  function status(kind, text) {
    els.status.hidden = !text;
    els.status.className = `cp-status ${kind || ""}`;
    els.status.textContent = text || "";
  }

  // ── tabs ──────────────────────────────────────────────────────────
  function selectTab(name) {
    container.querySelectorAll(".cp-tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
    for (const p of ["calendar", "tasks", "forms", "history"]) $(`#compliance-panel-${p}`).hidden = p !== name;
  }
  container.querySelectorAll(".cp-tab").forEach((b) => b.addEventListener("click", () => selectTab(b.dataset.tab)));

  // ── paint ─────────────────────────────────────────────────────────
  function paint() {
    if (!data?.ok) { els.summary.innerHTML = ""; els.grid.innerHTML = ""; return; }
    cal = buildCalendar(data.tasks, { now: new Date(), until: new Date(today.getFullYear(), today.getMonth() + 3, 0, 23, 59) });
    els.portal.href = data.portalUrl;
    paintSummary(); paintCalendar(); paintTasks(); paintForms(); paintHistory();
    const stale = data.staleOpen || [];
    els.stale.hidden = !stale.length;
    els.stale.innerHTML = stale.length
      ? `<b>${stale.length} old task${stale.length === 1 ? " is" : "s are"} still open in Enviance</b>: ` +
        stale.map((t) => `<a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.name)} due ${esc(fmtDay(t.due))} ${esc(String(parse(t.due)?.getFullYear() || ""))}</a>`).join(", ")
      : "";
  }

  function inMonth(t, y, m) { const d = parse(t.due); return d && d.getFullYear() === y && d.getMonth() === m; }

  function paintSummary() {
    const now = new Date();
    const month = cal.filter((t) => inMonth(t, now.getFullYear(), now.getMonth()) && t.cadence === "monthly");
    const done = month.filter((t) => t.status === "done" || t.status === "late");
    const open = cal.filter((t) => !t.projected && t.isopen);
    const overdue = open.filter((t) => t.status === "overdue");
    const pastTarget = open.filter((t) => t.status === "pastTarget");
    const next = open.filter((t) => t.status !== "overdue").sort((a, b) => (a.due < b.due ? -1 : 1))[0];
    const target = new Date(now.getFullYear(), now.getMonth(), 10);
    const daysToTarget = Math.ceil((target - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86_400_000);
    const tile = (n, l, s, cls = "") => `<div class="cp-sum ${cls}"><span class="cp-sum-n">${n}</span><span class="cp-sum-l">${esc(l)}</span><span class="cp-sum-s">${s}</span></div>`;
    els.summary.innerHTML =
      tile(`${done.length}/${month.length}`, `${MONTHS[now.getMonth()]} monthly tasks done`,
        daysToTarget >= 0 ? `${daysToTarget === 0 ? "Today is" : `${daysToTarget} day${daysToTarget === 1 ? "" : "s"} to`} the 10th` : "Past the 10th", done.length < month.length && daysToTarget < 0 ? "warn" : "") +
      tile(open.length, "Open in Enviance", next ? `Next: ${esc(next.name)}, ${esc(fmtWhen(next.due))}` : "Nothing open") +
      tile(pastTarget.length, "Past the 10th, not done", pastTarget.map((t) => esc(t.name)).join(", ") || "None", pastTarget.length ? "warn" : "") +
      tile(overdue.length, "Overdue", overdue.map((t) => esc(t.name)).join(", ") || "None", overdue.length ? "bad" : "");
  }

  function chip(t, kind) {
    const cls = kind === "target" ? "k-target" : `s-${t.status}`;
    const label = kind === "target" ? `aim: ${t.name}` : t.name;
    const title = `${t.name}\n${STATUS[t.status]}${t.completedBy ? ` by ${t.completedBy}` : ""}\nDue ${fmtWhen(t.due)}${t.target && kind !== "target" && t.cadence === "monthly" ? `\nAim for ${fmtDay(t.target)}` : ""}`;
    return `<button class="cp-chip ${cls}" data-task="${esc(t.id)}" title="${esc(title)}">${esc(label.replace(/^(Weekly|Monthly) /, ""))}</button>`;
  }

  function paintCalendar() {
    els.month.textContent = `${MONTHS[view.m]} ${view.y}`;
    const weeks = monthGrid(view.y, view.m, cal);
    const todayKey = new Date().toLocaleDateString("en-CA");
    els.grid.innerHTML =
      `<div class="cp-dow">${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => `<span>${d}</span>`).join("")}</div>` +
      weeks.map((w) => `<div class="cp-week">${w.map((d) => `
        <div class="cp-day${d.inMonth ? "" : " out"}${d.date === todayKey ? " today" : ""}${d.day === 10 && d.inMonth ? " tenth" : ""}">
          <span class="cp-daynum">${d.day}${d.day === 10 && d.inMonth ? ' <small>target</small>' : ""}</span>
          ${d.items.map((i) => chip(i.task, i.kind)).join("")}
        </div>`).join("")}</div>`).join("");
  }

  function paintTasks() {
    const list = cal.filter((t) => inMonth(t, view.y, view.m) || (!t.projected && t.isopen))
      .filter((t, i, a) => a.findIndex((x) => x.id === t.id) === i)
      .sort((a, b) => (a.isopen === b.isopen ? (a.due < b.due ? -1 : 1) : a.isopen ? -1 : 1));
    if (!list.length) { els.tasks.innerHTML = `<p class="cp-empty">No tasks in ${MONTHS[view.m]}.</p>`; return; }
    els.tasks.innerHTML = `<table class="cp-table"><thead><tr><th>Task</th><th>Due</th><th>Aim for</th><th>Status</th><th>Done by</th><th></th></tr></thead><tbody>${
      list.map((t) => {
        const type = data.types[t.type];
        const canFill = !t.projected && t.isopen && type?.form;
        return `<tr class="${openTask === t.id ? "open" : ""}">
          <td><b>${esc(t.name)}</b><div class="cp-muted">${esc(t.uid || "")}${t.projected ? " · Enviance creates it closer to the due date" : ""}</div></td>
          <td class="cp-when">${esc(fmtWhen(t.due))}</td>
          <td class="cp-when">${t.cadence === "monthly" ? esc(fmtDay(t.target)) : ""}</td>
          <td><span class="cp-chip s-${t.status}">${STATUS[t.status]}</span>${t.metTarget === false && t.cadence === "monthly" ? ' <span class="cp-muted">after the 10th</span>' : ""}</td>
          <td>${t.isopen ? "" : `${esc(t.completedBy || "")}<div class="cp-muted">${esc(fmtWhen(t.closed))}</div>`}</td>
          <td class="cp-actions">
            ${canFill ? `<button class="btn btn-primary btn-sm" data-fill="${esc(t.id)}">${openTask === t.id ? "Close" : "Fill in"}</button>` : ""}
            ${type?.form ? `<button class="btn btn-secondary btn-sm" data-paper="${esc(t.id)}">Paper copy</button>` : ""}
            ${t.url && !t.projected ? `<a class="btn btn-secondary btn-sm" href="${esc(t.url)}" target="_blank" rel="noopener">Enviance</a>` : ""}
          </td></tr>
          ${openTask === t.id ? `<tr class="cp-fillrow"><td colspan="6">${fillPanel(t)}</td></tr>` : ""}`;
      }).join("")}</tbody></table>`;
  }

  // ── fill-in panel ─────────────────────────────────────────────────
  function valuesFor(t) {
    if (!drafts.has(t.id)) drafts.set(t.id, defaultValues(data.types[t.type].form, t.answers || {}, new Date()));
    return drafts.get(t.id);
  }

  function input(f, vals) {
    const v = vals[f.name] || [];
    const name = `data-field="${esc(f.name)}"`;
    if (f.kind === "select") {
      const opts = f.options || [...new Set(f.seen.map((s) => s.v))];
      return `<select class="input" ${name}><option value=""></option>${opts.map((o) => `<option${v[0] === o ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
    }
    if (f.kind === "multi") {
      const opts = f.options || [];
      return `<span class="cp-multi">${opts.map((o) => `<label><input type="checkbox" ${name} value="${esc(o)}"${v.includes(o) ? " checked" : ""}> ${esc(o)}</label>`).join("")}</span>`;
    }
    if (f.kind === "bool") return `<input type="checkbox" ${name}${/^true$/i.test(v[0] || "") ? " checked" : ""}>`;
    const type = f.kind === "date" ? "date" : f.kind === "time" ? "time" : f.kind === "number" ? "number" : "text";
    return `<input class="input" type="${type}" ${name} value="${esc(v[0] || "")}">`;
  }

  function row(f, vals, extraCls = "") {
    const usual = f.mode ? join(f.mode) : "";
    return `<label class="cp-q ${extraCls}"><span class="cp-qt">${esc(f.caption)}${f.reqDone ? " *" : ""}${usual && f.kind !== "date" && f.kind !== "time" && !f.standard ? `<small>usually ${esc(usual)}</small>` : ""}</span>${input(f, vals)}</label>`;
  }

  function fillPanel(t) {
    const form = data.types[t.type].form;
    const vals = valuesFor(t);
    const enter = toEnter(form);
    const std = form.filter((f) => f.standard && !f.mirrorOf);
    const devs = deviations(form, vals);
    const devFollow = devs.flatMap((d) => followUps(form, d.name));
    return `<div class="cp-fill" data-task="${esc(t.id)}">
      <h3>Key in from the paper copy</h3>
      <div class="cp-qs">${enter.map((f) => row(f, vals)).join("")}</div>
      ${devFollow.length ? `<div class="cp-qs">${devFollow.map((f) => row(f, vals, "cp-follow")).join("")}</div>` : ""}
      <details class="cp-std"${devs.some((d) => std.some((f) => f.name === d.name)) ? " open" : ""}>
        <summary>${std.length} usual answers filled in. Change any that failed today.</summary>
        <div class="cp-qs">${std.map((f) => row(f, vals)).join("")}</div>
      </details>
      ${devs.length ? `<div class="cp-warn"><b>${devs.length} answer${devs.length === 1 ? "" : "s"} differ from the usual:</b> ${devs.map((d) => `${esc(d.caption)} (${esc(d.now)})`).join("; ")}.
        Finish this one in Enviance (the Enviance button on the row) so it opens the corrective action / work order.</div>` : ""}
      <div class="cp-fillbar">
        <span class="cp-muted">Due ${esc(fmtWhen(t.due))}.</span>
        <span id="compliance-fillmsg" class="cp-fillmsg"></span>
        <button class="btn btn-primary" data-save="complete"${devs.length ? " disabled" : ""}>Complete and close…</button>
      </div>
    </div>`;
  }

  function readInputs(panel, vals) {
    const multis = new Map();
    panel.querySelectorAll("[data-field]").forEach((el) => {
      const n = el.dataset.field;
      if (el.type === "checkbox" && el.closest(".cp-multi")) { if (!multis.has(n)) multis.set(n, []); if (el.checked) multis.get(n).push(el.value); }
      else if (el.type === "checkbox") vals[n] = [el.checked ? "True" : "False"];
      else vals[n] = el.value === "" ? [] : [el.value];
    });
    for (const [n, v] of multis) vals[n] = v;
  }

  async function save(t, complete, btn) {
    if (saving) return;
    const panel = els.tasks.querySelector(".cp-fill");
    const vals = valuesFor(t);
    readInputs(panel, vals);
    const msg = panel.querySelector("#compliance-fillmsg");
    if (complete && btn.dataset.armed !== "1") {
      btn.dataset.armed = "1"; btn.textContent = "Confirm: submit to Enviance";
      msg.textContent = "This closes the task in Enviance. Click again to confirm.";
      setTimeout(() => { if (btn.isConnected) { btn.dataset.armed = ""; btn.textContent = "Complete and close…"; msg.textContent = ""; } }, 8000);
      return;
    }
    saving = true; panel.querySelectorAll("button").forEach((b) => (b.disabled = true));
    msg.textContent = complete ? "Submitting…" : "Saving…";
    const res = await host.messaging.sendRaw("save_task", { id: t.id, values: vals, complete }, { timeoutMs: 180_000 }).catch((e) => ({ ok: false, error: String(e?.message || e) }));
    saving = false;
    if (!alive) return;
    if (!res?.ok && res?.savedOnly) {
      // Answers are in Enviance; keep the page in step, then say what is left.
      const tk = data.tasks.find((x) => x.id === t.id);
      if (tk && res.task) Object.assign(tk, { answers: res.task.answers });
      status("error", `${t.name}: ${res.error}`);
      panel.querySelectorAll("button").forEach((b) => (b.disabled = false));
      msg.innerHTML = `<span class="cp-bad">${esc(res.error)}</span> <a href="${esc(t.url)}" target="_blank" rel="noopener">Open in Enviance</a>`;
      return;
    }
    if (!res?.ok) {
      panel.querySelectorAll("button").forEach((b) => (b.disabled = false));
      msg.innerHTML = res?.problems ? `<span class="cp-bad">${res.problems.map(esc).join("<br>")}</span>` : `<span class="cp-bad">${esc(res?.error || "Failed.")}</span>`;
      return;
    }
    const tk = data.tasks.find((x) => x.id === t.id);
    if (tk) Object.assign(tk, { answers: res.task.answers, isopen: res.task.isopen, closed: res.task.closed });
    if (res.completed) { drafts.delete(t.id); openTask = null; status("", `${t.name} completed in Enviance (${res.sent} answers).`); }
    else status(res.missing?.length ? "error" : "", `${t.name}: saved ${res.sent} answers to Enviance${res.missing?.length ? `, but ${res.missing.length} did not stick: ${res.missing.join(", ")}` : ""}.`);
    paint();
  }

  // ── paper copy ────────────────────────────────────────────────────
  function paperCopy(t) {
    const type = data.types[t.type];
    const form = type.form;
    const boxes = (f) => {
      if (f.kind === "select" && f.options?.length && f.options.length <= 4) return f.options.map((o) => `<span class="box">☐ ${esc(o)}</span>`).join(" ");
      if (f.kind === "select") return `<span class="line"></span><div class="opts">${esc((f.options || []).join(" · "))}</div>`;
      if (f.kind === "multi") return (f.options || []).map((o) => `<span class="box">☐ ${esc(o)}</span>`).join(" ");
      if (f.kind === "bool") return `<span class="box">☐ Yes</span>`;
      return `<span class="line"></span>`;
    };
    const qs = form.filter((f) => !f.mirrorOf && !f.conditional && !/feedback/i.test(f.caption));
    const w = window.open("", "_blank");
    if (!w) return status("error", "Allow pop-ups to print the paper copy.");
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(t.name)} — paper copy</title><style>
      body{font:13px/1.35 system-ui,sans-serif;margin:24px;color:#111} h1{font-size:18px;margin:0} .meta{color:#555;margin:4px 0 14px}
      ol{padding-left:20px} li{margin:0 0 9px;break-inside:avoid} .q{font-weight:600} .usual{color:#666;font-weight:400;font-size:11px}
      .box{display:inline-block;margin-right:14px} .line{display:inline-block;border-bottom:1px solid #333;min-width:260px;height:14px}
      .opts{color:#666;font-size:11px} .sign{margin-top:18px;display:flex;gap:28px} @media print{button{display:none}}</style></head><body>
      <button onclick="print()">Print</button>
      <h1>${esc(t.name)} — Store ${esc(data.facility)}</h1>
      <div class="meta">${esc(t.uid || "")} · Due ${esc(fmtWhen(t.due))}${t.cadence === "monthly" ? ` · Aim for ${esc(fmtDay(t.target))}` : ""} · Any "No": write what was done and the work order #</div>
      <ol>${qs.map((f) => `<li><div class="q">${esc(f.caption)} ${f.mode && f.kind !== "date" && f.kind !== "time" && !/name of associate/i.test(f.caption) ? `<span class="usual">(usually ${esc(join(f.mode))})</span>` : ""}</div>${boxes(f)}</li>`).join("")}</ol>
      <div class="sign"><span>Notes / corrective actions: <span class="line" style="min-width:420px"></span></span></div>
      </body></html>`);
    w.document.close();
  }

  // ── what to key in ────────────────────────────────────────────────
  // Types still in use: something due in the last 60 days or ahead (the v1
  // security tour was replaced by v2 in June and should not show twice).
  function liveTypes() {
    const cutoff = new Date(Date.now() - 60 * 86_400_000);
    return Object.values(data.types).filter((ty) => cal.some((t) => t.type === ty.type && parse(t.due) >= cutoff))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function paintForms() {
    const types = liveTypes();
    els.forms.innerHTML = types.map((ty) => {
      const sample = cal.find((t) => t.type === ty.type);
      const cadence = sample?.cadence || "";
      if (!ty.form) {
        if (ty.formError) console.warn("[compliance] form error:", ty.type, ty.formError);
        return `<div class="cp-card"><h3>${esc(ty.name)}</h3><p class="cp-muted">Fill this one in Enviance.</p></div>`;
      }
      const enter = toEnter(ty.form), std = ty.form.filter((f) => f.standard && !f.mirrorOf), cond = ty.form.filter((f) => f.conditional);
      const open = cal.find((t) => t.type === ty.type && !t.projected && t.isopen) || cal.filter((t) => t.type === ty.type && !t.projected).slice(-1)[0];
      return `<div class="cp-card">
        <div class="cp-cardhead"><h3>${esc(ty.name)}</h3><span class="cp-muted">${esc(cadence)}</span>
          ${open ? `<button class="btn btn-secondary btn-sm" data-paper="${esc(open.id)}">Paper copy</button>` : ""}</div>
        <table class="cp-table cp-tight"><thead><tr><th>Changes each time — key these in</th><th>Recent values</th></tr></thead><tbody>
          ${enter.map((f) => `<tr><td>${esc(f.caption)}${f.reqDone ? " *" : ""}</td><td class="cp-muted">${f.kind === "date" || f.kind === "time" ? "today" : esc(f.seen.slice(0, 4).map((s) => s.v).join(" · "))}</td></tr>`).join("")}
        </tbody></table>
        <details><summary>${std.length} standard answers (always the same here)</summary>
          <table class="cp-table cp-tight"><tbody>${std.map((f) => `<tr><td>${esc(f.caption)}</td><td><b>${esc(join(f.standard))}</b></td></tr>`).join("")}</tbody></table></details>
        ${cond.length ? `<p class="cp-muted">Only when an answer fails: ${cond.map((f) => esc(f.caption)).join("; ")}.</p>` : ""}
      </div>`;
    }).join("");
  }

  // ── past submissions ──────────────────────────────────────────────
  function paintHistory() {
    const types = liveTypes().filter((ty) => ty.form);
    els.history.innerHTML = types.map((ty) => {
      const done = cal.filter((t) => t.type === ty.type && !t.projected && !t.isopen && t.answers).sort((a, b) => (a.due < b.due ? 1 : -1)).slice(0, 6);
      if (!done.length) return "";
      const odd = (t) => ty.form.filter((f) => !f.mirrorOf && f.mode && f.kind !== "date" && f.kind !== "time" && !/name of associate/i.test(f.caption)
        && join(t.answers[f.name]) && join(t.answers[f.name]) !== join(f.mode));
      return `<div class="cp-card"><h3>${esc(ty.name)}</h3>
        <table class="cp-table cp-tight"><thead><tr><th>Due</th><th>Completed</th><th>By</th><th>Answers that differ from usual</th></tr></thead><tbody>
        ${done.map((t) => `<tr><td class="cp-when">${esc(fmtDay(t.due))}</td>
          <td class="cp-when">${esc(fmtWhen(t.closed))}${t.status === "late" ? ' <span class="cp-chip s-overdue">late</span>' : t.metTarget === false && t.cadence === "monthly" ? ' <span class="cp-muted">after the 10th</span>' : ""}</td>
          <td>${esc(t.completedBy || "")}</td>
          <td>${odd(t).map((f) => `${esc(f.caption)}: <b>${esc(join(t.answers[f.name]))}</b>`).join("<br>") || '<span class="cp-muted">all usual</span>'}</td></tr>`).join("")}
        </tbody></table></div>`;
    }).join("") || `<p class="cp-empty">No completions in the last six months.</p>`;
  }

  // ── events ────────────────────────────────────────────────────────
  container.addEventListener("click", (e) => {
    const chipEl = e.target.closest(".cp-chip[data-task]");
    if (chipEl) {
      const t = cal.find((x) => x.id === chipEl.dataset.task);
      if (t && !t.projected && t.isopen && data.types[t.type]?.form) openTask = t.id;
      if (t) { const d = parse(t.due); view = { y: d.getFullYear(), m: d.getMonth() }; }
      paintTasks(); selectTab("tasks");
      return;
    }
    const fill = e.target.closest("[data-fill]");
    if (fill) { openTask = openTask === fill.dataset.fill ? null : fill.dataset.fill; paintTasks(); return; }
    const paper = e.target.closest("[data-paper]");
    if (paper) { const t = cal.find((x) => x.id === paper.dataset.paper); if (t) paperCopy(t); return; }
    const sv = e.target.closest("[data-save]");
    if (sv) { const t = cal.find((x) => x.id === openTask); if (t) save(t, sv.dataset.save === "complete", sv); }
  });
  // Re-check answers as they change: a failing answer reveals its follow-up
  // box and disables Complete.
  els.tasks.addEventListener("change", (e) => {
    if (!e.target.closest(".cp-fill")) return;
    const t = cal.find((x) => x.id === openTask);
    if (!t) return;
    const vals = valuesFor(t);
    const form = data.types[t.type].form;
    const before = deviations(form, vals).map((d) => d.name).join("|");
    readInputs(els.tasks.querySelector(".cp-fill"), vals);
    // Redraw only when a failing answer appears or clears (it adds the follow-up
    // box and disables Complete). Redrawing on every change replaced the button
    // under the mouse when a text box lost focus, so the click on Complete
    // never landed.
    if (deviations(form, vals).map((d) => d.name).join("|") === before) return;
    const scroll = window.scrollY;
    paintTasks();
    window.scrollTo(0, scroll);
  });
  els.prev.addEventListener("click", () => { view = view.m === 0 ? { y: view.y - 1, m: 11 } : { y: view.y, m: view.m - 1 }; paintCalendar(); paintTasks(); });
  els.next.addEventListener("click", () => { view = view.m === 11 ? { y: view.y + 1, m: 0 } : { y: view.y, m: view.m + 1 }; paintCalendar(); paintTasks(); });
  els.facility.addEventListener("change", async () => {
    const res = await host.messaging.sendRaw("save_settings", { facility: els.facility.value }).catch(() => null);
    if (!res?.ok) return status("error", res?.error || "Could not save the store.");
    data = null; drafts.clear(); openTask = null; refresh();
  });

  async function refresh() {
    if (busy) return;
    busy = true; els.refresh.disabled = true;
    const msg = data ? "Refreshing" : "Loading tasks (first load takes about a minute)";
    const started = Date.now();
    let stage = "";
    const tick = () => alive && status("", `${msg}… ${Math.round((Date.now() - started) / 1000)} s`);
    const poll = setInterval(async () => {
      const p = await host.messaging.sendRaw("progress", {}, { timeoutMs: 5000 }).catch(() => null);
      if (p?.ok && p.at >= started - 1000) stage = p.stage;
    }, 1500);
    tick();
    const ticker = setInterval(tick, 1000);
    // Never sit on "Loading…" forever: if the worker died mid-pull the reply never comes.
    // sendRaw's default 60 s is shorter than a first load (sign-in bounce +
    // learning every form). The pull keeps running in the worker either way and
    // caches its result, so a later Refresh is fast.
    const res = await host.messaging.sendRaw("pull", {}, { timeoutMs: 240_000 })
      .catch((e) => ({ ok: false, error: /timed out/.test(String(e?.message)) ? "No answer from Enviance after 4 minutes. Click Open Enviance (sign in if it asks), then Refresh." : String(e?.message || e) }));
    clearInterval(ticker); clearInterval(poll);
    busy = false; els.refresh.disabled = false;
    if (!alive) return;
    if (!res?.ok) {
      if (stage) console.warn("[compliance] pull failed at stage:", stage, res?.error);
      return status("error", res?.error || "Could not load from Enviance.");
    }
    // Keep whatever is typed into an open form: paint() redraws it from drafts.
    const panel = els.tasks.querySelector(".cp-fill");
    const open = openTask && cal.find((x) => x.id === openTask);
    if (panel && open && data?.types?.[open.type]?.form) readInputs(panel, valuesFor(open));
    data = res; status("", "");
    if (!saving) paint();    // mid-submit, the submit's own result repaints
  }
  els.refresh.addEventListener("click", refresh);

  // Outlook import: one all-day event per task on the day to do it (the 10th
  // for month-end tasks, else the due day), carrying the real due date.
  container.querySelector("#compliance-ics").addEventListener("click", () => {
    if (!data?.ok) return status("error", "Load the tasks first.");
    const now = new Date();
    const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const ics = (s) => String(s).replace(/[\\;,]/g, (c) => "\\" + c);
    const ymdC = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    const items = cal.filter((t) => t.isopen && parse(t.due) >= new Date(now.getFullYear(), now.getMonth(), now.getDate()));
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//APAISuite//Compliance Tasks//EN", "CALSCALE:GREGORIAN"];
    for (const t of items) {
      // Already past the 10th: put it on today instead of a day gone by.
      const tgt = parse(t.cadence === "monthly" ? t.target : t.due);
      const day = tgt < now ? now : tgt;
      const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
      lines.push("BEGIN:VEVENT", `UID:${ics(t.id)}-${ymdC(day)}@apaisuite-compliance`, `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${ymdC(day)}`, `DTEND;VALUE=DATE:${ymdC(next)}`,
        `SUMMARY:${ics(`${t.name} (store ${data.facility})`)}`,
        `DESCRIPTION:${ics(`Enviance due ${fmtWhen(t.due)}.${t.cadence === "monthly" ? " Store goal: done by the 10th." : ""}`)}`,
        "BEGIN:VALARM", "TRIGGER:-PT15H", "ACTION:DISPLAY", `DESCRIPTION:${ics(t.name)}`, "END:VALARM", "END:VEVENT");
    }
    lines.push("END:VCALENDAR");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\r\n")], { type: "text/calendar" }));
    a.download = `compliance-${data.facility}-${ymdC(now)}.ics`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    status("", `Exported ${items.length} upcoming tasks.`);
  });

  const s = await host.messaging.sendRaw("get_settings").catch(() => null);
  els.facility.value = s?.facility || "";
  const cached = await host.messaging.sendRaw("cached").catch(() => null);
  if (cached?.ok) { data = cached; paint(); }
  if (s?.facility) refresh(); else status("error", "Enter the store number to load its Enviance tasks.");

  return () => { alive = false; link.remove(); };
}
