// modules/punchlookup/review_view.js
//
// Day editor for a shared case — document what the associate did across one
// day against that day's punches. Everyone's lines show together (with who
// added them); you add and edit only your own, which save to your notes file
// in the case folder. Lines are typed "7:15-7:40 on phone" + Enter (or pasted
// as a block). Rows keep time order, stretches without notes show between
// them (counted as work), totals and flags update live, including when
// another investigator adds a line.
//
// Also home to the small output helpers the case screen shares (print
// window, W&H report window, Excel download).

import { analyzeDay, parseTime, parseQuickLine, fmtTime, fmtDuration, punchLine, TYPES } from "./lib/review.js";
import { breakLabel, reviewPrintHtml, reviewsWorkbook, timeline, totalsOf, whReport, whHtml, whText } from "./lib/review_export.js";
import { dayLabel } from "./lib/report.js";

export function downloadWorkbook(reviews) {
  const p = reviews[0]?.person || {};
  const blob = new Blob([reviewsWorkbook(reviews)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const dates = reviews.map((r) => r.date).sort();
  a.download = `day-review-${String(p.gtaName || "associate").replace(/[^A-Za-z]+/g, "-").replace(/^-|-$/g, "")}-${dates[0]}${dates.length > 1 ? `-to-${dates.at(-1)}` : ""}.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/**
 * Open `body` as its own page. A blob page made here inherits the
 * extension's CSP, so it can't run inline script: printing and the Copy
 * button are driven from this page through the window handle (same origin).
 * `copyText` adds a Print / Copy bar (hidden on paper) instead of opening
 * the print dialog straight away — for the W&H report, which usually gets pasted.
 */
export function printHtml(title, body, { copyText = null } = {}) {
  const bar = copyText == null ? "" : `<div class="bar"><button id="pr">Print / Save as PDF</button>
    <button id="cp">Copy (paste into your report or email)</button><span id="ok"></span></div>`;
  const doc = `<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/</g, "&lt;")}</title>
    <style>@page{margin:11mm} body{margin:0;padding:18px} tr{page-break-inside:avoid} thead{display:table-header-group}
      .bar{font-family:Segoe UI,Arial,sans-serif;margin:0 0 14px;display:flex;gap:8px;align-items:center}
      .bar button{font:inherit;font-size:13px;padding:5px 12px;cursor:pointer} #ok{color:#15803d;font-size:13px}
      @media print{body{padding:0}.bar{display:none!important}}</style></head>
    <body>${bar}<div id="doc">${body}</div></body></html>`;
  const url = URL.createObjectURL(new Blob([doc], { type: "text/html" }));
  const w = window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  if (!w) return;
  w.addEventListener("load", () => {
    const d = w.document;
    if (copyText == null) { setTimeout(() => w.print(), 150); return; }
    d.getElementById("pr").addEventListener("click", () => w.print());
    d.getElementById("cp").addEventListener("click", async () => {
      try {
        await w.navigator.clipboard.write([new w.ClipboardItem({
          "text/html": new w.Blob([d.getElementById("doc").innerHTML], { type: "text/html" }),
          "text/plain": new w.Blob([copyText], { type: "text/plain" }),
        })]);
        d.getElementById("ok").textContent = "Copied";
      } catch (e) { d.getElementById("ok").textContent = `Copy failed: ${e.message}`; }
    });
  });
}

/** The W&H narrative for a case's days, in a Print / Copy window. */
export function openWhReport(reviews) {
  const rep = whReport(reviews);
  printHtml(`W&H review — ${rep.person.gtaName || ""}`, whHtml(rep), { copyText: whText(rep) });
}

/**
 * Open the editor in `root` for one day of the case behind `ctl` (see
 * case_view.js::caseController). `onBack` returns to the case. Returns a
 * cleanup function.
 */
export function openDay(host, root, ctl, date, onBack) {
  const esc = host.ui.escapeHtml;
  const person = ctl.state.meta.person;
  const punches = () => ctl.day(date).punches || [];
  let window_ = analyzeDay([], punches(), date).window;
  const mine = () => ctl.myDay(date);
  let lastType = mine().entries.at(-1)?.type || "Non-work";   // no-notes time already counts as work

  root.innerHTML = `
  <div class="pr">
    <div class="pr-bar">
      <button type="button" class="btn btn-sm btn-secondary" data-act="back">← Case</button>
      <div class="pr-title"><b>${esc(person.gtaName || "")}</b> <span>${esc(dayLabel(date))}</span></div>
      <span class="pr-saved" data-el="saved"></span>
      <label class="pr-done"><input type="checkbox" data-el="done"> I've finished this day</label>
      <button type="button" class="btn btn-sm btn-secondary" data-act="print">Print day</button>
    </div>
    <div class="pr-meta"><div class="pr-punches"><span>Punches</span> <b data-el="punchline"></b></div><div class="pr-people" data-el="people"></div></div>
    <div class="pr-cards" data-el="cards"></div>
    <div class="pr-flags" data-el="flags" hidden></div>
    <div class="pr-table-wrap">
      <table class="pr-table">
        <colgroup><col style="width:2.2em"><col style="width:7.5em"><col style="width:7.5em"><col style="width:3.6em"><col style="width:7.5em"><col style="width:8.5em"><col><col style="width:10em"><col style="width:3em"><col style="width:2em"></colgroup>
        <thead><tr><th>#</th><th>Start</th><th>End</th><th>Min</th><th>Type</th><th>Clock</th><th>Activity observed</th><th>Source / camera</th><th>By</th><th></th></tr></thead>
        <tbody data-el="rows"></tbody>
      </table>
    </div>
    <form class="pr-add" data-el="add" autocomplete="off">
      <textarea class="input pr-text" name="text" rows="1" placeholder="7:15-7:40 standing in the backroom on the phone   ⏎   (or paste many lines at once)"></textarea>
      <div class="pr-types" role="group" title="Type for lines without a w / ? marker">${TYPES.map((t) => `<button type="button" class="pr-type" data-type="${t}">${t}</button>`).join("")}</div>
      <span class="pr-or">or times here:</span>
      <input class="input pr-time" name="start" placeholder="Start">
      <input class="input pr-time" name="end" placeholder="End">
      <input class="input pr-src" name="source" placeholder="Source / camera">
      <button class="btn btn-primary btn-sm" type="submit">Add</button>
    </form>
    <div class="pr-hint">Type a line like <code>7:15-7:40 on phone</code> and press Enter. Paste a list and press Enter to add every line. Lines take the selected type; start one with <code>w</code> for work or <code>?</code> for unclear, and end with <code>@camera</code> for the source. Times: <code>715</code>, <code>7:15</code>, <code>7:15p</code>, <code>19:15</code> (without AM/PM, the time nearest the shift). You can change only your own lines. Amber rows have no notes and count as work.</div>
  </div>`;

  const $ = (sel) => root.querySelector(sel);
  const els = { rows: $('[data-el="rows"]'), cards: $('[data-el="cards"]'), flags: $('[data-el="flags"]'), saved: $('[data-el="saved"]'),
    add: $('[data-el="add"]'), done: $('[data-el="done"]'), punchline: $('[data-el="punchline"]'), people: $('[data-el="people"]') };
  const addF = els.add.elements;

  function setAddType(t) {
    lastType = t;
    els.add.querySelectorAll(".pr-type").forEach((b) => b.classList.toggle("is-on", b.dataset.type === t));
  }
  setAddType(lastType);

  /** Change my entries for this day (fn gets a copy, returns the new list). */
  function editMine(fn, done = mine().done) {
    const next = fn(mine().entries.map((e) => ({ ...e })));
    ctl.setMyDay(date, next, done);
  }
  function autosize(t) { t.style.height = "auto"; t.style.height = `${t.scrollHeight + 2}px`; }

  function render() {
    const day = ctl.day(date);
    els.punchline.textContent = punchLine(day.punches || [], date);
    const a = analyzeDay(day.entries, day.punches || [], date);
    window_ = a.window;
    const t = totalsOf(a);
    const pct = (n) => (t.onClock ? `${Math.round((n / t.onClock) * 100)}%` : "");
    const card = (label, v, cls, sub = "") => `<div class="pr-card ${cls}"><span>${label}</span><b>${fmtDuration(v)}</b><small>${sub}</small></div>`;
    els.cards.innerHTML = card("On the clock", t.onClock, "", t.meal ? `meal ${fmtDuration(t.meal)}` : "")
      + card("Work", t.workOn, "is-work", `${pct(t.workOn)}${t.undocumented ? ` · ${fmtDuration(t.undocumented)} no notes` : ""}`)
      + card("Non-work", t.nonworkOn, "is-nonwork", pct(t.nonworkOn))
      + card("Unclear", t.unclearOn, "is-unclear", pct(t.unclearOn))
      + (t.offClockWork ? card("Work off the clock", t.offClockWork, "is-alert") : "")
      + (t.mealWork ? card("Work during meal", t.mealWork, "is-alert") : "");
    els.flags.hidden = !a.issues.length;
    els.flags.innerHTML = a.issues.map((i) => `<div>⚑ ${esc(i.text)}</div>`).join("");
    const who = [...new Map(day.entries.map((e) => [e.by, e])).values()];
    els.people.innerHTML = who.length ? `<span>On this day</span> ${who.map((e) => `<b class="pr-chip${e.mine ? " is-me" : ""}" title="${esc(e.byName)}">${esc(e.byInitials)}</b> ${esc(e.byName)}`).join(" · ")}${day.doneBy.length ? ` · <span class="pr-donelist">✓ finished: ${esc(day.doneBy.join(", "))}</span>` : ""}` : "";
    els.done.checked = !!mine().done;

    let n = 0;
    els.rows.innerHTML = timeline(a).map((it) => {
      if (it.kind === "break") {
        return `<tr class="pr-break"><td></td><td>${fmtTime(it.g.from)}</td><td>${fmtTime(it.g.to)}</td><td class="num">${it.g.to - it.g.from}</td>
          <td colspan="5">${esc(breakLabel(it.g))}</td><td></td></tr>`;
      }
      if (it.kind === "gap") {
        return `<tr class="pr-gap"><td></td><td>${fmtTime(it.g.from)}</td><td>${fmtTime(it.g.to)}</td><td class="num">${it.g.to - it.g.from}</td>
          <td colspan="5">No notes — counted as work <button type="button" class="pr-link" data-fill="${it.g.from}|${it.g.to}">add notes</button></td><td></td></tr>`;
      }
      const r = it.r; n++;
      const warnClock = r.type === "Work" && (r.clock?.off || r.clock?.meal);
      const ro = r.mine ? "" : " disabled";
      return `<tr class="pr-row t-${(r.type || "Unclear").toLowerCase().replace(/[^a-z]/g, "")}${r.mine ? "" : " is-other"}" data-id="${esc(r.id)}">
        <td class="pr-n">${n}</td>
        <td><input class="pr-cell pr-time" data-f="start" value="${esc(fmtTime(r.start))}"${ro}></td>
        <td><input class="pr-cell pr-time" data-f="end" value="${esc(fmtTime(r.end))}"${ro}></td>
        <td class="num">${r.minutes || ""}</td>
        <td><select class="pr-cell pr-typesel" data-f="type"${ro}>${TYPES.map((x) => `<option${x === r.type ? " selected" : ""}>${x}</option>`).join("")}</select></td>
        <td class="pr-clock${warnClock ? " is-alert" : ""}">${esc(r.clockLabel || "")}</td>
        <td><textarea class="pr-cell pr-text" data-f="text" rows="1"${ro}>${esc(r.text || "")}</textarea>${r.problems.length ? `<div class="pr-problem">⚠ ${esc(r.problems.join("; "))}</div>` : ""}</td>
        <td><input class="pr-cell" data-f="source" value="${esc(r.source || "")}"${ro}></td>
        <td><b class="pr-chip${r.mine ? " is-me" : ""}" title="${esc(r.byName || "")}">${esc(r.byInitials || "")}</b></td>
        <td>${r.mine ? `<button type="button" class="pr-del" title="Delete row" aria-label="Delete row">×</button>` : ""}</td></tr>`;
    }).join("") || `<tr><td colspan="10" class="pr-empty">No activity yet. Type the first line below.</td></tr>`;
    els.rows.querySelectorAll("textarea").forEach(autosize);
  }

  function showSaved() { els.saved.textContent = ctl.saveStatus(); }

  // Remote changes re-render, but never under the cursor of a row being edited.
  let pending = false;
  const unsub = ctl.subscribe(() => {
    showSaved();
    if (els.rows.contains(document.activeElement)) { pending = true; return; }
    render();
  });
  els.rows.addEventListener("focusout", () => setTimeout(() => {
    if (pending && !els.rows.contains(document.activeElement)) { pending = false; render(); }
  }, 0));

  // ── row edits (my rows only; others' are disabled) ──
  const idOf = (el) => el.closest("tr")?.dataset.id;
  els.rows.addEventListener("input", (e) => {
    const f = e.target.dataset.f, id = idOf(e.target);
    if (!id || (f !== "text" && f !== "source")) return;
    if (f === "text") autosize(e.target);
    const v = e.target.value;
    editMine((list) => list.map((x) => (x.id === id ? { ...x, [f]: v, at: Date.now() } : x)));
  });
  els.rows.addEventListener("change", (e) => {
    const f = e.target.dataset.f, id = idOf(e.target);
    if (!id) return;
    let v = e.target.value;
    if (f === "start" || f === "end") {
      v = parseTime(v, window_);
      if (v == null && e.target.value.trim()) { e.target.classList.add("is-bad"); return; }
    } else if (f !== "type") return;
    editMine((list) => list.map((x) => (x.id === id ? { ...x, [f]: v, at: Date.now() } : x)));
    render();
  });
  els.rows.addEventListener("click", (e) => {
    if (e.target.closest(".pr-del")) {
      const id = idOf(e.target);
      editMine((list) => list.filter((x) => x.id !== id));
      render(); return;
    }
    const fill = e.target.closest("[data-fill]");
    if (fill) {
      const [from, to] = fill.dataset.fill.split("|").map(Number);
      addF.start.value = fmtTime(from); addF.end.value = fmtTime(to);
      addF.text.focus();
      els.add.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  });
  els.done.addEventListener("change", () => editMine((list) => list, els.done.checked));

  // ── add bar ──
  els.add.addEventListener("click", (e) => { const b = e.target.closest(".pr-type"); if (b) setAddType(b.dataset.type); });
  function addRow(ev) {
    ev?.preventDefault();
    const now = Date.now();
    // Lines that carry their own times ("7:15-7:40 on phone") go straight in;
    // a pasted block adds every such line. Anything left over stays in the box.
    const lines = addF.text.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const quick = lines.map((l) => parseQuickLine(l, window_, lastType));
    if (quick.some(Boolean)) {
      const added = quick.filter(Boolean).map((q) => ({ id: crypto.randomUUID(), ...q, source: q.source || addF.source.value.trim(), at: now }));
      editMine((list) => [...list, ...added]);
      const left = lines.filter((_, i) => !quick[i]);
      render();
      addF.start.value = fmtTime(Math.max(...added.map((q) => q.end)));
      addF.text.value = left.join("\n"); autosize(addF.text);
      if (left.length) host.ui.toast(`${left.length} line${left.length === 1 ? "" : "s"} had no time range (e.g. 7:15-7:40) and ${left.length === 1 ? "was" : "were"} left in the box.`, { kind: "error" });
      addF.text.focus();
      return;
    }
    const start = parseTime(addF.start.value, window_), end = parseTime(addF.end.value, window_);
    addF.start.classList.toggle("is-bad", start == null);
    addF.end.classList.toggle("is-bad", end == null);
    if (start == null || end == null) { (start == null ? addF.start : addF.end).focus(); return; }
    if (!addF.text.value.trim()) { addF.text.focus(); return; }
    editMine((list) => [...list, { id: crypto.randomUUID(), start, end, text: addF.text.value.trim(), type: lastType, source: addF.source.value.trim(), at: now }]);
    render();
    addF.start.value = fmtTime(end); addF.end.value = ""; addF.text.value = ""; autosize(addF.text);
    addF.text.focus();
  }
  els.add.addEventListener("submit", addRow);
  addF.text.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) addRow(e); });
  addF.text.addEventListener("input", () => autosize(addF.text));
  addF.end.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addF.text.focus(); } });
  addF.start.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addF.end.focus(); } });
  for (const inp of [addF.start, addF.end]) {
    inp.addEventListener("blur", () => {
      const v = parseTime(inp.value, window_);
      if (v != null) { inp.value = fmtTime(v); inp.classList.remove("is-bad"); }
    });
  }

  // ── bar ──
  root.querySelector(".pr-bar").addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "back") { await ctl.flush(); onBack(); }
    else if (act === "print") {
      const day = ctl.day(date);
      printHtml(`Day review — ${person.gtaName} — ${date}`, reviewPrintHtml({
        empId: person.empId, person, date, punches: day.punches || [], entries: day.entries,
        caseNo: ctl.state.meta.caseNo, reviewer: [...new Set(day.entries.map((x) => x.byName))].join(", "),
      }));
    }
  });

  render();
  showSaved();
  const ends = mine().entries.map((x) => x.end).filter((v) => v != null);
  addF.start.value = fmtTime(ends.length ? Math.max(...ends) : window_[0]);
  addF.text.focus();
  return () => { unsub(); ctl.flush(); };
}
