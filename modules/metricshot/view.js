// modules/metricshot/view.js
//
// UI controller for the Metric Screenshot Scheduler.
// Loads view.html + styles.css into the shell viewport, renders the metrics
// table, handles the add/edit modal, and pipes RPCs to service.js.

import { shortScheduleSummary } from "./lib/metrics.js";

export async function mount(host, container) {
  // 1. Stylesheet (removed on cleanup).
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = host.url("styles.css");
  link.dataset.module = host.id;
  document.head.appendChild(link);

  // 2. Markup.
  try {
    const resp = await fetch(host.url("view.html"));
    container.innerHTML = await resp.text();
  } catch (e) {
    container.innerHTML = `<div class="state-error">Failed to load Metric Shots view: ${host.ui.escapeHtml(String(e?.message ?? e))}</div>`;
    return () => link.remove();
  }

  const $ = (id) => container.querySelector("#" + id);
  const q = (sel) => container.querySelector(sel);
  const qa = (sel) => Array.from(container.querySelectorAll(sel));

  // State kept in this closure — never leaks outside cleanup.
  let metrics = [];
  let homeStore = null;
  let editingId = null;

  // 3. Subscribe to broadcasts BEFORE first render so we don't miss anything.
  const unsubStatus = host.messaging.on("status-changed", ({ id, status }) => {
    const m = metrics.find((x) => x.id === id);
    if (m) {
      m.lastStatus  = status;
      if (status?.ok) m.lastSuccess = { at: status.at, channelUrl: status.channelUrl, messageId: status.messageId };
      renderRow(m);
    }
  });
  const unsubTick = host.messaging.on("tick", ({ at }) => {
    updateTickState(at);
  });

  // 4. Wire top-level buttons.
  $("ms-add").addEventListener("click", () => openModal(null));
  $("ms-refresh").addEventListener("click", () => refresh());
  $("ms-modal-close").addEventListener("click", closeModal);
  $("ms-modal-backdrop").addEventListener("click", (e) => {
    if (e.target === $("ms-modal-backdrop")) closeModal();
  });
  $("ms-f-cancel").addEventListener("click", closeModal);
  $("ms-form").addEventListener("submit", onFormSubmit);
  $("ms-f-preview").addEventListener("click", onFormPreview);
  $("ms-f-probe").addEventListener("click", onFormProbe);
  $("ms-preview-close").addEventListener("click", () => $("ms-preview-card").hidden = true);
  $("ms-log-refresh").addEventListener("click", refreshLog);
  $("ms-store-nudge-open")?.addEventListener("click", () => host.route("#/settings"));

  // 5. Row action delegation.
  const rowsUnsub = host.ui.delegate(container, "click", "[data-action]", async (_e, el) => {
    const action = el.dataset.action;
    const id = el.dataset.id;
    if (!id) return;
    if (action === "edit")     return openModal(id);
    if (action === "duplicate") return duplicateMetric(id);
    if (action === "delete")   return deleteMetric(id);
    if (action === "run")      return runNow(id);
    if (action === "preview")  return previewNow(id);
  });
  const togglesUnsub = host.ui.delegate(container, "change", "[data-toggle-id]", async (_e, el) => {
    const id = el.dataset.toggleId;
    const enabled = !!el.checked;
    if (enabled && !hasStore()) {
      el.checked = false;
      host.ui.toast("Set your store in Settings → Defaults before enabling captures.", { kind: "error" });
      return;
    }
    try {
      await host.messaging.send("set-enabled", { id, enabled });
      const m = metrics.find((x) => x.id === id);
      if (m) m.enabled = enabled;
    } catch (e) {
      host.ui.toast(`Toggle failed: ${e?.message ?? e}`, { kind: "error" });
      await refresh();
    }
  });

  await refresh();
  await refreshLog();
  await updateTickStateFromAlarm();

  // ── Cleanup ────────────────────────────────────────────────────────────
  return () => {
    unsubStatus();
    unsubTick();
    rowsUnsub();
    togglesUnsub();
    link.remove();
  };

  // ── Data ───────────────────────────────────────────────────────────────

  async function refresh() {
    const tbody = $("ms-tbody");
    tbody.innerHTML = `<tr><td colspan="8" class="state-loading">Loading…</td></tr>`;
    try {
      const res = await host.messaging.send("list-metrics");
      metrics = res.metrics || [];
      homeStore = res.home || null;
      $("ms-home-store").textContent = `Store: ${homeStore || "not set"}`;
      applyStoreGate();
      renderTable();
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="8" class="state-error">Failed to load: ${host.ui.escapeHtml(String(e?.message ?? e))}</td></tr>`;
    }
  }

  // Store-required gate: without a home store, store-scoped captures would
  // render Tableau's default store ("1" = blank). Show the nudge banner and
  // disable the actions that would produce a bad post.
  function hasStore() {
    return /^\d{1,5}$/.test(String(homeStore ?? "").trim());
  }
  function applyStoreGate() {
    const ok = hasStore();
    const nudge = $("ms-store-nudge");
    if (nudge) nudge.hidden = ok;
    // Adding a metric is fine (it can be saved disabled), but running,
    // previewing, and enabling toggles must be blocked until a store exists.
    const addBtn = $("ms-add");
    if (addBtn) addBtn.disabled = false;
  }

  async function refreshLog() {
    try {
      const res = await host.messaging.send("get-log", { limit: 50 });
      const lines = (res.entries || []).slice().reverse().map((e) => {
        const t = new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        return `${t}  ${e.event.padEnd(18)} ${JSON.stringify(e.payload)}`;
      });
      $("ms-log-pre").textContent = lines.length ? lines.join("\n") : "(no events yet)";
    } catch (e) {
      $("ms-log-pre").textContent = `Log unavailable: ${e?.message ?? e}`;
    }
  }

  async function updateTickStateFromAlarm() {
    try {
      const res = await host.messaging.send("get-tick-state");
      if (res.alarmScheduledAt) {
        const next = new Date(res.alarmScheduledAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        $("ms-tick-state").textContent = `Next tick: ${next}`;
      } else {
        $("ms-tick-state").textContent = "Tick alarm not scheduled";
      }
    } catch (_) { /* silent */ }
  }

  function updateTickState(atMs) {
    const t = new Date(atMs || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    $("ms-tick-state").textContent = `Last tick: ${t}`;
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  function renderTable() {
    const tbody = $("ms-tbody");
    if (!metrics.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="state-empty">No metrics yet. Click <strong>+ Add Metric</strong> to get started.</td></tr>`;
      return;
    }
    tbody.innerHTML = metrics.map(rowHtml).join("");
  }

  function renderRow(m) {
    const tr = q(`tr[data-row-id="${cssEsc(m.id)}"]`);
    if (!tr) return;
    tr.outerHTML = rowHtml(m);
  }

  function rowHtml(m) {
    const summary = shortScheduleSummary(m);
    const dest = m.destination || {};
    const destStr = dest.channelName || "—";
    const destSuffix = dest.channelUrl ? ` (…${host.ui.escapeHtml(dest.channelUrl.slice(-6))})` : "";
    const capAt  = m.lastStatus?.capturedAt || m.lastStatus?.at;
    const okAt   = m.lastSuccess?.at;
    const statusPill = renderStatusPill(m);
    return `
      <tr data-row-id="${host.ui.escapeHtml(m.id)}">
        <td><strong>${host.ui.escapeHtml(m.name)}</strong><br><span class="muted tiny">${host.ui.escapeHtml(m.id)}</span></td>
        <td>${host.ui.escapeHtml(summary)}</td>
        <td>${host.ui.escapeHtml(destStr)}${destSuffix}</td>
        <td>${capAt ? fmtWhen(capAt) : "<span class='muted'>—</span>"}</td>
        <td>${okAt ? fmtWhen(okAt) : "<span class='muted'>—</span>"}</td>
        <td>${statusPill}</td>
        <td class="ms-col-enabled">
          <label class="ms-switch">
            <input type="checkbox" data-toggle-id="${host.ui.escapeHtml(m.id)}" ${m.enabled ? "checked" : ""}>
            <span></span>
          </label>
        </td>
        <td class="ms-col-actions">
          <button data-action="run"       data-id="${host.ui.escapeHtml(m.id)}" class="btn btn-secondary btn-xs" title="Run now">Run</button>
          <button data-action="preview"   data-id="${host.ui.escapeHtml(m.id)}" class="btn btn-secondary btn-xs" title="Preview">Preview</button>
          <button data-action="edit"      data-id="${host.ui.escapeHtml(m.id)}" class="btn btn-secondary btn-xs" title="Edit">Edit</button>
          <button data-action="duplicate" data-id="${host.ui.escapeHtml(m.id)}" class="btn btn-secondary btn-xs" title="Duplicate">Dup</button>
          <button data-action="delete"    data-id="${host.ui.escapeHtml(m.id)}" class="btn btn-danger btn-xs" title="Delete">Del</button>
        </td>
      </tr>`;
  }

  function renderStatusPill(m) {
    const s = m.lastStatus;
    if (!s) return `<span class="pill pill-muted">idle</span>`;
    if (s.ok) return `<span class="pill pill-success" title="${host.ui.escapeHtml(s.path || "")}">posted</span>`;
    const cls = s.errorClass === "AUTH" ? "pill-warn" : "pill-danger";
    const label = s.errorClass || s.stage || "failed";
    return `<span class="pill ${cls}" title="${host.ui.escapeHtml(s.error || "")}">${host.ui.escapeHtml(label.toString().toLowerCase())}</span>`;
  }

  // ── Actions ────────────────────────────────────────────────────────────

  async function runNow(id) {
    if (!hasStore()) {
      host.ui.toast("Set your store in Settings → Defaults first.", { kind: "error" });
      return host.route("#/settings");
    }
    host.ui.toast(`Running "${nameOf(id)}"…`);
    try {
      const res = await host.messaging.send("run-now", { id });
      if (res.status?.ok) host.ui.toast(`Posted to Workvivo (${res.status.path})`);
      else host.ui.toast(`Run failed: ${res.status?.error || "unknown"}`, { kind: "error" });
      await refresh();
      await refreshLog();
    } catch (e) {
      host.ui.toast(`Run threw: ${e?.message ?? e}`, { kind: "error" });
    }
  }

  async function previewNow(id) {
    if (!hasStore()) {
      host.ui.toast("Set your store in Settings → Defaults first.", { kind: "error" });
      return host.route("#/settings");
    }
    host.ui.toast(`Previewing "${nameOf(id)}"…`);
    try {
      const res = await host.messaging.send("preview", { id });
      if (!res.pngBase64) throw new Error(res.error || "no image");
      showPreview(res.pngBase64, res.width, res.height, `Preview: ${nameOf(id)} · ${res.width}×${res.height}`, res.followUp);
    } catch (e) {
      host.ui.toast(`Preview failed: ${e?.message ?? e}`, { kind: "error" });
    }
  }

  async function duplicateMetric(id) {
    const src = metrics.find((m) => m.id === id);
    if (!src) return;
    const copy = { ...src, id: "", name: `${src.name} (copy)` };
    delete copy.lastStatus; delete copy.lastSuccess; delete copy.summary; delete copy.next;
    try {
      const res = await host.messaging.send("save-metric", { metric: copy });
      if (!res.ok) throw new Error(res.error);
      host.ui.toast(`Duplicated as "${copy.name}"`);
      await refresh();
    } catch (e) {
      host.ui.toast(`Duplicate failed: ${e?.message ?? e}`, { kind: "error" });
    }
  }

  async function deleteMetric(id) {
    if (!confirm(`Delete "${nameOf(id)}"? This can't be undone.`)) return;
    try {
      await host.messaging.send("delete-metric", { id });
      host.ui.toast(`Deleted.`);
      await refresh();
    } catch (e) {
      host.ui.toast(`Delete failed: ${e?.message ?? e}`, { kind: "error" });
    }
  }

  // ── Modal ──────────────────────────────────────────────────────────────

  function openModal(id) {
    editingId = id;
    const m = id ? metrics.find((x) => x.id === id) : null;
    $("ms-modal-title").textContent = m ? `Edit metric: ${m.name}` : "Add metric";
    $("ms-form-msg").textContent = "";
    $("ms-f-id").value = m?.id || "";
    $("ms-f-name").value = m?.name || "";
    $("ms-f-url").value = m?.url || "";
    $("ms-f-enabled").checked = m?.enabled !== false;
    $("ms-f-channel").value = m?.destination?.channelName || "";
    $("ms-f-caption").value = m?.caption || "";
    $("ms-f-tz").value = m?.timezone || "local";
    $("ms-f-times").value = (m?.schedules || []).map((s) => s.time).join("\n") || "";
    const daysSet = new Set((m?.schedules || []).flatMap((s) => s.days));
    for (const cb of qa("#ms-f-days input[type=checkbox]")) cb.checked = m ? daysSet.has(cb.value) : true;
    const c = m?.capture || {};
    $("ms-f-mode").value = c.mode || "viewport";
    $("ms-f-selector").value = c.selector || "";
    $("ms-f-contain-text").value = (c.containText || []).join(", ");
    $("ms-f-req-selector").value = c.requiredSelector || "";
    $("ms-f-hide-selectors").value = (c.hideSelectors || []).join(", ");
    $("ms-f-vw").value = c.viewportWidth ?? 1440;
    $("ms-f-vh").value = c.viewportHeight ?? 1000;
    $("ms-f-settle").value = c.settleDelayMs ?? 8000;
    $("ms-f-timeout").value = c.timeoutMs ?? 60000;
    $("ms-f-retries").value = c.retries ?? 2;
    $("ms-f-catchup").value = c.catchUpWindowMs ?? 3600000;
    $("ms-modal-backdrop").hidden = false;
  }

  function closeModal() {
    $("ms-modal-backdrop").hidden = true;
    editingId = null;
  }

  function collectForm() {
    const times = $("ms-f-times").value.split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean);
    const days = qa("#ms-f-days input[type=checkbox]:checked").map((cb) => cb.value);
    const hide = $("ms-f-hide-selectors").value.split(",").map((s) => s.trim()).filter(Boolean);
    return {
      id: $("ms-f-id").value || undefined,
      name: $("ms-f-name").value.trim(),
      url: $("ms-f-url").value.trim(),
      enabled: $("ms-f-enabled").checked,
      timezone: $("ms-f-tz").value.trim() || "local",
      schedules: times.map((t) => ({ days, time: t })),
      destination: { type: "workvivo-sendbird", channelName: $("ms-f-channel").value.trim() },
      caption: $("ms-f-caption").value,
      capture: {
        mode: $("ms-f-mode").value,
        selector: $("ms-f-selector").value.trim() || null,
        containText: $("ms-f-contain-text").value.split(",").map(s => s.trim()).filter(Boolean),
        requiredSelector: $("ms-f-req-selector").value.trim() || null,
        hideSelectors: hide,
        viewportWidth: parseInt($("ms-f-vw").value, 10) || 1440,
        viewportHeight: parseInt($("ms-f-vh").value, 10) || 1000,
        zoom: 1,
        settleDelayMs: parseInt($("ms-f-settle").value, 10) || 0,
        timeoutMs: parseInt($("ms-f-timeout").value, 10) || 60000,
        retries: parseInt($("ms-f-retries").value, 10) || 0,
        catchUpWindowMs: parseInt($("ms-f-catchup").value, 10) || 0,
      },
    };
  }

  async function onFormSubmit(e) {
    e.preventDefault();
    $("ms-form-msg").textContent = "Saving…";
    try {
      const res = await host.messaging.send("save-metric", { metric: collectForm() });
      if (!res.ok) throw new Error(res.error);
      host.ui.toast(`Saved.`);
      closeModal();
      await refresh();
    } catch (err) {
      $("ms-form-msg").textContent = `Error: ${err?.message ?? err}`;
    }
  }

  async function onFormPreview() {
    // Save first (need an id + persisted config for the SW to preview).
    $("ms-form-msg").textContent = "Saving before preview…";
    try {
      const res = await host.messaging.send("save-metric", { metric: collectForm() });
      if (!res.ok) throw new Error(res.error);
      $("ms-f-id").value = res.id;
      editingId = res.id;
      await refresh();
      $("ms-form-msg").textContent = "Capturing preview…";
      const p = await host.messaging.send("preview", { id: res.id });
      if (!p.pngBase64) throw new Error(p.error || "no image");
      showPreview(p.pngBase64, p.width, p.height, `Preview · ${p.width}×${p.height}`, p.followUp);
      $("ms-form-msg").textContent = "Preview ready — check the panel below the modal.";
    } catch (err) {
      $("ms-form-msg").textContent = `Preview failed: ${err?.message ?? err}`;
    }
  }

  async function onFormProbe() {
    $("ms-form-msg").textContent = "Saving before probing…";
    try {
      const res = await host.messaging.send("save-metric", { metric: collectForm() });
      if (!res.ok) throw new Error(res.error);
      $("ms-f-id").value = res.id;
      $("ms-form-msg").textContent = "Looking up channel…";
      const r = await host.messaging.send("probe-destination", { id: res.id });
      if (r.ok) {
        $("ms-form-msg").textContent = `Matched channel "${r.matched}" (…${r.channelUrlSuffix}).`;
      } else {
        $("ms-form-msg").textContent = `Probe failed [${r.errorClass}]: ${r.error}`;
      }
    } catch (err) {
      $("ms-form-msg").textContent = `Probe failed: ${err?.message ?? err}`;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  function showPreview(pngBase64, w, h, label, followUp) {
    $("ms-preview-img").src = `data:image/png;base64,${pngBase64}`;
    $("ms-preview-meta").textContent = label || "";
    $("ms-preview-card").hidden = false;

    const wrap = $("ms-preview-followup");
    const pre  = $("ms-followup-pre");
    const meta = $("ms-followup-meta");
    if (!followUp) {
      wrap.hidden = true;
    } else if (followUp.ok) {
      wrap.hidden = false;
      meta.textContent = `${followUp.binsCount} bins · ${followUp.deptsCount} depts scraped`;
      pre.textContent = followUp.text || "(nothing to report — no rows above tier thresholds)";
    } else {
      wrap.hidden = false;
      meta.textContent = `scrape failed`;
      pre.textContent = `[${followUp.errorClass || "?"}] ${followUp.error || "unknown"}`;
    }

    $("ms-preview-card").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function nameOf(id) {
    const m = metrics.find((x) => x.id === id);
    return m?.name || id;
  }

  function fmtWhen(epochMs) {
    const d = new Date(epochMs);
    const sameDay = new Date().toDateString() === d.toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
  }

  function cssEsc(s) {
    return String(s).replace(/["\\]/g, (c) => "\\" + c);
  }
}
