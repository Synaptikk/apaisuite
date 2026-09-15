// modules/boblisa/view.js
//
// BoB and Lisa — shell page. Two tabs (manned / unmanned first transaction),
// training-receipt cards, per-tab filters, rows that expand to both item
// lists with APPRISS CCTV links built from register + time. All data comes from
// service.js::get_state; nothing is computed here beyond filter + sort.
//
// Documented misses: any expanded row has "Document this miss" (cause, how
// it was caught, video review, cashier name, note — drafted from the pair);
// "Find APPRISS video" resolves transaction-id CCTV + receipt links through
// Open Drawer like the L/S triage. The Documented tab lists every record for
// the store with a per-cashier rollup and a CSV export.

import { TYPES, registerType as regTypeOf } from "./lib/registers.js";
import { videoUrl } from "./lib/video.js";
import { CAUSES, OUTCOMES, VIDEO_REVIEW, draftNote, rollupByCashier, pairFromRecord } from "./lib/misses.js";

const MONEY = (c) => "$" + ((Number(c) || 0) / 100).toFixed(2);
const SORTS = {
  train_value: (a, b) => (b.training - a.training) || (b.t2.total - a.t2.total),
  value:       (a, b) => b.t2.total - a.t2.total,
  score:       (a, b) => b.score - a.score || b.t2.total - a.t2.total,
  gap:         (a, b) => a.gapSec - b.gapSec || b.t2.total - a.t2.total,
  date:        (a, b) => a.date.localeCompare(b.date) || a.t1.time.localeCompare(b.t1.time),
};
const PREFS_KEY = "prefs.v3";   // v3: Automotive hidden by default (user rule 2026-09-15)
// Money Center second transactions (bill pay, card payments, debit loads) are
// financial services; Automotive (95) is tires and service. Both are the
// same customer buying something else, not a missed item — off by default.
const HIDDEN_DEFAULT = new Set(["Money Center", "Automotive"]);

