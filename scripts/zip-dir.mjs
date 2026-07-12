// scripts/zip-dir.mjs
//
// Zip a directory into a single archive with forward-slash entry names
// (per the ZIP spec, and what every non-Windows unzipper expects).
//
// Why we don't use PowerShell's Compress-Archive: Windows PowerShell 5.1's
// .NET-Framework-backed Compress-Archive writes entry names with backslashes
// on Windows, which has historically tripped up the Chrome Web Store
// uploader and breaks on macOS/Linux unzip tools. PowerShell 7+ fixed it
// but isn't installed on most Walmart corp laptops.
//
// Usage:
//   node zip-dir.mjs <dir-to-zip> <output.zip>
//
// The top-level directory IS included in the archive (so extracting produces
// a single folder, not a pile of files).

import AdmZip from "adm-zip";
import { argv, exit, stderr } from "node:process";
import path from "node:path";
import { statSync } from "node:fs";

if (argv.length !== 4) {
  stderr.write("usage: node zip-dir.mjs <dir-to-zip> <output.zip>\n");
  exit(64);
}

const srcDir = path.resolve(argv[2]);
const outPath = path.resolve(argv[3]);

const st = statSync(srcDir);
if (!st.isDirectory()) {
  stderr.write(`zip-dir: not a directory: ${srcDir}\n`);
  exit(2);
}

const zip = new AdmZip();
// addLocalFolder adds the *contents* of srcDir; the second arg lets us
// prefix every entry with the top-level directory name so the archive
// extracts to a single folder.
zip.addLocalFolder(srcDir, path.basename(srcDir));
zip.writeZip(outPath);

stderr.write(`zip-dir: wrote ${outPath}\n`);
