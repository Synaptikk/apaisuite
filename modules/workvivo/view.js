// modules/workvivo/view.js
//
// UI controller for the Workvivo module. Mounted by the shell when the user
// navigates to #/workvivo. Loads view.html + styles.css, wires the config
// form + manual-refresh button, subscribes to service.js broadcasts so
// status updates land without polling.
//
// All SW calls go through host.messaging.send / .on per the suite contract.
// Storage is read indirectly via the "get-status" handler so we never have
// two sources of truth for what the panel shows.

const BROADCAST_STATUS_CHANGED = "status-changed";

export async function mount(host, container) {
  // 1. Inject this module's stylesheet (removed on cleanup).
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = host.url("styles.css");
  link.dataset.module = host.id;
  document.head.appendChild(link);

  // 2. Load the markup.
  try {
    const resp = await fetch(host.url("view.html"));
    container.innerHTML = await resp.text();
  } catch (e) {
    container.innerHTML = `<div class="state-error">Failed to load Workvivo view: ${String(e?.message ?? e)}</div>`;
    return () => { link.remove(); };
  }

  const $ = (id) => container.querySelector("#" + id);

  // ── Render helpers ─────────────────────────────────────────────
  function fmtAgo(ms) {
    if (!ms) return "—";
    const diff = Date.now() - ms;
    if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))}s ago`;
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
    return `${Math.round(diff / 86_400_000)}d ago`;
  }

  function paintStatus(state) {
    const { lastStatus, lastSuccess, configured, apiKeyMasked, tabOpen, heartbeatPeriodMin } = state;

    // Top headline + dot
    const dot      = $("wv-statusDot");
    const headline = $("wv-statusHeadline");
    const detail   = $("wv-statusDetail");

    let color = "neutral";
    let head = "Status: not configured";
    let det  = "Paste your API key below, then click Send heartbeat now.";

    if (configured) {
      if (lastStatus?.ok) {
        color = "ok";
        head = "Status: healthy";
        det  = lastStatus.message ?? "Last heartbeat succeeded.";
      } else if (lastStatus && !lastStatus.ok) {
        color = lastStatus.errorClass === "NO_TAB" || lastStatus.errorClass === "NO_TOKEN" ? "warn" : "fail";
        head  = `Status: ${color === "warn" ? "waiting" : "broken"}`;
        det   = lastStatus.message ?? `Last heartbeat failed (${lastStatus.errorClass}).`;
      } else {
        color = "neutral";
        head  = "Status: configured, no heartbeat yet";
        det   = "Click Send heartbeat now to test, or wait for the next hourly tick.";
      }
    }
    dot.dataset.color = color;
    headline.textContent = head;
    detail.textContent   = det;

    // Row values
    $("wv-lastAttempt").textContent = lastStatus ? fmtAgo(lastStatus.at) : "—";
    $("wv-lastSuccess").textContent = lastSuccess
      ? `${fmtAgo(lastSuccess.at)}${lastSuccess.storeNumber ? ` · Store ${lastSuccess.storeNumber}` : ""}${lastSuccess.channelName ? ` · ${lastSuccess.channelName}` : ""}`
      : "—";
    $("wv-tabOpen").textContent = tabOpen ? "Yes" : "No — auto-opens once the last success is over 12 h old";
    $("wv-cadence").textContent = `Every ${heartbeatPeriodMin} min`;

    // API key placeholder — show masked saved value when field is empty.
    const apiKeyEl = $("wv-apiKey");
    if (apiKeyEl && document.activeElement !== apiKeyEl && !apiKeyEl.value) {
      apiKeyEl.placeholder = apiKeyMasked ? `saved: ${apiKeyMasked}` : "paste once — masked after save";
    }
  }

  async function reload() {
    try {
      const resp = await host.messaging.send("get-status");
      paintStatus(resp.data ?? resp);
    } catch (e) {
      $("wv-statusHeadline").textContent = `Status: error reading state`;
      $("wv-statusDetail").textContent   = String(e?.message ?? e);
    }
  }

  // ── "Your QRCallBox" card ──────────────────────────────────────
  // Renders user/store/channel + activity stats fetched from
  // /api/workvivo/connection-info. Hidden when not configured or when the
  // fetch fails for "no connection yet" reasons (404).
  function fmtMs(ms) {
    if (!ms || typeof ms !== "number") return "—";
    if (ms < 1000) return `${ms}ms`;
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    return `${Math.round(m / 60)}h`;
  }

  function paintConnection(data) {
    const section = $("wv-connection");
    if (!data?.ok) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    const body = data.body ?? data;
    const { user, store, activity, recentScans } = body;

    $("wv-connUser").textContent = user?.firstName
      ? `${user.firstName}${user.email ? ` (${user.email})` : ""}`
      : (user?.email || "—");
    $("wv-connStore").textContent     = store?.number     || "—";
    $("wv-connChannel").textContent   = store?.channelName || "(not picked yet)";
    $("wv-connTimeZone").textContent  = store?.timeZone   || "America/Chicago (default)";

    $("wv-connTotalScans").textContent = activity?.totalScans ?? "—";
    $("wv-connPosted").textContent     = activity?.scansPostedToWorkvivo ?? "—";
    $("wv-connAvgResp").textContent    = activity?.avgResponseTimeMs != null
      ? fmtMs(activity.avgResponseTimeMs)
      : "—";

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

    $("wv-connFootnote").textContent = activity
      ? `Last ${activity.windowDays} days.`
      : "";
  }

  async function reloadConnection() {
    try {
      const resp = await host.messaging.send("get-connection-info");
      const data = resp.data ?? resp;
      paintConnection(data);
    } catch {
      $("wv-connection").hidden = true;
    }
  }

  // ── Action wiring ──────────────────────────────────────────────
  $("wv-refreshNow").addEventListener("click", async () => {
    // The hourly heartbeat is the module's real work and runs in the SW; it
    // must NEVER count as usage or this module reads as the most-used in the
    // suite while nobody has opened it.
    host.usage.record("refresh_now");
    $("wv-refreshNow").disabled = true;
    $("wv-refreshMsg").textContent = "Sending…";
    try {
      const resp = await host.messaging.send("refresh-now");
      const status = resp.status ?? resp.data?.status;
      $("wv-refreshMsg").textContent = status?.ok ? "Sent." : `Failed: ${status?.message ?? "unknown"}`;
    } catch (e) {
      $("wv-refreshMsg").textContent = `Error: ${e?.message ?? e}`;
    } finally {
      $("wv-refreshNow").disabled = false;
      await reload();
      // Clear the message after a few seconds so the panel doesn't get noisy
      setTimeout(() => { $("wv-refreshMsg").textContent = ""; }, 5000);
    }
  });

  // Server-side post test. Unlike the heartbeat, a failure here is worth
  // leaving on screen — it names which half is broken, and the answer differs
  // per class. Sticky until the next press rather than the 5s auto-clear.
  $("wv-serverTest").addEventListener("click", async () => {
    $("wv-serverTest").disabled = true;
    $("wv-serverTestMsg").textContent = "Asking the server to post…";
    try {
      const resp = await host.messaging.send("server-test-post");
      const r = resp.data ?? resp;               // same unwrap as reloadConnection()
      if (r.ok) {
        const b = r.body || {};
        $("wv-serverTestMsg").textContent =
          `Posted to your Workvivo DM at ${b.sentAtLocal ?? "just now"}` +
          `${b.channelCreated ? " (created the DM)" : ""}. Check chat.`;
      } else {
        $("wv-serverTestMsg").textContent = explainServerTest(r);
      }
    } catch (e) {
      $("wv-serverTestMsg").textContent = `Error: ${e?.message ?? e}`;
    } finally {
      $("wv-serverTest").disabled = false;
    }
  });

  // Each class has a different fix, and "failed" on its own sends people to
  // re-paste an API key that was never the problem.
  function explainServerTest(r) {
    const detail = typeof r.body === "string" ? r.body : (r.body?.error ?? "");
    switch (r.errorClass) {
      case "CONFIG":
        return "Not configured yet — save your API key above first.";
      case "AUTH":
        return "The server rejected your API key. Generate a new one at qrcallbox.com → Workvivo and save it above.";
      case "TOKEN_STALE":
        return "Your API key is fine, but the token QRCallBox is holding is dead. Open a Workvivo tab and press “Send heartbeat now”, then retry.";
      case "NOT_FOUND":
        return "QRCallBox has no connection stored for you yet — press “Send heartbeat now” first.";
      case "TIMEOUT":
        return "The server didn't answer in time. Sendbird may be slow; try again.";
      case "NETWORK":
        return `Couldn't reach qrcallbox.com: ${detail}`;
      default:
        return `Server error${r.status ? ` (${r.status})` : ""}: ${detail || "unknown"}`;
    }
  }

  $("wv-saveConfig").addEventListener("click", async () => {
    const apiKey = $("wv-apiKey").value.trim();
    if (!apiKey) {
      $("wv-saveMsg").textContent = "API key is required.";
      return;
    }
    $("wv-saveConfig").disabled = true;
    $("wv-saveMsg").textContent = "Saving…";
    try {
      // endpointUrl: "" means "use hardcoded default in service.js"
      await host.messaging.send("save-config", { endpointUrl: "", apiKey });
      $("wv-saveMsg").textContent = "Saved. Click Send heartbeat now to test.";
      $("wv-apiKey").value = ""; // clear so the masked placeholder takes over
    } catch (e) {
      $("wv-saveMsg").textContent = `Failed: ${e?.message ?? e}`;
    } finally {
      $("wv-saveConfig").disabled = false;
      await reload();
      setTimeout(() => { $("wv-saveMsg").textContent = ""; }, 5000);
    }
  });

  $("wv-clearConfig").addEventListener("click", async () => {
    if (!confirm("Clear API key and status history?")) return;
    try {
      await host.messaging.send("clear-config");
      $("wv-apiKey").value = "";
    } catch (e) {
      $("wv-saveMsg").textContent = `Failed: ${e?.message ?? e}`;
    }
    await reload();
  });

  // ── Live updates from service.js ───────────────────────────────
  // CRITICAL: returned unsubscribe must be called from cleanup() to prevent
  // listener buildup on every mount.
  const unsubStatus = host.messaging.on(BROADCAST_STATUS_CHANGED, () => {
    reload();
    reloadConnection();
  });

  // Initial paint
  await reload();
  await reloadConnection();

  // Periodic re-render so the "Xm ago" labels stay current. Cheap — pure
  // local read + DOM update, no SW round-trip needed once the timestamps
  // are in hand.
  let lastState = null;
  const localTick = setInterval(async () => {
    try {
      const resp = await host.messaging.send("get-status");
      lastState = resp.data ?? resp;
      paintStatus(lastState);
    } catch { /* swallow — next reload() retries */ }
  }, 30_000);

  // Connection-info has heavier server work behind it; refresh on a slower
  // cadence than status. Anything more frequent would be wasteful for what
  // are largely-static fields (store, channel) plus an activity card that
  // doesn't change second-to-second.
  const connectionTick = setInterval(() => {
    reloadConnection();
  }, 60_000);

  // Shell-invoked cleanup
  return () => {
    clearInterval(localTick);
    clearInterval(connectionTick);
    unsubStatus();
    link.remove();
  };
}
