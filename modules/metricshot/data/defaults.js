// modules/metricshot/data/defaults.js
//
// Seed metrics installed on first run. Additional metrics are added via the
// UI and stored in chrome.storage.sync["metricshot.metrics"].
//
// The seed only lands if the metrics list is empty (see service.js::ensureSeed);
// removing or editing a seeded metric later is sticky — we won't re-add it.
//
// URL templating and parameterValues templating: {{HOME_STORE}} is expanded
// at capture time via shared/userStore.js::getUserHomeStore(). That way one
// seed works for every user regardless of their home store.
//
// Tableau notes:
//   - We use the direct embed URL (`/t/site/views/<viz>?:embed=y&:toolbar=n`)
//     instead of the VizPortal SPA URL (`/#/site/...`). The embed URL loads
//     the viz at the top level (no iframe wrapper), skips the surrounding
//     chrome, and renders faster.
//   - URL query params are NOT reliable for setting Tableau parameter values
//     — the URL param name must match the workbook's internal parameter id
//     (often "Store Number (copy)_2219430255132946450" or similar), not the
//     display title. Instead we inject the value into the parameter widget's
//     <textarea> after page load via capture.js::_injectParameters. That
//     matches the parameter by its DISPLAY title, which the analyst sees.

export const SEED_METRICS = [
  {
    id: "vizpick-score",
    name: "VizPick Score",
    url: "https://stores.tableau.wal-mart.com/t/OnlineGrocery/views/VizPick/VizPickDetails?:embed=y&:toolbar=n",
    enabled: true,
    timezone: "local",
    schedules: [
      { days: ["MON","TUE","WED","THU","FRI","SAT","SUN"], time: "10:00" },
      { days: ["MON","TUE","WED","THU","FRI","SAT","SUN"], time: "12:50" },
      { days: ["MON","TUE","WED","THU","FRI","SAT","SUN"], time: "20:00" },
    ],
    destination: { type: "workvivo-sendbird", channelName: "@me" },
    caption: "",
    capture: {
      // "region" + containText → smallest bounding box that includes each of
      // these visible strings. Robust to Tableau reflow: the anchors are the
      // section's own visible text. Anchors chosen for reliability:
      //   - "VizPick Backroom Health (Current Day)": section header banner
      //   - "VizPick Health Metric": right-side legend title
      //   - "Stocking Exceptions / Stocking Baseline": legend last item
      //     (defines bottom-right edge)
      // If some of these anchors render as image tiles (Tableau does this
      // sometimes), the matcher still uses whatever it finds — see
      // capture.js::_regionForContainText's lenient MIN_FOUND behavior.
      mode: "region",
      containText: [
        "VizPick Backroom Health (Current Day)",
        "VizPick Health Metric",
        "Stocking Exceptions / Stocking Baseline",
      ],
      selector: null,
      clip: null,
      // Padding around the computed anchor bounding box. The bottom-right
      // anchor is the legend's LAST LINE — its rect ends at the text baseline
      // so a raw crop clips the tails of glyphs like "y" and the small trailing
      // wt.% subscript. 40px bottom gives a comfortable margin.
      padding: { top: 12, right: 24, bottom: 48, left: 12 },
      requiredSelector: ".tab-parameter",
      hideSelectors: [],
      parameterValues: { "Store": "{{HOME_STORE}}" },
      viewportWidth: 1500,
      viewportHeight: 1000,
      // Zoom out slightly so the full VizPick report fits the capture surface
      // instead of the right/bottom edges being clipped. Tunable in the UI
      // (Advanced capture → Zoom).
      zoom: 0.85,
      settleDelayMs: 8000,
      timeoutMs: 60000,
      retries: 2,
      catchUpWindowMs: 60 * 60 * 1000,

      // Card rendering. The posted image is now drawn from VizPick's own rows
      // (lib/render_card.js) rather than screenshotted, so the crop fields
      // above — mode, containText, padding, viewportWidth/Height, zoom,
      // hideSelectors — are no longer read. They are left in place because
      // SEED_URL_MIGRATIONS fingerprints stored configs on them, and because
      // dropping keys from a stored metric is a migration in its own right.
      pickGoalPct: 80,   // goal line on the department bars
      rasterScale: 2,    // 2x for a crisp image in the Workvivo feed
    },
  },
];

// Known-broken older seeds we've shipped. If we see any of these fingerprints
// on an existing "vizpick-score" metric config, migrate it to the current
// seed above. Each entry is checked against the stored metric — if ANY key
// matches, we upgrade the URL + capture block.
export const SEED_URL_MIGRATIONS = [
  {
    // v0.1.0 — outer VizPortal URL, wrong readiness selector, no store filter.
    fromUrl: "https://stores.tableau.wal-mart.com/#/site/OnlineGrocery/views/VizPick/VizPickDetails?:iid=1&:linktarget=_self",
    fromRequiredSelector: ".tabCanvas, canvas.tab-widget",
  },
  {
    // v0.1.1 — outer VizPortal URL with URL-based store filter (didn't work).
    fromUrl: "https://stores.tableau.wal-mart.com/#/site/OnlineGrocery/views/VizPick/VizPickDetails?Store={{HOME_STORE}}&:iid=1&:linktarget=_self",
    fromRequiredSelector: "iframe",
  },
  {
    // v0.1.2 — full-viewport capture (no crop). Fingerprint: has direct embed
    // URL but no clip/region config.
    fromCaptureMode: "viewport",
    fromUrl: "https://stores.tableau.wal-mart.com/t/OnlineGrocery/views/VizPick/VizPickDetails?:embed=y&:toolbar=n",
  },
  {
    // v0.1.3 — region mode but with "Fresh" as an anchor (matched too many
    // elements or none). Migrate to the more reliable anchor set.
    fromContainTextIncludes: "Fresh",
  },
  {
    // v0.1.4 — region mode at zoom:1 clipped the right/bottom of the report.
    // Migrate to zoom:0.85 + roomier padding so the full viz fits the frame.
    // Keyed on zoom===1 so it fires once then leaves user-tuned zooms alone.
    fromZoom: 1,
  },
];
