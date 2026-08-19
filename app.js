// app.js — APAISuite shell bootstrap
//
// Responsibilities:
//   1. Build the sidebar from the module registry
//   2. Hash-based router: #/home, #/<moduleId>, #/<moduleId>/<sub...>
//   3. Mount/unmount modules on route change
//   4. Render the home dashboard with module cards
//
// Modules never edit the shell. They get a `host` object and a viewport
// element; everything else they own.

import { listModules, getModule }   from "./shared/registry.js";
import { createHost }               from "./shared/host.js";
import { $, $$, escapeHtml }        from "./shared/ui.js";
import { mountUpdaterIndicator }    from "./shared/updater_ui.js";
import { recordUsage }             from "./shared/usage_metrics.js";
import {
  getUserHomeStore, setUserHomeStoreOverride, clearUserHomeStoreOverride,
  extractWidFromAurorSub, extractStoreFromWid,
  getUserHomeMarket, setUserHomeMarket, clearUserHomeMarket,
  getUserRole, setUserRole, clearUserRole, onUserRoleChange, USER_ROLES,
  isHomeHeaderAllowedForRole,
  OVERRIDE_KEY,
} from "./shared/userStore.js";

const $nav  = $("#shell-nav");
const $main = $("#shell-main");

const FALLBACK_ROUTE = "#/home";

// ── Module ordering (drag-to-reorder, persisted per user) ───────
//
// User can drag modules around in the sidebar OR on the home card grid;
// the order is saved to chrome.storage.sync so it follows them across
// Edge profiles. Unknown ids (from a deleted module) are dropped silently;
// brand-new modules not in the saved order are appended to the end.
//
// Storage shape:
//   chrome.storage.sync["shell.moduleOrder"] = [
//     "claimsdisposition", "sparkfraud", "aurorbuddy", ...
//   ]
const MODULE_ORDER_KEY = "shell.moduleOrder";

// Modules the user has chosen not to see. Purely a display filter: hiding is
// not disabling, so a deep link to #/<id> still mounts a hidden module and its
// service keeps running. Anything else would make a hidden module's scheduled
// captures silently stop, which is not what "I'm not interested in this one"
// should mean.
//
// Storage shape: chrome.storage.sync["shell.hiddenModules"] = ["stockingplan", ...]
const HIDDEN_MODULES_KEY = "shell.hiddenModules";
let _cachedHidden = null;   // null until loaded; treat as "nothing hidden"

async function loadHiddenModules() {
  try {
    const got = await chrome.storage.sync.get(HIDDEN_MODULES_KEY);
    const v = got?.[HIDDEN_MODULES_KEY];
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : null;
  } catch {
    return null;
  }
}

async function saveHiddenModules(ids) {
  _cachedHidden = ids;
  try {
    await chrome.storage.sync.set({ [HIDDEN_MODULES_KEY]: ids });
  } catch (e) {
    console.warn("[shell] could not persist hidden modules:", e?.message);
  }
}

function isHiddenModule(mod) {
  return Array.isArray(_cachedHidden) && _cachedHidden.includes(mod?.manifest?.id);
}
const DRAG_MIME        = "application/x-apaisuite-module-id";
let _cachedOrder = null;   // null until first load completes; treat as "no override"

async function loadModuleOrder() {
  try {
    const got = await chrome.storage.sync.get(MODULE_ORDER_KEY);
    return Array.isArray(got?.[MODULE_ORDER_KEY]) ? got[MODULE_ORDER_KEY] : null;
  } catch (e) {
    console.warn("[shell] couldn't load module order:", e?.message);
    return null;
  }
}

async function saveModuleOrder(ids) {
  _cachedOrder = ids;
  try { await chrome.storage.sync.set({ [MODULE_ORDER_KEY]: ids }); }
  catch (e) { console.warn("[shell] couldn't save module order:", e?.message); }
}

// Apply the saved order to a fresh listModules() output. Modules in the
// saved order render first (in that order); anything not in the saved
// order — i.e. a module added since the user last reordered — appends.
function orderModules(modules, order) {
  if (!Array.isArray(order) || order.length === 0) return modules;
  const byId = new Map(modules.map((m) => [m.manifest.id, m]));
  const seen = new Set();
  const out  = [];
  for (const id of order) {
    if (byId.has(id)) { out.push(byId.get(id)); seen.add(id); }
  }
  for (const m of modules) {
    if (!seen.has(m.manifest.id)) out.push(m);
  }
  return out;
}