export async function mount(host, container) {
  const esc = host.ui.escapeHtml;
  const link = document.createElement("link");
  link.rel = "stylesheet"; link.href = host.url("styles.css"); link.dataset.module = host.id;
  const cssReady = new Promise((resolve) => {
    if (link.sheet) return resolve();
    link.addEventListener("load", resolve, { once: true });
    link.addEventListener("error", resolve, { once: true });
    setTimeout(resolve, 3000);
  });
  document.head.appendChild(link);
  await cssReady;
  container.innerHTML = await fetch(host.url("view.html")).then((r) => r.text());

  const $ = (sel) => container.querySelector(sel);
  const els = {
    store: $("#boblisa-store"), storeSrc: $("#boblisa-store-src"), from: $("#boblisa-from"), to: $("#boblisa-to"),
    pull: $("#boblisa-pull"), repull: $("#boblisa-repull"), progress: $("#boblisa-progress"), status: $("#boblisa-status"),
    summary: $("#boblisa-summary"), trainings: $("#boblisa-trainings"),
  };

  let state = null;
  let busy = false;
  const ui = {
    tab: "manned",
    manned:   { types: new Set(TYPES.filter((t) => !HIDDEN_DEFAULT.has(t))), vision: false, training: false, minDollars: 3, sort: "train_value", open: new Set() },
    unmanned: { types: new Set(TYPES.filter((t) => !HIDDEN_DEFAULT.has(t))), vision: false, training: false, minDollars: 3, sort: "train_value", open: new Set() },
    editing: new Set(),   // pair keys with the document form open
    video: {},            // pair key → link_video result (session only)
  };

  // ── prefs ─────────────────────────────────────────────────────
  async function loadPrefs() {
    const p = await host.storage.local.get(PREFS_KEY).catch(() => null);
    if (!p) return;
    for (const cat of ["manned", "unmanned"]) {
      const s = p[cat]; if (!s) continue;
      // Stored as the HIDDEN types so a register type added later shows by default.
      if (Array.isArray(s.hidden)) ui[cat].types = new Set(TYPES.filter((t) => !s.hidden.includes(t)));
      if (typeof s.minDollars === "number") ui[cat].minDollars = s.minDollars;
      if (SORTS[s.sort]) ui[cat].sort = s.sort;
    }
    if (["manned", "unmanned", "unpaid", "documented"].includes(p.tab)) ui.tab = p.tab;
  }
  function savePrefs() {
    const pick = (s) => ({ hidden: TYPES.filter((t) => !s.types.has(t)), minDollars: s.minDollars, sort: s.sort });
    host.storage.local.set(PREFS_KEY, { tab: ui.tab, manned: pick(ui.manned), unmanned: pick(ui.unmanned) }).catch(() => {});
  }

  // ── data ──────────────────────────────────────────────────────
  async function refresh(extra = {}) {
    const res = await host.messaging.sendRaw("get_state", extra);
    if (!res?.ok) { showStatus("error", res?.error || "Could not read module state."); return; }
    state = res;
    paint();
  }

  async function pull({ force = false } = {}) {
    if (busy) return;
    busy = true; els.pull.disabled = els.repull.disabled = true;
    showStatus(null);
    els.progress.textContent = "Opening EJ Viewer…";
    try {
      const res = await host.messaging.sendRaw("pull_range", { storeNbr: els.store.value.trim(), from: els.from.value, to: els.to.value, force }, { timeoutMs: 15 * 60_000 });
      if (!res?.ok) {
        const login = res?.loginUrl ? ` <a href="${esc(res.loginUrl)}" target="_blank" rel="noopener">Open EJ Viewer and sign in</a>, then pull again.` : "";
        showStatus("error", `${esc(res?.error || "Pull failed.")}${login}`, true);
      } else if (res.failed) {
        showStatus("warn", `${res.pulled} day${res.pulled === 1 ? "" : "s"} pulled, ${res.failed} failed. Failed days are listed under the summary.`);
      } else {
        host.ui.toast(`${res.pulled} day${res.pulled === 1 ? "" : "s"} pulled`, { kind: "ok" });
      }
      if (res && res.days) { state = { ...(state || {}), ...res }; paint(); }
    } catch (e) {
      showStatus("error", esc(String(e?.message || e)));
    } finally {
      busy = false; els.pull.disabled = els.repull.disabled = false; els.progress.textContent = "";
    }
  }

  function showStatus(kind, html, isHtml = false) {
    if (!kind) { els.status.hidden = true; els.status.innerHTML = ""; return; }
    els.status.hidden = false;
    els.status.className = `bl-status status-strip status-strip-${kind === "error" ? "error" : kind === "warn" ? "warn" : "info"}`;
    els.status.innerHTML = isHtml ? html : esc(html);
  }

  // ── paint ─────────────────────────────────────────────────────
  function visiblePairs(cat) {
    const s = ui[cat];
    return (state?.pairs || [])
      .filter((p) => p.category === cat && s.types.has(p.t2.type) && (!s.vision || p.vision) && (!s.training || p.training) && p.t2.total >= Math.round(s.minDollars * 100))
      .sort(SORTS[s.sort]);
  }

  function paint() {
    if (!state) return;
    els.store.value = state.store || "";
    els.storeSrc.textContent = state.store ? (state.storeSource === "override" ? "manual" : state.storeSource === "profile" ? "your store" : "") : "no store set";
    if (state.range) { els.from.value = state.range.from; els.to.value = state.range.to; }

    const pairs = state.pairs || [];
    const manned = pairs.filter((p) => p.category === "manned"), unmanned = pairs.filter((p) => p.category === "unmanned");
    const pulledDays = (state.days || []).filter((d) => d.fetchedAt).length;
    const failedDays = (state.days || []).filter((d) => d.error);
    const tiles = [
      ["pairs", pairs.length, "token pairs", `${pulledDays} of ${(state.days || []).length} days pulled`],
      ["manned", manned.length, "manned lanes", `${manned.filter((p) => p.training).length} confirmed by training receipt`],
      ["unmanned", unmanned.length, "unmanned registers", `${unmanned.filter((p) => p.t2.type === "Self-checkout").length} second trips at self-checkout`],
      ["train", (state.trainings || []).length, "training receipts", `${(state.trainings || []).filter((t) => t.paid.length).length} traced to a paid sale, ${(state.trainings || []).filter((t) => !t.paid.length).length} unpaid`],
    ];
    els.summary.innerHTML = tiles.map(([k, n, l, s]) => `<div class="bl-sum bl-sum-${k}"><div class="bl-sum-n">${n}</div><div class="bl-sum-l">${esc(l)}</div><div class="bl-sum-s">${esc(s)}</div></div>`).join("")
      + (failedDays.length ? `<div class="bl-failed">Not pulled: ${failedDays.map((d) => `<span title="${esc(d.error || "")}">${esc(d.date)}</span>`).join(", ")}</div>` : "")
      + (!pulledDays && state.store ? `<div class="bl-empty">No journal days cached for store ${esc(state.store)} in this range. Pull journal to start.</div>` : "");

    paintTrainings();
    $("#boblisa-cnt-manned").textContent = manned.length;
    $("#boblisa-cnt-unmanned").textContent = unmanned.length;
    $("#boblisa-cnt-unpaid").textContent = (state.trainings || []).filter((t) => !t.paid.length).length;
    $("#boblisa-cnt-documented").textContent = Object.keys(state.misses || {}).length;
    for (const cat of ["manned", "unmanned"]) { paintControls(cat); paintTable(cat); }
    paintUnpaid();
    paintDocumented();
    setTab(ui.tab);
  }
  function repaintAll() {
    if (!state) return;
    for (const cat of ["manned", "unmanned"]) paintTable(cat);
    paintDocumented();
    $("#boblisa-cnt-documented").textContent = Object.keys(state.misses || {}).length;
  }

  function paintTrainings() {
    const list = (state.trainings || []).filter((t) => t.paid.length);
    if (!list.length) { els.trainings.innerHTML = ""; return; }
    els.trainings.innerHTML = `<h2 class="bl-h2">Training receipts, paid <span class="bl-muted">door-host handhelds, matched to a sale by UPC</span></h2><div class="bl-tcards">` + list.map((t) => {
      const items = t.items.map((i) => `${esc(i.desc)} ${MONEY(i.cents)}`).join(", ");
      const paid = t.paid.length ? t.paid.map((s) => `<div class="bl-chain"><b>Paid</b> ${esc(s.time)} · reg ${s.reg}${typeTag(s.type)} · TR ${esc(s.tr)} · ${MONEY(s.total)} ${esc(s.tender)}${s.hasToken ? "" : " · no token"} ${videoBtn(t.date, s.reg, s.tr, s.time)}${s.prev ? `<br><b>Same card earlier</b> ${esc(s.prev.time)} · reg ${s.prev.reg}${typeTag(s.prev.type)} · op ${esc(s.prev.op)} · TR ${esc(s.prev.tr)} · ${s.prev.items} items ${MONEY(s.prev.total)} ${videoBtn(t.date, s.prev.reg, s.prev.tr, s.prev.time)}` : ""}</div>`).join("")
        : `<div class="bl-chain bl-muted">No paid sale with this item within 15 minutes — the item may have been handed back.</div>`;
      return `<div class="bl-tcard"><div class="bl-tcard-h">${esc(t.date)} · ${esc(t.time)} · reg ${t.reg} · op ${esc(t.op)} · TR ${esc(t.tr)}</div><div class="bl-tcard-items">${items}</div>${paid}</div>`;
    }).join("") + `</div>`;
  }

  const typeTag = (type) => `<span class="bl-type">${esc(type)}</span>`;
  // APPRISS CCTV by store + register + time window: no transaction id needed
  // (lib/video.js). Opens as an ordinary tab on the user's own SSO cookie.
  function videoBtn(date, reg, tr, time = "") {
    const href = state?.store && time ? videoUrl(state.store, reg, date, time) : null;
    if (!href) return "";
    return `<a class="btn btn-sm btn-ghost bl-video" href="${esc(href)}" target="_blank" rel="noopener" title="APPRISS CCTV, register ${reg}, around ${esc(time)}">▶ Video</a>`;
  }

  function paintControls(cat) {
    const s = ui[cat];
    const host_ = container.querySelector(`[data-controls="${cat}"]`);
    const present = new Set((state.pairs || []).filter((p) => p.category === cat).map((p) => p.t2.type));
    host_.innerHTML = `
      <div class="bl-chips"><span class="bl-lbl">Second register</span>${TYPES.filter((t) => present.has(t)).map((t) => `<button class="bl-chip" data-type="${esc(t)}" aria-pressed="${s.types.has(t)}">${esc(t)}</button>`).join("")}</div>
      <div class="bl-chips"><button class="bl-chip bl-chip-v" data-flag="vision" aria-pressed="${s.vision}">Vision only</button><button class="bl-chip bl-chip-t" data-flag="training" aria-pressed="${s.training}">Training only</button></div>
      <label class="bl-field">Min $ <input class="input bl-min" data-min type="number" min="0" step="1" value="${s.minDollars}"></label>
      <label class="bl-field bl-sort">Sort <select class="input" data-sort>
        <option value="train_value">Training first, then second $</option><option value="value">Second transaction $</option><option value="score">Score</option><option value="gap">Shortest gap</option><option value="date">Date and time</option></select></label>`;
    host_.querySelector("[data-sort]").value = s.sort;
  }

  function paintTable(cat) {
    const s = ui[cat];
    const table = container.querySelector(`[data-table="${cat}"]`);
    const rows = visiblePairs(cat);
    if (!rows.length) { table.innerHTML = `<tr><td class="bl-empty">${state.pairs?.length ? "No pairs match these filters." : "Nothing pulled yet."}</td></tr>`; return; }
    const head = `<thead><tr><th class="bl-grp" colspan="3">First transaction</th><th class="bl-grp bl-t2" colspan="4">Second transaction</th><th class="bl-grp"></th></tr>
      <tr><th>Date</th><th>Register · cashier</th><th class="bl-num">Items · total</th><th class="bl-t2">Register</th><th>Gap</th><th>Items</th><th class="bl-num">Total</th><th>Flags</th></tr></thead>`;
    const body = rows.map((p) => {
      const open = s.open.has(p.key);
      const flags = [
        p.training ? `<span class="badge badge-success">Training</span>` : "",
        p.vision ? `<span class="badge badge-info bl-vision">Vision</span>` : "",
        p.repeat ? `<span class="badge badge-warn">Repeat UPC</span>` : "",
        p.sameCashier ? `<span class="badge badge-neutral">Same cashier</span>` : "",
        state.misses?.[p.key] ? `<span class="badge badge-neutral bl-docd" title="${esc(CAUSES[state.misses[p.key].cause] || "")}">Documented</span>` : "",
      ].join(" ");
      const items = p.t2.items.map((it) => `${esc(it.desc)} <span class="bl-mono">${MONEY(it.cents)}</span>${it.onT1 ? ` <span class="bl-also">also on first</span>` : ""}${it.service ? ` <span class="bl-also">money service</span>` : ""}`).join("<br>");
      return `<tr class="bl-row${open ? " is-open" : ""}" data-key="${esc(p.key)}" tabindex="0">
        <td class="bl-mono">${esc(p.date.slice(5).replace("-", "/"))}<span class="bl-subl">${esc(p.t1.time)}</span></td>
        <td><span class="bl-reg">Reg ${p.t1.reg}</span>${typeTag(p.t1.type)}<span class="bl-subl">op ${esc(p.t1.op)} · TR ${esc(p.t1.tr)}</span></td>
        <td class="bl-num">${p.t1.items} · ${MONEY(p.t1.total)}</td>
        <td class="bl-t2"><span class="bl-reg">Reg ${p.t2.reg}</span>${typeTag(p.t2.type)}<span class="bl-subl">${esc(p.t2.time)} · op ${esc(p.t2.op)} · TR ${esc(p.t2.tr)}</span></td>
        <td class="bl-num">+${p.gapMin} min</td>
        <td class="bl-items">${items}</td>
        <td class="bl-money">${MONEY(p.t2.total)}<span class="bl-subl">${esc(p.t2.tender)}</span></td>
        <td>${flags}</td></tr>` + (open ? detailRow(p) : "");
    }).join("");
    table.innerHTML = head + `<tbody>${body}</tbody>`;
  }

  function detailRow(p) {
    const kv = (rows) => `<dl class="bl-kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
    return `<tr class="bl-detail"><td colspan="8"><div class="bl-dgrid">
      <div><h4>First transaction ${videoBtn(p.date, p.t1.reg, p.t1.tr, p.t1.time)}</h4>${kv([["Register", `${p.t1.reg} (${esc(p.t1.type)})`], ["Cashier", `op ${esc(p.t1.op)}`], ["TR#", esc(p.t1.tr)], ["Time", esc(p.t1.time)], ["Items", p.t1.items], ["Total", `${MONEY(p.t1.total)} ${esc(p.t1.tender)}`], ["Token", `…${esc(p.token)}`]])}</div>
      <div><h4>Second transaction · ${p.gapMin} min later ${videoBtn(p.date, p.t2.reg, p.t2.tr, p.t2.time)}</h4>${kv([["Register", `${p.t2.reg} (${esc(p.t2.type)})`], ["Operator", `op ${esc(p.t2.op)}`], ["TR#", esc(p.t2.tr)], ["Time", esc(p.t2.time)], ["Total", `${MONEY(p.t2.total)} ${esc(p.t2.tender)}`]])}
        <ul class="bl-ilist">${p.t2.items.map((it) => `<li><span>${esc(it.desc)} <span class="bl-mono bl-muted">${esc(it.code)}</span>${it.onT1 ? ` <span class="bl-also">also on first</span>` : ""}${it.service ? ` <span class="bl-also">money service</span>` : ""}</span><span class="bl-mono">${MONEY(it.cents)}</span></li>`).join("")}</ul>
        ${p.trainingRef ? `<div class="bl-chain"><b>Training receipt</b> ${esc(p.trainingRef.time)} · reg ${p.trainingRef.reg} · op ${esc(p.trainingRef.op)} · TR ${esc(p.trainingRef.tr)}</div>` : ""}</div>
      <div class="bl-doc">${videoBlock(p)}${docBlock(p)}</div>
    </div></td></tr>`;
  }

  // ── documented misses ─────────────────────────────────────────
  const recFor = (key) => state?.misses?.[key] || null;
  const pairFor = (key) => (state?.pairs || []).find((p) => p.key === key) || pairFromRecord(recFor(key));
  const sel = (name, opts, cur) => `<select class="input" name="${name}">${Object.entries(opts).map(([k, l]) => `<option value="${k}"${k === cur ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  const fmtAt = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? String(iso || "") : d.toLocaleString(undefined, { month: "2-digit", day: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }); };
  const mmdd = (iso) => esc(String(iso || "").slice(5).replace("-", "/"));

  // APPRISS links on the transaction id (from link_video), like the L/S triage.
  function apprissLinks(v, label) {
    if (!v?.cctvUrl) return "";
    return `<a class="btn btn-sm btn-primary bl-video" href="${esc(v.cctvUrl)}" target="_blank" rel="noopener" title="APPRISS CCTV on this transaction id">▶ ${esc(label)} video</a><a class="btn btn-sm btn-secondary bl-video" href="${esc(v.receiptUrl)}" target="_blank" rel="noopener" title="APPRISS receipt viewer">Receipt</a>${v.byTime ? `<span class="bl-muted" title="This sale never opened the drawer, so APPRISS has no id for it; this is the nearest drawer open on the same register within 90 s">matched by time</span>` : ""}`;
  }

  function videoBlock(p) {
    const v = ui.video[p.key];
    const saved = recFor(p.key)?.videoIds;
    if (!v && saved && (saved.t1 || saved.t2)) return `<div class="bl-vidrow">${apprissLinks(saved.t1, "First")}${apprissLinks(saved.t2, "Second")}<button class="btn btn-sm btn-ghost bl-vid-find" data-key="${esc(p.key)}">Look up again</button></div>`;
    if (!v) return `<div class="bl-vidrow"><button class="btn btn-sm btn-secondary bl-vid-find" data-key="${esc(p.key)}">Find APPRISS video</button><span class="bl-muted">transaction-id CCTV and receipt links through Open Drawer, like the L/S triage; the ▶ Video buttons above play the register by time</span></div>`;
    if (v.busy) return `<div class="bl-vidrow bl-muted">Looking up Open Drawer for reg ${p.t1.reg}${String(p.t2.reg) !== String(p.t1.reg) ? ` and reg ${p.t2.reg}` : ""} on ${mmdd(p.date)}…</div>`;
    if (!v.ok) return `<div class="bl-vidrow"><span class="bl-warn">${esc(v.error || "Open Drawer lookup failed.")}</span>${v.loginUrl ? `<a href="${esc(v.loginUrl)}" target="_blank" rel="noopener">Sign in to APPRISS</a>` : ""}<button class="btn btn-sm btn-ghost bl-vid-find" data-key="${esc(p.key)}">Retry</button></div>`;
    const none = (reg) => `<span class="bl-muted">reg ${reg}: ${v.empty?.includes(String(reg)) ? "no drawer opens that day in Open Drawer (outside APPRISS's 60-day window, or none)" : "no transaction id"}</span>`;
    return `<div class="bl-vidrow">${v.t1 ? apprissLinks(v.t1, "First") : none(p.t1.reg)}${v.t2 ? apprissLinks(v.t2, "Second") : none(p.t2.reg)}${v.explorer ? `<a class="bl-muted" href="${esc(v.explorer)}" target="_blank" rel="noopener">Open Drawer in APPRISS</a>` : ""}</div>`;
  }

  function docBlock(p) {
    const rec = recFor(p.key);
    if (ui.editing.has(p.key)) return missForm(p, rec);
    if (!rec) return `<div class="bl-doc-actions"><button class="btn btn-sm btn-primary bl-doc-open" data-key="${esc(p.key)}">Document this miss</button><span class="bl-muted">saves the cashier, what was missed, how it was caught and your note; kept across pulls</span></div>`;
    return `<div class="bl-doc-card">
      <div><span class="badge badge-neutral bl-docd">Documented</span> <b>${esc(CAUSES[rec.cause] || rec.cause)}</b> · ${esc(OUTCOMES[rec.outcome] || rec.outcome)} · ${esc(VIDEO_REVIEW[rec.video] || VIDEO_REVIEW.not_reviewed)}</div>
      <div>Cashier op ${esc(rec.cashier.op)}${rec.cashier.name ? ` · ${esc(rec.cashier.name)}` : ""} · missed ${MONEY(rec.missedCents)}</div>
      ${rec.note ? `<div class="bl-doc-note">${esc(rec.note)}</div>` : ""}
      <div class="bl-doc-meta">Documented ${esc(fmtAt(rec.createdAt))}${rec.createdByName || rec.createdBy ? ` by ${esc(rec.createdByName || rec.createdBy)}` : ""}${rec.updatedAt !== rec.createdAt ? ` · edited ${esc(fmtAt(rec.updatedAt))}` : ""}</div>
      <div class="bl-doc-actions"><button class="btn btn-sm btn-secondary bl-doc-open" data-key="${esc(p.key)}">Edit</button><button class="btn btn-sm btn-ghost bl-doc-remove" data-key="${esc(p.key)}">Remove</button></div></div>`;
  }

  function missForm(p, rec) {
    const cause = rec?.cause || "bottom_of_basket";
    const outcome = rec?.outcome || (p.training ? "training_receipt" : "door_paid");
    const video = rec?.video || "not_reviewed";
    return `<form class="bl-docform" data-docform="${esc(p.key)}">
      <label class="bl-field">Cause ${sel("cause", CAUSES, cause)}</label>
      <label class="bl-field">How it was caught ${sel("outcome", OUTCOMES, outcome)}</label>
      <label class="bl-field">Video ${sel("video", VIDEO_REVIEW, video)}</label>
      <label class="bl-field">Cashier name <input class="input" name="cashierName" value="${esc(rec?.cashier?.name || "")}" placeholder="op ${esc(p.t1.op)} — name optional"></label>
      <label class="bl-field bl-field-wide">Note <textarea class="input" name="note">${esc(rec ? rec.note : draftNote(p))}</textarea></label>
      <div class="bl-doc-actions"><button type="submit" class="btn btn-sm btn-primary">${rec ? "Save changes" : "Save"}</button><button type="button" class="btn btn-sm btn-ghost bl-doc-cancel" data-key="${esc(p.key)}">Cancel</button></div>
    </form>`;
  }

  function paintDocumented() {
    const records = Object.values(state.misses || {}).sort((a, b) => b.date.localeCompare(a.date) || String(b.t1?.time || "").localeCompare(String(a.t1?.time || "")));
    const roll = rollupByCashier(records);
    $("#boblisa-doc-rollup").innerHTML = roll.map((c) => `<div class="bl-cashier"><div class="bl-cashier-h">Op ${esc(c.op)}${c.name ? ` · ${esc(c.name)}` : ""}</div><div class="bl-cashier-n">${c.count} <span class="bl-cashier-s">miss${c.count === 1 ? "" : "es"} · ${MONEY(c.cents)}</span></div><div class="bl-cashier-s">reg ${esc(c.registers.join(", "))} · ${mmdd(c.first)}${c.last !== c.first ? ` – ${mmdd(c.last)}` : ""} · ${esc(Object.entries(c.causes).map(([k, n]) => `${n}× ${CAUSES[k] || k}`).join(", "))}</div></div>`).join("");
    const table = container.querySelector(`[data-table="documented"]`);
    if (!records.length) { table.innerHTML = `<tr><td class="bl-empty">Nothing documented for store ${esc(state.store || "")} yet. Open a row on the manned or unmanned tab and click "Document this miss".</td></tr>`; return; }
    const head = `<thead><tr><th>Date</th><th>Cashier</th><th>Register</th><th>Missed</th><th class="bl-num">$</th><th>Cause · caught · video</th><th>Note</th><th></th></tr></thead>`;
    const body = records.map((r) => {
      const p = pairFromRecord(r);
      const items = (r.t2?.items || []).map((it) => `${esc(it.desc)} <span class="bl-mono">${MONEY(it.cents)}</span>`).join("<br>");
      const vid = r.videoIds?.t1?.cctvUrl ? `<a class="btn btn-sm btn-primary bl-video" href="${esc(r.videoIds.t1.cctvUrl)}" target="_blank" rel="noopener" title="APPRISS CCTV on the first transaction${r.videoIds.t1.byTime ? " (matched by time)" : ""}">▶ Video</a>` : videoBtn(r.date, r.t1.reg, r.t1.tr, r.t1.time);
      return `<tr class="bl-docrow" data-key="${esc(r.key)}">
        <td class="bl-mono">${mmdd(r.date)}<span class="bl-subl">${esc(r.t1.time)}</span></td>
        <td>op ${esc(r.cashier.op)}${r.cashier.name ? `<span class="bl-subl">${esc(r.cashier.name)}</span>` : ""}</td>
        <td><span class="bl-reg">Reg ${esc(r.t1.reg)}</span>${typeTag(r.t1.type || "")}<span class="bl-subl">then reg ${esc(r.t2.reg)} +${esc(r.gapMin)} min${r.flags?.training ? " · training receipt" : ""}</span></td>
        <td class="bl-items">${items}</td>
        <td class="bl-money">${MONEY(r.missedCents)}</td>
        <td>${esc(CAUSES[r.cause] || r.cause)}<span class="bl-subl">${esc(OUTCOMES[r.outcome] || r.outcome)}</span><span class="bl-subl">${esc(VIDEO_REVIEW[r.video] || VIDEO_REVIEW.not_reviewed)}</span></td>
        <td class="bl-note-cell">${esc(r.note)}<span class="bl-subl">${esc(r.createdByName || r.createdBy || "")} ${esc(fmtAt(r.createdAt))}</span></td>
        <td class="bl-doc-td"><div class="bl-doc-actions">${vid}<button class="btn btn-sm btn-secondary bl-doc-open" data-key="${esc(r.key)}">Edit</button><button class="btn btn-sm btn-ghost bl-doc-remove" data-key="${esc(r.key)}">Remove</button></div></td></tr>`
        + (ui.editing.has(r.key) ? `<tr class="bl-detail"><td colspan="8"><div class="bl-doc">${videoBlock(p)}${missForm(p, r)}</div></td></tr>` : "");
    }).join("");
    table.innerHTML = head + `<tbody>${body}</tbody>`;
  }

  function paintUnpaid() {
    const table = container.querySelector(`[data-table="unpaid"]`);
    const rows = (state.trainings || []).filter((t) => !t.paid.length).sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
    if (!rows.length) { table.innerHTML = `<tr><td class="bl-empty">${state.trainings?.length ? "Every training receipt in this range was followed by a paid sale." : "Nothing pulled yet."}</td></tr>`; return; }
    const value = (t) => t.items.reduce((sum, i) => sum + (Number(i.cents) || 0), 0);
    table.innerHTML = `<thead><tr><th>Date</th><th>Time</th><th>Register · operator</th><th>TR#</th><th>Items on the training receipt</th><th class="bl-num">Value</th><th></th></tr></thead><tbody>` + rows.map((t) => `<tr>
      <td class="bl-mono">${esc(t.date.slice(5).replace("-", "/"))}</td><td class="bl-mono">${esc(t.time)}</td>
      <td><span class="bl-reg">Reg ${t.reg}</span>${typeTag(regTypeOf(t.reg))}<span class="bl-subl">op ${esc(t.op)}</span></td><td class="bl-mono">${esc(t.tr)}</td>
      <td class="bl-items">${t.items.map((i) => `${esc(i.desc)} <span class="bl-mono bl-muted">${esc(i.code)}</span> <span class="bl-mono">${MONEY(i.cents)}</span>`).join("<br>")}</td>
      <td class="bl-money">${MONEY(value(t))}</td><td>${videoBtn(t.date, t.reg, t.tr, t.time)}</td></tr>`).join("") + `</tbody>`;
  }

  function setTab(tab) {
    ui.tab = tab;
    for (const b of container.querySelectorAll(".bl-tab")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
    for (const p of container.querySelectorAll(".bl-panel")) p.hidden = p.dataset.panel !== tab;
  }

  // ── wiring ────────────────────────────────────────────────────
  const unsubs = [];
  unsubs.push(host.messaging.on("progress", (msg) => {
    const p = msg?.payload || msg || {};
    if (p.phase === "pull") els.progress.textContent = `Pulling ${p.date} (${p.i + 1} of ${p.n})…`;
    else if (p.phase === "done") els.progress.textContent = `${p.date}: ${p.records} records, ${p.pairs} pairs (${p.i + 1} of ${p.n})`;
    else if (p.phase === "error") els.progress.textContent = `${p.date}: ${p.error}`;
  }));
  unsubs.push(host.messaging.on("state_changed", () => { if (!busy) refresh(); }));

  els.pull.addEventListener("click", () => pull());
  els.repull.addEventListener("click", () => pull({ force: true }));
  els.store.addEventListener("change", async () => {
    const res = await host.messaging.sendRaw("set_store_override", { storeNbr: els.store.value.trim() });
    if (res?.ok) { state = res; paint(); }
  });
  const onRange = () => refresh({ from: els.from.value, to: els.to.value });
  els.from.addEventListener("change", onRange);
  els.to.addEventListener("change", onRange);

  unsubs.push(host.ui.delegate(container, "click", ".bl-tab", (e, el) => { setTab(el.dataset.tab); savePrefs(); }));
  unsubs.push(host.ui.delegate(container, "click", ".bl-chip", (e, el) => {
    const cat = el.closest("[data-controls]").dataset.controls, s = ui[cat];
    if (el.dataset.type) { s.types.has(el.dataset.type) ? s.types.delete(el.dataset.type) : s.types.add(el.dataset.type); el.setAttribute("aria-pressed", String(s.types.has(el.dataset.type))); }
    else { s[el.dataset.flag] = !s[el.dataset.flag]; el.setAttribute("aria-pressed", String(s[el.dataset.flag])); }
    savePrefs(); paintTable(cat);
  }));
  unsubs.push(host.ui.delegate(container, "change", "[data-sort]", (e, el) => { const cat = el.closest("[data-controls]").dataset.controls; ui[cat].sort = el.value; savePrefs(); paintTable(cat); }));
  unsubs.push(host.ui.delegate(container, "input", "[data-min]", (e, el) => { const cat = el.closest("[data-controls]").dataset.controls; ui[cat].minDollars = Math.max(0, Number(el.value) || 0); savePrefs(); paintTable(cat); }));
  unsubs.push(host.ui.delegate(container, "click", ".bl-row", (e, el) => {
    if (e.target.closest("a, button")) return;
    const cat = el.closest("[data-table]").dataset.table, s = ui[cat], k = el.dataset.key;
    s.open.has(k) ? s.open.delete(k) : s.open.add(k);
    paintTable(cat);
  }));
  unsubs.push(host.ui.delegate(container, "keydown", ".bl-row", (e, el) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.click(); } }));
  // Video links are plain anchors; stop the row from toggling when one is clicked.
  unsubs.push(host.ui.delegate(container, "click", ".bl-video", (e) => { e.stopPropagation(); }));

  // ── documented misses ─────────────────────────────────────────
  unsubs.push(host.ui.delegate(container, "click", ".bl-doc-open", (e, el) => {
    e.stopPropagation();
    const key = el.dataset.key;
    ui.editing.add(key);
    const p = (state?.pairs || []).find((x) => x.key === key);
    if (p) ui[p.category].open.add(key);   // the form lives in the expanded row
    repaintAll();
    container.querySelector(`[data-docform="${CSS.escape(key)}"] textarea`)?.focus();
  }));
  unsubs.push(host.ui.delegate(container, "click", ".bl-doc-cancel", (e, el) => { e.stopPropagation(); ui.editing.delete(el.dataset.key); repaintAll(); }));
  unsubs.push(host.ui.delegate(container, "submit", "[data-docform]", async (e, el) => {
    e.preventDefault(); e.stopPropagation();
    const key = el.dataset.docform;
    const fd = new FormData(el);
    const fields = { cause: fd.get("cause"), outcome: fd.get("outcome"), video: fd.get("video"), cashierName: fd.get("cashierName"), note: fd.get("note") };
    const pair = (state?.pairs || []).find((p) => p.key === key) || null;
    const v = ui.video[key];
    const videoIds = v?.ok && (v.t1 || v.t2) ? { t1: v.t1 || null, t2: v.t2 || null } : undefined;
    const btn = el.querySelector("[type=submit]"); btn.disabled = true;
    const res = await host.messaging.sendRaw("save_miss", { pair, key, fields, videoIds });
    btn.disabled = false;
    if (!res?.ok) { host.ui.toast(res?.error || "Could not save.", { kind: "error" }); return; }
    state.misses = res.misses; ui.editing.delete(key);
    host.ui.toast("Miss documented", { kind: "ok" });
    repaintAll();
  }));
  unsubs.push(host.ui.delegate(container, "click", ".bl-doc-remove", async (e, el) => {
    e.stopPropagation();
    const key = el.dataset.key, rec = recFor(key);
    if (!rec || !window.confirm(`Remove the documented miss for op ${rec.cashier.op} on ${rec.date}?`)) return;
    const res = await host.messaging.sendRaw("delete_miss", { key });
    if (!res?.ok) { host.ui.toast(res?.error || "Could not remove.", { kind: "error" }); return; }
    state.misses = res.misses; ui.editing.delete(key);
    host.ui.toast("Removed", { kind: "ok" });
    repaintAll();
  }));
  unsubs.push(host.ui.delegate(container, "click", ".bl-vid-find", async (e, el) => {
    e.stopPropagation();
    const key = el.dataset.key, p = pairFor(key);
    if (!p) return;
    ui.video[key] = { busy: true }; repaintAll();
    const res = await host.messaging.sendRaw("link_video", { date: p.date, t1: { reg: p.t1.reg, tr: p.t1.tr, time: p.t1.time }, t2: { reg: p.t2.reg, tr: p.t2.tr, time: p.t2.time } }, { timeoutMs: 90_000 }).catch((err) => ({ ok: false, error: String(err?.message || err) }));
    ui.video[key] = res || { ok: false, error: "No response from the service worker." };
    repaintAll();
  }));
  $("#boblisa-doc-export").addEventListener("click", async () => {
    const res = await host.messaging.sendRaw("export_misses", {});
    host.ui.toast(res?.ok ? `${res.rows} row${res.rows === 1 ? "" : "s"} saved to Downloads\\${String(res.filename).replace(/\//g, "\\")}` : (res?.error || "Export failed."), { kind: res?.ok ? "ok" : "error", durationMs: 6000 });
  });

  // ── boot ──────────────────────────────────────────────────────
  await loadPrefs();
  await refresh();
  if (state?.store && state.missing?.length) pull();

  return () => {
    for (const u of unsubs) { try { u(); } catch {} }
    link.remove();
  };
}
