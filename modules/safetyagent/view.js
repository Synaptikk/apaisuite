// modules/safetyagent/view.js
//
// Safety Agent Dashboard — shell page. Reads the cached pull from
// service.js::get_state, filters by date client-side, and renders tiles,
// the disposition families, a sortable camera pivot, an associate table and
// an hour-of-day chart. Every roll-up lives in lib/aggregate.js.

import { COL, TAGS, FAMILY_ORDER, FAMILY_NAME, ACTION_ORDER, ACTION_NAME, HOLD_LONG_MIN, HOLD_GRACE_MIN, HOLD_NOISE_PER_ALERT_MIN,
         familyOf, actionKey, cameraNhfRate, groupBy, summarize, byHour } from "./lib/aggregate.js";
import { hazardImageUrl } from "./lib/sql.js";
import { analyzeOncall, WAVE1_MIN, LEAD_SIT_MIN } from "./lib/oncall.js";
import { withWeekday, weekdayOf } from "../../shared/dates.js";

const PREFS_KEY = "prefs.v1";

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

  const root = container.querySelector(".sa");
  const $ = (sel) => root.querySelector(sel);
  const els = {
    store: $("#sa-store"), storeSrc: $("#sa-store-src"), from: $("#sa-from"), to: $("#sa-to"),
    pull: $("#sa-pull"), open: $("#sa-open"), progress: $("#sa-progress"), status: $("#sa-status"),
    empty: $("#sa-empty"), body: $("#sa-body"), meta: $("#sa-meta"), tiles: $("#sa-tiles"),
    fam: $("#sa-fam"), reasons: $("#sa-reasons"), actions: $("#sa-actions"),
    q: $("#sa-q"), dept: $("#sa-dept"), min: $("#sa-min"), colFam: $("#sa-col-fam"), colAll: $("#sa-col-all"),
    camCount: $("#sa-cam-count"), cams: $("#sa-cams"), amin: $("#sa-amin"), assCount: $("#sa-ass-count"), ass: $("#sa-ass"),
    assFam: $("#sa-ass-fam"), assAll: $("#sa-ass-all"), shareHolds: $("#sa-share-holds"),
    hours: $("#sa-hours"), foot: $("#sa-foot"), tip: $("#sa-tip"),
    ocPull: $("#sa-oc-pull"), ocProgress: $("#sa-oc-progress"), ocW1: $("#sa-oc-w1"), ocW2: $("#sa-oc-w2"),
    ocTeam: $("#sa-oc-team"), ocMin: $("#sa-oc-min"), ocCopy: $("#sa-oc-copy"), ocCount: $("#sa-oc-count"),
    ocNote: $("#sa-oc-note"), ocTiles: $("#sa-oc-tiles"), oc: $("#sa-oc"),
  };

  const f1  = (x) => (x == null ? "–" : (Math.round(x * 10) / 10).toFixed(1));
  const pct = (a, b) => (b ? Math.round((100 * a) / b) + "%" : "–");
  const fmtDate = (ms) => new Date(ms).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  let state = null;         // { store, storeSource, hasToken, data }
  let rows = [];            // rows after the date filter
  let busy = false;
  const ui = { camMode: "fam", assMode: "fam", cam: { sort: "nhf", dir: "desc" }, ass: { sort: "nhf", dir: "desc" },
               ocWave: 1, oc1: { sort: "passed", dir: "desc" }, oc2: { sort: "escPassed", dir: "desc" } };
  let oncall = null;        // service cache: { camTeam, days } — see service.js::pullOncall
  let ocBusy = false;

  // ── prefs ─────────────────────────────────────────────────────
  async function loadPrefs() {
    const p = await host.storage.local.get(PREFS_KEY).catch(() => null);
    if (!p) return;
    if (p.camMode === "all") ui.camMode = "all";
    if (p.assMode === "all") ui.assMode = "all";
    if (typeof p.min === "number") els.min.value = p.min;
    if (typeof p.amin === "number") els.amin.value = p.amin;
    if (typeof p.ocMin === "number") els.ocMin.value = p.ocMin;
    if (p.ocWave === 2) ui.ocWave = 2;
  }
  const savePrefs = () => host.storage.local.set(PREFS_KEY, {
    camMode: ui.camMode, assMode: ui.assMode, min: Number(els.min.value) || 1,
    amin: Number(els.amin.value) || 1, ocMin: Number(els.ocMin.value) || 1, ocWave: ui.ocWave,
  }).catch(() => {});

  // ── status ────────────────────────────────────────────────────
  function setStatus(text, kind = "info") {
    if (!text) { els.status.hidden = true; return; }
    els.status.className = `status-strip status-strip-${kind}`;
    els.status.textContent = text;
    els.status.hidden = false;
  }

  // ── data plumbing ─────────────────────────────────────────────
  function applyFilter() {
    const all = state?.data?.rows || [];
    const from = els.from.value, to = els.to.value;
    rows = all.filter((r) => (!from || r[COL.date] >= from) && (!to || r[COL.date] <= to));
  }

  function showState() {
    els.store.value = state?.store || "";
    els.storeSrc.textContent = state?.store
      ? (state.storeSource === "manual" ? "" : state.storeSource === "last" ? "last pulled" : "your store")
      : "no store set";
    if (!state?.data) {
      els.body.hidden = true; els.empty.hidden = false;
      return;
    }
    els.empty.hidden = true; els.body.hidden = false;
    applyFilter();
    renderAll();
  }

  async function refresh(store) {
    const res = await host.messaging.send("get_state", { store });
    if (!res.ok) { setStatus(res.error, "error"); return; }
    state = res.data;
    await loadOncall();
    showState();
    if (state.imageRefreshError) setStatus(state.imageRefreshError, "warn");
  }

  async function pull() {
    if (busy) return;
    const store = els.store.value.trim();
    if (!/^\d{1,5}$/.test(store)) { setStatus("Enter a store number first.", "warn"); return; }
    busy = true; els.pull.disabled = true; setStatus("");
    els.progress.textContent = "Starting…";
    try {
      const res = await host.messaging.send("pull", { store, from: els.from.value || null, to: els.to.value || null });
      if (!res.ok) { setStatus(res.error, "error"); return; }
      state = res.data;
      await loadOncall();
      showState();
      host.ui.toast(`Pulled ${state.data.rows.length} alerts for store ${store}`);
    } catch (e) {
      setStatus(e?.message || String(e), "error");
    } finally {
      busy = false; els.pull.disabled = false; els.progress.textContent = "";
    }
  }

  // ── renderers ─────────────────────────────────────────────────
  function renderAll() {
    const s = summarize(rows);
    const d = state.data;
    els.meta.innerHTML =
      `<span>Window <b>${esc(s.minDate ? withWeekday(s.minDate) : "–")} → ${esc(s.maxDate ? withWeekday(s.maxDate) : "–")}</b> (${s.days} days${d.from || d.to ? "" : ", all dates available"})</span>` +
      `<span>Latest detection <b class="sa-mono">${esc(s.last ? withWeekday(s.last) : "–")}</b> local</span>` +
      `<span>Pulled <b>${esc(fmtDate(d.pulledAt))}</b></span>`;

    els.tiles.innerHTML = [
      [String(s.total), "Alerts", `during operating hours, ${s.days} days`, ""],
      [pct(s.nhf, s.total), "Closed as a non-issue", `${s.nhf} alerts: ${s.byTag.no_hazard_found || 0} no hazard, ${s.byTag.no_spill || 0} no spill, ${s.byTag.no_object || 0} no object`, "sa-tile-hi"],
      [`${f1(s.medAck)} min`, "Median time to acknowledge", `${s.gt10} alerts took over 10 min`, ""],
      [`${f1(s.medHold)} min`, "Median accept → complete", `${s.holdLong} held over ${HOLD_LONG_MIN} min · ${f1(s.excessHold)} min held beyond the ${HOLD_GRACE_MIN}-min allowance`, s.holdLong ? "sa-tile-hi" : ""],
      [String(s.cameras), "Cameras that alerted", `${s.associates} associates responded`, ""],
    ].map(([v, l, sub, c]) => `<div class="sa-tile ${c}"><div class="sa-eyebrow">${esc(l)}</div><div class="sa-tile-v">${esc(v)}</div><div class="sa-tile-s">${esc(sub)}</div></div>`).join("");

    els.fam.innerHTML =
      `<div class="sa-bar">${FAMILY_ORDER.map((k) => `<span class="sa-fam-${k}" style="width:${s.total ? (100 * s.byFam[k]) / s.total : 0}%" data-tip="${esc(FAMILY_NAME[k])}: ${s.byFam[k]} (${pct(s.byFam[k], s.total)})"></span>`).join("")}</div>` +
      `<div class="sa-legend">${FAMILY_ORDER.map((k) => `<span><i class="sa-fam-${k}"></i>${esc(FAMILY_NAME[k])}<span class="sa-num sa-muted">${s.byFam[k]} · ${pct(s.byFam[k], s.total)}</span></span>`).join("")}</div>`;
    els.reasons.innerHTML = [...TAGS, "(none)"].map((t) =>
      `<div><span><i class="sa-fam-${familyOf(t)}"></i>${esc(t)}</span><span class="sa-num sa-muted">${s.byTag[t] || 0}</span></div>`).join("");

    // How the alert was answered at the device. Only ACCEPTED carries an
    // associate name, so the other two can never appear in the table below.
    const unattributed = s.byAction.na + s.byAction.noact + s.byAction.other;
    els.actions.innerHTML = ACTION_ORDER.map((k) =>
      `<div><span>${esc(ACTION_NAME[k])}</span><span class="sa-num sa-muted">${s.byAction[k]} · ${pct(s.byAction[k], s.total)}</span></div>`).join("") +
      `<p class="sa-sub">SafeIQ records a name only when the alert was accepted. The ${unattributed} alert${unattributed === 1 ? "" : "s"} nobody accepted ` +
      `(not available / no action) cannot be traced to a person and are grouped as <b>Unattributed</b> in the associate table. ` +
      `The refusal that <em>is</em> attributable is accepting an alert and closing it as nothing there — the Non-issue columns below.</p>` +
      (unattributed ? `<button id="sa-share-unatt" class="btn btn-sm btn-secondary" title="Copy the unattributed alerts as a plain-text list (day, date, time, camera, department, aisle)">Copy the ${unattributed} unaccepted alert${unattributed === 1 ? "" : "s"} as a list</button>` : "");

    renderCams();
    renderAss();
    renderOncall();
    renderHours();
    els.foot.textContent = `Times are store-local. "Ack" is minutes from detection to the associate accepting the alert; "done" is minutes from detection to task complete; "hold" is minutes from accepting to task complete — the window in which the alert is locked to the accepter. ${s.byFam.none} alerts have no tag (Not Available or No Action). Families are a reviewer grouping of the 12 system tags, not a SafeIQ field. ` +
      `Read the times as workload, not as proof: a quick close is the house norm on every disposition — confirmed hazards close about as fast as non-issues, because associates accept on the handheld once they are already at the spot. "vs expected" is the column that carries a refusal signal.`;
  }

  // Column definitions ----------------------------------------------------
  const baseCols = (label) => [
    { k: "key", h: label, v: (r) => r.label || r.key, cell: (r) => `<td class="${label === "Camera" ? "sa-cam" : ""}">${esc(r.label || r.key)}</td>` },
    ...(label === "Camera" ? [{ k: "dept", h: "Department", v: (r) => r.dept || "", cell: (r) => `<td class="sa-dept">${esc(r.dept || "")}</td>` }] : []),
    { k: "total", h: "Alerts", r: 1, v: (r) => r.total, cell: (r) => `<td class="r sa-num">${r.total}</td>` },
    { k: "nhf", h: "Non-issue", title: "Closed as no_hazard_found, no_spill or no_object", r: 1, dot: "nhf", v: (r) => r.nhf, cell: (r, ctx) => `<td class="r sa-num sa-heat" style="--h:${(r.nhf / ctx.maxNhf).toFixed(2)}">${r.nhf}</td>` },
    { k: "nhfPct", h: "Non-issue %", title: "Share of alerts closed as no_hazard_found, no_spill or no_object", r: 1, v: (r) => r.nhfPct, cell: (r) => `<td class="r sa-num sa-pct" style="--p:${r.nhfPct.toFixed(2)}">${pct(r.nhf, r.total)}</td>` },
  ];
  const famCols = [
    { k: "f_clr", h: "Cleared", title: "cleaned_object + cleaned_spill (gone before arrival)", r: 1, dot: "clr", v: (r) => r.fam.clr, cell: (r) => `<td class="r sa-num">${r.fam.clr}</td>` },
    { k: "f_haz", h: "Confirmed", r: 1, dot: "haz", v: (r) => r.fam.haz, cell: (r) => `<td class="r sa-num">${r.fam.haz}</td>` },
    { k: "f_none", h: "No tag", r: 1, dot: "none", v: (r) => r.fam.none, cell: (r) => `<td class="r sa-num">${r.fam.none || ""}</td>` },
  ];
  const tagCols = TAGS.map((t) => ({ k: "t_" + t, h: t.replace(/_/g, " "), r: 1, dot: familyOf(t), v: (r) => r.tag[t] || 0, cell: (r) => `<td class="r sa-num">${r.tag[t] || ""}</td>` }));
  const timeCols = [
    { k: "medAck", h: "Ack min", title: "Median minutes from detection to acknowledgement", r: 1, v: (r) => r.medAck, cell: (r) => `<td class="r sa-num">${f1(r.medAck)}</td>` },
    { k: "medTtc", h: "Done min", title: "Median minutes from detection to task complete", r: 1, v: (r) => r.medTtc, cell: (r) => `<td class="r sa-num">${f1(r.medTtc)}</td>` },
    { k: "medHold", h: "Hold min", title: "Median minutes from accepting the alert to task complete. While it sits accepted, nobody else can complete it.", r: 1, v: (r) => r.medHold, cell: (r) => `<td class="r sa-num">${f1(r.medHold)}</td>` },
    { k: "excessHold", h: "Hold excess", title: `Minutes accepted alerts sat open BEYOND a ${HOLD_GRACE_MIN}-minute working allowance per alert, summed. A raw total rewards volume — 47 quick closes outrank one parked alert — so only time past the allowance counts.`, r: 1,
      v: (r) => r.excessHold, cell: (r) => `<td class="r sa-num${r.excessHold > HOLD_LONG_MIN ? " sa-hold" : ""}"${r.maxHold != null ? ` data-tip="${f1(r.totHold)} min held in total, longest single hold ${f1(r.maxHold)} min"` : ""}>${r.excessHold ? f1(r.excessHold) : ""}</td>` },
    { k: "holdLong", h: `Held >${HOLD_LONG_MIN}m`, title: `Accepted alerts that stayed open more than ${HOLD_LONG_MIN} minutes before task complete`, r: 1,
      v: (r) => r.holdLong, cell: (r) => r.holdLong ? `<td class="r sa-num sa-hold" data-tip="longest ${f1(r.maxHold)} min">${r.holdLong}</td>` : `<td class="r sa-num"></td>` },
  ];
  // The column that separates "waves alerts away" from "works an area whose
  // camera really does over-fire". Only meaningful per associate.
  const baselineCol = [
    { k: "idx", h: "vs expected", r: 1,
      title: "This associate's non-issue count divided by what the store's own rate on the same cameras predicts. 1.0 = exactly the house rate; 2.0 = twice as many non-issue closes as those cameras produce for everyone else.",
      v: (r) => r.idx,
      cell: (r) => r.idx == null ? `<td class="r sa-num">–</td>`
        : `<td class="r sa-num sa-idx" style="--i:${Math.min(2, r.idx).toFixed(2)}" data-tip="${r.nhf} non-issue vs ${f1(r.exp)} expected from these ${new Set(r.rows.map((x) => x[COL.camera])).size} cameras">${(Math.round(r.idx * 100) / 100).toFixed(2)}×</td>` },
  ];

  // Generic sortable table with a click-to-expand event list ---------------
  const tables = {};   // id → { groups, cols, sortState, detailLabel }
  function renderTable(table, groups, cols, sortState, filterFn, countEl, detailLabel, emptyText, extraCtx = {}) {
    const list = groups.filter(filterFn);
    const c = cols.find((x) => x.k === sortState.sort) || cols[0];
    list.sort((a, b) => {
      const x = c.v(a), y = c.v(b);
      const numeric = (typeof x === "number" || x == null) && (typeof y === "number" || y == null);
      const r = numeric ? (x ?? -1) - (y ?? -1) : String(x).localeCompare(String(y));
      return sortState.dir === "desc" ? -r : r;
    });
    const ctx = { maxNhf: Math.max(1, ...groups.map((g) => g.nhf || 0)), ...extraCtx };
    table.querySelector("thead").innerHTML = `<tr>${cols.map((col) =>
      `<th class="${col.r ? "r" : ""}" data-k="${col.k}"${col.title ? ` title="${esc(col.title)}"` : ""}${sortState.sort === col.k ? ` aria-sort="${sortState.dir}ending"` : ""}>${col.dot ? `<span class="sa-dot sa-fam-${col.dot}"></span>` : ""}${esc(col.h)}</th>`).join("")}</tr>`;
    table.querySelector("tbody").innerHTML = list.length ? list.map((g, i) =>
      `<tr class="sa-row" tabindex="0" data-i="${i}" aria-expanded="false">${cols.map((col) => col.cell(g, ctx)).join("")}</tr>`).join("")
      : `<tr class="sa-empty"><td colspan="${cols.length}">${esc(emptyText || "No alerts in this window.")}</td></tr>`;
    countEl.textContent = `${list.length} of ${groups.length}`;
    tables[table.id] = { list, cols, sortState, detailLabel };
  }

  // Expanded row: every alert this camera/associate had in the window, as a
  // gallery of detection frames so a disposition can be eyeballed against
  // what the camera actually saw. All / Non-issue toggle per panel.
  let detSeq = 0;
  const details = new Map();   // detId → { rows, mode, other }
  function toggleDetail(table, tr) {
    const t = tables[table.id]; if (!t) return;
    const g = t.list[Number(tr.dataset.i)]; if (!g) return;
    const next = tr.nextElementSibling;
    if (next && next.classList.contains("sa-det")) { details.delete(next.dataset.det); next.remove(); tr.setAttribute("aria-expanded", "false"); return; }
    const all = [...g.rows].sort((a, b) => (b[COL.ts] < a[COL.ts] ? -1 : 1));
    const id = String(++detSeq);
    details.set(id, { rows: all, mode: "all", other: t.detailLabel === "Associate" ? COL.assoc : COL.camera, key: g.key, label: g.label });
    const det = document.createElement("tr");
    det.className = "sa-det"; det.dataset.det = id;
    det.innerHTML = `<td colspan="${t.cols.length}"><div class="sa-det-in"></div></td>`;
    tr.after(det);
    tr.setAttribute("aria-expanded", "true");
    renderDetail(det);
  }
  const detailFilter = (mode) => mode === "nhf" ? (r) => familyOf(r[COL.reason]) === "nhf" : () => true;
  function renderDetail(det) {
    const d = details.get(det.dataset.det); if (!d) return;
    const list = d.rows.filter(detailFilter(d.mode));
    const nhfCount = d.rows.filter((r) => familyOf(r[COL.reason]) === "nhf").length;
    const noIds = d.rows.length && !d.rows.some((r) => r[COL.id]);
    det.querySelector(".sa-det-in").innerHTML =
      `<div class="sa-det-head"><b>${esc(d.label || d.key)}</b><span class="sa-muted">${d.rows.length} alert${d.rows.length === 1 ? "" : "s"} in window · ${nhfCount} non-issue</span>` +
      `<span class="btn-group" role="group" aria-label="Show"><button class="btn btn-sm btn-group-item" data-mode="all" aria-pressed="${d.mode === "all"}">All</button>` +
      `<button class="btn btn-sm btn-group-item" data-mode="nhf" aria-pressed="${d.mode === "nhf"}">Non-issue only</button></span>` +
      (noIds ? `<span class="sa-muted">Image IDs unavailable for these alerts. Use Pull alerts to retry.</span>` : `<span class="sa-muted">Click a frame to enlarge.</span>`) + `</div>` +
      `<div class="sa-gallery">` + list.map((r, i) => {
        const url = hazardImageUrl(r[COL.id]);
        const tag = r[COL.reason] || "(no tag)";
        return `<figure class="sa-shot" data-i="${i}" tabindex="0" role="button" aria-label="Open alert image">` +
          (url ? `<img loading="lazy" decoding="async" src="${url}" alt="${esc(tag)} at ${esc(r[COL.ts])}">` : `<div class="sa-shot-none">No image</div>`) +
          `<figcaption><span class="sa-tag sa-fam-${familyOf(r[COL.reason])}">${esc(tag)}</span> <span class="sa-mono">${esc(withWeekday(r[COL.ts].slice(5), r[COL.ts]))}</span><br>${esc(r[d.other] || "—")}${r[COL.ack] != null ? ` · ack ${f1(r[COL.ack])} min` : ""}${r[COL.aisle] ? ` · ${esc(r[COL.aisle])}` : ""}</figcaption></figure>`;
      }).join("") + `</div>`;
  }

  // ── lightbox ──────────────────────────────────────────────────────
  const lb = { rows: [], i: 0, view: "alert", other: COL.assoc };
  const lbEls = { root: $("#sa-lb"), meta: $("#sa-lb-meta"), stage: $("#sa-lb-stage"), alert: $("#sa-lb-alert"), assoc: $("#sa-lb-assoc"), prev: $("#sa-lb-prev"), next: $("#sa-lb-next"), close: $("#sa-lb-close") };
  function openLightbox(rows, i, other) { lb.rows = rows; lb.i = i; lb.view = "alert"; lb.other = other; lbEls.root.hidden = false; renderLightbox(); lbEls.close.focus(); }
  function closeLightbox() { lbEls.root.hidden = true; lbEls.stage.innerHTML = ""; }
  function renderLightbox() {
    const r = lb.rows[lb.i]; if (!r) return closeLightbox();
    const accepted = r[COL.action] === "ACCEPTED";
    if (!accepted) lb.view = "alert";
    lbEls.assoc.disabled = !accepted;
    lbEls.alert.setAttribute("aria-pressed", String(lb.view === "alert"));
    lbEls.assoc.setAttribute("aria-pressed", String(lb.view === "assoc"));
    lbEls.prev.disabled = lb.i <= 0; lbEls.next.disabled = lb.i >= lb.rows.length - 1;
    const tag = r[COL.reason] || "(no tag)";
    lbEls.meta.innerHTML = `<span class="sa-tag sa-fam-${familyOf(r[COL.reason])}">${esc(tag)}</span> <b>${esc(r[COL.camera])}</b> <span class="sa-mono">${esc(withWeekday(r[COL.ts]))}</span> · ${esc(r[COL.assoc] || r[COL.action] || "")}${r[COL.ack] != null ? ` · ack ${f1(r[COL.ack])} min` : ""}${r[COL.ttc] != null ? ` · done ${f1(r[COL.ttc])} min` : ""}${r[COL.hold] != null ? ` · held ${f1(r[COL.hold])} min` : ""} <span class="sa-muted">${lb.i + 1} / ${lb.rows.length}</span>`;
    const url = hazardImageUrl(r[COL.id], lb.view === "assoc" ? "pre_verify" : "bbox_overlay");
    lbEls.stage.innerHTML = url ? `<img src="${url}" alt="${esc(tag)}">` : `<div class="sa-shot-none">No image</div>`;
    // Warm the neighbours so ← → feel instant.
    for (const n of [lb.i - 1, lb.i + 1]) { const nr = lb.rows[n]; if (nr && nr[COL.id]) { const im = new Image(); im.src = hazardImageUrl(nr[COL.id]); } }
  }
  const onLbKey = (e) => {
    if (lbEls.root.hidden) return;
    if (e.key === "Escape") closeLightbox();
    else if (e.key === "ArrowLeft" && lb.i > 0) { lb.i--; renderLightbox(); }
    else if (e.key === "ArrowRight" && lb.i < lb.rows.length - 1) { lb.i++; renderLightbox(); }
    else return;
    e.preventDefault();
  };
  document.addEventListener("keydown", onLbKey);
  lbEls.close.addEventListener("click", closeLightbox);
  lbEls.root.addEventListener("click", (e) => { if (e.target === lbEls.root) closeLightbox(); });
  lbEls.prev.addEventListener("click", () => { if (lb.i > 0) { lb.i--; renderLightbox(); } });
  lbEls.next.addEventListener("click", () => { if (lb.i < lb.rows.length - 1) { lb.i++; renderLightbox(); } });
  lbEls.alert.addEventListener("click", () => { lb.view = "alert"; renderLightbox(); });
  lbEls.assoc.addEventListener("click", () => { lb.view = "assoc"; renderLightbox(); });

  function renderCams() {
    const groups = groupBy(rows, COL.camera);
    const depts = [...new Set(groups.map((g) => g.dept).filter(Boolean))].sort();
    const cur = els.dept.value;
    els.dept.innerHTML = `<option value="">All</option>` + depts.map((d) => `<option${d === cur ? " selected" : ""}>${esc(d)}</option>`).join("");
    const q = els.q.value.trim().toLowerCase(), dept = els.dept.value, min = Number(els.min.value) || 1;
    const cols = [...baseCols("Camera"), ...(ui.camMode === "fam" ? famCols : tagCols), ...timeCols];
    renderTable(els.cams, groups, cols, ui.cam,
      (g) => g.total >= min && (!dept || g.dept === dept) && (!q || g.key.toLowerCase().includes(q) || (g.dept || "").toLowerCase().includes(q)),
      els.camCount, "Associate",
      groups.length ? `None of the ${groups.length} cameras that alerted in this window have ${min} or more alerts${q || dept ? " and match the search / department filter" : ""}. Lower "Min alerts" to see them.` : "");
    els.colFam.setAttribute("aria-pressed", String(ui.camMode === "fam"));
    els.colAll.setAttribute("aria-pressed", String(ui.camMode === "all"));
  }

  function renderAss() {
    const groups = groupBy(rows, COL.assoc, { camRate: cameraNhfRate(rows) });
    for (const g of groups) if (g.key === "(none)") g.label = "Unattributed (nobody accepted)";
    const min = Number(els.amin.value) || 1;
    const cols = [...baseCols("Associate"), ...baselineCol, ...(ui.assMode === "fam" ? famCols : tagCols), ...timeCols];
    renderTable(els.ass, groups, cols, ui.ass, (g) => g.total >= min, els.assCount, "Camera",
      groups.length ? `None of the ${groups.length} associates who responded in this window have ${min} or more alerts. Lower "Min alerts" to see them.` : "");
    els.assFam.setAttribute("aria-pressed", String(ui.assMode === "fam"));
    els.assAll.setAttribute("aria-pressed", String(ui.assMode === "all"));
  }

  // ── who was on the clock ──────────────────────────────────────
  // The roll-up is lib/oncall.js::analyzeOncall over the date-filtered rows
  // and the service's punch/schedule cache; nothing is stored per alert.
  const todayNow = () => {
    const d = new Date();
    return { iso: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`, min: d.getHours() * 60 + d.getMinutes() };
  };
  let ocLast = null;   // last analysis, for Copy list
  function renderOncall() {
    const days = Object.keys(oncall?.days || {});
    if (!oncall?.camTeam || !days.length) {
      els.ocNote.innerHTML = `<span>No clock-ins pulled for store ${esc(state?.store || "")} yet. <b>Pull clock-ins</b> reads the Store Systems camera list and each day's GTA punches (about 20 s a day the first time).</span>`;
      els.ocTiles.innerHTML = ""; els.oc.querySelector("thead").innerHTML = ""; els.oc.querySelector("tbody").innerHTML = ""; els.ocCount.textContent = "";
      ocLast = null; return;
    }
    const a = analyzeOncall(rows, oncall, COL, todayNow());
    ocLast = a;
    const s = a.summary, tb = a.takenBy, acc = tb.team + tb.leader + tb.other + tb.unknown;
    const notes = [];
    if (a.missingDays.length) notes.push(`<span><b>${a.missingDays.length}</b> day${a.missingDays.length === 1 ? "" : "s"} in the window have no punches yet (${esc(a.missingDays.slice(0, 4).map((d) => withWeekday(d)).join(", "))}${a.missingDays.length > 4 ? "…" : ""}) — Pull clock-ins</span>`);
    if (a.schedFallbackDays.length) notes.push(`<span>${a.schedFallbackDays.length} day${a.schedFallbackDays.length === 1 ? "" : "s"} (${esc(withWeekday(a.schedFallbackDays[0]))}${a.schedFallbackDays.length > 1 ? ` → ${esc(withWeekday(a.schedFallbackDays.at(-1)))}` : ""}) have a saved schedule that belongs to another store; job titles there come from each associate's other days</span>`);
    const offList = a.unknownCams.filter((c) => c !== "(no camera)");
    if (offList.length) notes.push(`<span>Not on the camera list (skipped): ${esc(offList.join(", "))}</span>`);
    els.ocNote.innerHTML = notes.join("");
    els.ocTiles.innerHTML = [
      [String(s.escalated + s.unanswered), `Went past ${WAVE1_MIN} min`, `${pct(s.escalated + s.unanswered, s.analysed)} of ${s.analysed} alerts · ${s.unanswered} never accepted`, "sa-tile-hi"],
      [String(s.passedWithTeamOnClock), "…with the team on the clock", `${s.noTeamOnClock} alerts had nobody from the camera's team clocked in`, ""],
      [pct(tb.team, acc), "Accepted by the camera's team", `${tb.team} of ${acc} accepted alerts`, ""],
      [pct(tb.leader, acc), "Accepted by a lead or coach", `${tb.leaderEarly} of them inside ${WAVE1_MIN} min — before the escalation`, tb.leaderEarly > tb.team ? "sa-tile-hi" : ""],
    ].map(([v, l, sub, c]) => `<div class="sa-tile ${c}"><div class="sa-eyebrow">${esc(l)}</div><div class="sa-tile-v">${esc(v)}</div><div class="sa-tile-s">${esc(sub)}</div></div>`).join("");

    const teams = [...new Set(a.people.map((p) => p.team).filter(Boolean))].sort();
    const cur = els.ocTeam.value;
    els.ocTeam.innerHTML = `<option value="">All</option>` + teams.map((t) => `<option${t === cur ? " selected" : ""}>${esc(t)}</option>`).join("");
    els.ocTeam.disabled = ui.ocWave === 2;
    const team = els.ocTeam.value, min = Number(els.ocMin.value) || 1;
    const nameCol = { k: "key", h: ui.ocWave === 1 ? "Associate" : "Lead / coach", v: (r) => r.name, cell: (r) => `<td>${esc(r.name)}</td>` };
    if (ui.ocWave === 1) {
      const cols = [nameCol,
        { k: "team", h: "Team", v: (r) => r.team || "", cell: (r) => `<td class="sa-dept">${esc(r.team || "")}</td>` },
        { k: "offered", h: "On the clock for", title: "Alerts on this associate's team's cameras that fired while they were clocked in (not on meal)", r: 1, v: (r) => r.offered, cell: (r) => `<td class="r sa-num">${r.offered}</td>` },
        { k: "took", h: "Accepted", r: 1, v: (r) => r.took, cell: (r) => `<td class="r sa-num">${r.took || ""}</td>` },
        { k: "others", h: "Taken by others", title: `Someone else (a coworker or a lead) accepted inside ${WAVE1_MIN} minutes, so the alert never escalated. Not counted as a pass. On the clock for = Accepted + Taken by others + Let pass.`, r: 1, v: (r) => r.others, cell: (r) => `<td class="r sa-num">${r.others || ""}</td>` },
        { k: "passed", h: "Let pass", title: `Alerts that went past ${WAVE1_MIN} minutes (escalated to leads and coaches) or were never accepted while this associate was on the clock`, r: 1,
          v: (r) => r.passed, cell: (r, ctx) => `<td class="r sa-num sa-heat" style="--h:${(r.passed / ctx.maxPassed).toFixed(2)}">${r.passed}</td>` },
        { k: "passPct", h: "Let pass %", r: 1, v: (r) => (r.offered ? r.passed / r.offered : 0), cell: (r) => `<td class="r sa-num sa-pct" style="--p:${(r.offered ? r.passed / r.offered : 0).toFixed(2)}">${pct(r.passed, r.offered)}</td>` },
      ];
      const list = a.people.filter((p) => p.offered);
      renderTable(els.oc, list, cols, ui.oc1, (g) => g.offered >= min && (!team || g.team === team), els.ocCount, "Associate",
        list.length ? `Nobody here has ${min} or more alerts${team ? " on this team" : ""}. Lower "Min alerts".` : "No team associate was on the clock for an alert in this window.",
        { maxPassed: Math.max(1, ...list.map((p) => p.passed)) });
    } else {
      const cols = [nameCol,
        { k: "job", h: "Job", v: (r) => r.job || "", cell: (r) => `<td class="sa-dept">${esc(r.job || "")}</td>` },
        { k: "esc", h: "Escalations reached", title: `Alerts still open at ${WAVE1_MIN} minutes while this lead or coach was on shift (clocked in, or scheduled when they never punch)`, r: 1, v: (r) => r.esc, cell: (r) => `<td class="r sa-num">${r.esc}</td>` },
        { k: "escTook", h: "Accepted", r: 1, v: (r) => r.escTook, cell: (r) => `<td class="r sa-num">${r.escTook || ""}</td>` },
        { k: "escPassed", h: `Left ${LEAD_SIT_MIN}+ min`, title: `Escalations still unaccepted ${LEAD_SIT_MIN} or more minutes after reaching the leads, or never accepted`, r: 1,
          v: (r) => r.escPassed, cell: (r, ctx) => `<td class="r sa-num sa-heat" style="--h:${(r.escPassed / ctx.maxPassed).toFixed(2)}">${r.escPassed}</td>` },
        { k: "escPct", h: "Left %", r: 1, v: (r) => (r.esc ? r.escPassed / r.esc : 0), cell: (r) => `<td class="r sa-num sa-pct" style="--p:${(r.esc ? r.escPassed / r.esc : 0).toFixed(2)}">${pct(r.escPassed, r.esc)}</td>` },
      ];
      const list = a.people.filter((p) => p.esc);
      renderTable(els.oc, list, cols, ui.oc2, (g) => g.esc >= min, els.ocCount, "Associate",
        list.length ? `Nobody here has ${min} or more escalations. Lower "Min alerts".` : "No escalated alert in this window.",
        { maxPassed: Math.max(1, ...list.map((p) => p.escPassed)) });
    }
    els.ocW1.setAttribute("aria-pressed", String(ui.ocWave === 1));
    els.ocW2.setAttribute("aria-pressed", String(ui.ocWave === 2));
  }

  async function pullOncall() {
    if (ocBusy || !state?.data) return;
    const dates = [...new Set(rows.map((r) => r[COL.date]))].sort();
    if (!dates.length) { setStatus("No alerts in this window to match punches against.", "warn"); return; }
    ocBusy = true; els.ocPull.disabled = true; els.ocProgress.textContent = "Starting…"; setStatus("");
    try {
      const res = await host.messaging.send("pull_oncall", { store: state.store, dates });
      if (!res.ok) { setStatus(res.error, "error"); return; }
      oncall = res.data.oncall;
      renderOncall();
      if (res.data.warnings?.length) setStatus(res.data.warnings.join(" · "), "warn");
      else host.ui.toast(res.data.pulled ? `Pulled clock-ins for ${res.data.pulled} day${res.data.pulled === 1 ? "" : "s"}` : "Clock-ins already up to date");
    } catch (e) {
      setStatus(e?.message || String(e), "error");
    } finally {
      ocBusy = false; els.ocPull.disabled = false; els.ocProgress.textContent = "";
    }
  }

  async function loadOncall() {
    const res = await host.messaging.send("get_oncall", { store: state?.store }).catch(() => null);
    oncall = res?.ok ? res.data.oncall : null;
  }

  // Email-ready copy of the on-the-clock table: a short summary in plain
  // words, one line on how to read the numbers, then the table. Copied as
  // HTML (pastes as a formatted table in Outlook) with a plain-text twin.
  function oncallText() {
    const t = tables[els.oc.id]; if (!t || !ocLast) return null;
    const s = summarize(rows);
    const sm = ocLast.summary, tb = ocLast.takenBy, acc = tb.team + tb.leader + tb.other + tb.unknown;
    const nice = (iso) => iso ? new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "–";
    const range = `${nice(s.minDate)} – ${nice(s.maxDate)}`;
    const w1 = ui.ocWave === 1, team = els.ocTeam.value;
    const title = w1
      ? `Safety Agent alerts: who let alerts pass, store ${state.data.store}${team ? ` (${team})` : ""}`
      : `Safety Agent alerts: leads & coaches on escalated alerts, store ${state.data.store}`;
    const passed = sm.escalated + sm.unanswered;
    const summary = [
      `${passed} of ${sm.analysed} alerts (${pct(passed, sm.analysed)}) went past ${WAVE1_MIN} minutes without being accepted; ${sm.unanswered} were never accepted at all.`,
      `${sm.passedWithTeamOnClock} of those had someone from the camera's team clocked in. ${sm.noTeamOnClock} alerts had nobody from the team on the clock.`,
      `The camera's own team accepted ${pct(tb.team, acc)} of accepted alerts (${tb.team} of ${acc}).`,
      `Leads and coaches accepted ${pct(tb.leader, acc)} (${tb.leader}), ${tb.leaderEarly} of them within ${WAVE1_MIN} minutes, before the alert escalated to them.`,
    ];
    const howTo = w1
      ? `How to read this: "On the clock" counts alerts on the associate's team cameras while they were clocked in (meal breaks excluded). Each row adds up: Accepted + Taken by others (a coworker or lead accepted within ${WAVE1_MIN} minutes) + Let pass (nobody accepted within ${WAVE1_MIN} minutes).`
      : `How to read this: "Escalations" counts alerts still open after ${WAVE1_MIN} minutes while the lead or coach was on shift. "Left ${LEAD_SIT_MIN}+ min" means it then sat another ${LEAD_SIT_MIN}+ minutes, or was never accepted.`;
    const head = w1 ? ["Associate", "Team", "On the clock", "Accepted", "Taken by others", "Let pass", "Let pass %"]
                    : ["Lead / coach", "Job", "Escalations", "Accepted", `Left ${LEAD_SIT_MIN}+ min`, "Left %"];
    const body = t.list.map((p) => w1
      ? [p.name, p.team || "", p.offered, p.took, p.others, p.passed, pct(p.passed, p.offered)]
      : [p.name, p.job || "", p.esc, p.escTook, p.escPassed, pct(p.escPassed, p.esc)]);
    const source = "Sources: SafeIQ alerts, GTA timesheet punches, the store schedule, and the Store Systems camera list.";

    const text = [title, range, "", "Summary", ...summary.map((x) => `- ${x}`), "", howTo, "",
      ...body.map((r) => w1
        ? `${r[0]} (${r[1]}): on the clock for ${r[2]} - accepted ${r[3]}, taken by others ${r[4]}, let pass ${r[5]} (${r[6]})`
        : `${r[0]} (${r[1]}): ${r[2]} escalations - accepted ${r[3]}, left ${LEAD_SIT_MIN}+ min ${r[4]} (${r[5]})`),
      "", source].join("\n");

    const cell = "padding:4px 10px;border:1px solid #d0d0d0;";
    const html = `<div style="font-family:Calibri,Arial,sans-serif;font-size:11pt;color:#222">` +
      `<p style="margin:0 0 2px"><b style="font-size:13pt">${esc(title)}</b></p><p style="margin:0 0 10px;color:#555">${esc(range)}</p>` +
      `<p style="margin:0 0 4px"><b>Summary</b></p><ul style="margin:0 0 10px">${summary.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` +
      `<p style="margin:0 0 10px;color:#555">${esc(howTo)}</p>` +
      `<table style="border-collapse:collapse;font-size:10.5pt"><thead><tr>${head.map((h, i) => `<th style="${cell}background:#f2f2f2;text-align:${i < 2 ? "left" : "right"}">${esc(h)}</th>`).join("")}</tr></thead>` +
      `<tbody>${body.map((r) => `<tr>${r.map((v, i) => `<td style="${cell}text-align:${i < 2 ? "left" : "right"}">${esc(String(v))}</td>`).join("")}</tr>`).join("")}</tbody></table>` +
      `<p style="margin:10px 0 0;color:#777;font-size:9pt">${esc(source)}</p></div>`;
    return { count: body.length, text, html };
  }

  function renderHours() {
    const hs = byHour(rows);
    const max = Math.max(1, ...hs.map((x) => x.total));
    const hl = (h) => (h % 24 === 0 ? "12a" : h < 12 ? h + "a" : h === 12 ? "12p" : (h - 12) + "p");
    els.hours.innerHTML = hs.map((x) =>
      `<div class="sa-h" data-tip="${hl(x.h)}–${hl(x.h + 1)}: ${x.total} alerts, ${x.nhf} non-issue (${pct(x.nhf, x.total)})"><b style="height:${Math.max(2, (100 * x.total) / max)}%"><i style="height:${(100 * x.nhf) / x.total}%"></i></b><small>${hl(x.h)}</small></div>`).join("");
  }

  // ── events ────────────────────────────────────────────────────
  const onImageError = (e) => {
    const img = e.target;
    if (img.tagName !== "IMG" || !img.closest(".sa-shot, #sa-lb")) return;
    const notice = document.createElement("div");
    notice.className = "sa-shot-none";
    notice.textContent = "Image unavailable from SafeIQ";
    img.replaceWith(notice);
  };
  root.addEventListener("error", onImageError, true);
  const onSortClick = (e) => {
    const th = e.target.closest("th[data-k]"); if (!th) return;
    const table = th.closest("table"); const t = tables[table.id]; if (!t) return;
    const k = th.dataset.k;
    if (t.sortState.sort === k) t.sortState.dir = t.sortState.dir === "desc" ? "asc" : "desc";
    else { t.sortState.sort = k; t.sortState.dir = t.cols.find((c) => c.k === k)?.r ? "desc" : "asc"; }
    table === els.cams ? renderCams() : table === els.oc ? renderOncall() : renderAss();
  };
  const onRowClick = (e) => {
    const tr = e.target.closest("tr.sa-row"); if (!tr) return;
    toggleDetail(tr.closest("table"), tr);
  };
  const onDetailClick = (e) => {
    const det = e.target.closest("tr.sa-det"); if (!det) return;
    const d = details.get(det.dataset.det); if (!d) return;
    const modeBtn = e.target.closest("[data-mode]");
    if (modeBtn) { d.mode = modeBtn.dataset.mode; renderDetail(det); return; }
    const shot = e.target.closest(".sa-shot");
    if (shot) {
      const list = d.rows.filter(detailFilter(d.mode));
      openLightbox(list, Number(shot.dataset.i), d.other);
    }
  };
  const onDetailKey = (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const shot = e.target.closest(".sa-shot"); if (!shot) return;
    e.preventDefault(); onDetailClick({ target: shot });
  };
  const onRowKey = (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const tr = e.target.closest("tr.sa-row"); if (!tr) return;
    e.preventDefault(); toggleDetail(tr.closest("table"), tr);
  };
  const onMove = (e) => {
    const t = e.target.closest("[data-tip]");
    if (!t) { els.tip.hidden = true; return; }
    els.tip.textContent = t.dataset.tip; els.tip.hidden = false;
    els.tip.style.left = Math.min(e.clientX + 12, window.innerWidth - 280) + "px";
    els.tip.style.top = (e.clientY + 14) + "px";
  };
  root.addEventListener("click", onSortClick);
  root.addEventListener("click", onRowClick);
  root.addEventListener("click", onDetailClick);
  root.addEventListener("keydown", onDetailKey);
  root.addEventListener("keydown", onRowKey);
  root.addEventListener("mousemove", onMove);
  root.addEventListener("mouseleave", () => { els.tip.hidden = true; });

  // Unattributed alerts as a shareable plain-text list. The button lives in
  // innerHTML the actions panel re-renders, so delegate from its container.
  function unattributedList() {
    const list = rows.filter((r) => actionKey(r[COL.action]) !== "acc")
      .sort((a, b) => (a[COL.ts] < b[COL.ts] ? -1 : 1));
    const lines = list.map((r) => {
      const [, m, d] = r[COL.ts].slice(0, 10).split("-");
      const where = [r[COL.camera], r[COL.dept], r[COL.aisle]].filter(Boolean).join(" · ");
      return `${weekdayOf(r[COL.ts])} ${Number(m)}/${Number(d)} ${r[COL.ts].slice(11)} · ${where} · ${ACTION_NAME[actionKey(r[COL.action])]}`;
    });
    const s = summarize(rows);
    return {
      count: list.length,
      text: [`SafeIQ alerts nobody accepted — store ${state.data.store}, ${withWeekday(s.minDate)} → ${withWeekday(s.maxDate)} (${list.length} alert${list.length === 1 ? "" : "s"})`, "", ...lines].join("\n"),
    };
  }
  els.actions.addEventListener("click", async (e) => {
    if (e.target.id !== "sa-share-unatt" || !state?.data) return;
    const { count, text } = unattributedList();
    await copyList(text, `Copied ${count} unaccepted alert${count === 1 ? "" : "s"} to the clipboard`);
  });

  // Top 10 associates by EXCESS held minutes — time beyond a per-alert working
  // allowance. A raw total scales with how many alerts someone answers, so it
  // ranks the busy (travel + cleanup on 47 alerts) above the one person who
  // parked a single alert for two hours; excess counts only the sitting.
  function topHoldsList() {
    const withExcess = groupBy(rows, COL.assoc)
      .filter((g) => g.key !== "(none)" && g.excessHold > 0)
      .sort((a, b) => b.excessHold - a.excessHold);
    // Volume noise: across 27–47 alerts a little excess accrues by sheer
    // volume (the odd big spill). Under 1 min/alert is workload, not parking.
    const diluted = (g) => g.excessHold / g.holds.length < HOLD_NOISE_PER_ALERT_MIN;
    const top = withExcess.filter((g) => !diluted(g)).slice(0, 10);
    const skipped = withExcess.filter(diluted);
    const s = summarize(rows);
    const lines = top.map((g, i) =>
      `${i + 1}. ${g.key} — ${f1(g.excessHold)} min beyond the allowance over ${g.holds.length} alert${g.holds.length === 1 ? "" : "s"}` +
      ` (${f1(g.totHold)} min held in total, longest ${f1(g.maxHold)} min${g.holdLong ? `, ${g.holdLong} held over ${HOLD_LONG_MIN} min` : ""})`);
    return {
      count: top.length,
      text: [`Top ${top.length} hold excess (accept → complete) — store ${state.data.store}, ${withWeekday(s.minDate)} → ${withWeekday(s.maxDate)}`,
             `While an accepted alert sits open, no one else can complete it. Each alert gets a ${HOLD_GRACE_MIN}-minute working allowance (travel + cleanup); only minutes past it count, so quick closes on many alerts don't outrank one parked alert. High-volume associates whose excess averages under ${HOLD_NOISE_PER_ALERT_MIN} min per alert are workload, not parking, and are skipped.`,
             "", ...lines,
             ...(skipped.length ? ["", `Skipped as volume noise: ${skipped.map((g) => `${g.key} (${f1(g.excessHold)} min over ${g.holds.length} alerts)`).join("; ")}`] : [])].join("\n"),
    };
  }
  els.shareHolds.addEventListener("click", async () => {
    if (!state?.data) return;
    const { count, text } = topHoldsList();
    if (!count) { host.ui.toast(`No alerts held past the ${HOLD_GRACE_MIN}-min allowance in this window.`); return; }
    await copyList(text, `Copied the top ${count} hold excess list to the clipboard`);
  });

  async function copyList(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      host.ui.toast(okMsg);
    } catch {
      host.ui.toast("Could not write to the clipboard — click the page once and retry.");
    }
  }

  els.pull.addEventListener("click", pull);
  els.ocPull.addEventListener("click", pullOncall);
  els.ocW1.addEventListener("click", () => { ui.ocWave = 1; savePrefs(); if (state?.data) renderOncall(); });
  els.ocW2.addEventListener("click", () => { ui.ocWave = 2; savePrefs(); if (state?.data) renderOncall(); });
  els.ocTeam.addEventListener("input", () => { if (state?.data) renderOncall(); });
  els.ocMin.addEventListener("input", () => { savePrefs(); if (state?.data) renderOncall(); });
  els.ocCopy.addEventListener("click", async () => {
    const out = state?.data && oncallText();
    if (!out?.count) { host.ui.toast("Nothing in the table to copy."); return; }
    const ok = `Copied ${out.count} row${out.count === 1 ? "" : "s"}, ready to paste into an email`;
    try {
      await navigator.clipboard.write([new ClipboardItem({
        "text/html": new Blob([out.html], { type: "text/html" }),
        "text/plain": new Blob([out.text], { type: "text/plain" }),
      })]);
      host.ui.toast(ok);
    } catch {
      await copyList(out.text, ok);   // plain text where rich copy is refused
    }
  });
  els.open.addEventListener("click", () => host.messaging.send("open_safeiq", {}));
  els.store.addEventListener("change", () => refresh(els.store.value.trim()));
  els.store.addEventListener("keydown", (e) => { if (e.key === "Enter") pull(); });
  for (const el of [els.from, els.to]) el.addEventListener("change", () => { if (state?.data) { applyFilter(); renderAll(); } });
  for (const el of [els.q, els.dept]) el.addEventListener("input", () => { if (state?.data) renderCams(); });
  els.min.addEventListener("input", () => { savePrefs(); if (state?.data) renderCams(); });
  els.amin.addEventListener("input", () => { savePrefs(); if (state?.data) renderAss(); });
  els.colFam.addEventListener("click", () => { ui.camMode = "fam"; savePrefs(); if (state?.data) renderCams(); });
  els.colAll.addEventListener("click", () => { ui.camMode = "all"; savePrefs(); if (state?.data) renderCams(); });
  els.assFam.addEventListener("click", () => { ui.assMode = "fam"; savePrefs(); if (state?.data) renderAss(); });
  els.assAll.addEventListener("click", () => { ui.assMode = "all"; savePrefs(); if (state?.data) renderAss(); });

  const unsubProgress = host.messaging.on("progress", (msg) => {
    if (busy) els.progress.textContent = msg.payload?.text || "";
  });
  const unsubOcProgress = host.messaging.on("oncall-progress", (msg) => {
    if (ocBusy) els.ocProgress.textContent = msg.payload?.text || "";
  });

  await loadPrefs();
  await refresh();

  return () => {
    root.removeEventListener("error", onImageError, true);
    unsubProgress();
    unsubOcProgress();
    document.removeEventListener("keydown", onLbKey);
    link.remove();
  };
}
