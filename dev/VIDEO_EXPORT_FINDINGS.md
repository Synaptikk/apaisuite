# Video Export Findings — APAISuite Incident Intake

Researched 2026-09-16 on the store 1458 AP workstation (Windows 11, user `US\ses008s.s01458`).
Test values from the handoff: camera `acc_bay_2`, incident 9/16/2026 2:00 PM, store 1458,
Clearsight UAT incident 26005842, clip window = 1 hour before to 1 hour after the stamp.

Everything below was read from installed binaries, configs, help files and logs on this PC.
Nothing was exported (see section 4 for why).

---

## 1. Video program on this PC and how a clip is exported

### What is installed

| Component | Version | Path | Role |
|---|---|---|---|
| **SYMPHIA VMS Review** (Cognyte, formerly Verint Nextiva) | 7.7 RU2 Update 2 (`Review.exe` 7.7.22325.0) | `C:\Program Files (x86)\Verint\Review\` | Desktop NVR client. This is "VMS Reviewer". Launched via `ReviewLaunch.exe` (login wrapper), Start menu *My Applications\SYMPHIA Video Manager\VMS Review*. |
| **SYMPHIA Enhanced Export Client** (VEE) | 7.7.0 (`SymphiaVmsEnhancedExport.exe` 3/31/2025) | `C:\Program Files (x86)\Verint\EnhancedExport\ExportUI\` | Walmart-customized evidence exporter. Opened from inside Review (external applications menu). Produces MP4 + `Inventory.csv` per case. |
| Enhanced Export Agent | service `VEEAgent` | `...\EnhancedExport\Agent\` | Runs the export on the workstation on behalf of the client (HTTPS 12388/12389, internal only). |
| Enhanced Export Transfer Service | service `VEETransferService` | `...\EnhancedExport\VEETransferService\` | Watches `Transfer\Feeder`, uploads finished packets via plugins: **CMI** (Azure blob), **Auror**, **Local file**. |
| Review Agent | service `Review Agent` | `...\Verint\ReviewAgent\` | `net.tcp://localhost:7010/Review/` — SDK bridge into the running Review instance (ports 7050+ per user). |
| VMS Control Center, Quick Setup Tool, Media Validator, Camera Rename Tool | 7.7 | `C:\Program Files (x86)\Verint\...` | Admin tools, not used for export. |

There is **no web viewer**; only the desktop client. The store NVR is `VSRV01S01458US` at
`tcp://192.168.84.38:5005`, Windows authentication. Review is currently running for this user with the
command line `Review.exe /s 192.168.84.38 /u US\ses008s.s01458 /p *** /l en-US /a AGENT /d 7054 /g 7055`.

### Export path A — VMS Review built-in export (AVI)

From the Review help (`ReviewHelp\Nextiva_Review_Help_en.chm`, "Video Exports"):

1. Navigation toolbar → **Recorded** → pick site/camera folder → select camera → drag to workspace.
2. **Video Query** dialog: Start date/time, **Workstation** or **Site** time zone radio, then Duration (minutes/hours) or *Set Stop Time Manually*, or Continuous Playback.
3. Optional: right-click left/right of the playback slider to set in/out points ("Setting Video Length"), or Activities pane → Timeline tab → Position → Range selector → drag.
4. Click **Export Video** (selected tile) or **Export All Tiles**.
5. **Pending Queue** tab: edit *File Name*, *Start Time*, *Stop Time* (default = 5 minutes, configurable "Default previous minutes to export").
6. **Start All** → **Export Pending Media** dialog fields:
   - *Export Folder* (default `C:\ProgramData\Review\ExportedMedia`; a changed path is remembered)
   - *Export Cognyte AVI* (proprietary codec; options *Export Codec installation*, *Autorun*)
   - *Export generic AVI and subtitle files* (H.264/H.265 only; plays in VLC; camera/time overlay is a sidecar subtitle file)
   - *Export Site Name*, *Export Review Offline* (bundles a portable player), *Protected Export* (password → ZIP), *Export on the machine server* (burn on server)
7. **Export** → progress in Activities → *Export Queue* tab.

Output: `.avi` (plus a subtitle sidecar for generic AVI), or `.zip` if password protected.
Tools and Configuration → Preferences → **Export** tab can set *Automatic export enabled = On* with a fixed
folder, type and file-name prefix, which skips the Export Pending Media dialog entirely.

