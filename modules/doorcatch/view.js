// modules/doorcatch/view.js
//
// Door Catches — shell page. Lists the store's catches for a date range
// (service.js::list → QRCallBox), filters by status and host, and reviews each
// one in place: a note plus Reviewed / Dismiss (or Reopen). Setup holds the
// store, the review key, the door key (only used to show the door link) and
// the host-name list the door page offers.

import { catchesCsv } from "./lib/api.js";

const STATUS_LABEL = { new: "Open", reviewed: "Reviewed", dismissed: "Dismissed" };
const MONEY = (n) => "$" + (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
    from: $("#doorcatch-from"), to: $("#doorcatch-to"), status: $("#doorcatch-status"), hostSel: $("#doorcatch-host"),
    refresh: $("#doorcatch-refresh"), export: $("#doorcatch-export"), msg: $("#doorcatch-status-msg"),
    summary: $("#doorcatch-summary"), rows: $("#doorcatch-rows"), setup: $("#doorcatch-setup"),
    settings: $("#doorcatch-settings"), store: $("#doorcatch-store"), reviewKey: $("#doorcatch-review-key"),
    submitKey: $("#doorcatch-submit-key"), linkBox: $("#doorcatch-link-box"), link: $("#doorcatch-link"),
    copy: $("#doorcatch-copy"), hostsForm: $("#doorcatch-hosts-form"), hosts: $("#doorcatch-hosts"),
    cntCatches: $("#doorcatch-cnt-catches"), cntHosts: $("#doorcatch-cnt-hosts"), hostRows: $("#doorcatch-host-rows"),
    panelCatches: $("#doorcatch-panel-catches"), panelHosts: $("#doorcatch-panel-hosts"),
  };

  let data = null;          // last list response
  let info = {};            // upc → item_lookup entry (name, picture, link)
  let lookupNote = "";      // why names are missing, when the lookup itself failed
  const notes = new Map();  // catch id → unsaved note text

  // Value of a catch = Walmart online price × qty for the UPCs that have one.
  // A withdrawn catch is worth nothing (the host took it back).
  function catchValue(c) {
    let value = 0, unpriced = 0;
    if (c.withdrawn) return { value, unpriced };
    for (const it of c.items) {
      const p = info[it.upc]?.walmartPrice;
      if (typeof p === "number") value += p * it.qty; else unpriced += it.qty;
    }
    return { value, unpriced };
  }

  const day = (d) => d.toLocaleDateString("en-CA");
  const back = new Date(); back.setDate(back.getDate() - 6);
  els.from.value = day(back);
  els.to.value = day(new Date());

  function status(kind, text) {
    els.msg.hidden = !text;
    els.msg.className = `dc-status ${kind || ""}`;
    els.msg.textContent = text || "";
  }

  async function loadSettings() {
    const s = await host.messaging.sendRaw("get_settings").catch(() => null);
    if (!s?.ok) return null;
    els.store.value = s.storeNbr || "";
    els.reviewKey.placeholder = s.hasReviewKey ? "saved" : "paste the review key";
    els.linkBox.hidden = !s.doorLink;
    els.link.textContent = s.doorLink || "";
    if (!s.storeNbr || !s.hasReviewKey) els.setup.open = true;
    return s;
  }

  async function show(res) {
    data = res;
    els.hosts.value = (res.hosts || []).join("\n");
    const keep = els.hostSel.value;
    const names = [...new Set([...(res.hosts || []), ...res.catches.map((c) => c.host)])].sort((a, b) => a.localeCompare(b));
    els.hostSel.innerHTML = `<option value="">Everyone</option>` + names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
    els.hostSel.value = names.includes(keep) ? keep : "";
    // Cached item details first (no network) so nothing flashes "Looking up…".
    const peek = await host.messaging.sendRaw("peek_items", { upcs: allUpcs() }).catch(() => null);
    if (peek?.ok) info = { ...peek.items, ...info };
    paint();
  }

  async function refresh() {
    els.refresh.disabled = true;
    status("", data ? "Updating…" : "Loading…");
    const res = await host.messaging.sendRaw("list", { from: els.from.value, to: els.to.value }).catch((err) => ({ ok: false, error: String(err?.message || err) }));
    els.refresh.disabled = false;
    if (!res?.ok) {
      // Keep showing what we have; a dropped connection shouldn't blank the page.
      if (!data) paint();
      status("error", res?.error || "Could not load catches.");
      if (/key|store/i.test(res?.error || "")) els.setup.open = true;
      return;
    }
    status("", "");
    await show(res);
    lookup();
  }

  const allUpcs = () => [...new Set((data?.catches || []).flatMap((c) => c.items.map((it) => it.upc)))];

  // Names, pictures and prices come from the SW (go-upc.com → walmart.com,
  // cached per UPC). Only UPCs this page has no entry for are looked up, one
  // at a time, each painted as it lands; a new item never holds up the rest.
  // lookup_items still refreshes a week-old price for cached ones in the
  // background pass at the end.
  let looking = false, lookAgain = false, alive = true;
  async function lookup() {
    if (looking) { lookAgain = true; return; }
    looking = true;
    try {
      do {
        lookAgain = false;
        for (const upc of allUpcs().filter((u) => !info[u])) {
          if (!alive) return;
          const res = await host.messaging.sendRaw("lookup_items", { upcs: [upc] }, { timeoutMs: 2 * 60_000 }).catch(() => null);
          if (res?.ok && res.items[upc]) { info = { ...info, [upc]: res.items[upc] }; paint(); }
        }
        const stale = allUpcs().filter((u) => info[u]?.walmartId && Date.now() - (info[u].priceAt || 0) > 7 * 24 * 3600 * 1000);
        if (stale.length) {
          const res = await host.messaging.sendRaw("lookup_items", { upcs: stale }, { timeoutMs: 5 * 60_000 }).catch(() => null);
          if (res?.ok) { info = { ...info, ...res.items }; paint(); }
        }
      } while (lookAgain);
    } finally {
      looking = false;
    }
  }

  function itemHtml(it) {
    const x = info[it.upc];
    const qty = ` × ${it.qty}${it.typed ? '<span class="dc-typed" title="Typed in by hand, not scanned">typed</span>' : ""}`;
    const upc = `<span class="dc-upc">${esc(it.upc)}</span>`;
    if (!x) return `<li class="dc-item"><span class="dc-thumb dc-thumb-empty"></span><span class="dc-item-text"><span class="dc-muted">Looking up…</span>${upc}${qty}</span></li>`;
    if (x.status !== "found") return `<li class="dc-item"><span class="dc-thumb dc-thumb-empty"></span><span class="dc-item-text"><span class="dc-muted">No product listing for this UPC</span>${upc}${qty}</span></li>`;
    const img = x.img ? `<img class="dc-thumb" src="${esc(x.img)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="dc-thumb dc-thumb-empty"></span>`;
    const meta = x.brand ? esc(x.brand) : "";
    const price = typeof x.walmartPrice === "number"
      ? `<span><span class="dc-price">${MONEY(x.walmartPrice)}</span> <span class="dc-muted">at Walmart${it.qty > 1 ? ` · ${MONEY(x.walmartPrice * it.qty)} for ${it.qty}` : ""}</span></span>`
      : `<span class="dc-muted">No Walmart price found</span>`;
    const links = `<span class="dc-muted"><a href="${esc(x.walmartUrl)}" target="_blank" rel="noopener">walmart.com</a> · <a href="${esc(x.sourceUrl)}" target="_blank" rel="noopener">${esc(x.source)}</a></span>`;
    return `<li class="dc-item">${img}<span class="dc-item-text"><span class="dc-item-name">${esc(x.name)}</span>${upc}${qty}${price}${meta ? `<span class="dc-muted">${meta}</span>` : ""}${links}</span></li>`;
  }

  function visible() {
    if (!data) return [];
    const st = els.status.value, who = els.hostSel.value;
    return data.catches.filter((c) => (st === "all" || c.status === st) && (!who || c.host === who));
  }

  function when(ms, fallbackDay) {
    if (!ms) return fallbackDay || "";
    const tz = data?.timeZone || undefined;
    const d = new Date(ms);
    return `${d.toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "numeric", day: "numeric" })} ${d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" })}`;
  }

  // Door hosts tab: one row per host for the loaded date range, every status.
  // Listed hosts with no catches still get a row so a quiet door shows up.
  function hostRows() {
    const by = new Map();
    const row = (h) => {
      if (!by.has(h)) by.set(h, { host: h, catches: 0, units: 0, value: 0, unpriced: 0, new: 0, reviewed: 0, dismissed: 0, withdrawn: 0, last: 0 });
      return by.get(h);
    };
    for (const h of data?.hosts || []) row(h);
    for (const c of data?.catches || []) {
      const r = row(c.host);
      if (c.withdrawn) { r.withdrawn++; continue; }
      const v = catchValue(c);
      r.catches++; r.units += c.unitCount || 0; r.value += v.value; r.unpriced += v.unpriced;
      r[c.status] = (r[c.status] || 0) + 1;
      r.last = Math.max(r.last, c.caughtAt || 0);
    }
    return [...by.values()].sort((a, b) => b.value - a.value || b.catches - a.catches || a.host.localeCompare(b.host));
  }

  function paintHosts() {
    const rows = hostRows();
    els.cntHosts.textContent = data ? `(${rows.filter((r) => r.catches).length})` : "";
    if (!rows.length) {
      els.hostRows.innerHTML = `<tr><td colspan="9" class="dc-empty">${data ? "No door hosts yet." : "Nothing loaded."}</td></tr>`;
      return;
    }
    const keys = ["catches", "units", "value", "unpriced", "new", "reviewed", "dismissed", "withdrawn"];
    const sum = rows.reduce((t, r) => { for (const k of keys) t[k] += r[k]; return t; }, Object.fromEntries(keys.map((k) => [k, 0])));
    const val = (r) => `${MONEY(r.value)}${r.unpriced ? ` <span class="dc-muted" title="Items with no Walmart price">+${r.unpriced} unpriced</span>` : ""}`;
    const cells = (r) => `<td class="num">${r.catches}</td><td class="num">${r.units}</td><td class="num">${val(r)}</td>
        <td class="num">${r.new}</td><td class="num">${r.reviewed}</td><td class="num">${r.dismissed}</td><td class="num">${r.withdrawn}</td>`;
    els.hostRows.innerHTML = rows.map((r) => `<tr data-host="${esc(r.host)}"><td>${esc(r.host)}</td>${cells(r)}
        <td>${r.last ? esc(when(r.last)) : '<span class="dc-muted">none</span>'}</td></tr>`).join("") +
      `<tr class="dc-total"><td>All hosts</td>${cells(sum)}<td></td></tr>`;
  }

  function showTab(t) {
    for (const b of container.querySelectorAll(".dc-tab")) b.setAttribute("aria-selected", String(b.dataset.tab === t));
    els.panelCatches.hidden = t !== "catches";
    els.panelHosts.hidden = t !== "hosts";
  }

  function paint() {
    const all = data?.catches || [];
    const live = all.filter((c) => !c.withdrawn);
    const open = live.filter((c) => c.status === "new").length;
    const units = live.reduce((n, c) => n + (c.unitCount || 0), 0);
    const totals = live.reduce((t, c) => { const v = catchValue(c); t.value += v.value; t.unpriced += v.unpriced; return t; }, { value: 0, unpriced: 0 });
    paintHosts();
    els.cntCatches.textContent = data ? `(${visible().length})` : "";
    els.summary.innerHTML = data ? [
      ["Catches", live.length, `${els.from.value} to ${els.to.value}`],
      ["Items", units, "units scanned in total"],
      ["Value", MONEY(totals.value), totals.unpriced ? `Walmart price × qty · ${totals.unpriced} unpriced` : "Walmart price × qty"],
      ["Open", open, "not reviewed yet"],
      ["Door hosts", new Set(live.map((c) => c.host)).size, "see the Door hosts tab"],
    ].map(([l, n, s]) => `<div class="dc-sum"><span class="dc-sum-n">${n}</span><span class="dc-sum-l">${esc(l)}</span><span class="dc-sum-s">${esc(s)}</span></div>`).join("") + (lookupNote ? `<div class="dc-lookup-note">${esc(lookupNote)}</div>` : "") : "";

    const rows = visible();
    if (!rows.length) {
      els.rows.innerHTML = `<tr><td colspan="5" class="dc-empty">${data ? "No catches match." : "Nothing loaded."}</td></tr>`;
      return;
    }
    els.rows.innerHTML = rows.map((c) => {
      const items = c.items.map(itemHtml).join("");
      const note = notes.has(c.id) ? notes.get(c.id) : c.note;
      const actions = c.withdrawn
        ? `<button class="btn btn-secondary btn-sm" data-act="note" data-id="${esc(c.id)}">Save note</button>`
        : c.status === "new"
        ? `<button class="btn btn-primary btn-sm" data-act="reviewed" data-id="${esc(c.id)}">Reviewed</button><button class="btn btn-secondary btn-sm" data-act="dismissed" data-id="${esc(c.id)}">Dismiss</button>`
        : `<button class="btn btn-secondary btn-sm" data-act="note" data-id="${esc(c.id)}">Save note</button><button class="btn btn-secondary btn-sm" data-act="new" data-id="${esc(c.id)}">Reopen</button>`;
      const v = catchValue(c);
      const first = (c.originalItems || []).map((it) => `${it.upc} × ${it.qty}`).join(", ");
      const edited = !c.withdrawn && c.editCount ? `<div class="dc-edited" title="${esc("First saved as: " + first)}">edited by the door host</div>` : "";
      const told = [
        c.register ? `<div><b>Register:</b> ${esc(c.register)}</div>` : "",
        c.hostNote ? `<div><b>Note:</b> ${esc(c.hostNote)}</div>` : "",
      ].join("");
      const badge = c.withdrawn
        ? `<span class="dc-badge withdrawn">Withdrawn</span><div class="dc-muted">by the door host</div>`
        : `<span class="dc-badge ${esc(c.status)}">${esc(STATUS_LABEL[c.status] || c.status)}</span>`;
      const by = c.status !== "new" && !c.withdrawn && (c.reviewer || c.reviewedAt) ? `<div class="dc-muted">${esc(c.reviewer || "")}${c.reviewedAt ? " · " + esc(when(c.reviewedAt)) : ""}</div>` : "";
      return `<tr>
        <td class="dc-when">${esc(when(c.caughtAt, c.day))}</td>
        <td>${esc(c.host)}${told ? `<div class="dc-told">${told}</div>` : ""}</td>
        <td><ul class="dc-items">${items}</ul><div class="dc-muted">${c.unitCount} unit${c.unitCount === 1 ? "" : "s"}${v.value ? ` · <span class="dc-price">${MONEY(v.value)}</span>` : ""}${v.value && v.unpriced ? ` + ${v.unpriced} unpriced` : ""}</div>${edited}</td>
        <td>${badge}${by}</td>
        <td><div class="dc-review"><input class="input" data-note="${esc(c.id)}" value="${esc(note || "")}" placeholder="Note (paid at register, left it, video checked…)" maxlength="1000"><div class="dc-review-actions">${actions}</div></div></td>
      </tr>`;
    }).join("");
  }

  async function review(id, act) {
    const c = data?.catches.find((x) => x.id === id);
    if (!c) return;
    const next = act === "note" ? c.status : act;
    const note = notes.has(id) ? notes.get(id) : c.note;
    const res = await host.messaging.sendRaw("set_review", { id, status: next, note }).catch((err) => ({ ok: false, error: String(err?.message || err) }));
    if (!res?.ok) return status("error", res?.error || "Could not save the review.");
    notes.delete(id);
    await refresh();
  }

  function exportCsv() {
    const rows = visible();
    if (!rows.length) return status("error", "Nothing to export.");
    const blob = new Blob([catchesCsv(rows, data.timeZone, info)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `door-catches-${data.storeNumber}-${els.from.value}-to-${els.to.value}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ── wiring (every listener here is on container-owned nodes) ─────────
  els.refresh.addEventListener("click", refresh);
  els.export.addEventListener("click", exportCsv);
  els.status.addEventListener("change", paint);
  els.hostSel.addEventListener("change", paint);
  container.querySelector(".dc-tabs").addEventListener("click", (e) => {
    const b = e.target.closest(".dc-tab");
    if (b) showTab(b.dataset.tab);
  });
  // Clicking a host shows all of their catches for the range.
  els.hostRows.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-host]");
    if (!tr) return;
    if (![...els.hostSel.options].some((o) => o.value === tr.dataset.host)) return;
    els.hostSel.value = tr.dataset.host;
    els.status.value = "all";
    paint();
    showTab("catches");
  });
  els.rows.addEventListener("input", (e) => { const id = e.target.dataset?.note; if (id) notes.set(id, e.target.value); });
  els.rows.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (b) { b.disabled = true; review(b.dataset.id, b.dataset.act); }
  });
  els.settings.addEventListener("submit", async (e) => {
    e.preventDefault();
    const res = await host.messaging.sendRaw("save_settings", {
      storeNbr: els.store.value, reviewKey: els.reviewKey.value, submitKey: els.submitKey.value,
    }).catch((err) => ({ ok: false, error: String(err?.message || err) }));
    if (!res?.ok) return status("error", res?.error || "Could not save.");
    els.reviewKey.value = ""; els.submitKey.value = "";
    await loadSettings();
    refresh();
  });
  els.copy.addEventListener("click", () => navigator.clipboard.writeText(els.link.textContent).then(() => status("", "Door link copied.")));
  els.hostsForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const hosts = els.hosts.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const res = await host.messaging.sendRaw("set_hosts", { hosts }).catch((err) => ({ ok: false, error: String(err?.message || err) }));
    if (!res?.ok) return status("error", res?.error || "Could not save names.");
    els.hosts.value = res.hosts.join("\n");
    status("", `Saved ${res.hosts.length} host name${res.hosts.length === 1 ? "" : "s"}.`);
  });

  const s = await loadSettings();
  if (s?.storeNbr && s?.hasReviewKey) {
    // Open on the last list this browser loaded (same dates), then update it.
    const last = await host.messaging.sendRaw("cached_list").catch(() => null);
    if (last?.ok && last.from === els.from.value && last.to === els.to.value) await show(last.list);
    refresh();
  } else paint();

  return () => { alive = false; link.remove(); };
}
