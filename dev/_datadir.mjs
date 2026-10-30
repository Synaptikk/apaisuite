// Where dev probe/capture dumps live. They carry live data (names, tokens), so
// they stay outside the repo: ~/Desktop/data/apaisuite unless APAISUITE_DATA_DIR
// says otherwise.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DATA_DIR = process.env.APAISUITE_DATA_DIR || path.join(os.homedir(), "Desktop", "data", "apaisuite");
fs.mkdirSync(DATA_DIR, { recursive: true });
