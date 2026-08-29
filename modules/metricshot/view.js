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

  // Crop-tool state. `cropCtx` holds the last preview's geometry so a drawn
  // box can be mapped back to padding insets. `cropDrag` tracks an in-progress
  // drag in on-screen (CSS) pixels.
  let cropCtx = null;   // { id, clipUsed, anchorRegion, padding, natW, natH }
  let cropDrag = null;  // { x0, y0, x1, y1 }

  // Destination-picker sentinels. Declared here (not down by setChannelValue's
  // definition) because this whole function `return`s its cleanup callback at
  // the end of its synchronous setup — code positioned after that `return`
  // never executes as statements, only hoisted `function` declarations do.
  // These were `const`s sitting after the return: their bindings hoisted into
  // TDZ but the assignment line was unreachable dead code, so EVERY call to
  // setChannelValue (and therefore openModal — Add and Edit both) threw
  // "Cannot access 'SELF_VALUE' before initialization" before ever reaching
  // the line that shows the modal.
  const SELF_VALUE = "@me";
  const MANUAL_VALUE = "__manual__";

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
  $("ms-preview-close").addEventListener("click", () => { cancelCrop(); $("ms-preview-card").hidden = true; });
  $("ms-log-refresh").addEventListener("click", refreshLog);
  $("ms-dump-export")?.addEventListener("click", dumpExport);
  $("ms-try-export")?.addEventListener("click", tryExport);
  $("ms-introspect-sdk")?.addEventListener("click", introspectSdkClick);
  $("ms-read-netlog")?.addEventListener("click", readNetlogClick);

  $("ms-f-channel-load")?.addEventListener("click", loadChannels);
  $("ms-f-channel-select")?.addEventListener("change", () => {
    const manual = $("ms-f-channel-select").value === "__manual__";
    showManual(manual);
    const note = $("ms-f-channel-note");
    if (note && !manual) {
      note.textContent = $("ms-f-channel-select").value === "@me"
        ? "Posts as a direct message to you."
        : "Posts to this channel. You must already be a member.";
    }
  });
  $("ms-store-nudge-open")?.addEventListener("click", () => host.route("#/settings"));

  // Crop tool buttons + drag handlers.
  $("ms-crop-start")?.addEventListener("click", startCrop);
  $("ms-crop-reset")?.addEventListener("click", resetCrop);
  $("ms-crop-cancel")?.addEventListener("click", cancelCrop);
  $("ms-crop-save")?.addEventListener("click", saveCrop);
  const cropOverlay = $("ms-crop-overlay");
  cropOverlay?.addEventListener("pointerdown", onCropPointerDown);
  cropOverlay?.addEventListener("pointermove", onCropPointerMove);
  cropOverlay?.addEventListener("pointerup", onCropPointerUp);

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
    if (action === "resetcrop") return resetCropById(id);
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

  // ── Destination picker ────────────────────────────────────────────────
  //
  // A dropdown of joined channels, with a manual-entry input that appears only
  // when the list cannot be fetched. Listing needs a live Workvivo session and
  // opens a background tab to borrow one, so it is on demand rather than on
  // every form open — and the fallback exists so a failed fetch cannot leave
  // the user unable to save a metric at all.
  //
  // SELF_VALUE / MANUAL_VALUE are declared up near the other closure state
  // (not here) — see the comment there for why.

  function channelEls() {
    return { sel: $("ms-f-channel-select"), input: $("ms-f-channel"), note: $("ms-f-channel-note") };
  }

  function setChannelValue(name) {
    const { sel, input } = channelEls();
    if (!sel || !input) return;
    const v = String(name || "").trim();
    const isSelf = /^(@me|@self|\(me\))$/i.test(v);
    const opt = [...sel.options].find((o) => o.value.toLowerCase() === v.toLowerCase());

    if (isSelf || !v) {
      sel.value = SELF_VALUE;
      showManual(false);
    } else if (opt) {
      sel.value = opt.value;
      showManual(false);
    } else {
      // Saved channel that isn't in the (possibly unloaded) list — keep it
      // visible as a real choice instead of silently resetting to self, which
      // would change where an existing metric posts without telling anyone.
      const o = document.createElement("option");
      o.value = v;
      o.textContent = v;
      sel.insertBefore(o, sel.options[1] || null);
      sel.value = v;
      showManual(false);
    }
  }

  function getChannelValue() {
    const { sel, input } = channelEls();
    if (!sel) return input ? input.value.trim() : "";
    return sel.value === MANUAL_VALUE ? input.value.trim() : sel.value;
  }

  function showManual(on) {
    const { input } = channelEls();
    if (!input) return;
    input.classList.toggle("ms-hidden", !on);
    if (on) input.focus();
  }

  async function loadChannels() {
    const { sel, note } = channelEls();
    if (!sel) return;
    const btn = $("ms-f-channel-load");
    const keep = getChannelValue();
    if (btn) { btn.disabled = true; btn.textContent = "Loading…"; }
    if (note) note.textContent = "Opening Workvivo to read your channels…";
    try {
      const r = await host.messaging.send("list-channels", {});
      if (!r?.ok) {
        if (note) {
          note.textContent = r?.errorClass === "NO_SESSION"
            ? "Couldn't read your channels — open Workvivo and sign in, then try again. You can type a name instead."
            : `Couldn't read your channels (${r?.error || "unknown error"}). You can type a name instead.`;
        }
        ensureManualOption();
        return;
      }
      sel.innerHTML = "";
      const self = document.createElement("option");
      self.value = SELF_VALUE;
      self.textContent = "Direct message to me";
      sel.appendChild(self);
      for (const ch of r.channels || []) {
        if (ch.isSelf) continue;                 // already offered as "@me"
        const o = document.createElement("option");
        o.value = ch.name;
        o.textContent = ch.memberCount ? `${ch.name} (${ch.memberCount})` : ch.name;
        sel.appendChild(o);
      }
      ensureManualOption();
      setChannelValue(keep);
      if (note) {
        const n = (r.channels || []).filter((c) => !c.isSelf).length;
        note.textContent = r.truncated
          ? `Showing the first ${n} channels — there may be more. If yours is missing, type its name.`
          : `${n} channel${n === 1 ? "" : "s"} you've joined.`;
      }
    } catch (e) {
      if (note) note.textContent = `Couldn't read your channels (${e?.message || e}).`;
      ensureManualOption();
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Reload channels"; }
    }
  }

  function ensureManualOption() {
    const { sel } = channelEls();
    if (!sel || [...sel.options].some((o) => o.value === MANUAL_VALUE)) return;
    const o = document.createElement("option");
    o.value = MANUAL_VALUE;
    o.textContent = "Type a channel name…";
    sel.appendChild(o);
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

  // TEMP diagnostic: dump the export/command requests recorded after the user
  // clicks Tableau's Download button, so we can reverse-engineer the endpoint.
  async function dumpExport() {
    const pre = $("ms-dump-export-pre");
    pre.textContent = "Reading capture ring…";
    try {
      const res = await host.messaging.send("dump-export-requests", {});
      pre.textContent = JSON.stringify(res, null, 2);
      try { await navigator.clipboard.writeText(JSON.stringify(res, null, 2)); host.ui?.toast?.("Export requests copied to clipboard."); }
      catch { /* clipboard blocked — still shown in the panel */ }
    } catch (e) {
      pre.textContent = `Dump failed: ${e?.message ?? e}`;
    }
  }

  // TEMP diagnostic: find where the Sendbird SDK lives in the Workvivo tab
  // + its shape, so we can fix detection when Workvivo changes the global.
  async function introspectSdkClick() {
    const pre = $("ms-dump-export-pre");
    pre.textContent = "Opening Workvivo tab + introspecting SDK (up to ~20s)…";
    try {
      const res = await host.messaging.send("introspect-sdk", {});
      pre.textContent = JSON.stringify(res, null, 2);
      try { await navigator.clipboard.writeText(JSON.stringify(res, null, 2)); host.ui?.toast?.("SDK introspection copied to clipboard."); }
      catch { /* clipboard blocked — still shown in the panel */ }
    } catch (e) {
      pre.textContent = `Introspect failed: ${e?.message ?? e}`;
    }
  }

  // TEMP diagnostic: read the sniffer's netlog off a tab the user already has
  // open (unlike introspectSdkClick, which opens its own fresh tab and so
  // would always see an empty log). Use after manually sending a test image
  // in your own Workvivo tab, to capture the real upload route.
  async function readNetlogClick() {
    const pre = $("ms-dump-export-pre");
    pre.textContent = "Reading netlog from your open Workvivo tab…";
    try {
      const res = await host.messaging.send("read-netlog", {});
      pre.textContent = JSON.stringify(res, null, 2);
      try { await navigator.clipboard.writeText(JSON.stringify(res, null, 2)); host.ui?.toast?.("Netlog copied to clipboard."); }
      catch { /* clipboard blocked — still shown in the panel */ }
    } catch (e) {
      pre.textContent = `Read netlog failed: ${e?.message ?? e}`;
    }
  }

  // TEMP diagnostic: run the headless crosstab export and show the real rows
  // so we can confirm column layout + wire the follow-up text.
  async function tryExport() {
    const pre = $("ms-dump-export-pre");
    pre.textContent = "Running headless export (this can take a few seconds)…";
    try {
      const res = await host.messaging.send("try-export", { format: "excel" });
      pre.textContent = JSON.stringify(res, null, 2);
      try { await navigator.clipboard.writeText(JSON.stringify(res, null, 2)); host.ui?.toast?.("Export result copied to clipboard."); }
      catch { /* clipboard blocked — still shown in the panel */ }
    } catch (e) {
      pre.textContent = `Export failed: ${e?.message ?? e}`;
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
          ${rowHasCrop(m) ? `<button data-action="resetcrop" data-id="${host.ui.escapeHtml(m.id)}" class="btn btn-secondary btn-xs" title="Clear the saved crop">Reset crop</button>` : ""}
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
    // The 1-minute tick alarm posts scheduled metrics from the SW and never
    // reaches here, so this is only ever a person pressing Run now.
    host.usage.record("run_now");
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
      showPreview(res.pngBase64, res.width, res.height, `Preview: ${nameOf(id)} · ${res.width}×${res.height}`, res.followUp, { id, ...res });
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
    setChannelValue(m?.destination?.channelName || "@me");
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
    $("ms-f-zoom").value = c.zoom ?? 1;
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
      destination: { type: "workvivo-sendbird", channelName: getChannelValue() },
      caption: $("ms-f-caption").value,
      capture: {
        mode: $("ms-f-mode").value,
        selector: $("ms-f-selector").value.trim() || null,
        containText: $("ms-f-contain-text").value.split(",").map(s => s.trim()).filter(Boolean),
        requiredSelector: $("ms-f-req-selector").value.trim() || null,
        hideSelectors: hide,
        viewportWidth: parseInt($("ms-f-vw").value, 10) || 1440,
        viewportHeight: parseInt($("ms-f-vh").value, 10) || 1000,
        // CSS zoom (<1 shrinks content to fit more into the capture surface).
        // Clamped to the validator's (0, 3] range; falls back to 1 if blank.
        zoom: Math.min(3, Math.max(0.25, parseFloat($("ms-f-zoom").value) || 1)),
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
      showPreview(p.pngBase64, p.width, p.height, `Preview · ${p.width}×${p.height}`, p.followUp, { id: res.id, ...p });
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

  function showPreview(pngBase64, w, h, label, followUp, ctx) {
    const img = $("ms-preview-img");
    img.src = `data:image/png;base64,${pngBase64}`;
    $("ms-preview-meta").textContent = label || "";
    $("ms-preview-card").hidden = false;

    // Crop tool is only offered for region-mode captures that reported their
    // geometry (clipUsed + anchorRegion). Other modes have nothing to inset.
    cancelCrop();
    const canCrop = !!(ctx && ctx.id && ctx.clipUsed && ctx.anchorRegion);
    $("ms-crop-start").hidden = !canCrop;
    cropCtx = canCrop
      ? {
          id: ctx.id,
          clipUsed: ctx.clipUsed,
          anchorRegion: ctx.anchorRegion,
          padding: ctx.padding || { top: 0, right: 0, bottom: 0, left: 0 },
          natW: w, natH: h,
        }
      : null;
    // Offer Reset only when a non-zero crop is currently saved.
    const p = cropCtx?.padding;
    const hasCrop = !!(p && (p.top || p.right || p.bottom || p.left));
    $("ms-crop-reset").hidden = !(canCrop && hasCrop);

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
      // On a PARSE failure the raw Tableau body was stashed — offer to copy it
      // so the parser can be fixed against real data.
      if (ctx?.id) maybeShowScrapeDebug(ctx.id);
    }

    $("ms-preview-card").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // Fetch the stashed raw Tableau response for a failed scrape and append it
  // to the follow-up panel + copy to clipboard, so it can be shared to fix
  // the parser. Best-effort; silent if nothing saved.
  async function maybeShowScrapeDebug(id) {
    try {
      const res = await host.messaging.send("get-scrape-debug", { id });
      const dbg = res?.debug;
      if (!dbg) return;
      const body = dbg.respBodyPreview || "";
      const pre = $("ms-followup-pre");
      pre.textContent += `\n\n── Raw Tableau response (${body.length} chars) ──\nURL: ${dbg.capturedUrl || "?"}\n\n${body}`;
      try { await navigator.clipboard.writeText(body); host.ui.toast("Raw scrape body copied to clipboard."); }
      catch { /* clipboard blocked — it's still shown in the panel */ }
    } catch { /* ignore */ }
  }

  // ── Crop tool ───────────────────────────────────────────────────────────
  // The preview image IS the captured clip box (cropCtx.clipUsed, in viewport
  // px). When the user drags a keep-rectangle, we convert it to viewport px,
  // then express it as padding insets relative to the anchor region so the
  // dynamic containText anchoring still works on future captures:
  //   left   = anchor.x               - keep.x
  //   top    = anchor.y               - keep.y
  //   right  = keep.x2 - (anchor.x + anchor.width)
  //   bottom = keep.y2 - (anchor.y + anchor.height)
  // Negative insets crop inward; positive add margin.
  function startCrop() {
    if (!cropCtx) return;
    $("ms-crop-start").hidden = true;
    $("ms-crop-save").hidden = false;
    $("ms-crop-cancel").hidden = false;
    $("ms-crop-hint").hidden = false;
    $("ms-crop-overlay").hidden = false;
    $("ms-crop-box").hidden = true;
    cropDrag = null;
  }

  function cancelCrop() {
    cropDrag = null;
    const box = $("ms-crop-box");
    if (box) box.hidden = true;
    const ov = $("ms-crop-overlay");
    if (ov) ov.hidden = true;
    $("ms-crop-save").hidden = true;
    $("ms-crop-cancel").hidden = true;
    $("ms-crop-hint").hidden = true;
    $("ms-crop-start").hidden = !cropCtx;
    const p = cropCtx?.padding;
    $("ms-crop-reset").hidden = !(cropCtx && p && (p.top || p.right || p.bottom || p.left));
  }

  // Clear any saved crop (padding back to 0). Recovery hatch if a crop ever
  // trims too much or breaks the capture.
  async function resetCrop() {
    if (!cropCtx) return;
    try {
      const res = await host.messaging.send("set-crop", {
        id: cropCtx.id, padding: { top: 0, right: 0, bottom: 0, left: 0 },
      });
      if (!res.ok) throw new Error(res.error || "reset failed");
      cropCtx.padding = res.padding;
      cancelCrop();
      host.ui.toast("Crop reset — re-run Preview to confirm.");
    } catch (e) {
      host.ui.toast(`Crop reset failed: ${e?.message ?? e}`, { kind: "error" });
    }
  }

  // Does this metric have a non-zero saved crop? Used to show a row-level
  // "Reset crop" button so a bad crop is recoverable even when Preview itself
  // fails (a too-aggressive crop shrinks capture below the min size, so the
  // preview panel never opens — the in-panel Reset would be unreachable).
  function rowHasCrop(m) {
    const p = m?.capture?.padding;
    return !!(p && (p.top || p.right || p.bottom || p.left));
  }

  // Row-level reset: works without a loaded preview (recovers the deadlock).
  async function resetCropById(id) {
    try {
      const res = await host.messaging.send("set-crop", {
        id, padding: { top: 0, right: 0, bottom: 0, left: 0 },
      });
      if (!res.ok) throw new Error(res.error || "reset failed");
      host.ui.toast(`Crop reset for "${nameOf(id)}" — try Preview again.`);
      await refresh();
    } catch (e) {
      host.ui.toast(`Crop reset failed: ${e?.message ?? e}`, { kind: "error" });
    }
  }

  function onCropPointerDown(e) {
    if (!cropCtx) return;
    const r = $("ms-crop-overlay").getBoundingClientRect();
    const px = Math.max(0, Math.min(r.width,  e.clientX - r.left));
    const py = Math.max(0, Math.min(r.height, e.clientY - r.top));

    // Click-move-click model: if a box is currently being sized, this second
    // click LOCKS it in place rather than throwing it away and starting over
    // (the old bug — every pointerdown reset the box to zero size).
    if (cropDrag && cropDrag.active) {
      cropDrag.x1 = px;
      cropDrag.y1 = py;
      cropDrag.active = false;
      drawCropBox();
      return;
    }

    // Otherwise begin a new box (first click, or redraw after a locked one).
    cropDrag = { x0: px, y0: py, x1: px, y1: py, downX: px, downY: py, active: true };
    $("ms-crop-overlay").setPointerCapture?.(e.pointerId);
    drawCropBox();
  }

  function onCropPointerMove(e) {
    if (!cropDrag || !cropDrag.active) return;
    const r = $("ms-crop-overlay").getBoundingClientRect();
    cropDrag.x1 = Math.max(0, Math.min(r.width,  e.clientX - r.left));
    cropDrag.y1 = Math.max(0, Math.min(r.height, e.clientY - r.top));
    drawCropBox();
  }

  function onCropPointerUp(e) {
    if (!cropDrag || !cropDrag.active) return;
    $("ms-crop-overlay").releasePointerCapture?.(e.pointerId);
    // Two interaction styles, both supported:
    //  - DRAG: press → move → release. If the pointer actually moved, treat the
    //    release as the lock.
    //  - CLICK-MOVE-CLICK: press+release in ~the same spot is just placing the
    //    first corner — keep the box active so the next move rubber-bands and
    //    the next click locks it (handled in onCropPointerDown).
    const moved = Math.abs(cropDrag.x1 - cropDrag.downX) + Math.abs(cropDrag.y1 - cropDrag.downY);
    if (moved > 4) cropDrag.active = false;
  }

  function drawCropBox() {
    if (!cropDrag) return;
    const box = $("ms-crop-box");
    const x = Math.min(cropDrag.x0, cropDrag.x1);
    const y = Math.min(cropDrag.y0, cropDrag.y1);
    const w = Math.abs(cropDrag.x1 - cropDrag.x0);
    const h = Math.abs(cropDrag.y1 - cropDrag.y0);
    box.hidden = false;
    box.style.left = `${x}px`;
    box.style.top = `${y}px`;
    box.style.width = `${w}px`;
    box.style.height = `${h}px`;
  }

  async function saveCrop() {
    if (!cropCtx || !cropDrag) {
      host.ui.toast("Draw a crop box first.", { kind: "error" });
      return;
    }
    const img = $("ms-preview-img");
    // Displayed size can differ from natural size (max-width:100%). Scale the
    // on-screen drag back to natural (viewport) pixels.
    const dispW = img.clientWidth  || cropCtx.natW;
    const dispH = img.clientHeight || cropCtx.natH;
    const sx = cropCtx.natW / dispW;
    const sy = cropCtx.natH / dispH;

    const dx = Math.min(cropDrag.x0, cropDrag.x1) * sx;
    const dy = Math.min(cropDrag.y0, cropDrag.y1) * sy;
    const dw = Math.abs(cropDrag.x1 - cropDrag.x0) * sx;
    const dh = Math.abs(cropDrag.y1 - cropDrag.y0) * sy;
    // The saved region ends up ~= the drawn box (natural px). The capture is
    // rejected below 100×100 (validate.js), which used to leave the user stuck
    // — preview fails, panel never opens, in-panel Reset unreachable. Enforce
    // a comfortable minimum here so a bad crop can't be saved in the first
    // place.
    const MIN_CROP_PX = 120;
    if (dw < MIN_CROP_PX || dh < MIN_CROP_PX) {
      host.ui.toast(`Crop box too small — draw at least ${MIN_CROP_PX}×${MIN_CROP_PX}px.`, { kind: "error" });
      return;
    }

    // Keep-rectangle in absolute viewport px = clipUsed origin + offset in img.
    const keep = {
      x:  cropCtx.clipUsed.x + dx,
      y:  cropCtx.clipUsed.y + dy,
      x2: cropCtx.clipUsed.x + dx + dw,
      y2: cropCtx.clipUsed.y + dy + dh,
    };
    const a = cropCtx.anchorRegion;
    const padding = {
      left:   Math.round(a.x - keep.x),
      top:    Math.round(a.y - keep.y),
      right:  Math.round(keep.x2 - (a.x + a.width)),
      bottom: Math.round(keep.y2 - (a.y + a.height)),
    };

    try {
      const res = await host.messaging.send("set-crop", { id: cropCtx.id, padding });
      if (!res.ok) throw new Error(res.error || "save failed");
      cropCtx.padding = res.padding;
      cancelCrop();
      host.ui.toast("Crop saved — re-run Preview to confirm.");
    } catch (e) {
      host.ui.toast(`Crop save failed: ${e?.message ?? e}`, { kind: "error" });
    }
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
