// modules/gifphone/lib/setup.js
//
// Everything Phone Setup does to a phone, in order. Each step gets the adb
// connection plus a context of callbacks (pairing code, status polls, logging)
// and returns { ok, detail } — or { warn, detail } for something the phone
// still works without. A step that throws stops the run; the user fixes the
// one thing named and presses Set up again (every step is safe to repeat).

export const PKG = "com.apaisuite.gifcompanion";
export const GIF_PKG = "com.walmart.gif2";
export const A11Y_SERVICE = `${PKG}/${PKG}.GifService`;
export const TILE = `${PKG}/${PKG}.GifTile`;
export const ENDPOINT = "https://qrcallbox.com/api/gif";
const MIN_SDK = 30;                  // AndroidManifest uses-sdk minSdkVersion
const STAY_ON_ALL = 15;              // AC | USB | wireless | dock
const SCREEN_TIMEOUT_MS = 30 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `pm list users` → [{ id, name }]  ("UserInfo{10:Work profile:1030} running") */
export function parseUsers(text) {
  const out = [];
  for (const m of String(text).matchAll(/UserInfo\{(\d+):([^:}]*)/g)) out.push({ id: Number(m[1]), name: m[2] });
  return out;
}

/** Add our service to secure.enabled_accessibility_services, keeping any others. */
export function withService(current, svc = A11Y_SERVICE) {
  const list = String(current || "").split(":").map((s) => s.trim()).filter((s) => s && s !== "null");
  const short = svc.replace(`/${svc.split("/")[0]}.`, "/.");
  if (list.includes(svc) || list.includes(short)) return list.join(":");
  return [...list, svc].join(":");
}

/** First versionCode in `dumpsys package <pkg>`; 0 when not installed. */
export function versionCodeOf(dumpsys) {
  const m = String(dumpsys).match(/versionCode=(\d+)/);
  return m ? Number(m[1]) : 0;
}

/** pm's install answer → a sentence a store user can act on, or "" for Success. */
export function installProblem(out) {
  if (/^Success/m.test(out)) return "";
  if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(out)) return "incompatible";
  if (/VERIFICATION_FAILURE|verification/i.test(out)) return "verification";
  if (/USER_RESTRICTED|DISALLOW_INSTALL|restricted/i.test(out)) return "The phone's work policy blocks installing apps from a computer. Ask IT to allow it, or install GIF Companion another way.";
  return out.split("\n").pop() || "The phone refused the install.";
}

