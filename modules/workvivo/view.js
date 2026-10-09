// modules/workvivo/view.js
//
// UI controller for the QRCallBox ↔ Workvivo connector panel. Mounted by the
// shell when the user navigates to #/workvivo. Loads view.html + styles.css,
// paints the health card and the three-step setup checklist, and subscribes
// to service.js broadcasts so status updates land without polling.
//
// All SW calls go through host.messaging.send / .on per the suite contract.
// Storage is read indirectly via the "get-status" handler so there is one
// source of truth for what the panel shows.

const BROADCAST_STATUS_CHANGED = "status-changed";
const POSTABLE = new Set(["ready", "validation_warn", "active"]);

export async function mount(host, container) {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = host.url("styles.css");
  link.dataset.module = host.id;
  document.head.appendChild(link);

  try {
    const resp = await fetch(host.url("view.html"));
    container.innerHTML = await resp.text();
  } catch (e) {
    console.warn("[workvivo] view load failed:", e);
    container.textContent = "Couldn't load this page. Reload the suite.";
    container.className += " state-error";
    return () => { link.remove(); };
  }

  const $ = (id) => container.querySelector("#" + id);

  // ── Formatting ─────────────────────────────────────────────────
  function fmtAgo(ms) {
    if (!ms) return "—";
    const diff = Date.now() - ms;
    if (diff < 0) return "just now";
    if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))}s ago`;
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
    return `${Math.round(diff / 86_400_000)}d ago`;
  }
  function fmtIn(ms) {
    if (!ms) return "—";
    const diff = ms - Date.now();
    if (diff <= 0) return "any moment";
    if (diff < 3_600_000) return `in ${Math.max(1, Math.round(diff / 60_000))}m`;
    return `in ${Math.round(diff / 3_600_000)}h`;
  }
  function fmtDur(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "—";
    const m = Math.floor(ms / 60_000), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d > 0) return `${d}d ${h % 24}h`;
    if (h > 0) return `${h}h ${m % 60}m`;
    return `${m}m`;
  }
  function fmtMs(ms) {
    if (!ms || typeof ms !== "number") return "—";
    if (ms < 1000) return `${ms}ms`;
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    return `${Math.round(m / 60)}h`;
  }

  // ── Health card ────────────────────────────────────────────────
  function deriveHeadline(state) {
    const { lastStatus, lastSuccess, configured } = state;
    const health = state.server?.health ?? null;

    if (!configured) {
      return { color: "neutral", head: "Not set up yet", det: "Work through the three steps below." };
    }

    // A courier failure newer than the last success outranks whatever the
    // server thinks: the server's view is only as fresh as the last delivery.
    const courierBroken = lastStatus && !lastStatus.ok && lastStatus.at > (lastSuccess?.at ?? 0);
    if (courierBroken) {
      const soft = lastStatus.errorClass === "NO_TAB" || lastStatus.errorClass === "NO_TOKEN";
      return {
        color: soft ? "warn" : "fail",
        head:  soft ? "Waiting for Workvivo" : "Can't reach QRCallBox",
        det:   lastStatus.message ?? "Last attempt failed.",
      };
    }

    const chan = health?.channelName ?? lastSuccess?.channelName ?? null;
    switch (health?.status) {
      case "ready":
      case "active":
        return {
          color: health.lastServerPostOk === false ? "warn" : "ok",
          head:  `Posting to ${chan || "your store channel"}`,
          det:   health.lastServerPostAtMs
            ? (health.lastServerPostOk === false
                ? "The last post failed; it will retry on the next scan."
                : `Last posted a scan ${fmtAgo(health.lastServerPostAtMs)}.`)
            : "Connected. The next scan will post.",
        };
      case "validation_warn":
        return {
          color: "warn",
          head:  "Connection unverified",
          det:   "Couldn't verify the connection. Press Refresh now.",
        };
      case "needs_channel":
        return { color: "warn", head: "Pick your store's channel", det: "Connected. Choose the channel in step 3." };
      case "needs_reauth":
        return {
          color: "fail",
          head:  "Workvivo sign-in expired",
          det:   "Sign in to Workvivo, then press Refresh now.",
        };
      default:
        if (lastSuccess) {
          return { color: "ok", head: "Connected", det: "Waiting for the first scan to post." };
        }
        return { color: "neutral", head: "Ready to connect", det: "Sign in to Workvivo and press Refresh now." };
    }
  }

  function paintStatus(state) {
    const { lastSuccess, tabOpen, nextHeartbeatAt, retryCount, pushLinked, apiKeyMasked, configured } = state;
    const health = state.server?.health ?? null;
    const { color, head, det } = deriveHeadline(state);

    $("wv-statusDot").dataset.color = color;
    $("wv-statusHeadline").textContent = head;
    $("wv-statusDetail").textContent   = det;

    $("wv-serverPost").textContent = health?.lastServerPostAtMs
      ? `${fmtAgo(health.lastServerPostAtMs)} · ${health.lastServerPostOk === false ? "failed" : "ok"}`
      : "no scan posted yet";
    $("wv-lastSuccess").textContent = lastSuccess
      ? `${fmtAgo(lastSuccess.at)}${lastSuccess.storeNumber ? ` · store ${lastSuccess.storeNumber}` : ""}`
      : "never";
    $("wv-nextCheck").textContent = configured
      ? `${fmtIn(nextHeartbeatAt)}${retryCount ? ` · retry ${retryCount} queued` : ""}`
      : "—";

    // Steps
    const step1 = configured;
    const step2 = !!lastSuccess;
    const step3 = POSTABLE.has(health?.status);
    setStep("wv-step1", step1, step1 ? `saved (${apiKeyMasked})` : "");
    setStep("wv-step2", step2, step2
      ? `connected${lastSuccess?.storeNumber ? ` · store ${lastSuccess.storeNumber}` : ""}`
      : (step1 ? "" : "after step 1"));
    setStep("wv-step3", step3, step3
      ? (health?.channelName || "channel saved")
      : (step2 ? "" : "after step 2"));

    const apiKeyEl = $("wv-apiKey");
    if (apiKeyEl && document.activeElement !== apiKeyEl && !apiKeyEl.value) {
      apiKeyEl.placeholder = apiKeyMasked ? `saved: ${apiKeyMasked}` : "paste once — masked after save";
    }

    paintChannels(state.server?.channels ?? [], health?.channelUrl ?? null, step2);
  }

  function setStep(id, done, label) {
    const li = $(id);
    if (!li) return;
    li.dataset.done = done ? "true" : "false";
    const state = li.querySelector(".wv-step-state");
    if (state) state.textContent = done ? `✓ ${label}` : label;
  }

  let lastRenderedChannelsKey = "";
  function paintChannels(channels, currentUrl, connected) {
    const sel = $("wv-channelSelect");
    const key = JSON.stringify([channels.map((c) => c.url), currentUrl]);
    if (key === lastRenderedChannelsKey && sel.options.length) return;
    lastRenderedChannelsKey = key;
    sel.innerHTML = "";
    if (!channels.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = connected ? "Press Refresh now to load your channels" : "Complete step 2 first";
      sel.appendChild(opt);
      sel.disabled = true;
      $("wv-saveChannel").disabled = true;
      return;
    }
    sel.disabled = false;
    $("wv-saveChannel").disabled = false;
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Choose a channel…";
    sel.appendChild(placeholder);
    for (const c of channels) {
      const opt = document.createElement("option");
      opt.value = c.url;
      opt.textContent = c.name || c.url;
      if (c.url === currentUrl) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  async function reload() {
    try {
      const resp = await host.messaging.send("get-status");
      paintStatus(resp.data ?? resp);
    } catch (e) {
      $("wv-statusHeadline").textContent = "Error reading state";
      $("wv-statusDetail").textContent   = String(e?.message ?? e);
    }
  }

  // ── "Your QRCallBox" card ──────────────────────────────────────
  function paintConnection(data) {
    const section = $("wv-connection");
    if (!data?.ok) { section.hidden = true; return; }
    section.hidden = false;
    const body = data.body ?? data;
    const { user, store, activity, recentScans } = body;

    $("wv-connUser").textContent = user?.firstName
      ? `${user.firstName}${user.email ? ` (${user.email})` : ""}`
      : (user?.email || "—");
    $("wv-connStore").textContent    = store?.number      || "—";
    $("wv-connChannel").textContent  = store?.channelName || "(not picked yet)";

    $("wv-connTotalScans").textContent = activity?.totalScans ?? "—";
    $("wv-connPosted").textContent     = activity?.scansPostedToWorkvivo ?? "—";
    $("wv-connAvgResp").textContent    = activity?.avgResponseTimeMs != null ? fmtMs(activity.avgResponseTimeMs) : "—";

    const ul = $("wv-connRecent");
    ul.innerHTML = "";
    if (!recentScans?.length) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "No scans in the last 7 days.";
      ul.appendChild(li);
    } else {
      for (const s of recentScans) {
        const li = document.createElement("li");
        const ago = s.atMs ? fmtAgo(s.atMs) : "—";
        const claimed = s.claimedByName ? ` · claimed by ${s.claimedByName}` : "";
        const posted = s.workvivoPostedAtMs ? " · posted ✓" : "";
        li.textContent = `${ago} — ${s.area || "(unknown area)"}${claimed}${posted}`;
        ul.appendChild(li);
      }
    }
  }

  async function reloadConnection() {
    try {
      const resp = await host.messaging.send("get-connection-info");
      paintConnection(resp.data ?? resp);
    } catch {
      $("wv-connection").hidden = true;
    }
  }

  // ── Actions ────────────────────────────────────────────────────
  function flash(id, text, sticky = false) {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    if (!sticky) setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 6000);
  }

  async function refreshNow(msgId) {
    // The hourly heartbeat is the module's real work and runs in the SW; it
    // must never count as usage. A deliberate button press does.
    host.usage.record("refresh_now");
    for (const id of ["wv-refreshNow", "wv-refreshNow2"]) $(id).disabled = true;
    flash(msgId, "Checking…", true);
    try {
      const resp = await host.messaging.send("refresh-now");
      const status = resp.status ?? resp.data?.status;
      flash(msgId, status?.ok ? status.message || "Delivered." : `Failed: ${status?.message ?? "unknown"}`, !status?.ok);
    } catch (e) {
      flash(msgId, `Error: ${e?.message ?? e}`, true);
    } finally {
      for (const id of ["wv-refreshNow", "wv-refreshNow2"]) $(id).disabled = false;
      await reload();
      reloadConnection();
    }
  }
  $("wv-refreshNow").addEventListener("click", () => refreshNow("wv-refreshMsg"));
  $("wv-refreshNow2").addEventListener("click", () => refreshNow("wv-step2Msg"));

  $("wv-openWorkvivo").addEventListener("click", async () => {
    try { await host.messaging.send("open-workvivo"); }
    catch (e) { flash("wv-step2Msg", `Error: ${e?.message ?? e}`, true); }
  });

  // Server-side post test. A failure here names which half is broken, so it
  // stays on screen until the next press.
  $("wv-serverTest").addEventListener("click", async () => {
    $("wv-serverTest").disabled = true;
    flash("wv-refreshMsg", "Sending test…", true);
    try {
      const resp = await host.messaging.send("server-test-post");
      const r = resp.data ?? resp;
      if (r.ok) {
        const b = r.body || {};
        flash("wv-refreshMsg",
          `Test sent to your Workvivo DM at ${b.sentAtLocal ?? "just now"}. Check chat.`, true);
      } else {
        flash("wv-refreshMsg", explainServerTest(r), true);
      }
    } catch (e) {
      flash("wv-refreshMsg", `Error: ${e?.message ?? e}`, true);
    } finally {
      $("wv-serverTest").disabled = false;
    }
  });

  function explainServerTest(r) {
    const detail = typeof r.body === "string" ? r.body : (r.body?.error ?? "");
    console.warn("[workvivo] server test failed:", r.errorClass, r.status, detail);
    switch (r.errorClass) {
      case "CONFIG":      return "Not configured yet — save your API key in step 1.";
      case "AUTH":        return "The server rejected your API key. Generate a new one at qrcallbox.com → Settings → Integrations and save it in step 1.";
      case "TOKEN_STALE": return "Workvivo sign-in expired. Press Refresh now, then retry.";
      case "NOT_FOUND":   return "Not connected yet. Press Refresh now first.";
      case "TIMEOUT":     return "No answer in time. Try again.";
      case "NETWORK":     return "Couldn't reach qrcallbox.com. Check your connection and try again.";
      default:            return "Something went wrong. Try again.";
    }
  }

  $("wv-saveConfig").addEventListener("click", async () => {
    const apiKey = $("wv-apiKey").value.trim();
    if (!apiKey) { flash("wv-saveMsg", "Paste the API key first."); return; }
    $("wv-saveConfig").disabled = true;
    flash("wv-saveMsg", "Saving…", true);
    try {
      const resp = await host.messaging.send("save-config", { endpointUrl: "", apiKey });
      const r = resp.data ?? resp;
      if (r?.ok === false) { flash("wv-saveMsg", r.error || "Save failed.", true); return; }
      $("wv-apiKey").value = "";
      flash("wv-saveMsg", "Saved. Now sign in to Workvivo and press Refresh now.", true);
    } catch (e) {
      flash("wv-saveMsg", `Failed: ${e?.message ?? e}`, true);
    } finally {
      $("wv-saveConfig").disabled = false;
      await reload();
    }
  });

  $("wv-clearConfig").addEventListener("click", async () => {
    if (!confirm("Remove the API key from this browser?")) return;
    try {
      await host.messaging.send("clear-config");
      $("wv-apiKey").value = "";
      lastRenderedChannelsKey = "";
    } catch (e) {
      flash("wv-saveMsg", `Failed: ${e?.message ?? e}`, true);
    }
    await reload();
    reloadConnection();
  });

  $("wv-saveChannel").addEventListener("click", async () => {
    const channelUrl = $("wv-channelSelect").value;
    if (!channelUrl) { flash("wv-channelMsg", "Choose a channel first."); return; }
    $("wv-saveChannel").disabled = true;
    flash("wv-channelMsg", "Checking with the server…", true);
    try {
      const resp = await host.messaging.send("set-channel", { channelUrl });
      const r = resp.data ?? resp;
      if (r.ok) {
        flash("wv-channelMsg", `Saved. Scans will post to ${r.body?.channelName || "that channel"}.`, true);
      } else {
        const detail = typeof r.body === "string" ? r.body : (r.body?.error ?? "");
        console.warn("[workvivo] set-channel failed:", r.errorClass, detail);
        flash("wv-channelMsg", r.errorClass === "TOKEN_STALE"
          ? "Workvivo sign-in expired. Press Refresh now, then save the channel again."
          : "Couldn't save the channel. Try again.", true);
      }
    } catch (e) {
      flash("wv-channelMsg", `Error: ${e?.message ?? e}`, true);
    } finally {
      $("wv-saveChannel").disabled = false;
      lastRenderedChannelsKey = "";
      await reload();
      reloadConnection();
    }
  });

  // ── Live updates from service.js ───────────────────────────────
  const unsubStatus = host.messaging.on(BROADCAST_STATUS_CHANGED, () => {
    reload();
    reloadConnection();
  });

  await reload();
  await reloadConnection();

  // Keep the relative times honest.
  const localTick = setInterval(reload, 30_000);
  const connectionTick = setInterval(reloadConnection, 60_000);

  return () => {
    clearInterval(localTick);
    clearInterval(connectionTick);
    unsubStatus();
    link.remove();
  };
}
