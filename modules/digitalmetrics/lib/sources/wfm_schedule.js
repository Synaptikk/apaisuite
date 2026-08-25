// modules/digitalmetrics/lib/sources/wfm_schedule.js
//
// Automated pull of the week's schedule from the Workforce Planning portal.
// Runs in the service worker.
//
// The React state path was discovered live 2026-08-25 (dev/probe-wfm-worker.mjs
// and dev/probe-wfm-fiber.mjs); lib/data/wfm_parse.js documents the shape and
// does the transform. This file is transport + extraction only.
//
// ── Not a port of the donor ────────────────────────────────────────────────
// Downloads\DMtool's polarisExtractSchedule walks the fiber tree accepting the
// first array of >=5 people-shaped objects. That is `workers`, whose ROSTER
// half it then reads — so it returns hundreds of associates and zero shifts,
// and has been doing so silently. Verified 2026-08-25: 351 associates,
// 0 shifts. This goes to workers[i].weekEvents instead, which is where the
// shifts actually live.

import { buildSchedules } from "../data/wfm_parse.js";

const SCHEDULER_URL =
  "https://workforce-planning-portal.us-walmart.prod.polaris.walmart.com/scheduler";

const LOAD_MS   = 90_000;
const READY_MS  = 90_000;
const SETTLE_MS = 6_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Extract worker rows from the scheduler's React state.
 *
 * Serialised into the page, so: no closures, no imports, and every value it
 * returns must be plain JSON. That last point is not incidental — the day
 * wrappers carry LUXON DateTime objects (`isLuxonDateTime`, with `.ts` and
 * `.c{year,month,day,hour,minute}`). Handing those to chrome.scripting means
 * structured-cloning Luxon's whole locale cache and losing the actual instant,
 * so times are flattened to ISO strings here, in the page.
 */
