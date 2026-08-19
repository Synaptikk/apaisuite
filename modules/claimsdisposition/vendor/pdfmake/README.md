# pdfmake (vendored)

Third-party, unmodified, minified as published upstream — **not obfuscated**.
Recorded here because Chrome Web Store review asks where large minified bundles
came from, and "we don't know" is what turns a question into a rejection.

| File | Size | What it is |
|---|---|---|
| `pdfmake.min.js` | ~1.39 MB | pdfmake, client-side PDF generation |
| `vfs_fonts.js` | ~783 KB | the bundled Roboto font set pdfmake renders with |

- Upstream: https://github.com/bpampuch/pdfmake — MIT licence
- **Version: 3.19.0** (read from the `version:` string inside `pdfmake.min.js`)
- Used by: `modules/claimsdisposition/lib/pdf.js`
- Readable source for review: the unminified build is published in the same
  upstream release; point reviewers at the tagged release matching the version
  string inside `pdfmake.min.js` if they ask for non-minified code.

**If you upgrade it:** record the new version here at the same time. A vendored
bundle whose provenance nobody can state is the version a reviewer objects to.
