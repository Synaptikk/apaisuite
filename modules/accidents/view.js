// modules/accidents/view.js
//
// Accident Details — shell page. Renders the cached pull from service.js:
// claim cards for everything on the evidence reports (summary, statements,
// evidence checklist) and the FY PNL charge table with credit-back flags.

const money = (n) => (n == null ? "–" : (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString());

const STATUS_LABEL = { complete: "✓", missing: "✗", partial: "…", unknown: "–" };
const EVIDENCE_COLS = [
  ["customerStatement", "Customer stmt"],
  ["witnessStatement",  "Witness stmt"],
  ["video",             "Video"],
  ["photos",            "Photos"],
  ["evidenceCollectionSheet", "Collection sheet"],
];

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

  const root = container.querySelector(".acc");
  const $ = (sel) => root.querySelector(sel);
  const els = {
    meta: $("#acc-meta"), progress: $("#acc-progress"), pull: $("#acc-pull"), signin: $("#acc-signin"),
    banner: $("#acc-banner"), tiles: $("#acc-tiles"), tabs: $("#acc-tabs"),
    claims: $("#acc-claims"), pnl: $("#acc-pnl"), pnlBody: $("#acc-pnl-body"),
    pnlCredits: $("#acc-pnl-credits"), pnlFy: $("#acc-pnl-fy"), empty: $("#acc-empty"),
    tOpen: $("#acc-t-open"), tMissing: $("#acc-t-missing"), tCharged: $("#acc-t-charged"), tCredit: $("#acc-t-credit"),
  };

  let state = null;    // { store, storeSource, data }
  let busy = false;

  function currentFy(refs) {
    const fys = [...new Set(refs.flatMap((r) => r.charges.map((c) => c.fy)))].sort().reverse();
    return fys;
  }

  // ── render ────────────────────────────────────────────────────

  function render() {
    const data = state?.data;
    if (!data) {
      els.empty.hidden = false; els.tiles.hidden = true; els.tabs.hidden = true;
      els.claims.innerHTML = ""; els.pnlBody.innerHTML = "";
      els.meta.textContent = state?.store ? `Store ${state.store}` : "No store set";
      return;
    }
    els.empty.hidden = true; els.tiles.hidden = false; els.tabs.hidden = false;
    els.meta.textContent = `Store ${data.store} · CAS data as of ${data.sourceUpdatedOn || "?"} · pulled ${new Date(data.capturedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;

    els.banner.hidden = !data.clearsight?.error;
    if (data.clearsight?.error) els.banner.textContent = data.clearsight.error;
    els.signin.hidden = data.clearsight?.signedIn !== false;

    // tiles
    const missing = data.evidence.filter((r) => r.missingCount > 0).length;
    const fys = currentFy(data.pnl.refs);
    const topFy = fys[0];
    let charged = 0, credited = 0;
    for (const c of data.pnl.charges) {
      if (c.fy !== topFy || c.amount == null) continue;
      if (c.amount >= 0) charged += c.amount; else credited += -c.amount;
    }
    els.tOpen.textContent = data.evidence.length;
    els.tMissing.textContent = missing;
    els.tCharged.textContent = money(charged);
    els.tCredit.textContent = money(credited);
    els.tMissing.classList.toggle("is-bad", missing > 0);

    renderClaims(data);
    renderPnl(data);
  }

  function renderClaims(data) {
    if (!data.evidence.length) {
      els.claims.innerHTML = `<div class="acc-empty">No claims in the evidence window right now.</div>`;
      return;
    }
    const cards = data.evidence
      .slice()
      .sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0))
      .map((rec) => claimCard(rec, data.claims[rec.referenceNbr]))
      .join("");
    els.claims.innerHTML = cards;
  }

  function claimCard(rec, detail) {
    const d = detail?.digest;
    const title = d
      ? `${esc(rec.referenceNbr)} — ${esc(d.claimant)}`
      : `${esc(rec.referenceNbr)} — ${esc(rec.claimant)}`;
    const badges = [
      `<span class="acc-badge">${esc(rec.reportType === "BodilyInjury" ? "Bodily injury" : "Garage Keeper / property damage")}</span>`,
      d?.status ? `<span class="acc-badge">${esc(d.status)}</span>` : "",
      `<span class="acc-badge ${rec.daysOpen >= 14 ? "is-bad" : ""}">${rec.daysOpen ?? "?"} days open</span>`,
      rec.missingCount ? `<span class="acc-badge is-bad">${rec.missingCount} evidence item${rec.missingCount > 1 ? "s" : ""} missing</span>` : `<span class="acc-badge is-ok">evidence complete</span>`,
    ].join("");

    const evRow = EVIDENCE_COLS.map(([k, label]) =>
      `<span class="acc-ev ${esc(rec[k])}" title="${esc(label)}">${STATUS_LABEL[rec[k]] || "–"} ${esc(label)}</span>`
    ).join("");

    let body;
    if (detail?.error) {
      body = `<div class="acc-note">Clearsight lookup failed: ${esc(detail.error)}</div>`;
    } else if (detail?.notFound) {
      body = `<div class="acc-note">Not found in Clearsight quick search.</div>`;
    } else if (d) {
      const checklist = detail.digest.evidence;
      const missingItems = checklist.items.filter((i) => !i.filled);
      body = `
        <div class="acc-summary">${esc(detail.summary).replace(/\n\n/g, "<br><br>")}</div>
        <div class="acc-check ${checklist.complete ? "is-ok" : ""}">
          <div class="acc-check-head">
            Evidence Collection (Clearsight): ${checklist.complete
              ? `completed ${esc(checklist.completedOn)}`
              : `${checklist.filled}/${checklist.total} fields filled — <strong>not completed</strong>`}
          </div>
          ${checklist.complete ? "" : `<ul class="acc-check-list">${missingItems.map((i) => `<li>${esc(i.label)}</li>`).join("")}</ul>`}
        </div>
        <div class="acc-detail-foot">
          ${d.caseManager?.name ? `Case manager: ${esc(d.caseManager.name)}${d.caseManager.email ? ` · <a href="mailto:${esc(d.caseManager.email)}">${esc(d.caseManager.email)}</a>` : ""}` : ""}
          ${detail.attachments != null ? ` · ${detail.attachments} attachment${detail.attachments === 1 ? "" : "s"}` : ""}
        </div>`;
    } else {
      body = `<div class="acc-note">No Clearsight detail (not signed in during the pull).</div>`;
    }

    const links = [
      detail?.claimUrl ? `<button class="acc-link" data-open="${esc(detail.claimUrl)}">Open in Clearsight</button>` : "",
      d?.claimEasyUrl ? `<button class="acc-link" data-open="${esc(d.claimEasyUrl)}">ClaimEasy Pro</button>` : "",
      rec.trackingNbr ? `<span class="acc-tracking">FedEx ${esc(rec.trackingNbr)}</span>` : "",
    ].join(" ");

    return `
      <article class="acc-card">
        <div class="acc-card-head">
          <div class="acc-card-title">${title}</div>
          <div class="acc-badges">${badges}</div>
        </div>
        <div class="acc-ev-row">${evRow}</div>
        ${body}
        <div class="acc-links">${links}</div>
      </article>`;
  }

  function renderPnl(data) {
    const fys = currentFy(data.pnl.refs);
    els.pnlFy.innerHTML = `<option value="">All FYs</option>` + fys.map((f) => `<option${f === fys[0] ? " selected" : ""}>${esc(f)}</option>`).join("");
    drawPnlRows(data);
  }

  function drawPnlRows(data) {
    const fy = els.pnlFy.value;
    const creditsOnly = els.pnlCredits.checked;
    const rows = data.pnl.refs
      .map((r) => {
        const charges = r.charges.filter((c) => !fy || c.fy === fy);
        if (!charges.length) return null;
        let charged = 0, credited = 0;
        for (const c of charges) { if (c.amount == null) continue; if (c.amount >= 0) charged += c.amount; else credited += -c.amount; }
        return { ...r, charged, credited, net: charged - credited, hasCredit: credited > 0 };
      })
      .filter(Boolean)
      .filter((r) => !creditsOnly || r.hasCredit)
      .sort((a, b) => b.net - a.net || b.charged - a.charged);

    els.pnlBody.innerHTML = rows.map((r) => {
      const det = data.refDetails?.[r.ref];
      return `
      <tr class="${r.hasCredit ? "has-credit" : ""}" data-ref="${esc(r.ref)}">
        <td>${esc(r.ref)}</td>
        <td>${esc(det?.digest?.claimant || r.claimant)}</td>
        <td>${esc(r.category)}</td>
        <td>${esc(det?.digest?.status || r.status)}</td>
        <td class="acc-num">${money(r.charged)}</td>
        <td class="acc-num ${r.credited ? "is-credit" : ""}">${r.credited ? money(-r.credited) : "–"}</td>
        <td class="acc-num">${money(r.net)}</td>
        <td>${det ? `<button class="acc-link" data-ref-show="${esc(r.ref)}">Summary</button>` : `<button class="acc-link" data-ref-load="${esc(r.ref)}">Load details</button>`}</td>
      </tr>
      ${det && !det.notFound ? `<tr class="acc-ref-detail" data-ref-detail="${esc(r.ref)}" hidden><td colspan="8">
          <div class="acc-summary">${esc(det.summary || "").replace(/\n\n/g, "<br><br>")}</div>
          ${det.claimUrl ? `<button class="acc-link" data-open="${esc(det.claimUrl)}">Open in Clearsight</button>` : ""}
        </td></tr>` : ""}`;
    }).join("") || `<tr><td colspan="8" class="acc-empty">No charge rows.</td></tr>`;
  }

  // ── data ──────────────────────────────────────────────────────

  async function refresh() {
    try {
      const res = await host.messaging.send("get_state", {});
      state = res?.data || {};
    } catch (e) {
      // SW may still be booting on a cold shell load — keep the empty state.
      state = state || {};
    }
    render();
  }

  async function pull() {
    if (busy) return;
    busy = true;
    els.pull.disabled = true;
    try {
      // pull returns { ok, data } itself — the SW dispatcher passes it
      // through unwrapped (send() rejects when ok is false).
      const res = await host.messaging.send("pull", { store: state?.store });
      state = state || {};
      state.data = res.data;
      render();
    } catch (e) {
      host.ui.toast(e.message || "Pull failed.", { kind: "error" });
    } finally {
      busy = false;
      els.pull.disabled = false;
      els.progress.textContent = "";
    }
  }

  // ── events ────────────────────────────────────────────────────

  els.pull.addEventListener("click", pull);
  els.signin.addEventListener("click", () => host.messaging.send("open_signin", {}));
  els.pnlCredits.addEventListener("change", () => state?.data && drawPnlRows(state.data));
  els.pnlFy.addEventListener("change", () => state?.data && drawPnlRows(state.data));

  els.tabs.addEventListener("click", (e) => {
    const tab = e.target.closest(".acc-tab");
    if (!tab) return;
    for (const t of els.tabs.querySelectorAll(".acc-tab")) t.classList.toggle("is-active", t === tab);
    els.claims.hidden = tab.dataset.tab !== "claims";
    els.pnl.hidden = tab.dataset.tab !== "pnl";
  });

  root.addEventListener("click", async (e) => {
    const open = e.target.closest("[data-open]");
    if (open) { host.messaging.send("open_claim", { claimUrl: open.dataset.open }); return; }
    const show = e.target.closest("[data-ref-show]");
    if (show) {
      const row = root.querySelector(`[data-ref-detail="${CSS.escape(show.dataset.refShow)}"]`);
      if (row) row.hidden = !row.hidden;
      return;
    }
    const load = e.target.closest("[data-ref-load]");
    if (load && !busy) {
      load.disabled = true; load.textContent = "Loading…";
      try {
        const res = await host.messaging.send("resolve_ref", { store: state.store, ref: load.dataset.refLoad });
        state.data.refDetails[load.dataset.refLoad] = res.detail;
        drawPnlRows(state.data);
      } catch (e) {
        host.ui.toast(e.message || "Lookup failed.", { kind: "error" });
        load.disabled = false; load.textContent = "Load details";
      }
    }
  });

  const unsubProgress = host.messaging.on("progress", (msg) => {
    els.progress.textContent = msg?.payload?.text || "";
  });

  await refresh();

  return () => {
    unsubProgress();
    link.remove();
  };
}