function getOrderedModules() {
  return orderModules(listModules(), _cachedOrder);
}

// Sidebar + home-cards lists exclude "home-header" surface modules — those
// render inline above the home cards instead of getting their own entry.
function isSidebarModule(mod) {
  return (mod?.manifest?.ui?.kind ?? "fullpage") === "fullpage";
}
function getSidebarModules() {
  return getOrderedModules().filter((m) => isSidebarModule(m) && !isHiddenModule(m));
}
// Role gating. Cached because getHomeHeaderModule() is called synchronously
// from render paths; null means "not loaded yet", which deliberately reads as
// "no gating" so the header is never hidden by a slow storage read.
let _cachedRole = null;

function getHomeHeaderModule() {
  // Policy lives in shared/userStore.js so it stays testable and so the
  // module-level role gating still to come extends one table, not two.
  if (!isHomeHeaderAllowedForRole(_cachedRole)) return null;
  const mod = getOrderedModules().find((m) => m?.manifest?.ui?.kind === "home-header") || null;
  return mod && !isHiddenModule(mod) ? mod : null;
}

// Wire an element as a drag source AND drop target for module reordering.
// `modId` identifies which module this element represents; `onDrop` fires
// with (draggedId, targetId) when the user releases over this element.
function wireModuleDnD(el, modId, onDrop) {
  el.draggable = true;
  el.dataset.moduleId = modId;
  el.style.cursor = "grab";

  el.addEventListener("dragstart", (ev) => {
    ev.dataTransfer.effectAllowed = "move";
    ev.dataTransfer.setData(DRAG_MIME, modId);
    el.classList.add("is-dragging");
  });
  el.addEventListener("dragend", () => {
    el.classList.remove("is-dragging");
    document.querySelectorAll(".is-drop-target").forEach((n) => n.classList.remove("is-drop-target"));
  });
  el.addEventListener("dragover", (ev) => {
    if (!ev.dataTransfer.types.includes(DRAG_MIME)) return;
    const draggedId = ev.dataTransfer.getData(DRAG_MIME);
    // dataTransfer.getData is empty during dragover in some browsers, so
    // we can't always detect "dragged over self" here. The drop handler
    // re-checks and no-ops if same.
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    if (!draggedId || draggedId !== modId) el.classList.add("is-drop-target");
  });
  el.addEventListener("dragleave", () => {
    el.classList.remove("is-drop-target");
  });
  el.addEventListener("drop", async (ev) => {
    ev.preventDefault();
    el.classList.remove("is-drop-target");
    const draggedId = ev.dataTransfer.getData(DRAG_MIME);
    if (!draggedId || draggedId === modId) return;
    await onDrop(draggedId, modId);
  });
}

// Compute a new id list with `draggedId` removed and re-inserted just
// before `targetId`. Works whether or not draggedId was already in the
// list (idempotent on dragged side).
function reorderIds(currentIds, draggedId, targetId) {
  const next = currentIds.filter((id) => id !== draggedId);
  const idx  = next.indexOf(targetId);
  if (idx === -1) next.push(draggedId);    // target not in list → append
  else            next.splice(idx, 0, draggedId);
  return next;
}

// Re-render on drop. The home-header surface (Live Dashboard strip) is
// also re-rendered when home is reshown, so we await renderHome.
async function onModuleReorder(draggedId, targetId) {
  const ids = getOrderedModules().map((m) => m.manifest.id);
  const next = reorderIds(ids, draggedId, targetId);
  await saveModuleOrder(next);
  renderSidebar();
  const hash = location.hash || FALLBACK_ROUTE;
  if (hash === "#/home" || hash === "#/") await renderHome();
}

// ── Sidebar render ────────────────────────────────────────────
function renderSidebar() {
  const modules = getSidebarModules();
  $nav.innerHTML = "";

  // Home (always first)
  $nav.appendChild(navItem({
    href: "#/home",
    label: "Home",
    icon: iconHome(),
  }));

  // Section header for tools (only if there's at least one module)
  if (modules.length) {
    const h = document.createElement("div");
    h.className = "shell-nav-section";
    h.textContent = "Tools";
    $nav.appendChild(h);
  }

  // Modules in saved order; deprecated ones go to the bottom in their
  // own section regardless of where they appear in the saved order.
  const active     = modules.filter((m) => m.manifest.status !== "deprecated");
  const deprecated = modules.filter((m) => m.manifest.status === "deprecated");

  for (const mod of active) $nav.appendChild(moduleNavItem(mod));

  if (deprecated.length) {
    const h2 = document.createElement("div");
    h2.className = "shell-nav-section";
    h2.textContent = "Deprecated";
    $nav.appendChild(h2);
    for (const mod of deprecated) $nav.appendChild(moduleNavItem(mod));
  }
}

