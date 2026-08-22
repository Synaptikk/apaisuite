// modules/digitalrollup/lib/sorting.js
//
// Card ordering and the card-level status roll-up. Pure functions over the
// /api/dashboard card shape, extracted from view.js so they can be tested:
// five metrics in two directions each, plus missing values and tie-breaks, is
// more behaviour than a render path should be hiding.

/** Worst first. `gray` is "no data", which is not a performance judgement. */
export const SEVERITY = { red: 0, yellow: 1, green: 2, gray: 3 };

/** Read a dotted path off a card. */
export const at = (obj, path) =>
  path ? path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj) : undefined;

/**
 * One sort per headline figure, same order as the card's headline strip.
 *
 * `num` is the RAW numeric field, never the formatted one — sorting "8.0 min"
 * against "10.0 min" as strings puts 10 first.
 *
 * `worst` records which end of the metric is the bad one, because it differs
 * per metric: low on-time is bad, high totes is bad. It drives the "needs
 * attention" ordering and labels the menu; the explicit options stay plain
 * low→high / high→low so a reader never has to infer the direction.
 */
export const METRIC_SORTS = [
  { key: "ontime",   label: "On-time pick",   num: "picking.on_time_pct",    worst: "low" },
  { key: "pickrate", label: "Pick rate",      num: "picking.pick_rate",      worst: "low" },
  { key: "totes",    label: "Totes to stage", num: "staging.totes_to_stage", worst: "high" },
  { key: "wait",     label: "Avg wait",       num: "dispense.wait_time",     worst: "high" },
  { key: "presub",   label: "Pre-sub %",      num: "quality.pre_sub_pct",    worst: "low" },
];

export const DEFAULT_SORT = "attention";

/** Every value the Sort menu can legitimately hold. */
export function isKnownSort(v) {
  if (v === "attention" || v === "store-asc" || v === "store-desc") return true;
  return METRIC_SORTS.some((s) => v === `${s.key}-asc` || v === `${s.key}-desc`);
}

export function numAt(card, path) {
  const v = at(card, path);
  return Number.isFinite(v) ? v : null;
}

/**
 * Compare two cards on one numeric field.
 *
 * Missing values sort LAST in BOTH directions rather than being coerced to 0
 * or to Infinity. A store the board returned no data for is neither the best
 * nor the worst performer — it is not in the ranking at all, and parking it at
 * the bottom says so without dropping it from view.
 */
export function byMetric(path, dir) {
  return (a, b) => {
    const x = numAt(a, path);
    const y = numAt(b, path);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return dir === "asc" ? x - y : y - x;
  };
}

/**
 * The worst-off group on a card, as BOTH its status and its label.
 *
 * Taking the colour from one group and the wording from another produced an
 * amber chip reading "On track" — the picking label beside the dispense
 * colour. A chip that contradicts itself is worse than no chip, so both halves
 * come from the same group.
 *
 * Staging is deliberately NOT considered here, even though the API bands it.
 * Totes to stage is shown on every card and is sortable, but it does not move
 * a store's overall status: it is a backlog, and a backlog is context for
 * judging the two figures that do measure service, not a verdict on its own.
 * Folding it in also meant inventing a label — the API bands
 * `totes_to_stage_status` but publishes no `status_label` for staging — so the
 * chip would have been putting our words in the board's mouth. Show it; don't
 * weight it.
 */
export function cardStatus(card) {
  const groups = [
    { status: at(card, "picking.status"),  label: at(card, "picking.status_label") },
    { status: at(card, "dispense.status"), label: at(card, "dispense.status_label") },
  ].filter((g) => g.status);
  if (!groups.length) return { status: "gray", label: "—" };
  groups.sort((a, b) => (SEVERITY[a.status] ?? 9) - (SEVERITY[b.status] ?? 9));
  return groups[0];
}

export const cardSeverity = (card) => cardStatus(card).status;

/**
 * @param {object[]} cards
 * @param {string} sortMode  a METRIC_SORTS key with -asc/-desc, "store-asc",
 *   "store-desc", or "attention". Anything unrecognised — a mode saved by an
 *   older build, say — falls through to "attention" rather than returning an
 *   arbitrary order.
 * @returns {object[]} a new array; the input is not mutated.
 */
export function sortCards(cards, sortMode) {
  const arr = [...cards];
  if (sortMode === "store-asc")  return arr.sort((a, b) => a.store_nbr - b.store_nbr);
  if (sortMode === "store-desc") return arr.sort((a, b) => b.store_nbr - a.store_nbr);

  const m = METRIC_SORTS.find((s) => sortMode === `${s.key}-asc` || sortMode === `${s.key}-desc`);
  if (m) return arr.sort(byMetric(m.num, sortMode.endsWith("-asc") ? "asc" : "desc"));

  return arr.sort((a, b) => {
    const d = (SEVERITY[cardSeverity(a)] ?? 9) - (SEVERITY[cardSeverity(b)] ?? 9);
    if (d !== 0) return d;
    // Longest wait breaks a tie within a band. Totes deliberately does not
    // feed this — see cardStatus. Sort by it explicitly (`totes-desc`) when
    // the backlog is what you are looking for.
    return byMetric("dispense.wait_time", "desc")(a, b);
  });
}
