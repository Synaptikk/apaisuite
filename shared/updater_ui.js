// shared/updater_ui.js
//
// Page-side renderer for the "update available" banner. Runs in app.html.
//
// Reads chrome.storage.local["shell.updater.available"] (written by the SW
// in shared/updater.js) and renders a full-width banner into the host
// element. Re-renders reactively when storage changes.
//
// Banner UX (load-unpacked installs):
//   [↑ Update available — v0.8.0]  release-notes-truncated…  [Download & Update] [Later]
//
// Clicking "Download & Update":
//   1. chrome.downloads.download(zipUrl)  — fires a Save dialog-less download
//      to the user's Downloads folder.
//   2. chrome.tabs.create({ url: "chrome://extensions" }) — opens the page
//      they need to be on to finish the swap.
//   3. Expands the banner with step-by-step instructions including the
//      extension ID (so they can locate "their" entry on chrome://extensions).
//
// Why this isn't true one-click: Chrome blocks extensions from self-replacing
// their own files. The only true zero-click path is a Chrome Web Store install
// (Chrome's own updater polls every ~5h). For load-unpacked installs this is
// the best you can do — auto-download + auto-navigate + crystal-clear next
// steps; the user still does the unzip + reload by hand.

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
  primary.textContent = "Download & Update";
  primary.title = "Download the new ZIP and open chrome://extensions";
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
 * Trigger the download + open-extensions-page flow, then show inline help so
 * the user knows what to do next.
 */
async function startUpdate(root, payload) {
  const zipUrl = payload?.zipUrl;
  const newVer = String(payload?.version ?? "?");

  // 1. Kick off the download. saveAs:false so the browser doesn't prompt
  //    for a location — file lands in default Downloads folder.
  let downloadId = null;
  if (zipUrl) {
    try {
      downloadId = await chrome.downloads.download({ url: zipUrl, saveAs: false });
    } catch (e) {
      console.warn("[APAISuite updater_ui] download failed:", e);
    }
  }

  // 2. Open chrome://extensions in a new tab so they're one click from
  //    "Load unpacked" / "Reload" buttons.
  try {
    await chrome.tabs.create({ url: "chrome://extensions" });
  } catch (e) {
    console.warn("[APAISuite updater_ui] tabs.create failed:", e);
  }

  // 3. Expand banner with step-by-step help. We can't auto-locate the install
  //    folder (Chrome doesn't expose it to JS), but the extension ID + the
  //    open chrome://extensions tab gets them there in 2 clicks.
  const help = document.createElement("div");
  help.className = "wv-banner-help";
  const extId = chrome.runtime.id;
  help.innerHTML = `
    <strong>Downloading apaisuite-${newVer}.zip…</strong>
    Once it finishes:
    <ol>
      <li>Unzip it (any folder works — but easiest is to <em>overwrite the existing install folder</em> so you don't have to re-pick it).</li>
      <li>On the <code>chrome://extensions</code> tab that just opened, find <strong>APAISuite</strong>
          (ID: <code>${extId}</code>) and click <strong>Reload</strong>.</li>
      <li>If you unzipped to a new folder, click <strong>Load unpacked</strong> and select it,
          then <strong>Remove</strong> the old install.</li>
    </ol>
    The banner will clear automatically once the SW sees you're on v${newVer}.
  `;
  // Replace primary button label so the user knows it's progressing.
  const primary = root.querySelector("button.is-primary");
  if (primary) {
    primary.textContent = "Downloading…";
    primary.disabled = true;
  }
  // Append the help block beneath the inline row (re-flowed via grid).
  root.classList.add("is-expanded");
  // Insert help into the parent grid as a sibling so it spans full width
  // properly via grid-area:banner; we append to root for simplicity and
  // let CSS handle layout.
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