function navItem({ href, label, icon, statusClass }) {
  const a = document.createElement("a");
  a.href = href;
  a.className = "shell-nav-item";
  a.dataset.route = href;
  if (icon)  a.appendChild(icon);
  const span = document.createElement("span");
  span.textContent = label;
  a.appendChild(span);
  if (statusClass) {
    const dot = document.createElement("span");
    dot.className = `shell-nav-status ${statusClass}`;
    a.appendChild(dot);
  }
  return a;
}

function moduleNavItem(mod) {
  const a = navItem({
    href: `#/${mod.manifest.id}`,
    label: mod.manifest.name,
    icon: iconModule(),
    statusClass: mod.manifest.status === "beta" ? "beta"
               : mod.manifest.status === "deprecated" ? "deprecated"
               : "",
  });
  wireModuleDnD(a, mod.manifest.id, onModuleReorder);
  return a;
}

// ── Router ────────────────────────────────────────────────────
let currentMount = null;   // { cleanup?: () => void, moduleId?: string }

async function route() {
  const hash = location.hash || FALLBACK_ROUTE;
  const path = hash.replace(/^#\//, "").split("/").filter(Boolean);
  const [head, ...rest] = path;

  // Highlight active nav item
  $$("a.shell-nav-item").forEach((el) => {
    const isActive = el.dataset.route === `#/${head ?? "home"}`
                  || (!head && el.dataset.route === "#/home");
    el.classList.toggle("is-active", isActive);
  });

  // Unmount previous — await so async cleanups (cancel polling loops,
  // unsubscribe from host.messaging.on, etc.) finish before we wipe the
  // viewport and start mounting the next module.
  if (currentMount?.cleanup) {
    try { await currentMount.cleanup(); } catch (e) { console.warn("[shell] cleanup threw:", e); }
  }
  currentMount = null;
  $main.innerHTML = "";

  if (!head || head === "home")     return renderHome();
  if (head === "settings")          return renderSettings();
  if (head === "docs")              return renderDocs();

  noteModuleOpened(head);
  return mountModule(head, rest);
}

// Usage telemetry: which tools are actually used, by which store and market.
// Pseudonymous — see the header of shared/usage_metrics.js.
//
// Recorded here rather than per-module so all eleven are covered without each
// one remembering to instrument itself, and so it cannot drift as modules are
// added. Fire-and-forget: a telemetry failure must never stop a module
// mounting, which is why nothing awaits this and every path swallows.
let _lastOpened = { id: null, at: 0 };
const REOPEN_DEDUPE_MS = 30_000;

function noteModuleOpened(moduleId) {
  if (!moduleId) return;
  // Bouncing between two modules is real usage; re-entering the SAME one
  // within half a minute is usually a back-button or a re-render, and
  // counting it would inflate exactly the number this exists to inform.
  const now = Date.now();
  if (_lastOpened.id === moduleId && now - _lastOpened.at < REOPEN_DEDUPE_MS) return;
  _lastOpened = { id: moduleId, at: now };

  recordUsage({ moduleName: moduleId, actionName: "module_opened" }).catch(() => {});
}

window.addEventListener("hashchange", route);

// ── Home dashboard ────────────────────────────────────────────
//
// renderHome can be invoked from multiple async sources at boot:
//   1. route() on the initial #/home navigation
//   2. loadModuleOrder().then(...) when a saved order resolves
//   3. onModuleReorder() on a drag-drop
//
// Without serialization, two concurrent calls each call $main.innerHTML=""
// then appendChild(root), leaving two dashboards stacked. Track in-flight
// and serialize.
let _renderHomePromise = null;

async function renderHome() {
  // Wait for any in-flight render to settle, then run a fresh one. The
  // most recent caller's state wins.
  while (_renderHomePromise) {
    try { await _renderHomePromise; } catch {}
  }
  _renderHomePromise = (async () => {
    try {
      // Tear down any prior inline-mounted module (home-header surface).
      // route() does this on hashchange, but renderHome can be invoked
      // directly (loadModuleOrder, onModuleReorder) without going through
      // route() — duplicate the cleanup here so we never double-mount.
      if (currentMount?.cleanup) {
        try { await currentMount.cleanup(); } catch (e) { console.warn("[shell] renderHome cleanup threw:", e); }
        currentMount = null;
      }
      $main.innerHTML = "";

      const modules = getSidebarModules();
      const root = document.createElement("div");
      root.className = "stack-lg";
      root.style.maxWidth = "1200px";
      root.style.margin   = "0 auto";

      // 1. Home-header module (Live Dashboard strip) — sits above the
      // module cards. Mounted with the same host/cleanup contract as a
      // fullpage module mount, so navigating away cleans up listeners.
      const headerMod = getHomeHeaderModule();
      if (headerMod) {
        const headerContainer = document.createElement("div");
        headerContainer.className = `module-${headerMod.manifest.id}`;
        headerContainer.dataset.surface = "home-header";
        root.appendChild(headerContainer);
        try {
          await mountInline(headerMod, headerContainer);
        } catch (e) {
          console.error(`[shell] home-header mount ${headerMod.manifest.id} failed:`, e);
          headerContainer.innerHTML = `<div class="state-error">Failed to load dashboard strip: ${escapeHtml(String(e?.message ?? e))}</div>`;
        }
      }

      // 2. Welcome heading
      const heading = document.createElement("div");
      heading.className = "stack-sm";
      heading.innerHTML = `
        <h1>Welcome to APAISuite</h1>
        <p class="muted">Asset Protection investigation tools, unified.
          ${modules.length === 0
            ? "No modules registered yet — see <code>modules/_registry.js</code>."
            : `${modules.length} module${modules.length === 1 ? "" : "s"} available.`}
        </p>
      `;
      root.appendChild(heading);

      // 3. Module card grid
      if (modules.length === 0) {
        const empty = document.createElement("div");
        empty.className = "state-empty";
        empty.innerHTML = `
          The suite shell is ready. Add a module by following
          <a href="#/docs">docs/MIGRATION_PLAN.md</a> →
          <em>Importing a new extension</em>.
        `;
        root.appendChild(empty);
      } else {
        const grid = document.createElement("div");
        grid.className = "grid grid-cards";
        for (const mod of modules) grid.appendChild(moduleCard(mod));
        root.appendChild(grid);
      }

      $main.appendChild(root);
    } finally {
      _renderHomePromise = null;
    }
  })();
  return _renderHomePromise;
}

// Mount a module's view into an inline container (vs. as the routed
// page). Used for home-header surfaces. Tracks cleanup in the same
// currentMount slot so route() will release listeners on navigation.
async function mountInline(mod, container) {
  const id = mod.manifest.id;
  const host = createHost(id, {
    route: (newHash) => { location.hash = newHash; },
    routePath: [],
    accent: mod.manifest.accent,
  });
  if (typeof mod.register === "function" && !registeredModules.has(id)) {
    await mod.register(host);
    registeredModules.add(id);
  }
  const m = await mod.manifest.ui.view();
  const mount = m.mount ?? m.default;
  if (typeof mount !== "function") {
    throw new Error(`module ${id} view.js must export mount(host, container)`);
  }
  const cleanup = await mount(host, container);
  currentMount = { cleanup, moduleId: id };
}

function moduleCard(mod) {
  const m = mod.manifest;
  const card = document.createElement("div");
  card.className = "module-card";
  card.innerHTML = `
    <div class="module-card-head">
      <span class="module-card-icon">${iconModuleSvg()}</span>
      <div class="stack" style="gap:2px">
        <span class="module-card-name">${escapeHtml(m.name)}</span>
        <span class="muted tiny">v${escapeHtml(m.version)} · ${escapeHtml(m.status)}</span>
      </div>
    </div>
    <div class="module-card-desc">${escapeHtml(m.description || "")}</div>
    <div class="module-card-foot">
      <span class="pill ${pillClassForStatus(m.status)}">${escapeHtml(m.status)}</span>
      <a href="#/${escapeHtml(m.id)}" class="btn btn-primary btn-sm btn-pill">Open</a>
    </div>
  `;
  wireModuleDnD(card, m.id, onModuleReorder);
  return card;
}

function pillClassForStatus(s) {
  return s === "deprecated" ? "pill-fail"
       : s === "beta"        ? "pill-warn"
       : "pill-ok";
}

// ── Module mount ──────────────────────────────────────────────
const registeredModules = new Set();

async function mountModule(id, restPath) {
  const mod = getModule(id);
  if (!mod) {
    $main.innerHTML = `<div class="state-error">Unknown module: <code>${escapeHtml(id)}</code></div>`;
    return;
  }

  const host = createHost(id, {
    route: (newHash) => { location.hash = newHash; },
    // Deep-copy to prevent modules from mutating the shell's call-stack arrays.
    routePath: [...restPath],
    accent: mod.manifest.accent,
  });

  try {
    // register() runs ONCE per module lifetime (per shell load) — for
    // one-time setup like storage migrations. Gated so subsequent route
    // changes don't repeatedly re-init.
    if (typeof mod.register === "function" && !registeredModules.has(id)) {
      await mod.register(host);
      registeredModules.add(id);
    }
    const m = await mod.manifest.ui.view();
    const mount = m.mount ?? m.default;
    if (typeof mount !== "function") {
      throw new Error(`module ${id} view.js must export mount(host, container)`);
    }
    // Module-scoped container — the .module-<id> class gives modules access
    // to their own accent CSS overrides (see styles/tokens.css per-module
    // blocks).
    const container = document.createElement("div");
    container.className = `module-${id}`;
    $main.appendChild(container);
    const cleanup = await mount(host, container);
    currentMount = { cleanup, moduleId: id };
  } catch (e) {
    console.error(`[shell] mount ${id} failed:`, e);
    $main.innerHTML = `
      <div class="state-error">
        <strong>Failed to load module <code>${escapeHtml(id)}</code>.</strong><br>
        ${escapeHtml(String(e?.message ?? e))}
      </div>
    `;
  }
}

// ── Settings ──────────────────────────────────────────────────
//
// The Defaults panel below is not cosmetic. Seven modules read the home store
// through shared/userStore.js, and VizPick reads the home market; until this
// existed there was no way to set either from the UI, so metricshot reported
// "no store set - set your store in Settings > Defaults" pointing at a page
// that had no such section.
//
// The store has an auto-detected source (the WIN ID in the cached Auror JWT);
// the market has none, so it is manual-only.

const AUROR_IDENTITY_KEY = "aurorbuddy.fb_aurorIdentity";

// The store that WOULD be used if no manual override existed. Shown so the
// user can tell "detected 1458" from "I typed 1458", which matters when
// deciding whether clearing the override is safe.
async function detectedHomeStore() {
  try {
    const got = await chrome.storage.local.get(AUROR_IDENTITY_KEY);
    const sub = got?.[AUROR_IDENTITY_KEY]?.aurorUserId;
    return extractStoreFromWid(extractWidFromAurorSub(sub)) || null;
  } catch {
    return null;
  }
}

function renderSettings() {
  const current = localStorage.getItem("shell.theme") || "system";
  $main.innerHTML = `
    <div class="stack" style="max-width:900px;margin:0 auto">
      <h1>Settings</h1>
      <div class="card">
        <h2 class="card-title">Appearance</h2>
        <div class="stack stack-sm">
          <p class="muted" style="margin:0">
            Theme — applies across every module. "System" follows your OS
            light/dark preference. Saved to chrome.storage.sync so it follows
            you to other Edge profiles.
          </p>
          <div class="cluster" role="radiogroup" aria-label="Theme">
            ${["system", "light", "dark"].map((t) => `
              <label class="check">
                <input type="radio" name="shell-theme" value="${t}" ${t === current ? "checked" : ""}>
                <span>${t[0].toUpperCase() + t.slice(1)}</span>
              </label>
            `).join("")}
          </div>
        </div>
      </div>
      <div class="card" id="settings-modules">
        <h2 class="card-title">Modules</h2>
        <div class="stack stack-sm">
          <p class="muted" style="margin:0">
            Untick anything you don't use to take it out of the sidebar and the
            home page. Hiding is not disabling — a hidden module keeps running
            its scheduled work, and a direct link to it still opens.
          </p>
          <div class="stack stack-sm" id="set-modules-list"></div>
        </div>
      </div>

      <div class="card" id="settings-defaults">
        <h2 class="card-title">Defaults</h2>
        <div class="stack stack-sm">
          <p class="muted" style="margin:0">
            Used across the suite — Metric Shots, VizPick, Live Dashboard,
            Claims Disposition, StockingPlan and Digital Locks all read these
            instead of asking every time. Saved to chrome.storage.sync.
          </p>

          <div class="field">
            <label class="field-label" for="set-home-store">Home store number</label>
            <div class="cluster">
              <input class="input" id="set-home-store" inputmode="numeric"
                     placeholder="e.g. 1458" style="max-width:180px">
              <button class="btn btn-primary btn-sm" id="set-home-store-save">Save</button>
              <button class="btn btn-secondary btn-sm" id="set-home-store-clear">Use detected</button>
            </div>
            <p class="muted tiny" id="set-home-store-note" style="margin:0"></p>
          </div>

          <div class="field">
            <span class="field-label" id="set-role-label">Role</span>
            <div class="cluster" role="radiogroup" aria-labelledby="set-role-label">
              ${USER_ROLES.map((r) => `
                <label class="check" title="${escapeHtml(r.hint)}">
                  <input type="radio" name="apai-role" value="${escapeHtml(r.value)}">
                  <span>${escapeHtml(r.label)}</span>
                </label>
              `).join("")}
              <button class="btn btn-secondary btn-sm" id="set-role-clear">Clear</button>
            </div>
            <p class="muted tiny" id="set-role-note" style="margin:0"></p>
          </div>

          <div class="field">
            <label class="field-label" for="set-home-market">Home market</label>
            <div class="cluster">
              <input class="input" id="set-home-market" inputmode="numeric"
                     placeholder="e.g. 120" style="max-width:180px">
              <button class="btn btn-primary btn-sm" id="set-home-market-save">Save</button>
              <button class="btn btn-secondary btn-sm" id="set-home-market-clear">Clear</button>
            </div>
            <p class="muted tiny" id="set-home-market-note" style="margin:0">
              VizPick preselects this market in the rollup. Nothing in your
              sign-in identifies a market, so it can't be detected for you.
            </p>
          </div>
        </div>
      </div>
    </div>
  `;
  // Wire the radios to apply + persist.
  for (const radio of $main.querySelectorAll('input[name="shell-theme"]')) {
    radio.addEventListener("change", () => {
      const v = radio.value;
      localStorage.setItem("shell.theme", v);
      window.__apaiApplyTheme?.(v);
      chrome.storage.sync.set({ "shell.theme": v }).catch(() => {});
    });
  }

  wireDefaults();
}

function wireDefaults() {
  const storeInput  = $("#set-home-store");
  const storeNote   = $("#set-home-store-note");
  const marketInput = $("#set-home-market");
  const marketNote  = $("#set-home-market-note");
  if (!storeInput || !marketInput) return;   // settings route replaced mid-flight

  const say = (el, msg, cls) => {
    if (!el) return;
    el.textContent = msg;
    el.className = `tiny ${cls || "muted"}`;
  };

  async function paintStore() {
    const [effective, detected, override] = await Promise.all([
      getUserHomeStore().catch(() => null),
      detectedHomeStore(),
      chrome.storage.sync.get(OVERRIDE_KEY).then((g) => g?.[OVERRIDE_KEY] ?? null).catch(() => null),
    ]);
    storeInput.value = effective || "";
    if (override) {
      say(storeNote, detected
        ? `Set manually. Detected from your sign-in: ${detected}.`
        : "Set manually. Nothing detected from your sign-in yet.");
    } else if (detected) {
      say(storeNote, `Detected from your sign-in. Type a different number to override.`);
    } else {
      say(storeNote, "Not set. Sign in to AurorBuddy once to detect it, or type it here.", "muted");
    }
  }

  async function paintMarket() {
    const m = await getUserHomeMarket().catch(() => null);
    marketInput.value = m || "";
  }

  $("#set-home-store-save")?.addEventListener("click", async () => {
    try {
      await setUserHomeStoreOverride(storeInput.value);
      await paintStore();
      say(storeNote, `Saved. ${storeNote.textContent}`, "muted");
    } catch {
      say(storeNote, "Store number must be 1-5 digits.", "state-error");
    }
  });

  $("#set-home-store-clear")?.addEventListener("click", async () => {
    await clearUserHomeStoreOverride().catch(() => {});
    await paintStore();
  });

  $("#set-home-market-save")?.addEventListener("click", async () => {
    try {
      await setUserHomeMarket(marketInput.value);
      say(marketNote, "Saved. VizPick will preselect this market.", "muted");
    } catch {
      say(marketNote, "Market must be 1-8 letters or digits.", "state-error");
    }
  });

  $("#set-home-market-clear")?.addEventListener("click", async () => {
    await clearUserHomeMarket().catch(() => {});
    marketInput.value = "";
    say(marketNote, "Cleared. VizPick will use the first market in the capture.", "muted");
  });

  const roleNote = $("#set-role-note");

  async function paintRole() {
    const role = await getUserRole().catch(() => null);
    for (const el of $main.querySelectorAll('input[name="apai-role"]')) {
      el.checked = el.value === role;
    }
    say(roleNote, role === "market"
      ? "Market: the Live Dashboard strip is hidden from the home page."
      : role
        ? "More modules will be filtered by role in a later release."
        : "Not set — nothing is filtered.");
  }

  for (const el of $main.querySelectorAll('input[name="apai-role"]')) {
    el.addEventListener("change", async () => {
      if (!el.checked) return;
      try {
        await setUserRole(el.value);
        // _cachedRole is refreshed by the onUserRoleChange subscription in the
        // boot block, which also re-renders home if that is the current route.
        await paintRole();
      } catch {
        say(roleNote, "Could not save that role.", "state-error");
      }
    });
  }

  $("#set-role-clear")?.addEventListener("click", async () => {
    await clearUserRole().catch(() => {});
    await paintRole();
  });

  wireModuleVisibility();

  paintStore();
  paintMarket();
  paintRole();
}

// Checklist of every registered module. Built from the registry rather than
// from the sidebar list, because the sidebar list is exactly what this filters
// — reading it back would make hidden modules unrecoverable from the UI.
function wireModuleVisibility() {
  const list = $("#set-modules-list");
  if (!list) return;

  const all = getOrderedModules();
  if (!all.length) {
    list.innerHTML = `<p class="muted tiny" style="margin:0">No modules registered.</p>`;
    return;
  }

  list.innerHTML = all.map((mod) => {
    const m = mod.manifest;
    const hidden = isHiddenModule(mod);
    const isHeader = m?.ui?.kind === "home-header";
    return `
      <label class="check" title="${escapeHtml(m.description || "")}">
        <input type="checkbox" data-module-id="${escapeHtml(m.id)}" ${hidden ? "" : "checked"}>
        <span>${escapeHtml(m.name)}${isHeader ? ' <span class="muted tiny">(home page strip)</span>' : ""}</span>
      </label>`;
  }).join("");

  for (const box of list.querySelectorAll("input[type=checkbox][data-module-id]")) {
    box.addEventListener("change", async () => {
      const id = box.dataset.moduleId;
      const next = new Set(Array.isArray(_cachedHidden) ? _cachedHidden : []);
      if (box.checked) next.delete(id); else next.add(id);
      await saveHiddenModules([...next]);
      renderSidebar();
    });
  }
}

function renderDocs() {
  $main.innerHTML = `
    <div class="stack" style="max-width:900px;margin:0 auto">
      <h1>Docs</h1>
      <p class="muted">Project docs live in <code>docs/</code>.</p>
      <div class="card">
        <ul style="margin:0;padding-left:1.5em">
          <li><code>EXTENSION_SUITE_AUDIT.md</code> — code-level audit of the three donors</li>
          <li><code>ARCHITECTURE.md</code> — plugin-style module registry</li>
          <li><code>MIGRATION_PLAN.md</code> — phased plan + how to import a new extension</li>
          <li><code>DESIGN_SYSTEM.md</code> — tokens + components</li>
          <li><code>SOURCE_MAPPING.md</code> — file-by-file migration tracker</li>
          <li><code>PERMISSIONS_MATRIX.md</code> — per-permission audit</li>
          <li><code>FEATURE_PARITY.md</code> — feature-by-feature status</li>
        </ul>
      </div>
      <div class="state-empty">In-app rendering of these markdown files will land in Phase 6.</div>
    </div>
  `;
}

// ── Icons (inline SVG; no external assets) ────────────────────
function iconHome() {
  const tpl = document.createElement("template");
  tpl.innerHTML = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
    <path d="M3 10l7-6 7 6v7a1 1 0 0 1-1 1h-4v-5H8v5H4a1 1 0 0 1-1-1z" stroke-linejoin="round"></path>
  </svg>`;
  return tpl.content.firstElementChild;
}
function iconModule() {
  const tpl = document.createElement("template");
  tpl.innerHTML = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
    <rect x="3" y="3" width="6" height="6" rx="1"></rect>
    <rect x="11" y="3" width="6" height="6" rx="1"></rect>
    <rect x="3" y="11" width="6" height="6" rx="1"></rect>
    <rect x="11" y="11" width="6" height="6" rx="1"></rect>
  </svg>`;
  return tpl.content.firstElementChild;
}
function iconModuleSvg() {
  return `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
    <rect x="3" y="3" width="6" height="6" rx="1"></rect>
    <rect x="11" y="3" width="6" height="6" rx="1"></rect>
    <rect x="3" y="11" width="6" height="6" rx="1"></rect>
    <rect x="11" y="11" width="6" height="6" rx="1"></rect>
  </svg>`;
}

// ── Boot ──────────────────────────────────────────────────────
// Render the sidebar immediately with the registry's natural order so the
// nav appears with no flash of empty content. Then load the user's saved
// module order from chrome.storage.sync and, if it differs, re-render.
// Same for home cards (handled in route() since renderHome reads the
// cached order on every call).
renderSidebar();

// Role decides whether the home-header strip mounts at all, so load it before
// home is likely to matter, and react if it changes on this or another device.
getUserRole().then(async (role) => {
  if (role === _cachedRole) return;
  _cachedRole = role;
  if ((location.hash || FALLBACK_ROUTE) === "#/home") await renderHome();
}).catch(() => {});

onUserRoleChange(async (role) => {
  _cachedRole = role;
  if ((location.hash || FALLBACK_ROUTE) === "#/home") await renderHome();
});

loadHiddenModules().then(async (hidden) => {
  if (!hidden) return;
  _cachedHidden = hidden;
  renderSidebar();
  if ((location.hash || FALLBACK_ROUTE) === "#/home") await renderHome();
}).catch(() => {});

loadModuleOrder().then(async (order) => {
  if (order) {
    _cachedOrder = order;
    renderSidebar();
    if ((location.hash || FALLBACK_ROUTE) === "#/home") await renderHome();
  }
}).catch(() => {});

// Populate the version pill from the manifest (app.html ships v0.1.0 as a
// placeholder; the actual version comes from manifest.json at runtime).
const $version = $("#suite-version");
if ($version) $version.textContent = `v${chrome.runtime.getManifest().version}`;

// Mount the "update available" banner under the header. Lives for the
// lifetime of the shell page — header isn't re-rendered per route, so we
// don't need to remount in route().
const $updateBanner = document.getElementById("suite-update-banner");
if ($updateBanner) mountUpdaterIndicator($updateBanner);

// ── Theme bootstrap ────────────────────────────────────────────
// app.html applied data-theme synchronously from localStorage to avoid FOUC.
// Here we reconcile with chrome.storage.sync — the authoritative store —
// so a preference set on another device propagates on next open.
// Also subscribe to the OS color-scheme media query for `theme: "system"`.
(async () => {
  try {
    const got = await chrome.storage.sync.get("shell.theme");
    const synced = got?.["shell.theme"];
    const local  = localStorage.getItem("shell.theme") || "system";
    if (synced && synced !== local) {
      localStorage.setItem("shell.theme", synced);
      applyTheme(synced);
    }
  } catch (e) { /* sync unavailable — local-only is fine */ }
})();

// When user picks "system", listen to OS preference changes.
if (window.matchMedia) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener?.("change", () => {
    if ((localStorage.getItem("shell.theme") || "system") === "system") {
      applyTheme("system");
    }
  });
}

function applyTheme(pref) {
  let resolved = pref;
  if (pref === "system") {
    resolved = window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  document.documentElement.setAttribute("data-theme", resolved);
}
// Exposed so renderSettings can call it on toggle.
window.__apaiApplyTheme = applyTheme;

route().catch((e) => {
  console.error("[shell] boot route failed:", e);
  $main.innerHTML = `<div class="state-error">Shell boot failed: ${escapeHtml(String(e?.message ?? e))}</div>`;
});
