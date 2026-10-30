// modules/gifphone/view.js
//
// One page, one button: connect to the phone over WebUSB, then run
// lib/setup.js's STEPS in order, painting each one as it goes. The adb key
// lives in this module's local storage so the phone's "Always allow" sticks.

import { AdbDevice, ADB_USB_FILTER, usbTransport, parseBanner } from "./lib/adb.js";
import { generateAdbKey } from "./lib/adb_key.js";
import { STEPS } from "./lib/setup.js";

const KEY_STORE = "adbKey";

export async function mount(host, container) {
  const link = document.createElement("link");
  link.rel = "stylesheet"; link.href = host.url("styles.css"); link.dataset.module = host.id;
  const cssReady = new Promise((resolve) => {
    link.addEventListener("load", resolve, { once: true });
    link.addEventListener("error", resolve, { once: true });
    setTimeout(resolve, 3000);
  });
  document.head.appendChild(link);
  await cssReady;

  container.innerHTML = await (await fetch(host.url("view.html"))).text();
  const $ = (sel) => container.querySelector(sel);
  let disposed = false, running = false, adb = null;

  // SW dispatcher wraps plain results as { ok, data }; handlers that return { ok, … } pass flat.
  async function ask(type, payload = {}, opts) {
    const r = await host.messaging.sendRaw(type, payload, opts);
    return (r && r.ok === true && Object.prototype.hasOwnProperty.call(r, "data")) ? r.data : r;
  }

  function note(msg, kind = "info") {
    const el = $("[data-note]");
    if (!msg) { el.hidden = true; return; }
    el.hidden = false; el.textContent = msg; el.className = `status-strip status-strip-${kind}`;
  }

  function log(line) {
    const el = $("[data-log]");
    el.textContent += `${new Date().toLocaleTimeString()}  ${line}\n`;
    el.scrollTop = el.scrollHeight;
  }

  function progress(frac) {
    const bar = $("[data-progress]");
    bar.hidden = frac == null || frac >= 1;
    bar.firstElementChild.style.width = `${Math.round((frac || 0) * 100)}%`;
  }

  // ── step list ───────────────────────────────────────────────────
  const rows = new Map();
  for (const s of STEPS) {
    const li = document.createElement("li");
    li.className = "gp-step";
    li.dataset.state = "todo";
    const title = document.createElement("span");
    title.className = "gp-step-title";
    title.textContent = s.title;
    const detail = document.createElement("span");
    detail.className = "gp-step-detail";
    li.append(title, detail);
    $("[data-steps]").append(li);
    rows.set(s.id, { li, detail });
  }
  function paint(id, state, text = "") {
    const r = rows.get(id);
    if (!r) return;
    r.li.dataset.state = state;
    r.detail.textContent = text;
  }

  // ── prerequisites the page can see ─────────────────────────────
  async function checkPrereqs() {
    const r = await ask("prereqs").catch(() => null);
    const el = $('[data-check="key"]');
    if (r?.hasKey) { el.textContent = "✓ found"; el.dataset.ok = "1"; }
    else { el.textContent = "✗ not set yet — the pairing step needs it"; el.dataset.ok = "0"; }
    return !!r?.hasKey;
  }

  if (!navigator.usb) {
    note("This browser can't reach USB devices. Use Microsoft Edge or Google Chrome on a Windows PC.", "error");
    $('[data-action="setup"]').disabled = true;
  }

  async function adbKey() {
    let key = await host.storage.local.get(KEY_STORE).catch(() => null);
    if (!key?.d) {
      key = await generateAdbKey();
      await host.storage.local.set(KEY_STORE, key);
    }
    return key;
  }

  // ── setup context: the callbacks steps lean on ──────────────────
  async function loadApk() {
    const [apk, info] = await Promise.all([
      fetch(host.url("vendor/gif-companion.apk")).then((r) => r.arrayBuffer()),
      fetch(host.url("vendor/gif-companion.json")).then((r) => r.json()),
    ]);
    return { apk: new Uint8Array(apk), apkInfo: info };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function makeCtx(apkBits) {
    const startedAt = Date.now();
    return {
      ...apkBits,
      log, progress,
      async pairCode() {
        const r = await ask("pair_phone");
        if (!r?.code) throw new Error(r?.error ? `QRCallBox wouldn't give a pairing code: ${r.error}` : "QRCallBox didn't return a pairing code.");
        log(`Pairing code ${r.code}`);
        return r.code;
      },
      async waitPaired(ms) {
        const until = Date.now() + ms;
        while (!disposed && Date.now() < until) {
          await sleep(3000);
          const s = await ask("pair_status").catch(() => null);
          const t = Date.parse(s?.phone?.pairedAt || "") || Number(s?.phone?.pairedAt) || 0;
          if (s?.phone && !s.pending && t >= startedAt - 5000) return s.phone;
        }
        return null;
      },
      async waitReporting(ms) {
        const until = Date.now() + ms;
        let last = null;
        while (!disposed && Date.now() < until) {
          await sleep(10_000);
          const h = await ask("health").catch(() => null);
          last = h;
          const p = h?.phone;
          if (p?.status?.state) log(`Phone: ${p.status.state}${p.status.step ? ` · ${p.status.step}` : ""}${p.status.code ? ` · ${p.status.code}` : ""}`);
          if (p && p.lastSeenSec != null && p.lastSeenSec < 90 && Date.now() - startedAt > 20_000) {
            if (Number(p.status?.lastOkAt) >= startedAt) return h;   // ms since epoch
            if (/SIGNIN|NEEDS_PERSON|BLOCKED|LOCKED|NO_GIF/i.test(p.status?.code || "")) return h;
          }
        }
        return last?.phone?.lastSeenSec < 90 ? last : null;
      },
    };
  }

  // ── the button ──────────────────────────────────────────────────
  async function connect() {
    let device;
    try {
      device = await navigator.usb.requestDevice({ filters: [ADB_USB_FILTER] });
    } catch {
      throw new Error("No phone picked. If the phone wasn't in the list, check USB debugging is on and the cable carries data (see 'If it gets stuck').");
    }
    const transport = await usbTransport(device);
    const conn = new AdbDevice(transport);
    log(`Connecting to ${device.productName || "phone"}…`);
    $("[data-device]").textContent = `${device.manufacturerName || ""} ${device.productName || "Phone"} — waiting for Allow on the phone…`.trim();
    const banner = await conn.connect(await adbKey(), {
      onPrompt: () => note("Look at the phone: tick 'Always allow from this computer' and tap Allow.", "warn"),
    });
    note("");
    const b = parseBanner(banner);
    $("[data-device]").textContent = `Connected: ${b.model || device.productName || "phone"}`;
    log(`Connected (${banner})`);
    return conn;
  }

  async function run() {
    if (running) return;
    running = true;
    const btn = $('[data-action="setup"]');
    btn.disabled = true; btn.textContent = "Setting up…";
    $("[data-after]").hidden = true;
    for (const s of STEPS) paint(s.id, "todo");
    note("");
    let failed = false;
    try {
      if (!(await checkPrereqs())) note("Your QRCallBox key isn't in the suite yet, so the pairing step will fail. Open the Workvivo module and save it first.", "warn");
      const apkBits = await loadApk();
      adb = await connect();
      const ctx = makeCtx(apkBits);
      for (const s of STEPS) {
        if (disposed) return;
        paint(s.id, "run", "");
        log(`▶ ${s.title}`);
        try {
          const r = await s.run(adb, ctx);
          paint(s.id, r.warn ? "warn" : "ok", r.detail || "");
          log(`  ${r.warn ? "⚠" : "✓"} ${r.detail || ""}`);
          if (s.id === "gif") $('[data-check="gif"]').textContent = ctx.gifFound ? "✓ GIF found on the phone" : "✗ GIF not found on the phone";
        } catch (e) {
          paint(s.id, "fail", e.message);
          log(`  ✗ ${e.message}`);
          throw e;
        } finally {
          progress(null);
        }
      }
      $("[data-after]").hidden = false;
      note("The phone is set up. You can close this page.", "success");
    } catch (e) {
      failed = true;
      note(e.message || String(e), "error");
    } finally {
      if (adb) { await adb.close(); adb = null; }
      running = false;
      btn.disabled = false; btn.textContent = failed ? "Try again" : "Set up phone";
    }
  }

  $('[data-action="setup"]').addEventListener("click", run);
  checkPrereqs();

  return () => {
    disposed = true;
    if (adb) adb.close();
    link.remove();
  };
}
