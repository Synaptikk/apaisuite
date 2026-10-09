// modules/digitalschedule/lib/page.js
//
// In-page half of the Digital Schedule module. Handed to
// chrome.scripting.executeScript({ world: "MAIN", func: wfmInPage, args: [args] })
// against the Polaris scheduler tab (workforce-planning-portal…/scheduler).
// Same code as .claude/skills/wfm-schedule/scripts/page.js (the CLI evaluates
// that one over CDP); keep the two in step.
//
// Serialised into the page: no imports, no closures over module scope. The
// result goes through JSON so no Luxon object reaches structured clone.
//
// args.cmd: week {wk} | read | readback {who[]} | validate {changes[]} |
//           save {changes[], allowWarnings, allowSkips}

export async function wfmInPage(ARGS) {
  const run = async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const DAYS = ["SATURDAY", "SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];
  const SHORT = ["sat", "sun", "mon", "tue", "wed", "thu", "fri"];

  // --- page plumbing: React root -> Redux store, the `workers` prop, the remote's webpack modules
  // Find the React root holding the scheduler's Redux store. Polaris mounts the
  // scheduler after the page reports "complete" (and after any sign-in bounce),
  // so wait for it; check every root, and cache only one that has the store.
  const rootNodes = () => { const out = new Set();
    for (const el of document.querySelectorAll("body, body *")) for (const k of Object.keys(el)) {
      if (k.startsWith("__reactContainer")) { const f = el[k]; if (f?.stateNode?.current) out.add(f.stateNode); }
      else if (k === "_reactRootContainer") { const r = el[k], n = r?._internalRoot || r; if (n?.current) out.add(n); } }
    if (!out.size) for (const el of document.querySelectorAll("body *")) { const k = Object.keys(el).find((k) => k.startsWith("__reactFiber")); if (k) { let f = el[k]; while (f.return) f = f.return; if (f.stateNode?.current) out.add(f.stateNode); break; } }
    return [...out]; };
  const walkFrom = (top, pred, limit) => { const s = [top]; let n = 0; while (s.length && n < limit) { const f = s.pop(); if (!f) continue; n++; const p = f.memoizedProps; const hit = p && pred(p); if (hit) return hit; s.push(f.sibling, f.child); } return null; };
  const isStore = (p) => p.store && typeof p.store.getState === "function" && p.store.getState()?.scheduler && p.store;
  if (!window.__wfmRoot?.current || !window.__wfmStore) {
    window.__wfmRoot = null; window.__wfmStore = null;
    for (let i = 0; i < 90 && !window.__wfmStore; i++) {
      for (const node of rootNodes()) { const s = walkFrom(node.current, isStore, 200000); if (s) { window.__wfmRoot = node; window.__wfmStore = s; break; } }
      if (!window.__wfmStore) await sleep(1000);
    }
  }
  const walk = (pred, limit = 200000) => walkFrom(window.__wfmRoot.current, pred, limit);
  const store = window.__wfmStore;
  if (!store) return { error: /login|signin|sso|pingfed/i.test(location.href) || /sign in/i.test(document.body?.innerText?.slice(0, 2000) || "")
    ? "The scheduler tab is on a sign-in page — press “Show scheduler”, sign in, then try again."
    : `The scheduler's data never appeared in that tab after 90 s (${location.pathname}). Press “Show scheduler”, wait for the grid to show, then try again.` };
  const state = () => store.getState();
  const ctx = () => { const s = state(), sel = s.selections?.calendar?.value || s.calendar.selection, h = s.hierarchy.selection;
    return { weekStart: sel.startOfWeekDate, weekEnd: sel.endOfWeekDate, wk: sel.fiscalWeek, fiscalYear: sel.fiscalYear,
      locationId: h.currentLocationId, store: h.store, locationName: String(h.store).padStart(5, "0"), site: s.hierarchy.locations?.siteName }; };
  const workersFor = (weekStart) => walk((p) => Array.isArray(p.workers) && p.workers.length > 3 &&
    p.workers.some((x) => String(x.weekEvents?.[0]?.[0]?.startDateTime?.toISODate?.() ?? "") === weekStart) && p.workers, 150000);
  const waitWeek = async (weekStart) => { for (let i = 0; i < 90; i++) { const s = state(), d = s.scheduler.scheduleLaborDemand;
      if (ctx().weekStart === weekStart && d.status === "Success" && (d.data || []).some((x) => String(x.startTime).startsWith(weekStart)) && workersFor(weekStart)) return true;
      await sleep(1000); } return false; };
  let req; self.webpackChunk_polaris_scheduler_ui.push([[Symbol("wfm")], {}, (r) => { req = r; }]);
  const api = req(24941), lux = req(10930).c9, blocks = req(16463);

  const nm = (w) => w.name && (w.name.firstName ? w.name.firstName + " " + w.name.lastName : String(w.name));
  const hm = (s) => { const m = String(s).match(/T(\d\d):(\d\d)/); return +m[1] * 60 + +m[2]; };
  const fmt = (m) => String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, "0") + ":" + String(((m % 60) + 60) % 60).padStart(2, "0");
  const isoOf = (v) => v == null ? null : typeof v === "string" ? v : v.toISO ? v.toISO({ includeOffset: false, suppressMilliseconds: true }) : String(v);

  // ---------------------------------------------------------------- week
  if (ARGS.cmd === "week") {
    const want = String(ARGS.wk);
    if (String(ctx().wk) !== want) {
      const opener = [...document.querySelectorAll("button")].find((b) => /^WK \d+/.test(b.textContent.trim()));
      if (!opener) return { error: "WK picker button not found" };
      if (!document.querySelector('[aria-label^="Week WK"]')) { opener.click(); await sleep(1500); }
      const card = document.querySelector(`[aria-label^="Week WK ${want},"]`);
      if (!card) return { error: `WK ${want} not in the picker`, available: [...document.querySelectorAll('[aria-label^="Week WK"]')].map((e) => e.getAttribute("aria-label")) };
      card.click(); await sleep(800);
      const ok = [...document.querySelectorAll("button")].find((b) => /^(apply|done|ok|select)$/i.test(b.textContent.trim())); if (ok) ok.click();
      for (let i = 0; i < 30 && String(ctx().wk) !== want; i++) await sleep(500);
    }
    const c = ctx();
    if (String(c.wk) !== want) return { error: `week did not switch (still WK ${c.wk})` };
    if (!(await waitWeek(c.weekStart))) return { error: "week selected but schedule/demand never finished loading", ctx: c };
    return { ctx: c };
  }

  const c = ctx();
  if (!(await waitWeek(c.weekStart))) return { error: "schedule/demand for the selected week did not load", ctx: c };
  const workers = workersFor(c.weekStart);
  const DATES = DAYS.map((_, i) => lux.fromISO(c.weekStart).plus({ days: i }).toISODate());
  const at = (di, m) => lux.fromISO(DATES[di]).plus({ minutes: m }).toISO({ suppressMilliseconds: true, includeOffset: false });
  const eventsOn = (x, di) => (x.weekEvents || []).map((row) => row?.[di]).filter(Boolean);
  const shiftsOn = (x, di) => eventsOn(x, di).filter((e) => e.type === "SHIFT" && e.shift);
  const brk = (b) => ({ start: b.startDate.slice(11, 16), end: b.endDate.slice(11, 16), paid: b.paidInd === "Y" });

  // ---------------------------------------------------------------- read
  if (ARGS.cmd === "read") {
    const avail = (w) => { const recs = (w.availability?.trueAvailabilityRecords || []).filter((r) => r.effectiveDate <= c.weekEnd).sort((a, b) => (a.effectiveDate < b.effectiveDate ? 1 : -1));
      const r = recs[0]; if (!r) return null; const wk = r.weeks?.[0] || {};
      return Object.fromEntries(DAYS.map((d, i) => { const v = wk[d]; return [SHORT[i], !v ? null : v.unavailable ? "off" : (v.timeSlots || []).map((t) => { const s = hm("T" + t.startTime); return fmt(s) + "-" + fmt(s + t.duration); }).join(",") || "any"]; })); };
    const exc = (w) => (w.availabilityExceptions?.generalAvailabilityExceptions || []).filter((e) => String(e.endDateTime) >= c.weekStart && String(e.beginDateTime) <= c.weekEnd + "T23:59")
      .map((e) => ({ from: isoOf(e.beginDateTime), to: isoOf(e.endDateTime), unavailable: e.unavailable ?? e.isUnavailable ?? null, slots: e.timeSlots ?? null }));
    const out = workers.map((x) => { const w = x.worker;
      const shifts = DAYS.flatMap((_, di) => shiftsOn(x, di).map((e) => ({ day: DATES[di], dow: SHORT[di], shiftId: e.shift.shiftId, job: e.shift.jobName,
        start: e.shift.shiftStartDateTime.slice(11, 16), end: e.shift.shiftEndDateTime.slice(11, 16), breaks: (e.shift.breaks || []).map(brk) })));
      const other = DAYS.flatMap((_, di) => eventsOn(x, di).filter((e) => e.type !== "SHIFT" && e.type !== "AVAIL").map((e) => ({ day: DATES[di], type: e.type })));
      return { workerId: w.workerId, name: nm(w), job: w.job, payType: w.payType, employmentType: w.employmentType, minor: w.minorStatus ?? null,
        weekTotal: x.weekTotal ?? null, availability: avail(w), exceptions: exc(w), shifts, otherEvents: other }; });
    const demand = (state().scheduler.scheduleLaborDemand.data || []).map((d) => ({ roleId: d.laborRoleId, start: d.startTime, fte: d.fullTimeEquivalent, adjusted: d.adjustedFullTimeEquivalent }));
    return { ctx: c, dates: DATES, demand, workers: out };
  }

  // ---------------------------------------------------------------- readback (server copy, via the scheduler's own GET)
  if (ARGS.cmd === "readback") {
    const out = {};
    const ids = (ARGS.who || []).map((q) => typeof q === "number" || /^\d+$/.test(q) ? +q : workers.find((w) => nm(w.worker).toLowerCase() === String(q).toLowerCase())?.worker.workerId).filter(Boolean);
    for (const id of ids) { const d = await api.Zv(lux.fromISO(DATES[0]), lux.fromISO(DATES[6]), id);
      const shifts = (Array.isArray(d) ? d : [d]).flatMap((s) => s?.shifts || []).filter((s) => s.workerId === id || s.workerId == null);
      out[id] = shifts.map((s) => ({ day: s.shiftStartDateTime.slice(0, 10), shiftId: s.shiftId, job: s.jobName, start: s.shiftStartDateTime.slice(11, 16), end: s.shiftEndDateTime.slice(11, 16), breaks: (s.breaks || []).map(brk) })); }
    return { ctx: c, readback: out };
  }

  // ---------------------------------------------------------------- validate / save
  if (ARGS.cmd !== "validate" && ARGS.cmd !== "save") return { error: "unknown cmd " + ARGS.cmd };
  const dayIdx = (d) => { if (d == null) return -1; const s = String(d).toLowerCase(); const i = DATES.indexOf(s); return i >= 0 ? i : SHORT.indexOf(s.slice(0, 3)); };
  const toMin = (t) => { const m = String(t).match(/^(\d{1,2}):(\d\d)$/); return m ? +m[1] * 60 + +m[2] : NaN; };
  const shiftBlockIndex = (s, e) => blocks._o({ shiftStart: lux.fromISO(s), shiftEnd: lux.fromISO(e), shiftBlocks: state().scheduler.shiftBlocks.data });
  const common = { offsiteTypeId: null, shiftUpdateReasonId: null, shiftModRequestId: null };
  const byWorker = new Map(), base = new Map(), skipped = [], applied = [];
  const push = (map, w, sh) => { if (!map.has(w.workerId)) map.set(w.workerId, { workerId: w.workerId, name: w.name, payType: w.payType, shifts: [] }); map.get(w.workerId).shifts.push(sh); };
  const noop = (e) => ({ isDeleted: false, shiftId: e.shift.shiftId, breaks: (e.shift.breaks || []).map((b) => ({ paidInd: b.paidInd, startDate: b.startDate, endDate: b.endDate })), jobId: e.shift.jobId, jobName: e.shift.jobName,
    shiftStartDateTime: e.shift.shiftStartDateTime, shiftEndDateTime: e.shift.shiftEndDateTime, shiftBlockIndex: shiftBlockIndex(e.shift.shiftStartDateTime, e.shift.shiftEndDateTime), tempId: e.tempId, shiftTemplateId: e.shift.shiftTemplateId, ...common });
  const touched = new Set(); // "workerId|day" already consumed by an earlier change, so two changes can't both claim it

  ARGS.changes.forEach((ch, idx) => {
    const tag = `#${idx} ${ch.name || ch.workerId} ${ch.action} ${ch.day}${ch.from ? " " + ch.from : ""}`;
    const fail = (why) => skipped.push({ idx, change: tag, why });
    const x = workers.find((w) => (ch.workerId && w.worker.workerId === ch.workerId) || (ch.name && nm(w.worker).toLowerCase() === String(ch.name).toLowerCase()));
    if (!x) return fail("associate not found on this week's schedule");
    const w = x.worker, action = ch.action;
    if (!["edit", "move", "delete", "create"].includes(action)) return fail("action must be edit | move | delete | create");
    const di = dayIdx(ch.day); if (di < 0) return fail(`day ${ch.day} is not in the selected week ${DATES[0]}..${DATES[6]}`);
    const ti = action === "move" ? dayIdx(ch.toDay) : di; if (ti < 0) return fail(`toDay ${ch.toDay} is not in the selected week`);

    let ev = null;
    if (action !== "create") {
      const cands = shiftsOn(x, di).filter((e) => (!ch.from || hm(e.shift.shiftStartDateTime) === toMin(ch.from)) && (!ch.job || e.shift.jobName === ch.job));
      if (cands.length === 0) return fail(`no ${ch.job ? ch.job + " " : ""}shift starting ${ch.from || "(any)"} on ${DATES[di]} — schedule changed?`);
      if (cands.length > 1) return fail(`${cands.length} shifts match on ${DATES[di]}; add "from" and/or "job"`);
      ev = cands[0];
      if (ch.expectEnd && hm(ev.shift.shiftEndDateTime) !== toMin(ch.expectEnd)) return fail(`shift now ends ${ev.shift.shiftEndDateTime.slice(11, 16)}, expected ${ch.expectEnd} — schedule changed?`);
    }
    if (action === "move" || action === "create") {
      const busy = eventsOn(x, ti).filter((e) => e.type !== "AVAIL" && !(action === "move" && e === ev) && !(e.type === "SHIFT" && ch.allowSecondShift));
      if (busy.length && !ch.force) return fail(`${DATES[ti]} is not free (${busy.map((e) => e.type).join(",")}); pass "force": true to try anyway`);
    }
    const key = w.workerId + "|" + ti; if (action !== "delete" && touched.has(key) && !ch.allowSecondShift) return fail(`another change already lands on ${DATES[ti]} for this associate`);

    const orig = ev && { day: DATES[di], start: fmt(hm(ev.shift.shiftStartDateTime)), end: fmt(hm(ev.shift.shiftEndDateTime)), job: ev.shift.jobName, breaks: (ev.shift.breaks || []).map(brk) };
    if (action === "delete") {
      push(byWorker, w, { isDeleted: true, shiftId: ev.shift.shiftId, shiftStartDateTime: ev.shift.shiftStartDateTime, tempId: ev.tempId, shiftTemplateId: ev.shift.shiftTemplateId, ...common });
      push(base, w, noop(ev)); touched.add(w.workerId + "|" + di);
      applied.push({ idx, workerId: w.workerId, name: nm(w), action, orig, next: null }); return;
    }

    // new times
    const s0 = ch.start != null ? toMin(ch.start) : ev ? hm(ev.shift.shiftStartDateTime) : NaN;
    let e0 = ch.end != null ? toMin(ch.end) : ev ? hm(ev.shift.shiftEndDateTime) : NaN;
    if (!Number.isFinite(s0) || !Number.isFinite(e0)) return fail("start/end must be HH:MM");
    if (e0 <= s0) e0 += 1440;
    const len = e0 - s0;
    // breaks: explicit list > lunch shorthand > carry the old breaks along with the shift
    let breaks;
    if (Array.isArray(ch.breaks)) breaks = ch.breaks.map((b) => { let bs = toMin(b.start), be = toMin(b.end); if (bs < s0) bs += 1440; if (be <= bs) be += 1440; return { paidInd: b.paid ? "Y" : "N", startDate: at(ti, bs), endDate: at(ti, be) }; });
    else if (ch.lunch === "none" || ch.lunch === null) breaks = [];
    else if (ch.lunch) { let ls = toMin(ch.lunch); if (ls < s0) ls += 1440; breaks = [{ paidInd: "N", startDate: at(ti, ls), endDate: at(ti, ls + 60) }]; }
    else if (ev) { const delta = (ti - di) * 1440 + s0 - hm(ev.shift.shiftStartDateTime);
      breaks = (ev.shift.breaks || []).map((b) => ({ paidInd: b.paidInd, startDate: lux.fromISO(b.startDate).plus({ minutes: delta }).toISO({ suppressMilliseconds: true, includeOffset: false }), endDate: lux.fromISO(b.endDate).plus({ minutes: delta }).toISO({ suppressMilliseconds: true, includeOffset: false }) })); }
    else breaks = [];
    const sIso = at(ti, s0), eIso = at(ti, e0);
    if (breaks.some((b) => b.startDate < sIso || b.endDate > eIso)) return fail("a break falls outside the shift");
    const unpaid = breaks.filter((b) => b.paidInd !== "Y").reduce((a, b) => a + (lux.fromISO(b.endDate).diff(lux.fromISO(b.startDate), "minutes").minutes), 0);
    if (len > 360 && unpaid < 60 && !ch.noLunchOk) return fail(`shift is ${len / 60} h with no 1-hour unpaid lunch (store rule: every shift over 6 h); give "lunch": "HH:MM"`);

    let jobId = ev?.shift.jobId, jobName = ev?.shift.jobName;
    if (action === "create") {
      jobName = ch.job || w.job;
      const src = workers.flatMap((y) => DAYS.flatMap((_, d) => shiftsOn(y, d))).find((e) => e.shift.jobName === jobName);
      if (!src) return fail(`no shift with job ${jobName} on this week to copy a jobId from; pass "jobId"`);
      jobId = ch.jobId ?? src.shift.jobId;
    }
    const next = { day: DATES[ti], start: fmt(s0), end: fmt(e0), job: jobName, breaks: breaks.map((b) => ({ start: b.startDate.slice(11, 16), end: b.endDate.slice(11, 16), paid: b.paidInd === "Y" })) };
    const shape = { breaks, jobId, jobName, shiftStartDateTime: sIso, shiftEndDateTime: eIso, shiftBlockIndex: shiftBlockIndex(sIso, eIso), ...common };
    if (action === "edit") { if (ti !== di) return fail("edit stays on the same day; use move"); push(byWorker, w, { isDeleted: false, shiftId: ev.shift.shiftId, tempId: ev.tempId, shiftTemplateId: ev.shift.shiftTemplateId, ...shape }); push(base, w, noop(ev)); }
    else if (action === "move") { push(byWorker, w, { isDeleted: true, shiftId: ev.shift.shiftId, shiftStartDateTime: ev.shift.shiftStartDateTime, tempId: ev.tempId, shiftTemplateId: ev.shift.shiftTemplateId, ...common });
      push(byWorker, w, { isDeleted: false, shiftId: null, shiftTemplateId: null, ...shape }); push(base, w, noop(ev)); }
    else { push(byWorker, w, { isDeleted: false, shiftId: null, shiftTemplateId: null, ...shape }); const any = DAYS.flatMap((_, d) => shiftsOn(x, d))[0]; if (any && !base.has(w.workerId)) push(base, w, noop(any)); }
    touched.add(key); if (ev) touched.add(w.workerId + "|" + di);
    applied.push({ idx, workerId: w.workerId, name: nm(w), action, orig, next });
  });

  const payload = [...byWorker.values()], basePayload = [...base.values()];
  const result = { ctx: c, dates: DATES, skipped, applied, workers: payload.length, edits: payload.reduce((a, w) => a + w.shifts.length, 0) };
  if (!payload.length) return result;
  const viol = (rows) => (rows || []).flatMap((r) => (r.violations || []).map((v) => ({ workerId: r.workerId, type: v.type, code: v.code, message: v.message, value: v.constraintValue ?? null })));
  const [v, b] = await Promise.all([api.EY(DATES[0], DATES[6], c.locationId, c.locationName, payload), basePayload.length ? api.EY(DATES[0], DATES[6], c.locationId, c.locationName, basePayload) : Promise.resolve({ data: [] })]);
  const after = viol(v.data), before = new Set(viol(b.data).map((x) => x.workerId + "|" + x.code));
  const names = Object.fromEntries(payload.map((w) => [w.workerId, nm(w)]));
  result.hard = after.filter((x) => x.type === "HARD").map((x) => ({ ...x, name: names[x.workerId] }));
  result.newWarnings = after.filter((x) => x.type !== "HARD" && !before.has(x.workerId + "|" + x.code)).map((x) => ({ ...x, name: names[x.workerId] }));
  result.preexistingWarnings = after.filter((x) => x.type !== "HARD" && before.has(x.workerId + "|" + x.code)).length;
  if (ARGS.cmd === "validate") return result;

  if (result.hard.length) return { ...result, saved: false, why: "the scheduler will refuse some changes" };
  if (result.newWarnings.length && !ARGS.allowWarnings) return { ...result, saved: false, why: "new warnings need your OK first" };
  if (skipped.length && !ARGS.allowSkips) return { ...result, saved: false, why: "some changes couldn't be built — fix or remove them first" };
  const saved = await api.qG(lux.fromISO(DATES[0]).toISO(), lux.fromISO(DATES[6]).toISO(), c.locationId, c.locationName, payload);
  result.saved = true;
  result.saveStatus = (Array.isArray(saved) ? saved : []).map((r) => ({ workerId: r.workerId, name: names[r.workerId], status: r.scheduleApiResponse?.status ?? r.status ?? null }));
  result.payload = payload;
  return result;
  };
  try {
    const r = await run();
    return JSON.parse(JSON.stringify(r ?? { error: "no result" }));
  } catch (e) {
    return { error: "page error: " + String(e && (e.stack || e.message) || e).slice(0, 600) };
  }
}
