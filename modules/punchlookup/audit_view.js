// modules/punchlookup/audit_view.js
//
// Store punch-edit review: every associate's punches for a range of days,
// pulled one store-day at a time (service.js::audit_day, ~20 s a day), then
// lib/audit.js finds late clock-ins set back inside the 9-minute grace,
// clock-ins kept exactly on the hour, and punches not clocked live.
//
// Pulled days are cached in browser storage, one key per day (`auditDay:<date>`,
// GPS already dropped in the page), so a re-run only pulls new days. Days in
// the last 14 are re-pulled once per calendar day (edits keep landing for
// days), not every 6 h: that re-pulled half a 28-day range on every run.
// The cached days for the range are shown on open, before any pull.
// (2026-10-09: was one `auditDays` blob rewritten after every day, with save
// failures swallowed; migrated on first open.)

import { analyzeStore, auditCsv, fmtMin, punchName, SOURCE_LABEL, GRACE, BIG_LATE } from "./lib/audit.js";

const OLD_CACHE = "auditDays";
const DAY = (d) => `auditDay:${d}`;
const KEEP_DAYS = 120;
const iso = (d) => d.toLocaleDateString("en-CA");

export function mountAudit(host, root) {
  const esc = host.ui.escapeHtml;
  root.innerHTML = `
    <details class="pa">
      <summary><h2 class="pl-h2">Store punch-edit review</h2>
        <span class="pa-sub">Everyone's punches: late clock-ins set back inside grace, on-the-hour clock-ins, punches not clocked live</span></summary>
      <form class="pl-toolbar pa-form" autocomplete="off">
        <label class="pl-field">From <input class="input pa-from" type="date" required></label>
        <label class="pl-field">To <input class="input pa-to" type="date" required></label>
        <div class="pl-presets" role="group" aria-label="Quick ranges">
          <button type="button" class="btn btn-sm btn-secondary" data-days="14">14 days</button>
          <button type="button" class="btn btn-sm btn-secondary" data-days="28">28</button>
          <button type="button" class="btn btn-sm btn-secondary" data-days="56">56</button>
        </div>
        <label class="pl-check"><input type="checkbox" class="pa-fresh"> Re-pull cached days</label>
        <button class="btn btn-primary pa-run" type="submit">Run review</button>
        <button class="btn btn-secondary pa-stop" type="button" hidden>Stop</button>
      </form>
      <div class="pl-status pa-msg" hidden></div>
      <div class="pa-out" hidden>
        <div class="pa-store"></div>
        <div class="pl-actions">
          <label class="pl-check"><input type="checkbox" class="pa-only" checked> Only associates with a flag or a late set-back</label>
          <input class="input pa-filter" type="search" placeholder="Filter by name">
          <span class="pl-spacer"></span>
          <button type="button" class="btn btn-secondary btn-sm pa-csv">CSV</button>
        </div>
        <div class="pa-tablewrap"><table class="pa-table"><thead></thead><tbody></tbody></table></div>
        <p class="pa-note"></p>
      </div>
    </details>`;
  const $ = (s) => root.querySelector(s);
  const els = { form: $(".pa-form"), from: $(".pa-from"), to: $(".pa-to"), fresh: $(".pa-fresh"), run: $(".pa-run"), stop: $(".pa-stop"),
    msg: $(".pa-msg"), out: $(".pa-out"), store: $(".pa-store"), only: $(".pa-only"), filter: $(".pa-filter"), csv: $(".pa-csv"),
    thead: $(".pa-table thead"), tbody: $(".pa-table tbody"), note: $(".pa-note") };

  const setRange = (days) => {
    const to = new Date(); to.setDate(to.getDate() - 1);
    const from = new Date(to); from.setDate(to.getDate() - (days - 1));
    els.from.value = iso(from); els.to.value = iso(to);
  };
  setRange(28);
  root.querySelectorAll("[data-days]").forEach((b) => b.addEventListener("click", () => setRange(Number(b.dataset.days))));

  let alive = true, stop = false, result = null, open = new Set();
  let sortKey = "lateRescued", sortDir = -1;
  const say = (text, kind = "") => { els.msg.hidden = !text; els.msg.textContent = text || ""; els.msg.className = `pl-status pa-msg${kind ? ` ${kind}` : ""}`; };
  const call = (type, payload, timeoutMs = 3 * 60_000) => host.messaging.sendRaw(type, payload, { timeoutMs })
    .catch((e) => ({ ok: false, error: String(e?.message || e) }));

  // ── Day cache ──
  async function migrateOldCache() {
    let old = null;
    try { old = await host.storage.local.get(OLD_CACHE); } catch { return; }
    if (!old || typeof old !== "object") return;
    try {
      await host.storage.local.set(Object.fromEntries(Object.entries(old).map(([d, v]) => [DAY(d), v])));
      await host.storage.local.remove(OLD_CACHE);
    } catch { /* keep the old blob; read it next time */ }
  }
  async function readDays(dates) {
    const out = {};
    for (const d of dates) {
      try { const v = await host.storage.local.get(DAY(d)); if (v?.rows) out[d] = v; } catch { /* missing */ }
    }
    return out;
  }
  /** Drop cached days beyond the newest KEEP_DAYS. */
  async function pruneDays() {
    try {
      const all = Object.keys(await host.storage.local.get()).filter((k) => k.startsWith("auditDay:")).sort();
      if (all.length > KEEP_DAYS) await host.storage.local.remove(all.slice(0, all.length - KEEP_DAYS));
    } catch { /* next time */ }
  }
  const rangeDates = () => {
    const from = els.from.value, to = els.to.value, dates = [];
    if (!from || !to || from > to) return null;
    for (let d = new Date(`${from}T12:00`); iso(d) <= to; d.setDate(d.getDate() + 1)) dates.push(iso(d));
    return dates;
  };

  async function analyze(dates, cache, store, note) {
    const have = dates.filter((d) => cache[d] && cache[d].store === store);
    if (!have.length) return false;
    say("Reading schedules…");
    const st = await call("audit_starts", { store, dates: have });
    if (!alive) return false;
    result = analyzeStore(have.map((d) => ({ date: d, rows: cache[d].rows })), st.ok ? st.starts : {});
    const oldest = Math.min(...have.map((d) => cache[d].pulledAt || 0));
    result.range = { from: have[0], to: have.at(-1), days: have.length, asked: dates.length, store, schedDays: Object.keys(st.starts || {}).length, oldest };
    say(note || "");
    render();
    return true;
  }

  /** On open: show whatever is cached for the range, no pulling. */
  async function showCached() {
    await migrateOldCache();
    const dates = rangeDates();
    if (!dates || !alive) return;
    const cache = await readDays(dates);
    const stores = [...new Set(Object.values(cache).map((c) => c.store))];
    if (stores.length !== 1) {
      result = null; els.out.hidden = true;
      say(stores.length ? "" : `Nothing cached for this range yet. Run review to pull it (~20 s a day).`);
      return;
    }
    const n = Object.keys(cache).length;
    await analyze(dates, cache, stores[0],
      `Showing ${n} of ${dates.length} days from the cache. Run review to pull ${n < dates.length ? "the rest and " : ""}refresh recent days.`);
  }

  async function run() {
    const dates = rangeDates();
    if (!dates) { say("Pick a start date on or before the end date.", "error"); return; }
    if (dates.length > 93) { say("Pick 93 days or fewer.", "error"); return; }
    stop = false; els.run.disabled = true; els.stop.hidden = false;
    try {
      say("Finding your store team in the timesheet…");
      const team = await call("audit_team", {});
      if (!team.ok) { say(team.error, "error"); return; }
      await migrateOldCache();
      const cache = await readDays(dates);
      const recent = iso(new Date(Date.now() - 14 * 86_400_000));
      const today = iso(new Date());
      const pulledOn = (c) => iso(new Date(c.pulledAt || 0));
      const isNew = (d) => !cache[d] || cache[d].store !== team.store;
      const stale = (d) => isNew(d) || els.fresh.checked || (d >= recent && pulledOn(cache[d]) < today);
      const need = dates.filter(stale);
      const counts = { cached: dates.length - need.length, fresh: need.filter(isNew).length, again: need.filter((d) => !isNew(d)).length };
      const t0 = Date.now();
      let saveError = null, pulled = 0, failed = null;
      for (const [i, d] of need.entries()) {
        if (stop || !alive) break;
        const left = i ? Math.round(((Date.now() - t0) / i) * (need.length - i) / 60_000) : null;
        say(`Loading day ${i + 1} of ${need.length} (${counts.cached} from cache)${left != null ? ` · ~${left} min left` : ""}…`);
        const res = await call("audit_day", { teamId: team.teamId, date: d });
        if (!res.ok) { failed = `${d}: ${res.error}`; break; }
        pulled++;
        cache[d] = { store: team.store, pulledAt: res.pulledAt, rows: res.rows };
        try { await host.storage.local.set(DAY(d), cache[d]); }
        catch (e) { saveError = String(e?.message || e); }
      }
      if (pulled) await pruneDays();
      const bits = [`${counts.cached} day(s) from the cache`, `${pulled} pulled${counts.again ? ` (${counts.again} recent day(s) re-pulled for late edits)` : ""}`];
      if (stop) bits.unshift("Stopped");
      if (failed) bits.push(`stopped at ${failed}`);
      if (saveError) bits.push(`NOT saved to the cache: ${saveError}`);
      const ok = await analyze(dates, cache, team.store, bits.join(" · ") + ".");
      if (!ok) say(failed || "No days pulled.", "error");
      else if (failed || saveError) els.msg.classList.add("error");
    } finally {
      els.run.disabled = false; els.stop.hidden = true;
    }
  }

  const COLS = [
    ["name", "Associate", "text"], ["shifts", "Shifts"], ["lateRescued", `Late ≥${GRACE + 1} set back ≤${GRACE}`, "", "Clock-in submitted 9+ min after the scheduled start but kept within 8 min (no occurrence)"],
    ["lateRescuedBig", `…≥${BIG_LATE} late`], ["rescuedMinutes", "Min set back"], ["lateKept", "Late kept", "", "Clock-ins kept more than 8 min after the scheduled start (occurrence)"],
    ["insChanged", "Ins not live", "", "Clock-ins not clocked live: set in the app, edited, entered or keyed"],
    ["insEditedInGrace", "Edited ins in grace", "", "Edited/keyed clock-ins kept within grace; the real arrival time is not in the data"],
    ["onHourRate", "% ins on :00"], ["nonDevice", "Punches not live"],
  ];

  function render() {
    if (!result) return;
    els.out.hidden = false;
    const s = result.store, r = result.range;
    const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "–");
    els.store.innerHTML = `<b>Store ${esc(r.store)}</b>, ${esc(r.from || "")} to ${esc(r.to || "")} (${r.days} of ${r.asked} days${r.oldest ? `, oldest pull ${esc(new Date(r.oldest).toLocaleString("en-US", { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" }))}` : ""}) ·
      ${s.punches} punches, <b>${pct(s.nonDevice, s.punches)}</b> not clocked live · clock-ins on the hour: <b>${pct(s.insOnHour, s.ins)}</b>`;
    const q = els.filter.value.trim().toUpperCase();
    const rows = result.people
      .filter((p) => !q || p.name.includes(q))
      .filter((p) => !els.only.checked || p.flags.length || p.lateRescued)
      .sort((a, b) => {
        const x = a[sortKey], y = b[sortKey];
        return (typeof x === "string" ? x.localeCompare(y) : x - y) * sortDir || a.name.localeCompare(b.name);
      });
    els.thead.innerHTML = `<tr>${COLS.map(([k, label, , title]) => `<th data-k="${k}"${title ? ` title="${esc(title)}"` : ""} class="${k === sortKey ? "is-sorted" : ""}">${esc(label)}${k === sortKey ? (sortDir < 0 ? " ▾" : " ▴") : ""}</th>`).join("")}<th>Flags</th></tr>`;
    els.tbody.innerHTML = rows.map((p) => {
      const cells = COLS.map(([k]) => {
        if (k === "name") return `<td><button type="button" class="pr-link pa-name" data-name="${esc(p.name)}">${open.has(p.name) ? "▾" : "▸"} ${esc(p.name)}</button></td>`;
        if (k === "onHourRate") return `<td class="num">${p.ins ? `${Math.round(p.onHourRate * 100)}% <small>(${p.insOnHour}/${p.ins})</small>` : ""}</td>`;
        const v = p[k];
        return `<td class="num${(k === "lateRescued" || k === "lateRescuedBig") && v ? " is-alert" : ""}">${v || ""}</td>`;
      }).join("");
      const detail = open.has(p.name) ? `<tr class="pa-detail"><td colspan="${COLS.length + 1}">${eventsTable(p)}</td></tr>` : "";
      return `<tr>${cells}<td class="pa-flags">${p.flags.map((f) => `<span>⚑ ${esc(f)}</span>`).join("")}</td></tr>${detail}`;
    }).join("") || `<tr><td colspan="${COLS.length + 1}" class="pr-empty">Nobody matches.</td></tr>`;
    els.note.textContent = `Grace: up to ${GRACE} min late, no occurrence.`;
  }

  function eventsTable(p) {
    if (!p.events.length) return `<div class="pa-none">Every punch clocked live.</div>`;
    const day = (d) => new Date(`${d}T12:00`).toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" });
    const when = (e) => {
      if (e.pressed != null) return fmtMin(e.pressed);
      if (e.at) return `changed ${e.at.slice(4, 6)}/${e.at.slice(6, 8)} ${fmtMin(Number(e.at.slice(8, 10)) * 60 + Number(e.at.slice(10, 12)))}`;
      return "—";
    };
    return `<table class="pa-ev"><thead><tr><th>Date</th><th>Punch</th><th>How</th><th>Scheduled</th><th>Kept</th><th>Pressed / submitted</th><th>Moved</th><th>Late (pressed → kept)</th></tr></thead><tbody>
      ${p.events.map((e) => {
        const rescued = e.pressedLate != null && e.pressedLate > GRACE && e.keptLate <= GRACE;
        return `<tr class="${rescued ? "is-alert" : ""}"><td>${day(e.date)}</td><td>${punchName(e)}</td><td>${esc(SOURCE_LABEL[e.source] || e.source)}</td>
          <td>${e.start != null ? fmtMin(e.start) : ""}</td><td>${fmtMin(e.kept)}</td><td>${when(e)}</td>
          <td class="num">${e.shift != null && Math.abs(e.shift) >= 1 ? `${e.shift > 0 ? "−" : "+"}${Math.abs(e.shift)} min` : ""}</td>
          <td>${e.keptLate != null ? `${e.pressedLate != null ? `${e.pressedLate} → ` : ""}${e.keptLate} min` : ""}</td></tr>`;
      }).join("")}</tbody></table>`;
  }

  els.form.addEventListener("submit", (e) => { e.preventDefault(); run(); });
  els.stop.addEventListener("click", () => { stop = true; say("Stopping after this day…"); });
  els.only.addEventListener("change", render);
  els.filter.addEventListener("input", render);
  els.thead.addEventListener("click", (e) => {
    const k = e.target.closest("th")?.dataset.k;
    if (!k) return;
    if (k === sortKey) sortDir = -sortDir; else { sortKey = k; sortDir = k === "name" ? 1 : -1; }
    render();
  });
  els.tbody.addEventListener("click", (e) => {
    const b = e.target.closest(".pa-name");
    if (!b) return;
    const n = b.dataset.name;
    if (open.has(n)) open.delete(n); else open.add(n);
    render();
  });
  els.csv.addEventListener("click", () => {
    if (!result) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([auditCsv(result)], { type: "text/csv" }));
    a.download = `punch-edit-review-${result.range.store}-${result.range.from}-to-${result.range.to}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  });

  showCached().catch(() => {});
  // A new range shows its cached days straight away too.
  const reshow = () => { if (!els.run.disabled) showCached().catch(() => {}); };
  els.from.addEventListener("change", reshow); els.to.addEventListener("change", reshow);
  root.querySelectorAll("[data-days]").forEach((btn) => btn.addEventListener("click", reshow));
  return () => { alive = false; stop = true; };
}
