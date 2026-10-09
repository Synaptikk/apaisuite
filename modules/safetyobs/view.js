// modules/safetyobs/view.js
//
// Safety Observations — shell page. Sentence → proposed answers (editable
// dropdowns, guesses flagged, missing ones demanded) → Submit; the coach
// check (preview / post now); the behind-since ledger; local submit history.

import { QUESTIONS, ROLES, missingAnswers } from "./lib/form_schema.js";

const LABEL = {
  store: "Store number", role: "Your role", shift: "Shift", type: "Engagement or recognition",
  description: "Description", location: "Location", process: "Process", tool: "Tool",
};

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
    form: $("#safetyobs-parse-form"), sentence: $("#safetyobs-sentence"), parse: $("#safetyobs-parse"),
    msg: $("#safetyobs-parse-msg"), review: $("#safetyobs-review"), fields: $("#safetyobs-fields"), note: $("#safetyobs-note"),
    submit: $("#safetyobs-submit"), dry: $("#safetyobs-dry"), cancel: $("#safetyobs-cancel"),
    next: $("#safetyobs-next"), preview: $("#safetyobs-preview"), post: $("#safetyobs-post"), check: $("#safetyobs-check"),
    from: $("#safetyobs-from"), ledgerRun: $("#safetyobs-ledger-run"), ledgerCopy: $("#safetyobs-ledger-copy"), ledgerEmail: $("#safetyobs-ledger-email"), ledger: $("#safetyobs-ledger"), history: $("#safetyobs-history"),
    settings: $("#safetyobs-settings"), store: $("#safetyobs-store"), role: $("#safetyobs-role"), channel: $("#safetyobs-channel"),
    checkAt: $("#safetyobs-checkat"), enabled: $("#safetyobs-enabled"), ai: $("#safetyobs-ai"), aiState: $("#safetyobs-ai-state"),
  };
  els.role.innerHTML = ROLES.map((r) => `<option>${esc(r)}</option>`).join("");

  const send = (type, payload, opts) =>
    host.messaging.sendRaw(type, payload, opts).catch((err) => ({ ok: false, error: String(err?.message || err) }));
  const status = (text, kind = "") => {
    els.msg.hidden = !text; els.msg.textContent = text || ""; els.msg.className = "so-status " + kind;
  };
  const when = (ms) => new Date(ms).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  // ── Sentence → review ──
  let proposal = null;

  function readFields() {
    const a = { ...(proposal?.answers || {}) };
    for (const el of els.fields.querySelectorAll("[data-key]")) a[el.dataset.key] = el.value.trim();
    return a;
  }

  function renderFields() {
    const a = proposal.answers;
    const missing = new Set(missingAnswers(a));
    const guessed = new Set(proposal.guessed || []);
    els.fields.innerHTML = QUESTIONS
      .filter((q) => !q.onlyFor || q.onlyFor === a.type)
      .map((q) => {
        const cls = missing.has(q.key) ? "need" : guessed.has(q.key) ? "guess" : "";
        const flag = missing.has(q.key) ? "Pick one" : guessed.has(q.key) ? "Guessed, check it" : "";
        const v = a[q.key] ?? "";
        const input = q.kind === "choice"
          ? `<select class="input" data-key="${q.key}"><option value="">—</option>${q.choices.map((c) => `<option${c === v ? " selected" : ""}>${esc(c)}</option>`).join("")}</select>`
          : q.key === "description"
            ? `<textarea class="input" rows="2" data-key="${q.key}">${esc(v)}</textarea>`
            : `<input class="input" data-key="${q.key}" value="${esc(v)}">`;
        return `<label class="so-field ${cls} ${q.key === "description" ? "wide" : ""}">${esc(LABEL[q.key])} ${flag ? `<span class="so-flag">${flag}</span>` : ""}${input}</label>`;
      }).join("");
    const notes = [];
    if (a.type === "Engagement") notes.push("Engagements have no description box on the form; only the picks above are recorded.");
    if (proposal.ai?.used && proposal.ai.changed?.length) notes.push(`Check: ${proposal.ai.changed.join(", ")}.`);
    else if (proposal.ai?.note) console.warn("[safetyobs] keyword picks only:", proposal.ai.note);
    els.note.textContent = notes.join(" ");
    els.submit.disabled = missing.size > 0;
  }

  els.fields.addEventListener("change", (e) => {
    if (!e.target.dataset?.key) return;
    proposal.answers = readFields();
    proposal.guessed = (proposal.guessed || []).filter((k) => k !== e.target.dataset.key);
    renderFields();   // a type change shows/hides the description box
  });

  els.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const sentence = els.sentence.value.trim();
    if (!sentence) return;
    els.parse.disabled = true; status("Reading it…");
    const res = await send("parse", { sentence }, { timeoutMs: 60_000 });
    els.parse.disabled = false;
    if (!res?.ok) { status(res?.error || "Could not read that.", "error"); return; }
    status("");
    proposal = { ...res, startedAt: Date.now() };
    els.review.hidden = false;
    renderFields();
  });
  els.sentence.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); els.form.requestSubmit(); }
  });

  async function doSubmit(submit) {
    const answers = readFields();
    els.submit.disabled = els.dry.disabled = true;
    status(submit ? "Submitting the form…" : "Filling the form in a background tab (it will not be submitted)…");
    const t0 = Date.now();
    const res = await send("submit", { answers, submit, sentence: proposal?.sentence, startedAt: proposal?.startedAt }, { timeoutMs: 120_000 });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    els.submit.disabled = els.dry.disabled = false;
    if (!res?.ok) {
      if (res?.step) console.warn("[safetyobs] submit failed at step:", res.step, res?.error);
      status(`Not submitted: ${res?.error || "unknown error"}`, "error"); return;
    }
    if (submit) {
      if (res.method !== "api") console.warn(`[safetyobs] submitted via form page (${secs} s); direct submit refused:`, res.apiError);
      status("Submitted ✓", "ok");
      els.review.hidden = true; els.sentence.value = ""; proposal = null;
      loadHistory();
    } else {
      status("Test fill worked: every answer took on the real form. Nothing was submitted.", "ok");
    }
  }
  els.submit.addEventListener("click", () => doSubmit(true));
  els.dry.addEventListener("click", () => doSubmit(false));
  els.cancel.addEventListener("click", () => { els.review.hidden = true; proposal = null; status(""); });

  // ── Coach check ──
  function renderCheck(c) {
    if (!c) { els.check.innerHTML = `<span class="so-muted">No check run yet.</span>`; return; }
    if (!c.ok) { els.check.innerHTML = `<div class="so-status error">${esc(c.error || c.skipped || "Check failed")} <span class="so-muted">${when(c.at)}</span></div>`; return; }
    if (!c.throughIso) { els.check.innerHTML = `<span class="so-muted">Press Check now.</span>`; return; }
    const rows = (c.checked || []).map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.jobName)}</td><td>${esc(p.shiftStart)}–${esc(p.shiftEnd)}</td>
      <td class="num ${p.behind ? "bad" : "good"}">${p.behind}</td><td class="num">${p.doneToday || 0}</td><td class="num ${p.owe ? "" : "good"}">${p.owe}</td><td>${p.member ? "" : `<span class="so-muted">not in chat, no @</span>`}</td></tr>`).join("");
    const what = c.trigger === "preview" ? "Preview" : c.posted ? (c.nothingToPost ? "Nobody on today is behind, nothing posted" : "Posted") : `Not posted${c.postError ? `: ${c.postError}` : ""}`;
    els.check.innerHTML = `
      ${c.error ? `<div class="so-status error">${esc(c.error)}</div>` : ""}
      <div class="so-muted">${esc(what)} · ${when(c.at)}${c.liveError ? ` <span class="bad">Today's count unavailable</span>` : ""}</div>
      <table><thead><tr><th>On today</th><th>Title</th><th>Shift</th><th class="num">Behind</th><th class="num">Done today</th><th class="num">Still to do today</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="7" class="so-muted">No coaches or managers on today's schedule.</td></tr>`}</tbody></table>
      ${c.message ? `<pre class="so-pre">${esc(c.message.replace(/@\[([^\]]+)\]\(person:\d+\)/g, "@$1"))}</pre>` : ""}`;
  }
  async function runCheck(post) {
    if (post && !confirm("Post the catch-up message to the Workvivo chat now?")) return;
    els.preview.disabled = els.post.disabled = true;
    els.check.innerHTML = `<span class="so-muted">Checking…</span>`;
    const res = await send("check", { post }, { timeoutMs: 3 * 60_000 });
    els.preview.disabled = els.post.disabled = false;
    renderCheck(res);
  }
  els.preview.addEventListener("click", () => runCheck(false));
  els.post.addEventListener("click", () => runCheck(true));

  // ── Ledger ──
  let shownLedger = null;
  const localIso = (ms = Date.now()) => new Date(ms).toLocaleDateString("en-CA");
  const mdy = (iso) => { const [y, m, d] = String(iso || "").split("-"); return y ? `${m}/${d}` : ""; };

  /**
   * Ledger rows (through yesterday) joined with today's side: on today or
   * not, logged today in the suite, owed today. Leaders on today who have no
   * ledger row yet (first scheduled day) are added with zeros.
   */
  function ledgerView(l) {
    const hasToday = Array.isArray(l.today) && l.todayIso === localIso();
    const todayBy = new Map((hasToday ? l.today : []).map((t) => [t.name.toLowerCase(), t]));
    const rows = l.rows.map((r) => {
      const t = todayBy.get(r.name.toLowerCase());
      if (t) todayBy.delete(r.name.toLowerCase());
      return { ...r, t };
    });
    for (const t of todayBy.values()) {
      rows.push({ name: t.name, jobName: t.jobName, scheduledDays: 0, expected: 0, done: 0, behind: 0, ahead: 0, pct: null, t });
    }
    return { rows, hasToday };
  }
  const todayCells = (r) => r.t
    ? [`${r.t.shiftStart || "?"}–${r.t.shiftEnd || "?"}`, r.t.doneToday || 0, r.t.owe]
    : ["off", "", ""];

  function renderLedger(l) {
    shownLedger = l?.ok ? l : null;
    els.ledgerCopy.disabled = els.ledgerEmail.disabled = !shownLedger;
    if (!l) { els.ledger.innerHTML = `<span class="so-muted">Press Refresh.</span>`; return; }
    if (!l.ok) { els.ledger.innerHTML = `<div class="so-status error">${esc(l.error)}</div>`; return; }
    const { rows, hasToday } = ledgerView(l);
    const warn = [];
    if (l.toIso < localIso(Date.now() - 86_400_000)) warn.push(`Built ${when(l.at)}: it stops at ${mdy(l.toIso)} and has no today columns for ${mdy(localIso())}. Press Refresh.`);
    else if (!hasToday) warn.push("Built before the today columns existed. Press Refresh.");
    if (l.scheduledThrough && !l.observationsThrough) warn.push(`${mdy(l.toIso)} isn't in yet; it counts as not done.`);
    if (hasToday && l.todayScheduleError) warn.push(`Today's schedule: ${l.todayScheduleError}.`);
    if (hasToday && l.liveError) warn.push(`Today's suite submissions could not be read: ${l.liveError}.`);
    const cols = hasToday ? 10 : 7;
    const body = rows.map((r, i) => {
      const [shift, logged, owe] = todayCells(r);
      return `<tr class="so-coach" data-i="${i}" title="Show day by day">
      <td><span class="so-caret">▸</span> ${esc(r.name)}</td><td>${esc(r.jobName)}</td>
      <td class="num">${r.scheduledDays}</td><td class="num">${r.expected}</td><td class="num">${r.done}</td>
      <td class="num ${r.behind ? "bad" : "good"}">${r.behind ? r.behind : r.ahead ? `+${r.ahead}` : "0"}</td>
      <td class="num">${r.pct ?? ""}${r.pct == null ? "" : "%"}</td>
      ${hasToday ? `<td class="so-today">${r.t ? esc(shift) : `<span class="so-muted">off</span>`}</td><td class="num so-today">${logged}</td><td class="num so-today ${r.t ? (owe ? "bad" : "good") : ""}">${owe}</td>` : ""}</tr>
      <tr class="so-days" data-i="${i}" hidden><td colspan="${cols}">${dayBreakdown(r, l)}</td></tr>`;
    }).join("");
    els.ledger.innerHTML = `
      ${warn.map((w) => `<div class="so-status error">${esc(w)}</div>`).join("")}
      <div class="so-muted">Through ${mdy(l.toIso)} · ${l.days.length} scheduled days · updated ${when(l.at)}</div>
      <table><thead><tr><th>Coach</th><th>Title</th><th class="num">Days scheduled</th><th class="num">Expected</th><th class="num">Done</th><th class="num">Behind</th><th class="num">Done %</th>${hasToday ? `<th class="so-today">Today's shift</th><th class="num so-today">Logged today</th><th class="num so-today" title="Behind + 2 − logged today">Owe today</th>` : ""}</tr></thead>
      <tbody>${body}</tbody></table>`;
    els.ledger.querySelectorAll("tr.so-coach").forEach((tr) => tr.addEventListener("click", () => {
      const detail = els.ledger.querySelector(`tr.so-days[data-i="${tr.dataset.i}"]`);
      detail.hidden = !detail.hidden;
      tr.classList.toggle("open", !detail.hidden);
    }));
  }

  /** One coach, day by day: shift, expected, done, running behind; today last. */
  function dayBreakdown(r, l) {
    const days = r.byDay || [];
    if (!days.length && !r.t) return `<span class="so-muted">No per-day detail in this table. Press Refresh.</span>`;
    let run = 0;
    const dow = (iso) => new Date(iso + "T12:00:00").toLocaleDateString("en-US", { weekday: "short" });
    const lines = days.map((d) => {
      run += d.expected - d.done;
      const short = d.scheduled && d.done < d.expected;
      return `<tr><td>${dow(d.dateIso)} ${mdy(d.dateIso)}</td><td>${d.scheduled ? esc(d.shift || "scheduled") : `<span class="so-muted">off</span>`}</td>
        <td class="num">${d.expected}</td><td class="num ${short ? "bad" : d.done ? "good" : ""}">${d.done}</td>
        <td class="num ${run > 0 ? "bad" : "good"}">${run > 0 ? run : run < 0 ? `+${-run}` : 0}</td></tr>`;
    });
    if (r.t) {
      lines.push(`<tr class="so-today"><td>${dow(l.todayIso)} ${mdy(l.todayIso)} (today)</td><td>${esc(`${r.t.shiftStart || "?"}–${r.t.shiftEnd || "?"}`)}</td>
        <td class="num">2</td><td class="num">${r.t.doneToday || 0}</td><td class="num ${r.t.owe ? "bad" : "good"}">owe ${r.t.owe}</td></tr>`);
    }
    return `<table class="so-daytable"><thead><tr><th>Day</th><th>Shift</th><th class="num">Expected</th><th class="num">Done</th><th class="num">Running behind</th></tr></thead>
      <tbody>${lines.join("")}</tbody></table>
      <div class="so-muted">Only days with a shift or an observation are listed. An observation on a day off still counts toward Done.</div>`;
  }
  // Copy / email: the table goes on the clipboard twice, as HTML (Outlook,
  // Teams and Excel keep it a table) and as tab-separated text.
  const LEDGER_HEAD = ["Coach", "Title", "Days scheduled", "Expected", "Done", "Behind", "Done %"];
  const TODAY_HEAD = ["Today's shift", "Logged today", "Owe today"];
  const ledgerCells = (r) => [r.name, r.jobName, r.scheduledDays, r.expected, r.done,
    r.behind ? r.behind : r.ahead ? `+${r.ahead}` : 0, r.pct == null ? "" : `${r.pct}%`];
  const ledgerSubject = (l) => `Safety observations behind since ${mdy(l.fromIso)}`;
  function ledgerClip(l) {
    const { rows, hasToday } = ledgerView(l);
    const head = hasToday ? [...LEDGER_HEAD, ...TODAY_HEAD] : LEDGER_HEAD;
    const cells = (r) => hasToday ? [...ledgerCells(r), ...todayCells(r)] : ledgerCells(r);
    const notes = [`Counts ${mdy(l.fromIso)}–${mdy(l.toIso)}, 2 per scheduled day.`];
    const td = (v, i, head) => {
      const tag = head ? "th" : "td";
      const align = i >= 2 ? "right" : "left";
      const bg = i >= LEDGER_HEAD.length ? "background:#f3f6fb;" : "";
      return `<${tag} style="border:1px solid #bbb;padding:3px 8px;text-align:${align};${bg}">${esc(String(v))}</${tag}>`;
    };
    const html = `<p><b>${esc(ledgerSubject(l))}</b><br>${notes.map(esc).join("<br>")}</p>
      <table style="border-collapse:collapse;font-family:Segoe UI,Arial,sans-serif;font-size:13px">
      <thead><tr style="background:#eee">${head.map((h, i) => td(h, i, true)).join("")}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${cells(r).map((v, i) => td(v, i)).join("")}</tr>`).join("")}</tbody></table>`;
    const text = [ledgerSubject(l), ...notes, "", head.join("\t"),
      ...rows.map((r) => cells(r).join("\t"))].join("\n");
    return { html, text };
  }
  async function copyLedger() {
    if (!shownLedger) return false;
    const { html, text } = ledgerClip(shownLedger);
    try {
      await navigator.clipboard.write([new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" }),
      })]);
      return true;
    } catch (e) {
      host.ui.toast(`Copy failed: ${e.message}`, { kind: "error" });
      return false;
    }
  }
  els.ledgerCopy.addEventListener("click", async () => {
    if (await copyLedger()) host.ui.toast("Copied, paste it anywhere.", { kind: "ok" });
  });
  els.ledgerEmail.addEventListener("click", async () => {
    if (!(await copyLedger())) return;
    const url = `https://outlook.office.com/mail/deeplink/compose?subject=${encodeURIComponent(ledgerSubject(shownLedger))}`;
    window.open(url, "_blank");
    host.ui.toast("Table copied: click in the email body and press Ctrl+V.", { kind: "ok" });
  });

  els.ledgerRun.addEventListener("click", async () => {
    els.ledgerRun.disabled = true;
    els.ledger.innerHTML = `<span class="so-muted">Loading…</span>`;
    const res = await send("ledger", { from: els.from.value }, { timeoutMs: 5 * 60_000 });
    els.ledgerRun.disabled = false;
    renderLedger(res);
  });

  // ── History ──
  async function loadHistory() {
    const h = await send("history");
    const items = h?.items || [];
    const shareNote = h?.share && !h.share.ok ? `<div class="so-status error">Today's submissions not shared yet: ${esc(h.share.error)}</div>` : "";
    els.history.innerHTML = items.length
      ? `<table><thead><tr><th>When</th><th>What you typed</th><th>Type</th><th>Location</th><th>Process</th><th>Tool</th></tr></thead><tbody>${
        items.map((i) => `<tr><td>${when(i.at)}</td><td>${esc(i.sentence)}</td><td>${esc(i.answers.type)}</td><td>${esc(i.answers.location)}</td><td>${esc(i.answers.process)}</td><td>${esc(i.answers.tool)}</td></tr>`).join("")}</tbody></table>`
      : `<span class="so-muted">Nothing submitted yet.</span>`;
    if (shareNote) els.history.insertAdjacentHTML("afterbegin", shareNote);
  }

  // ── Settings ──
  async function loadSettings() {
    const r = await send("get_settings");
    if (!r?.ok) return;
    const s = r.settings;
    els.store.value = s.storeNbr; els.role.value = s.role; els.channel.value = s.channel;
    els.checkAt.value = s.postAt; els.enabled.checked = s.checkEnabled; els.ai.checked = s.useAi;
    if (!els.from.value) els.from.value = s.ledgerFrom;
    els.aiState.textContent = r.aiReady ? "(on)" : "(sign in on the Cx page)";
    els.next.textContent = s.checkEnabled
      ? (r.nextCheckAt ? `next post ${when(r.nextCheckAt)} to “${s.channel}”` : "")
      : "daily post is off";
  }
  els.settings.addEventListener("submit", async (e) => {
    e.preventDefault();
    await send("save_settings", { patch: {
      storeNbr: els.store.value, role: els.role.value, channel: els.channel.value, postAt: els.checkAt.value,
      checkEnabled: els.enabled.checked, useAi: els.ai.checked, ledgerFrom: els.from.value,
    } });
    loadSettings();
  });

  await loadSettings();
  send("last_check").then((r) => renderCheck(r?.check));
  send("last_ledger").then((r) => renderLedger(r?.ledger));
  loadHistory();

  return () => { link.remove(); };
}
