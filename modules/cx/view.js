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
import { withWeekday } from "../../shared/dates.js";
import { SUBSCORES } from "./lib/hoops.js";
import { generateCxPdf } from "./lib/report.js";

/** Comments rendered per page in the evidence list. */
const COMMENT_PAGE = 30;

export async function mount(host, container) {
  // Inject the module stylesheet and WAIT for it. The shell's app.html links
  // only the suite-wide sheets, so a module that skips this renders as a plain
  // vertical stack of text — which is exactly what the first end-to-end run
  // produced. Awaiting matters as much as injecting: without it the first paint
  // lands before the sheet applies and the grids lay out as blocks until
  // something forces a reflow. (Same shape as digitalrollup and vizpick.)
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = host.url("styles.css");
  link.dataset.module = host.id;
  const cssReady = new Promise((resolve) => {
    if (link.sheet) return resolve();
    link.addEventListener("load", resolve, { once: true });
    // Never block the module on a missing stylesheet — unstyled beats absent.
    link.addEventListener("error", resolve, { once: true });
    setTimeout(resolve, 3000);
  });
  document.head.appendChild(link);
  await cssReady;

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
    market: null,
    // Hoops' 50-row stopgap, present only when Medallia could not be read.
    fallback: null,
    lastRun: null,
    openThemes: new Set(),
    commentQuery: "",
    commentRating: "",
    commentLimit: COMMENT_PAGE,
    commentTotal: 0,
    busy: false,
  };

  const unsubscribers = [];

  // ── Messaging ─────────────────────────────────────────────────────────

  // sendRaw, not send: several handlers here answer `{ ok: false, reason }` as
  // flow control ("no data yet", "no gateway token"), and `send` REJECTS on a
  // falsy `ok`. Those are states the panel renders, not exceptions.
  //
  // The timeout matters too: a full 52-week pull is eight Medallia requests over
  // roughly two minutes, and sendRaw's default 60 s would abandon it half way.
  const TIMEOUTS = { refresh: 600_000, narrate: 180_000 };
  const send = (type, payload = {}) =>
    host.messaging.sendRaw(type, payload, { timeoutMs: TIMEOUTS[type] ?? 60_000 });

  unsubscribers.push(
    host.messaging.on("refresh_start", () => setBusy(true, "Reading…")),
    host.messaging.on("market_progress", ({ done, total, store }) => {
      const el = $("[data-market-sub]");
      if (el) el.textContent = `reading store ${store} — ${done} of ${total}`;
    }),
    // The Hoops half lands seconds into a pull while Medallia takes minutes, so
    // the scorecard paints as soon as it is there.
    host.messaging.on("scores_ready", () => { void loadState(); }),
    host.messaging.on("signin_stage", ({ stage }) => {
      const el = $("[data-token-status]");
      if (!el) return;
      el.textContent = stage === "waiting" ? "finish the sign-in in the tab that opened…" : "opening sign-in…";
      el.className = "cx-token-status";
    }),
    host.messaging.on("refresh_progress", ({ fetched, total, page }) => {
      setBusy(true, `Comments: ${fmt(fetched)} of ${fmt(total)} (page ${page})`);
    }),
    host.messaging.on("refresh_done", async ({ outcome }) => {
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
      case "pull-market":    return doPullMarket();
      case "signin-gateway": return doSignIn();
      case "signout-gateway":return doSignOut();
      case "export-pdf":     return doExportPdf();
      case "toggle-theme": {
        const id = el.dataset.themeId;
        if (state.openThemes.has(id)) state.openThemes.delete(id);
        else state.openThemes.add(id);
        renderThemes();
        // Persisted so a theme left open survives a route change — the drilled-in
        // topic table is usually what someone came back to look at again.
        return send("setPrefs", { patch: { openThemes: [...state.openThemes] } });
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
    void renderComments();
  }, 180));

  const ratingSelect = $("[data-comment-rating]");
  ratingSelect?.addEventListener("change", () => {
    state.commentRating = ratingSelect.value;
    state.commentLimit = COMMENT_PAGE;
    void renderComments();
  });

  // Settings inputs write through on change rather than needing a Save — there
  // is nothing here that is only valid as a set.
  $("[data-setting-weeks]")?.addEventListener("change", (e) =>
    saveSettings({ windowWeeks: Number(e.target.value) }));
  $("[data-setting-model]")?.addEventListener("change", (e) =>
    saveSettings({ gatewayModel: e.target.value }));
  $("[data-setting-version]")?.addEventListener("change", (e) =>
    saveSettings({ gatewayClientVersion: e.target.value.trim() }));
  // Reading a file the user explicitly picked is the one filesystem route an
  // extension has — there is no API for opening a path itself. The file is
  // parsed in the page and only the token is forwarded; the rest of puppy.cfg
  // (names, model choice, colours) is never looked at or stored.
  $("[data-setting-cfg]")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";                 // allow re-picking the same file
    if (!file) return;
    const status = $("[data-token-status]");
    try {
      const text = await file.text();
      // INI, [puppy] section, key `puppy_token` — confirmed against the real file.
      const token = /^\s*puppy_token\s*=\s*(.+?)\s*$/m.exec(text)?.[1];
      if (!token) {
        status.textContent = "no puppy_token in that file";
        status.className = "cx-token-status is-bad";
        return;
      }
      await saveSettings({ gatewayToken: token });
    } catch (err) {
      status.textContent = `could not read that file: ${err?.message ?? err}`;
      status.className = "cx-token-status is-bad";
    }
  });

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
    // The shell unmounts the container but does not touch <head>; without this
    // the sheet stacks up again on every route back into the module.
    link.remove();
  };

  // ── Loaders ───────────────────────────────────────────────────────────

  async function loadState() {
    const [s, m] = await Promise.all([send("getState"), send("getMarket")]);
    state.market = m?.market ?? state.market;
    state.storeNbr = s.storeNbr;
    state.prefs = s.prefs;
    state.settings = s.settings;
    state.scores = s.scores;
    state.coverage = s.coverage;
    state.fallback = s.fallback ?? null;
    state.lastRun = s.lastRun ?? state.lastRun;
    state.openThemes = new Set(s.prefs.openThemes ?? []);
    renderHeader();
    renderScorecard();
    renderMarket();
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
    await renderComments();
    // Rehydrate from the cache before painting: the read is stored in the
    // service worker, and without this the panel showed it while the PDF
    // silently left it out after any remount.
    const cached = await send("getNarrative", {});
    state.narrative = cached?.narrative ?? null;
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
    if (!res?.ok) return;
    state.settings = res.settings;
    renderSettings();
    // The narrative panel's placeholder is written from the token status, so it
    // has to be repainted here too — otherwise pasting a token leaves "none is
    // set" sitting on screen, which reads as the paste having failed.
    await renderNarrative();
    toast("Saved", { kind: "success" });
  }

  async function doRefresh(mode) {
    if (state.busy) return;
    setBusy(true, mode === "full" ? "Full pull…" : "Refreshing…");
    try {
      const outcome = await send("refresh", { mode });
      // Normally `refresh_done` clears the button and repaints. Some early
      // returns (no home store set) bail before any broadcast, so clear here
      // too rather than leaving the button spinning forever.
      if (!outcome?.ok) {
        state.lastRun = outcome ?? state.lastRun;
        renderRunNote();
      }
    } catch (e) {
      toast(`Refresh failed: ${e?.message ?? e}`, { kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function doNarrate(force) {
    const body = $("[data-narrative-body]");
    body.innerHTML = `<p class="cx-empty">Writing…</p>`;
    const res = await send("narrate", { force });
    if (!res?.ok) {
      body.innerHTML = `<p class="cx-error">${escapeHtml(res?.error ?? "The written read is unavailable.")}</p>`
        + (res?.reason === "TOKEN" || res?.reason === "EXPIRED"
          ? `<p class="cx-note">Use <strong>Settings → Sign in</strong> to get a current token. Everything else on this page works without it.</p>`
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

    // Hoops' pivotRows carry the same figures at month / quarter / year for the
    // current period, at no extra request. They matter here because the LAST WEEK
    // in the series is the week in progress, and on a single store that is a
    // handful of surveys — 4.12 on eleven responses reads like a collapse next to
    // last year's 4.65. Every tile therefore shows the month beside the week, so
    // a thin week cannot be mistaken for a trend.
    const npsMonth = state.scores.nps?.pivots?.[302] ?? null;
    const subMonth = state.scores.subscores?.pivots?.[302] ?? null;

    const tiles = [];

    // NPS leads and is given more room than the sub-scores: it is the graded
    // number, and it is the one with a last-year line to compare against.
    if (latest) {
      tiles.push(`
        <div class="cx-tile cx-tile-hero">
          <div class="cx-tile-label">
            NPS
            <span class="cx-tile-period">${escapeHtml(latest.labelLong ?? latest.label)} · in progress</span>
          </div>
          <div class="cx-tile-value">${latest.ty}</div>
          <div class="cx-tile-meta">
            ${deltaChip(latest.ty, prior?.ty, "vs last week", { higherIsBetter: true })}
            ${deltaChip(latest.ty, latest.ly, "vs last year", { higherIsBetter: true })}
            ${npsMonth?.ty != null
              ? `<span class="cx-delta is-period">${npsMonth.ty} <em>${escapeHtml(npsMonth.label)}</em></span>`
              : ""}
          </div>
          ${sparkline(periods)}
        </div>`);
    }

    for (const def of SUBSCORES) {
      const cur = latestSub?.scores?.[def.key];
      if (!cur || cur.ty == null) continue;
      const monthTy = subMonth?.[`${def.key}_ty`];
      const monthLy = subMonth?.[`${def.key}_ly`];
      tiles.push(`
        <div class="cx-tile cx-scope-${def.scope}">
          <div class="cx-tile-label">${escapeHtml(def.label)}</div>
          <div class="cx-tile-value cx-tile-value-sm">${cur.ty.toFixed(2)}</div>
          <div class="cx-tile-meta">
            ${deltaChip(cur.ty, cur.ly, "vs LY", { higherIsBetter: true, decimals: 2 })}
            ${monthTy != null
              ? `<span class="cx-delta is-period" title="${escapeHtml(subMonth.label)}${monthLy != null ? `, last year ${monthLy.toFixed(2)}` : ""}">${monthTy.toFixed(2)} <em>MTD</em></span>`
              : ""}
          </div>
        </div>`);
    }

    row.innerHTML = tiles.join("")
      + `<p class="cx-note cx-scorecard-note">
           From the Hoops scorecard. The big figure is
           <strong>${escapeHtml(latestSub?.labelLong ?? "the current week")}</strong>, which is still in progress —
           on one store that can be a handful of surveys, so read it against the
           <strong>MTD</strong> figure beside it. Sub-scores are averages out of 5;
           NPS is published weekly, never daily.
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
                  <span class="cx-quote-meta">${escapeHtml(withWeekday(ex.day ?? ""))} · ${escapeHtml(ex.journey ?? "—")} · ${starLabel(ex.score)}</span>
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

    // The direction is spelled out, not just drawn. A ▲/▼ pair at 12px separated
    // only by colour was genuinely hard to read at a glance — and colour alone
    // fails anyone who cannot use it. The word carries the meaning; the arrow and
    // the colour only reinforce it.
    const DIRECTION = {
      worse:  { word: "worse",  arrow: "↑" },
      better: { word: "better", arrow: "↓" },
      flat:   { word: "flat",   arrow: "→" },
    };

    $("[data-movers]").innerHTML = rows.length
      ? rows.map((x) => {
        const d = DIRECTION[x.direction] ?? DIRECTION.flat;
        return `
        <div class="cx-mover cx-mover-${x.direction}${x.thin ? " is-thin" : ""}">
          <span class="cx-mover-dir">
            <span class="cx-mover-arrow" aria-hidden="true">${d.arrow}</span>${escapeHtml(d.word)}
          </span>
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
        </div>`;
      }).join("")
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

  /**
   * The evidence list, read from the SW's real filtered set rather than from the
   * theme cards' example quotes — those are capped at six per theme, so a panel
   * built from them would be a sample of a sample while looking complete.
   */
  async function renderComments() {
    const list = $("[data-comment-list]");
    const res = await send("comments", {
      query: state.commentQuery,
      rating: state.commentRating,
      limit: state.commentLimit,
      offset: 0,
    });

    if (!res?.ok) {
      list.innerHTML = `<p class="cx-empty">No comments stored yet.</p>`;
      $("[data-comments-sub]").textContent = "";
      $(".cx-more").hidden = true;
      return;
    }

    state.commentTotal = res.total;
    for (const sel of ["[data-comment-search]", "[data-comment-rating]", "[data-action='export-comments']"]) {
      const el = $(sel);
      if (el) el.hidden = false;
    }
    $("[data-comments-sub]").textContent =
      `${fmt(res.total)} comments match${state.commentQuery || state.commentRating ? " this search" : " the chips above"}`;

    list.innerHTML = res.rows.length
      ? res.rows.map((r) => `
        <article class="cx-comment cx-rating-${r.score ?? 0}">
          <div class="cx-comment-meta">
            <span class="cx-comment-stars">${starLabel(r.score)}</span>
            <span>${escapeHtml(withWeekday(r.day ?? ""))}</span>
            <span>${escapeHtml(r.journey ?? "—")}</span>
            <span>${escapeHtml(r.channel ?? "")}</span>
            <span class="cx-comment-themes">${r.themes.map((t) => `<em>${escapeHtml(t)}</em>`).join(" ")}</span>
          </div>
          <p class="cx-comment-text">${escapeHtml(r.text)}</p>
        </article>`).join("")
      : `<p class="cx-empty">No comments match.</p>`;

    $(".cx-more").hidden = res.rows.length >= res.total;
  }

  function renderFallbackComments(box) {
    const rows = [...box.rows].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    $("[data-comments-sub]").textContent =
      `${fmt(rows.length)} from the Ops Portal — no topic tags, through ${escapeHtml(rows[0]?.date ?? "?")}`;

    // The search and rating controls act on the Medallia set; with only the
    // stopgap loaded they would silently do nothing.
    for (const sel of ["[data-comment-search]", "[data-comment-rating]", "[data-action='export-comments']"]) {
      const el = $(sel);
      if (el) el.hidden = true;
    }

    $("[data-comment-list]").innerHTML = `
      <p class="cx-note">
        Medallia could not be read, so these come from the Ops Portal's own feed:
        <strong>50 rows, capped, with no topic tags and about a week behind</strong>.
        That is why the theme breakdown and the trend above are not shown — they
        cannot be built from this. Fix the Medallia session and press Refresh.
      </p>`
      + rows.map((r) => `
        <article class="cx-comment cx-rating-${r.rating ?? 0}">
          <div class="cx-comment-meta">
            <span class="cx-comment-stars">${starLabel(r.rating)}</span>
            <span>${escapeHtml(r.date ?? "")}</span>
            <span>${escapeHtml(r.journey ?? "—")}</span>
          </div>
          <p class="cx-comment-text">${escapeHtml(r.text)}</p>
        </article>`).join("");

    $(".cx-more").hidden = true;
  }

  async function renderNarrative() {
    const body = $("[data-narrative-body]");
    const stamp = $("[data-narrative-stamp]");
    const n = state.narrative;

    $("[data-action='narrate-force']").hidden = !n;
    $("[data-action='show-facts']").hidden = !n;

    if (!n) {
      const st = state.settings?.gatewayTokenStatus;
      // Both branches write. An earlier version only wrote the warning, so once
      // a token was pasted the "none is set" line stayed on screen and read as
      // the paste having failed.
      body.innerHTML = (st && !st.ok)
        ? `<p class="cx-note">
             The written read needs an AI gateway token — ${escapeHtml(st.reason === "expired" ? "the stored one has expired" : "none is set")}.
             <strong>Settings → Sign in</strong> sets one up. Everything else on this page works without it.
           </p>`
        : `<p class="cx-empty">
             <strong>Write it up</strong> sends the ranked themes, the movement figures and a
             handful of verbatims to Walmart's internal AI gateway and gets back a written
             summary, covering <strong>this store's comments only</strong>. Every number in it
             is one already on this page — the model is told to use the figures it is given and
             not to derive any.
           </p>`;
      stamp.textContent = "";
      return;
    }

    stamp.textContent = `${n.model ?? ""} · ${relTime(Date.now() - (n.generatedAt ?? Date.now()))}`;
    body.innerHTML = renderMarkdown(n.text);
  }

  /**
   * Show exactly what went to the gateway, inline. Rendered here rather than in a
   * dialog because shared/ui.js has no modal helper, and an auditable panel is
   * more useful open beside the prose it explains than in a box over it.
   */
  function showFacts() {
    const facts = state.narrative?.facts;
    if (!facts) return;
    const existing = container.querySelector("[data-facts-block]");
    if (existing) { existing.remove(); return; }
    const block = document.createElement("details");
    block.className = "cx-facts-block";
    block.setAttribute("data-facts-block", "");
    block.open = true;
    block.innerHTML = `<summary>What was sent to the gateway</summary>
      <p class="cx-note">The figures already on this page, plus the quotes shown under each theme.
         No token, and nothing the panel is not already displaying.</p>
      <pre class="cx-facts">${escapeHtml(JSON.stringify(facts, null, 1))}</pre>`;
    $("[data-narrative-body]").after(block);
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
      `generated ${withWeekday(when)}${ageDays != null && ageDays > 45 ? ` — ${ageDays} days old` : ""}`;

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
    const ver = $("[data-setting-version]");
    if (ver && document.activeElement !== ver) {
      ver.value = s.gatewayClientVersion ?? "";
      ver.placeholder = s.gatewayClientVersionEffective ?? "0.1.70";
    }

    const st = s.gatewayTokenStatus ?? { ok: false, reason: "missing" };
    const el = $("[data-token-status]");
    const signIn = $("[data-action='signin-gateway']");
    const signOut = $("[data-action='signout-gateway']");
    if (!el) return;

    // The button says what it will do next, so an expired token reads as
    // "sign in again" rather than as a state to puzzle over.
    if (signIn) signIn.textContent = s.gatewayTokenSet ? "Sign in again" : "Sign in";
    if (signOut) signOut.hidden = !s.gatewayTokenSet;

    if (!s.gatewayTokenSet) { el.textContent = "not signed in"; el.className = "cx-token-status"; return; }
    if (st.reason === "expired") { el.textContent = "expired — sign in again"; el.className = "cx-token-status is-bad"; return; }
    const exp = st.expiresAt ? new Date(st.expiresAt).toISOString().slice(0, 10) : null;
    el.textContent = exp ? `signed in · expires ${withWeekday(exp)}` : "signed in";
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
    show("[data-filters]", false);

    // With no Medallia history there is still the Ops Portal stopgap. Showing it
    // beats an empty page, but it is labelled for what it is: 50 rows, no topic
    // tags, about a week behind — which is why none of the panels above it can
    // be drawn from it.
    if (state.fallback?.rows?.length) {
      renderFallbackComments(state.fallback);
      show("[data-comments-panel]", true);
    } else {
      show("[data-comments-panel]", false);
    }
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

  async function doSignIn() {
    const btn = $("[data-action='signin-gateway']");
    const status = $("[data-token-status]");
    btn.disabled = true;
    const was = btn.textContent;
    btn.textContent = "Signing in…";
    try {
      const res = await send("signInGateway", {});
      if (!res?.ok) {
        status.textContent = res?.reason === "CANCELLED" ? "sign-in cancelled" : "sign-in failed";
        status.className = `cx-token-status${res?.reason === "CANCELLED" ? "" : " is-bad"}`;
        // The two failure modes look identical from here, so show what the
        // listener actually observed rather than a generic retry message.
        await renderAuthDiagnostics(res?.error);
        return;
      }
      $("[data-signin-diag]")?.remove();
      await loadState();
      // The narrative panel's placeholder is written from the token status.
      await renderNarrative();
      // Said plainly because the auth page may be showing its own "couldn't
      // reach the CLI" error at this exact moment — that hand-off failing is
      // expected and unrelated to whether we got the token.
      toast("Signed in to the AI gateway — ignore any error on the sign-in page", { kind: "success" });
    } finally {
      btn.disabled = false;
      btn.textContent = was;
    }
  }

  /** Inline, under the sign-in row, because that is where the question is. */
  async function renderAuthDiagnostics(message) {
    const diag = await send("authDiagnostics", {});
    $("[data-signin-diag]")?.remove();

    const block = document.createElement("div");
    block.className = "cx-signin-diag";
    block.setAttribute("data-signin-diag", "");

    const seen = diag?.observed ?? [];
    block.innerHTML = `
      <p class="cx-error">${escapeHtml(message ?? "The sign-in did not complete.")}</p>
      <details>
        <summary>What the extension saw</summary>
        <p class="cx-setting-hint">
          Sign-in page access: <strong>${diag?.authPageGranted ? "granted" : "NOT granted"}</strong>
          ${diag?.authPageGranted ? "" : " — reload the extension, this is why the page hook never ran"}
        </p>
        ${seen.length
          ? `<table class="cx-topic-table"><thead><tr><th>Reported by the page</th><th>Token len</th><th>In flow</th></tr></thead><tbody>
              ${seen.map((o) => `<tr>
                <td>${escapeHtml(new Date(o.at).toLocaleTimeString())}</td>
                <td>${o.tokenLen ?? "—"}</td>
                <td>${o.fresh ? "yes" : "no"}</td>
              </tr>`).join("")}
            </tbody></table>`
          : `<p class="cx-setting-hint">
               <strong>The sign-in page never handed a token to the extension.</strong> The page
               hook is a content script, and a newly added one only applies to pages loaded after
               an extension reload — reload it and try again, or use “Paste a token instead”.
             </p>`}
      </details>`;
    $(".cx-signin-row")?.after(block);
  }

  async function doSignOut() {
    if (!confirm("Forget the stored AI gateway token on this device?")) return;
    await send("signOutGateway", {});
    await loadState();
    await renderNarrative();
    toast("Signed out", { kind: "info" });
  }

  async function doPullMarket() {
    const body = $("[data-market-body]");
    const sub = $("[data-market-sub]");
    body.innerHTML = `<p class="cx-empty">Reading the market…</p>`;
    const res = await send("pullMarket", {});
    if (!res?.ok) {
      sub.textContent = "";
      body.innerHTML = `<p class="cx-error">${escapeHtml(res?.error ?? "Could not read the market.")}</p>`;
      return;
    }
    state.market = res.market;
    renderMarket();
  }

  /**
   * The market scoreboard. Scores only — Medallia scopes comments to the role,
   * so there is nothing market-wide to analyse and the panel says so rather than
   * leaving the reader to infer it from a missing section.
   */
  function renderMarket() {
    const body = $("[data-market-body]");
    const sub = $("[data-market-sub]");
    const m = state.market;
    if (!m?.rows?.length) { if (sub) sub.textContent = ""; return; }

    sub.textContent = `market ${m.marketNbr ?? "—"} · ${m.period ?? ""} · read ${relTime(Date.now() - (m.pulledAt ?? Date.now()))}`;

    const defs = m.subscores ?? SUBSCORES;
    const home = m.rows.find((r) => r.isHome);

    body.innerHTML = `
      ${m.market?.nps != null || home ? `
      <p class="cx-market-lead">
        ${m.market?.nps != null ? `Market NPS <strong>${m.market.nps}</strong>` : ""}
        ${m.market?.vsLy != null ? deltaChip(m.market.nps, m.market.npsLy, "vs LY", { higherIsBetter: true }) : ""}
        ${home?.nps != null ? ` · store ${escapeHtml(home.store)} is <strong>${escapeHtml(ordinal(home.rank))}</strong> of ${m.counts.scored}, ${home.vsMarket >= 0 ? "" : ""}<strong>${signedNum(home.vsMarket)}</strong> against the market` : ""}
        ${m.medianNps != null ? ` · median store ${m.medianNps}` : ""}
      </p>` : ""}
      <div class="cx-market-scroll">
        <table class="cx-market-table">
          <thead>
            <tr>
              <th>#</th><th>Store</th><th>NPS</th><th>vs LY</th><th>vs market</th>
              ${defs.map((d) => `<th class="cx-scope-head cx-scope-${d.scope}" title="${escapeHtml(d.label)}">${escapeHtml(shortLabel(d.label))}</th>`).join("")}
            </tr>
          </thead>
          <tbody>
            ${m.rows.map((r) => `
              <tr class="${r.isHome ? "is-home" : ""}">
                <td>${r.rank ?? "—"}</td>
                <td class="cx-market-store">${escapeHtml(r.store)}${r.isHome ? ' <span class="cx-home-tag">yours</span>' : ""}</td>
                <td class="cx-num">${r.ok ? (r.nps ?? "—") : "—"}</td>
                <td class="cx-num ${cls(r.vsLy)}">${signedNum(r.vsLy)}</td>
                <td class="cx-num ${cls(r.vsMarket)}">${signedNum(r.vsMarket)}</td>
                ${defs.map((d) => {
                  const v = r.scores?.[d.key];
                  return `<td class="cx-num">${v?.ty == null ? "—" : v.ty.toFixed(2)}</td>`;
                }).join("")}
              </tr>`).join("")}
          </tbody>
        </table>
      </div>
      <p class="cx-note">
        NPS and the eight sub-scores for the latest week each store has published, from the
        same Hoops scorecard as the panel above — <strong>scores only</strong>. Medallia shows
        you comments for your own store, so the theme analysis below cannot be produced for
        the rest of the market.
      </p>`;
  }

  async function doExportPdf() {
    const btn = $("[data-action='export-pdf']");
    const was = btn.textContent;
    btn.textContent = "Building…";
    btn.disabled = true;
    try {
      const name = await generateCxPdf({
        storeNbr: state.storeNbr,
        generatedAt: Date.now(),
        // subscoreDefs travels with the scores so the PDF labels the rows from
        // the same table the panel does.
        scores: state.scores ? { ...state.scores, subscoreDefs: SUBSCORES } : null,
        analysis: state.analysis,
        market: state.market,
        narrative: state.narrative ?? null,
      });
      toast(`Saved ${name}`, { kind: "success" });
    } catch (e) {
      toast(`PDF failed: ${e?.message ?? e}`, { kind: "error" });
    } finally {
      btn.textContent = was;
      btn.disabled = false;
    }
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

  /**
   * CSV of everything the current chips select, not just the rows on screen —
   * asked for a year of comments, the file should hold a year of comments.
   */
  async function exportComments() {
    const first = await send("comments", {
      query: state.commentQuery, rating: state.commentRating, limit: 200, offset: 0,
    });
    if (!first?.ok) { toast("Nothing to export yet", { kind: "info" }); return; }

    const rows = [["day", "journey", "source", "rating", "themes", "comment"]];
    let page = first, offset = 0;
    // Paged because the handler caps one page at 200. A year is about forty
    // pages, which keeps any single structured clone small.
    while (page?.ok && page.rows.length) {
      for (const r of page.rows) {
        rows.push([r.day ?? "", r.journey ?? "", r.channel ?? "", r.score ?? "", (r.themes ?? []).join("; "), r.text ?? ""]);
      }
      offset += page.rows.length;
      if (offset >= page.total) break;
      page = await send("comments", {
        query: state.commentQuery, rating: state.commentRating, limit: 200, offset,
      });
    }

    const csv = rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `cx-comments-${state.storeNbr ?? "store"}-${state.analysis?.counts.lastDay ?? "latest"}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    toast(`Exported ${fmt(rows.length - 1)} comments`, { kind: "success" });
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

function signedNum(v, decimals = 0) {
  if (v == null || Number.isNaN(v)) return "—";
  const n = Number(v);
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(decimals)}`;
}

const cls = (v) => (v == null ? "" : v > 0 ? "is-good" : v < 0 ? "is-bad" : "");

export function ordinal(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  const teens = v % 100;
  if (teens >= 11 && teens <= 13) return `${v}th`;
  return `${v}${{ 1: "st", 2: "nd", 3: "rd" }[v % 10] ?? "th"}`;
}

/** Column headers have to fit ten of them across; the full label is the title. */
function shortLabel(label) {
  return label
    .replace("Associate interactions", "Assoc")
    .replace("Checkout satisfaction", "Checkout")
    .replace("Product availability", "Avail")
    .replace("Overall satisfaction", "Overall")
    .replace("SCO / pinpad", "SCO");
}

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
