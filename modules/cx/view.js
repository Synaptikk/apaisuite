// modules/cx/view.js
//
// Full-page mount for Cx.
//
// The page reads top to bottom as an argument: here is the graded number, here
// is what customers actually said, here is what moved, here is the evidence.
// The chips at the top scope everything below them, so the same page answers
// "how is the store doing" and "how is delivery dragging the store down"
// without being two pages.
//
// The heavy lifting is in the service worker: a year of comments is several MB
// and structured-cloning it into the page on every chip click is the slow part,
// so the view sends the filter selection and gets back a finished analysis.

import { escapeHtml, toast } from "../../shared/ui.js";
import { SUBSCORES } from "./lib/hoops.js";

/** Comments rendered per page in the evidence list. */
const COMMENT_PAGE = 30;

export async function mount(host, container) {
  container.innerHTML = await (await fetch(host.url("view.html"))).text();

  const $ = (sel) => container.querySelector(sel);
  const $$ = (sel) => [...container.querySelectorAll(sel)];

  // ── Local view state. Nothing derived lives here — `analysis` is whatever
  // the SW last returned, and every render reads from it.
  const state = {
    storeNbr: null,
    prefs: null,
    settings: null,
    analysis: null,
    coverage: null,
    scores: null,
    lastRun: null,
    openThemes: new Set(),
    commentQuery: "",
    commentRating: "",
    commentLimit: COMMENT_PAGE,
    busy: false,
  };

  const unsubscribers = [];

  // ── Messaging ─────────────────────────────────────────────────────────

  const send = (type, payload = {}) => host.messaging.send(type, payload);

  unsubscribers.push(
    host.messaging.on("cx.refresh.start", () => setBusy(true, "Reading…")),
    host.messaging.on("cx.refresh.progress", ({ fetched, total, page }) => {
      setBusy(true, `Comments: ${fmt(fetched)} of ${fmt(total)} (page ${page})`);
    }),
    host.messaging.on("cx.refresh.done", async ({ outcome }) => {
      state.lastRun = outcome;
      setBusy(false);
      await loadState();
      await loadAnalysis();
    }),
  );

  // ── Event wiring ──────────────────────────────────────────────────────

  host.ui.delegate(container, "click", "[data-action]", async (e, el) => {
    const action = el.dataset.action;
    switch (action) {
      case "refresh":        return doRefresh("incremental");
      case "refresh-full":   return doRefresh("full");
      case "open-settings":  return openSettings(true);
      case "close-settings": return openSettings(false);
      case "narrate":        return doNarrate(false);
      case "narrate-force":  return doNarrate(true);
      case "show-facts":     return showFacts();
      case "clear-journeys": return setFilter({ journeys: [] });
      case "clear-channels": return setFilter({ channels: [] });
      case "more-comments":  state.commentLimit += COMMENT_PAGE; return renderComments();
      case "export-comments":return exportComments();
      case "clear-history":  return clearHistory();
      case "copy-diagnostics": return copyDiagnostics();
      case "toggle-theme": {
        const id = el.dataset.themeId;
        if (state.openThemes.has(id)) state.openThemes.delete(id);
        else state.openThemes.add(id);
        return renderThemes();
      }
      default: return undefined;
    }
  });

  host.ui.delegate(container, "click", "[data-chip]", (e, el) => {
    const kind = el.dataset.chipKind;          // "journey" | "channel"
    const value = el.dataset.chip;
    const key = kind === "journey" ? "journeys" : "channels";
    const current = new Set(state.prefs[key] ?? []);
    if (current.has(value)) current.delete(value);
    else current.add(value);
    return setFilter({ [key]: [...current] });
  });

  const windowSelect = $("[data-window-select]");
  windowSelect?.addEventListener("change", () => setFilter({ windowDays: Number(windowSelect.value) }));

  const search = $("[data-comment-search]");
  search?.addEventListener("input", debounce(() => {
    state.commentQuery = search.value.trim().toLowerCase();
    state.commentLimit = COMMENT_PAGE;
    renderComments();
  }, 180));

  const ratingSelect = $("[data-comment-rating]");
  ratingSelect?.addEventListener("change", () => {
    state.commentRating = ratingSelect.value;
    state.commentLimit = COMMENT_PAGE;
    renderComments();
  });

  // Settings inputs write through on change rather than needing a Save — there
  // is nothing here that is only valid as a set.
  $("[data-setting-weeks]")?.addEventListener("change", (e) =>
    saveSettings({ windowWeeks: Number(e.target.value) }));
  $("[data-setting-model]")?.addEventListener("change", (e) =>
    saveSettings({ gatewayModel: e.target.value }));
  $("[data-setting-token]")?.addEventListener("change", (e) => {
    const value = e.target.value.trim();
    // Blank the field immediately: a pasted JWT should not sit visible in the
    // DOM, and the SW is the only thing that keeps it.
    e.target.value = "";
    if (value) saveSettings({ gatewayToken: value });
  });

  // ── Boot ──────────────────────────────────────────────────────────────

  await loadState();
  if (state.coverage?.count) await loadAnalysis();
  else renderEmpty();

  return function cleanup() {
    for (const off of unsubscribers) { try { off(); } catch { /* already gone */ } }
  };

  // ── Loaders ───────────────────────────────────────────────────────────

  async function loadState() {
    const s = await send("getState");
    state.storeNbr = s.storeNbr;
    state.prefs = s.prefs;
    state.settings = s.settings;
    state.scores = s.scores;
    state.coverage = s.coverage;
    state.lastRun = s.lastRun ?? state.lastRun;
    state.openThemes = new Set(s.prefs.openThemes ?? []);
    renderHeader();
    renderScorecard();
    renderGenAi();
    renderSettings();
    renderRunNote();
  }

  async function loadAnalysis() {
    const res = await send("analyze", {});
    if (!res?.ok) { renderEmpty(); return; }
    state.analysis = res.analysis;
    state.coverage = { ...state.coverage, ...res.coverage };
    renderFilters();
    renderThemes();
    renderMovement();
    renderTrend();
    renderComments();
    await renderNarrative();
    show("[data-columns]", true);
    show("[data-movement-panel]", true);
    show("[data-trend-panel]", true);
    show("[data-comments-panel]", true);
    show("[data-narrative-panel]", true);
  }

  async function setFilter(patch) {
    state.prefs = { ...state.prefs, ...patch };
    await send("setPrefs", { patch });
    state.commentLimit = COMMENT_PAGE;
    await loadAnalysis();
  }

  async function saveSettings(patch) {
    const res = await send("setSettings", { patch });
    if (res?.ok) {
      state.settings = res.settings;
      renderSettings();
      toast("Saved", { kind: "success" });
    }
  }

  async function doRefresh(mode) {
    if (state.busy) return;
    setBusy(true, mode === "full" ? "Full pull…" : "Refreshing…");
    try {
      await send("refresh", { mode });
    } catch (e) {
      setBusy(false);
      toast(`Refresh failed: ${e?.message ?? e}`, { kind: "error" });
    }
  }

  async function doNarrate(force) {
    const body = $("[data-narrative-body]");
    body.innerHTML = `<p class="cx-empty">Writing…</p>`;
    const res = await send("narrate", { force });
    if (!res?.ok) {
      body.innerHTML = `<p class="cx-error">${escapeHtml(res?.error ?? "The written read is unavailable.")}</p>`
        + (res?.reason === "TOKEN" || res?.reason === "EXPIRED"
          ? `<p class="cx-note">Paste a current token under <strong>Settings</strong>. Everything else on this page works without it.</p>`
          : "");
      return;
    }
    state.narrative = res.narrative;
    await renderNarrative();
  }

  async function clearHistory() {
    if (!confirm("Drop the stored comment history? The next Refresh pulls the whole window again.")) return;
    await send("clearHistory");
    state.analysis = null;
    state.coverage = null;
    await loadState();
    renderEmpty();
    toast("Comment history cleared", { kind: "info" });
  }

  // ── Renderers ─────────────────────────────────────────────────────────

  function renderHeader() {
    $("[data-store-label]").textContent = state.storeNbr ? `Store ${state.storeNbr}` : "No home store set";

    const f = $("[data-freshness]");
    if (!state.coverage?.count) { f.textContent = "no comments pulled yet"; f.className = "cx-freshness"; return; }
    const age = Date.now() - (state.coverage.pulledAt ?? 0);
    f.textContent = `${fmt(state.coverage.count)} comments · ${state.coverage.from} to ${state.coverage.to} · read ${relTime(age)}`;
    // A day is fine here: comments land hours after the visit and the graded
    // week rolls weekly, so "this morning" is current.
    f.className = `cx-freshness${age > 36 * 3600_000 ? " cx-stale" : ""}`;
  }

  function renderScorecard() {
    const row = $("[data-score-row]");
    const nps = state.scores?.nps;
    if (!nps?.periods?.length) {
      row.innerHTML = `<p class="cx-empty">Click Refresh to read the scorecard.</p>`;
      $("[data-scores-stamp]").textContent = "—";
      return;
    }

    $("[data-scores-stamp]").textContent = `read ${relTime(Date.now() - (state.scores.pulledAt ?? 0))}`;

    const periods = nps.periods.filter((p) => p.ty != null);
    const latest = periods[periods.length - 1] ?? null;
    const prior = periods[periods.length - 2] ?? null;

    const sub = state.scores.subscores?.periods ?? [];
    const latestSub = [...sub].reverse().find((p) => Object.values(p.scores).some((s) => s.ty != null)) ?? null;

    const tiles = [];

    // NPS leads and is given more room than the sub-scores: it is the graded
    // number, and it is the one with a last-year line to compare against.
    if (latest) {
      tiles.push(`
        <div class="cx-tile cx-tile-hero">
          <div class="cx-tile-label">NPS <span class="cx-tile-period">${escapeHtml(latest.labelLong ?? latest.label)}</span></div>
          <div class="cx-tile-value">${latest.ty}</div>
          <div class="cx-tile-meta">
            ${deltaChip(latest.ty, prior?.ty, "vs last week", { higherIsBetter: true })}
            ${deltaChip(latest.ty, latest.ly, "vs last year", { higherIsBetter: true })}
          </div>
          ${sparkline(periods)}
        </div>`);
    }

    for (const def of SUBSCORES) {
      const cur = latestSub?.scores?.[def.key];
      if (!cur || cur.ty == null) continue;
      tiles.push(`
        <div class="cx-tile cx-scope-${def.scope}">
          <div class="cx-tile-label">${escapeHtml(def.label)}</div>
          <div class="cx-tile-value cx-tile-value-sm">${cur.ty.toFixed(2)}</div>
          <div class="cx-tile-meta">${deltaChip(cur.ty, cur.ly, "vs LY", { higherIsBetter: true, decimals: 2 })}</div>
        </div>`);
    }

    row.innerHTML = tiles.join("")
      + `<p class="cx-note cx-scorecard-note">
           From the Hoops scorecard for ${escapeHtml(latestSub?.labelLong ?? "the current week")}.
           Sub-scores are averages out of 5. NPS is published weekly only.
         </p>`;
  }

  function renderFilters() {
    const wrap = $("[data-filters]");
    if (!state.analysis) { wrap.hidden = true; return; }
    wrap.hidden = false;

    const a = state.analysis;
    $("[data-journey-chips]").innerHTML = chipRow(a.facets.journeys, state.prefs.journeys, "journey");
    $("[data-channel-chips]").innerHTML = chipRow(a.facets.channels, state.prefs.channels, "channel");
    windowSelect.value = String(state.prefs.windowDays);

    const scoped = (state.prefs.journeys?.length || state.prefs.channels?.length);
    $("[data-filter-meta]").innerHTML = scoped
      ? `Showing <strong>${fmt(a.counts.filtered)}</strong> of ${fmt(a.counts.all)} comments`
        + ` (${escapeHtml(a.counts.firstDay ?? "?")} to ${escapeHtml(a.counts.lastDay ?? "?")}).`
      : `All <strong>${fmt(a.counts.all)}</strong> comments`
        + ` (${escapeHtml(a.counts.firstDay ?? "?")} to ${escapeHtml(a.counts.lastDay ?? "?")}).`;
  }

  function chipRow(facets, selected, kind) {
    const sel = new Set(selected ?? []);
    return facets.map((f) => `
      <button class="cx-chip${sel.has(f.value) ? " is-on" : ""}"
              data-chip="${escapeHtml(f.value)}" data-chip-kind="${kind}"
              aria-pressed="${sel.has(f.value)}">
        ${escapeHtml(f.value)} <span class="cx-chip-count">${fmt(f.count)}</span>
      </button>`).join("");
  }

  function renderThemes() {
    const a = state.analysis;
    if (!a) return;

    const tagged = a.themes.taggedCount;
    const total = a.counts.filtered;
    // Said plainly rather than buried: the theme lists describe under half the
    // comments, and a reader who assumes otherwise will over-read a small row.
    const coverage = `${fmt(tagged)} of ${fmt(total)} comments carry topic tags`;

    $("[data-bad-sub]").textContent = coverage;
    $("[data-good-sub]").textContent = coverage;

    $("[data-bad-themes]").innerHTML = a.themes.negative.length
      ? a.themes.negative.map((t) => themeCard(t, "negative")).join("")
      : `<p class="cx-empty">No negative themes in this selection.</p>`;

    $("[data-good-themes]").innerHTML = a.themes.positive.length
      ? a.themes.positive.map((t) => themeCard(t, "positive")).join("")
      : `<p class="cx-empty">No positive themes in this selection.</p>`;
  }

  function themeCard(theme, side) {
    const open = state.openThemes.has(theme.themeId + ":" + side);
    const count = side === "negative" ? theme.negative : theme.positive;
    const other = side === "negative" ? theme.positive : theme.negative;
    const examples = theme.examples[side] ?? [];

    // The bar is share of this theme's OPINIONATED mentions, so a theme
    // mentioned neutrally does not read as half-bad.
    const share = theme.negativeShare;
    const barPct = share == null ? 0 : Math.round(share * 100);

    return `
      <article class="cx-theme${open ? " is-open" : ""} cx-scope-${theme.scope}">
        <button class="cx-theme-head" data-action="toggle-theme" data-theme-id="${escapeHtml(theme.themeId + ":" + side)}"
                aria-expanded="${open}">
          <span class="cx-theme-count">${fmt(count)}</span>
          <span class="cx-theme-name">
            ${escapeHtml(theme.label)}
            <span class="cx-theme-scope" title="${escapeHtml(scopeBlurb(theme.scope))}">${escapeHtml(theme.scope)}</span>
          </span>
          <span class="cx-theme-split" title="${barPct}% of opinions about this were negative">
            <span class="cx-theme-bar"><span style="width:${barPct}%"></span></span>
            <span class="cx-theme-splitnum">${side === "negative" ? `${barPct}% neg` : `${fmt(other)} neg`}</span>
          </span>
          <span class="cx-theme-caret" aria-hidden="true"></span>
        </button>
        ${open ? `
        <div class="cx-theme-body">
          <p class="cx-theme-blurb">${escapeHtml(theme.blurb)}</p>
          <table class="cx-topic-table">
            <thead><tr><th>Topic</th><th>Mentions</th><th>Good</th><th>Bad</th></tr></thead>
            <tbody>
              ${theme.topics.map((t) => `
                <tr>
                  <td>${escapeHtml(t.label)}</td>
                  <td>${fmt(t.mentions)}</td>
                  <td class="cx-num-good">${fmt(t.positive)}</td>
                  <td class="cx-num-bad">${fmt(t.negative)}</td>
                </tr>`).join("")}
            </tbody>
          </table>
          ${examples.length ? `
            <h4 class="cx-quotes-head">In their words</h4>
            <ul class="cx-quotes">
              ${examples.map((ex) => `
                <li>
                  <span class="cx-quote-meta">${escapeHtml(ex.day ?? "")} · ${escapeHtml(ex.journey ?? "—")} · ${starLabel(ex.score)}</span>
                  <span class="cx-quote-text">${escapeHtml(ex.text)}</span>
                </li>`).join("")}
            </ul>` : ""}
        </div>` : ""}
      </article>`;
  }

  function renderMovement() {
    const m = state.analysis?.movement;
    if (!m?.recent) { show("[data-movement-panel]", false); return; }

    $("[data-movement-sub]").textContent =
      `${m.recent.from} to ${m.recent.to} (${fmt(m.recent.count)} comments)`
      + ` vs ${m.prior.from} to ${m.prior.to} (${fmt(m.prior.count)})`;

    const rows = m.movers.filter((x) => x.direction !== "flat" || !x.thin);
    $("[data-movers]").innerHTML = rows.length
      ? rows.map((x) => `
        <div class="cx-mover cx-mover-${x.direction}${x.thin ? " is-thin" : ""}">
          <span class="cx-mover-dir" aria-hidden="true">${x.direction === "worse" ? "▲" : x.direction === "better" ? "▼" : "–"}</span>
          <span class="cx-mover-name">
            ${escapeHtml(x.label)}
            ${x.thin ? `<span class="cx-mover-thin" title="Too few mentions in either window to read anything into">thin</span>` : ""}
          </span>
          <span class="cx-mover-rates">
            ${x.priorRate.toFixed(1)} → <strong>${x.recentRate.toFixed(1)}</strong>
            <span class="cx-mover-unit">neg per 100</span>
          </span>
          <span class="cx-mover-delta">${x.deltaRate > 0 ? "+" : ""}${x.deltaRate.toFixed(1)}</span>
          <span class="cx-mover-counts">${fmt(x.priorNegative)} → ${fmt(x.recentNegative)} mentions</span>
        </div>`).join("")
      : `<p class="cx-empty">Nothing moved enough to report in this selection.</p>`;
  }

  function renderTrend() {
    const weekly = state.analysis?.weekly ?? [];
    if (!weekly.length) { show("[data-trend-panel]", false); return; }

    $("[data-trend-sub]").textContent = `${weekly.length} weeks · bar height is comment volume`;

    const max = Math.max(...weekly.map((w) => w.scored || 0), 1);
    // A stacked bar rather than a line: the interesting thing about this store's
    // feedback is the 1-vs-5 barbell, which a mean or a single line hides.
    $("[data-trend-chart]").innerHTML = `
      <div class="cx-bars" role="img" aria-label="Weekly rating mix">
        ${weekly.map((w) => {
          const det = w.bands.detractor, pas = w.bands.passive, pro = w.bands.promoter;
          const h = Math.max(2, Math.round((w.scored / max) * 100));
          const seg = (n) => (w.scored ? (n / w.scored) * 100 : 0);
          return `
            <div class="cx-bar-col" title="${escapeHtml(w.weekStart)} · ${fmt(w.scored)} rated · ${fmt(pro)} promoters, ${fmt(pas)} passive, ${fmt(det)} detractors · comment NPS ${w.commentNps ?? "—"}">
              <div class="cx-bar" style="height:${h}%">
                <span class="cx-seg cx-seg-pro" style="height:${seg(pro)}%"></span>
                <span class="cx-seg cx-seg-pas" style="height:${seg(pas)}%"></span>
                <span class="cx-seg cx-seg-det" style="height:${seg(det)}%"></span>
              </div>
              <span class="cx-bar-label">${escapeHtml(w.weekStart.slice(5))}</span>
            </div>`;
        }).join("")}
      </div>
      <div class="cx-legend">
        <span><i class="cx-key cx-seg-pro"></i>5 stars</span>
        <span><i class="cx-key cx-seg-pas"></i>4 stars</span>
        <span><i class="cx-key cx-seg-det"></i>1-3 stars</span>
        <span class="cx-legend-note">
          Comment NPS over this selection: <strong>${state.analysis.ratings.commentNps ?? "—"}</strong>
          — computed from these ${fmt(state.analysis.ratings.scored)} ratings, not the graded NPS above.
        </span>
      </div>`;
  }

  function renderComments() {
    const a = state.analysis;
    if (!a) return;

    // The evidence list works off the theme examples the SW already sent rather
    // than shipping a year of comments into the page. That is a real limit and
    // the footer says so instead of implying the list is everything.
    const pool = new Map();
    for (const t of a.themes.all) {
      for (const side of ["negative", "positive", "neutral"]) {
        for (const ex of t.examples[side] ?? []) {
          if (!pool.has(ex.id)) pool.set(ex.id, { ...ex, themes: [] });
          pool.get(ex.id).themes.push(t.label);
        }
      }
    }

    let rows = [...pool.values()];
    if (state.commentQuery) {
      rows = rows.filter((r) => r.text.toLowerCase().includes(state.commentQuery));
    }
    if (state.commentRating === "detractor") rows = rows.filter((r) => r.score >= 1 && r.score <= 3);
    else if (state.commentRating) rows = rows.filter((r) => r.score === Number(state.commentRating));

    rows.sort((x, y) => (x.day < y.day ? 1 : x.day > y.day ? -1 : 0));

    const page = rows.slice(0, state.commentLimit);
    $("[data-comments-sub]").textContent =
      `${fmt(rows.length)} quoted comments across ${fmt(a.themes.all.length)} themes`;

    $("[data-comment-list]").innerHTML = page.length
      ? page.map((r) => `
        <article class="cx-comment cx-rating-${r.score ?? 0}">
          <div class="cx-comment-meta">
            <span class="cx-comment-stars">${starLabel(r.score)}</span>
            <span>${escapeHtml(r.day ?? "")}</span>
            <span>${escapeHtml(r.journey ?? "—")}</span>
            <span class="cx-comment-themes">${r.themes.map((t) => `<em>${escapeHtml(t)}</em>`).join(" ")}</span>
          </div>
          <p class="cx-comment-text">${escapeHtml(r.text)}</p>
        </article>`).join("")
      : `<p class="cx-empty">No quoted comments match.</p>`;

    $("[data-more-comments], .cx-more").hidden = page.length >= rows.length;
  }

  async function renderNarrative() {
    const body = $("[data-narrative-body]");
    const stamp = $("[data-narrative-stamp]");
    const n = state.narrative;

    $("[data-action='narrate-force']").hidden = !n;
    $("[data-action='show-facts']").hidden = !n;

    if (!n) {
      const st = state.settings?.gatewayTokenStatus;
      if (st && !st.ok) {
        body.innerHTML = `<p class="cx-note">
          The written read needs an AI gateway token — ${escapeHtml(st.reason === "expired" ? "the stored one has expired" : "none is set")}.
          Add one under <strong>Settings</strong>. Everything else on this page works without it.
        </p>`;
      }
      stamp.textContent = "";
      return;
    }

    stamp.textContent = `${n.model ?? ""} · ${relTime(Date.now() - (n.generatedAt ?? Date.now()))}`;
    body.innerHTML = renderMarkdown(n.text);
  }

  function showFacts() {
    const facts = state.narrative?.facts;
    if (!facts) return;
    host.ui.modal?.({
      title: "What was sent to the gateway",
      body: `<p class="cx-note">These are the figures already on this page, plus the quotes shown under each theme.
               No token, and nothing the panel is not already displaying.</p>
             <pre class="cx-facts">${escapeHtml(JSON.stringify(facts, null, 1))}</pre>`,
    }) ?? toast("Facts are in the console", { kind: "info" });
    if (!host.ui.modal) console.log("[cx] narrative facts", facts);
  }

  function renderGenAi() {
    const g = state.scores?.genAi;
    const panel = $("[data-genai-panel]");
    if (!g?.summary) { panel.hidden = true; return; }
    panel.hidden = false;

    const when = g.generatedAt ? String(g.generatedAt).slice(0, 10) : "unknown date";
    const ageDays = g.generatedAt ? Math.round((Date.now() - Date.parse(g.generatedAt)) / 86_400_000) : null;

    // Dated loudly on purpose: the copy Hoops serves has been frozen since
    // January, and read as current it would contradict everything above.
    $("[data-genai-stamp]").textContent =
      `generated ${when}${ageDays != null && ageDays > 45 ? ` — ${ageDays} days old` : ""}`;

    const s = g.summary;
    $("[data-genai-body]").innerHTML = `
      <p class="cx-note">
        The Ops Portal's own summary of this store's comments. Shown for reference only:
        Walmart regenerates it rarely${ageDays != null && ageDays > 45 ? `, and this copy is ${ageDays} days old` : ""},
        so the panels above are the current read.
      </p>
      ${s.brief ? `<p class="cx-genai-brief">${escapeHtml(s.brief)}</p>` : ""}
      ${s.suggestions?.length ? `
        <h4>Its suggestions</h4>
        <ul class="cx-genai-list">${s.suggestions.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>` : ""}`;
  }

  function renderSettings() {
    const s = state.settings;
    if (!s) return;
    const weeks = $("[data-setting-weeks]");
    if (weeks) weeks.value = String(s.windowWeeks);
    const model = $("[data-setting-model]");
    if (model) model.value = s.gatewayModel;

    const st = s.gatewayTokenStatus ?? { ok: false, reason: "missing" };
    const el = $("[data-token-status]");
    if (!el) return;
    if (!s.gatewayTokenSet) { el.textContent = "not set"; el.className = "cx-token-status"; return; }
    if (st.reason === "expired") { el.textContent = "expired — paste a fresh one"; el.className = "cx-token-status is-bad"; return; }
    const exp = st.expiresAt ? new Date(st.expiresAt).toISOString().slice(0, 10) : null;
    el.textContent = exp ? `set · expires ${exp}` : "set";
    el.className = `cx-token-status${st.reason === "expiring" ? " is-warn" : " is-ok"}`;
  }

  function renderRunNote() {
    const note = $("[data-run-note]");
    const r = state.lastRun;
    if (!r) { note.hidden = true; return; }

    const parts = [];
    if (r.reason === "NO_STORE") parts.push(`<strong>No home store set.</strong> ${escapeHtml(r.error)}`);
    if (r.hoops?.ok) parts.push(`Scorecard: ${r.hoops.weeks} weeks.`);
    else if (r.hoops) parts.push(`<strong>Scorecard failed</strong> (${escapeHtml(r.hoops.errorClass)}): ${escapeHtml(r.hoops.error)}`);

    if (r.medallia?.ok) {
      parts.push(r.medallia.added
        ? `Comments: ${fmt(r.medallia.added)} new, ${fmt(r.medallia.held)} held.`
        : `Comments: nothing new, ${fmt(r.medallia.held)} held.`);
    } else if (r.medallia) {
      parts.push(`<strong>Comments failed</strong> (${escapeHtml(r.medallia.errorClass)}): ${escapeHtml(r.medallia.error)}`);
      if (r.fallbackComments?.ok) {
        parts.push(`Fell back to the Ops Portal's 50-comment feed — no topic tags, and about a week behind.`);
      }
    }

    note.innerHTML = parts.join(" ");
    note.hidden = !parts.length;
    note.className = `cx-runnote${r.ok === false ? " is-bad" : r.hoops?.ok === false || r.medallia?.ok === false ? " is-warn" : ""}`;

    const failed = r.hoops?.ok === false || r.medallia?.ok === false;
    show("[data-debug-panel]", failed);
    if (failed) {
      $("[data-debug-body]").innerHTML = `<pre class="cx-facts">${escapeHtml(JSON.stringify(r, null, 1))}</pre>`;
    }
  }

  function renderEmpty() {
    show("[data-columns]", false);
    show("[data-movement-panel]", false);
    show("[data-trend-panel]", false);
    show("[data-comments-panel]", false);
    show("[data-filters]", false);
    const body = $("[data-narrative-body]");
    if (body) {
      body.innerHTML = `<p class="cx-empty">
        Click <strong>Refresh</strong> to read the scorecard and pull this store's comments.
        The first pull covers ${state.settings?.windowWeeks ?? 52} weeks and takes a couple of minutes;
        it opens a background Medallia tab to borrow your signed-in session.
      </p>`;
    }
    show("[data-narrative-panel]", true);
  }

  // ── Small helpers ─────────────────────────────────────────────────────

  function setBusy(busy, label = null) {
    state.busy = busy;
    const btn = $("[data-action='refresh']");
    btn.disabled = busy;
    $("[data-action='refresh-full']").disabled = busy;
    btn.querySelector(".btn-spinner").hidden = !busy;
    btn.querySelector(".btn-label").textContent = busy ? (label ?? "Working…") : "Refresh";
  }

  function show(sel, visible) {
    const el = $(sel);
    if (el) el.hidden = !visible;
  }

  async function exportComments() {
    const a = state.analysis;
    if (!a) return;
    const rows = [["day", "journey", "rating", "themes", "comment"]];
    for (const t of a.themes.all) {
      for (const side of ["negative", "positive", "neutral"]) {
        for (const ex of t.examples[side] ?? []) {
          rows.push([ex.day ?? "", ex.journey ?? "", ex.score ?? "", t.label, ex.text ?? ""]);
        }
      }
    }
    const csv = rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" }));
    const a2 = document.createElement("a");
    a2.href = url;
    a2.download = `cx-comments-${state.storeNbr ?? "store"}-${a.counts.lastDay ?? "latest"}.csv`;
    a2.click();
    URL.revokeObjectURL(url);
  }

  async function copyDiagnostics() {
    const payload = {
      storeNbr: state.storeNbr,
      coverage: state.coverage,
      prefs: state.prefs,
      // Redacted by construction — the SW never hands the token to the view.
      settings: state.settings,
      lastRun: state.lastRun,
    };
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 1));
    toast("Diagnostics copied", { kind: "success" });
  }

  function openSettings(open) {
    show("[data-settings-panel]", open);
    if (open) $("[data-settings-panel]").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

// ── Pure formatting ───────────────────────────────────────────────────────

function deltaChip(now, then, label, { higherIsBetter = true, decimals = 0 } = {}) {
  if (now == null || then == null) return `<span class="cx-delta is-none">${escapeHtml(label)} n/a</span>`;
  const d = now - then;
  const good = higherIsBetter ? d > 0 : d < 0;
  const cls = Math.abs(d) < (decimals ? 0.005 : 0.5) ? "is-flat" : good ? "is-good" : "is-bad";
  const sign = d > 0 ? "+" : d < 0 ? "−" : "";
  return `<span class="cx-delta ${cls}">${sign}${Math.abs(d).toFixed(decimals)} <em>${escapeHtml(label)}</em></span>`;
}

/**
 * Inline sparkline of the NPS weeks, this year solid and last year dashed.
 * Inline SVG so it inherits the theme's chart tokens rather than carrying hexes.
 */
function sparkline(periods) {
  const pts = periods.filter((p) => p.ty != null);
  if (pts.length < 3) return "";
  const W = 180, H = 40, pad = 3;
  const values = pts.flatMap((p) => [p.ty, p.ly].filter((v) => v != null));
  const lo = Math.min(...values), hi = Math.max(...values);
  const span = hi - lo || 1;
  const x = (i) => pad + (i / (pts.length - 1)) * (W - pad * 2);
  const y = (v) => H - pad - ((v - lo) / span) * (H - pad * 2);
  const path = (key) => pts
    .map((p, i) => (p[key] == null ? null : `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`))
    .filter(Boolean).join(" ");

  return `
    <svg class="cx-spark" viewBox="0 0 ${W} ${H}" role="img"
         aria-label="NPS over ${pts.length} weeks, this year against last year">
      <path class="cx-spark-ly" d="${path("ly")}" fill="none"/>
      <path class="cx-spark-ty" d="${path("ty")}" fill="none"/>
      <circle class="cx-spark-dot" cx="${x(pts.length - 1).toFixed(1)}" cy="${y(pts[pts.length - 1].ty).toFixed(1)}" r="2.5"/>
    </svg>
    <div class="cx-spark-key">
      <span><i class="cx-key cx-key-ty"></i>this year</span>
      <span><i class="cx-key cx-key-ly"></i>last year</span>
      <span>${escapeHtml(pts[0].label)} → ${escapeHtml(pts[pts.length - 1].label)}</span>
    </div>`;
}

/**
 * The narrative comes back as markdown with a known, small shape (## headings,
 * - bullets, **bold**). Rendered here rather than with a vendored parser: the
 * input is one prompt's worth of text from one endpoint, and everything is
 * escaped before any tag is added, so no markup from the model reaches the DOM.
 */
function renderMarkdown(text) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  let inList = false;

  const inline = (s) => escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|\s)\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");

  const closeList = () => { if (inList) { out.push("</ul>"); inList = false; } };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { closeList(); continue; }

    const h = /^(#{2,4})\s+(.*)$/.exec(line);
    if (h) { closeList(); const lvl = Math.min(h[1].length + 1, 5); out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`); continue; }

    const li = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (li) { if (!inList) { out.push('<ul class="cx-md-list">'); inList = true; } out.push(`<li>${inline(li[1])}</li>`); continue; }

    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ol) { if (!inList) { out.push('<ul class="cx-md-list">'); inList = true; } out.push(`<li>${inline(ol[1])}</li>`); continue; }

    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join("");
}

function starLabel(score) {
  if (!score) return "—";
  return `${"★".repeat(score)}${"☆".repeat(5 - score)}`;
}

function scopeBlurb(scope) {
  switch (scope) {
    case "store":   return "The store floor controls this.";
    case "digital": return "The digital / OPD operation controls this.";
    default:        return "A judgement about Walmart at large — a store cannot coach this away.";
  }
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString());

function relTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
