// modules/compshop/view.js
//
// Comp Shop Prep — shell page. Reads the cached doc (service.js::get),
// refreshes it on demand (service.js::pull) and draws two tabs:
//   Ad deals      (lib/model.js::buildAdModel) every produce item in an ALDI /
//                 Food City ad running within a week of today: their photo,
//                 price, deal and dates beside our walmart.com match (photo,
//                 price, barcode), tinted red / yellow by the gap. The match
//                 can be changed from walmart.com's top results; the choice is
//                 kept per ad item name and reused every week.
//   Scan history  (lib/model.js::buildModel) items 1458 has comp shopped, with
//                 the shelf and competitor prices from the last scan.
// Browser storage holds view settings and the chosen matches (adLinks).

import { buildModel, buildAdModel, DEFAULT_RULES } from "./lib/model.js";
import { barcodeSvg } from "./lib/barcode.js";

const money = (n) => (n == null ? "—" : `$${n.toFixed(2)}`);
const fmtDay = (ms) => (ms ? new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");
const fmtRange = (a, b) => `${fmtDay(a)}–${fmtDay(b)}`;
const fmtWhen = (ms) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const daysAgo = (ms) => Math.floor((Date.now() - ms) / 86_400_000);
// "$0.83 each · 12 for $10.00 · Get 2 free · Each" — what to type into Comp Shop's price / units / weight.
const dealParts = (a) => {
  const per = /lb/i.test(a.post || "") ? "/lb" : "";
  const parts = [a.qty > 1 ? `${money(a.unit)} each` : `${money(a.price)}${per}`];
  if (a.qty > 1) parts.push(`${a.qty} for ${money(a.price)}`);
  else if (a.pre && !/^\s*price drops?\s*$/i.test(a.pre)) parts.push(a.pre.toLowerCase());
  if (a.sale) parts.push(a.sale.charAt(0) + a.sale.slice(1).toLowerCase());
  if (a.size && a.size.length < 40) parts.push(a.size);
  return parts;
};

export async function mount(host, container) {
  const esc = host.ui.escapeHtml;
  const link = document.createElement("link");
  link.rel = "stylesheet"; link.href = host.url("styles.css"); link.dataset.module = host.id;
  const cssReady = new Promise((resolve) => {
    link.addEventListener("load", resolve, { once: true });
    link.addEventListener("error", resolve, { once: true });
    setTimeout(resolve, 3000);
  });
  document.head.appendChild(link);
  await cssReady;
  container.innerHTML = await fetch(host.url("view.html")).then((r) => r.text());

  const $ = (sel) => container.querySelector(sel);
  const els = {
    sub: $("#compshop-sub"), msg: $("#compshop-msg"), empty: $("#compshop-empty"), body: $("#compshop-body"),
    cards: $("#compshop-cards"), pane: $("#compshop-pane"), refresh: $("#compshop-refresh"), print: $("#compshop-print"), ai: $("#compshop-ai"),
    comp: $("#compshop-comp"), show: $("#compshop-show"), days: $("#compshop-days"), daysWrap: $("#compshop-days-wrap"),
    q: $("#compshop-q"), redPct: $("#compshop-red-pct"), redDollar: $("#compshop-red-dollar"), zoom: $("#compshop-zoom"),
  };

  let alive = true;
  let data = null;
  let deals = null;      // buildAdModel
  let hist = null;       // buildModel
  let tab = "deals";
  let adLinks = {};
  let rules = { ...DEFAULT_RULES };
  let compFilter = "";
  let show = "cheaper";
  let days = 120;
  let q = "";

  try {
    const saved = await host.storage.local.get(null);
    if (saved.tab === "deals" || saved.tab === "history") tab = saved.tab;
    if (saved.adLinks) adLinks = saved.adLinks;
    if (saved.rules) rules = { ...rules, ...saved.rules };
    if (saved.show) show = saved.show;
    if (saved.days != null) days = Number(saved.days);
  } catch { /* defaults */ }
  els.show.value = show;
  els.days.value = String(days);
  els.redPct.value = String(rules.redPct);
  els.redDollar.value = rules.redDollar.toFixed(2);

  function status(text, kind = "") {
    els.msg.hidden = !text;
    els.msg.textContent = text || "";
    els.msg.className = `cs-status ${kind}`;
  }
  const save = (k, v) => host.storage.local.set(k, v).catch(() => {});

  // ── render ─────────────────────────────────────────────────────
  function render() {
    if (!data) { els.empty.hidden = false; els.body.hidden = true; return; }
    els.empty.hidden = true; els.body.hidden = false;
    deals = buildAdModel(data, { links: adLinks, rules });
    hist = buildModel(data, { days, rules });

    const ads = (data.flyers || []).map((f) => `${f.comp} ${f.name || "ad"} ${fmtRange(f.from, f.to)}`).join(" · ");
    els.sub.textContent = `Store ${data.store} · ads: ${ads || "none found"} · loaded ${fmtWhen(data.pulledAt)}`;

    const comps = (data.comps || []).map((c) => c.name);
    if (els.comp.options.length !== comps.length + 1) {
      els.comp.innerHTML = `<option value="">All</option>` + comps.map((c) => `<option>${esc(c)}</option>`).join("");
    }
    els.comp.value = compFilter;
    els.daysWrap.hidden = tab !== "history";

    for (const b of container.querySelectorAll(".cs-tab")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
    renderCards();
    if (tab === "history") renderHistory(); else renderDeals();
  }

  function renderCards() {
    const c = deals.counts;
    const card = (n, label, detail, tone, go) =>
      `<button class="cs-card ${tone}" type="button" data-go="${go}"><span class="cs-card-n">${n}</span><span class="cs-card-label">${esc(label)}</span><span class="cs-card-detail">${esc(detail)}</span></button>`;
    const stale = Object.entries(hist.lastTrip).filter(([, ms]) => daysAgo(ms) > 30).map(([name, ms]) => `${name}: ${daysAgo(ms)} days`);
    els.cards.innerHTML =
      card(c.red, "Big gap", `Ad at least ${rules.redPct}% or ${money(rules.redDollar)} under us`, "tier-red", "deals") +
      card(c.yellow, "Slightly cheaper", "Ad a little under us", "tier-yellow", "deals") +
      card(c.total, "Produce on sale", c.unmatched ? `${c.unmatched} without a match on walmart.com` : "All matched to our items", c.unmatched ? "tone-warn" : "", "deals") +
      (stale.length ? card(stale.length, "Not shopped in 30+ days", stale.join(" · "), "tone-warn", "history") : "");
  }

  function barcodeHtml(parsed, zoomAttr) {
    if (!parsed) return `<span class="cs-muted">No barcode yet</span>`;
    const svg = barcodeSvg(parsed, { module: 1.4, height: 40 });
    return `<button class="cs-barcode" type="button" ${zoomAttr} title="Show large to scan">` +
      (parsed.plu ? `<span class="cs-plu">PLU ${esc(parsed.plu)}</span>` : "") +
      (svg || `<span class="cs-muted">${esc(parsed.gtin)} (not a valid barcode)</span>`) + `</button>`;
  }

  const matchLine = (r) => r.matchedBy === "ai"
    ? `<small class="cs-match ai ${esc(r.ai.confidence)}">AI match (${esc(r.ai.confidence)})${r.ai.note ? `: ${esc(r.ai.note)}` : ""}</small>`
    : r.matchedBy === "size" ? `<small class="cs-match">Switched to the ad's size (the AI's pick was a different size)</small>`
    : r.matchedBy === "you" ? `<small class="cs-match">Your pick</small>` : r.matchedBy === "keywords" ? `<small class="cs-match">Keyword match: check it</small>` : "";

  // ── Ad deals ───────────────────────────────────────────────────
  function renderDeals() {
    let rows = deals.rows.filter((r) => !compFilter || r.comp === compFilter)
      .filter((r) => !q || `${r.name} ${r.adName} ${r.ours?.name || ""}`.toLowerCase().includes(q));
    if (show === "cheaper") rows = rows.filter((r) => r.tier !== "none" || !r.ours || r.unitsNote);
    if (!rows.length) {
      els.pane.innerHTML = `<div class="cs-empty-small">${deals.rows.length ? "No ad items are cheaper than ours. Switch Show to All items to see every one." : "No produce in the competitor ads for this week."}</div>`;
      return;
    }
    const html = rows.map((r, i) => {
      const [first, ...rest] = dealParts(r);
      const badge = r.phase === "active" ? "On now" : r.phase === "upcoming" ? `Starts ${fmtDay(r.from)}` : "Ended";
      const opts = r.cands.map((c) => `<option value="${esc(c.id)}"${r.ours?.id === c.id ? " selected" : ""}>${esc(c.name)} · ${money(c.price)}</option>`).join("") +
        `<option value=""${r.ours ? "" : " selected"}>No match</option><option value="none">Not produce / hide</option>`;
      const ours = r.ours
        ? `<div class="cs-ours">
             ${r.ours.img ? `<img src="${esc(r.ours.img)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}
             <div><b>${money(r.ours.price)}</b> <span class="cs-muted">${esc(r.ours.shown || "")}</span>
               ${r.ours.unitText ? `<small>${esc(r.ours.unitText)}${r.oursPerLb ? " (compared per lb)" : ""}</small>` : ""}
               <small>walmart.com price</small>${matchLine(r)}</div>
           </div>`
        : `<div class="cs-muted">${r.ai?.none ? `AI found nothing comparable on walmart.com${r.ai.note ? `: ${esc(r.ai.note)}` : ""}` : "No match found on walmart.com"}</div>`;
      const last = r.lastScan
        ? `<small>1458 at last comp scan ${fmtDay(r.lastScan.ours.date)}: ${money(r.lastScan.ours.price)}${r.lastScan.comp ? ` · ${esc(r.comp)} ${money(r.lastScan.comp.price)} ${fmtDay(r.lastScan.comp.date)}` : ""}</small>` : "";
      const gap = r.tier !== "none"
        ? `<b>${money(r.gap)}</b><small>${Math.round(r.pct)}% under ours</small>` : `<span class="cs-muted">—</span>`;
      const notes = (r.unitsNote ? `<small class="cs-suspect">${esc(r.unitsNote)}</small>` : "") +
        (r.suspect ? `<small class="cs-suspect">Check the sizes: a gap this big is usually a different pack size.</small>` : "");
      return `<tr class="tier-${r.tier}">
        <td class="cs-img">${r.img ? `<img src="${esc(r.img)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}</td>
        <td><span class="cs-comp-name">${esc(r.comp)}</span> <span class="cs-badge ${r.phase}">${badge}</span>
          <div class="cs-name">${esc(r.name)}</div>
          <div class="cs-ad-price">${esc(first)}</div>
          ${rest.length ? `<small>${esc(rest.join(" · "))}</small>` : ""}
          <small>${fmtRange(r.from, r.to)}${r.name !== r.adName ? ` · ad: ${esc(r.adName)}` : ""}</small></td>
        <td class="cs-ours-cell">${ours}
          <select class="input cs-pick" data-pick="${esc(r.key)}" aria-label="Our item">${opts}</select>
          ${last}</td>
        <td>${barcodeHtml(r.barcode, `data-zoom-deal="${i}"`)}</td>
        <td class="cs-gap">${gap}${notes}</td>
      </tr>`;
    }).join("");
    shownDeals = rows;
    els.pane.innerHTML = `<p class="cs-hint">Every produce item in the competitors' ads within a week of today, beside the closest item on walmart.com. If the match is wrong, pick another; the choice is remembered. Our price is walmart.com's (it can differ from 1458's shelf). Click a barcode to show it large; the competitor price still has to be typed into Comp Shop.</p>
      <div class="cs-table-wrap"><table class="cs-table cs-deals">
        <thead><tr><th></th><th>Their ad</th><th>Our item</th><th>Barcode</th><th>Gap</th></tr></thead>
        <tbody>${html}</tbody></table></div>
      <p class="cs-muted cs-count">${rows.length} item${rows.length === 1 ? "" : "s"}</p>`;
  }
  let shownDeals = [];

  // ── Scan history ───────────────────────────────────────────────
  function renderHistory() {
    let items = hist.items.filter((it) => !q || `${it.desc} ${it.label} ${it.gtin} ${it.barcode.plu || ""}`.toLowerCase().includes(q));
    if (compFilter) items = items.filter((it) => it.comps[compFilter]);
    if (show === "cheaper") items = items.filter((it) => it.tier !== "none");
    if (!items.length) { els.pane.innerHTML = `<div class="cs-empty-small">No scanned items match.</div>`; return; }
    const html = items.map((it) => {
      const comps = Object.entries(it.comps).filter(([c]) => !compFilter || c === compFilter)
        .map(([c, s]) => `<div class="cs-comp"><span class="cs-comp-name">${esc(c)}</span><div><b>${money(s.price)}</b> <span class="cs-muted">scanned ${fmtDay(s.date)}</span></div></div>`).join("");
      const gap = it.tier !== "none" ? `<b>${money(it.gap)}</b><small>${Math.round(it.pct)}% under us at ${esc(it.best.comp)}</small>` : `<span class="cs-muted">—</span>`;
      return `<tr class="tier-${it.tier}">
        <td class="cs-img">${it.img ? `<img src="${esc(it.img)}" alt="" loading="lazy" referrerpolicy="no-referrer">${it.imgSimilar ? `<small>similar</small>` : ""}` : `<span class="cs-noimg">No photo</span>`}</td>
        <td><div class="cs-name">${esc(it.label)}</div><small>${esc(it.desc)}</small></td>
        <td>${barcodeHtml(it.barcode, `data-zoom-gtin="${esc(it.gtin)}"`)}</td>
        <td class="cs-price"><b>${money(it.ours)}</b><small>at scan ${fmtDay(it.oursDate)}</small></td>
        <td>${comps}</td>
        <td class="cs-gap">${gap}${it.suspect ? `<small class="cs-suspect">Check this scan: likely a different size or a typo.</small>` : ""}</td>
      </tr>`;
    }).join("");
    els.pane.innerHTML = `<p class="cs-hint">What 1458 has comp shopped: prices from each item's last scan, not today's.</p>
      <div class="cs-table-wrap"><table class="cs-table">
        <thead><tr><th></th><th>Item</th><th>Barcode / PLU</th><th>Our price</th><th>Competitor price</th><th>Gap</th></tr></thead>
        <tbody>${html}</tbody></table></div>
      <p class="cs-muted cs-count">${items.length} item${items.length === 1 ? "" : "s"}</p>`;
  }

  function openZoom({ title, parsed, prices }) {
    if (!parsed) return;
    els.zoom.innerHTML = `<div class="cs-zoom-card">
      <button class="cs-zoom-close btn btn-ghost btn-sm" type="button" data-close>Close</button>
      <div class="cs-name">${esc(title)}</div>
      ${parsed.plu ? `<div class="cs-zoom-plu">PLU ${esc(parsed.plu)}</div>` : ""}
      <div class="cs-zoom-code">${barcodeSvg(parsed, { module: 4, height: 140 })}</div>
      <div class="cs-zoom-prices">${prices}</div>
    </div>`;
    els.zoom.hidden = false;
  }

  // ── events ─────────────────────────────────────────────────────
  container.addEventListener("click", (e) => {
    const t = e.target;
    const tabBtn = t.closest(".cs-tab");
    if (tabBtn) { tab = tabBtn.dataset.tab; save("tab", tab); render(); return; }
    const go = t.closest("[data-go]");
    if (go) { tab = go.dataset.go; save("tab", tab); render(); return; }
    const zd = t.closest("[data-zoom-deal]");
    if (zd) {
      const r = shownDeals[Number(zd.dataset.zoomDeal)];
      if (r) openZoom({ title: r.ours?.name || r.name, parsed: r.barcode, prices: `Ours ${money(r.ours?.price)} · ${esc(r.comp)} ${esc(dealParts(r).join(" · "))} · ${fmtRange(r.from, r.to)}` });
      return;
    }
    const zg = t.closest("[data-zoom-gtin]");
    if (zg) {
      const it = hist.items.find((i) => i.gtin === zg.dataset.zoomGtin);
      if (it) openZoom({ title: it.label, parsed: it.barcode, prices: `Ours ${money(it.ours)} · ${it.best ? `${esc(it.best.comp)} ${money(it.best.price)}` : "no competitor price"}` });
      return;
    }
    if (t.closest("[data-close]") || t === els.zoom) els.zoom.hidden = true;
  });
  container.addEventListener("change", async (e) => {
    const sel = e.target.closest("[data-pick]");
    if (!sel) return;
    const key = sel.dataset.pick;
    const next = { ...adLinks };
    if (sel.value) next[key] = sel.value; else delete next[key];
    adLinks = next;
    await save("adLinks", adLinks);
    // A walmart.com item we haven't read a barcode for yet.
    if (sel.value && sel.value !== "none" && !data.upcs?.[sel.value]) {
      status("Reading that item's barcode…");
      const res = await host.messaging.sendRaw("upc", { id: sel.value }).catch(() => null);
      if (!alive) return;
      if (res?.ok && res.upc) data.upcs = { ...(data.upcs || {}), [sel.value]: res.upc };
      status(res?.ok ? "" : "Couldn't read that item's barcode from walmart.com.", res?.ok ? "" : "warn");
    }
    render();
  });
  const onKey = (e) => { if (e.key === "Escape" && !els.zoom.hidden) els.zoom.hidden = true; };
  document.addEventListener("keydown", onKey);

  els.comp.addEventListener("change", () => { compFilter = els.comp.value; render(); });
  els.show.addEventListener("change", () => { show = els.show.value; save("show", show); render(); });
  els.days.addEventListener("change", () => { days = Number(els.days.value); save("days", days); render(); });
  els.q.addEventListener("input", () => { q = els.q.value.trim().toLowerCase(); render(); });
  const onRules = () => {
    const pct = Number(els.redPct.value), dol = Number(els.redDollar.value);
    if (!(pct > 0) || !(dol > 0)) return;
    rules = { ...rules, redPct: pct, redDollar: dol };
    save("rules", rules); render();
  };
  els.redPct.addEventListener("change", onRules);
  els.redDollar.addEventListener("change", onRules);
  els.print.addEventListener("click", () => window.print());

  async function refresh() {
    els.refresh.disabled = true;
    status("Refreshing…");
    const res = await host.messaging.sendRaw("pull", {}, { timeoutMs: 8 * 60_000 })
      .catch((e) => ({ ok: false, error: String(e?.message || e) }));
    if (!alive) return;
    els.refresh.disabled = false;
    if (!res?.ok) { status(res?.error || "The refresh failed.", "error"); return; }
    data = res.data;
    status(res.warnings?.length ? res.warnings.join(" ") : "", res.warnings?.length ? "warn" : "");
    render();
  }
  els.refresh.addEventListener("click", refresh);

  // AI matching needs the gateway sign-in; without it rows fall back to keywords.
  async function checkAi() {
    const res = await host.messaging.sendRaw("ai_status", {}).catch(() => null);
    if (alive) els.ai.hidden = !!res?.status?.ok;
  }
  els.ai.addEventListener("click", async () => {
    els.ai.disabled = true;
    status("Signing in to the AI gateway: finish the sign-in in the tab that opened…");
    const res = await host.messaging.sendRaw("ai_sign_in", {}, { timeoutMs: 5 * 60_000 }).catch((e) => ({ ok: false, error: String(e?.message || e) }));
    if (!alive) return;
    els.ai.disabled = false;
    if (!res?.ok) { status(res?.error || "The sign-in didn't finish.", "error"); return; }
    els.ai.hidden = true;
    status("Signed in. Refreshing so the AI can match the ads…");
    refresh();
  });
  checkAi();

  const unsub = host.messaging.on("progress", (m) => { if (alive && m.payload?.text) status(m.payload.text); });

  const got = await host.messaging.sendRaw("get", {}).catch(() => null);
  if (!alive) return () => {};
  data = got?.ok ? got.data : null;
  render();
  // Ads change weekly; refresh when the cache is older than 6 h.
  if (!data || !data.matches || Date.now() - (data.pulledAt || 0) > 6 * 3600_000) refresh();

  return () => {
    alive = false;
    unsub?.();
    document.removeEventListener("keydown", onKey);
    link.remove();
  };
}
