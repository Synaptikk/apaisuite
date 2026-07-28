// modules/metricshot/lib/metrics.js
//
// Pure CRUD + validation for metric configs. Storage is in the SW's
// chrome.storage.sync["metricshot.metrics"] — this file is a Node-testable
// wrapper around that shape, with no dependency on chrome.* APIs.

export const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

export const DEFAULT_CAPTURE = Object.freeze({
  mode: "viewport",
  selector: null,
  requiredSelector: null,
  hideSelectors: [],
  parameterValues: {},
  // For mode:"region":
  //   clip:         { x, y, width, height }  — fixed pixel region, OR
  //   containText:  [ "exact text 1", ... ]  — smallest bounding rect of the
  //                                            first element whose textContent
  //                                            equals each string, computed at
  //                                            capture time (robust to Tableau
  //                                            reflow)
  //   padding:      { top, right, bottom, left } | number
  //                 — extra pixels added around the computed region so we don't
  //                   crop tight against anchor text
  clip: null,
  containText: [],
  padding: { top: 0, right: 0, bottom: 0, left: 0 },
  viewportWidth: 1440,
  viewportHeight: 1000,
  zoom: 1,
  settleDelayMs: 8000,
  timeoutMs: 60000,
  retries: 2,
  catchUpWindowMs: 60 * 60 * 1000,
});

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const HTTPS_RE = /^https:\/\/[^\s]+$/i;
const ID_ALLOWED_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function slugifyName(name) {
  const s = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || `metric-${Date.now().toString(36)}`;
}