Live config on this PC (`Review.exe.config`): `ExportPandingQueueEnabled=true`, `ExportStandard=true`
(generic AVI on), `ExportCodecs=true`, `AutoCloseExport=True`, `MaxNumberOfExportsInExportsQueue=16`.
`LastExportDirectory` and `AutomaticExportFolderLocation` currently point at other associates' Desktop
case folders (the config is machine-wide and shared by every user of the PC). `C:\ProgramData\Review\ExportedMedia`
does not exist on this machine.

### Export path B — Enhanced Export (this is what the store actually uses for evidence)

Observed flow from another associate's session this morning (log `ExportUI\Logs\MIM001M.s01458\EnhancedExport.log`):

1. Open the camera as a **Recorded** tile in Review for the time range you want.
2. Launch Enhanced Export from Review's external applications menu. It logs in with the Review
   session credential (no second login) and connects to the Review Agent.
3. **Insert selected tile / Insert cameras** → the tile's camera and its start/end are read from Review.
   Log: `Adding item|Type:Recorded|Id:239|Name:ACC_BAY_02|Start:6/9/2026 2:50:00 PM|End:6/9/2026 5:50:00 PM UTC`.
4. Choose a **Template**: `CMI` (uploads to Azure/CMI), `Auror` (uploads to Auror, case = Auror event id
   e1234567), or `Local Export` (writes to `...\EnhancedExport\LocalExport`, no upload).
   A hidden `Local Export Testing` support template exists (enabled from ReviewLaunch's template configurator).
5. Enter **Case number** (`LimitCaseToAlphaNumeric=true`), optional per-camera **Notes**, then **Start**.
6. The client asks the server for the expected duration, enqueues a "direct export task" to the local
   agent, and the queue runs. Progress is logged every ~1:48.
7. Output folder name: `<store>_Evidence-<case>_<yyyy-MM-dd_hh-mm-ss_tt>` under
   `C:\Program Files (x86)\Verint\EnhancedExport\Transfer\Feeder\` (CMI/Auror), for example
   `1458_Evidence-26298677_2026-09-16_08-56-28_AM`.
8. Files: `<CAMERA_NAME>.mp4`, `<CAMERA_NAME> #2.mp4`, `#3`… (fragmented at **1 hour / 900 MB**, template
   `MaxDuration 01:00:00`, `MaxSize 900`), plus `Inventory.csv`. Video is transcoded to **1920x1080 H.264 MP4**
   with a burned-in timestamp overlay (`%Y-%m-%d %I:%M:%S %p %z`) and an embedded authenticity fingerprint
   (verifiable with `MediaValidator.exe`).
9. `VEETransferService` polls Feeder every 5 min, uploads via the template's plugin, writes
   `Transfer\Status\<packet>.xml` (status, attempts, user, base64 notes) and moves the packet to
   `Transfer\Archive\` (kept 15 days).

Real sample (`Transfer\Archive\1458_Evidence-26292808_2026-09-11_04-44-13_PM\`):

| File | Size | Covers (UTC) |
|---|---|---|
| `SAL_BABY.mp4` | 52,727,623 B | 09/10 11:02:00 – 12:01:59 |
| `SAL_BABY #2.mp4` | 54,120,689 B | 09/10 12:02:02 – 13:04:00 |
| `Inventory.csv` | 926 B | — |

Inventory columns: `LocationId, MasterServerName, EvidenceId, QueryStartUtc, QueryEndUtc, ServerTimeZone,
ServerTimeZoneOffset, Notes, ExportStartUtc, ExportEndUtc, ExportRunTime, Template, CameraName, ExportedFile,
ExportedFileStartTimeUtc, ExportedFileEndTimeUtc, FileSize, UserName`.

Throughput seen: a 2-hour query ran 18 min; a 3-hour query ran 26 min (about 9 min and about 50 MB per hour of
480p source). A 2-hour incident clip should therefore be 2 files, roughly 100 MB, roughly 18 minutes wall time.

---

## 2. Can it be driven without clicking?

Short answer: **not headlessly with what is on the PC today, but there are three real hooks.**

