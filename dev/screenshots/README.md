# Chrome Web Store screenshots

Regenerates the 1280×800 listing images in `docs/store-assets/`.

The pages import the extension's **real** stylesheets and, where a renderer is
pure enough to run in a page, its **real** renderer — `vizpick/lib/charts.js`
draws the gauges and `metricshot/lib/render_card.js` draws the metric card. Only
the data is synthetic: store `0000`, "Demo BU", generic department names. No real
Walmart data appears in a listing image, and listing images are public even on an
unlisted item.

Run:

    ./run.sh

An HTTP server is required — the pages use ES modules, which Chrome refuses to
load over `file://`.
