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

/** A sortable data table. `columns` = [{ key, label, align?, format? }] */
export function table(columns, rows, { emptyMessage = "No data." } = {}) {
  if (!rows?.length) return empty(emptyMessage);

  const head = columns
    .map((c) => `<th class="${c.align === "right" ? "is-right" : ""}">${esc(c.label)}</th>`)
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