| Hook | What it can do | Evidence | Status |
|---|---|---|---|
| `Review.exe` command line | Login only. Switches (from `LoginCommandLineConverter`): `/s` site, `/u` user, `/p` password, `/t` token, `/c` custom creds, `/l` locale, `/m` monitor, `/a` application tag, `/f` Compass token file, `/r` SDK token, `/d` SDK admin port, `/g` SDK gateway port, `/recover`. No export, camera or time switches. | reflection of `Verint.Video.Modules.Infrastructure.Authentication.dll`; live process command line | Confirmed |
| **Review SDK** (`ReviewSDK.dll`, via Review Agent `net.tcp://localhost:7010`) | `ReviewApplication.Initialize(agent)` → `Run(LoginData, RunOptions.Connect)` → `GetManager<T>()`. `CameraManager.GetCameraByName(site, name)`, `RecordedManager.DisplayRecorded(camera, start, end)` with `TimeZoneMode {Default, Workstation, Site}`, `WorkspaceManager.GetOpenedTiles()`, `PlayerManager.SeekTo/GetImage`. **No public export method** in this build (export entities exist but no manager exposes them). | reflection of `ReviewSDK.dll` (682 types); ReviewLaunch and Enhanced Export both use it | Confirmed (can open the tile, cannot export) |
| **Export SDK** (`Verint.Vms.Export.Sdk.*.dll`, .NET Framework 4.7.2 **x86**, in `ExportUI\`) | Full programmatic export: `VmsExportConnection.StartUp(); Login(user, pass)` (or `VmsExportClient.Login(identityToken)`); `GetVideoAvailability().IsAvailable(camera, startUtc, endUtc)`; `GetInitiator().CreateVideoTask(ICamera, startUtc, endUtc, IExportDestination)`; `GetDestination().CreateLocal(dir)` / `CreateAgent(dir)` / `CreateNetworkShare(unc)`; `GetQueue().Enqueue(task)`, `GetTaskProgress(id)`, `Cancel`. Camera lookup via `VmsExportClient.GetCameraManager()`. | reflection of `Verint.Vms.Export.Sdk.Client.dll` and `.Common.dll` | Real API, **untested**; needs VMS credentials or a Review-issued identity token, and a 32-bit .NET host |
| Enhanced Export command line | `SymphiaVmsEnhancedExport.exe` has a multi-instance IPC command-line reader (`ReviewApplicationCommandLineReader`): credential switches `-s/-server`, `-u/-username`, `-p/-password`, `-c/-credentials` (from `CredentialCommandLine`), plus key/value external args for `cameraId`, `StartTime`, `endTime` (validation flags `InvalidCameraID/InvalidStartTime/InvalidEndTime`). It pre-loads a tile into the UI queue; case number and Start still happen in the GUI. Exact prefix/separator characters not verified. | reflection plus string heap of the exe | Partially confirmed, syntax unverified |
| Watched folder | `Transfer\Feeder` is watched by `VEETransferService`, but for **uploading** already-exported packets, not for export requests. Dropping a folder there would push it to CMI/Auror. | `VEETransferService.exe.config` | Not an export trigger |
| REST API | The agent listens on HTTPS 12388 (registers as `s[SiteNumber].us.wal-mart.com`) and a transfer server on 12389, used only by the client. No documented routes; logs show none. | `Agent\SymphiaVmsEnhancedExportAgent.Settings.json` | Not usable |
| Help menu / docs | Only the Review CHM. No CLI docs, no SDK docs, no PDFs in any install folder. | file inventory | — |

Practical recommendation for the module:

1. **Semi-automated, today:** APAISuite prepares the request (normalized camera name, start/end in store
   local time and UTC, Clearsight incident as case number). A small helper uses the Review SDK to
   `GetCameraByName` + `DisplayRecorded(camera, start, end)` so the tile is already open at the right
   range; the associate then does Enhanced Export → Insert tile → template → case → Start (4 clicks).
2. **Pickup:** watch `...\EnhancedExport\Transfer\Feeder`, `Transfer\Archive` and `LocalExport` for a folder
   matching `1458_Evidence-<incident>_*`, read `Inventory.csv`, and attach the MP4s to the Clearsight incident.
   `Transfer\Status\*.xml` gives upload success or failure.
3. **Fully automated, later:** a 32-bit .NET helper on the Export SDK (`CreateVideoTask` → `Enqueue` →
   `CreateLocal`). The blocker is authentication: it needs an explicit VMS login or the Review identity token.
   The Auror/CMI upload should stay on the existing transfer service.

---

## 3. Camera names and store-local time

### Camera names do **not** match the paper form exactly

VMS names on this server are **UPPERCASE with a two-digit zero-padded index**. Seen in logs today:
`ACC_BAY_01`, `ACC_BAY_02`, `POS_30`, `SAL_BABY`, `ENT_GENERAL_MERCHANDISE_FRONT`,
`FRNT_SELF_CHECKOUT_02_BELT`. Camera groups are folders such as `ACTION ALLEY`, `POS`, `BACKROOM`,
`SC_POINT_OF_SALE`. Internal IDs are numeric (`ACC_BAY_02` = camera #239).

So the paper `acc_bay_2` is `ACC_BAY_02` in Review. Suggested normalization: upper-case, keep
underscores, zero-pad a trailing integer to 2 digits, then confirm with `CameraManager.GetCameraByName`
(or the Filter box in Review's camera list, which is a substring match). Another associate
exported `ACC_BAY_02` for case 26298677 at 08:56 today, so this camera exists and records at 480p.

### Time zone handling

- **PC:** `Eastern Standard Time` (currently EDT, UTC-4). **Server:** `ServerTimeZone = Eastern Daylight
  Time, offset -04:00` (from `Inventory.csv`). Workstation and site are the same zone here, so the
  Workstation/Site choice is moot for store 1458, but it matters for remote or multi-site use.
- **Review Video Query dialog:** explicit **Workstation** vs **Site** radio; Start/Stop fields follow the
  chosen zone. The default zone is set in Tools and Configuration → Preferences → Display → *Time Zone*
  (Workstation or Cognyte site). The Review SDK exposes the same choice as `TimeZoneMode`.
- **Review export dialog:** Pending Queue Start/Stop are shown in the tile's display zone; there is no zone field.
- **Enhanced Export:** takes the tile's range, converts to UTC for the server query and logs both
  (`Start time: 06/09/2026 14:50:00 Utc, 06/09/2026 10:50:00 local`). `Inventory.csv` stores UTC plus the
  server zone and offset; the burned-in overlay includes `%z`. File names carry no time; the folder name uses
  the local export start time with `_AM`/`_PM`.
- For the test incident (2:00 PM 9/16/2026 EDT), the request is 1:00 PM–3:00 PM local =
  **17:00–19:00 UTC**. Two 1-hour fragments expected.

---

## 4. Test export — not performed

No clip was exported. Reasons:

- Both export paths are GUI dialogs. This session had no screen access to drive Review or Enhanced
  Export, and the Review SDK has no export call.
- The Export SDK path needs VMS credentials or a Review identity token that were not available, and it is
  untested; a first run should be done interactively.
- `CMI` and `Auror` templates upload to production evidence systems; only `Local Export` is safe for a
  test, and that still needs the GUI.

To run the test manually (safe, no upload):

1. Review → Recorded → `ACC_BAY_02` → Video Query: Start 9/16/2026 1:55 PM (Workstation), Duration 10 min → OK.
2. Enhanced Export → Insert selected tile → Template **Local Export** → Case `26005842` → Start.
3. Expect `C:\Program Files (x86)\Verint\EnhancedExport\LocalExport\1458_Evidence-26005842_2026-09-16_<hh-mm-ss>_PM\ACC_BAY_02.mp4`
   (roughly 8–10 MB for 10 min at 480p→1080p) plus `Inventory.csv`; the run should take about 1–2 minutes.

For the real 2-hour window use Start 1:00 PM, Duration 2 hours; expect `ACC_BAY_02.mp4` and
`ACC_BAY_02 #2.mp4`, about 100 MB total, about 18 minutes.

---

## Reference: key files on this PC

- `C:\Program Files (x86)\Verint\Review\Review.exe.config` — export defaults (shared by all users).
- `C:\Program Files (x86)\Verint\Review\ReviewHelp\Nextiva_Review_Help_en.chm` — the only documentation.
- `C:\Program Files (x86)\Verint\EnhancedExport\ExportUI\EnhancedExportConfig.config` — Review path, agent endpoints, Walmart inventory and output-directory services.
- `C:\Program Files (x86)\Verint\EnhancedExport\ExportUI\Templates\{CMI,Auror,Local Export}.json` — output resolution, fragment size, overlay, destination.
- `C:\Program Files (x86)\Verint\EnhancedExport\ExportUI\DefaultAppSettings.json` — last site and template, auto-remove settings.
- `C:\Program Files (x86)\Verint\EnhancedExport\Transfer\{Feeder,Status,Archive}` — packet lifecycle.
- `C:\Program Files (x86)\Verint\EnhancedExport\VEETransferService\VEETransferService.exe.config` — poll intervals, retention, plugins.
- Logs: `Review\logs\<user>\Review.log`, `EnhancedExport\ExportUI\Logs\<user>\EnhancedExport.log`, `EnhancedExport\Agent\Logs\`, `VEETransferService\Logs\Service.log`.