export const STEPS = [
  {
    id: "phone", title: "Check the phone",
    async run(adb, ctx) {
      const sdk = Number(await adb.shell("getprop ro.build.version.sdk")) || 0;
      const release = await adb.shell("getprop ro.build.version.release");
      const model = await adb.shell("getprop ro.product.model");
      ctx.model = model;
      if (sdk && sdk < MIN_SDK) throw new Error(`This phone runs Android ${release}; GIF Companion needs Android 11 or newer.`);
      return { ok: true, detail: `${model}, Android ${release}` };
    },
  },
  {
    id: "gif", title: "Find the GIF app",
    async run(adb, ctx) {
      const users = parseUsers(await adb.shell("pm list users"));
      const found = [];
      for (const u of users.length ? users : [{ id: 0, name: "Owner" }]) {
        const p = await adb.shell(`pm path --user ${u.id} ${GIF_PKG}`);
        if (/^package:/m.test(p)) found.push(u.id === 0 ? "personal" : (u.name || `user ${u.id}`).toLowerCase());
      }
      ctx.gifFound = found.length > 0;
      if (!found.length) return { warn: true, detail: "GIF isn't installed. Install it from the Hub app (work profile) and sign in; setup carries on." };
      return { ok: true, detail: `GIF installed (${found.join(", ")})` };
    },
  },
  {
    id: "awake", title: "Keep the phone awake on the charger",
    async run(adb) {
      await adb.shell(`settings put global stay_on_while_plugged_in ${STAY_ON_ALL}`);
      await adb.shell(`settings put system screen_off_timeout ${SCREEN_TIMEOUT_MS}`);
      const stay = Number(await adb.shell("settings get global stay_on_while_plugged_in")) || 0;
      if (!stay) return { warn: true, detail: "The phone's policy kept 'Stay awake' off. The app's keep-screen-on still holds it awake while it runs." };
      return { ok: true, detail: "Screen stays on while charging; 30-min screen timeout otherwise" };
    },
  },
  {
    id: "install", title: "Install GIF Companion",
    async run(adb, ctx) {
      const listed = await adb.shell(`pm list packages --user 0 ${PKG}`);
      const have = new RegExp(`package:${PKG.replace(/\./g, "\\.")}$`, "m").test(listed)
        ? versionCodeOf(await adb.shell(`dumpsys package ${PKG} | grep versionCode`)) : 0;
      if (have && have >= ctx.apkInfo.versionCode) return { ok: true, detail: `Already on ${ctx.apkInfo.versionName}` };
      ctx.log(have ? `Updating from version code ${have}` : "Sending the app to the phone…");
      let out = await adb.install(ctx.apk, { user: 0, onProgress: ctx.progress });
      let problem = installProblem(out);
      if (problem === "verification") {
        // Play Protect sometimes times out on adb installs; skip its check and retry once.
        await adb.shell("settings put global verifier_verify_adb_installs 0");
        out = await adb.install(ctx.apk, { user: 0, onProgress: ctx.progress });
        problem = installProblem(out);
      }
      if (problem === "incompatible") {
        // An old build signed with another key: remove it (its settings go with it) and install fresh.
        ctx.log("Removing an older copy signed differently…");
        await adb.shell(`pm uninstall --user 0 ${PKG}`);
        out = await adb.install(ctx.apk, { user: 0, onProgress: ctx.progress });
        problem = installProblem(out);
      }
      if (problem) throw new Error(problem === "verification" ? "Play Protect blocked the install. On the phone, tap 'Install anyway' if asked, then press Set up again." : problem);
      return { ok: true, detail: `Installed ${ctx.apkInfo.versionName}` };
    },
  },
  {
    id: "battery", title: "Let it run in the background",
    async run(adb) {
      const cmds = [
        `cmd deviceidle whitelist +${PKG}`,
        `cmd appops set ${PKG} RUN_IN_BACKGROUND allow`,
        `cmd appops set ${PKG} RUN_ANY_IN_BACKGROUND allow`,
        `cmd appops set ${PKG} ACCESS_RESTRICTED_SETTINGS allow`,
        `pm grant ${PKG} android.permission.POST_NOTIFICATIONS`,
      ];
      const failed = [];
      for (const c of cmds) {
        const out = await adb.shell(c);
        if (/Exception|Error|Unknown|not allowed/i.test(out)) failed.push(c.split(" ").slice(0, 3).join(" "));
      }
      if (failed.length) return { warn: true, detail: `Battery saver exemption partly refused (${failed.length} of ${cmds.length})` };
      return { ok: true, detail: "Battery saver won't stop it; notifications allowed" };
    },
  },
  {
    id: "a11y", title: "Turn on its screen reader (accessibility)",
    async run(adb) {
      const cur = await adb.shell("settings get secure enabled_accessibility_services");
      await adb.shell(`settings put secure enabled_accessibility_services '${withService(cur)}'`);
      await adb.shell("settings put secure accessibility_enabled 1");
      for (let i = 0; i < 10; i++) {
        await sleep(1000);
        const d = await adb.shell("dumpsys accessibility | grep -c GifService");
        if (Number(d) > 0) return { ok: true, detail: "GIF Companion can read GIF's screens" };
      }
      const now = await adb.shell("settings get secure enabled_accessibility_services");
      if (!now.includes("GifService")) throw new Error("The phone wouldn't turn the accessibility service on. On the phone: Settings → Accessibility → Installed apps → GIF Companion → On, then press Set up again.");
      return { warn: true, detail: "Turned on; the phone hasn't started it yet" };
    },
  },
  {
    id: "tile", title: "Add the pause button to quick settings",
    async run(adb) {
      const out = await adb.shell(`cmd statusbar add-tile ${TILE}`);
      if (/Exception|Error|Unknown/i.test(out)) return { warn: true, detail: "Skipped (the phone doesn't allow it)" };
      return { ok: true, detail: "Swipe down twice for the GIF Companion pause tile" };
    },
  },
  {
    id: "pair", title: "Pair it with QRCallBox",
    async run(adb, ctx) {
      const code = await ctx.pairCode();
      await adb.shell(`am start -a android.intent.action.VIEW -d 'gifcompanion://pair?code=${encodeURIComponent(code)}' ${PKG}`);
      const paired = await ctx.waitPaired(60_000);
      if (!paired) throw new Error("The phone didn't finish pairing. Check it has Wi-Fi (the app needs qrcallbox.com), then press Set up again.");
      return { ok: true, detail: `Paired (store ${paired.store}, key ${paired.keyId})` };
    },
  },
  {
    id: "start", title: "Start reading GIF",
    async run(adb) {
      const act = `${PKG}/.MainActivity`;
      // 0x24000000 = SINGLE_TOP | CLEAR_TOP: reaches the screen already open from pairing.
      await adb.shell(`am start -n ${act} -f 0x24000000 --es endpoint ${ENDPOINT} --ez enable true`);
      await sleep(3000);
      await adb.shell(`am start -n ${act} -f 0x24000000 --ez run true`);
      await sleep(1500);
      await adb.shell("input keyevent KEYCODE_HOME");
      return { ok: true, detail: "Sending readings to qrcallbox.com" };
    },
  },
  {
    id: "verify", title: "Wait for the first reading",
    async run(_adb, ctx) {
      const h = await ctx.waitReporting(4 * 60_000);
      if (!h) return { warn: true, detail: "No reading yet. Look at the phone: if GIF asks you to sign in, sign in and it carries on." };
      const st = h.phone?.status || {};
      if (/SIGNIN|NEEDS_PERSON|BLOCKED|LOCKED|NO_GIF/i.test(st.code || "")) {
        return { warn: true, detail: `The phone needs a person: ${st.error || st.code}. Fix that on the phone; readings start on their own.` };
      }
      return { ok: true, detail: st.step ? `Reporting — ${st.step}` : "Reporting to qrcallbox.com" };
    },
  },
];
