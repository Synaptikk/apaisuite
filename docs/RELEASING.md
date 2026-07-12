# Releasing APAISuite

How to ship a new version, and how the update-checker that nags installed
clients actually works.

## TL;DR

After one-time setup (below), every release is two manual steps:

```bash
# from unified-extension-suite/
./scripts/release.sh patch    # bumps version, zips source, stages to QRCallBox

# from QRCallBox/
npm run build && firebase deploy --only hosting

# then, manually upload the same ZIP to the Chrome Web Store dashboard:
#   https://chrome.google.com/webstore/devconsole
#   (file is at QRCallBox/public/extension/apaisuite-<version>.zip)
```

Within ~6 hours of the QRCallBox deploy, every running extension surfaces a
"v0.X.Y available" pill in the shell header. Web Store-installed copies
auto-update via Chrome's own poll within ~5 hours.

---

## How the two install paths interact

APAISuite is published two ways. They use **different extension IDs** —
Chrome treats them as completely separate extensions, with independent
`chrome.storage`. That's a feature, not a bug: it means a developer running
the unpacked source can have a teammate on the Web Store build sitting in
the same Chrome profile without state conflicts.

| Install path | Extension ID | Auto-updates? | Nag pill? |
|---|---|---|---|
| Load unpacked (dev mode) | path-derived hash | No — Chrome ignores `update_url` for unpacked | Yes — links to source ZIP |
| Chrome Web Store (Unlisted) | CWS-assigned | Yes — Chrome polls CWS every ~5h | Yes — links to CWS listing |

The "nag pill" is the in-extension version checker
(`shared/updater.js` → `shared/updater_ui.js`). It runs in both install
paths and polls `https://qrcallbox.com/extension/version.json` every six
hours. The pill appears in the shell header next to the version pill
whenever the published version is newer than the running version.

---

## One-time setup

### 1. Local prerequisites

The release script uses Node + the bundled `adm-zip` package (in `scripts/`).
Install the tooling deps once:

```bash
cd unified-extension-suite/scripts
npm install
cd ..
```

`adm-zip` is the only dep — it's pure JS, zero runtime deps, ~150KB. We
bundle it because Windows PowerShell 5.1's `Compress-Archive` writes ZIPs
with backslash entry names that the Chrome Web Store uploader rejects and
macOS/Linux unzippers mangle.

Sanity check:

```bash
node --version       # >= 18
firebase --version   # any (used only to deploy QRCallBox)
ls scripts/node_modules/adm-zip  # should exist after npm install
```

### 2. Chrome Web Store developer account (first publish only)

1. Sign in to <https://chrome.google.com/webstore/devconsole> with a Google
   account you control.
2. Pay the $5 one-time developer registration fee.
3. Click **New item**, upload the first release ZIP (produced by
   `./scripts/release.sh patch`), and fill out the listing:
   - **Visibility:** Unlisted (search-invisible, install-by-direct-URL only)
   - **Category:** Productivity (or whatever fits)
   - Description, screenshots, icon, privacy policy URL
4. Submit for review. First review typically takes 1–3 business days.
   Subsequent updates usually publish within hours.
5. Once published, **copy the listing URL** — looks like
   `https://chromewebstore.google.com/detail/<name>/<32-char-id>`. Save it
   somewhere you'll find it during release.

### 3. Configure the release script with your CWS listing URL

The landing page on qrcallbox.com needs the CWS link so the "Install from
Chrome Web Store" button works. The script reads it from the
`CWS_LISTING_URL` environment variable.

You have two options:

- **Set it per-release:**
  ```bash
  CWS_LISTING_URL="https://chromewebstore.google.com/detail/.../..." \
    ./scripts/release.sh patch
  ```
- **Add it to your shell rc once:**
  ```bash
  echo 'export CWS_LISTING_URL="https://chromewebstore.google.com/detail/.../..."' >> ~/.bashrc
  ```

If you skip this, the "Install from Chrome Web Store" button on the landing
page will be a dead link until you set it.

---

## Normal release flow

