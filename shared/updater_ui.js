// shared/updater_ui.js
//
// Page-side renderer for the "update available" banner. Runs in app.html.
//
// Reads chrome.storage.local["shell.updater.available"] (written by the SW
// in shared/updater.js) and renders a full-width banner into the host
// element. Re-renders reactively when storage changes.
//
// Banner UX (load-unpacked installs):
//   [↑ Update available — v1.0.3]  release-notes-truncated…  [Get update] [Later]
//
// Clicking "Get update":
//   1. chrome.tabs.create({ url: downloadUrl }) — opens the qrcallbox.com
//      landing page, whose "Download to folder" button writes the new files
//      straight into the existing install folder (File System Access API,
//      fed by pkg.json — the only delivery the corp proxy lets through).
//   2. Expands the banner with step-by-step instructions including the
//      extension ID (so they can locate "their" entry on edge://extensions).
//
// The ZIP path (chrome.downloads on zipUrl) was retired: the proxy 403s
// archive downloads, so the button failed silently for everyone on corp.
//
// Why this isn't true one-click: Chrome blocks extensions from self-replacing
// their own files. The only true zero-click path is a Chrome Web Store install
// (Chrome's own updater polls every ~5h). For load-unpacked installs this is
// the best you can do — open the installer page + crystal-clear next steps;
// the user still does the folder pick + reload by hand.

import { UPDATER_STORAGE_KEYS } from "./updater.js";

const BANNER_ID         = "suite-update-banner";
const SESSION_DISMISS_K = "shell.updater.dismissedVersion";

function buildBanner(payload) {
  const root = document.createElement("div");
  root.id = BANNER_ID;
  root.className = "shell-update-banner";

  const newVer = String(payload?.version ?? "?");
  const oldVer = String(payload?.currentVersion ?? chrome.runtime.getManifest().version);

  // Title
  const title = document.createElement("span");
  title.className = "wv-banner-title";
  title.textContent = `↑ Update available — v${newVer}`;
  title.title = `You're on v${oldVer}`;
  root.appendChild(title);

  // Notes (truncated to one line, expandable)
  const notes = document.createElement("span");
  notes.className = "wv-banner-notes";
  notes.textContent = payload?.releaseNotes || "(no release notes provided)";
  notes.title = payload?.releaseNotes || "";
  root.appendChild(notes);

  // Actions
  const actions = document.createElement("div");
  actions.className = "wv-banner-actions";

  const primary = document.createElement("button");
  primary.className = "is-primary";
  primary.textContent = "Get update";
  primary.title = "Open the download page — use \"Download to folder\" on your existing install folder, then Reload";
  primary.addEventListener("click", () => startUpdate(root, payload));
  actions.appendChild(primary);

  const dismiss = document.createElement("button");
  dismiss.textContent = "Later";
  dismiss.title = "Hide this until the next published version";
  dismiss.addEventListener("click", async () => {
    // Dismiss for THIS version only. The SW will set a new payload when a
    // newer version is published, and we compare in syncBanner() to re-show.
    await chrome.storage.local.set({ [SESSION_DISMISS_K]: newVer });
    root.hidden = true;
  });
  actions.appendChild(dismiss);

  root.appendChild(actions);

  return root;
}

/**
 * Send the user to the landing page's folder installer, then show inline
 * help so they know what to do next.
 *
 * Why not chrome.downloads on the ZIP: the corp proxy 403s .zip/octet-stream
 * archives, so the old "Download & Update" button silently produced a
 * failed download and a chrome://extensions tab with nothing to load. The
 * landing page's "Download to folder" path fetches pkg.json (plain JSON,
 * which the proxy lets through) and writes every file straight into the
 * install folder via the File System Access API — no archive ever crosses
 * the wire. release.sh keeps pkg.json in lockstep with the ZIP.
 */
async function startUpdate(root, payload) {
  const newVer = String(payload?.version ?? "?");
  const pageUrl = payload?.downloadUrl || "https://qrcallbox.com/extension/";

  // 1. Open the landing page. That's where the firewall-safe installer lives.
  try {
    await chrome.tabs.create({ url: pageUrl });
  } catch (e) {
    console.warn("[APAISuite updater_ui] tabs.create failed:", e);
  }

  // 2. Expand banner with step-by-step help. We can't auto-locate the install
  //    folder (Chrome doesn't expose it to JS), but the extension ID gets
  //    them to the right card on chrome://extensions in 2 clicks.
  const help = document.createElement("div");
  help.className = "wv-banner-help";
  const extId = chrome.runtime.id;
  help.innerHTML = `
    <strong>Update page opened in a new tab.</strong>
    On that page:
    <ol>
      <li>Click <strong>Download to folder</strong> and pick your <em>existing</em> APAISuite install folder
          (files are overwritten in place — no ZIP, no extracting).</li>
      <li>Wait for it to report all files written.</li>
      <li>Open <code>edge://extensions</code>, find <strong>APAISuite</strong>
          (ID: <code>${extId}</code>) and click <strong>Reload</strong>.</li>
    </ol>
    The banner will clear automatically once the SW sees you're on v${newVer}.
  `;
  const primary = root.querySelector("button.is-primary");
  if (primary) {
    primary.textContent = "Update page opened";
    primary.disabled = true;
  }
  root.classList.add("is-expanded");
  root.appendChild(help);
}

async function syncBanner(hostEl, payload) {
  if (!payload) {
    hostEl.hidden = true;
    hostEl.replaceChildren();
    return;
  }
  // Respect "Later" dismissal for the same version.
  const got = await chrome.storage.local.get(SESSION_DISMISS_K);
  if (got?.[SESSION_DISMISS_K] === payload.version) {
    hostEl.hidden = true;
    hostEl.replaceChildren();
    return;
  }
  // Build a fresh banner; replace contents in place so the host element
  // (mounted by app.js) stays referentially stable.
  const fresh = buildBanner(payload);
  hostEl.replaceChildren(...fresh.childNodes);
  hostEl.className = fresh.className;
  hostEl.hidden = false;
}

/**
 * Mount the update banner into the given host element (the shell's
 * #suite-update-banner div). Returns an unsubscribe function for symmetry —
 * the shell never calls it because the banner lives for the page's lifetime.
 */
export function mountUpdaterIndicator(hostEl) {
  if (!hostEl) {
    console.warn("[APAISuite updater_ui] no host element provided");
    return () => {};
  }

  const key = UPDATER_STORAGE_KEYS.available;

  // Initial render from current storage.
  chrome.storage.local.get(key).then((got) => {
    syncBanner(hostEl, got?.[key] ?? null);
  }).catch((e) => {
    console.warn("[APAISuite updater_ui] storage.get failed:", e);
  });

  // Reactive update on change. Listens for both the available-payload key
  // and the dismissed-version key so that clicking "Later" hides immediately
  // and a fresher version (set by the SW) re-shows.
  const listener = (changes, area) => {
    if (area !== "local") return;
    if (!(key in changes) && !(SESSION_DISMISS_K in changes)) return;
    chrome.storage.local.get(key).then((got) => {
      syncBanner(hostEl, got?.[key] ?? null);
    });
  };
  chrome.storage.onChanged.addListener(listener);

  return () => {
    chrome.storage.onChanged.removeListener(listener);
    hostEl.replaceChildren();
    hostEl.hidden = true;
  };
}
