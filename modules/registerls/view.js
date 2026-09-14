// modules/registerls/view.js
//
// Triage board. Left: every open WorkView item for the store, sorted into
// "needs a look", "ready to close", "not analyzed yet" and "other work
// items". Right: for the selected item — what we think it is, why, what to
// do (fill the APPRISS form from the suggestion, never submit it), and, for
// items we can't safely classify, the details most likely to matter.
// Nothing here talks to a source directly; every pull is a SW handler.

const NOISE = new Set(["flip", "bounceback"]);
import { reasonsFor } from "./lib/reasons.js";
const SEV_ORDER = { high: 0, medium: 1, low: 2, none: 3 };

const BUCKET = {
  ready:   { title: "Ready to close — nothing found", hint: "Offsetting entries found. Fill the form in APPRISS and complete it." },
  review:  { title: "Needs a look", hint: "No safe classification. The evidence is ordered by what usually settles it." },
  pending: { title: "Not analyzed yet", hint: "Pull Power BI, then Analyze all." },
  other:   { title: "Other open work items", hint: "Not register items — worked in APPRISS as usual." },
};

export async function mount(host, container) {
  // The shell links only its global stylesheets; a module injects its own
  // and removes it on unmount (same as closinglist / digitallocks).
  const link = document.createElement("link");
  link.rel = "stylesheet"; link.href = host.url("styles.css"); link.dataset.module = "registerls";
  document.head.appendChild(link);

  const html = await fetch(host.url("view.html")).then((r) => r.text());
  container.innerHTML = html;
  const $  = (sel) => host.ui.$(sel, container);
  const esc = host.ui.escapeHtml;

  let state = null;
  let selectedId = null;
  let analysis = null;
  let storeDraft = "";
  let cashiers = null;      // get_cashiers payload
  let openCashier = null;   // expanded row
  let cashierRange = { from: "", to: "" };   // permanent ledger, date-filtered
  const inFlight = new Map();   // work items completing in the background: id → { reasonLabel, startedAt }
  let unmounted = false;        // set by cleanup; stops the open-time bootstrap from painting a dead container

  // ── data ────────────────────────────────────────────────────────
  async function load() {
    let res;
    try { res = await host.messaging.send("get_state", {}); }
    catch (e) { host.ui.toast(e?.message || "state failed", { kind: "error" }); return; }
    state = res.data;
    storeDraft = state.store.storeNbr || "";
    await loadCashiers();
    paintAll();
  }

  async function loadCashiers() {
    try { const c = await host.messaging.send("get_cashiers", { from: cashierRange.from, to: cashierRange.to }); cashiers = c.data; } catch { cashiers = null; }
  }

  async function run(action, payload, btn) {
    setBusy(btn, true);
    try {
      let res;
      try { res = await host.messaging.sendRaw(action, payload, { timeoutMs: 1_800_000 }); }
      catch (e) { host.ui.toast(e?.message || `${action} failed`, { kind: "error" }); return null; }
      const d = res && res.data !== undefined ? res.data : res;
      if (!res || res.ok === false || (d && d.ok === false)) {
        host.ui.toast((d && d.error) || (res && res.error) || `${action} failed`, { kind: "error" });
        const loginUrl = (d && d.loginUrl) || (res && res.loginUrl);
        if (loginUrl) window.open(loginUrl, "_blank");
        return null;
      }
      return d;
    } finally {
      setBusy(btn, false);
    }
  }

  function setBusy(btn, on) {
    if (!btn) return;
    btn.disabled = on;
    const sp = btn.querySelector(".btn-spinner"); if (sp) sp.hidden = !on;
  }

  // ── classification for the list ─────────────────────────────────
  // Full analysis when one exists, else the grid-only pre-verdict.
  function classify(i) {
    const a0 = state.analyses[i.id];
    const a = a0 && !a0.stale ? a0 : null;   // analysed against an older grid → use the live grid verdict
    const v = a?.verdict || i.pre.verdict;
    const sev = a?.severity || i.pre.severity || "none";
    if (v === "pending") return { bucket: "pending", verdict: v, severity: sev, label: "Power BI not pulled", why: "", analyzed: !!a };
    if (NOISE.has(v)) return { bucket: "ready", verdict: v, severity: sev, label: v === "flip" ? "Till flip" : "Bounceback", why: preWhy(i), analyzed: !!a };
    return { bucket: "review", verdict: v, severity: sev, label: v === "unmatched" ? "Unmatched shortage" : v === "unmatched_over" ? "Unmatched overage" : v === "suspect_flip" ? "Weak offset" : "No data", why: a?.whyShort || preWhy(i), video: !!a?.hasVideo, analyzed: !!a };
  }

  function preWhy(i) {
    const cp = i.pre.counterpart;
    if (cp) return `other half of reg ${cp.registerNbr} ${money(Math.abs(cp.amountCents))} ${cp.amountCents < 0 ? "short" : "over"} on ${cp.date}${i.pre.flipConfidence != null ? ` · ${Math.round(i.pre.flipConfidence * 100)}% confidence` : ""}`;
    const m = i.pre.matchedAgainst?.[0];
    if (m) return `${m.registerNbr === i.register ? "same register" : `reg ${m.registerNbr}`} ${money(Math.abs(m.amountCents))} ${m.amountCents < 0 ? "short" : "over"} on ${m.date}${i.pre.flipConfidence != null ? ` · ${Math.round(i.pre.flipConfidence * 100)}% confidence` : ""}`;
    if (i.pre.verdict === "no_grid") return "no long/short data for this day";
    if (i.pre.verdict === "unmatched") return "no offsetting entry on a neighbouring register";
    if (i.pre.verdict === "unmatched_over") return "no shortage nearby offsets this overage";
    return "";
  }

  // ── paint ───────────────────────────────────────────────────────
  function paintAll() { paintHeader(); paintSummary(); paintCashiers(); paintQueue(); paintDetail(); }

  const ACTIONS = ["Retrained", "Coached", "Verbal warning", "Written warning", "Cleared", "Note"];

  function paintCashiers() {
    const box = $("[data-cashiers]");
    if (!cashiers || (!cashiers.hasTills && !cashiers.stored?.events)) { box.hidden = true; return; }
    box.hidden = false;
    const list = cashiers.cashiers;
    const st = cashiers.stored || {};
    const rangeTxt = cashierRange.from || cashierRange.to ? `${cashierRange.from || "…"} → ${cashierRange.to || "…"}` : `all time (${st.dateMin || "?"} → ${st.dateMax || "?"})`;
    $("[data-cashiers-meta]").textContent = `${list.length} associates · ${money(list.reduce((s, c) => s + c.totalCents, 0))} involved · ${rangeTxt} · ${st.events || 0} events on record`;
    const fromEl = $("[data-range-from]"), toEl = $("[data-range-to]");
    if (document.activeElement !== fromEl) fromEl.value = cashierRange.from;
    if (document.activeElement !== toEl) toEl.value = cashierRange.to;
    if (!list.length) { $("[data-cashiers-body]").innerHTML = `<div class="rls-muted">No attributed errors in this range.</div>`; return; }
    const chip = (c) => Object.entries(c.byType).map(([k, v]) => `<span class="rls-chip t-${esc(k)}" title="${esc(cashiers.types[k] || k)} · ${esc(money(v.cents))}">${esc(shortType(k))} ×${v.count}</span>`).join(" ");
    $("[data-cashiers-body]").innerHTML = `<table class="rls-table rls-cashier-table"><thead><tr><th>Associate</th><th>$ involved</th><th>Events</th><th>Error types</th><th>First → last</th><th></th></tr></thead><tbody>${list.map((c) => `
      <tr class="rls-cashier-row ${openCashier === c.id ? "is-open" : ""}" data-cashier="${esc(c.id)}"><td>${esc(c.name || c.id)} <span class="rls-muted">${esc(c.id)}</span></td><td>${esc(money(c.totalCents))}</td><td>${c.count}</td><td class="rls-chips">${chip(c)}</td><td>${esc(c.first)} → ${esc(c.last)}</td><td><button class="btn btn-sm btn-ghost" data-action="cashier-toggle" data-id="${esc(c.id)}">${openCashier === c.id ? "Hide" : "Details"}</button> <button class="btn btn-sm btn-ghost" data-action="cashier-export" data-id="${esc(c.id)}" title="Write this associate's CSV">Export</button></td></tr>
      ${openCashier === c.id ? `<tr class="rls-cashier-detail"><td colspan="6">${cashierDetail(c)}</td></tr>` : ""}`).join("")}</tbody></table>
      <div class="rls-muted">Permanent record: an event stays here after its work item is completed and after the till log window moves on. Every entry is an action the till log records this person doing: a till checked in to a register it was not checked out to, a cash advance carried to the wrong register or never surfaced, a till re-checked in with less cash, or a check-in override on a discrepancy day. Being on a register that came up short is not counted.</div>`;
  }

  function shortType(k) {
    return { till_moved: "till → wrong reg", advance_wrong_till: "advance → wrong reg", advance_missing: "advance missing", quick_recheck: "quick re-check-in", override: "override", flip_checkin: "flipped check-ins" }[k] || k;
  }

  function cashierDetail(c) {
    const notes = cashiers.notes[c.id] || [];
    const today = new Date().toISOString().slice(0, 10);
    return `<div class="rls-cashier-panel">
      <div><strong>Events</strong><table class="rls-table"><thead><tr><th>Date</th><th>Register</th><th>Type</th><th>Amount</th><th>Work item</th><th>Detail</th></tr></thead><tbody>${c.events.map((e) => `<tr><td>${esc(e.date)}</td><td>${esc(e.register)}</td><td>${esc(cashiers.types[e.type] || e.type)}</td><td>${esc(money(Math.abs(e.cents || 0)))}</td><td>${e.workItemId ? `<a href="https://apps.apprissretail.com/walmart-usa/platform/workview#/detail/${esc(e.workItemId)}?id=${esc(e.workItemId)}" target="_blank" rel="noopener">${esc(e.workItemId)}</a>` : ""}</td><td>${esc(e.detail || "")}</td></tr>`).join("")}</tbody></table></div>
      <div><strong>Coaching log</strong>${notes.length ? `<table class="rls-table"><thead><tr><th>Date</th><th>Action</th><th>Note</th><th></th></tr></thead><tbody>${notes.map((n) => `<tr><td>${esc(n.date)}</td><td>${esc(n.action)}</td><td>${esc(n.note)}</td><td><button class="btn btn-sm btn-ghost" data-action="note-remove" data-id="${esc(c.id)}" data-at="${esc(n.at)}">remove</button></td></tr>`).join("")}</tbody></table>` : `<div class="rls-muted">No coaching recorded yet.</div>`}
        <form class="rls-note-form" data-note-form data-id="${esc(c.id)}">
          <input class="input" type="date" name="date" value="${today}">
          <select class="input" name="action">${ACTIONS.map((a) => `<option>${esc(a)}</option>`).join("")}</select>
          <input class="input rls-note-text" name="note" placeholder="What was covered / agreed">
          <button class="btn btn-sm btn-primary" type="submit">Add</button>
        </form>
      </div>
    </div>`;
  }

  function paintHeader() {
    const inp = $("#rls-store");
    if (document.activeElement !== inp) inp.value = storeDraft;
    $("[data-store-src]").textContent = state.store.source === "override" ? "(override)" : state.store.source === "profile" ? "(your home store)" : state.store.source === "none" ? "(not set)" : "";
    const q = state.queue, g = state.grid;
    pill("queue", q ? `WorkView · ${q.items.length + (q.others || []).length} open items${q.totals ? ` (${q.totals.unassigned ?? 0} new, ${q.totals.assigned ?? 0} assigned)` : ""} · ${ago(q.fetchedAt)}` : "WorkView: not pulled", q ? "pill-ok" : "pill-checking", state.links.workview);
    const t = state.tills;
    pill("tills", t ? `Till log · ${t.rows} events · ${t.dateMin} → ${t.dateMax} · ${ago(t.fetchedAt)}` : "Till log: not pulled", t ? "pill-ok" : "pill-warn", t?.reportUrl || null);
    const cf = state.cft;
    pill("cft", cf ? `CFTs · ${cf.rows} transfers · ${cf.dateMin} → ${cf.dateMax} · ${ago(cf.fetchedAt)}` : "Cash fund transfers: not pulled", cf ? "pill-ok" : "pill-warn", cf?.reportUrl || null);
    paintMoves();
    pill("grid", g && g.capturedAt ? `Power BI · ${g.cellCount} register-days${g.dateMin ? ` · ${g.dateMin} → ${g.dateMax}` : ""} · ${ago(g.capturedAt)}` : g?.staleStore ? `Power BI: cached for store ${g.staleStore} — refresh` : "Power BI: not pulled", g && g.capturedAt ? "pill-ok" : "pill-warn", state.links.powerbi);
  }

  function paintMoves() {
    const box = $("[data-moves]");
    const moves = state.tills?.moves || [];
    if (!moves.length) { box.hidden = true; return; }
    box.hidden = false;
    $("[data-moves-meta]").textContent = `${moves.length} in the last ${state.tills.dateMin} → ${state.tills.dateMax}`;
    $("[data-moves-body]").innerHTML = `<table class="rls-table"><thead><tr><th>Date</th><th>Associate</th><th>Out of</th><th>Into</th><th>Out</th><th>In</th><th>Amount out / in</th></tr></thead><tbody>${moves.map((m) => `<tr><td>${esc(m.date)}</td><td>${esc(m.associate || m.associateId)} <span class="rls-muted">${esc(m.associateId)}</span></td><td>reg ${esc(m.fromRegister)}</td><td>reg ${esc(m.toRegister)}${m.override ? ' <span class="badge badge-warn">override</span>' : ""}</td><td>${esc(m.outTime)}</td><td>${esc(m.inTime)}</td><td>${esc(money(m.outCents))} / ${esc(money(m.inCents))}</td></tr>`).join("")}</tbody></table><div class="rls-muted">A till checked in to a register it was never checked out to, paired with a register whose till never came back that day. Charged to the person who did the check-in. This is how flips happen; the matching pair usually sits in "ready to close".</div>`;
  }

  function pill(key, text, cls, href) {
    const el = $(`[data-pill="${key}"]`);
    el.className = `pill ${cls}`;
    el.innerHTML = esc(text) + (href ? ` <a href="${esc(href)}" target="_blank" rel="noopener">open</a>` : "");
  }

  function paintSummary() {
    const box = $("[data-summary]");
    const q = state.queue;
    if (!q) { box.innerHTML = ""; return; }
    const cls = q.items.map(classify);
    const n = (b) => cls.filter((c) => c.bucket === b).length;
    const video = cls.filter((c) => c.video).length;
    const cards = [
      { key: "review",  n: n("review"),  label: "need a look",      sub: video ? `${video} with a video candidate` : "unmatched or weak offsets", tone: n("review") ? "warn" : "muted" },
      { key: "ready",   n: n("ready"),   label: "ready to close",   sub: "flips & bouncebacks", tone: n("ready") ? "ok" : "muted" },
      { key: "pending", n: n("pending"), label: "not analyzed",     sub: "pull Power BI / analyze", tone: "muted" },
      { key: "other",   n: (q.others || []).length, label: "other open items", sub: "refunds, scans, WIN match…", tone: "muted" },
    ];
    box.innerHTML = cards.map((c) => `<div class="rls-sum tone-${c.tone}" data-jump="${c.key}"><div class="rls-sum-n">${c.n}</div><div class="rls-sum-l">${esc(c.label)}</div><div class="rls-sum-s">${esc(c.sub)}</div></div>`).join("");
  }

  function paintQueue() {
    const list = $("[data-queue-list]");
    const q = state.queue;
    if (!q) { list.innerHTML = `<div class="rls-empty">No WorkView data yet — click <strong>Refresh WorkView</strong>.</div>`; return; }
    const groups = { ready: [], review: [], pending: [] };
    for (const i of q.items) groups[classify(i).bucket].push(i);
    groups.review.sort((a, b) => ((classify(b).video ? 1 : 0) - (classify(a).video ? 1 : 0)) || (SEV_ORDER[classify(a).severity] ?? 3) - (SEV_ORDER[classify(b).severity] ?? 3) || (b.amountAbsCents || 0) - (a.amountAbsCents || 0));
    groups.ready.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    const sec = (key, rows) => rows.length ? `<div class="rls-group" data-group="${key}"><div class="rls-group-head"><span>${esc(BUCKET[key].title)}</span><span class="rls-group-n">${rows.length}</span></div><div class="rls-group-hint">${esc(BUCKET[key].hint)}</div>${rows.join("")}</div>` : "";
    const row = (i) => {
      const c = classify(i);
      const sla = i.isOverDue ? "overdue" : i.targetResolutionAt ? `due ${i.targetResolutionAt.slice(0, 10)}` : "";
      const busy = inFlight.has(i.id);
      return `<div class="rls-row ${i.id === selectedId ? "is-selected" : ""} b-${c.bucket} ${busy ? "is-busy" : ""}" data-id="${esc(i.id)}" role="button" tabindex="0">
        <div class="rls-row-top">
          <span class="rls-row-reg">Reg ${esc(i.register || "?")}</span>
          <span class="rls-row-amt ${i.type}">${esc(money(i.amountCents))}</span>
          <span class="rls-row-date">${esc(i.date || "?")}</span>
          ${busy ? `<span class="badge badge-info">completing…</span>` : `<span class="badge v-${esc(c.verdict)}">${esc(c.label)}${c.video ? " · 🎥" : ""}</span>`}
        </div>
        ${c.why ? `<div class="rls-row-why">${esc(c.why)}</div>` : ""}
        <div class="rls-row-sla ${i.isOverDue ? "overdue" : ""}">${esc(i.sourceAppId === "mel" ? "Long/Short item" : i.category)}${i.view === "assigned" ? " · assigned" : ""}${sla ? ` · ${esc(sla)}` : ""}${c.analyzed ? " · analyzed" : " · grid only"}</div>
      </div>`;
    };
    const other = (o) => {
      const sla = o.isOverDue ? "overdue" : o.targetResolutionAt ? `due ${o.targetResolutionAt.slice(0, 10)}` : "";
      return `<div class="rls-row rls-row-other ${o.id === selectedId ? "is-selected" : ""}" data-id="${esc(o.id)}" role="button" tabindex="0">
        <div class="rls-row-top"><span class="rls-row-reg">${esc(o.headLine || o.category)}</span><span class="rls-row-amt">${esc(o.potentialValueCents != null ? money(o.potentialValueCents) : "")}</span><span class="rls-row-date">${esc(o.date || "")}</span><span class="badge badge-neutral">${esc(o.sourceApp || o.sourceAppId)}</span></div>
        <div class="rls-row-sla ${o.isOverDue ? "overdue" : ""}">${esc(o.category)}${o.view === "assigned" ? " · assigned" : ""}${sla ? ` · ${esc(sla)}` : ""}</div>
      </div>`;
    };
    const html = sec("review", groups.review.map(row)) + sec("ready", groups.ready.map(row)) + sec("pending", groups.pending.map(row)) + sec("other", (q.others || []).map(other));
    list.innerHTML = html || `<div class="rls-empty">No open work items in the last 30 days.</div>`;
  }

  function paintDetail() {
    const box = $("[data-detail]");
    const item = state.queue?.items.find((i) => i.id === selectedId);
    if (!item) {
      const o = (state.queue?.others || []).find((x) => x.id === selectedId);
      if (o) return paintOtherDetail(box, o);
      box.innerHTML = `<div class="rls-empty">Select a work item.</div>`; return;
    }
    const c = classify(item);
    const ev = analysis?.evidence || null;
    const why = ev?.why || item.pre.why || (c.why ? [{ kind: "grid", text: c.why.charAt(0).toUpperCase() + c.why.slice(1) + "." }] : []);
    const sug = ev?.suggestion || item.pre.suggestion || null;
    const src = analysis?.sources;
    const tone = c.bucket === "ready" ? "ok" : c.bucket === "review" ? (c.severity === "high" ? "high" : "warn") : "muted";

    const think = c.bucket === "ready"
      ? `Nothing found — ${c.verdict === "flip" ? "the tills were checked in as each other" : "the drawer count was corrected on a following day"}.`
      : c.bucket === "review"
        ? (c.verdict === "no_grid" ? "Can't classify: no long/short data for that day."
          : c.verdict === "unmatched_over" ? "Unmatched overage — no shortage nearby explains it."
          : c.verdict === "suspect_flip" ? "Probably not a clean flip — the candidate offset is weak."
          : (ev?.videoCandidates?.length ? "Shortage worth pursuing — transactions recorded cash near the amount." : ev ? "Unmatched shortage — review transaction and till evidence to establish the cause." : "Unmatched shortage in the grid — analyze to pull the journal."))
        : "Not analyzed yet — pull Power BI or analyze this item.";

    const actions = [];
    if (inFlight.has(item.id)) actions.push(`<span class="badge badge-info">Completing in APPRISS… you can move on to the next item</span>`);
    else if (sug?.safe) actions.push(`<button class="btn btn-primary" data-action="prefill" title="Verify, then completes the work item in a background tab as ${esc(sug.reasonLabel)}"><span class="btn-label">Complete in APPRISS as ${esc(sug.reasonLabel)}…</span><span class="btn-spinner" hidden aria-hidden="true"></span></button>`);
    else if (sug && !inFlight.has(item.id)) actions.push(`<label class="rls-cause"><span class="rls-muted">Cause found:</span> <select class="input" data-cause><option value="">choose after review…</option>${reasonsFor(item.sourceAppId).map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join("")}</select></label><button class="btn btn-secondary" data-action="prefill" disabled title="Pick the cause you found first, verify, and the work item is completed in a background tab."><span class="btn-label">Complete in APPRISS…</span><span class="btn-spinner" hidden aria-hidden="true"></span></button>`);
    actions.push(`<button class="btn ${analysis ? "btn-ghost" : "btn-secondary"}" data-action="analyze"><span class="btn-label">${analysis ? "Re-analyze" : "Analyze (Cash Research + EJ)"}</span><span class="btn-spinner" hidden aria-hidden="true"></span></button>`);
    const links = [
      `<a href="${esc(item.detailUrl)}" target="_blank" rel="noopener">Work item ${esc(item.id)}</a>`,
      src?.ledger?.explorerUrl ? `<a href="${esc(src.ledger.explorerUrl)}" target="_blank" rel="noopener">Cash Research</a>` : "",
      `<a href="${esc(state.links.ej)}" target="_blank" rel="noopener">EJ</a>`,
      `<a href="${esc(state.links.powerbi)}" target="_blank" rel="noopener">Power BI</a>`,
    ].filter(Boolean).join(" · ");

    const sources = src ? `<div class="rls-sources">${srcPill("Power BI", src.grid)}${srcPill("Cash Research", src.ledger)}${srcPill("EJ", src.ej)}${srcPill("Till log", src.tills)}${srcPill("Open Drawer", src.drawer)}${srcPill("CFTs", src.cft)}<span class="rls-muted">analyzed ${esc(ago(analysis.at))}</span></div>` : `<div class="rls-sources"><span class="rls-muted">${c.bucket === "ready" ? "Matched from the long/short entries alone — no journal pull needed to file this." : "Offset check only — analyze to add the cash ledger and the journal."}</span></div>`;

    const suggestion = sug ? `<div class="rls-block">
        <h3>${sug.safe ? "Disposition to file" : "Investigation notes (become the More Information text once a cause is picked)"}</h3>
        ${sug.safe ? `<div class="rls-sug-reason"><span class="rls-muted">Reason</span> <strong>${esc(sug.reasonLabel)}</strong> <span class="rls-muted">· More Information:</span></div>` : ""}
        <textarea class="rls-sug-text" data-sug-text rows="4">${esc(sug.text)}</textarea>
        <div class="rls-muted">${sug.safe ? "Complete in APPRISS asks you to verify, then starts work, picks the reason, pastes this text and clicks Complete in a background tab." : "This item is not dispositioned until the cause is found. When it is, pick the cause above and Complete in APPRISS; edit the notes first if needed."}</div>
      </div>` : "";

    box.innerHTML = `
      <div class="rls-verdict tone-${tone}">
        <div class="rls-verdict-top"><span class="rls-verdict-item">Reg ${esc(item.register)} · ${esc(item.date)} · <strong>${esc(money(item.amountCents))}</strong>${item.isOverDue ? " · <strong>overdue</strong>" : ""}</span><span class="badge v-${esc(c.verdict)}">${esc(c.label)}</span></div>
        <h2>${esc(think)}</h2>
        ${why.length ? `<div class="rls-why"><div class="rls-why-h">Why</div><ul>${why.map((w) => `<li class="w-${esc(w.kind)}">${esc(w.text)}</li>`).join("")}</ul></div>` : ""}
      </div>
      <div class="rls-actions">${actions.join("")}<span class="rls-links">${links}</span></div>
      ${sources}
      ${suggestion}
      ${ev ? renderLookAt(ev, item) : ""}
    `;
  }

  function renderLookAt(ev, item) {
    const parts = [];
    const sec = (title, body, cls = "") => `<div class="rls-block ${cls}"><h3>${esc(title)}</h3>${body}</div>`;
    // ▶ Video / Receipt open APPRISS's own viewers on the transaction id the
    // Open Drawer search gave us for this TR#.
    const vlinks = (v) => v ? `<span class="rls-links"><a class="btn btn-primary" href="${esc(v.cctvUrl)}" target="_blank" rel="noopener" title="APPRISS CCTV viewer for this transaction">▶ Video</a><a class="btn btn-secondary" href="${esc(v.receiptUrl)}" target="_blank" rel="noopener" title="APPRISS receipt viewer">Receipt</a>${v.byTime ? `<span class="rls-muted">matched by time</span>` : ""}</span>` : `<span class="rls-muted rls-links">no video id (not in Open Drawer)</span>`;
    for (const k of ev.lookAt || []) {
      if (k === "investigation") {
        const inv = ev.investigation;
        const cards = inv.candidates.slice(0, 5).map((c, i) => `<div class="rls-block"><h4>${i + 1}. ${esc(c.time || "Time unknown")} · TR# ${esc(c.transNum)} · operator ${esc(c.opNum || "?")} ${vlinks(c.video)}</h4><p>${esc(c.hypothesis)}</p><ul class="rls-list">${c.supporting.map(x => `<li>${esc(x)}</li>`).join("")}</ul><p>Potential cash discrepancy ${esc(money(c.possibleLossCents))}; remaining shortage under that hypothesis ${esc(money(c.residualCents))}${c.residualCents < 0 ? " (candidate exceeds shortage)" : ""}. Confirmed explained: $0.00.</p><p>${esc(c.check)}</p><details><summary>Receipt and conflicting evidence</summary><ul class="rls-list">${c.conflicting.map(x => `<li>${esc(x)}</li>`).join("")}</ul><p>TC# ${esc(c.tcNum || "?")} · total ${esc(money(c.totalCents))} · cash ${esc(money(c.cashTendCents))} · change ${esc(money(c.changeDueCents || 0))}</p><pre>${esc(c.raw || "Raw receipt unavailable")}</pre></details></div>`).join("");
        parts.push(sec("Investigate the shortage — cause unconfirmed", `<p>${esc(inv.method)}</p><p>${inv.gaps.map(esc).join(" ")}</p><p>${inv.candidates.length} completed cash transactions ranked; showing up to five. Review the till timeline alongside these transactions.</p>${cards || "<p>No eligible completed cash transactions. Check source coverage and till handling.</p>"}`));
      } else if (k === "tills") {
        const t = ev.tills; if (!t) continue;
        const adv = (t.advances || []).map((a) => `<li class="${a.kind === "advance_missing" ? "hit" : ""}">${esc(a.advance.time)} · ${esc(a.advance.action)} ${esc(money(a.advance.amountCents))} by ${esc(a.advance.associate || a.advance.associateId)} → ${a.kind === "advance_flip" ? `over on reg ${esc(a.landedOn.registerNbr)} ${esc(a.landedOn.date)} (${esc(money(a.landedOn.amountCents))})` : "never surfaced as an overage"}</li>`).join("");
        const mv = (t.moves || []).map((m) => `<li>${esc(m.date)} · ${esc(m.associate || m.associateId)} out of reg ${esc(m.fromRegister)} ${esc(m.outTime)} → into reg ${esc(m.toRegister)} ${esc(m.inTime)}${m.override ? " (override)" : ""}</li>`).join("");
        const tl = (t.events || []).map((e) => `<tr class="${e.date === item.date ? "" : "rls-dim"}"><td>${esc(e.date)} ${esc(e.time)}</td><td>${esc(e.action)}</td><td>${esc(money(e.amountCents))}</td><td>${esc(e.associate || e.associateId)} <span class="rls-muted">${esc(e.associateId)}</span></td></tr>`).join("");
        const qf = (t.flags || []).filter((f) => f.kind === "quick_recheck").map((f) => `<li class="hit">${esc(f.text)}</li>`).join("");
        parts.push(sec("Till log — who handled this register", `${qf ? `<div><strong>Till re-checked in with less cash</strong><ul class="rls-list">${qf}</ul></div>` : ""}${adv ? `<div><strong>Cash advances near the amount</strong><ul class="rls-list">${adv}</ul></div>` : ""}${mv ? `<div><strong>Tills moved between registers</strong><ul class="rls-list">${mv}</ul></div>` : ""}<table class="rls-table"><thead><tr><th>When</th><th>Action</th><th>Amount</th><th>Associate</th></tr></thead><tbody>${tl || `<tr><td colspan="4" class="rls-muted">no till events for this register on ${esc(item.date)} ±1 day</td></tr>`}</tbody></table>`, ((t.advances || []).some((a) => a.kind === "advance_missing") || qf) ? "hot" : ""));
      } else if (k === "video") {
        const v = ev.videoCandidates[0];
        parts.push(sec("Watch this transaction — did the cash go in the drawer?", `<div class="rls-video"><div class="rls-video-big">${esc(v.time)} · TR# ${esc(v.transNum)} ${vlinks(v.video)}</div><div>${esc(v.why.join(", "))}${v.opNum ? ` · operator ${esc(v.opNum)}${v.opName ? " " + esc(v.opName) : ""}` : ""}</div><div class="rls-muted">TC# ${esc(v.tcNum || "?")} · total ${esc(money(v.totalCents))} · cash tendered ${esc(money(v.cashTendCents))}${v.changeDueCents ? ` · change ${esc(money(v.changeDueCents))}` : ""}${v.tenders?.length ? ` · tenders: ${esc(v.tenders.map((t) => `${t.label} ${money(t.cents)}`).join(", "))}` : ""}</div></div>`, "hot"));
      } else if (k === "cash") {
        parts.push(sec(`${ev.cashMatches.length} transactions recorded cash near the amount`, `<ul class="rls-list">${ev.cashMatches.slice(0, 8).map((x) => `<li>${esc(x.time)} · TR# ${esc(x.transNum)} · op ${esc(x.opNum || "?")}${x.opName ? " " + esc(x.opName) : ""} · ${esc(x.why.join(", "))} ${vlinks(x.video)}</li>`).join("")}</ul>`));
      } else if (k === "cft") {
        const rows = ev.cftNear || [];
        parts.push(sec("Cash fund transfers near the amount (reference)", `<p class="rls-muted">CFT cash is dispensed by the recycler, not taken from a register, so a CFT does not by itself explain a register shortage. Listed so the amount and the person are in front of you if the journal or video points at a payout.</p><table class="rls-table"><thead><tr><th>Business date</th><th>Keyed</th><th>Amount</th><th>Recipient</th><th>Account</th><th>Reason</th></tr></thead><tbody>${rows.map((c) => `<tr class="${c.keyedLate ? "hit" : ""}"><td>${esc(c.businessDate)}${c.businessDate === item.date ? " ◀" : ""}</td><td>${esc(c.inputDate || "?")} ${esc(c.inputTime || "")}${c.keyedLate ? ' <span class="badge badge-warn">late</span>' : ""}</td><td>${esc(money(c.amountCents))}</td><td>${esc(c.recipient || "?")}</td><td>${esc(c.accountDesc || "")} <span class="rls-muted">${esc(c.accountNbr || "")}</span></td><td>${esc(c.reason || "")}</td></tr>`).join("")}</tbody></table>`));
      } else if (k === "drawer") {
        const d = ev.drawer; if (!d?.rows?.length) continue;
        const rows = [...d.rows].sort((a, b) => (b.near ? 1 : 0) - (a.near ? 1 : 0) || String(a.time).localeCompare(String(b.time)));
        parts.push(sec(`Every drawer open on reg ${esc(item.register)} that day — ${d.count} transactions, each with video`, `<table class="rls-table"><thead><tr><th>Time</th><th>TR#</th><th>Cashier</th><th>Visit</th><th>Cash</th><th>Change</th><th></th></tr></thead><tbody>${rows.map((r) => `<tr class="${r.near ? "hit" : ""}"><td>${esc(r.time || "?")}</td><td>${esc(r.transNum)}${r.nearKind === "in" ? ' <span class="badge badge-warn">cash in ≈ amount</span>' : r.nearKind === "out" ? ' <span class="badge badge-warn">cash OUT ≈ amount</span>' : ""}</td><td>${esc(r.cashier || "?")}</td><td>${esc(money(r.amountCents))}</td><td>${esc(money(r.cashTendCents))}</td><td>${esc(money(r.changeCents))}</td><td>${vlinks({ cctvUrl: r.cctvUrl, receiptUrl: r.receiptUrl })}</td></tr>`).join("")}</tbody></table>${d.explorerUrl ? `<div class="rls-muted"><a href="${esc(d.explorerUrl)}" target="_blank" rel="noopener">Open Drawer search in APPRISS</a></div>` : ""}`));
      } else if (k === "operators") {
        parts.push(sec("Who was on the register", `<table class="rls-table"><thead><tr><th>Operator</th><th>First seen</th><th>Last seen</th><th>Transactions</th><th>Seen in</th></tr></thead><tbody>${ev.operators.map((o) => `<tr><td>${esc(o.opNum)}${o.name ? " " + esc(o.name) : ""}</td><td>${esc(o.firstSeen || "?")}</td><td>${esc(o.lastSeen || "?")}</td><td>${o.transactionCount}</td><td>${esc(o.sources.join(" + "))}</td></tr>`).join("")}</tbody></table>`));
      } else if (k === "redFlags") {
        parts.push(sec("Journal red flags", `<ul class="rls-list">${ev.redFlags.map((f) => `<li>${esc(f.time || "")} · ${esc(f.text)}${f.opNum ? ` · op ${esc(f.opNum)}` : ""}</li>`).join("")}</ul>`));
      } else if (k === "ledgerFlags") {
        parts.push(sec("Ledger flags", `<ul class="rls-list">${ev.ledgerFlags.map((f) => `<li>${esc(f.text)}</li>`).join("")}</ul>`));
      } else if (k === "ledger") {
        const rows = ev.ledgerRows || [];
        parts.push(sec("Cash Research — register history", rows.length ? `<table class="rls-table"><thead><tr><th>Day</th><th>Finalized L/S</th><th>Advances</th><th>Pickups</th><th>In / Out</th></tr></thead><tbody>${rows.map((r) => `<tr class="${r.date === item.date ? "is-day" : ""}"><td>${esc(r.date)}${r.date === item.date ? " ◀" : ""}</td><td class="${r.finalizedLsCents < 0 ? "neg" : r.finalizedLsCents > 0 ? "pos" : ""}">${esc(money(r.finalizedLsCents))}</td><td>${esc(money(r.advancesCents))}</td><td>${esc(money(r.pickupsCents))}</td><td>${r.tillCheckins} / ${r.tillCheckouts}</td></tr>`).join("")}</tbody></table>` : `<div class="rls-muted">No ledger rows.</div>`));
      }
    }
    const day = ev.sections?.find((s) => s.key === "day");
    if (day) parts.push(`<div class="rls-muted">${esc(day.lines[0])}</div>`);
    return parts.length ? `<div class="rls-lookat"><div class="rls-lookat-h">${ev.suggestion?.safe ? "Supporting detail" : "What to look at"}</div>${parts.join("")}</div>` : "";
  }

  function srcPill(name, s) {
    if (!s) return "";
    const cls = s.ok ? "pill-ok" : "pill-fail";
    const text = s.ok ? `${name} ✓${s.rows != null ? ` ${s.rows} days` : s.records != null ? ` ${s.records} records` : s.events != null ? ` ${s.events} events` : s.opens != null ? ` ${s.opens} opens` : s.transfers != null ? ` ${s.transfers} nearby` : s.hasCell === false ? " (no cell)" : ""}` : `${name} ✗ ${s.error || ""}`;
    return `<span class="pill ${cls}">${esc(text)}${!s.ok && s.loginUrl ? ` <a href="${esc(s.loginUrl)}" target="_blank" rel="noopener">sign in</a>` : ""}</span>`;
  }

  function paintOtherDetail(box, o) {
    const kv = (rows) => `<table class="rls-table rls-kv"><tbody>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</tbody></table>`;
    box.innerHTML = `
      <div class="rls-verdict tone-muted">
        <div class="rls-verdict-top"><span class="rls-verdict-item">${esc(o.sourceApp)} · ${esc(o.category)} · ${esc(o.date || "")}${o.periodTo && o.periodTo !== o.date ? ` → ${esc(o.periodTo)}` : ""}${o.isOverDue ? " · <strong>overdue</strong>" : ""}</span></div>
        <h2>${esc(o.headLine || o.category)}</h2>
        <p class="rls-muted">${esc(o.description || "")} Not a register item — no long/short analysis. Work it in APPRISS.</p>
      </div>
      <div class="rls-actions"><a class="btn btn-secondary" href="${esc(o.detailUrl)}" target="_blank" rel="noopener">Open work item ${esc(o.id)}</a></div>
      <div class="rls-block"><h3>Card</h3>${kv([...o.cards.map((c) => [c.label, c.value]), ...(o.potentialValueCents != null ? [["Value potential", money(o.potentialValueCents)]] : []), ...(o.countOfEvents != null ? [["Events", String(o.countOfEvents)]] : [])])}</div>
      ${o.tags.length ? `<div class="rls-block"><h3>Tags</h3>${kv(o.tags.map((t) => [t.label, t.value]))}</div>` : ""}
    `;
  }

  // ── events ──────────────────────────────────────────────────────
  host.ui.delegate(container, "click", "[data-action='refresh-queue']", async (ev) => {
    await commitStore();
    const d = await run("refresh_queue", {}, ev.target.closest("button"));
    if (d) host.ui.toast(`WorkView: ${d.count} register items, ${d.otherCount} other open items`);
    await load();
  });
  host.ui.delegate(container, "click", "[data-action='refresh-grid']", async (ev) => {
    await commitStore();
    const d = await run("refresh_grid", {}, ev.target.closest("button"));
    if (d) host.ui.toast(`Power BI: ${d.cellCount} register-days, ${d.rollup?.r1 ?? 0} unmatched`);
    await load();
  });
  host.ui.delegate(container, "change", "[data-range-from], [data-range-to]", async (ev) => {
    ev.stopPropagation();
    cashierRange = { from: $("[data-range-from]").value, to: $("[data-range-to]").value };
    await loadCashiers(); paintCashiers();
  });
  host.ui.delegate(container, "click", "[data-range-from], [data-range-to], .rls-range", (ev) => { ev.stopPropagation(); });
  host.ui.delegate(container, "click", "[data-action='cashiers-range-clear']", async (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    cashierRange = { from: "", to: "" };
    await loadCashiers(); paintCashiers();
  });
  host.ui.delegate(container, "click", "[data-action='cashier-toggle']", (ev) => {
    const id = ev.target.closest("[data-id]").dataset.id;
    openCashier = openCashier === id ? null : id;
    paintCashiers();
  });
  host.ui.delegate(container, "click", "[data-action='cashier-export']", async (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    const id = ev.target.closest("[data-id]").dataset.id;
    const d = await run("export_cashier_files", { id, from: cashierRange.from, to: cashierRange.to }, ev.target.closest("button"));
    if (d) host.ui.toast(`Saved ${d.files.length} file${d.files.length === 1 ? "" : "s"} to Downloads\\${d.files[0].split("/").slice(0, -1).join("\\")}`);
  });
  host.ui.delegate(container, "click", "[data-action='cashiers-export-all']", async (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    const d = await run("export_cashier_files", { from: cashierRange.from, to: cashierRange.to }, ev.target.closest("button"));
    if (d) host.ui.toast(`Saved ${d.files.length} cashier files to Downloads\\${d.files[0].split("/").slice(0, -1).join("\\")}`);
  });
  host.ui.delegate(container, "submit", "[data-note-form]", async (ev) => {
    ev.preventDefault();
    const f = ev.target.closest("form");
    const fd = new FormData(f);
    const d = await run("add_coaching_note", { id: f.dataset.id, date: fd.get("date"), action: fd.get("action"), note: fd.get("note") }, f.querySelector("button"));
    if (d) { cashiers.notes[f.dataset.id] = d.notes; paintCashiers(); host.ui.toast("Coaching note saved"); }
  });
  host.ui.delegate(container, "click", "[data-action='note-remove']", async (ev) => {
    const el = ev.target.closest("[data-id]");
    const d = await run("remove_coaching_note", { id: el.dataset.id, at: el.dataset.at }, ev.target.closest("button"));
    if (d) { cashiers.notes[el.dataset.id] = d.notes; paintCashiers(); }
  });
  host.ui.delegate(container, "click", "[data-action='refresh-tills']", async (ev) => {
    await commitStore();
    const d = await run("refresh_tills", {}, ev.target.closest("button"));
    if (d) host.ui.toast(`Till log: ${d.rows} events, ${d.dateMin} → ${d.dateMax}`);
    await load();
  });
  host.ui.delegate(container, "click", "[data-action='refresh-cft']", async (ev) => {
    await commitStore();
    const d = await run("refresh_cft", {}, ev.target.closest("button"));
    if (d) host.ui.toast(`Cash fund transfers: ${d.rows} transfers, ${d.dateMin} → ${d.dateMax}`);
    await load();
  });
  host.ui.delegate(container, "click", "[data-action='analyze-all']", async (ev) => {
    const d = await run("analyze_all", {}, ev.target.closest("button"));
    if (d) host.ui.toast(`Analyzed ${d.analyzed} items${d.failed ? `, ${d.failed} failed` : ""}`);
    await reloadSelected(); await load();
  });
  host.ui.delegate(container, "click", "[data-action='analyze']", async (ev) => {
    if (!selectedId) return;
    const d = await run("analyze_item", { id: selectedId }, ev.target.closest("button"));
    if (d) { analysis = d.analysis; host.ui.toast(analysis.evidence.verdictLabel); }
    await load();
  });
  // Step 1: the verification dialog (second look at reason + text).
  let pending = null;
  host.ui.delegate(container, "click", "[data-action='prefill']", (ev) => {
    const item = state.queue?.items.find((i) => i.id === selectedId);
    const sug = analysis?.evidence?.suggestion || item?.pre?.suggestion;
    if (!selectedId || !sug || !item) return;
    const text = $("[data-sug-text]")?.value?.trim() || sug.text;
    const reasonLabel = sug.reasonLabel || $("[data-cause]")?.value || "";
    if (!reasonLabel) { host.ui.toast("Pick the cause you found first.", { kind: "error" }); return; }
    pending = { id: selectedId, reasonLabel };
    $("[data-verify-item]").innerHTML = `Work item <strong>${esc(item.id)}</strong> · Reg ${esc(item.register)} · ${esc(item.date)} · <strong>${esc(money(item.amountCents))}</strong> · ${esc(item.category)}`;
    $("[data-verify-reason]").textContent = reasonLabel;
    $("[data-verify-text]").value = text;
    $("[data-verify-ack]").checked = false;
    $("[data-action='verify-complete']").disabled = true;
    $("[data-verify]").showModal();
  });
  host.ui.delegate(container, "change", "[data-verify-ack]", (ev) => { $("[data-action='verify-complete']").disabled = !ev.target.checked || !$("[data-verify-text]").value.trim(); });
  host.ui.delegate(container, "click", "[data-action='verify-cancel']", () => { pending = null; $("[data-verify]").close(); });
  // Step 2: close the dialog at once and complete in the background. The
  // row shows "completing…" until the service worker reports back; several
  // items can be in flight while the analyst moves on to the next one.
  host.ui.delegate(container, "click", "[data-action='verify-complete']", (ev) => {
    if (!pending) return;
    const text = $("[data-verify-text]").value.trim();
    if (!text) { host.ui.toast("More Information cannot be empty.", { kind: "error" }); return; }
    const { id, reasonLabel } = pending;
    $("[data-verify]").close(); pending = null;
    inFlight.set(id, { reasonLabel, startedAt: Date.now() });
    paintQueue(); paintDetail();
    host.ui.toast(`Completing ${id} in the background…`);
    run("complete_disposition", { id, reasonLabel, text }, null).then(async (d) => {
      inFlight.delete(id);
      if (d?.completed) host.ui.toast(`Work item ${id} completed as ${d.chosen || reasonLabel}`);
      else if (d?.alreadyClosed) host.ui.toast(`Work item ${id} was already dispositioned in APPRISS — removed from the board`);
      else if (d) host.ui.toast(`Not completed (${id}): ${d.error || "form did not confirm"}`, { kind: "error" });
      if ((d?.completed || d?.alreadyClosed) && selectedId === id) { selectedId = null; analysis = null; }
      await load();
    }).catch((e) => { inFlight.delete(id); host.ui.toast(`Not completed (${id}): ${e?.message || e}`, { kind: "error" }); paintQueue(); paintDetail(); });
  });
  host.ui.delegate(container, "change", "[data-cause]", (ev) => {
    const btn = $("[data-action='prefill']"); if (btn) btn.disabled = !ev.target.value;
  });
  host.ui.delegate(container, "click", ".rls-row", async (ev) => {
    const id = ev.target.closest(".rls-row")?.dataset.id;
    if (!id) return;
    selectedId = id; await reloadSelected();
    paintQueue(); paintDetail();
  });
  host.ui.delegate(container, "click", "[data-jump]", (ev) => {
    const g = $(`[data-group="${ev.target.closest("[data-jump]").dataset.jump}"]`);
    g?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  host.ui.delegate(container, "change", "#rls-store", async () => { await commitStore(); await load(); });

  async function reloadSelected() {
    analysis = null;
    if (!selectedId) return;
    if (state?.analyses?.[selectedId]?.stale) return;   // grid changed since; show grid-only until re-analysed
    try { const res = await host.messaging.send("get_analysis", { id: selectedId }); analysis = res?.data?.analysis || null; }
    catch { analysis = null; }
  }

  async function commitStore() {
    const v = $("#rls-store").value.trim();
    if (v === (state?.store.storeNbr || "") && state?.store.source !== "none") return;
    await host.messaging.send("set_store_override", { storeNbr: v });
  }

  const unsubProgress = host.messaging.on("progress", (msg) => {
    const el = $("[data-progress]"); if (el) el.textContent = msg?.payload?.text || msg?.text || "";
  });

  await load();
  await bootstrap();
  return () => { unmounted = true; unsubProgress(); link.remove(); };

  // Opening the module loads everything the board needs, in order, so a
  // fresh profile (or a stale one) never sits on "not pulled" waiting for
  // three clicks. WorkView re-pulls after 30 min because items dispositioned
  // directly in APPRISS leave the board stale; Power BI and the till log
  // change once a day and re-pull after 6 h. Anything that just changed is
  // then analyzed, so the detail pane has the ledger and journal ready.
  async function bootstrap() {
    if (!state?.store.storeNbr) return;
    const stale = (iso, min) => !iso || Date.now() - new Date(iso).getTime() > min * 60_000;
    const steps = [];
    if (!state.queue || stale(state.queue.fetchedAt, 30)) steps.push({ action: "refresh_queue", btn: "refresh-queue", label: "WorkView" });
    if (!state.grid?.capturedAt || stale(state.grid.capturedAt, 6 * 60)) steps.push({ action: "refresh_grid", btn: "refresh-grid", label: "Power BI" });
    if (!state.tills || stale(state.tills.fetchedAt, 6 * 60)) steps.push({ action: "refresh_tills", btn: "refresh-tills", label: "Till log" });
    if (!state.cft || stale(state.cft.fetchedAt, 6 * 60)) steps.push({ action: "refresh_cft", btn: "refresh-cft", label: "Cash fund transfers" });
    // Items whose analysis is missing or from an older schema still need a
    // pass even when every source is fresh (e.g. after an extension update).
    const needsAnalysis = (state.queue?.items || []).some((i) => i.register && i.date && !state.analyses?.[i.id] && !["flip", "bounceback"].includes(i.pre?.verdict));
    if (!steps.length && !needsAnalysis) return;
    const loaded = [];
    for (const st of steps) {
      if (unmounted) return;
      progress(`Loading ${st.label}…`);
      const d = await run(st.action, {}, $(`[data-action='${st.btn}']`));
      if (unmounted) return;
      if (d) loaded.push(st.label);
      await load();
    }
    if (loaded.length) host.ui.toast(`Loaded ${loaded.join(", ")}`);
    if ((!loaded.length && !needsAnalysis) || !state.grid?.capturedAt || !state.queue) { progress(""); return; }
    // analyze_all reports "nothing needs analysis" as ok:false; that is not
    // an error on open, so call it directly instead of through run().
    const btn = $("[data-action='analyze-all']"); setBusy(btn, true);
    try {
      const res = await host.messaging.sendRaw("analyze_all", {}, { timeoutMs: 1_800_000 });
      const d = res && res.data !== undefined ? res.data : res;
      if (d?.ok && d.analyzed) host.ui.toast(`Analyzed ${d.analyzed} items${d.failed ? `, ${d.failed} failed` : ""}`);
    } catch (e) { host.ui.toast(`Analysis did not finish: ${e?.message || e}`, { kind: "error" }); }
    finally { setBusy(btn, false); progress(""); }
    if (unmounted) return;
    await reloadSelected(); await load();
  }

  function progress(text) { const el = $("[data-progress]"); if (el) el.textContent = text; }
}

function money(cents) {
  if (cents == null) return "?";
  return `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function ago(iso) {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
