// dev/cws-drive.mjs — step-by-step driver for the Chrome Web Store dashboard.
//
// Attaches to an ALREADY-RUNNING Chrome over CDP so the developer's Google
// session is reused. Playwright's own Chromium is useless here: it starts with
// a blank profile, and Google refuses sign-in from an automated browser.
//
// Start Chrome once with:
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//     --remote-debugging-port=9222 \
//     --user-data-dir="$HOME/Library/Application Support/Google/Chrome"
//
// (Chrome must be fully quit first — it will not open a debugging port on a
// profile another instance already holds.)
//
// Usage:
//   node dev/cws-drive.mjs snapshot            # interactive elements on the page
//   node dev/cws-drive.mjs shot out.png        # screenshot, so the state is visible
//   node dev/cws-drive.mjs goto <url>
//   node dev/cws-drive.mjs click "<text>"
//   node dev/cws-drive.mjs fill "<label>" "<value>"
//   node dev/cws-drive.mjs upload "<near-text>" <file>
//   node dev/cws-drive.mjs text                # visible text of the page
//
// Deliberately NOT automated: "Submit for review" and "Publish". Those are
// outward-facing and effectively irreversible, and they stay a human click.

import { chromium } from "playwright";

const CDP = process.env.CDP_URL || "http://127.0.0.1:9222";
const [cmd, ...args] = process.argv.slice(2);

// Anything that ships the listing. Refused even if asked by name.
const FORBIDDEN = /submit for review|publish item|publish now|^publish$/i;

function die(msg, code = 1) {
  process.stderr.write(msg + "\n");
  process.exit(code);
}

const browser = await chromium.connectOverCDP(CDP).catch((e) => {
  die(
    `Could not attach to Chrome at ${CDP}.\n` +
      `Is Chrome running with --remote-debugging-port=9222?\n\n${e.message}`,
  );
});

const contexts = browser.contexts();
if (!contexts.length) die("Attached, but Chrome has no browser context open.");

// Prefer a tab already on the developer dashboard; fall back to the active one.
let page = null;
for (const ctx of contexts) {
  for (const p of ctx.pages()) {
    const url = p.url();
    if (/chrome\.google\.com\/webstore\/devconsole|chromewebstore\.google\.com\/devconsole/.test(url)) {
      page = p;
      break;
    }
  }
  if (page) break;
}
if (!page) page = contexts[0].pages().at(-1) ?? (await contexts[0].newPage());

async function snapshot() {
  // Playwright's engine pierces open shadow roots, which is the only reason
  // this is tractable — the dashboard is almost entirely custom elements.
  const rows = [];
  for (const role of ["button", "link", "textbox", "combobox", "checkbox", "radio", "tab"]) {
    const loc = page.getByRole(role);
    const n = await loc.count();
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      const [name, visible] = await Promise.all([
        el.textContent().catch(() => ""),
        el.isVisible().catch(() => false),
      ]);
      if (!visible) continue;
      const label = (name || "").replace(/\s+/g, " ").trim().slice(0, 80);
      if (label) rows.push(`${role.padEnd(9)} | ${label}`);
    }
  }
  const files = await page.locator('input[type="file"]').count();
  process.stdout.write(`url: ${page.url()}\n\n${rows.join("\n")}\n\nfile inputs: ${files}\n`);
}

