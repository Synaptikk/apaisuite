// dev/gif-reader.mjs
//
// One-pass reader for the GIF app running in the headless `gif` emulator.
// Drives adb (uiautomator dump + input tap), navigates GIF, and emits JSON —
// run-model-agnostic: a poller/daemon/module just consumes the JSON.
//
// The GIF mobile backend is app-gated (no legit direct API for us; see
// MEMORY.md::managed-phone-screen-access), so the real app in the emulator is
// the data source and we read its accessibility tree. Headless screencap is
// black (swiftshader) — the text tree is the only signal, so everything here
// is uiautomator-based, never pixels.
//
// Usage:
//   node gif-reader.mjs home       # ensure signed-in on Store #1458 home
//   node gif-reader.mjs opd        # OPD Hourly: express items/orders per hour
//   node gif-reader.mjs notactive  # My Associates > Not active roster
//   node gif-reader.mjs assoc "<name>"   # one associate's detail (last-seen…)
//
// Fragile bits live behind named nav helpers so a GIF layout change is a
// one-line fix. Every tap is text/resource-id anchored, never raw coords,
// except the lock-screen PIN path (handled by the launcher, not here).

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ADB = process.env.ADB || `${process.env.HOME || process.env.USERPROFILE}/tools/android-sdk/platform-tools/adb.exe`;
const WORK_USER = "10";                 // GIF lives in the work profile
const PKG = "com.walmart.gif2";
const TMP = join(tmpdir(), "gif-ui.xml");
const DUMP_TIMEOUT_MS = 4000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function adb(args, { timeout = 15000 } = {}) {
  return execFileSync(ADB, args, { timeout, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function shell(cmd, opts) { return adb(["shell", ...cmd], opts); }

/** Dump the current window's a11y tree and return parsed nodes. */
export async function dump() {
  // uiautomator writes to the device; pull to a local temp and parse.
  try { shell(["uiautomator", "dump", "/sdcard/gif-ui.xml"], { timeout: DUMP_TIMEOUT_MS }); }
  catch { /* sometimes prints to stderr but still writes */ }
  adb(["pull", "/sdcard/gif-ui.xml", TMP], { timeout: 8000 });
  const xml = readFileSync(TMP, "utf8");
  return parseNodes(xml);
}

/** Minimal bounds+text parse — one object per node with a center point. */
function parseNodes(xml) {
  const out = [];
  const re = /<node\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const get = (k) => { const a = new RegExp(`${k}="([^"]*)"`).exec(attrs); return a ? a[1] : ""; };
    const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(attrs);
    if (!b) continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number);
    out.push({
      text: get("text"), desc: get("content-desc"), rid: get("resource-id").split("/").pop(),
      cls: get("class"), x1, y1, x2, y2, cx: (x1 + x2) >> 1, cy: (y1 + y2) >> 1,
    });
  }
  return out;
}

const label = (n) => n.text || n.desc || "";
function find(nodes, pred) { return nodes.find(pred); }
function findText(nodes, t, { exact = false } = {}) {
  return nodes.find((n) => exact ? label(n) === t : label(n).includes(t));
}
async function tap(cx, cy) { shell(["input", "tap", String(cx), String(cy)]); }
async function tapNode(n) { if (!n) throw new Error("tapNode: null"); await tap(n.cx, n.cy); }
// Gentle, controlled scroll — a long fast fling overshoots short lists.
async function swipeUp() { shell(["input", "swipe", "540", "1500", "540", "900", "500"]); }

/** The number paired with a row label: nearest node to its right on the same row. */
function valueRightOf(nodes, labelNode, { band = 40 } = {}) {
  const cands = nodes.filter((n) => n !== labelNode && /^\d[\d,]*$/.test(label(n).trim()) &&
    Math.abs(n.cy - labelNode.cy) <= band && n.cx > labelNode.cx);
  cands.sort((a, b) => (b.cx - a.cx)); // right-most number in the row
  return cands[0] ? Number(label(cands[0]).replace(/,/g, "")) : null;
}

/** Poll dump until pred(nodes) is truthy; returns the nodes or throws. */
async function waitFor(pred, { tries = 20, gap = 500, what = "condition" } = {}) {
  for (let i = 0; i < tries; i++) {
    const nodes = await dump();
    if (pred(nodes)) return nodes;
    await sleep(gap);
  }
  throw new Error(`waitFor timed out: ${what}`);
}

// ── Navigation ──────────────────────────────────────────────────
async function launchGif() {
  const brief = shell(["cmd", "package", "resolve-activity", "--brief", "--user", WORK_USER,
    "-c", "android.intent.category.LAUNCHER", PKG]).trim().split(/\r?\n/).pop();
  shell(["am", "start", "--user", WORK_USER, "-n", brief]);
}

/** The bottom tab bar (Home/Picking/Staging/Dispense/More) marks the GIF root. */
function hasRootNav(nodes) {
  return nodes.some((n) => label(n).trim() === "More" && n.cy > 2000) &&
         nodes.some((n) => label(n).trim() === "Home" && n.cy > 2000);
}

// Progress hook — the daemon sets this so /health can report the current step
// while a long read is in flight. No-op by default (CLI, tests).
let _onStep = () => {};
export function setProgressHook(fn) { _onStep = typeof fn === "function" ? fn : () => {}; }
function step(s) { try { _onStep(s); } catch { /* ignore */ } }

// ── Saved sign-in ───────────────────────────────────────────────
// When GIF's SSO session lapses it lands on the Walmart login form. The login
// lives in a local file next to the emulator PIN (never the repo, never logged):
// line 1 user id, line 2 password, line 3 store number.
const LOGIN_FILE = process.env.GIF_LOGIN || `${process.env.HOME || process.env.USERPROFILE}/tools/android-sdk/.gif-login`;
const LOGIN_COUNTRY = "United States";
const LOGIN_LOCATION = "Store/Club (NexGen – Pilot Site)";
// One try per saved file: a rejected password must not be replayed into an
// account lockout. Cleared when a sign-in reaches the GIF home, or the file changes.
let loginTried = null;
let submittedAt = 0;
// A rejection outlives the process: the marker holds the rejected file's mtime,
// so a daemon restart cannot replay it either. Saving a corrected file clears it.
const REJECTED_FILE = LOGIN_FILE + ".rejected";
function loginRejected(mtime) {
  try { return existsSync(REJECTED_FILE) && readFileSync(REJECTED_FILE, "utf8").trim() === String(mtime); } catch { return false; }
}

const byId = (nodes, id) => nodes.find((n) => n.rid === id);
function typeText(t) {
  // adb's own error text quotes the command line — never let that reach a log.
  try { shell(["input", "text", "'" + t.replace(/ /g, "%s").replace(/'/g, "'\\''") + "'"]); }
  catch { throw new Error("sign-in form: typing into a field failed"); }
}

async function fillField(id, value) {
  const n = byId(await waitFor((ns) => byId(ns, id), { tries: 8, gap: 700, what: `sign-in field ${id}` }), id);
  if (!n) throw new Error(`sign-in form: field ${id} not found`);
  // The soft keyboard covers the lower fields; a covered node reports a
  // collapsed box, and a tap there leaves focus (and the typing) in the
  // previous field.
  if (n.y2 <= n.y1) throw new Error(`sign-in form: field ${id} is covered`);
  await tapNode(n); await sleep(700);
  // Clear whatever a remembered or half-finished attempt left behind.
  shell(["input", "keyevent", "KEYCODE_MOVE_END", ...Array(40).fill("KEYCODE_DEL")]);
  typeText(value); await sleep(500);
  await hideKeyboard();
}
async function hideKeyboard() {
  // BACK only while the keyboard is up — otherwise it closes the sign-in tab.
  if (/mInputShown=true/.test(shell(["dumpsys", "input_method"]))) {
    shell(["input", "keyevent", "KEYCODE_BACK"]); await sleep(900);
  }
}
async function pickOption(id, option) {
  const n = byId(await waitFor((ns) => byId(ns, id), { tries: 8, gap: 700, what: `sign-in field ${id}` }), id);
  if (!n) throw new Error(`sign-in form: ${id} not found`);
  if (n.text.startsWith(option)) return;
  await tapNode(n);
  const isOpt = (ns) => find(ns, (o) => label(o) === option && /CheckedTextView/.test(o.cls));
  await tapNode(isOpt(await waitFor(isOpt, { tries: 10, gap: 700, what: `sign-in option "${option}"` })));
  await sleep(1500);
}

/** Fill the Walmart login form from LOGIN_FILE. False = no file, or this file was already rejected. */
async function savedSignIn() {
  if (!existsSync(LOGIN_FILE)) return false;
  const mtime = statSync(LOGIN_FILE).mtimeMs;
  if (loginTried === mtime || loginRejected(mtime)) return false;
  const [user, pass, store] = readFileSync(LOGIN_FILE, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).map((l) => l.trim());
  if (!user || !pass) return false;
  loginTried = mtime;
  step("signing in with the saved login");
  await pickOption("domainName", LOGIN_COUNTRY);
  await pickOption("BU", LOGIN_LOCATION);
  await fillField("username1", user);
  await fillField("password", pass);
  if (store) await fillField("store", store);
  const go = find(await dump(), (n) => label(n) === "Sign In" && /Button/.test(n.cls));
  if (!go || go.y2 <= go.y1) throw new Error("sign-in form: Sign In button not found");
  await tapNode(go);
  return true;
}

/** Ensure GIF is signed in and on the root home (bottom nav present). */
export async function ensureHome() {
  step("opening GIF");
  await launchGif();
  await sleep(4000);
  for (let i = 0; i < 14; i++) {
    const nodes = await dump();
    // "Something went wrong. Tap RESTART APP" — routine right after a sign-in;
    // restarting is all it needs.
    const restart = findText(nodes, "Restart application", { exact: true });
    if (restart) { step("GIF start-up error — restarting it"); await tapNode(restart); await sleep(15000); continue; }
    // Session Inactive dialog -> OK closes app, then relaunch
    if (findText(nodes, "Session Inactive")) {
      step("GIF session expired — reopening");
      const ok = findText(nodes, "OK", { exact: true }); if (ok) await tapNode(ok);
      await sleep(2000); await launchGif(); await sleep(4000); continue;
    }
    // SSO fell through to the Walmart login form (its heading is also an exact
    // "Sign in") — only a person can finish that, so stop instead of tapping.
    if (findText(nodes, "Forgot Password?")) {
      if (findText(nodes, "recognize the username or password") && existsSync(LOGIN_FILE)) {
        try { writeFileSync(REJECTED_FILE, String(statSync(LOGIN_FILE).mtimeMs)); } catch { /* still refuse below */ }
        step("saved login was rejected");
        throw Object.assign(new Error("GIF sign-in rejected the saved login — fix the login file or sign in by hand"), { code: "NEEDS_SIGNIN" });
      }
      if (await savedSignIn()) { submittedAt = Date.now(); await sleep(15000); continue; }
      // The form lingers while SSO redirects; give a just-submitted login time.
      if (Date.now() - submittedAt < 75_000) { step("waiting for the sign-in to go through"); await sleep(5000); continue; }
      step("GIF needs a manual sign-in");
      throw Object.assign(new Error("GIF needs a manual sign-in (SSO asked for a password)"), { code: "NEEDS_SIGNIN" });
    }
    // Sign-in screen -> tap Sign in (auto-auths via SSO)
    const signin = findText(nodes, "Sign in", { exact: true });
    if (signin) { step("signing in to GIF"); await tapNode(signin); await sleep(14000); continue; }
    // "Go to home store" popup
    const gohome = find(nodes, (n) => n.rid === "component-button-alert-popup-Go to home store-" || label(n) === "Go to home store");
    if (gohome) { step("returning to home store"); await tapNode(gohome); await sleep(6000); continue; }
    // Already at the root home?
    if (hasRootNav(nodes)) { loginTried = null; step("GIF ready"); return nodes; }
    // GIF not in front yet (still launching, or handing off to the SSO tab) —
    // wait; a BACK here closes it before the sign-in page can be recognised.
    if (!gifFocused()) {
      // Chrome = the SSO tab is still loading; anything else (the launcher)
      // means GIF closed, so bring it back.
      if (!chromeFocused()) { await launchGif(); }
      await sleep(3000); continue;
    }
    // Still loading after sign-in / home-store switch — BACK would close GIF.
    if (findText(nodes, "Getting user info") || findText(nodes, "Loading")) { await sleep(3000); continue; }
    // In GIF but on a sub-screen — back out toward the root.
    shell(["input", "keyevent", "KEYCODE_BACK"]); await sleep(1500);
  }
  throw new Error("ensureHome: could not reach GIF root home");
}

function chromeFocused() {
  try { return /com\.android\.chrome/.test(shell(["dumpsys", "window"]).split(/\r?\n/).find((l) => /mCurrentFocus/.test(l)) || ""); }
  catch { return false; }
}

function gifFocused() {
  try { return /com\.walmart\.gif2/.test(shell(["dumpsys", "window"]).split(/\r?\n/).find((l) => /mCurrentFocus/.test(l)) || ""); }
  catch { return false; }
}

/**
 * Back out to the GIF root (bottom nav showing) from wherever a previous read
 * left it. One BACK too many leaves GIF for the launcher, so check focus and
 * relaunch rather than keep pressing.
 */
async function toRoot() {
  for (let i = 0; i < 7; i++) {
    if (!gifFocused()) { await launchGif(); await sleep(3500); }
    const ns = await dump();
    if (hasRootNav(ns)) return ns;
    shell(["input", "keyevent", "KEYCODE_BACK"]); await sleep(1300);
  }
  throw new Error("toRoot: could not get back to the GIF home screen");
}

async function openMore() {
  let nodes = await dump();
  if (!hasRootNav(nodes)) nodes = await toRoot();
  const more = find(nodes, (n) => /(,|^)\s*More$/.test(label(n)) && n.cy > 2000);
  if (!more) throw new Error("openMore: More nav not found");
  await tapNode(more); await sleep(1500);
}

export async function openMyStore() {
  await openMore();
  const nodes = await dump();
  const ms = findText(nodes, "My Store", { exact: true });
  if (!ms) throw new Error("openMyStore: My Store not in More sheet");
  await tapNode(ms);
  await waitFor((ns) => findText(ns, "My Tasks") || findText(ns, "My Associates"), { what: "My Store" });
}

/**
 * Scroll the page down and confirm it actually moved. A swipe fired while a
 * screen is still settling is dropped the same way an early tap is, so compare
 * an on-screen anchor before and after and retry with a different stroke.
 * Returns the post-scroll nodes, or null when the page will not move (bottom).
 */
async function scrollDown(before) {
  const anchor = before.find((n) => label(n).trim() && n.cy > 400 && n.cy < 1900);
  const strokes = [["540", "1500", "540", "900", "500"], ["540", "1800", "540", "900", "350"], ["540", "1700", "540", "700", "400"]];
  for (const s of strokes) {
    shell(["input", "swipe", ...s]); await sleep(900);
    const after = await dump();
    if (!anchor) return after;
    const same = after.find((n) => label(n) === label(anchor) && n.cx === anchor.cx);
    if (!same || same.cy !== anchor.cy) return after;   // moved
    await sleep(800);
  }
  return null;
}

export async function openPickMonitoring() {
  await openMyStore();
  await sleep(1200); // let My Store settle before scrolling
  // scroll to reveal "Pick Monitoring", then tap the clickable row — only when
  // it is safely inside the viewport (a node at the scroll edge taps as a drag).
  let nodes = await dump();
  for (let i = 0; i < 7 && nodes; i++) {
    const pm = nodes.find((n) => label(n).includes("Pick Monitoring") && n.cls?.includes("Button"))
            || findText(nodes, "Pick Monitoring");
    if (pm && pm.cy > 300 && pm.cy < 1950) {
      for (let t = 0; t < 3; t++) {
        await tapNode(pm); await sleep(1500);
        const ns = await dump();
        if (findText(ns, "OPD Hourly") || findText(ns, "Commodity View")) return;
      }
      throw new Error("openPickMonitoring: tapped Pick Monitoring but the tabs never opened");
    }
    nodes = await scrollDown(nodes);
  }
  throw new Error("openPickMonitoring: Pick Monitoring link not found");
}

// ── Readers ─────────────────────────────────────────────────────
export async function readOpdHourly() {
  step("opening Pick Monitoring");
  await openPickMonitoring();
  step("reading OPD Hourly");
  let nodes = await dump();
  const tab = findText(nodes, "OPD Hourly", { exact: true });
  if (tab) { await tapNode(tab); await sleep(1500); nodes = await dump(); }

  const readyNode = findText(nodes, "Ready to Pick");
  const readyToPick = readyNode ? valueRightOf(nodes, readyNode) : null;
  const upNode = find(nodes, (n) => /^Upcoming Picks,\s*[\d,]+/.test(label(n)));
  const upcomingPicks = upNode ? Number(/([\d,]+)\s*$/.exec(label(upNode))[1].replace(/,/g, "")) : null;

  const result = { readyToPick, upcomingPicks, capturedAt: new Date().toISOString(), hours: [], completed: [] };

  // Open slots sit above the "Completed Hours" header. Only these expand, and
  // only these show Express — and what they show is the express qty STILL TO
  // PICK, which falls as it is picked and rises as orders drop in. The daemon
  // turns successive reads into a drop-in estimate (lib/gif_metrics.js).
  const slotRe = /^\d{1,2}(am|pm)\s*-\s*\d{1,2}(am|pm)$/i;
  const completedHdr = findText(nodes, "Completed Hours");
  const openLabels = [...new Set(nodes
    .filter((n) => slotRe.test(label(n).trim()) && (!completedHdr || n.cy < completedHdr.cy))
    .map((n) => label(n).trim()))];

  step(`reading ${openLabels.length} open hour(s)`);
  for (const slot of openLabels) {
    step(`reading hour ${slot}`);
    // re-find the slot node (list position stable within one dump)
    const cur = (await dump());
    const node = cur.find((n) => label(n).trim() === slot);
    if (!node) continue;
    await tapNode(node);
    let d;
    try { d = await waitFor((ns) => findText(ns, "Left to Pick") || findText(ns, "picked)"), { tries: 12, what: `hour ${slot}` }); }
    catch { d = await dump(); }
    const expressNode = findText(d, "Express", { exact: true });
    const expressQty = expressNode ? valueRightOf(d, expressNode) : null;
    // express orders ≈ pick-walk cards below the Express section header
    const expressOrders = expressNode
      ? d.filter((n) => n.rid === "pick-walk-card" && n.cy > expressNode.cy).length
      : null;
    // "(678 / 828 picked)" -> picked/total; left is derived (its tile value
    // sits below the label, and "Exceptions Left 0" sits beside it — both trap
    // a naive right-of lookup, so compute it instead).
    const pp = d.map(label).find((t) => /\(\s*\d[\d,]*\s*\/\s*\d[\d,]*\s*picked\)/.test(t));
    let picked = null, total = null;
    if (pp) { const mm = /\(\s*([\d,]+)\s*\/\s*([\d,]+)\s*picked\)/.exec(pp); if (mm) { picked = +mm[1].replace(/,/g, ""); total = +mm[2].replace(/,/g, ""); } }
    const left = (picked != null && total != null) ? total - picked : null;
    // "41 qty unassigned for 06:58pm" under the Express header
    const un = expressNode && d.map((n) => ({ t: label(n), cy: n.cy }))
      .find((x) => x.cy > expressNode.cy && /^\d+\s+qty unassigned/i.test(x.t));
    const expressUnassigned = un ? Number(/^(\d+)/.exec(un.t)[1]) : null;
    result.hours.push({ slot, expressQty, expressOrders, expressUnassigned, picked, total, left });
    // go back to the OPD Hourly list
    shell(["input", "keyevent", "KEYCODE_BACK"]); await sleep(1200);
  }

  step("reading completed hours");
  // Closed slots: not expandable, one "Qtys Picked" figure each. Expand the
  // section, then scroll-collect every row (the list runs off the screen).
  let list = await dump();
  const hdr = findText(list, "Completed Hours");
  // The section remembers its expanded state; tapping an open one collapses it.
  const alreadyOpen = hdr && list.some((n) => slotRe.test(label(n).trim()) && n.cy > hdr.cy);
  if (hdr && !alreadyOpen) { await tapNode(hdr); await sleep(1300); list = await dump(); }
  const seen = new Map();
  for (let i = 0; i < 6 && list; i++) {
    for (const n of list) {
      const t = label(n).trim();
      if (!slotRe.test(t) || seen.has(t) || openLabels.includes(t)) continue;
      const v = valueRightOf(list, n);
      if (v != null) seen.set(t, v);
    }
    const before = seen.size;
    list = await scrollDown(list);
    if (list && seen.size === before && i > 1) {
      // one more pass over the post-scroll dump, then stop when nothing new
      for (const n of list) { const t = label(n).trim(); if (slotRe.test(t) && !seen.has(t) && !openLabels.includes(t)) { const v = valueRightOf(list, n); if (v != null) seen.set(t, v); } }
      if (seen.size === before) break;
    }
  }
  result.completed = [...seen].map(([slot, qtyPicked]) => ({ slot, qtyPicked }));
  return result;
}

/**
 * The whole day's picking roster from the "All" filter: every associate active
 * today with their current status. Rows read "<Name>, <Status>" (Picking /
 * Backroom / Dispensing / Not Active). One cheap scroll-collect — no per-person
 * drilling. Status is normalised to picking|backroom|dispensing|notactive.
 */
export async function readAllAssociates() {
  step("reading All associates list");
  await openAssociatesList();
  // select the "All (N)" filter chip
  let nodes = await dump();
  const chip = find(nodes, (n) => /^All\s*\(\d+\)/.test(label(n)));
  if (chip) { await tapNode(chip); await sleep(1200); }
  const lastUpd = (findText(await dump(), "Last updated:") || {}).text || null;

  const byName = new Map();
  let stable = 0;
  for (let i = 0; i < 16 && stable < 2; i++) {
    const ns = await dump();
    const before = byName.size;
    for (const n of ns) {
      if (!n.cls?.includes("Button")) continue;
      const m = /^(.+?),\s*([A-Za-z ]+)$/.exec(label(n).trim());
      if (!m) continue;
      const status = m[2].trim().toLowerCase().replace(/\s+/g, "");
      if (!["picking", "backroom", "dispensing", "notactive"].includes(status)) continue;
      byName.set(m[1].trim(), status);
    }
    stable = byName.size === before ? stable + 1 : 0;
    await swipeUp(); await sleep(700);
  }
  const seen = [...byName].map(([name, status]) => ({ name, status }));
  return { lastUpdated: lastUpd, seen, count: seen.length, capturedAt: new Date().toISOString() };
}

export async function readNotActive() {
  step("reading Not Active list");
  await openMyStore();
  await sleep(1500); // let My Store settle — taps fired mid-render are dropped
  // The "Not active, N" chip on My Store opens the associates list directly.
  // Retry the tap: the first can land before the row is interactive.
  let nodes;
  for (let i = 0; i < 4; i++) {
    nodes = await dump();
    if (findText(nodes, "Search by name")) break; // list already open
    const entry = find(nodes, (n) => /^Not active,\s*\d+/.test(label(n)) && n.cls?.includes("Button"))
               || find(nodes, (n) => /^My Associates,/.test(label(n)) && n.cls?.includes("Button"));
    if (!entry) throw new Error("readNotActive: no associates entry on My Store");
    await tapNode(entry); await sleep(1800);
  }
  nodes = await waitFor((ns) => findText(ns, "Search by name"), { what: "associates list" });
  // Select the "Not active (N)" filter chip (the list opens on All/Picking).
  const chip = find(nodes, (n) => /^Not active\s*\(\d+\)/.test(label(n)));
  if (chip) { await tapNode(chip); await sleep(1200); }
  const lastUpd = (findText(await dump(), "Last updated:") || {}).text || null;

  // Scroll-collect every "<Name>, Not active" row.
  const names = new Set();
  let stable = 0;
  for (let i = 0; i < 10 && stable < 2; i++) {
    const ns = await dump();
    const before = names.size;
    ns.filter((n) => /,\s*Not active$/i.test(label(n)) && n.cls?.includes("Button"))
      .forEach((n) => names.add(label(n).replace(/,\s*Not active$/i, "").trim()));
    stable = names.size === before ? stable + 1 : 0;
    await swipeUp(); await sleep(700);
  }
  return { lastUpdated: lastUpd, notActive: [...names], count: names.size, capturedAt: new Date().toISOString() };
}

/** My Store → the associates list (search box showing). */
async function openAssociatesList() {
  // Already there (readNotActive leaves the list open)? Use it as is.
  const here = await dump();
  if (findText(here, "Search by name")) return here;
  await openMyStore();
  await sleep(1200);
  // open the associates list via the Not active chip (any entry works)
  for (let i = 0; i < 4; i++) {
    const nodes = await dump();
    if (findText(nodes, "Search by name")) break;
    const entry = find(nodes, (n) => /^Not active,\s*\d+/.test(label(n)) && n.cls?.includes("Button"))
               || find(nodes, (n) => /^My Associates,/.test(label(n)) && n.cls?.includes("Button"));
    if (entry) { await tapNode(entry); await sleep(1800); }
  }
  return waitFor((ns) => findText(ns, "Search by name"), { what: "associates list" });
}

/** One associate's detail: last-seen, pick rate, qty, pickwalks, orders. */
export async function readAssociateDetail(name) {
  await openAssociatesList();
  return detailFromList(name);
}

/**
 * Several associates in one trip: open the list once, then for each name clear
 * the search box, type the name, read the detail and come back. About 20 s a
 * name instead of ~1 min when each started from GIF home.
 * @returns {Promise<Record<string, object>>} detail (or {error}) per name
 */
export async function readAssociateDetails(names) {
  const out = {};
  if (!names?.length) return out;
  await openAssociatesList();
  let _i = 0;
  for (const name of names) {
    step(`reading associate ${++_i}/${names.length}: ${name}`);
    try { out[name] = await detailFromList(name); }
    catch (e) { out[name] = { name, error: e.message }; }
    // back to the list (one BACK leaves the detail; a second only if the
    // keyboard swallowed the first)
    for (let i = 0; i < 3; i++) {
      const ns = await dump();
      if (findText(ns, "Search by name")) break;
      shell(["input", "keyevent", "KEYCODE_BACK"]); await sleep(1200);
    }
  }
  return out;
}

/** On the associates list: search `name`, open its detail, read it. */
async function detailFromList(name) {
  let nodes = await dump();
  // clear whatever the box holds, then type the name to filter
  const box = find(nodes, (n) => n.cls?.includes("EditText"));
  if (box) {
    await tapNode(box); await sleep(400);
    shell(["input", "keyevent", "KEYCODE_MOVE_END", ...Array(40).fill("KEYCODE_DEL")]);
    shell(["input", "text", name.replace(/ /g, "%s")]); await sleep(1200);
  }
  // Tap the row, retrying — a tap fired before the filtered row is interactive
  // is dropped (same mid-render issue as the My Store chip).
  let d;
  for (let i = 0; i < 4; i++) {
    nodes = await dump();
    if (findText(nodes, "Live Performance") || findText(nodes, "Associate Profile")) break;
    const row = nodes.find((n) => label(n).startsWith(name) && n.cls?.includes("Button"));
    if (!row) throw new Error(`readAssociateDetail: '${name}' not found in roster`);
    await tapNode(row); await sleep(1800);
  }
  d = await waitFor((ns) => findText(ns, "Live Performance") || findText(ns, "Associate Profile"), { what: `detail ${name}` });
  // The metric tiles carry their value in the ViewGroup description
  // ("Qty picked, 55", "Avg pick rate, 98.65, items/hr"). Last-seen + the
  // pickwalks/orders tiles are hidden until the "Pickwalk History" toggle is
  // tapped — expand it, then merge that dump in.
  const ph = findText(d, "Pickwalk History");
  if (ph) { await tapNode(ph); await sleep(1200); }
  const all = [...d, ...(await dump())];
  const descs = all.map(label);
  const grab = (re) => { for (const t of descs) { const m = re.exec(t); if (m) return Number(m[1].replace(/,/g, "")); } return null; };
  const lastSeen = descs.find((t) => /^Last seen at /i.test(t)) || null;
  // picking-duration appears only while the associate is actively picking
  const pickingFor = descs.find((t) => /pick(ing)?\s+(duration|for)/i.test(t)) || null;
  return {
    name, lastSeen, pickingFor,
    avgPickRate: grab(/Avg pick rate,\s*([\d.,]+)/i),
    qtyPicked: grab(/Qty picked,\s*([\d,]+)/i),
    pickwalksCompleted: grab(/Pickwalks completed,\s*([\d,]+)/i),
    ordersPicked: grab(/Orders Picked,\s*([\d,]+)/i),
    capturedAt: new Date().toISOString(),
  };
}

// ── CLI (only when run directly, not when imported by gif-daemon) ──
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, arg] = process.argv.slice(2);
  try {
    let out;
    if (cmd === "home") { await ensureHome(); out = { ok: true, where: "home" }; }
    else if (cmd === "opd") { await ensureHome(); out = await readOpdHourly(); }
    else if (cmd === "notactive") { await ensureHome(); out = await readNotActive(); }
    else if (cmd === "all") { await ensureHome(); out = await readAllAssociates(); }
    else if (cmd === "assoc") { await ensureHome(); out = await readAssociateDetail(arg); }
    else if (cmd === "assocs") { await ensureHome(); out = await readAssociateDetails(arg.split("|")); }
    else { out = { error: `unknown cmd '${cmd}'. use: home|opd|notactive|assoc "<name>"` }; }
    console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    console.error("READER ERROR:", e.message);
    process.exit(1);
  }
}