function extractWorkersInPage() {
  const log = [];
  try {
    // ── locate props.workers ────────────────────────────────────────────
    let rootFiber = null;
    for (const el of document.querySelectorAll("*")) {
      const key = Object.keys(el).find(
        (k) => k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance"));
      if (key) { rootFiber = el[key]; break; }
    }
    if (!rootFiber) return { ok: false, reason: "no React fiber on the page", log };

    let workers = null;
    let visited = 0;
    const MAX = 60_000;
    const walk = (fiber) => {
      if (!fiber || workers || visited > MAX) return;
      visited++;
      const p = fiber.memoizedProps;
      if (p && typeof p === "object" && Array.isArray(p.workers) && p.workers.length > 3) {
        workers = p.workers;
        return;
      }
      walk(fiber.child);
      walk(fiber.sibling);
    };
    walk(rootFiber);
    log.push(`fiber nodes visited: ${visited}`);
    if (!workers) return { ok: false, reason: "props.workers not found in the fiber tree", log };
    log.push(`workers: ${workers.length}`);

    // ── time flattening ─────────────────────────────────────────────────
    const pad = (n) => String(n).padStart(2, "0");
    const isoOf = (v) => {
      if (v == null) return null;
      if (typeof v === "string") return v;
      if (typeof v === "object") {
        const c = v.c;
        if (c && Number.isFinite(c.hour)) {
          return `${c.year}-${pad(c.month)}-${pad(c.day)}T${pad(c.hour)}:${pad(c.minute || 0)}:00`;
        }
        if (Number.isFinite(v.ts)) {
          const d = new Date(v.ts);
          return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
                 `T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
        }
      }
      return null;
    };

    // ── week start, taken from the DATA, not from today's date ──────────
    // The donor computed the Saturday from `new Date()`, which quietly made a
    // backfill impossible and mislabelled the week whenever the page was
    // showing anything other than the current one.
    let weekStart = null;
    for (const w of workers) {
      const days = w?.weekEvents?.[0];
      if (!Array.isArray(days)) continue;
      for (let i = 0; i < days.length; i++) {
        const iso = isoOf(days[i]?.startDateTime) || isoOf(days[i]?.shift?.shiftStartDateTime);
        if (!iso) continue;
        const [datePart] = iso.split("T");
        const [y, m, d] = datePart.split("-").map((n) => parseInt(n, 10));
        const dt = new Date(y, m - 1, d - i);          // day i is weekStart + i
        weekStart = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
        break;
      }
      if (weekStart) break;
    }
    log.push(`weekStart from data: ${weekStart}`);

    // ── store number ────────────────────────────────────────────────────
    //
    // `locations[0].locationId` is an INTERNAL location id, not a store
    // number — it came back as 116580 for store 1458 on 2026-08-25, which got
    // written to stores/116580/schedules/* and then added to the store list,
    // where the metrics pull dutifully tried to fetch it and found nothing.
    //
    // The store number is what the page prints ("1458-WMSC"). Take that, and
    // only accept something that is actually store-shaped (<= 5 digits).
    const isStoreNumber = (v) => /^\d{1,5}$/.test(String(v ?? ""));
    let store = null;
    const pageText = document.body?.innerText || "";
    const m = pageText.match(/(\d{3,5})\s*-?\s*WMSC/i) || pageText.match(/Store\s*#?\s*(\d{3,5})\b/i);
    if (m && isStoreNumber(m[1])) store = String(parseInt(m[1], 10));

    // Location id only as a last resort, and only if it could pass for one.
    if (!store) {
      for (const w of workers) {
        const loc = w?.worker?.locations?.[0]?.locationId ?? w?.worker?.jobs?.[0]?.locationId;
        if (isStoreNumber(loc)) { store = String(parseInt(loc, 10)); break; }
      }
    }

    // ── job code → job title ────────────────────────────────────────────
    //
    // `shift.jobName` is a job CODE ("1-936-1451"), not a title — verified
    // 2026-08-25, where classifying on it produced 171 Store Help and zero
    // Digital because nothing could ever match /digital/.
    //
    // The human title exists only in the rendered text, with the code appended
    // ("Digital Personal Shopper 1-936-1451"). Building the mapping from the
    // page keeps this working when a new job code appears, which hardcoding
    // "1-936-1451 means digital" would not.
    const jobTitles = {};
    for (const line of pageText.split("\n")) {
      const m = line.match(/^(.+?)\s+(\d{1,2}-\d{2,3}-\d{3,4})\b/);
      if (!m) continue;
      const title = m[1].trim();
      // Titles are words; a line that is mostly digits is a data row, not a
      // job label.
      if (title.length < 3 || !/[A-Za-z]{3}/.test(title)) continue;
      if (!jobTitles[m[2]]) jobTitles[m[2]] = title;
    }
    log.push(`job titles resolved: ${Object.keys(jobTitles).length}`);

    // ── rows ────────────────────────────────────────────────────────────
    const out = [];
    let shiftTotal = 0;
    for (const w of workers) {
      const person = w?.worker || {};
      // The worker object carries ONE `name` string — verified live 2026-08-25.
      // It does NOT have firstName/lastName; those appear on the separate
      // roster payload the donor mistakenly read, which is why looking for
      // them here silently skipped all 439 workers.
      const name = String(
        person.name ||
        [person.firstName, person.lastName].filter(Boolean).join(" ") ||
        "",
      ).trim();
      if (!name) continue;

      const days = Array.isArray(w?.weekEvents?.[0]) ? w.weekEvents[0] : [];
      const rows = [];
      for (let i = 0; i < days.length; i++) {
        const day = days[i];
        if (!day) continue;
        const shift = day.shift;
        if (!shift) continue;                       // Available / Time Off / LOA
        const start = isoOf(shift.shiftStartDateTime) || isoOf(day.startDateTime);
        const end   = isoOf(shift.shiftEndDateTime)   || isoOf(day.endDateTime);
        if (!start || !end) continue;
        // Resolve the code to its title so classification can read it; keep
        // the code as a fallback rather than losing the field entirely.
        const code = shift.jobName ?? null;
        rows.push({
          index: i, type: "shift", start, end,
          jobName: (code && jobTitles[code]) || code,
          jobCode: code,
        });
        shiftTotal++;
      }
      const workerCode = person.jobs?.[0]?.jobName ?? null;
      if (rows.length) {
        out.push({
          name,
          jobName: (workerCode && jobTitles[workerCode]) || workerCode,
          jobCode: workerCode,
          days: rows,
        });
      }
    }
    log.push(`workers with shifts: ${out.length}, shifts: ${shiftTotal}`);

    return { ok: true, store, weekStart, workers: out, workerTotal: workers.length, log };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e), log };
  }
}

/**
 * Is the scheduler ready — meaning has the DATA arrived, not just the chrome?
 *
 * The donor's check was "page is complete and has >5000 chars of text and >5
 * row-ish elements", which the app satisfies while it is still an empty shell.
 * In a BACKGROUND tab (where this driver runs) that gap is wide, and the
 * result was an extraction that found `props.workers` populated with roster
 * entries whose `weekEvents` had not loaded — reported as
 * "no workers in the extraction" with no clue why.
 *
 * So wait for what is actually needed: at least one worker carrying a shift.
 */
function schedulerReadyInPage() {
  try {
    if (document.readyState !== "complete") return false;

    let workers = null, visited = 0;
    const walk = (f) => {
      if (!f || workers || visited > 60000) return;
      visited++;
      const p = f.memoizedProps;
      if (p && typeof p === "object" && Array.isArray(p.workers) && p.workers.length > 3) { workers = p.workers; return; }
      walk(f.child); walk(f.sibling);
    };
    for (const el of document.querySelectorAll("*")) {
      const k = Object.keys(el).find((k) => k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance"));
      if (k) { walk(el[k]); break; }
    }
    if (!workers) return false;
    return workers.some((w) => (w?.weekEvents?.[0] || []).some((d) => d && d.shift));
  } catch { return false; }
}

/**
 * Why did an extraction come back empty? Distinguish the cases, because their
 * remedies are opposites: a filtered view needs the filter cleared, an
 * unrendered grid needs more time, and an SSO wall needs the user.
 */
function diagnoseInPage() {
  try {
    const text = document.body?.innerText || "";
    const rosterLabel = (text.match(/Roster\s*\((\d+)\)/i) || [])[1];
    let workers = null, visited = 0;
    const walk = (f) => {
      if (!f || workers || visited > 60000) return;
      visited++;
      const p = f.memoizedProps;
      if (p && typeof p === "object" && Array.isArray(p.workers) && p.workers.length > 3) { workers = p.workers; return; }
      walk(f.child); walk(f.sibling);
    };
    for (const el of document.querySelectorAll("*")) {
      const k = Object.keys(el).find((k) => k.startsWith("__reactFiber"));
      if (k) { walk(el[k]); break; }
    }
    const withWeek = (workers || []).filter((w) => Array.isArray(w?.weekEvents?.[0])).length;
    const withShift = (workers || []).filter((w) => (w?.weekEvents?.[0] || []).some((d) => d && d.shift)).length;
    return {
      url: location.href,
      textLength: text.length,
      rosterLabel: rosterLabel ? Number(rosterLabel) : null,
      workers: workers ? workers.length : 0,
      withWeekEvents: withWeek,
      withShifts: withShift,
      // "Clear filters" only renders when at least one filter is active, so its
      // presence is the page telling us the view is scoped.
      filtersActive: /Clear filters/i.test(text),
    };
  } catch (e) { return { error: String(e?.message ?? e) }; }
}

async function waitForTabLoad(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error("the schedule tab was closed");
    if (tab.status === "complete") return;
    await sleep(500);
  }
}

async function waitForReady(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await chrome.scripting.executeScript({
      target: { tabId }, world: "MAIN", func: schedulerReadyInPage,
    }).catch(() => null);
    if (res?.[0]?.result) return true;
    await sleep(1500);
  }
  return false;
}

/**
 * Pull the currently-displayed week's schedule.
 *
 * Only the current week is reachable: the portal renders one week at a time and
 * this reads what is on screen. Backfill would mean driving its week navigation,
 * which is a separate job.
 */
export async function pullSchedule({ onProgress = () => {}, store: expectedStore = null } = {}) {
  onProgress({ phase: "opening" });
  const tab = await chrome.tabs.create({ url: SCHEDULER_URL, active: false });
  try {
    await waitForTabLoad(tab.id, LOAD_MS);
    onProgress({ phase: "rendering" });

    const ready = await waitForReady(tab.id, READY_MS);
    if (!ready) {
      // Say WHICH failure this is rather than offering one guess.
      const d = (await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: "MAIN", func: diagnoseInPage,
      }).catch(() => null))?.[0]?.result;

      if (d && /login|signin|sso|saml/i.test(new URL(d.url || SCHEDULER_URL).hostname)) {
        throw new Error("the portal redirected to sign-in. Open the scheduler in a normal tab, sign in, then retry.");
      }
      if (d?.workers && !d.withShifts) {
        throw new Error(
          `the roster loaded (${d.workers} workers) but no shifts did` +
          (d.filtersActive ? " — and a filter is active on the scheduler, which limits what loads. Clear filters there and retry." : ". The grid had not finished loading."));
      }
      throw new Error(
        `the scheduler never finished rendering (workers: ${d?.workers ?? 0}, text: ${d?.textLength ?? 0} chars).`);
    }
    await sleep(SETTLE_MS);

    onProgress({ phase: "reading" });
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: "MAIN", func: extractWorkersInPage,
    });
    const raw = res?.[0]?.result;
    if (!raw?.ok) throw new Error(raw?.reason || "extraction failed");

    // A filtered view yields a PARTIAL week that would otherwise be stored as
    // if complete. Compare against the page's own roster count and refuse.
    const diag = (await chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: "MAIN", func: diagnoseInPage,
    }).catch(() => null))?.[0]?.result;

    const built = buildSchedules(raw);
    if (!built.ok) {
      throw new Error(
        `${built.reason} (workers seen: ${diag?.workers ?? "?"}, ` +
        `with weekEvents: ${diag?.withWeekEvents ?? "?"}, with shifts: ${diag?.withShifts ?? "?"}` +
        `${diag?.filtersActive ? ", FILTER ACTIVE on the scheduler" : ""})`);
    }
    // The caller usually knows which store this pull is FOR. Trust that over
    // anything scraped, and only use the page's own reading to flag a
    // disagreement — a schedule written under the wrong store id is close to
    // impossible to notice later.
    if (expectedStore) {
      if (built.store && String(built.store) !== String(expectedStore)) {
        built.warnings = [...(built.warnings || []),
          `The scheduler page reported store ${built.store} but this pull is for ${expectedStore}; using ${expectedStore}.`];
      }
      built.pageStore = built.store ?? null;
      built.store = String(expectedStore);
    }
    if (!built.store) throw new Error("could not determine which store this schedule is for");

    built.partial = !!(diag?.rosterLabel && diag.workers && diag.rosterLabel !== diag.workers);
    built.filtersActive = !!diag?.filtersActive;
    if (built.partial) {
      built.warnings = [...(built.warnings || []),
        `The scheduler is showing ${diag.workers} of ${diag.rosterLabel} associates — a filter is active there, so this week is INCOMPLETE.`];
    }

    onProgress({ phase: "done", dates: built.dates.length, shifts: built.associateCount });
    return { ...built, workerTotal: raw.workerTotal, log: raw.log };
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}
