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
  return getOrderedModules().filter(isSidebarModule);
}
function getHomeHeaderModule() {
  return getOrderedModules().find((m) => m?.manifest?.ui?.kind === "home-header") || null;
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
  return mountModule(head, rest);
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

// ── Stub views ────────────────────────────────────────────────
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
      <div class="state-empty">More suite-level + per-module settings will land in Phase 6.</div>
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
