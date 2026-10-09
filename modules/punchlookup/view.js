// modules/punchlookup/view.js
//
// Punch Lookup — shell page. Search (service.js::search) → pick a match when
// there is more than one → load the range (service.js::load) → one report
// rendered from lib/report.js, which is also what Print, Copy for email and
// CSV hand out. The punch result lives in this closure only.
//
// Shared cases: "Start shared case" turns the loaded range into a case folder
// in the user's OneDrive (case_service.js); the Cases list shows the user's
// own cases plus any shared case they opened by link, and a case opens in
// case_view.js. The opened-by-link list (folder refs only) is the one thing
// kept in browser storage.

import { reportHtml, reportText, reportCsv } from "./lib/report.js";
import { printHtml } from "./review_view.js";
import { openCase, AP_TEAM } from "./case_view.js";
import { mountAudit } from "./audit_view.js";

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const OPENED = "openedCases";

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
    form: $("#punchlookup-form"), q: $("#punchlookup-q"), from: $("#punchlookup-from"), to: $("#punchlookup-to"),
    find: $("#punchlookup-find"), msg: $("#punchlookup-msg"), matches: $("#punchlookup-matches"),
    result: $("#punchlookup-result"), paper: $("#punchlookup-paper"),
    hideEmpty: $("#punchlookup-hide-empty"), hideCarry: $("#punchlookup-hide-carry"),
    print: $("#punchlookup-print"), copy: $("#punchlookup-copy"), mail: $("#punchlookup-mail"), csv: $("#punchlookup-csv"),
    startCase: $("#punchlookup-start-case"), lookup: $("#punchlookup-lookup"),
    cases: $("#punchlookup-cases"), casesList: $("#punchlookup-cases-list"), caseLink: $("#punchlookup-case-link"),
    openLink: $("#punchlookup-open-link"), casePane: $("#punchlookup-case"),
    audit: $("#punchlookup-audit"),
  };

  let alive = true;
  let data = null;       // last load + { person }
  let matches = [];
  let mine = [];         // my cases (with their case.json)
  let closeCase = null;  // cleanup of the open case screen
  const closeAudit = mountAudit(host, els.audit);   // store punch-edit review (audit_view.js)

  function setRange(days) {
    const to = new Date(); const from = new Date(); from.setDate(to.getDate() - (days - 1));
    els.from.value = iso(from); els.to.value = iso(to);
  }
  setRange(14);
  try {
    const saved = await host.storage.local.get("rangeDays");
    if (saved) setRange(saved);
  } catch { /* default range */ }

  function status(text, kind = "") {
    els.msg.hidden = !text;
    els.msg.textContent = text || "";
    els.msg.className = `pl-status ${kind}`;
  }
  const opts = () => ({ hideEmpty: els.hideEmpty.checked, hideCarry: els.hideCarry.checked });

  function render() {
    if (!data) { els.result.hidden = true; return; }
    els.result.hidden = false;
    els.paper.innerHTML = reportHtml(data, opts());
    // Map links open in a new tab, not inside the shell.
    for (const a of els.paper.querySelectorAll("a[href]")) { a.target = "_blank"; a.rel = "noopener"; }
    const existing = mine.find((c) => c.meta?.person?.empId === String(data.person.empId));
    els.startCase.textContent = existing ? `Open case: ${existing.title}` : "Start shared case";
    els.startCase.dataset.folder = existing?.folder || "";
  }

  // ── cases ─────────────────────────────────────────────────────────────────
  async function opened() { try { return (await host.storage.local.get(OPENED)) || []; } catch { return []; } }

  async function renderCases() {
    els.casesList.innerHTML = `<p class="pl-muted">Loading cases…</p>`;
    const res = await host.messaging.sendRaw("cases_mine", {}, { timeoutMs: 3 * 60_000 }).catch((e) => ({ ok: false, error: String(e?.message || e) }));
    if (!alive) return;
    mine = res.ok ? res.cases : [];
    const shared = (await opened()).filter((o) => !mine.some((m) => m.folder === o.folder));
    const row = (c, kind) => `<div class="pl-case-row">
      <button type="button" class="pl-case-open" data-site="${esc(c.site)}" data-folder="${esc(c.folder)}">
        <b>${esc(c.meta?.person?.gtaName || c.title)}</b>
        <span>${esc([c.meta?.caseNo && `Case ${c.meta.caseNo}`, c.meta && `${Object.keys(c.meta.days || {}).length} days`, kind === "shared" && c.owner && `from ${c.owner}`, c.readError && `couldn't read its details: ${c.readError}`].filter(Boolean).join(" · "))}</span>
      </button>
      ${kind === "shared" ? `<button type="button" class="pr-del" data-forget="${esc(c.folder)}" title="Remove from this list (doesn't delete the case)">×</button>` : ""}
    </div>`;
    els.casesList.innerHTML = (!res.ok ? `<div class="pl-status error">${esc(res.error)}</div>` : "")
      + `<div class="pl-cases-group"><h3>My cases</h3>${mine.map((c) => row(c, "mine")).join("") || `<p class="pl-muted">None yet. Look up an associate, then <b>Start shared case</b>.${res.ok && res.site ? `<br><small>Looked in ${esc(res.site)}/Documents/Punch Lookup Cases</small>` : ""}</p>`}</div>`
      + `<div class="pl-cases-group"><h3>Shared with me</h3>${shared.map((c) => row(c, "shared")).join("") || `<p class="pl-muted">Paste a case link below to open a case someone shared with you.</p>`}</div>`;
    if (data) render();
  }

  async function showCase(ref) {
    els.lookup.hidden = true; els.cases.hidden = true; els.audit.hidden = true; els.casePane.hidden = false;
    closeCase?.();
    closeCase = await openCase(host, els.casePane, ref, async () => {
      closeCase?.(); closeCase = null;
      els.casePane.hidden = true; els.casePane.innerHTML = "";
      els.lookup.hidden = false; els.cases.hidden = false; els.audit.hidden = false;
      await renderCases();
    });
    window.scrollTo?.(0, 0);
  }

  els.casesList.addEventListener("click", async (e) => {
    const f = e.target.closest("[data-forget]")?.dataset.forget;
    if (f) { await host.storage.local.set(OPENED, (await opened()).filter((o) => o.folder !== f)); renderCases(); return; }
    const b = e.target.closest(".pl-case-open");
    if (b) showCase({ site: b.dataset.site, folder: b.dataset.folder });
  });

  async function openByLink() {
    const text = els.caseLink.value.trim();
    if (!text) return;
    els.openLink.disabled = true;
    const res = await host.messaging.sendRaw("resolve_link", { text }, { timeoutMs: 3 * 60_000 }).catch((e) => ({ ok: false, error: String(e?.message || e) }));
    els.openLink.disabled = false;
    if (!res.ok) { host.ui.toast(res.error, { kind: "error" }); return; }
    const list = (await opened()).filter((o) => o.folder !== res.ref.folder);
    list.unshift({ site: res.ref.site, folder: res.ref.folder, title: res.ref.title, meta: { person: { gtaName: res.meta.person?.gtaName }, caseNo: res.meta.caseNo, days: res.meta.days ? Object.fromEntries(Object.keys(res.meta.days).map((k) => [k, 1])) : {} }, owner: res.meta.owner?.name || "" });
    await host.storage.local.set(OPENED, list.slice(0, 30));
    els.caseLink.value = "";
    showCase(res.ref);
  }
  els.openLink.addEventListener("click", openByLink);
  els.caseLink.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); openByLink(); } });

  els.startCase.addEventListener("click", async () => {
    if (!data) return;
    if (els.startCase.dataset.folder) { showCase({ site: mine.find((c) => c.folder === els.startCase.dataset.folder).site, folder: els.startCase.dataset.folder }); return; }
    const days = data.days.filter((d) => d.punches.some((p) => !p.system));
    if (!days.length) { host.ui.toast("No worked days in this range.", { kind: "error" }); return; }
    els.startCase.disabled = true; els.startCase.textContent = "Creating the case in your OneDrive…";
    const team = (await host.storage.local.get(AP_TEAM).catch(() => null)) || [];
    const res = await host.messaging.sendRaw("case_create", { person: data.person, days, from: data.from, to: data.to, teamKeys: team.map((p) => p.key) }, { timeoutMs: 2 * 60_000 })
      .catch((e) => ({ ok: false, error: String(e?.message || e) }));
    els.startCase.disabled = false;
    if (!res.ok) { host.ui.toast(res.error, { kind: "error" }); render(); return; }
    host.ui.toast(res.shareError ? `Case created, but sharing with your AP team failed: ${res.shareError} Use Share… to retry.`
      : res.shared ? `Case created and shared with ${team.map((p) => p.name).join(", ")}.`
      : "Case created. Use Share… to add investigators.", { kind: res.shareError ? "error" : "ok" });
    showCase(res.ref);
  });
  renderCases();


  function renderMatches(active) {
    if (matches.length <= 1) { els.matches.hidden = true; return; }
    els.matches.hidden = false;
    els.matches.innerHTML = `<span>${matches.length} matches:</span>` + matches.map((m, i) =>
      `<button type="button" class="pl-match${m.empId === active ? " is-active" : ""}" data-i="${i}">${esc(m.gtaName)}<small>${esc(m.win)}</small></button>`).join("");
  }

  async function load(person) {
    data = null; render(); renderMatches(person.empId);
    status(`Loading ${person.gtaName}'s punches ${els.from.value} → ${els.to.value}…`);
    els.find.disabled = true;
    try {
      const res = await host.messaging.sendRaw("load", { empId: person.empId, from: els.from.value, to: els.to.value }, { timeoutMs: 4 * 60_000 })
        .catch((e) => ({ ok: false, error: String(e?.message || e) }));
      if (!alive) return;
      if (!res.ok) { status(res.error || "The load failed.", "error"); return; }
      data = { ...res, person };
      const n = res.days.reduce((s, d) => s + d.punches.filter((p) => !p.system).length, 0);
      status(n ? "" : `No punches for ${person.gtaName} between ${els.from.value} and ${els.to.value}.`);
      render();
    } finally { els.find.disabled = false; }
  }

  async function find(ev) {
    ev?.preventDefault();
    const q = els.q.value.trim();
    if (!q) return;
    if (els.from.value > els.to.value) { status("The start date is after the end date.", "error"); return; }
    data = null; render(); matches = []; renderMatches();
    status(`Searching the timesheet for "${q}"…`);
    els.find.disabled = true;
    let res;
    try {
      res = await host.messaging.sendRaw("search", { q }, { timeoutMs: 2 * 60_000 })
        .catch((e) => ({ ok: false, error: String(e?.message || e) }));
    } finally { els.find.disabled = false; }
    if (!alive) return;
    if (!res.ok) { status(res.error || "The search failed.", "error"); return; }
    matches = res.matches || [];
    if (!matches.length) { status(`No associate at your store matches "${q}".`, "error"); return; }
    if (matches.length === 1) return load(matches[0]);
    status("Pick the associate.");
    renderMatches();
  }

  els.form.addEventListener("submit", find);
  els.matches.addEventListener("click", (e) => {
    const b = e.target.closest(".pl-match");
    if (b) load(matches[Number(b.dataset.i)]);
  });
  container.querySelectorAll("[data-days]").forEach((b) => b.addEventListener("click", () => {
    const days = Number(b.dataset.days);
    setRange(days);
    host.storage.local.set("rangeDays", days).catch(() => {});
    // A loaded associate reloads for the new range straight away.
    if (data?.person) load(data.person);
  }));
  els.hideEmpty.addEventListener("change", render);
  els.hideCarry.addEventListener("change", render);

  const title = () => `Punches — ${data.person.gtaName} — ${data.from} to ${data.to}`;

  els.print.addEventListener("click", () => {
    if (!data) return;
    printHtml(title(), reportHtml(data, opts()));
  });

  async function copyReport() {
    if (!data) return false;
    try {
      await navigator.clipboard.write([new ClipboardItem({
        "text/html":  new Blob([reportHtml(data, opts())], { type: "text/html" }),
        "text/plain": new Blob([reportText(data, opts())], { type: "text/plain" }),
      })]);
      host.ui.toast("Copied — paste into the email body.", { kind: "ok" });
      return true;
    } catch (e) {
      host.ui.toast(`Copy failed: ${e.message}`, { kind: "error" });
      return false;
    }
  }
  els.copy.addEventListener("click", copyReport);

  els.mail.addEventListener("click", async () => {
    if (!data) return;
    // mailto bodies are length-capped and plain text, so the formatted report
    // goes on the clipboard and the new email only carries the subject.
    const copied = await copyReport();
    window.location.href = `mailto:?subject=${encodeURIComponent(title())}&body=${encodeURIComponent(copied ? "(press Ctrl+V to paste the punch report)\n" : "")}`;
  });

  els.csv.addEventListener("click", () => {
    if (!data) return;
    const blob = new Blob([reportCsv(data, opts())], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `punches-${data.person.gtaName.replace(/[^A-Za-z]+/g, "-").replace(/^-|-$/g, "")}-${data.from}-to-${data.to}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  });

  els.q.focus();
  return () => { alive = false; closeCase?.(); closeAudit(); link.remove(); data = null; };
}