// Ensure a new metric id is unique within an existing list. Appends -2, -3, …
export function uniqueId(base, existing) {
  const set = new Set(existing.map((m) => m.id));
  if (!set.has(base)) return base;
  let n = 2;
  while (set.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * Fill in defaults + coerce shapes; caller does I/O.
 * Returns a NEW object — never mutates input.
 */
export function normalizeMetric(m) {
  const out = { ...m };
  out.id       = String(m.id || "").trim();
  out.name     = String(m.name || "").trim();
  out.url      = String(m.url  || "").trim();
  out.enabled  = m.enabled !== false;
  out.timezone = m.timezone || "local";
  out.caption  = String(m.caption || "");

  out.schedules = Array.isArray(m.schedules) ? m.schedules.map(normalizeSchedule) : [];
  out.destination = normalizeDestination(m.destination);
  out.capture = { ...DEFAULT_CAPTURE, ...(m.capture || {}) };
  if (!Array.isArray(out.capture.hideSelectors)) out.capture.hideSelectors = [];
  if (!Array.isArray(out.capture.containText)) out.capture.containText = [];
  else out.capture.containText = out.capture.containText.map((s) => String(s ?? "").trim()).filter(Boolean);
  if (out.capture.clip && typeof out.capture.clip === "object") {
    const c = out.capture.clip;
    out.capture.clip = {
      x: Number(c.x) || 0,
      y: Number(c.y) || 0,
      width: Number(c.width) || 0,
      height: Number(c.height) || 0,
    };
  } else {
    out.capture.clip = null;
  }
  // Normalize padding: number → {top,right,bottom,left}; missing sides default to 0.
  // NOTE: padding may be NEGATIVE to crop *inward* (used by the preview crop
  // tool to trim edges like Tableau's left accent band). capture.js clamps the
  // final clip box to the viewport, so negatives are safe here.
  if (typeof out.capture.padding === "number" && Number.isFinite(out.capture.padding)) {
    const n = out.capture.padding;
    out.capture.padding = { top: n, right: n, bottom: n, left: n };
  } else if (out.capture.padding && typeof out.capture.padding === "object") {
    const p = out.capture.padding;
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    out.capture.padding = {
      top:    num(p.top),
      right:  num(p.right),
      bottom: num(p.bottom),
      left:   num(p.left),
    };
  } else {
    out.capture.padding = { top: 0, right: 0, bottom: 0, left: 0 };
  }
  if (!out.capture.parameterValues || typeof out.capture.parameterValues !== "object" || Array.isArray(out.capture.parameterValues)) {
    out.capture.parameterValues = {};
  } else {
    // Coerce to plain {string: string} — trim keys, stringify values.
    const cleaned = {};
    for (const [k, v] of Object.entries(out.capture.parameterValues)) {
      const key = String(k || "").trim();
      if (!key) continue;
      cleaned[key] = String(v ?? "");
    }
    out.capture.parameterValues = cleaned;
  }
  return out;
}

function normalizeSchedule(s) {
  return {
    days: Array.isArray(s?.days)
      ? [...new Set(s.days.map((d) => String(d).toUpperCase()))].filter((d) => WEEKDAYS.includes(d))
      : [],
    time: typeof s?.time === "string" ? s.time.trim() : "",
  };
}

function normalizeDestination(d) {
  const type = d?.type || "workvivo-sendbird";
  return {
    type,
    channelName: String(d?.channelName || "").trim(),
    // Populated after first resolve; caller may pre-fill from storage.
    channelUrl: d?.channelUrl ? String(d.channelUrl) : null,
    appId:      d?.appId ? String(d.appId) : null,
    resolvedAt: typeof d?.resolvedAt === "number" ? d.resolvedAt : null,
  };
}

/**
 * Structural validation. Returns { ok: true } or { ok: false, errors: [...] }.
 * Does NOT check destination reachability or URL liveness — those are runtime
 * concerns handled by capture/sendbird.
 */
export function validateMetric(m, { existing = [] } = {}) {
  const errors = [];
  const n = normalizeMetric(m);

  if (!n.name) errors.push("name is required");
  if (n.name.length > 80) errors.push("name is too long (max 80)");

  if (!n.url) errors.push("url is required");
  else if (!HTTPS_RE.test(n.url)) errors.push("url must be https://…");

  if (n.id && !ID_ALLOWED_RE.test(n.id)) {
    errors.push("id must be lowercase [a-z0-9_-], starting with a letter or digit");
  }
  if (n.id) {
    const dup = existing.some((e) => e.id === n.id && e !== m);
    if (dup) errors.push(`id "${n.id}" is already used by another metric`);
  }

  if (!n.schedules.length) errors.push("at least one schedule is required");
  for (const [i, s] of n.schedules.entries()) {
    if (!TIME_RE.test(s.time)) errors.push(`schedule[${i}].time must be HH:MM (24h)`);
    if (!s.days.length) errors.push(`schedule[${i}].days must include at least one day`);
    for (const d of s.days) {
      if (!WEEKDAYS.includes(d)) errors.push(`schedule[${i}].days: "${d}" is not a weekday`);
    }
  }

  if (!n.destination.channelName) errors.push("destination.channelName is required");
  if (n.destination.type !== "workvivo-sendbird") {
    errors.push(`destination.type "${n.destination.type}" is not supported yet`);
  }

  const c = n.capture;
  if (!["viewport", "fullpage", "selector", "region"].includes(c.mode)) {
    errors.push(`capture.mode "${c.mode}" is not viewport | fullpage | selector | region`);
  }
  if (c.mode === "selector" && !c.selector) {
    errors.push("capture.selector required when capture.mode = selector");
  }
  if (c.mode === "region" && !c.clip && (!Array.isArray(c.containText) || !c.containText.length)) {
    errors.push("capture.mode = region requires either capture.clip or capture.containText");
  }
  if (c.clip) {
    for (const k of ["x", "y", "width", "height"]) {
      if (!Number.isFinite(c.clip[k]) || c.clip[k] < 0) errors.push(`capture.clip.${k} must be a non-negative number`);
    }
  }
  if (!(c.viewportWidth >= 320 && c.viewportWidth <= 3840))   errors.push("capture.viewportWidth out of range");
  if (!(c.viewportHeight >= 240 && c.viewportHeight <= 2400)) errors.push("capture.viewportHeight out of range");
  if (!(c.zoom > 0 && c.zoom <= 3))         errors.push("capture.zoom must be (0, 3]");
  if (!(c.settleDelayMs >= 0 && c.settleDelayMs <= 120_000))  errors.push("capture.settleDelayMs out of range");
  if (!(c.timeoutMs >= 5_000 && c.timeoutMs <= 600_000))      errors.push("capture.timeoutMs must be 5s–10min");
  if (!(Number.isInteger(c.retries) && c.retries >= 0 && c.retries <= 5)) errors.push("capture.retries must be 0..5");
  if (!(c.catchUpWindowMs >= 0 && c.catchUpWindowMs <= 24 * 60 * 60 * 1000)) errors.push("capture.catchUpWindowMs must be 0..24h");

  return errors.length ? { ok: false, errors, normalized: n } : { ok: true, normalized: n };
}

/**
 * Assign an id if missing, ensure it's unique against `existing`, then return
 * a metric ready to persist. Does not mutate input.
 */
export function readyForSave(m, existing = []) {
  const n = normalizeMetric(m);
  if (!n.id) n.id = uniqueId(slugifyName(n.name), existing);
  return n;
}

export function shortScheduleSummary(m) {
  if (!m?.schedules?.length) return "—";
  const daysAll = new Set(WEEKDAYS);
  const daysSet = new Set(m.schedules.flatMap((s) => s.days));
  const times = [...new Set(m.schedules.map((s) => s.time))].sort();
  const daysLabel =
    daysSet.size === 7 ? "Daily"
    : ["MON","TUE","WED","THU","FRI"].every((d) => daysSet.has(d)) && daysSet.size === 5 ? "Weekdays"
    : ["SAT","SUN"].every((d) => daysSet.has(d)) && daysSet.size === 2 ? "Weekends"
    : [...daysSet].join(" ");
  return `${daysLabel} ${times.join(" / ")}`;
}

/**
 * True if the metric injects any templated parameter value (e.g. a
 * {{HOME_STORE}} token). Such metrics are store-scoped and must not run
 * without a resolved store, or Tableau renders its default (store "1") and
 * we'd post a blank report. Pure + Node-testable; shared by service.js.
 */
export function metricNeedsStore(m) {
  const pv = m?.capture?.parameterValues;
  if (!pv || typeof pv !== "object") return false;
  return Object.values(pv).some((v) => typeof v === "string" && v.includes("{{"));
}

/**
 * Does a stored metric match a seed-migration fingerprint?
 *
 * A migration entry describes ONE specific broken past state. Only the keys
 * it actually specifies are evaluated, and ALL of them must match (AND).
 * Returns false if the entry specifies no conditions (so an empty entry can
 * never nuke a user's config).
 *
 * Bug history: this used OR, and one entry listed the *current* URL as its
 * `fromUrl`, so it re-fired on every service-worker restart and wiped the
 * user's capture block (incl. saved crop) back to seed defaults.
 */
export function migrationMatches(migration, existing) {
  if (!migration || !existing) return false;
  const checks = [];
  if (migration.fromUrl !== undefined) {
    checks.push(existing.url === migration.fromUrl);
  }
  if (migration.fromRequiredSelector !== undefined) {
    checks.push(existing.capture?.requiredSelector === migration.fromRequiredSelector);
  }
  if (migration.fromCaptureMode !== undefined) {
    checks.push(existing.capture?.mode === migration.fromCaptureMode);
  }
  if (migration.fromContainTextIncludes !== undefined) {
    checks.push(
      Array.isArray(existing.capture?.containText)
      && existing.capture.containText.includes(migration.fromContainTextIncludes)
    );
  }
  return checks.length > 0 && checks.every(Boolean);
}