switch (cmd) {
  case "snapshot":
    await snapshot();
    break;

  case "text": {
    const t = await page.locator("body").innerText();
    process.stdout.write(t.replace(/\n{3,}/g, "\n\n").slice(0, 12000) + "\n");
    break;
  }

  case "shot":
    await page.screenshot({ path: args[0] || "cws.png", fullPage: args.includes("--full") });
    process.stdout.write(`wrote ${args[0] || "cws.png"} — ${page.url()}\n`);
    break;

  case "goto":
    if (!args[0]) die("goto needs a url");
    await page.goto(args[0], { waitUntil: "domcontentloaded" });
    process.stdout.write(`at ${page.url()}\n`);
    break;

  case "click": {
    const target = args[0];
    if (!target) die("click needs text");
    if (FORBIDDEN.test(target)) {
      die(`Refusing to click "${target}" — publishing is a human decision, not an automated one.`);
    }
    await page.getByText(target, { exact: false }).first().click({ timeout: 15000 });
    process.stdout.write(`clicked: ${target}\n`);
    break;
  }

  case "fill": {
    const [label, value] = args;
    if (!label || value === undefined) die('fill needs "<label>" "<value>"');
    // Several fields end in "justification", so a substring match on the
    // remote-code field's bare "Justification" label is ambiguous. Try exact
    // first and fall back to substring.
    let box = page.getByLabel(label, { exact: true }).first();
    if (!(await box.count().catch(() => 0))) {
      box = page.getByLabel(label, { exact: false }).first();
    }
    await box.fill(value, { timeout: 15000 });
    process.stdout.write(`filled ${label}\n`);
    break;
  }

  case "upload": {
    const [near, file] = args;
    if (!file) die('upload needs "<near-text>" <file>');
    // The dashboard hides its real <input type=file> behind a styled button, so
    // setInputFiles on the input directly is more reliable than a click dance.
    const inputs = page.locator('input[type="file"]');
    const n = await inputs.count();
    if (!n) die("no file input on this page");
    const idx = Number.isInteger(Number(near)) ? Number(near) : 0;
    // Screenshot slots take several files at once; setInputFiles REPLACES the
    // selection, so they have to go in one call rather than one per file.
    const files = args.slice(1);
    await inputs.nth(idx).setInputFiles(files);
    process.stdout.write(`uploaded ${files.length} file(s) to input #${idx}: ${files.join(", ")}\n`);
    break;
  }

  case "radio": {
    // Clicking the descriptive paragraph next to a radio does nothing — the
    // Visibility setting silently stayed on Public that way. Target the
    // control by role instead.
    if (!args[0]) die("radio needs a name");
    const r = page.getByRole("radio", { name: new RegExp(`^\\s*${args[0]}`, "i") }).first();
    await r.click({ timeout: 15000 });
    await page.waitForTimeout(500);
    const on = await r.isChecked().catch(() => null);
    process.stdout.write(`radio ${args[0]} -> checked=${on}\n`);
    if (on === false) die("radio did not take", 3);
    break;
  }

  case "scrollto": {
    // fullPage screenshots are useless here — the dashboard scrolls an inner
    // container, not the document — so bring the target into view first.
    if (!args[0]) die("scrollto needs text");
    await page.getByText(args[0], { exact: false }).first().scrollIntoViewIfNeeded({ timeout: 15000 });
    await page.waitForTimeout(500);
    process.stdout.write(`scrolled to ${args[0]}\n`);
    break;
  }

  case "options": {
    // Open a combobox and list what it offers. The dashboard's selects are
    // custom elements, so the options only exist in the DOM once opened.
    const name = args[0];
    if (!name) die("options needs the combobox name");
    await page.getByRole("combobox", { name: new RegExp(name, "i") }).first().click({ timeout: 15000 });
    await page.waitForTimeout(800);
    const opts = page.getByRole("option");
    const n = await opts.count();
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = (await opts.nth(i).textContent().catch(() => "")) || "";
      const label = t.replace(/\s+/g, " ").trim();
      if (label) out.push(label);
    }
    process.stdout.write(out.join("\n") + "\n");
    break;
  }

  case "select": {
    const [name, option] = args;
    if (!name || !option) die('select needs "<combobox>" "<option>"');
    await page.getByRole("combobox", { name: new RegExp(name, "i") }).first().click({ timeout: 15000 });
    await page.waitForTimeout(800);
    await page.getByRole("option", { name: new RegExp(`^\\s*${option}\\s*$`, "i") }).first().click({ timeout: 15000 });
    process.stdout.write(`selected ${option} for ${name}\n`);
    break;
  }

  default:
    die(
      "commands: snapshot | text | shot <out.png> | goto <url> | click <text> | " +
        "fill <label> <value> | upload <input-index> <file>",
    );
}

// Detach without closing — this is the user's browser, not ours.
await browser.close();