```bash
cd unified-extension-suite

# 1. Bump version, zip source, render version.json + landing page,
#    stage everything into ../QRCallBox/public/extension/
./scripts/release.sh patch    # or: minor / major / 0.4.2

# (Optional — include release notes that show up in the nag pill tooltip
#  and on the landing page.)
RELEASE_NOTES="Fixed the auror cross-ref CSV export" \
  ./scripts/release.sh patch

# 2. Deploy QRCallBox hosting
cd ../QRCallBox
npm run build && firebase deploy --only hosting

# 3. Upload the same ZIP to the Chrome Web Store dashboard
#    File: QRCallBox/public/extension/apaisuite-<version>.zip
#    https://chrome.google.com/webstore/devconsole
#    (Drag-and-drop on the listing's "Package" tab → "Submit for review")
```

After step 2 lands, you can verify with:

```bash
curl --ssl-no-revoke https://qrcallbox.com/extension/version.json
```

You should see your new version in the JSON.

### Forcing the nag pill to fire immediately (for testing)

The check normally runs on a 6-hour alarm. To force it:

1. Open `chrome://extensions`, find APAISuite, click "service worker"
   to open the SW's devtools.
2. In the SW console:
   ```js
   chrome.alarms.create("_suite_updater", { when: Date.now() + 500 })
   ```
3. Within a few seconds the SW logs `[APAISuite updater] new version
   available: …`. Reopen the shell page (Cmd-R/Ctrl-R) and the pill
   should appear in the header.

To inspect the current state:

```js
chrome.storage.local.get([
  "shell.updater.available",
  "shell.updater.lastCheckedAt",
  "shell.updater.lastError",
]).then(console.log)
```

---

## Why this design

**Why a separate in-extension nag if Chrome auto-updates CWS installs?**
Two reasons. (1) Load-unpacked installs get NO auto-update — Chrome ignores
`update_url` entirely for unpacked extensions, and there's no other
mechanism. The nag is the only signal those installs get. (2) Even for
CWS-installed copies, Chrome's poll cadence is ~5 hours and there's no
in-app "what's new" surface. The nag pill closes both gaps with one
implementation.

**Why not self-host a CRX too?** The original plan was self-hosted CRX with
the extension's `key` and `update_url` pointing to qrcallbox.com. We
dropped that path because:

- CWS rejects manifests containing `key` or `update_url`, so the same
  extension can't be both self-hosted-CRX *and* CWS-published.
- Self-hosted CRX install on modern Windows Chrome is effectively blocked
  unless an enterprise policy whitelists the source — and if you have that
  policy in place, you'd use `ExtensionInstallForcelist` directly and skip
  the dance.
- Without CRX self-hosting, there's no signing key to manage, no Firebase
  Secret to provision, and crucially no one-time `chrome.storage` reset
  (which would have happened the moment we added `key` to the manifest).

**What if I want enterprise force-install later?** It's compatible. Walmart
IT would push `HKLM\Software\Policies\Google\Chrome\ExtensionInstallForcelist`
with `1 = "<cws_extension_id>;https://clients2.google.com/service/update2/crx"`
— the same CWS-published listing, just installed automatically instead of
by user click. No code changes here.

---

## Troubleshooting

### "EXTENSION_ID is unset" — wait, why?

You shouldn't see this. That error was from the earlier self-hosted-CRX
design. If you do see it, you're running a stale `release.sh`. The current
script doesn't reference `EXTENSION_ID` at all.

### Nag pill never appears

1. Check the SW console for `[APAISuite updater] check failed:` — usually a
   network/proxy issue. The Walmart corp proxy intercepts TLS; the
   extension fetches use system trust so this should "just work," but if
   the proxy is unhappy, the fetch will fail.
2. Verify the deployed version.json: `curl --ssl-no-revoke
   https://qrcallbox.com/extension/version.json`
3. Verify `compareVersions` is finding it newer:
   `chrome.runtime.getManifest().version` in SW console.
4. Check the alarm exists: `chrome.alarms.get("_suite_updater").then(console.log)`.

### Pill is stuck after I installed the update

The pill clears the next time the check runs and sees the installed version
matches or exceeds the published version. Force a check with the alarm
trick above, or just wait for the next 6-hour tick.

### CWS rejected my upload with "key" or "update_url" error

You shouldn't have those in `manifest.json` — the current design
specifically avoids them. If you see this error, grep the manifest:

```bash
grep -E '"key"|"update_url"' manifest.json
```

Both should return nothing.
