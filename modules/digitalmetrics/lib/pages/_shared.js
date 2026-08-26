// modules/digitalmetrics/lib/pages/_shared.js
//
// Markup helpers shared by the page renderers.
//
// Page contract:
//   render(ctx) -> HTML string
//   wire?(ctx, root) -> cleanup fn        (only pages with interaction)
//
// ctx = { associates, benchmarks, classifications, adherence, rawData,
//         store, week, dates, host }
//
// Everything user-derived goes through esc(). The donor sanitised at the call
// site by hand; here it is the default and the raw path has to be explicit.

import { badgeClass } from "../data/classify.js";

export const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const num = (v) => (Number(v) || 0).toLocaleString();

/**
 * One statistic tile.
 * `tone` maps to a token-backed colour class — never an inline colour, which
 * is what the donor did and what breaks theming.
 */
export function statCard(label, value, { tone = "", note = "" } = {}) {
  return `
    <div class="dm-stat">
      <div class="dm-stat-label">${esc(label)}</div>
      <div class="dm-stat-value ${tone ? `is-${esc(tone)}` : ""}">${esc(value)}</div>
      ${note ? `<div class="dm-stat-note">${esc(note)}</div>` : ""}
    </div>`;
}

export const statRow = (cards) => `<div class="dm-stat-row">${cards.join("")}</div>`;

export const section = (title, body) => `
  <section class="dm-section">
    <h3 class="dm-section-title">${esc(title)}</h3>
    ${body}
  </section>`;

export const empty = (message) => `<div class="dm-todo">${esc(message)}</div>`;

/**
 * Flip a sort direction. Exported because every board needs the same rule for
 * "click the column you are already sorted by".
 */
export const flipDir = (dir) => (dir === "asc" ? "desc" : "asc");

/**
 * What clicking a header should do, as a plain function of the current state.
 *
 * Clicking the column you are already sorted by flips the direction; clicking
 * any other switches to it in its natural order. Shared so the Leaderboard and
 * Opportunities cannot drift apart, and pulled out of the event handlers so it
 * can be tested without a DOM — the branch that decides "same column or not" is
 * the one that silently does nothing when it is wrong.
 *
 * Returns a patch for onUiChange, keyed by the caller's own field names:
 *   nextSort({ clicked: "ftpr", current: "nil_rate", rev: true,
 *              keyField: "lbMetric", revField: "lbRev" })
 *     -> { lbMetric: "ftpr", lbRev: false }
 */
export function nextSort({ clicked, current, rev, keyField, revField }) {
  return clicked === current
    ? { [revField]: !rev }
    : { [keyField]: clicked, [revField]: false };
}

/**
 * Generic comparator by key. Numbers compare numerically, everything else
 * case-insensitively as text, and `name` is the tiebreaker so equal values
 * keep a stable, predictable order instead of shuffling between renders.
 *
 * `valueOf` lets a column sort on something other than the cell it displays —
 * Adherence renders "94%" out of a side table, for instance.
 */
export function compareBy(key, dir = "desc", valueOf = null) {
  const read = valueOf || ((row) => row[key]);
  const sign = dir === "asc" ? 1 : -1;
  return (a, b) => {
    const av = read(a), bv = read(b);
    const an = typeof av === "number" || (av !== "" && av != null && !isNaN(Number(av)));
    const bn = typeof bv === "number" || (bv !== "" && bv != null && !isNaN(Number(bv)));
    let d;
    if (an && bn) d = (Number(av) || 0) - (Number(bv) || 0);
    else d = String(av ?? "").localeCompare(String(bv ?? ""), undefined, { sensitivity: "base" });
    if (d) return d * sign;
    return String(a.name ?? "").localeCompare(String(b.name ?? ""));
  };
}

/**
 * A data table, optionally with click-to-sort headers.
 *
 * `columns` = [{ key, label, align?, format?, sortKey?, sortable? }]
 *
 * Pass `sort: { key, dir }` to turn the headers into sort buttons. The table
 * does NOT sort — it only renders the current state and emits `data-dm-sort`
 * on click, because each board's ordering has its own rules (the leaderboard
 * knows lower Nil Rate is better; Opportunities ranks worst-first). Sorting
 * here as well would mean two sorters that can disagree.
 *
 * Columns opt OUT with `sortable: false` — a rank column or a list of issue
 * strings has no meaningful order of its own.
 */
export function table(columns, rows, { emptyMessage = "No data.", sort = null } = {}) {
  if (!rows?.length) return empty(emptyMessage);

  const head = columns
    .map((c) => {
      const right = c.align === "right" ? "is-right" : "";
      const sortKey = c.sortable === false ? null : (c.sortKey || c.key);
      if (!sort || !sortKey) {
        return `<th class="${right}">${esc(c.label)}</th>`;
      }
      const active = sort.key === sortKey;
      // "↕" on an unsorted column advertises that it can be clicked at all —
      // without it the headers look identical to the plain ones above.
      const arrow = !active ? "↕" : sort.dir === "asc" ? "▲" : "▼";
      return `<th class="${right} is-sortable ${active ? "is-sorted" : ""}"` +
             ` aria-sort="${active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}">` +
             `<button type="button" class="dm-sort" data-dm-sort="${esc(sortKey)}"` +
             ` title="Sort by ${esc(c.label)}">${esc(c.label)}` +
             `<span class="dm-sort-arrow" aria-hidden="true">${arrow}</span></button></th>`;
    })
    .join("");

  const body = rows.map((row) => {
    const cells = columns.map((c) => {
      const raw = c.format ? c.format(row) : row[c.key];
      // format() may return markup deliberately (badges); esc() the plain path.
      return `<td class="${c.align === "right" ? "is-right" : ""}">${
        c.format ? raw : esc(raw)
      }</td>`;
    }).join("");
    return `<tr>${cells}</tr>`;
  }).join("");

  return `<div class="dm-table-scroll"><table class="data-table">
    <thead><tr>${head}</tr></thead><tbody>${body}</tbody>
  </table></div>`;
}

/**
 * An associate's name plus their role badge, as one aligned, clickable cell.
 *
 * Shared so every board renders the pair identically. Two problems it fixes:
 *
 *  · The badge used to follow the name inline, so its left edge landed
 *    wherever the name happened to end and the column read as ragged. Here the
 *    badge is pushed to the column's right edge with margin-left:auto, so all
 *    badges line up regardless of name length.
 *  · Names were plain text on every board except Associates, so there was no
 *    way to open someone's breakdown from the Leaderboard or Opportunities.
 *    `data-dm-associate` is the hook the delegated handler already looks for.
 */
export function associateCell(name, classification) {
  const cls = classification || "Unclassified";
  return `<span class="dm-assoc-cell">` +
    `<button type="button" class="dm-assoc-link" data-dm-associate="${esc(name)}">${esc(name)}</button>` +
    `<span class="badge ${esc(badgeClass(cls))} dm-role">${esc(cls)}</span>` +
  `</span>`;
}
