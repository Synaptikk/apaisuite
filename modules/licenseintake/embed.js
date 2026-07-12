// modules/licenseintake/embed.js
//
// Standalone bootstrap for embedding LicenseIntake inside another
// page (e.g., the Auror in-page overlay). Mirrors what the suite shell
// does for one module — no sidebar, no theme switcher, no other modules.
//
// The host context is constructed via shared/host.js::createHost so the
// view sees the same `host.storage` / `host.messaging` / `host.url` /
// `host.logging` API it gets in the full suite. All chrome.* APIs work
// because this page is served from the extension's own origin.

import { createHost }    from "../../shared/host.js";
import licenseintakeMod  from "./module.js";

// ── Theme adoption ────────────────────────────────────────────────
// Parent (the content script on Auror's page) posts the sampled Auror
// palette right after iframe load. We translate it into the suite's
// own --apai-* token names so the existing licenseintake stylesheet
// re-skins itself without code changes.
window.addEventListener("message", (e) => {
  const msg = e?.data;
  if (!msg || msg.type !== "li_apply_theme" || !msg.theme) return;
  applyTheme(msg.theme);
});

function applyTheme(t) {
  const root = document.documentElement.style;
  if (t.bg)         root.setProperty("--apai-bg", t.bg);
  if (t.bgElev)     root.setProperty("--apai-bg-elev", t.bgElev);
  if (t.fg)         root.setProperty("--apai-fg", t.fg);
  if (t.fgMuted)    root.setProperty("--apai-fg-muted", t.fgMuted);
  if (t.border)     root.setProperty("--apai-border", t.border);
  if (t.accent)     root.setProperty("--apai-accent", t.accent);
  if (t.accentFg)   root.setProperty("--apai-accent-fg", t.accentFg);
  if (t.fontFamily) root.setProperty("--apai-font", t.fontFamily);
  // Also reset our module accent so the green pill / score chips inherit
  // Auror's primary color instead of LicenseIntake's default green.
  if (t.accent) {
    document.documentElement.style.setProperty("--module-accent", t.accent);
  }
}

(async () => {
  const root = document.getElementById("embed-root");
  if (!root) return;

  // Module-scoped container so styles.css `.module-licenseintake`
  // selectors match exactly the way they do in the full shell.
  const container = document.createElement("div");
  container.className = "module-licenseintake";
  root.appendChild(container);

  const host = createHost("licenseintake", {
    route: (newHash) => { /* no-op in embed; nav stays in the host page */ },
    routePath: [],
    accent: licenseintakeMod.manifest?.accent,
  });

  try {
    if (typeof licenseintakeMod.register === "function") {
      await licenseintakeMod.register(host);
    }
    const m = await licenseintakeMod.manifest.ui.view();
    const mount = m.mount ?? m.default;
    if (typeof mount !== "function") {
      throw new Error("licenseintake view.js must export mount(host, container)");
    }
    await mount(host, container);
  } catch (err) {
    root.innerHTML = `<div class="embed-error">License Intake failed to mount: ${
      String(err?.message ?? err).replace(/</g, "&lt;")
    }</div>`;
    console.error("[licenseintake/embed] mount failed:", err);
  }
})();
