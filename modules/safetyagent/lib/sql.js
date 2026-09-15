// modules/safetyagent/lib/sql.js
//
// SafeIQ Studio exposes its dashboards as thin HTML over one raw SQL endpoint:
//   POST /api/studio/search/sql?page=N&size=M&count=false   body: { sql }
// Server rules (enforced with a 400): no LIMIT in the SQL (the server appends
// one from ?size=), and every query must carry an ORDER BY. Dialect is
// BigQuery (COUNTIF, DATE_SUB, ...). Pure helpers only — Node-testable.

export const SAFEIQ_ORIGIN   = "https://safeiq.stage.walmart.net";
export const DASHBOARD_PATH  = "/SafeIQStudio/dashboards/82ed390b-c9c5-486e-8e06-3fdd68940d23";
export const HAZARD_TABLE    = "trade_model_safety_cv_hazard_detections";
export const PAGE_SIZE       = 1000;
// SafeIQ CV image host. Every alert has two frames keyed by its string hzd_id:
//   bbox_overlay — detection frame with the bounding box burned in
//   pre_verify   — raw frame the associate saw before verifying
// Plain <img src> loads them (CORS *, public cache); no token needed.
export const IMAGE_BASE      = "https://safeiqcv.stage.walmart.net/api/images";
export function hazardImageUrl(hzdId, type = "bbox_overlay") {
  return hzdId ? `${IMAGE_BASE}/${encodeURIComponent(hzdId)}_${type}.jpg` : null;
}
export const MAX_PAGES       = 40;   // 40k rows — well past any single store's history so far

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function sqlUrl(origin, page, size = PAGE_SIZE) {
  return `${origin}/api/studio/search/sql?page=${page}&size=${size}&count=false`;
}

// One row per CV alert for one store. Only the columns the module renders;
// ordered by detection time so paging is stable.
export function hazardSql({ store, from, to } = {}) {
  const nbr = Number(store);
  if (!Number.isInteger(nbr) || nbr <= 0) throw new Error(`hazardSql: bad store "${store}"`);
  const where = [`hzd.store_nbr = ${nbr}`];
  if (from) { if (!DATE_RE.test(from)) throw new Error("hazardSql: bad from date"); where.push(`hzd.hzd_dt >= DATE '${from}'`); }
  if (to)   { if (!DATE_RE.test(to))   throw new Error("hazardSql: bad to date");   where.push(`hzd.hzd_dt <= DATE '${to}'`); }
  return [
    "SELECT hzd.hzd_id, hzd.hzd_dt, hzd.hzd_dt_lcl, hzd.hzd_ts_lcl, hzd.action_ts_lcl, hzd.task_complete_ts_lcl,",
    "  hzd.note_hzd_type_desc, hzd.aisle_nm, hzd.dept_nm, hzd.camera_name, hzd.action_category,",
    "  hzd.associate_comment, hzd.associate_name, hzd.acknowledgement_minutes, hzd.is_during_operational_hours",
    `FROM ${HAZARD_TABLE} hzd`,
    `WHERE ${where.join(" AND ")}`,
    "ORDER BY hzd.hzd_ts ASC, hzd.hzd_id ASC",
  ].join("\n");
}

// Compact row layout stored in chrome.storage.local and handed to the view.
// Keep this array in sync with lib/aggregate.js::COL.
export function compactRow(r) {
  const ts  = r.hzd_ts_lcl ? String(r.hzd_ts_lcl).slice(0, 16).replace("T", " ") : "";
  const ttc = r.task_complete_ts_lcl && r.hzd_ts_lcl
    ? Math.round((Date.parse(r.task_complete_ts_lcl) - Date.parse(r.hzd_ts_lcl)) / 6000) / 10
    : null;
  return [
    ts,                                              // 0 local detection "YYYY-MM-DD HH:MM"
    r.camera_name || "(no camera)",                  // 1
    r.dept_nm || "",                                 // 2
    r.associate_comment || "",                       // 3 quick-select tag ("" = none)
    r.associate_name || "",                          // 4
    r.acknowledgement_minutes ?? null,               // 5 detection → accepted, minutes
    r.action_category || "",                         // 6 ACCEPTED | NOT AVAILABLE | NO ACTION
    r.note_hzd_type_desc || "",                      // 7 object | spill
    ttc,                                             // 8 detection → task complete, minutes
    r.hzd_dt_lcl || (ts ? ts.slice(0, 10) : r.hzd_dt || ""), // 9 local date
    r.aisle_nm || "",                                // 10
    r.is_during_operational_hours !== false,         // 11
    r.hzd_id || "",                                  // 12 image key (see hazardImageUrl)
  ];
}
