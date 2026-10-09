// modules/gnfr/view.js
//
// Supply Orders — shell page. Reads the cached store doc (service.js::get),
// refreshes it from MyGNFR on demand (service.js::pull) and renders five
// views over the same filtered set: Orders (carts by day, expandable),
// Items (every line, sortable), Who orders (by person / job title), Regular
// items (rhythm + not reordered) and Spend. All derivation is lib/model.js.
// Browser storage holds only view conveniences (tab, range, hidden regulars).

import {
  flatLines, cartState, personOf, regulars, duplicates, people, spendBy,
  trackingUrl, parseApprovalLog, STAGE_LABEL, CARRIER, AREAS, daysBetween,
} from "./lib/model.js";

const NO_TITLE = "Not on recent schedule";

const DAY = 86_400_000;
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const money = (n) => `$${(Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const money0 = (n) => `$${Math.round(n).toLocaleString("en-US")}`;
const fmtDay = (d, opts = { month: "short", day: "numeric" }) => d ? new Date(`${d}T12:00:00`).toLocaleDateString("en-US", opts) : "";
const fmtTime = (ms) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const plural = (n, w, p = `${w}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? w : p}`;
const initials = (name) => String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
const qtyText = (q, uom) => `${Number.isInteger(q) ? q : q.toFixed(1)} ${uom === "EA" ? "" : (uom || "").toLowerCase()}`.trim();
const ago = (days) => days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;

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
    sub: $("#gnfr-sub"), range: $("#gnfr-range"), refresh: $("#gnfr-refresh"), msg: $("#gnfr-msg"),
    empty: $("#gnfr-empty"), body: $("#gnfr-body"), attn: $("#gnfr-attn"), pane: $("#gnfr-pane"),
    filters: $("#gnfr-filters"), q: $("#gnfr-q"), person: $("#gnfr-person"), job: $("#gnfr-job"),
    area: $("#gnfr-area"), stage: $("#gnfr-stage"), clear: $("#gnfr-clear"), count: $("#gnfr-count"), csv: $("#gnfr-csv"),
  };

  let alive = true;
  let data = null;
  let view = null;               // derived from data + range
  let tab = "orders";
  const f = { q: "", win: "", job: "", area: "", stage: "" };
  const open = new Set();        // expanded cart ids
  let itemSort = { key: "at", dir: -1 };
  let peopleBy = "person";
  let regShow = "attention";     // attention | all
  let hidden = {};               // art → lastDay when hidden ("not needed")
  let itemLimit = 300;
  let orderSort = "new";         // new | old | total | person | status
  const tableSort = {};          // data-st table name → { col, dir }

  try {
    const saved = await host.storage.local.get(null);
    if (saved.tab) tab = saved.tab;
    if (saved.range) els.range.value = String(saved.range);
    if (saved.hiddenRegulars) hidden = saved.hiddenRegulars;
    if (saved.orderSort) orderSort = saved.orderSort;
  } catch { /* defaults */ }

  function status(text, kind = "") {
    els.msg.hidden = !text;
    els.msg.textContent = text || "";
    els.msg.className = `gn-status ${kind}`;
  }

  // ── derive ────────────────────────────────────────────────────────────────
  function derive() {
    const today = iso(new Date());
    const rangeDays = Number(els.range.value) || 365;
    const fromDay = iso(new Date(Date.now() - (rangeDays - 1) * DAY));
    const allCarts = Object.values(data.carts || {}).sort((a, b) => b.at - a.at);
    const allLines = flatLines(allCarts, today);
    const carts = allCarts.filter((c) => iso(new Date(c.at)) >= fromDay);
    const lines = allLines.filter((l) => l.day >= fromDay);
    const who = new Map();
    for (const c of allCarts) if (!who.has(c.win)) who.set(c.win, personOf(c.win, data));
    const states = new Map(carts.map((c) => [c.id, cartState(c, today)]));
    // Regular rhythm is judged over everything kept, not just the view range.
    const regs = regulars(allLines, today);
    const dupes = duplicates(lines, { sinceDay: iso(new Date(Date.now() - 45 * DAY)) });
    const dupeKeys = new Set(dupes.flatMap((d) => [`${d.a.cart}|${d.a.art}`, `${d.b.cart}|${d.b.art}`]));
    const byCart = new Map();
    for (const l of lines) { if (!byCart.has(l.cart)) byCart.set(l.cart, []); byCart.get(l.cart).push(l); }
    view = { today, fromDay, rangeDays, carts, lines, byCart, who, states, regs, dupes, dupeKeys };
  }

  const P = (win) => view.who.get(win) || { win, name: `WIN ${win}`, job: "" };

  function lineMatches(l) {
    if (f.area && l.area !== f.area) return false;
    if (f.stage) {
      if (f.stage === "late") { if (!l.late) return false; }
      else if (f.stage === "stale") { if (!l.stale) return false; }
      else if (f.stage === "open") { if (["delivered", "rejected"].includes(l.stage)) return false; }
      else if (f.stage === "dup") { if (!view.dupeKeys.has(`${l.cart}|${l.art}`)) return false; }
      else if (l.stage !== f.stage) return false;
    }
    if (f.q) {
      const p = P(l.win);
      const hay = `${l.desc} ${l.art} ${l.cart} ${l.po} ${l.pr} ${l.trk} ${p.name} ${p.job}`.toLowerCase();
      if (!f.q.toLowerCase().split(/\s+/).every((t) => hay.includes(t))) return false;
    }
    return true;
  }
  const personMatches = (win) => (!f.win || win === f.win) && (!f.job || (P(win).job || NO_TITLE) === f.job);
  const filtered = () => view.lines.filter((l) => personMatches(l.win) && lineMatches(l));
  const anyFilter = () => Object.values(f).some(Boolean);

  // ── header + filters ─────────────────────────────────────────────────────
  function renderHeader() {
    const store = data.store ? `Store ${Number(data.store)}` : "";
    const when = data.pulledAt ? `updated ${new Date(data.pulledAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "";
    const wk = (data.weeks || []).find((w) => w.current);
    const week = wk ? ` · Order cutoff: ${fmtDay(wk.order, { weekday: "short", month: "short", day: "numeric" })}` : "";
    els.sub.textContent = [store, `${plural(view.carts.length, "cart")} · ${money0(view.lines.filter((l) => l.stage !== "rejected").reduce((s, l) => s + l.net, 0))}`, when].filter(Boolean).join(" · ") + week;
  }

  function fillSelect(sel, options, current, allLabel) {
    sel.innerHTML = `<option value="">${esc(allLabel)}</option>` + options.map(([v, label]) => `<option value="${esc(v)}"${v === current ? " selected" : ""}>${esc(label)}</option>`).join("");
  }

  function renderFilterOptions() {
    const wins = [...new Set(view.carts.map((c) => c.win))].map((w) => P(w)).sort((a, b) => a.name.localeCompare(b.name));
    fillSelect(els.person, wins.map((p) => [p.win, p.job ? `${p.name} — ${p.job}` : p.name]), f.win, "Everyone");
    const jobs = [...new Set(wins.map((p) => p.job || NO_TITLE))].sort();
    fillSelect(els.job, jobs.map((j) => [j, j]), f.job, "All job titles");
    const areas = AREAS.filter((a) => view.lines.some((l) => l.area === a));
    fillSelect(els.area, areas.map((a) => [a, a]), f.area, "All areas");
    if (![...els.stage.options].some((o) => o.value === "dup")) els.stage.insertAdjacentHTML("beforeend", `<option value="dup">Possible double orders</option>`);
    els.stage.value = f.stage;
    els.q.value = f.q;
    els.clear.hidden = !anyFilter();
  }

  // ── attention strip ──────────────────────────────────────────────────────
  function renderAttention() {
    const cards = [];
    const appr = view.carts.filter((c) => view.states.get(c.id).stage === "approval");
    if (appr.length) {
      let oldest = Infinity, approver = "";
      for (const c of appr) for (const l of c.lines) {
        const step = (data.approvals?.[l.pr] || []).find((s) => /pending/i.test(s.status));
        if (step?.at && step.at < oldest) { oldest = step.at; approver = step.name; }
      }
      const wait = oldest < Infinity ? Math.floor((Date.now() - oldest) / DAY) : null;
      const amt = appr.reduce((s, c) => s + cartLines(c).filter((l) => l.stage === "approval").reduce((t, l) => t + l.net, 0), 0);
      cards.push({ tone: wait >= 3 ? "warn" : "info", stage: "approval", n: appr.length, label: `${appr.length === 1 ? "cart" : "carts"} waiting on approval`, detail: `${money0(amt)}${approver ? ` · ${approver}` : ""}${wait != null ? ` · oldest ${ago(wait)}` : ""}` });
    }
    const late = view.lines.filter((l) => l.late);
    if (late.length) {
      const worst = Math.max(...late.map((l) => daysBetween(l.eta, view.today)));
      cards.push({ tone: "bad", stage: "late", n: late.length, label: `${late.length === 1 ? "item" : "items"} past expected delivery`, detail: `${plural(new Set(late.map((l) => l.cart)).size, "cart")} · up to ${plural(worst, "day")} late` });
    }
    const overdue = view.regs.filter(needsLook);
    if (overdue.length) cards.push({ tone: "warn", tab: "regulars", n: overdue.length, label: `regular ${overdue.length === 1 ? "item" : "items"} not reordered`, detail: overdue.slice(0, 2).map((r) => shortDesc(r.desc)).join(", ") + (overdue.length > 2 ? "…" : "") });
    if (view.dupes.length) cards.push({ tone: "info", stage: "dup", n: view.dupes.length, label: `possible double ${view.dupes.length === 1 ? "order" : "orders"}`, detail: "same item, 2 carts within 2 days" });
    const moving = view.lines.filter((l) => ["ordered", "shipped", "submitted"].includes(l.stage) && !l.late && !l.stale);
    cards.push({ tone: "ok", stage: "open", n: moving.length, label: `${moving.length === 1 ? "item" : "items"} on the way`, detail: moving.length ? `${plural(new Set(moving.map((l) => l.cart)).size, "cart")} · next due ${fmtDay(moving.map((l) => l.eta).filter(Boolean).sort()[0]) || "—"}` : "nothing outstanding" });
    const mtd = (data.budget || []).reduce((s, b) => s + b.mtd, 0), ly = (data.budget || []).reduce((s, b) => s + b.ly, 0);
    if (ly > 0) cards.push({ tone: mtd > ly ? "bad" : "plain", tab: "spend", n: money0(mtd), label: "invoiced this month", detail: `${Math.round((mtd / ly) * 100)}% of last year's ${new Date().toLocaleDateString("en-US", { month: "long" })} (${money0(ly)})` });

    els.attn.innerHTML = cards.map((c, i) => `
      <button type="button" class="gn-card tone-${c.tone}" data-i="${i}">
        <span class="gn-card-n">${esc(String(c.n))}</span>
        <span class="gn-card-label">${esc(c.label)}</span>
        <span class="gn-card-detail">${esc(c.detail)}</span>
      </button>`).join("");
    els.attn.onclick = (e) => {
      const b = e.target.closest(".gn-card"); if (!b) return;
      const c = cards[Number(b.dataset.i)];
      if (c.stage) { Object.assign(f, { stage: c.stage, q: "", area: "" }); setTab(c.stage === "dup" ? "items" : "orders"); }
      else if (c.tab) setTab(c.tab);
    };
  }

  // Sort order for status columns: what needs action first.
  const STAGE_RANK = { approval: 0, late: 1, submitted: 2, ordered: 3, shipped: 4, stale: 5, delivered: 6, rejected: 7 };
  const lineRank = (l) => STAGE_RANK[l.late ? "late" : l.stale ? "stale" : l.stage] ?? 9;
  const shortDesc = (d) => String(d).replace(/\s+1\s*=\s*\d+.*$/, "").slice(0, 40);
  const isHidden = (r) => hidden[r.art] && hidden[r.art] >= r.lastDay;
  const needsLook = (r) => r.state === "overdue" && !r.open && !isHidden(r);

  // ── shared bits ──────────────────────────────────────────────────────────
  function pill(stage, late, stale) {
    const s = late ? "late" : stale ? "stale" : stage;
    return `<span class="gn-pill st-${s}">${esc(STAGE_LABEL[s] || s)}</span>`;
  }
  function personCell(win, { compact = false } = {}) {
    const p = P(win);
    return `<span class="gn-person"><span class="gn-avatar" aria-hidden="true">${esc(initials(p.name))}</span><span><b>${esc(p.name)}</b>${p.job ? `<small>${esc(p.job)}</small>` : ""}</span></span>`;
  }
  function whenCell(l) {
    if (l.stage === "delivered") return `<span class="gn-ok">Delivered${l.arrDay ? ` ${esc(fmtDay(l.arrDay))}` : ""}</span>`;
    if (l.stage === "rejected") return `<span class="gn-muted">—</span>`;
    if (!l.eta) return `<span class="gn-muted">No date yet</span>`;
    const d = daysBetween(view.today, l.eta);
    if (l.stale) return `<span class="gn-muted">Expected ${esc(fmtDay(l.eta))} · never marked delivered</span>`;
    if (l.late) return `<span class="gn-bad">Due ${esc(fmtDay(l.eta))} · ${plural(-d, "day")} late</span>`;
    return `Due ${esc(fmtDay(l.eta, { weekday: "short", month: "short", day: "numeric" }))}${d <= 1 ? ` <small class="gn-muted">(${d === 0 ? "today" : "tomorrow"})</small>` : ""}`;
  }
  function trackCell(l) {
    if (!l.trk && !l.po) return "";
    const url = trackingUrl(l);
    const carrier = CARRIER[l.carrier] || l.carrier;
    const trk = l.trk ? (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(l.trk)}</a>` : esc(l.trk)) : "";
    return [l.po && `PO ${esc(l.po)}`, carrier && esc(carrier), trk].filter(Boolean).join(" · ");
  }
  function thumb(img) {
    return img ? `<img class="gn-thumb" src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="gn-thumb gn-thumb-none" aria-hidden="true"></span>`;
  }
  function steps(cart, st) {
    if (st.stage === "rejected") return "";
    const order = ["submitted", "approval", "ordered", "shipped", "delivered"];
    const at = order.indexOf(st.stage === "stale" ? "ordered" : st.stage);
    return `<span class="gn-steps" title="${esc(STAGE_LABEL[st.stage])}">${order.map((s, i) => `<i class="${i <= at ? "on" : ""}"></i>`).join("")}</span>`;
  }
  // Pending steps say who it's waiting on; the comment log (see
  // model.js::parseApprovalLog) says who approved or rejected, and why.
  function approvalNotes(cart) {
    const out = [], seen = new Set();
    const day = (ms) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    for (const l of cart.lines) {
      const steps = data.approvals?.[l.pr] || [];
      for (const s of steps) {
        if (!/pending/i.test(s.status) || seen.has(`p|${s.by}`)) continue;
        seen.add(`p|${s.by}`);
        const d = s.at ? Math.floor((Date.now() - s.at) / DAY) : null;
        out.push(`<div class="gn-note tone-${d >= 3 ? "warn" : "info"}">Waiting on <b>${esc(s.name || `WIN ${s.by}`)}</b>${s.title ? ` <small>(${esc(s.title)})</small>` : ""}${s.at ? ` since ${esc(day(s.at))} (${ago(d)})` : ""}.</div>`);
      }
      const logged = new Set();
      for (const s of steps) {
        for (const e of parseApprovalLog(s.comment)) {
          const k = `${e.who}|${e.when}|${e.action}`;
          logged.add(`${e.who}|${e.action}`.toLowerCase());
          if (seen.has(k)) continue; seen.add(k);
          const bad = /reject/i.test(e.action);
          const when = e.when.replace(/ at .*$/, "").replace(/^(\w)(\w+)/, (m, a, b) => a + b.toLowerCase());
          out.push(`<div class="gn-note tone-${bad ? "bad" : "ok"}">${esc(e.action)} by <b>${esc(e.who)}</b> on ${esc(when)}${e.note ? `: “${esc(e.note)}”` : "."}</div>`);
        }
      }
      for (const s of steps) {
        if (!/reject/i.test(s.status) || logged.has(`${s.name}|rejected`.toLowerCase()) || seen.has(`r|${s.by}|${s.doneAt}`)) continue;
        seen.add(`r|${s.by}|${s.doneAt}`);
        out.push(`<div class="gn-note tone-bad">Rejected by <b>${esc(s.name || `WIN ${s.by}`)}</b>${s.title ? ` <small>(${esc(s.title)})</small>` : ""}${s.doneAt ? ` on ${esc(day(s.doneAt))}` : ""}.</div>`);
      }
    }
    return out.join("");
  }

  // ── Orders ───────────────────────────────────────────────────────────────
  function renderOrders() {
    const carts = view.carts.filter((c) => personMatches(c.win) && cartMatches(c));
    els.count.textContent = plural(carts.length, "cart");
    const sortBar = `<div class="gn-sortbar"><label class="gn-field">Sort carts
      <select class="input" data-order-sort>${[["new", "Newest first"], ["old", "Oldest first"], ["total", "Biggest total"], ["person", "Person A–Z"], ["status", "Needs action first"]]
        .map(([v, l]) => `<option value="${v}"${v === orderSort ? " selected" : ""}>${l}</option>`).join("")}</select></label></div>`;
    if (!carts.length) { els.pane.innerHTML = emptyNote(); return; }
    if (!["new", "old"].includes(orderSort)) {
      const key = {
        total: (c) => -c.total,
        person: (c) => P(c.win).name.toLowerCase(),
        status: (c) => { const st = view.states.get(c.id); return STAGE_RANK[st.late ? "late" : st.stage] ?? 9; },
      }[orderSort];
      const list = [...carts].sort((a, b) => { const x = key(a), y = key(b); return (x > y ? 1 : x < y ? -1 : 0) || b.at - a.at; });
      els.pane.innerHTML = sortBar + list.slice(0, 400).map((c) => cartRow(c, true)).join("")
        + (list.length > 400 ? `<p class="gn-muted gn-more">Showing the first 400. Narrow with the filters above.</p>` : "");
      return;
    }
    if (orderSort === "old") carts.reverse();
    const groups = [];
    for (const c of carts) {
      const d = iso(new Date(c.at));
      if (groups.at(-1)?.day !== d) groups.push({ day: d, carts: [] });
      groups.at(-1).carts.push(c);
    }
    const shown = groups.slice(0, 60);
    els.pane.innerHTML = sortBar + shown.map((g) => {
      const diff = daysBetween(g.day, view.today);
      const label = diff === 0 ? "Today" : diff === 1 ? "Yesterday" : fmtDay(g.day, { weekday: "long", month: "short", day: "numeric", year: diff > 300 ? "numeric" : undefined });
      const tot = g.carts.reduce((s, c) => s + c.total, 0);
      return `<div class="gn-day"><h3><span>${esc(label)}</span><small>${plural(g.carts.length, "cart")} · ${money0(tot)}</small></h3>${g.carts.map(cartRow).join("")}</div>`;
    }).join("") + (groups.length > shown.length ? `<p class="gn-muted gn-more">Showing ${orderSort === "old" ? "the earliest" : "the latest"} 60 order days. Narrow with the filters above to see older carts.</p>` : "");
  }

  const cartLines = (c) => view.byCart.get(c.id) || [];
  function cartMatches(c) {
    if (!f.q && !f.area && !f.stage) return true;
    return cartLines(c).some(lineMatches);
  }

  function cartRow(c, withDate = false) {
    const st = view.states.get(c.id);
    const ls = cartLines(c);
    const areas = [...new Set(ls.map((l) => l.area))];
    const custom = c.name && !/^\d{5}_[\w.]+_\d{8}$/.test(c.name) && c.name !== "Not Available" ? c.name : "";
    const progress = st.stage === "delivered" ? "" : st.lines > 1 && st.delivered ? `<small>${st.delivered}/${st.lines - st.rejected} delivered</small>` : "";
    const isOpen = open.has(c.id);
    const flagLate = st.late ? `<span class="gn-pill st-late">${plural(st.late, "item")} late</span>` : "";
    return `<article class="gn-cart${isOpen ? " is-open" : ""}" data-cart="${esc(c.id)}">
      <button type="button" class="gn-cart-head" aria-expanded="${isOpen}">
        ${personCell(c.win, { compact: true })}
        <span class="gn-cart-what">
          <b>${plural(ls.length, "item")}</b> · ${esc(areas.slice(0, 3).join(", "))}${areas.length > 3 ? ` +${areas.length - 3}` : ""}
          ${custom ? `<small>“${esc(custom)}”</small>` : ""}${c.comment ? `<small class="gn-quote">${esc(c.comment.replace(/^[^-]*\(\d\d\/\d\d\/\d{4}[^)]*\)\s*-\s*/, ""))}</small>` : ""}
        </span>
        <span class="gn-cart-time">${withDate ? `${esc(fmtDay(iso(new Date(c.at))))}<small>${esc(fmtTime(c.at))}</small>` : esc(fmtTime(c.at))}</span>
        <span class="gn-cart-total">${esc(money(c.total))}</span>
        <span class="gn-cart-state">${pill(st.stage)}${flagLate}${steps(c, st)}${progress}</span>
      </button>
      ${isOpen ? cartDetail(c, ls) : ""}
    </article>`;
  }

  function cartDetail(c, ls) {
    return `<div class="gn-cart-body">
      ${approvalNotes(c)}
      <table class="gn-table gn-lines" data-st="lines">
        <thead><tr><th></th><th>Item</th><th class="num">Qty</th><th class="num">Total</th><th>Status</th><th>Expected / delivered</th><th>PO · tracking</th></tr></thead>
        <tbody>${ls.map((l) => `<tr class="${lineMatches(l) || !anyFilter() ? "" : "is-dim"}">
          <td>${thumb(l.img)}</td>
          <td data-v="${esc(l.desc)}"><b>${esc(l.desc)}</b><small>#${esc(l.art)} · ${esc(l.area)}${view.dupeKeys.has(`${l.cart}|${l.art}`) ? ` · <span class="gn-warn">possible double order</span>` : ""}</small></td>
          <td class="num" data-v="${l.qty}">${esc(qtyText(l.qty, l.uom))}</td>
          <td class="num" data-v="${l.net}">${esc(money(l.net))}<small>${esc(money(l.price))} ea</small></td>
          <td data-v="${lineRank(l)}">${pill(l.stage, l.late, l.stale)}</td>
          <td data-v="${esc(l.arrDay || l.eta || "9999")}">${whenCell(l)}</td>
          <td class="gn-track" data-v="${esc(l.po || "~")}">${trackCell(l)}</td>
        </tr>`).join("")}</tbody>
      </table>
      <div class="gn-cart-foot">
        <span>Cart #${esc(c.id)}</span>
        <span>Submitted ${esc(new Date(c.at).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}</span>
        ${c.ship ? `<span>Ship note: ${esc(c.ship)}</span>` : ""}
        <span class="gn-spacer"></span>
        <button type="button" class="btn btn-sm btn-secondary" data-who="${esc(c.win)}">All orders by ${esc(P(c.win).name.split(" ")[0])}</button>
      </div>
    </div>`;
  }

  // ── Items ────────────────────────────────────────────────────────────────
  const ITEM_COLS = [
    ["at", "Ordered"], ["desc", "Item"], ["area", "Area"], ["qty", "Qty", "num"], ["net", "Total", "num"],
    ["who", "Ordered by"], ["stage", "Status"], ["eta", "Expected / delivered"],
  ];
  function sortLines(ls) {
    const k = itemSort.key, d = itemSort.dir;
    const val = (l) => k === "who" ? P(l.win).name : k === "stage" ? lineRank(l) : k === "eta" ? (l.arrDay || l.eta || "") : l[k];
    return [...ls].sort((a, b) => { const x = val(a), y = val(b); return (x > y ? 1 : x < y ? -1 : 0) * d || b.at - a.at; });
  }
  function renderItems() {
    const ls = sortLines(filtered());
    const total = ls.filter((l) => l.stage !== "rejected").reduce((s, l) => s + l.net, 0);
    els.count.textContent = `${plural(ls.length, "item line")} · ${money0(total)}`;
    if (!ls.length) { els.pane.innerHTML = emptyNote(); return; }
    const arrow = (k) => itemSort.key === k ? (itemSort.dir > 0 ? " ▲" : " ▼") : "";
    els.pane.innerHTML = `<div class="gn-scroll"><table class="gn-table gn-items">
      <thead><tr>${ITEM_COLS.map(([k, label, cls]) => `<th class="${cls || ""}"><button type="button" data-sort="${k}">${esc(label)}${arrow(k)}</button></th>`).join("")}</tr></thead>
      <tbody>${ls.slice(0, itemLimit).map((l) => `<tr data-cart="${esc(l.cart)}">
        <td class="nowrap">${esc(fmtDay(l.day))}<small>${esc(fmtTime(l.at))}</small></td>
        <td><span class="gn-item">${thumb(l.img)}<span><b>${esc(l.desc)}</b><small>#${esc(l.art)}${view.dupeKeys.has(`${l.cart}|${l.art}`) ? ` · <span class="gn-warn">possible double order</span>` : ""}</small></span></span></td>
        <td>${esc(l.area)}</td>
        <td class="num">${esc(qtyText(l.qty, l.uom))}</td>
        <td class="num">${esc(money(l.net))}</td>
        <td>${personCell(l.win, { compact: true })}</td>
        <td>${pill(l.stage, l.late, l.stale)}</td>
        <td>${whenCell(l)}</td>
      </tr>`).join("")}</tbody></table></div>
      ${ls.length > itemLimit ? `<p class="gn-more"><button type="button" class="btn btn-sm btn-secondary" data-more>Show ${Math.min(300, ls.length - itemLimit)} more (${ls.length - itemLimit} left)</button></p>` : ""}`;
  }

  // ── Who orders ───────────────────────────────────────────────────────────
  function renderPeople() {
    const ls = filtered();
    const hit = new Set(ls.map((l) => l.cart));
    const carts = view.carts.filter((c) => personMatches(c.win) && (!f.q && !f.area && !f.stage || hit.has(c.id)));
    let rows = people(carts, ls).map((r) => ({ ...r, p: P(r.win) }));
    const toggle = `<div class="gn-seg" role="group" aria-label="Group by">
      <button type="button" data-by="person" class="${peopleBy === "person" ? "is-active" : ""}">By person</button>
      <button type="button" data-by="job" class="${peopleBy === "job" ? "is-active" : ""}">By job title</button></div>`;
    const noTitles = !data.roster?.days ? `<p class="gn-hint">Job titles unavailable. Sync Digital Metrics to add them.</p>` : "";
    if (peopleBy === "job") {
      const m = new Map();
      for (const r of rows) {
        const j = r.p.job || NO_TITLE;
        const e = m.get(j) || { job: j, people: 0, carts: 0, lines: 0, spend: 0, last: 0, areas: {}, open: 0 };
        e.people++; e.carts += r.carts; e.lines += r.lines; e.spend += r.spend; e.last = Math.max(e.last, r.last); e.open += r.open;
        for (const [a, v] of Object.entries(r.areas)) e.areas[a] = (e.areas[a] || 0) + v;
        m.set(j, e);
      }
      const jobs = [...m.values()].sort((a, b) => b.spend - a.spend);
      els.count.textContent = plural(jobs.length, "job title");
      els.pane.innerHTML = toggle + noTitles + `<div class="gn-scroll"><table class="gn-table gn-people" data-st="jobs">
        <thead><tr><th>Job title</th><th class="num">People</th><th class="num">Carts</th><th class="num">Items</th><th class="num">Spend</th><th>Last order</th><th>Mostly orders</th></tr></thead>
        <tbody>${jobs.map((j) => `<tr class="gn-click" data-job="${esc(j.job)}">
          <td><b>${esc(j.job)}</b></td><td class="num">${j.people}</td><td class="num">${j.carts}</td><td class="num">${j.lines}</td>
          <td class="num">${esc(money0(j.spend))}</td><td data-v="${j.last}">${esc(ago(daysBetween(iso(new Date(j.last)), view.today)))}</td>
          <td>${Object.entries(j.areas).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a]) => `<span class="gn-chip">${esc(a)}</span>`).join("")}</td>
        </tr>`).join("")}</tbody></table></div>`;
      return;
    }
    els.count.textContent = plural(rows.length, "person", "people");
    els.pane.innerHTML = toggle + noTitles + `<div class="gn-scroll"><table class="gn-table gn-people" data-st="people">
      <thead><tr><th>Person</th><th class="num">Carts</th><th class="num">Items</th><th class="num">Spend</th><th class="num">Avg cart</th><th>Last order</th><th>Mostly orders</th><th class="num">Not delivered</th></tr></thead>
      <tbody>${rows.map((r) => `<tr class="gn-click" data-who="${esc(r.win)}">
        <td data-v="${esc(r.p.name)}">${personCell(r.win)}</td><td class="num">${r.carts}</td><td class="num">${r.lines}</td>
        <td class="num">${esc(money0(r.spend))}</td><td class="num">${esc(money0(r.carts ? r.spend / r.carts : 0))}</td>
        <td data-v="${r.last}">${esc(ago(daysBetween(iso(new Date(r.last)), view.today)))}<small>${esc(fmtDay(iso(new Date(r.last))))}</small></td>
        <td>${r.topAreas.map((a) => `<span class="gn-chip">${esc(a)}</span>`).join("")}</td>
        <td class="num" data-v="${r.open}">${r.open || ""}</td>
      </tr>`).join("")}</tbody></table></div>`;
  }

  // ── Regular items ────────────────────────────────────────────────────────
  const REG_STATE = {
    overdue: ["Not reordered", "bad"], due: ["Due now", "warn"], lapsed: ["Stopped?", "muted"], ok: ["On rhythm", "ok"],
  };
  function regNote(r) {
    const by = P(r.lastWin).name;
    const usual = r.usualWin && r.usualWin !== r.lastWin ? ` Usually ordered by ${P(r.usualWin).name}.` : "";
    if (r.open) return `Ordered ${ago(r.since)} by ${by} and still on its way.${usual}`;
    if (r.state === "overdue") return `Usually every ${plural(r.gap, "day")}; last ordered ${ago(r.since)} by ${by}. Expected again around ${fmtDay(r.dueDay)}.${usual}`;
    if (r.state === "due") return `Due about now — every ~${plural(r.gap, "day")}, last ${ago(r.since)} by ${by}.${usual}`;
    if (r.state === "lapsed") return `Was ordered every ~${plural(r.gap, "day")}, but not for ${r.since} days. Maybe no longer needed, or ordered under another item #.`;
    return `Next expected around ${fmtDay(r.dueDay)}. Last ${ago(r.since)} by ${by}.`;
  }
  function renderRegulars() {
    const q = f.q.toLowerCase();
    let regs = view.regs.filter((r) => (!f.area || r.area === f.area)
      && (!f.win || r.usualWin === f.win || r.lastWin === f.win)
      && (!f.job || (P(r.usualWin).job || NO_TITLE) === f.job)
      && (!q || `${r.desc} ${r.art}`.toLowerCase().includes(q)));
    const hiddenN = regs.filter(isHidden).length;
    if (regShow === "attention") regs = regs.filter(needsLook);
    else if (regShow === "hidden") regs = regs.filter(isHidden);
    const lookN = view.regs.filter(needsLook).length;
    els.count.textContent = plural(regs.length, "item");
    els.pane.innerHTML = `
      <p class="gn-hint" title="Regular: ordered on 4 or more separate occasions, usually no more than 60 days apart. Not reordered: half again past its usual gap (and at least a week over). Stopped?: past three times the gap. Judged over everything loaded (up to 13 months).">Items you order on a regular rhythm. <b>Not needed</b> hides one until it's reordered.</p>
      <div class="gn-seg" role="group" aria-label="Show">
        <button type="button" data-reg="attention" class="${regShow === "attention" ? "is-active" : ""}">Not reordered (${lookN})</button>
        <button type="button" data-reg="all" class="${regShow === "all" ? "is-active" : ""}">All regular items (${view.regs.length})</button>
        ${hiddenN || regShow === "hidden" ? `<button type="button" data-reg="hidden" class="${regShow === "hidden" ? "is-active" : ""}">Marked not needed (${hiddenN})</button>` : ""}
      </div>
      ${regs.length ? `<div class="gn-scroll"><table class="gn-table gn-regs" data-st="regs">
        <thead><tr><th>Item</th><th>Status</th><th>Rhythm</th><th>Last ordered</th><th data-nosort>What to know</th><th></th></tr></thead>
        <tbody>${regs.map((r) => {
          const [label, tone] = r.open ? ["On order", "ok"] : REG_STATE[r.state];
          return `<tr>
            <td data-v="${esc(r.desc)}"><span class="gn-item">${thumb(r.img)}<span><b>${esc(r.desc)}</b><small>#${esc(r.art)} · ${esc(r.area)}</small></span></span></td>
            <td data-v="${r.open ? 4 : { overdue: 0, due: 1, lapsed: 2, ok: 3 }[r.state]}"><span class="gn-pill tone-${tone}">${esc(label)}</span></td>
            <td class="nowrap" data-v="${r.gap}">every ~${plural(r.gap, "day")}<small>usually ${esc(qtyText(r.qty, r.uom) || "1")} · ${r.occasions}×</small></td>
            <td class="nowrap" data-v="${esc(r.lastDay)}">${esc(fmtDay(r.lastDay))}<small>${esc(ago(r.since))}</small></td>
            <td class="gn-note-cell">${esc(regNote(r))}</td>
            <td>${isHidden(r) ? `<button type="button" class="btn btn-sm btn-secondary" data-unhide="${esc(r.art)}">Watch again</button>`
              : (r.state === "overdue" || r.state === "due" || r.state === "lapsed") && !r.open ? `<button type="button" class="btn btn-sm btn-secondary" data-hide="${esc(r.art)}" data-last="${esc(r.lastDay)}" title="Stop flagging this item until it's ordered again">Not needed</button>` : ""}</td>
          </tr>`;
        }).join("")}</tbody></table></div>` : `<div class="gn-empty-small">${regShow === "attention" ? "Every regular item has been reordered on time." : "No regular items match."}</div>`}`;
  }

  // ── Spend ────────────────────────────────────────────────────────────────
  function bars(rows, { fmt = money0, onKey = "" } = {}) {
    const max = Math.max(1, ...rows.map((r) => r.spend));
    return `<ul class="gn-bars">${rows.map((r) => `<li${onKey ? ` class="gn-click" data-${onKey}="${esc(r.key)}"` : ""} title="${esc(`${r.label || r.key}: ${fmt(r.spend)} · ${plural(r.lines, "item line")}`)}">
      <span class="gn-bar-label">${esc(r.label || r.key)}</span>
      <span class="gn-bar-track"><span class="gn-bar" style="width:${Math.max(1, (r.spend / max) * 100).toFixed(1)}%"></span></span>
      <span class="gn-bar-val">${esc(fmt(r.spend))}</span></li>`).join("")}</ul>`;
  }
  function renderSpend() {
    const ls = filtered();
    const total = ls.filter((l) => l.stage !== "rejected").reduce((s, l) => s + l.net, 0);
    els.count.textContent = `${money0(total)} over ${plural(view.rangeDays, "day")}`;
    // Months across the range, empty months included.
    const months = [];
    const d0 = new Date(`${view.fromDay}T12:00:00`); d0.setDate(1);
    for (let d = d0; iso(d) <= view.today; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) months.push(iso(d).slice(0, 7));
    const byMonth = new Map(spendBy(ls, (l) => l.day.slice(0, 7)).map((r) => [r.key, r]));
    const mrows = months.map((m) => ({ key: m, spend: byMonth.get(m)?.spend || 0, lines: byMonth.get(m)?.lines || 0 }));
    const mmax = Math.max(1, ...mrows.map((r) => r.spend));
    const avg = mrows.length > 1 ? mrows.slice(0, -1).reduce((s, r) => s + r.spend, 0) / (mrows.length - 1) : 0;
    const monthChart = `<div class="gn-cols" role="img" aria-label="Spend per month">${mrows.map((r, i) => {
      const label = new Date(`${r.key}-15T12:00:00`).toLocaleDateString("en-US", { month: "short", year: i === 0 || r.key.endsWith("-01") ? "2-digit" : undefined });
      return `<div class="gn-col${i === mrows.length - 1 ? " is-current" : ""}" title="${esc(`${label}: ${money0(r.spend)} · ${plural(r.lines, "item line")}${i === mrows.length - 1 ? " (month so far)" : ""}`)}">
        <span class="gn-col-val">${esc(money0(r.spend))}</span>
        <span class="gn-col-bar" style="height:${Math.max(1, (r.spend / mmax) * 100).toFixed(1)}%"></span>
        <span class="gn-col-label">${esc(label)}</span></div>`;
    }).join("")}</div>`;
    const byArea = spendBy(ls, (l) => l.area).sort((a, b) => b.spend - a.spend);
    const byPerson = spendBy(ls, (l) => l.win).sort((a, b) => b.spend - a.spend).slice(0, 12).map((r) => ({ ...r, label: P(r.key).name }));
    const byJob = spendBy(ls, (l) => P(l.win).job || NO_TITLE).sort((a, b) => b.spend - a.spend).slice(0, 12);
    const topItems = spendBy(ls, (l) => l.art).sort((a, b) => b.spend - a.spend).slice(0, 12)
      .map((r) => ({ ...r, label: shortDesc(ls.find((l) => l.art === r.key)?.desc || r.key) }));
    const budget = (data.budget || []).filter((b) => b.ly || b.mtd).sort((a, b) => b.ly - a.ly);
    const bLy = budget.reduce((s, b) => s + b.ly, 0), bMtd = budget.reduce((s, b) => s + b.mtd, 0);
    els.pane.innerHTML = `
      <div class="gn-panel gn-span2"><h3>Spend by month <small>ordered value of carts submitted · current month so far${avg ? ` · average ${esc(money0(avg))}/month` : ""}</small></h3>${monthChart}</div>
      <div class="gn-grid">
        <div class="gn-panel"><h3>By area <small>click to filter</small></h3>${bars(byArea, { onKey: "area" })}</div>
        <div class="gn-panel"><h3>By person <small>top 12 · click to filter</small></h3>${bars(byPerson, { onKey: "who" })}</div>
        <div class="gn-panel"><h3>By job title <small>top 12</small></h3>${bars(byJob, { onKey: "job" })}</div>
        <div class="gn-panel"><h3>Top items</h3>${bars(topItems)}</div>
      </div>
      ${budget.length ? `<div class="gn-panel"><h3>Invoiced this month vs last year <small>invoiced; lags orders</small></h3>
        <table class="gn-table gn-budget" data-st="budget"><thead><tr><th>Category</th><th class="num">Last year, full month</th><th class="num">This month so far</th><th>Used</th></tr></thead>
        <tbody>${budget.map((b) => { const pct = b.ly ? Math.round((b.mtd / b.ly) * 100) : null; return `<tr>
          <td><b>${esc(b.cat.replace(/^\[[\d.]+\]\s*/, ""))}</b><small>${esc(b.descr)} · GL ${esc(b.gl)}</small></td>
          <td class="num">${esc(money0(b.ly))}</td><td class="num">${esc(money0(b.mtd))}</td>
          <td data-v="${pct ?? 999}"><span class="gn-meter${pct > 100 ? " over" : ""}"><span style="width:${Math.min(100, pct ?? 100)}%"></span></span> ${pct == null ? "new" : `${pct}%`}</td></tr>`; }).join("")}
          <tr class="gn-total"><td>Total</td><td class="num">${esc(money0(bLy))}</td><td class="num">${esc(money0(bMtd))}</td><td>${bLy ? `${Math.round((bMtd / bLy) * 100)}%` : ""}</td></tr></tbody></table></div>` : ""}`;
  }

  function emptyNote() {
    return `<div class="gn-empty-small">Nothing matches these filters.${anyFilter() ? ` <button type="button" class="btn btn-sm btn-secondary" data-clear>Clear filters</button>` : ""}</div>`;
  }

  // ── sortable tables ──────────────────────────────────────────────────────
  // Every <table data-st="name"> sorts by any header with text. A cell's
  // data-v (when present) is the sort key, else its text; "$1,234" and "45%"
  // sort as numbers. The choice is remembered per table across re-renders.
  function cellVal(td) {
    const raw = (td?.dataset.v ?? td?.textContent ?? "").trim();
    const n = raw.replace(/[$,%]/g, "");
    return raw !== "" && n !== "" && !Number.isNaN(Number(n)) ? Number(n) : raw.toLowerCase();
  }
  function decorateTables(root) {
    for (const table of root.querySelectorAll("table[data-st]")) {
      const st = tableSort[table.dataset.st];
      table.querySelectorAll("thead th").forEach((th, i) => {
        if (!th.textContent.trim() || th.hasAttribute("data-nosort")) return;
        if (!th.querySelector("[data-tsort]")) th.innerHTML = `<button type="button" data-tsort="${i}">${th.innerHTML}<span class="gn-arrow"></span></button>`;
        th.querySelector(".gn-arrow").textContent = st?.col === i ? (st.dir > 0 ? " ▲" : " ▼") : "";
        th.setAttribute("aria-sort", st?.col === i ? (st.dir > 0 ? "ascending" : "descending") : "none");
      });
      if (!st) continue;
      const tb = table.tBodies[0];
      const rows = [...tb.rows];
      const fixed = rows.filter((r) => r.classList.contains("gn-total"));
      rows.filter((r) => !fixed.includes(r))
        .map((r, k) => [cellVal(r.cells[st.col]), k, r])
        .sort((a, b) => {
          const x = a[0], y = b[0];
          const c = typeof x === typeof y ? (x > y ? 1 : x < y ? -1 : 0) : typeof x === "number" ? -1 : 1;
          return c * st.dir || a[1] - b[1];
        })
        .forEach(([, , r]) => tb.appendChild(r));
      fixed.forEach((r) => tb.appendChild(r));
    }
  }

  // ── render + events ──────────────────────────────────────────────────────
  function render() {
    if (!alive) return;
    if (!data || !Object.keys(data.carts || {}).length) { els.body.hidden = true; els.empty.hidden = false; return; }
    els.empty.hidden = true; els.body.hidden = false;
    derive();
    renderHeader();
    renderFilterOptions();
    renderAttention();
    renderPane();
  }
  function renderPane() {
    for (const b of container.querySelectorAll(".gn-tabs [data-tab]")) {
      b.classList.toggle("is-active", b.dataset.tab === tab);
      b.setAttribute("aria-selected", String(b.dataset.tab === tab));
    }
    els.pane.className = `gn-pane pane-${tab}`;
    els.csv.hidden = tab === "spend";
    els.clear.hidden = !anyFilter();
    ({ orders: renderOrders, items: renderItems, people: renderPeople, regulars: renderRegulars, spend: renderSpend })[tab]();
    decorateTables(els.pane);
  }
  function setTab(t) {
    tab = t; itemLimit = 300;
    host.storage.local.set("tab", t).catch(() => {});
    renderFilterOptions();
    renderPane();
  }

  container.querySelector(".gn-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]"); if (b) setTab(b.dataset.tab);
  });
  let qTimer = null;
  els.q.addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(() => { f.q = els.q.value.trim(); itemLimit = 300; renderPane(); }, 180); });
  const onSel = (key, el) => el.addEventListener("change", () => { f[key] = el.value; itemLimit = 300; renderPane(); });
  onSel("win", els.person); onSel("job", els.job); onSel("area", els.area); onSel("stage", els.stage);
  const clearAll = () => { Object.keys(f).forEach((k) => { f[k] = ""; }); renderFilterOptions(); renderPane(); };
  els.clear.addEventListener("click", clearAll);
  els.range.addEventListener("change", () => {
    host.storage.local.set("range", Number(els.range.value)).catch(() => {});
    const need = Date.now() - (Number(els.range.value) - 1) * DAY;
    if (data?.coveredFrom && iso(new Date(need)) < data.coveredFrom) refresh();
    else render();
  });

  els.pane.addEventListener("click", async (e) => {
    const t = e.target;
    if (t.closest("a")) return;
    if (t.closest("[data-clear]")) { clearAll(); return; }
    const tsort = t.closest("[data-tsort]");
    if (tsort) {
      const table = tsort.closest("table[data-st]");
      const col = Number(tsort.dataset.tsort), name = table.dataset.st, cur = tableSort[name];
      // First click: numbers and dates biggest/newest first, text A→Z.
      const first = cellVal(table.tBodies[0]?.rows[0]?.cells[col]);
      const dir = cur?.col === col ? -cur.dir : (typeof first === "number" || /^\d{4}-\d{2}-\d{2}$/.test(first) ? -1 : 1);
      tableSort[name] = { col, dir };
      decorateTables(table.parentElement);
      return;
    }
    const sortB = t.closest("[data-sort]");
    if (sortB) { const k = sortB.dataset.sort; itemSort = { key: k, dir: itemSort.key === k ? -itemSort.dir : (k === "desc" || k === "who" || k === "area" ? 1 : -1) }; renderItems(); return; }
    if (t.closest("[data-more]")) { itemLimit += 300; renderItems(); return; }
    const by = t.closest("[data-by]"); if (by) { peopleBy = by.dataset.by; renderPeople(); decorateTables(els.pane); return; }
    const reg = t.closest("[data-reg]"); if (reg) { regShow = reg.dataset.reg; renderRegulars(); decorateTables(els.pane); return; }
    const hide = t.closest("[data-hide]");
    if (hide) { hidden[hide.dataset.hide] = hide.dataset.last; await host.storage.local.set("hiddenRegulars", hidden).catch(() => {}); renderAttention(); renderRegulars(); decorateTables(els.pane); return; }
    const unhide = t.closest("[data-unhide]");
    if (unhide) { delete hidden[unhide.dataset.unhide]; await host.storage.local.set("hiddenRegulars", hidden).catch(() => {}); renderAttention(); renderRegulars(); decorateTables(els.pane); return; }
    const who = t.closest("[data-who]");
    if (who) { Object.assign(f, { win: who.dataset.who, job: "" }); setTab("orders"); return; }
    const job = t.closest("[data-job]");
    if (job) { Object.assign(f, { job: job.dataset.job, win: "" }); setTab("orders"); return; }
    const area = t.closest("[data-area]");
    if (area) { f.area = area.dataset.area; setTab("items"); return; }
    const head = t.closest(".gn-cart-head");
    if (head) {
      const id = head.closest("[data-cart]").dataset.cart;
      open.has(id) ? open.delete(id) : open.add(id);
      const art = head.closest(".gn-cart");
      const c = data.carts[id];
      art.outerHTML = cartRow(c, !["new", "old"].includes(orderSort));
      decorateTables(els.pane);
      return;
    }
    const row = t.closest(".gn-items tr[data-cart]");
    if (row) { open.add(row.dataset.cart); f.q = row.dataset.cart; setTab("orders"); }
  });

  els.pane.addEventListener("change", (e) => {
    const sel = e.target.closest("[data-order-sort]");
    if (sel) { orderSort = sel.value; host.storage.local.set("orderSort", orderSort).catch(() => {}); renderOrders(); decorateTables(els.pane); }
  });

  els.csv.addEventListener("click", () => {
    const ls = tab === "regulars" ? null : sortLines(filtered());
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    let rows;
    if (ls) {
      rows = [["Ordered", "Time", "Cart", "Item #", "Item", "Area", "Qty", "UOM", "Unit price", "Total", "Ordered by", "Job title", "WIN", "Status", "Expected", "Delivered", "PO", "Carrier", "Tracking"],
        ...ls.map((l) => { const p = P(l.win); return [l.day, fmtTime(l.at), l.cart, l.art, l.desc, l.area, l.qty, l.uom, l.price, l.net, p.name, p.job, l.win, l.late ? "Late" : l.stale ? STAGE_LABEL.stale : STAGE_LABEL[l.stage], l.eta, l.stage === "delivered" ? (l.arrDay || "yes") : "", l.po, CARRIER[l.carrier] || l.carrier, l.trk]; })];
    } else {
      rows = [["Item #", "Item", "Area", "Status", "Every (days)", "Usual qty", "Times ordered", "Last ordered", "Days since", "Expected", "Usually ordered by", "Last ordered by"],
        ...view.regs.map((r) => [r.art, r.desc, r.area, r.open ? "On order" : REG_STATE[r.state][0], r.gap, r.qty, r.occasions, r.lastDay, r.since, r.dueDay, P(r.usualWin).name, P(r.lastWin).name])];
    }
    const blob = new Blob([rows.map((r) => r.map(q).join(",")).join("\r\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `supply-${tab === "regulars" ? "regular-items" : "orders"}-${Number(data.store)}-${view.today}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  // ── load / refresh ───────────────────────────────────────────────────────
  const unsub = host.messaging.on("progress", (m) => { if (alive && m.payload?.text) status(m.payload.text); });

  async function refresh() {
    els.refresh.disabled = true;
    status("Connecting to MyGNFR…");
    const res = await host.messaging.sendRaw("pull", { days: Number(els.range.value) || 365 }, { timeoutMs: 6 * 60_000 })
      .catch((e) => ({ ok: false, error: String(e?.message || e) }));
    if (!alive) return;
    els.refresh.disabled = false;
    if (!res?.ok) { status(res?.error || "The pull failed.", "error"); return; }
    data = res.data;
    status(res.warnings?.length ? res.warnings.join(" ") : "", res.warnings?.length ? "warn" : "");
    render();
  }
  els.refresh.addEventListener("click", refresh);

  const got = await host.messaging.sendRaw("get", {}).catch(() => null);
  if (!alive) return () => {};
  data = got?.ok ? got.data : null;
  render();
  // Stale or never pulled → refresh in the background of the view.
  if (!data || Date.now() - (data.pulledAt || 0) > 30 * 60_000) refresh();

  return () => {
    alive = false;
    unsub();
    clearTimeout(qTimer);
    link.remove();
  };
}
