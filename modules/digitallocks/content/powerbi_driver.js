// modules/digitallocks/content/powerbi_driver.js
//
// Injected on demand by the SW (chrome.scripting.executeScript) into an
// app.powerbi.com tab. Runs in the ISOLATED world. Drives the per-visual
// "Export data" flow on the digital-lock-events data grid:
//   1. waitForReady          — data grid + Store slicer rendered
//   2. setStoreSlicer(n)     — open slicer, search, click exact option
//   3. triggerExportToExcel  — click the data-grid's More-options →
//                              Export → choose Excel + "Current layout" →
//                              click the dialog's Export button
// The SW captures the resulting .xlsx via chrome.downloads.onCreated; this
// script only signals "click finished, download will start now".

(() => {
  // Version marker — bump when changing this file so reload/injection issues
  // are obvious from the page's own console.
  console.log("[digitallocks driver] v3 — slicer-scoped search input + tolerant matching");
  if (window.__dlPbiListener) chrome.runtime.onMessage.removeListener(window.__dlPbiListener);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const handler = (msg, _s, sendResponse) => {
    if (msg?.module !== "digitallocks") return false;
    if (msg.type === "pbi-ping") {
      sendResponse({ ok: true, ready: isReady(), href: location.href });
      return false;
    }
    if (msg.type === "pbi-drive-export") {
      driveExport(msg.storeNumber)
        .then((r) => sendResponse({ ok: true, ...r }))
        .catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
      return true;
    }
    return false;
  };
  chrome.runtime.onMessage.addListener(handler);
  window.__dlPbiListener = handler;

  async function driveExport(storeNumber) {
    await waitFor(() => isReady(), 60_000, "Power BI report did not finish loading");
    if (storeNumber) {
      await setStoreSlicer(String(storeNumber));
      await waitForVisualsRefresh(20_000);
    }
    const startedAt = Date.now();
    await triggerExport();
    return { startedAt, slicerValue: storeNumber ?? null };
  }

  function findDataGrid() {
    return [...document.querySelectorAll(".visualContainer")]
      .find((v) => v.querySelector('[role="grid"]'));
  }
  function findStoreSlicer() {
    return [...document.querySelectorAll('[role="combobox"]')]
      .find((c) => /^Store$/i.test(c.getAttribute("aria-label") || ""));
  }
  function isReady() { return !!findDataGrid() && !!findStoreSlicer(); }

  async function setStoreSlicer(storeNumber) {
    const slicer = findStoreSlicer();
    if (!slicer) throw new Error("Store slicer not found");
    fireClick(slicer);
    await sleep(400);

    // Power BI's open slicer popup mounts a Search input somewhere in the
    // dropdown. We MUST filter out the page-level "Global search" bar at the
    // top — it also matches input[placeholder="Search"] and is visible.
    // Discovered via dev/probe-digitallocks-slicer.mjs: the page has ~10
    // Search inputs; the global one carries aria-label="Global search",
    // the slicer's carries aria-label="Search".
    const search = await waitFor(
      () => [...document.querySelectorAll(
        'input[placeholder="Search"], input[aria-label="Search"], input[type="search"]'
      )].find((el) => {
        if (el.offsetParent === null) return false;
        const lbl = (el.getAttribute("aria-label") || "").toLowerCase();
        return lbl !== "global search";
      }),
      5000, "Slicer search input did not appear",
    );
    setNativeValue(search, String(storeNumber));
    search.dispatchEvent(new Event("input", { bubbles: true }));
    search.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(700);

    const wanted = String(storeNumber).trim();
    const padded = wanted.padStart(4, "0");
    const norm = (s) => (s || "")
      .replace(/ /g, " ")    // NBSP → space (PBI uses these in labels)
      .replace(/\s+/g, " ")
      .trim();
    const wordRe = new RegExp(`(^|\\D)0*${wanted}(\\D|$)`);  // matches "1458" inside "1458 - Foo", "Store 01458", etc.

    let lastVisible = [];
    const opt = await waitFor(() => {
      const visible = [...document.querySelectorAll('[role="option"], [role="listitem"], .slicerItemContainer')]
        .filter((o) => o.offsetParent !== null);
      lastVisible = visible;
      // Match strategies, most-specific first:
      return visible.find((o) => norm(o.textContent) === wanted)
          || visible.find((o) => norm(o.textContent) === padded)
          || visible.find((o) => wordRe.test(norm(o.textContent)))
          || (visible.length === 1 ? visible[0] : null)  // search narrowed to one → take it
          || null;
    }, 6000, "").catch(() => null);

    if (!opt) {
      const sample = lastVisible.slice(0, 12).map((o) => JSON.stringify(norm(o.textContent))).join(", ");
      throw new Error(
        `Store option "${storeNumber}" not in slicer. Visible options after search ` +
        `(${lastVisible.length} shown): ${sample || "(none)"}`
      );
    }

    fireClick(opt);
    // Some PBI slicers require the checkbox/input inside the option to be
    // toggled too. Click any input[type=checkbox] descendant as belt-and-suspenders.
    const cb = opt.querySelector('input[type="checkbox"], [role="checkbox"]');
    if (cb && cb !== opt) fireClick(cb);
    await sleep(300);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    await sleep(200);
  }

  async function waitForVisualsRefresh(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let sawLoading = false;
    await sleep(300);
    while (Date.now() < deadline) {
      const loading = !!document.querySelector('[aria-label="Visuals are loading..."], [aria-label="Loading"]');
      if (loading) sawLoading = true;
      else if (sawLoading) return;
      await sleep(200);
    }
  }

  async function triggerExport() {
    const grid = findDataGrid();
    if (!grid) throw new Error("Data grid visual not found");
    hover(grid);
    await sleep(300);
    const gr = grid.getBoundingClientRect();
    const moreBtn = [...document.querySelectorAll('button[aria-label="More options"], button[title="More options"]')]
      .filter((b) => b.offsetParent !== null)
      .find((b) => {
        const r = b.getBoundingClientRect();
        return r.x >= gr.x - 5 && r.x <= gr.x + gr.width + 5 && r.y >= gr.y - 30 && r.y <= gr.y + 60;
      });
    if (!moreBtn) throw new Error("Data-grid 'More options' button not found");
    fireClick(moreBtn);
    await sleep(400);

    const visibleMenuItems = () =>
      [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], button, .menu-item, .menu-link')]
        .filter((i) => i.offsetParent !== null);
    const itemText = (el) => (el.textContent || "").replace(/\s+/g, " ").trim();

    // The chart-menu has historically labelled this either "Export data" or
    // just "Export" (sometimes the latter opens a submenu of formats, not a
    // dialog). Pick the most-specific match first.
    const exportItem = await waitFor(() => {
      const items = visibleMenuItems();
      return items.find((i) => /^export\s+data$/i.test(itemText(i)))
          || items.find((i) => /^export$/i.test(itemText(i)))
          || items.find((i) => /\bexport\b/i.test(itemText(i)));
    }, 5000, "Export menu item not found");
    fireClick(exportItem);
    await sleep(700);

    // Branch: a dialog may have opened directly, OR a flyout submenu may
    // have appeared offering Excel / CSV / Summarized-data choices. Race
    // both possibilities and act on whichever shows up.
    const dialogSelector = '[role="dialog"], .pbi-modal, .ms-Dialog';
    const dialog = await waitFor(() => {
      // Case A: dialog opened directly.
      const d = document.querySelector(dialogSelector);
      if (d) return d;
      // Case B: submenu opened — click the .xlsx / Excel / "Data" item to open the dialog.
      const submenuPick = visibleMenuItems().find((i) => {
        const t = itemText(i);
        return /excel|\.xlsx|^xlsx$/i.test(t)
            || /^data(\s+with.*layout)?$/i.test(t);  // "Data" or "Data with current layout"
      });
      if (submenuPick) {
        fireClick(submenuPick);
        return null;  // give the dialog a tick to mount; next poll picks it up
      }
      return null;
    }, 8000, "Export dialog/submenu did not produce a dialog. Visible items: " +
      visibleMenuItems().slice(0, 10).map((i) => JSON.stringify(itemText(i))).join(", "));

    // Inside dialog: pick Excel format if a chooser is present (radio or select).
    const xlsxRadio = [...dialog.querySelectorAll('input[type="radio"], [role="radio"]')]
      .find((r) => /xlsx|excel/i.test(r.getAttribute("aria-label") || r.closest("label")?.textContent || ""));
    if (xlsxRadio) fireClick(xlsxRadio);
    const formatSelect = [...dialog.querySelectorAll("select")]
      .find((s) => [...s.options].some((o) => /xlsx|excel/i.test(o.textContent)));
    if (formatSelect) {
      const opt = [...formatSelect.options].find((o) => /xlsx|excel/i.test(o.textContent));
      if (opt) {
        formatSelect.value = opt.value;
        formatSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }

    const exportBtn = [...dialog.querySelectorAll("button")]
      .filter((b) => b.offsetParent !== null && !b.disabled)
      .find((b) => /^(export|download|apply)$/i.test((b.textContent || "").trim()));
    if (!exportBtn) {
      const sample = [...dialog.querySelectorAll("button")]
        .filter((b) => b.offsetParent !== null)
        .map((b) => JSON.stringify((b.textContent || "").trim()))
        .slice(0, 8).join(", ");
      throw new Error(`Dialog Export/Download button not found. Visible buttons: ${sample}`);
    }
    fireClick(exportBtn);
  }

  // ── tiny helpers ─────────────────────────────────────────────────
  function fireClick(el) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new PointerEvent("pointerup",   { ...opts, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
    if (typeof el.click === "function") el.click();
  }
  function hover(el) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    ["pointerover", "pointerenter", "mouseover", "mouseenter", "mousemove"].forEach((t) => {
      try { el.dispatchEvent(new PointerEvent(t, { ...opts, pointerType: "mouse" })); }
      catch { el.dispatchEvent(new MouseEvent(t, opts)); }
    });
  }
  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "value")
              || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    desc?.set?.call(el, value);
  }
  async function waitFor(fn, timeoutMs, errMsg) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const v = fn();
      if (v) return v;
      await sleep(150);
    }
    throw new Error(errMsg || "waitFor timed out");
  }
})();
