// Try every GTA "My Reports" Cognos report: fill Team/date params where the
// form has them, submit, and classify the outcome (DATA / NO DATA / ERROR).
// Usage: node dev/gta-report-survey.mjs [team] [dateMMDDYYYY]
import fs from "node:fs";
import puppeteer from "puppeteer-core";

const TEAM = process.argv[2] || "01458-01-930";
const DATE = process.argv[3] || "09/22/2026";
// targetFilter: Edge freezes idle tabs (the VizPick capture set), and
// initializing a frozen target hangs Network.enable — attach only to the
// timesheet tab.
const b = await puppeteer.connect({
  browserURL: "http://127.0.0.1:9222", protocolTimeout: 60000,
  targetFilter: (t) => String(typeof t.url === "function" ? t.url() : t.url).includes("timesheet.cloud"),
});
const pg = (await b.pages()).find((x) => x.url().includes("timesheet.cloud"));
if (!pg) { console.error("no timesheet tab"); process.exit(1); }
await pg.bringToFront();
// Leaving a submitted report can raise a confirm(); an unhandled dialog
// blocks every subsequent CDP evaluate (that is what killed run #2).
pg.on("dialog", (d) => d.accept().catch(() => {}));

const cf = () => pg.frames().find((f) => f.name() === "contentFrame")
  || pg.frames().find((f) => /reportParams|folderTree|reportViewer|dailytimesheet/.test(f.url()));

// 1. Collect the report list from the folder tree.
const listFrame = cf();
const reports = await listFrame.evaluate(async () => {
  const res = await fetch("/gtaapp/interface/folderTree.jsp?rootId=216&expandLevel=3", { credentials: "include" });
  const txt = await res.text();
  return [...txt.matchAll(/href="(\/gtaapp\/reports\/cognos\/reportParams\.jsp\?[^"]+)"[^>]*><span[^>]*>([^<]+)<\/span>/g)]
    .map((m) => ({ url: m[1].replace(/&amp;/g, "&"), name: m[2].trim() }));
});
console.log(`${reports.length} reports found\n`);

const results = [];
for (const rep of reports) {
  const tag = rep.name.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40);
  try {
    await pg.evaluate((u) => { window.frames.contentFrame.location = u; }, rep.url).catch(() => {});
    await new Promise((r) => setTimeout(r, 5000));
    let frame = pg.frames().find((f) => f.url().includes("reportParams"));
    if (!frame) {   // one retry — the frameset sometimes needs a second nudge
      await pg.evaluate((u) => { window.frames.contentFrame.location = u; }, rep.url).catch(() => {});
      await new Promise((r) => setTimeout(r, 5000));
      frame = pg.frames().find((f) => f.url().includes("reportParams"));
    }
    if (!frame) { results.push({ name: rep.name, out: "no params page" }); continue; }

    // Fill whatever the form has.
    const filled = await frame.evaluate((TEAM, DATE) => {
      const done = [];
      const teamLbl = document.querySelector("input[name=TEAM_label]");
      if (teamLbl) { teamLbl.value = TEAM; teamLbl.dispatchEvent(new Event("change", { bubbles: true })); done.push("team"); }
      return done;
    }, TEAM, DATE);
    if (filled.includes("team")) await new Promise((r) => setTimeout(r, 4500));
    // NOTE: this page's ancient framework breaks NodeList iteration (spread /
    // for..of yields numbers) — use classic index loops only.
    const state = await frame.evaluate((DATE) => {
      const done = [];
      const teamHid = document.querySelector("input[name=TEAM]");
      const setDummy = (n) => {
        const d = document.getElementsByName(n)[0];
        if (d) { d.value = DATE; d.onchange && d.onchange(new Event("change")); done.push(n); }
      };
      setDummy("START_DATE_dummy"); setDummy("END_DATE_dummy"); setDummy("DATE_dummy"); setDummy("AS_OF_DATE_dummy");
      const sels = document.getElementsByTagName("select");
      for (let i = 0; i < sels.length; i++) {
        const sel = sels.item(i);
        if ((/^\s*$/.test(sel.value) || sel.selectedIndex === 0) && /select one/i.test(sel.options[0]?.text || "")) {
          if (sel.options.length > 1) { sel.selectedIndex = 1; sel.dispatchEvent(new Event("change", { bubbles: true })); done.push(`sel:${sel.name}`); }
        }
      }
      return { done, team: teamHid ? teamHid.value : "n/a" };
    }, DATE);

    // Submit: the button's onclick is plain JS (validate + form.submit), so a
    // synthetic click works — no trusted event needed.
    const clicked = await frame.evaluate(() => {
      const lists = [document.getElementsByTagName("button"), document.getElementsByTagName("input")];
      for (const list of lists) {
        for (let i = 0; i < list.length; i++) {
          const e = list.item(i);
          if (String(e.value || e.textContent || "").trim() === "Submit") { e.click(); return true; }
        }
      }
      return false;
    });
    if (!clicked) { results.push({ name: rep.name, out: "no submit", fields: state }); continue; }
    await new Promise((r) => setTimeout(r, 25000));

    // Classify what rendered: read each frame separately through the CDP
    // frame list (a hung or cross-origin frame then only loses itself).
    let all = "";
    for (const f of pg.frames()) {
      if (/menu\.jsp/.test(f.url())) continue;
      const t = await Promise.race([
        f.evaluate(() => (document.body ? document.body.innerText : "")).catch(() => ""),
        new Promise((r) => setTimeout(() => r(""), 8000)),
      ]);
      all += " " + t;
    }
    all = all.replace(/\s+/g, " ");
    const verdict = /RQP-DEF|System Error|error has occurred/i.test(all)
      ? "ERROR: " + (all.match(/RQP-DEF-\d+[^.]*|Unparseable[^"]{0,60}/) || ["server error"])[0]
      : /No Data Available/i.test(all) ? "NO DATA"
      : /being processed/i.test(all) ? "STILL PROCESSING after 25s"
      : "DATA? " + ((all.match(/Run Date:[^]*/) || [all])[0]).slice(0, 220);
    await pg.screenshot({ path: `gta-survey-${tag}.png` });
    results.push({ name: rep.name, team: state.team, filled: [...filled, ...state.done], out: verdict });
    console.log(`■ ${rep.name} → ${verdict.slice(0, 120)}`);
  } catch (e) {
    results.push({ name: rep.name, out: "script error: " + String(e).slice(0, 120) });
    console.log(`■ ${rep.name} → script error`);
  }
}
fs.writeFileSync(new URL("./.gta-survey.json", import.meta.url), JSON.stringify(results, null, 1));
console.log("\nsaved .gta-survey.json");
b.disconnect();
