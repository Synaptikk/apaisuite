// modules/stockingplan/lib/lines.js
// Pure data + pure functions — no DOM, no chrome.*.
//
// The vocabulary a stocking plan is written in. Store 1458's plans never say
// "D14 Kitchen & Dining" — they say "stock home-12.5 hours". Each entry below
// is one of those lines, with the departments it covers.
//
// ── How the department sets were fitted ───────────────────────────────────
// 11 plans sent 2026-08-10 → 09-18 state hours for their GM lines. Those
// stated hours were compared against CaseVisibility's own per-department
// stocking time (casesByDept.html) for the same business date, which is
// retrievable about 45 days back. The sets below are the ones that matched:
//
//   line        stated vs CV total, 10 dates      verdict
//   home        14.2/14  9.2/8.5  13.4/12.5 …     D14+D17+D22+D74 (mean err 0.6h)
//                                                 D14+D74 alone is ~40% too low;
//                                                 adding D20+D71 is ~20% too high
//   hardware    4.4/3.5  3.9/3.5  6.8/5.5 …       D11+D12 — paint travels with
//                                                 hardware; D11 alone is always short
//   toys/sg/auto                                  D7 / D9 / D10, one dept each
//   garden      1.9/2  1.0/1  0.9/1               D16+D56
//
// The food lines were confirmed a different way — against the adjectives the
// plans use, which turn out to be a consistent ratio to that line's own median:
//
//   "90/91/97 very light — only 15 hours"   D90+D91+D97 = 17.6h  (median 36)
//   "90/91/97 very heavy"                                 41.9h
//   "grocery very light — only 21 hours"    D92+D95     = 30.9h  (median 52.5)
//   "grocery very heavy"                                  62.5h
//   "4/8/13/79 extremely light"             D4+D8+D13+D79 = 13.8h (median 27.5)
//   "4/8/13/79 also very heavy"                           40.8h
//   "heavier than average in chemicals"     D13         = 9.3h   (median 5.6)
//
// The stated hours run a little under CV's estimate — a plan is written to what
// the crew will really get through — but the direction is right every time.

export const LINES = [
  // ── Stock 2: the GM list, in the order the plans write it ───────────────
  { key: "toys",     label: "toys",            depts: [7],            block: "stock2", order: 1, priority: 30 },
  { key: "sg",       label: "sporting goods",  depts: [9],            block: "stock2", order: 2, priority: 30 },
  { key: "auto",     label: "automotive",      depts: [10],           block: "stock2", order: 3, priority: 30 },
  { key: "hardware", label: "hardware",        depts: [11, 12],       block: "stock2", order: 4, priority: 30 },
  { key: "garden",   label: "garden",          depts: [16, 56],       block: "stock2", order: 5, priority: 20 },

  // ── Overnight: the food list first, always in this order ────────────────
  { key: "fdd",      label: "90/91/97",        depts: [90, 91, 97],   block: "stock3", order: 1, priority: 100 },
  { key: "grocery",  label: "grocery",         depts: [92, 95],       block: "stock3", order: 2, priority: 100 },
  { key: "chem",     label: "4/8/13/79",       depts: [4, 8, 13, 79], block: "stock3", order: 3, priority: 90  },
  { key: "hba",      label: "2/40/46",         depts: [2, 40, 46],    block: "stock3", order: 4, priority: 90  },
  { key: "d82",      label: "82",              depts: [82],           block: "stock3", order: 5, priority: 80  },
  // …then the GM overflow the night picks up. Home is big — 8h to 16h — but
  // every plan in the sample kept it overnight, including 09-18 at 91% ("stock
  // home-13 hours-catch up on any unworked pallets where possible"). So it
  // sits above CORE_PRIORITY: the night gets told it doesn't fit rather than
  // quietly handing home to a 9-person morning crew.
  { key: "home",     label: "home",            depts: [14, 17, 22, 74], block: "stock3", order: 7, priority: 85 },
  // 3/19/67 is the swing line — it is what the plans shed first, every time.
  { key: "craft",    label: "3/19/67",         depts: [3, 19, 67],    block: "stock3", order: 8, priority: 40 },

  // ── Seasonal floats: whichever shift has room, most often Stock 1 ───────
  { key: "d18",      label: "D18 seasonal",    depts: [18],           block: "stock1", order: 1, priority: 25 },

  // ── Not a stocking-plan line: these have their own teams ────────────────
  { key: "fresh",    label: "meat/produce/deli", depts: [80, 93, 94, 98],
    block: null, order: 99, priority: 0, owner: "Meat/Produce + Deli/Bakery TAs" },
  { key: "fashion",  label: "fashion",         depts: [23, 24, 25, 26, 29, 31, 32, 33, 34],
    block: null, order: 99, priority: 0, owner: "Fashion Stocking TA" },
];

