// modules/qrcallbox/view.js
//
// QRCallBox panel: sign-in, then Scans / Insights / Team / Posters / Workvivo
// tabs over the SW handlers in service.js. Everything is fetched on demand
// (tab open, period change, Refresh); nothing subscribes, so cleanup only
// removes the stylesheet and timers.

import { create as qrCreate } from "./vendor/qrcode.min.js";
import { summarize, radioLabel } from "./lib/stats.js";

const TABS = ["scans", "insights", "team", "posters", "workvivo"];
const PREFS_KEY = "prefs";   // { tab, days } via host.storage.local
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const ERROR_TEXT = {
  LOGIN:      "Email or password is wrong.",
  LOCKED:     "QRCallBox has paused sign-ins for this account. Wait a few minutes or ask an admin.",
  SIGNED_OUT: "Your QRCallBox sign-in expired. Sign in again.",
  FORBIDDEN:  "QRCallBox didn't allow that for your account.",
  NO_STORE:   "Your QRCallBox account has no store yet. An admin sets it when approving you.",
  INDEX:      "QRCallBox needs a database index for this view. Tell the QRCallBox admin.",
  TIMEOUT:    "No answer in time. Try again.",
  NETWORK:    "Couldn't reach QRCallBox. Check your connection and try again.",
};
const errText = (r) => ERROR_TEXT[r?.errorClass] ?? (r?.error ? `Something went wrong: ${r.error}` : "Something went wrong. Try again.");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function fmtWhen(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

function fmtDur(ms) {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function qrSvg(text, px = 8) {
  const { modules } = qrCreate(text, { errorCorrectionLevel: "M" });
  const n = modules.size, q = 4, size = (n + q * 2) * px;
  let d = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (modules.get(r, c)) d += `M${(c + q) * px} ${(r + q) * px}h${px}v${px}h-${px}z`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="100%" role="img" aria-label="QR code">`
    + `<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

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
    console.warn("[qrcallbox] view load failed:", e);
    container.textContent = "Couldn't load this page. Reload the suite.";
    container.className += " state-error";
    return () => { link.remove(); };
  }

  const $ = (id) => container.querySelector("#" + id);
  const call = (type, payload) => host.messaging.sendRaw(type, payload).catch((e) => ({ ok: false, error: e?.message ?? String(e) }));

  let profile = null;
  const prefs = (await host.storage.local.get(PREFS_KEY).catch(() => null)) ?? {};
  let tab = TABS.includes(prefs.tab) ? prefs.tab : "scans";
  const savePrefs = () => host.storage.local.set(PREFS_KEY, { tab, days: $("qc-days").value }).catch(() => {});
  let scans = null;          // { key, rows, truncated }
  let lastPoster = null;
  let disposed = false;

  $("qc-days").value = String(prefs.days ?? "7");
  if (!$("qc-days").value) $("qc-days").value = "7";

  const store = () => (profile?.isAdmin ? $("qc-store").value.trim() : "") || profile?.store || "";
  const days = () => Number($("qc-days").value) || 7;

  function flash(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
  }

  function showBanner(text) {
    const el = $("qc-banner");
    el.textContent = text || "";
    el.hidden = !text;
  }

  // ── Session ────────────────────────────────────────────────────
  function paintSession() {
    const signedIn = !!profile;
    $("qc-signin").hidden = signedIn;
    $("qc-main").hidden = !signedIn;
    $("qc-account").hidden = !signedIn;
    if (!signedIn) return;
    const bits = [profile.name || profile.email];
    if (profile.store) bits.push(`store ${profile.store}`);
    if (profile.isAdmin) bits.push("admin");
    $("qc-who").textContent = bits.join(" · ");
    $("qc-storePick").hidden = !profile.isAdmin;
    if (profile.isAdmin && !$("qc-store").value) $("qc-store").value = profile.store;
    showBanner(!profile.approved && !profile.isAdmin
      ? "Your QRCallBox account isn't approved yet. Ask a QRCallBox admin to approve it for your store."
      : (!profile.store && !profile.isAdmin ? ERROR_TEXT.NO_STORE : ""));
  }

  async function loadSession() {
    const r = await call("get-session");
    if (disposed) return;
    if (!r.ok) {
      profile = null;
      paintSession();
      flash("qc-signinMsg", errText(r));
      return;
    }
    profile = r.signedIn ? r.profile : null;
    paintSession();
    if (profile) showTab(tab);
  }

  $("qc-signinForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const email = $("qc-email").value.trim();
    const password = $("qc-password").value;
    $("qc-signinBtn").disabled = true;
    flash("qc-signinMsg", "Signing in…");
    const r = await call("sign-in", { email, password });
    $("qc-password").value = "";
    $("qc-signinBtn").disabled = false;
    if (!r.ok) { flash("qc-signinMsg", errText(r)); return; }
    flash("qc-signinMsg", "");
    profile = r.profile;
    scans = null;
    paintSession();
    showTab(tab);
  });

  $("qc-signOut").addEventListener("click", async () => {
    await call("sign-out");
    profile = null;
    scans = null;
    paintSession();
  });

  container.querySelectorAll("[data-site]").forEach((a) => a.addEventListener("click", (ev) => {
    ev.preventDefault();
    call("open-site", { path: a.dataset.site });
  }));

  // A handler error that means the session is gone sends the user back to sign-in.
  function handleFail(r, msgId = "qc-loadMsg") {
    if (r?.errorClass === "SIGNED_OUT") { profile = null; paintSession(); flash("qc-signinMsg", errText(r)); return; }
    flash(msgId, errText(r));
  }

  // ── Tabs ───────────────────────────────────────────────────────
  function showTab(name) {
    tab = name;
    savePrefs();
    container.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("is-active", b.dataset.tab === name));
    container.querySelectorAll("[data-pane]").forEach((p) => { p.hidden = p.dataset.pane !== name; });
    $("qc-days").disabled = !(name === "scans" || name === "insights");
    loadTab(name);
  }

  container.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  $("qc-reload").addEventListener("click", () => { scans = null; loadTab(tab, true); });
  $("qc-days").addEventListener("change", () => { savePrefs(); scans = null; loadTab(tab); });
  $("qc-store").addEventListener("change", () => { scans = null; loadTab(tab); });

  async function loadTab(name, force = false) {
    if (!profile) return;
    if (name === "scans" || name === "insights") return loadScans(force);
    if (name === "team") return loadTeam();
    if (name === "posters") return loadLocations();
    if (name === "workvivo") return loadWorkvivo();
  }

  // ── Scans + Insights ───────────────────────────────────────────
  async function loadScans(force) {
    const key = `${store()}|${days()}`;
    if (!force && scans?.key === key) { paintScans(); return; }
    flash("qc-loadMsg", "Loading scans…");
    const r = await call("scans", { store: store(), days: days() });
    if (disposed) return;
    if (!r.ok) { handleFail(r); return; }
    scans = { key, rows: r.rows, truncated: r.truncated, store: r.store };
    flash("qc-loadMsg", r.truncated ? `Showing the newest ${r.rows.length} scans.` : "");
    paintScans();
  }

  function paintScans() {
    const s = summarize(scans.rows);
    const pct = (n) => (s.total ? `${Math.round((n / s.total) * 100)}%` : "—");
    $("qc-kpis").innerHTML = [
      ["Scans", s.total, `store ${esc(scans.store)}`],
      ["Posted to Workvivo", s.posted, pct(s.posted)],
      ["Announced on radio", s.announced, pct(s.announced)],
      ["Answer recorded", s.answered, s.medianResponseMs != null ? `typical ${fmtDur(s.medianResponseMs)}` : pct(s.answered)],
    ].map(([label, value, sub]) => `<div class="card qc-kpi"><div class="muted tiny">${label}</div><div class="qc-kpi-value">${value}</div><div class="muted tiny">${sub}</div></div>`).join("");

    const rows = scans.rows.slice(0, 300);
    $("qc-scanRows").innerHTML = rows.map((r) => `<tr>
      <td>${fmtWhen(r.ts)}</td>
      <td>${esc(r.area)}</td>
      <td>${esc(radioLabel(r.radio))}</td>
      <td>${r.wvPosted ? `<span class="badge badge-success">Posted</span>` : `<span class="badge badge-muted">No</span>`}</td>
      <td>${esc(r.responder) || `<span class="muted">—</span>`}</td>
      <td>${fmtDur(r.responseMs)}</td>
    </tr>`).join("");
    $("qc-scanEmpty").hidden = scans.rows.length > 0;

    paintInsights(s);
  }

  function paintInsights(s) {
    const head = `<div></div>${Array.from({ length: 24 }, (_, h) => `<div class="qc-heat-h">${h % 3 === 0 ? (h % 12 || 12) + (h < 12 ? "a" : "p") : ""}</div>`).join("")}`;
    const body = s.heat.map((row, d) => `<div class="qc-heat-d">${WEEKDAYS[d]}</div>${row.map((n, h) => {
      const level = s.heatMax ? Math.ceil((n / s.heatMax) * 4) : 0;
      return `<div class="qc-heat-c qc-l${level}" title="${WEEKDAYS[d]} ${h}:00 · ${n} scan${n === 1 ? "" : "s"}">${n || ""}</div>`;
    }).join("")}`).join("");
    $("qc-heat").innerHTML = head + body;

    $("qc-areaRows").innerHTML = s.areas.map((a) => `<tr>
      <td>${esc(a.area)}</td><td class="num">${a.count}</td><td class="num">${a.answered}</td><td>${fmtWhen(a.lastTs)}</td>
    </tr>`).join("") || `<tr><td colspan="4" class="muted">No scans.</td></tr>`;

    $("qc-respRows").innerHTML = s.responders.map((p) => `<tr>
      <td>${esc(p.name)}</td><td class="num">${p.count}</td><td class="num">${fmtDur(p.medianMs)}</td>
    </tr>`).join("") || `<tr><td colspan="3" class="muted">No recorded answers in this period.</td></tr>`;
  }

  // ── Team ───────────────────────────────────────────────────────
  async function loadTeam() {
    flash("qc-loadMsg", "Loading team…");
    const r = await call("team", { store: store() });
    if (disposed) return;
    if (!r.ok) { handleFail(r); return; }
    flash("qc-loadMsg", "");
    $("qc-teamStore").textContent = `store ${r.store}`;
    $("qc-teamHint").textContent = r.canApprove
      ? "Approve new accounts here. Approving also confirms the store number."
      : "Everyone with a QRCallBox account at your store.";
    $("qc-teamActHead").textContent = r.canApprove ? "" : "";
    $("qc-teamRows").innerHTML = r.people.map((p) => `<tr>
      <td>${esc(p.name)}${p.email ? `<div class="muted tiny">${esc(p.email)}</div>` : ""}</td>
      <td>${esc(p.jobTitle) || `<span class="muted">—</span>`}</td>
      <td>${p.approved ? `<span class="badge badge-success">Approved</span>` : `<span class="badge badge-warn">Waiting</span>`}${p.onShift ? ` <span class="badge badge-info">On shift</span>` : ""}</td>
      <td>${fmtWhen(p.lastSeen)}</td>
      <td>${r.canApprove && !p.approved ? `<button class="btn btn-primary btn-sm" data-approve="${esc(p.uid)}">Approve</button>` : ""}</td>
    </tr>`).join("") || `<tr><td colspan="5" class="muted">Nobody has signed up at this store yet.</td></tr>`;

    container.querySelectorAll("[data-approve]").forEach((b) => b.addEventListener("click", async () => {
      b.disabled = true;
      b.textContent = "Approving…";
      const res = await call("approve-user", { uid: b.dataset.approve, store: r.store });
      if (!res.ok) { b.disabled = false; b.textContent = "Approve"; handleFail(res); return; }
      loadTeam();
    }));
  }

  // ── Posters ────────────────────────────────────────────────────
  async function loadLocations() {
    if ($("qc-area").options.length) return;
    const r = await call("locations");
    if (disposed) return;
    if (!r.ok) { handleFail(r, "qc-mintMsg"); return; }
    $("qc-area").innerHTML = `<option value="">Pick an area…</option>`
      + r.locations.map((l) => `<option value="${esc(l.name)}">${esc(l.name)}</option>`).join("");
  }

  $("qc-mint").addEventListener("click", async () => {
    const area = $("qc-area").value;
    if (!area) { flash("qc-mintMsg", "Pick an area first."); return; }
    $("qc-mint").disabled = true;
    flash("qc-mintMsg", "Making poster…");
    const r = await call("mint-poster", { store: store(), area, areaDescription: $("qc-areaDesc").value });
    $("qc-mint").disabled = false;
    if (!r.ok) { handleFail(r, "qc-mintMsg"); return; }
    flash("qc-mintMsg", "");
    lastPoster = r;
    $("qc-posterQr").innerHTML = qrSvg(r.url);
    $("qc-posterArea").textContent = `${r.areaDescription} · store ${r.store}`;
    $("qc-posterUrl").textContent = r.url;
    $("qc-poster").hidden = false;
  });

  $("qc-print").addEventListener("click", () => {
    if (!lastPoster) return;
    const w = window.open("", "_blank");
    if (!w) { flash("qc-mintMsg", "Allow pop-ups for the suite to print."); return; }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>QR poster · ${esc(lastPoster.areaDescription)}</title>
      <style>
        @page { size: letter; margin: 0.6in; }
        body { font-family: "EverydaySans", Arial, sans-serif; text-align: center; color: #000; margin: 0; }
        h1 { font-size: 40pt; margin: 0.2in 0 0.1in; }
        p.lead { font-size: 20pt; margin: 0 0 0.3in; }
        .qr { width: 5.2in; margin: 0 auto; }
        .area { font-size: 22pt; font-weight: bold; margin-top: 0.25in; }
        .store { font-size: 12pt; color: #444; }
      </style></head><body>
      <h1>Need help?</h1>
      <p class="lead">Scan with your phone camera and an associate is on the way.</p>
      <div class="qr">${qrSvg(lastPoster.url, 10)}</div>
      <div class="area">${esc(lastPoster.areaDescription)}</div>
      <div class="store">Store ${esc(lastPoster.store)}</div>
      </body></html>`);
    w.document.close();
    w.focus();
    w.print();
  });

  // ── Workvivo ───────────────────────────────────────────────────
  const WV_STATUS = {
    ready: "Ready", validation_warn: "Ready (last check warned)", needs_channel: "Needs a channel",
    needs_reauth: "Needs Workvivo sign-in", active: "Legacy posting",
  };

  async function loadWorkvivo() {
    flash("qc-loadMsg", "Loading Workvivo…");
    const r = await call("workvivo", { store: store() });
    if (disposed) return;
    if (!r.ok) { handleFail(r); return; }
    flash("qc-loadMsg", "");
    $("qc-wvMine").innerHTML = r.mine
      ? `${esc(WV_STATUS[r.mine.status] ?? r.mine.status ?? "Unknown")} · ${esc(r.mine.channelName || "no channel")} · last post ${fmtWhen(r.mine.lastServerPostAt)}${r.mine.lastServerPostOk === false ? " (failed)" : ""}`
      : "Not connected from any browser yet.";
    $("qc-wvAdmin").hidden = !r.connections;
    if (r.connections) {
      $("qc-wvStore").textContent = `store ${r.store}`;
      $("qc-wvRows").innerHTML = r.connections.map((c) => `<tr>
        <td>${esc(c.user?.firstName || "")}<div class="muted tiny">${esc(c.user?.email || "")}</div></td>
        <td>${esc(WV_STATUS[c.status] ?? c.status ?? "—")}</td>
        <td>${esc(c.channelName || "—")}</td>
        <td>${fmtWhen(c.lastServerPostAtMs)}${c.lastServerPostOk === false ? " (failed)" : ""}</td>
      </tr>`).join("") || `<tr><td colspan="4" class="muted">Nobody is posting for this store.</td></tr>`;
    }
  }

  await loadSession();

  return () => {
    disposed = true;
    link.remove();
  };
}
