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
    from: $("#safetyobs-from"), ledgerRun: $("#safetyobs-ledger-run"), ledger: $("#safetyobs-ledger"), history: $("#safetyobs-history"),
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
    if (proposal.ai?.used) notes.push(proposal.ai.changed?.length ? `AI adjusted: ${proposal.ai.changed.join(", ")}.` : "AI agreed with the keyword picks.");
    else if (proposal.ai?.note) notes.push(`Keyword picks only (${proposal.ai.note}).`);
    notes.push("Submits under your own Microsoft account.");
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
    if (!res?.ok) { status(`Not submitted: ${res?.error || "unknown error"}${res?.step ? ` (step: ${res.step})` : ""}`, "error"); return; }
    if (submit) {
      status(res.method === "api"
        ? `Submitted ✓ (direct, ${secs} s)`
        : `Submitted ✓ through the form page (${secs} s); the direct submit was refused: ${res.apiError || "unknown"}`, "ok");
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
    const rows = (c.checked || []).map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.jobName)}</td><td>${esc(p.shiftStart)}–${esc(p.shiftEnd)}</td>
      <td class="num ${p.count < 2 ? "bad" : "good"}">${p.count}</td><td>${p.member ? "" : `<span class="so-muted">not in chat, no @</span>`}</td></tr>`).join("");
    const what = c.trigger === "preview" ? "Preview" : c.posted ? (c.nothingToPost ? "Everyone done, nothing posted" : "Posted") : `Not posted${c.postError ? `: ${c.postError}` : ""}`;
    els.check.innerHTML = `
      <div class="so-muted">${esc(what)} · ${when(c.at)} · ${c.observationsToday} observations at the store today</div>
      <table><thead><tr><th>Coach</th><th>Title</th><th>Shift</th><th class="num">Today</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="5" class="so-muted">No coaches scheduled before the check time.</td></tr>`}</tbody></table>
      ${c.message ? `<pre class="so-pre">${esc(c.message.replace(/@\[([^\]]+)\]\(person:\d+\)/g, "@$1"))}</pre>` : ""}`;
  }
  async function runCheck(post) {
    if (post && !confirm("Post the coach check to the Workvivo chat now?")) return;
    els.preview.disabled = els.post.disabled = true;
    els.check.innerHTML = `<span class="so-muted">Reading the schedule and Field_Dashboard…</span>`;
    const res = await send("check", { post }, { timeoutMs: 3 * 60_000 });
    els.preview.disabled = els.post.disabled = false;
    renderCheck(res);
  }
  els.preview.addEventListener("click", () => runCheck(false));
  els.post.addEventListener("click", () => runCheck(true));

  // ── Ledger ──
  function renderLedger(l) {
    if (!l) { els.ledger.innerHTML = `<span class="so-muted">Press Refresh.</span>`; return; }
    if (!l.ok) { els.ledger.innerHTML = `<div class="so-status error">${esc(l.error)}</div>`; return; }
    const rows = l.rows.map((r) => `<tr>
      <td>${esc(r.name)}</td><td>${esc(r.jobName)}</td>
      <td class="num">${r.scheduledDays}</td><td class="num">${r.expected}</td><td class="num">${r.done}</td>
      <td class="num ${r.behind ? "bad" : "good"}">${r.behind ? r.behind : r.ahead ? `+${r.ahead}` : "0"}</td>
      <td class="num">${r.pct ?? ""}%</td><td class="num">${r.scheduledToday ? r.today : "<span class='so-muted'>off</span>"}</td></tr>`).join("");
    els.ledger.innerHTML = `
      <div class="so-muted">${esc(l.fromIso)} → ${esc(l.toIso)} · ${l.days.length} scheduled days · ${when(l.at)}${l.excludedDays.length ? ` · left out (schedule doc holds another store's roster): ${esc(l.excludedDays.join(", "))}` : ""}</div>
      <table><thead><tr><th>Coach</th><th>Title</th><th class="num">Days scheduled</th><th class="num">Expected</th><th class="num">Done</th><th class="num">Behind</th><th class="num">Done %</th><th class="num">Today</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  }
  els.ledgerRun.addEventListener("click", async () => {
    els.ledgerRun.disabled = true;
    els.ledger.innerHTML = `<span class="so-muted">Reading schedules and observations…</span>`;
    const res = await send("ledger", { from: els.from.value }, { timeoutMs: 5 * 60_000 });
    els.ledgerRun.disabled = false;
    renderLedger(res);
  });

  // ── History ──
  async function loadHistory() {
    const h = await send("history");
    const items = h?.items || [];
    els.history.innerHTML = items.length
      ? `<table><thead><tr><th>When</th><th>What you typed</th><th>Type</th><th>Location</th><th>Process</th><th>Tool</th></tr></thead><tbody>${
        items.map((i) => `<tr><td>${when(i.at)}</td><td>${esc(i.sentence)}</td><td>${esc(i.answers.type)}</td><td>${esc(i.answers.location)}</td><td>${esc(i.answers.process)}</td><td>${esc(i.answers.tool)}</td></tr>`).join("")}</tbody></table>`
      : `<span class="so-muted">Nothing submitted from here yet.</span>`;
  }

  // ── Settings ──
  async function loadSettings() {
    const r = await send("get_settings");
    if (!r?.ok) return;
    const s = r.settings;
    els.store.value = s.storeNbr; els.role.value = s.role; els.channel.value = s.channel;
    els.checkAt.value = s.checkAt; els.enabled.checked = s.checkEnabled; els.ai.checked = s.useAi;
    if (!els.from.value) els.from.value = s.ledgerFrom;
    els.aiState.textContent = r.aiReady ? "(token live)" : "(no live token: sign in from the Cx module)";
    els.next.textContent = s.checkEnabled
      ? (r.nextCheckAt ? `next post ${when(r.nextCheckAt)} to “${s.channel}”` : "")
      : "daily post is off";
  }
  els.settings.addEventListener("submit", async (e) => {
    e.preventDefault();
    await send("save_settings", { patch: {
      storeNbr: els.store.value, role: els.role.value, channel: els.channel.value, checkAt: els.checkAt.value,
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
