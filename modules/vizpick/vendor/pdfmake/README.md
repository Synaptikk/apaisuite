# pdfmake (vendored)

pdfmake v0.2.10 (MIT, http://pdfmake.org) with its Roboto `vfs_fonts.js`,
copied byte-for-byte from `modules/claimsdisposition/vendor/pdfmake/`.
Copied rather than imported because the module contract keeps modules
self-contained (same reason `modules/digitalmetrics/vendor/xlsx_min.js` is a copy).

Used by `lib/case_report.js` for the pick progression "Generate PDF report"
button. Loaded lazily on the first click; attachments use the bundled pdfkit
`file()` method.
