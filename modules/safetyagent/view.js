// modules/safetyagent/view.js
//
// Safety Agent Dashboard — shell page. Reads the cached pull from
// service.js::get_state, filters by date client-side, and renders tiles,
// the disposition families, a sortable camera pivot, an associate table and
// an hour-of-day chart. Every roll-up lives in lib/aggregate.js.

import { COL, TAGS, FAMILY_ORDER, FAMILY_NAME, familyOf, groupBy, summarize, byHour } from "./lib/aggregate.js";
import { hazardImageUrl } from "./lib/sql.js";

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
    fam: $("#sa-fam"), reasons: $("#sa-reasons"),
    q: $("#sa-q"), dept: $("#sa-dept"), min: $("#sa-min"), colFam: $("#sa-col-fam"), colAll: $("#sa-col-all"),
    camCount: $("#sa-cam-count"), cams: $("#sa-cams"), amin: $("#sa-amin"), assCount: $("#sa-ass-count"), ass: $("#sa-ass"),
    hours: $("#sa-hours"), foot: $("#sa-foot"), tip: $("#sa-tip"),
  };

  const f1  = (x) => (x == null ? "–" : (Math.round(x * 10) / 10).toFixed(1));
  const pct = (a, b) => (b ? Math.round((100 * a) / b) + "%" : "–");
  const fmtDate = (ms) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  let state = null;         // { store, storeSource, hasToken, data }
  let rows = [];            // rows after the date filter
  let busy = false;
  const ui = { camMode: "fam", cam: { sort: "nhf", dir: "desc" }, ass: { sort: "nhf", dir: "desc" } };

  // ── prefs ─────────────────────────────────────────────────────
  async function loadPrefs() {
    const p = await host.storage.local.get(PREFS_KEY).catch(() => null);
    if (!p) return;
    if (p.camMode === "all") ui.camMode = "all";
    if (typeof p.min === "number") els.min.value = p.min;
    if (typeof p.amin === "number") els.amin.value = p.amin;
  }
  const savePrefs = () => host.storage.local.set(PREFS_KEY, {
    camMode: ui.camMode, min: Number(els.min.value) || 1, amin: Number(els.amin.value) || 1,
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
      `<span>Window <b>${esc(s.minDate || "–")} → ${esc(s.maxDate || "–")}</b> (${s.days} days${d.from || d.to ? "" : ", all dates available"})</span>` +
      `<span>Latest detection <b class="sa-mono">${esc(s.last || "–")}</b> local</span>` +
      `<span>Pulled <b>${esc(fmtDate(d.pulledAt))}</b></span>`;

    els.tiles.innerHTML = [
      [String(s.total), "Alerts", `during operating hours, ${s.days} days`, ""],
      [pct(s.nhf, s.total), "Closed as a non-issue", `${s.nhf} alerts: ${s.byTag.no_hazard_found || 0} no hazard, ${s.byTag.no_spill || 0} no spill, ${s.byTag.no_object || 0} no object`, "sa-tile-hi"],
      [`${f1(s.medAck)} min`, "Median time to acknowledge", `${s.gt10} alerts took over 10 min`, ""],
      [String(s.cameras), "Cameras that alerted", `${s.associates} associates responded`, ""],
    ].map(([v, l, sub, c]) => `<div class="sa-tile ${c}"><div class="sa-eyebrow">${esc(l)}</div><div class="sa-tile-v">${esc(v)}</div><div class="sa-tile-s">${esc(sub)}</div></div>`).join("");

    els.fam.innerHTML =
      `<div class="sa-bar">${FAMILY_ORDER.map((k) => `<span class="sa-fam-${k}" style="width:${s.total ? (100 * s.byFam[k]) / s.total : 0}%" data-tip="${esc(FAMILY_NAME[k])}: ${s.byFam[k]} (${pct(s.byFam[k], s.total)})"></span>`).join("")}</div>` +
      `<div class="sa-legend">${FAMILY_ORDER.map((k) => `<span><i class="sa-fam-${k}"></i>${esc(FAMILY_NAME[k])}<span class="sa-num sa-muted">${s.byFam[k]} · ${pct(s.byFam[k], s.total)}</span></span>`).join("")}</div>`;
    els.reasons.innerHTML = [...TAGS, "(none)"].map((t) =>
      `<div><span><i class="sa-fam-${familyOf(t)}"></i>${esc(t)}</span><span class="sa-num sa-muted">${s.byTag[t] || 0}</span></div>`).join("");

    renderCams();
    renderAss();
    renderHours();
    els.foot.textContent = `Times are store-local. "Ack" is minutes from detection to the associate accepting the alert; "done" is minutes from detection to task complete. ${s.byFam.none} alerts have no tag (Not Available or No Action). Families are a reviewer grouping of the 12 system tags, not a SafeIQ field.`;
  }

  // Column definitions ----------------------------------------------------
  const baseCols = (label) => [
    { k: "key", h: label, v: (r) => r.key, cell: (r) => `<td class="${label === "Camera" ? "sa-cam" : ""}">${esc(r.key)}</td>` },
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
  ];

  // Generic sortable table with a click-to-expand event list ---------------
  const tables = {};   // id → { groups, cols, sortState, detailLabel }
  function renderTable(table, groups, cols, sortState, filterFn, countEl, detailLabel) {
    const list = groups.filter(filterFn);
    const c = cols.find((x) => x.k === sortState.sort) || cols[0];
    list.sort((a, b) => {
      const x = c.v(a), y = c.v(b);
      const numeric = (typeof x === "number" || x == null) && (typeof y === "number" || y == null);
      const r = numeric ? (x ?? -1) - (y ?? -1) : String(x).localeCompare(String(y));
      return sortState.dir === "desc" ? -r : r;
    });
    const ctx = { maxNhf: Math.max(1, ...groups.map((g) => g.nhf)) };
    table.querySelector("thead").innerHTML = `<tr>${cols.map((col) =>
      `<th class="${col.r ? "r" : ""}" data-k="${col.k}"${col.title ? ` title="${esc(col.title)}"` : ""}${sortState.sort === col.k ? ` aria-sort="${sortState.dir}ending"` : ""}>${col.dot ? `<span class="sa-dot sa-fam-${col.dot}"></span>` : ""}${esc(col.h)}</th>`).join("")}</tr>`;
    table.querySelector("tbody").innerHTML = list.map((g, i) =>
      `<tr class="sa-row" tabindex="0" data-i="${i}" aria-expanded="false">${cols.map((col) => col.cell(g, ctx)).join("")}</tr>`).join("");
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
    details.set(id, { rows: all, mode: "all", other: t.detailLabel === "Associate" ? COL.assoc : COL.camera, key: g.key });
    const det = document.createElement("tr");
    det.className = "sa-det"; det.dataset.det = id;
    det.innerHTML = `<td colspan="${t.cols.length}"><div class="sa-det-in"></div></td>`;
    tr.after(det);
    tr.setAttribute("aria-expanded", "true");
    renderDetail(det);
  }
  function renderDetail(det) {
    const d = details.get(det.dataset.det); if (!d) return;
    const list = d.mode === "nhf" ? d.rows.filter((r) => familyOf(r[COL.reason]) === "nhf") : d.rows;
    const nhfCount = d.rows.filter((r) => familyOf(r[COL.reason]) === "nhf").length;
    const noIds = d.rows.length && !d.rows.some((r) => r[COL.id]);
    det.querySelector(".sa-det-in").innerHTML =
      `<div class="sa-det-head"><b>${esc(d.key)}</b><span class="sa-muted">${d.rows.length} alert${d.rows.length === 1 ? "" : "s"} in window · ${nhfCount} non-issue</span>` +
      `<span class="btn-group" role="group" aria-label="Show"><button class="btn btn-sm btn-group-item" data-mode="all" aria-pressed="${d.mode === "all"}">All</button><button class="btn btn-sm btn-group-item" data-mode="nhf" aria-pressed="${d.mode === "nhf"}">Non-issue only</button></span>` +
      (noIds ? `<span class="sa-muted">Image IDs unavailable for these alerts. Use Pull alerts to retry.</span>` : `<span class="sa-muted">Click a frame to enlarge.</span>`) + `</div>` +
      `<div class="sa-gallery">` + list.map((r, i) => {
        const url = hazardImageUrl(r[COL.id]);
        const tag = r[COL.reason] || "(no tag)";
        return `<figure class="sa-shot" data-i="${i}" tabindex="0" role="button" aria-label="Open alert image">` +
          (url ? `<img loading="lazy" decoding="async" src="${url}" alt="${esc(tag)} at ${esc(r[COL.ts])}">` : `<div class="sa-shot-none">No image</div>`) +
          `<figcaption><span class="sa-tag sa-fam-${familyOf(r[COL.reason])}">${esc(tag)}</span> <span class="sa-mono">${esc(r[COL.ts].slice(5))}</span><br>${esc(r[d.other] || "—")}${r[COL.ack] != null ? ` · ack ${f1(r[COL.ack])} min` : ""}${r[COL.aisle] ? ` · ${esc(r[COL.aisle])}` : ""}</figcaption></figure>`;
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
    lbEls.meta.innerHTML = `<span class="sa-tag sa-fam-${familyOf(r[COL.reason])}">${esc(tag)}</span> <b>${esc(r[COL.camera])}</b> <span class="sa-mono">${esc(r[COL.ts])}</span> · ${esc(r[COL.assoc] || r[COL.action] || "")}${r[COL.ack] != null ? ` · ack ${f1(r[COL.ack])} min` : ""}${r[COL.ttc] != null ? ` · done ${f1(r[COL.ttc])} min` : ""} <span class="sa-muted">${lb.i + 1} / ${lb.rows.length}</span>`;
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
      els.camCount, "Associate");
    els.colFam.setAttribute("aria-pressed", String(ui.camMode === "fam"));
    els.colAll.setAttribute("aria-pressed", String(ui.camMode === "all"));
  }

  function renderAss() {
    const groups = groupBy(rows, COL.assoc);
    const min = Number(els.amin.value) || 1;
    renderTable(els.ass, groups, [...baseCols("Associate"), ...famCols, ...timeCols], ui.ass, (g) => g.total >= min, els.assCount, "Camera");
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
    table === els.cams ? renderCams() : renderAss();
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
      const list = d.mode === "nhf" ? d.rows.filter((r) => familyOf(r[COL.reason]) === "nhf") : d.rows;
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

  els.pull.addEventListener("click", pull);
  els.open.addEventListener("click", () => host.messaging.send("open_safeiq", {}));
  els.store.addEventListener("change", () => refresh(els.store.value.trim()));
  els.store.addEventListener("keydown", (e) => { if (e.key === "Enter") pull(); });
  for (const el of [els.from, els.to]) el.addEventListener("change", () => { if (state?.data) { applyFilter(); renderAll(); } });
  for (const el of [els.q, els.dept]) el.addEventListener("input", () => { if (state?.data) renderCams(); });
  els.min.addEventListener("input", () => { savePrefs(); if (state?.data) renderCams(); });
  els.amin.addEventListener("input", () => { savePrefs(); if (state?.data) renderAss(); });
  els.colFam.addEventListener("click", () => { ui.camMode = "fam"; savePrefs(); if (state?.data) renderCams(); });
  els.colAll.addEventListener("click", () => { ui.camMode = "all"; savePrefs(); if (state?.data) renderCams(); });

  const unsubProgress = host.messaging.on("progress", (msg) => {
    if (busy) els.progress.textContent = msg.payload?.text || "";
  });

  await loadPrefs();
  await refresh();

  return () => {
    root.removeEventListener("error", onImageError, true);
    unsubProgress();
    document.removeEventListener("keydown", onLbKey);
    link.remove();
  };
}
