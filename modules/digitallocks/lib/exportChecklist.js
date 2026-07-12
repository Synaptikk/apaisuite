// modules/digitallocks/lib/exportChecklist.js
//
// CSV export for the active-review queue and the daily checklist (episodes).
// PDF export is deliberately deferred to V2 — the spec calls for it but
// pdfmake is a 1.4MB vendor dependency and the daily checklist works fine
// as CSV + spreadsheet for V1.
//
// Triggers a browser download via a Blob URL — no chrome.downloads call,
// so the module needs no extra permission.

import { STATUS_LABEL } from "./statusStore.js";

const DISCLAIMER_LINE = "# DigitalLocks suggested-review list. Inclusion does not indicate wrongdoing. Each event is a triage hint, not a verdict.";

/**
 * Download the active-review event table as a CSV file.
 * @param {object[]} events  — already-filtered/scored event rows
 * @param {string}  fileName — e.g. "digitallocks-active-2026-06-01.csv"
 */
export function exportActiveCsv(events, fileName) {
  const headers = [
    "store", "eventTime", "userId", "firstName", "lastName", "position",
    "lockName", "zoneName", "unlockSource",
    "riskScore", "riskLevel", "riskReasons", "reviewStatus", "reviewerNotes",
  ];
  const lines = [DISCLAIMER_LINE, headers.join(",")];
  for (const e of events) {
    lines.push(headers.map((h) => {
      if (h === "riskReasons")  return csvCell((e.riskReasons || []).join("; "));
      if (h === "reviewStatus") return csvCell(STATUS_LABEL[e.reviewStatus] || e.reviewStatus);
      return csvCell(e[h]);
    }).join(","));
  }
  triggerDownload(lines.join("\r\n"), fileName, "text/csv");
}

/**
 * Download a daily checklist CSV grouped by episode.
 * @param {object[]} episodes — from riskScoring.groupIntoEpisodes
 * @param {string}   fileName
 */
export function exportChecklistCsv(episodes, fileName) {
  const headers = [
    "maxScore", "store", "user", "userId", "position",
    "zone", "startTime", "endTime", "eventCount", "locks", "reasons",
    "suggestedActions",
  ];
  const lines = [DISCLAIMER_LINE, headers.join(",")];
  for (const ep of episodes) {
    const actions = suggestedActions(ep);
    lines.push([
      csvCell(ep.maxScore),
      csvCell(ep.store),
      csvCell(ep.name || "(unattributed)"),
      csvCell(ep.userId),
      csvCell(ep.position),
      csvCell(ep.zoneName),
      csvCell(ep.startTime),
      csvCell(ep.endTime),
      csvCell(ep.eventCount),
      csvCell(ep.locks.join("; ")),
      csvCell(ep.reasons.join("; ")),
      csvCell(actions.join("; ")),
    ].join(","));
  }
  triggerDownload(lines.join("\r\n"), fileName, "text/csv");
}

/**
 * Download the history (cleared events) CSV.
 */
export function exportHistoryCsv(events, fileName) {
  const headers = [
    "store", "eventTime", "userId", "firstName", "lastName", "position",
    "lockName", "zoneName", "riskScore", "riskLevel", "riskReasons",
    "reviewStatus", "clearedAt", "clearedReason", "reviewerNotes",
  ];
  const lines = [DISCLAIMER_LINE, headers.join(",")];
  for (const e of events) {
    lines.push(headers.map((h) => {
      if (h === "riskReasons") return csvCell((e.riskReasons || []).join("; "));
      if (h === "clearedAt" && e.clearedAt) return csvCell(new Date(e.clearedAt).toISOString());
      if (h === "reviewStatus")  return csvCell(STATUS_LABEL[e.reviewStatus]  || e.reviewStatus);
      if (h === "clearedReason") return csvCell(STATUS_LABEL[e.clearedReason] || e.clearedReason || "");
      return csvCell(e[h]);
    }).join(","));
  }
  triggerDownload(lines.join("\r\n"), fileName, "text/csv");
}

// ── Suggested next steps per episode (deliberately phrased as questions
// for the reviewer, not findings). ──────────────────────────────────
function suggestedActions(ep) {
  const out = [];
  const reasons = new Set(ep.reasons.map((r) => r.toLowerCase()));
  if ([...reasons].some((r) => r.includes("after-hours") || r.includes("edge after"))) {
    out.push("Verify the associate was scheduled on this shift");
    out.push("Review CCTV in the window");
  }
  if ([...reasons].some((r) => r.includes("role/zone mismatch"))) {
    out.push("Check whether a task or assist drove the access");
  }
  if ([...reasons].some((r) => r.includes("high-risk zone"))) {
    out.push("Compare to transactions in the window");
  }
  if ([...reasons].some((r) => r.includes("zones in") || r.includes("repeated"))) {
    out.push("Look for a pattern across prior days");
  }
  if ([...reasons].some((r) => r.includes("unusual unlock source"))) {
    out.push("Confirm the source device/account is legitimate for this user");
  }
  if (out.length === 0) out.push("Brief eyeball review");
  return out;
}

// ── Helpers ─────────────────────────────────────────────────────────

function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function triggerDownload(text, fileName, mime) {
  const blob = new Blob([text], { type: mime + ";charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the click handler has had a chance to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