// Departments a line never claims still exist (D5, D6, D20, D49, D71, D72,
// D87, D1, D81, D96). The plans sweep them up as "any remaining GM freight",
// so the suggester totals them into one catch-all line rather than dropping
// them — a plan that silently loses 5 hours of freight is worse than an ugly
// one.
export const CATCH_ALL = {
  key: "restgm", label: "any remaining GM freight", block: "stock1", order: 9, priority: 10,
  // A grab-bag of unrelated departments has no "normal" to be heavy or light
  // against, so it never gets an adjective.
  unweighed: true,
};

// Median line hours over the 10 business dates with complete freight detail
// (2026-08-27 → 09-18; 08-10 came back with the whole GM side empty — CV thins
// older history, so it is excluded rather than dragging every median down).
//
// Used only to describe a line as heavy or light. It is a starting point: once
// the module has seen enough days of its own, `observedMedian` from the stored
// history wins — a different store has a different shape entirely.
export const BASELINE_HOURS = {
  toys: 2.8, sg: 2.3, auto: 2.1, hardware: 3.1, garden: 1.1, d18: 4.4,
  fdd: 36, grocery: 52.5, chem: 27.5, hba: 27.5, d82: 0.9,
  home: 11.1, craft: 8.3, fresh: 20.2, fashion: 13.8, restgm: 4.8,
};

// Ratio bands, read off the plans' own wording, against the ratio each was
// written at:
//   0.49  "very light"      0.50  "extremely light"    0.59  "very light"
//   1.16  "very heavy"      1.19  "very heavy"         1.48  "very heavy"
//   1.66  "heavier than average"
// One manager, six samples, so the bands below are deliberately a notch more
// conservative than his vocabulary at the edges — 1.16 reads as "heavy" here,
// not "very heavy". Being under-dramatic about a normal night is the cheaper
// mistake.
const BANDS = [
  { at: 1.35, word: "very heavy" },
  { at: 1.15, word: "heavy" },
  { at: 0.80, word: null },        // unremarkable — say nothing
  { at: 0.60, word: "light" },
  { at: 0,    word: "very light" },
];

/**
 * How this line's hours compare to normal for this line.
 * @returns {{ratio:number|null, word:string|null, median:number|null}}
 */
// Below this, a line is too small for the adjective to mean anything: garden at
// 1.7h against a 1.1h median is "very heavy" by ratio and nonsense in a plan.
export const MIN_WEIGH_HOURS = 2;

export function weigh(lineKey, hours, medians = BASELINE_HOURS) {
  const median = medians?.[lineKey];
  if (!median || median <= 0) return { ratio: null, word: null, median: null };
  if (hours < MIN_WEIGH_HOURS) return { ratio: Math.round((hours / median) * 100) / 100, word: null, median };
  const ratio = hours / median;
  let word = null;
  for (const b of BANDS) {
    if (ratio >= b.at) { word = b.word; break; }
  }
  return { ratio: Math.round(ratio * 100) / 100, word, median };
}

// Departments → line key. Built once; a department belongs to at most one line.
const DEPT_TO_LINE = new Map();
for (const l of LINES) for (const d of l.depts) DEPT_TO_LINE.set(d, l.key);

export function lineForDept(deptNbr) {
  return DEPT_TO_LINE.get(Number(deptNbr)) || null;
}

export function lineByKey(key) {
  return LINES.find((l) => l.key === key) || (key === CATCH_ALL.key ? CATCH_ALL : null);
}
