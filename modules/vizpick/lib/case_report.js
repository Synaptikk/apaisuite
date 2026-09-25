// modules/vizpick/lib/case_report.js
//
// The pick progression Business case as a PDF, with every data file the
// numbers were calculated from embedded in it as attachments (2026-09-16: the
// analyst presents it to the VizPick report owner, who needs to be able to
// recheck the maths, not just read it).
//
// The view builds a plain `model` (lib-free strings and numbers, names already
// resolved) from the same values it renders, so the PDF can never say
// something the tab does not. Everything here but generateCasePdf() is pure.
//
// model = {
//   store, day, generatedAt, verdict, setAside,
//   tallies: [{ value, label }],
//   groupRows: [{ group, rescans, rescansGained, rescanRate, rescanPicks, firstScans, firstScanPicks }],
//   otherJobs: [{ group, people: [name], ...same counts }],
//   associates: [{ name, job, scans, bins, picks }],
//   digAdds: [{ update, location, name, job, scan, prevName, prevJob, dDue, done, due }],
//   steps: [string], example: { location, narrative, rows: [{ update, scan, name, job, done, due, change }] } | null,
//   cannotShow, limits, summaryText,
//   entries: [history entry],                          // the cleaned day
//   people: { [win]: { name, job, shiftStart, shiftEnd } },
// }

import { scanLedger, ledgerCsv, toCsv } from "./home_history.js";

const cell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (head, rows) => [head, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");

/** The data files embedded in the PDF, in the order they are listed in it. */
export function caseAttachments(model) {
  const prefix = `vizpick-${model.store}-${model.day}`;
  const person = (win) => model.people?.[win] || null;
  const pct = (v) => (v == null ? "" : v);
  return [
    {
      name: `${prefix}-summary.txt`, type: "text/plain",
      description: "The business case as plain text (the same as Copy summary).",
      text: model.summaryText || "",
    },
    {
      name: `${prefix}-digital-scans-that-added-picks.csv`, type: "text/csv",
      description: "Every scan by a digital associate after which the bin had more picks due, with who had scanned the bin before.",
      text: csv(
        ["tableau_update", "bin", "scanned_by", "job", "scan_time", "scanned_before_by", "previous_job", "picks_added", "picks_done_after", "picks_due_after"],
        (model.digAdds || []).map((r) => [r.update, r.location, r.name, r.job, r.scan, r.prevName, r.prevJob, r.dDue, r.done, r.due]),
      ),
    },
    {
      name: `${prefix}-scan-comparison-by-job.csv`, type: "text/csv",
      description: "For each group of scanners: rescans, rescans that added picks, new picks on rescans, first scans of the day and new picks on first scans. Other jobs are also listed one by one.",
      text: csv(
        ["group", "job_detail", "associates", "rescans", "rescans_that_added_picks", "rescans_that_added_picks_pct", "new_picks_on_rescans", "first_scans_of_the_day", "new_picks_on_first_scans"],
        [
          ...(model.groupRows || []).map((g) => [g.group, "", "", g.rescans, g.rescansGained, pct(g.rescanRate), g.rescanPicks, g.firstScans, g.firstScanPicks]),
          ...(model.otherJobs || []).map((j) => ["Other jobs", j.group, j.people.join("; "), j.rescans, j.rescansGained, pct(j.rescanRate), j.rescanPicks, j.firstScans, j.firstScanPicks]),
        ],
      ),
    },
    {
      name: `${prefix}-bin-history.csv`, type: "text/csv",
      description: "Every bin's day: its starting state, each scan (who, when, done/due and the change) and each change with no new scan.",
      text: ledgerCsv(scanLedger(model.entries || []), { person }),
    },
    {
      name: `${prefix}-tableau-updates-every-bin.csv`, type: "text/csv",
      description: "The raw capture: every bin at every Tableau update used, one line per bin per update, with the last scanner and scan time Tableau reported.",
      text: toCsv(model.entries || [], { person }),
    },
    {
      name: `${prefix}-associates-and-jobs.csv`, type: "text/csv",
      description: "Every scanner's WIN with the name from the associate directory and the job and shift from that day's Digital Metrics schedule.",
      text: csv(
        ["win", "name", "scheduled_job", "shift_start", "shift_end"],
        Object.entries(model.people || {}).sort((a, b) => String(a[1]?.name || a[0]).localeCompare(String(b[1]?.name || b[0])))
          .map(([win, p]) => [win, p?.name || "", p?.job || "not on the schedule", p?.shiftStart || "", p?.shiftEnd || ""]),
      ),
    },
    {
      name: `${prefix}-tableau-updates-raw.json`, type: "application/json",
      description: "The exact Tableau updates used, as a pick history file. Load it with Pick progression > Load history file to recheck every number.",
      text: JSON.stringify({ v: 1, days: { [model.day]: model.entries || [] } }),
    },
  ];
}

const TEAL = "#17708A";
const INK = "#1C2320";
const MUTED = "#5F6B66";
const RULE = "#D5DDD9";
const TINT = "#EEF4F6";

const tableLayout = {
  hLineWidth: (i, node) => (i === 0 || i === 1 || i === node.table.body.length ? 0.8 : 0.3),
  vLineWidth: () => 0,
  hLineColor: (i) => (i === 1 ? INK : RULE),
  paddingLeft: () => 4, paddingRight: () => 4, paddingTop: () => 3, paddingBottom: () => 3,
};

const th = (text, alignment = "left") => ({ text, style: "th", alignment });
const td = (text, extra = {}) => ({ text: text == null ? "" : String(text), style: "td", ...extra });
const num = (text, extra = {}) => td(text, { alignment: "right", ...extra });

/** pdfmake document definition for the business case. Pure. */
export function caseDocDefinition(model, files = caseAttachments(model)) {
  const pct = (v) => (v == null ? "—" : `${v}%`);
  const content = [
    { text: `VizPick · store ${model.store} · ${model.day}`, style: "eyebrow" },
    { text: "Digital associates' scans add suggested picks", style: "title" },
    { text: `Generated ${model.generatedAt} from ${model.entries?.length || 0} Tableau updates kept by the APAISuite pick progression.`, style: "meta" },
    { text: model.verdict || "", style: "verdict", margin: [0, 10, 0, 6] },
  ];
  if (model.setAside) content.push({ text: `Set aside before measuring: ${model.setAside}.`, style: "note" });

  if (model.tallies?.length) {
    content.push({
      margin: [0, 6, 0, 4],
      table: {
        widths: model.tallies.map(() => "*"),
        body: [model.tallies.map((t) => ({
          stack: [{ text: String(t.value), fontSize: 16, bold: true, color: INK }, { text: t.label, fontSize: 8, color: MUTED }],
          fillColor: TINT, margin: [6, 5, 6, 5],
        }))],
      },
      layout: { hLineWidth: () => 0, vLineWidth: () => 3, vLineColor: () => "#FFFFFF" },
    });
  }

  content.push({ text: "Do picks go up when a bin is scanned, whoever scans it?", style: "h2" });
  const groupBody = [[th("Scanned by"), th("Rescans", "right"), th("Rescans that added picks", "right"), th("New picks on rescans", "right"), th("First scans of the day", "right"), th("New picks on first scans", "right")]];
  for (const g of model.groupRows || []) {
    const bold = g.group === "Digital";
    groupBody.push([td(g.group, { bold }), num(g.rescans, { bold }), num(`${g.rescansGained} (${pct(g.rescanRate)})`, { bold }), num(g.rescanPicks, { bold }), num(g.firstScans, { bold }), num(g.firstScanPicks, { bold })]);
    if (g.group === "Other jobs") {
      for (const j of model.otherJobs || []) {
        groupBody.push([
          { stack: [{ text: j.group, fontSize: 7.5 }, { text: j.people.join(", "), fontSize: 6.5, color: MUTED }], margin: [10, 0, 0, 0] },
          num(j.rescans, { fontSize: 7.5 }), num(`${j.rescansGained} (${pct(j.rescanRate)})`, { fontSize: 7.5 }), num(j.rescanPicks, { fontSize: 7.5 }),
          num(j.firstScans, { fontSize: 7.5 }), num(j.firstScanPicks, { fontSize: 7.5 }),
        ]);
      }
    }
  }
  content.push({ table: { headerRows: 1, widths: ["*", 44, 70, 60, 60, 66], body: groupBody }, layout: tableLayout });
  content.push({ text: "\"New picks\" are picks that appeared in a bin when that group scanned it: how many picks each group's scans generated. They are not picks left behind; most were pulled afterwards. \"Rescans\" are bins already scanned earlier that day, so a first scan of the day doesn't inflate them.", style: "note" });

  content.push({ text: "Picks added on digital scans, by associate", style: "h2" });
  if (model.associates?.length) {
    const body = [[th("Digital associate"), th("Scans that added picks", "right"), th("Bins", "right"), th("Picks added", "right")]];
    for (const a of model.associates) body.push([td(`${a.name}${a.job ? `  ·  ${a.job}` : ""}`), num(a.scans), num(a.bins), num(`+${a.picks}`, { color: "#A6423A", bold: true })]);
    const total = model.associates.reduce((n, a) => ({ scans: n.scans + a.scans, picks: n.picks + a.picks }), { scans: 0, picks: 0 });
    body.push([td("All digital associates", { bold: true }), num(total.scans, { bold: true }), num(new Set((model.digAdds || []).map((r) => r.location)).size, { bold: true }), num(`+${total.picks}`, { bold: true })]);
    content.push({ table: { headerRows: 1, widths: ["*", 90, 40, 60], body }, layout: tableLayout });
  } else {
    content.push({ text: "No digital scan added picks on this day.", style: "note" });
  }

  content.push({ text: `Every digital scan that added picks (${model.digAdds?.length || 0})`, style: "h2" });
  if (model.digAdds?.length) {
    const body = [[th("Tableau update"), th("Bin"), th("Scanned by"), th("Scan"), th("Scanned before by"), th("Picks added", "right"), th("Done / due after", "right")]];
    for (const r of model.digAdds) {
      body.push([td(r.update), td(r.location), td(r.name), td(r.scan), { stack: [{ text: r.prevName || "", style: "td" }, { text: r.prevJob || "", fontSize: 6.5, color: MUTED }] },
        num(`+${r.dDue}`, { color: "#A6423A", bold: true }), num(`${r.done} / ${r.due}`)]);
    }
    content.push({ table: { headerRows: 1, widths: [46, 34, "*", 44, "*", 38, 48], body }, layout: tableLayout });
  }

  content.push({ text: "How this is measured", style: "h2", pageBreak: "before" });
  content.push({ ol: (model.steps || []).map((s) => ({ text: s, style: "body", margin: [0, 0, 0, 3] })) });
  if (model.example) {
    content.push({ text: [{ text: `Worked example, bin ${model.example.location}. `, bold: true }, model.example.narrative || ""], style: "body", margin: [0, 8, 0, 6] });
    const body = [[th("Tableau update"), th("Bin's last scan"), th("Scanned by"), th("Done / due", "right"), th("Change since the row above", "right")]];
    for (const r of model.example.rows) body.push([td(r.update), td(r.scan), td(`${r.name}${r.job ? `  ·  ${r.job}` : ""}`), num(`${r.done} / ${r.due}`), num(r.change)]);
    content.push({ table: { headerRows: 1, widths: [60, 80, "*", 50, 100], body }, layout: tableLayout });
  }
  if (model.cannotShow) content.push({ text: model.cannotShow, style: "note" });
  if (model.limits) content.push({ text: model.limits, style: "note" });

  content.push({ text: "Data attached to this PDF", style: "h2" });
  content.push({ text: "Every number above was calculated from these files, which are embedded in this PDF. Open the attachments panel (the paperclip in Adobe Acrobat Reader) to save them. The CSV files open in Excel.", style: "body", margin: [0, 0, 0, 6] });
  content.push({
    table: {
      headerRows: 1, widths: [170, "*"],
      body: [[th("File"), th("What it holds")], ...files.map((f) => [td(f.name, { fontSize: 7.5 }), td(f.description)])],
    },
    layout: tableLayout,
  });

  return {
    info: { title: `VizPick business case, store ${model.store}, ${model.day}`, author: "APAISuite", subject: "Digital associates' scans and suggested picks" },
    pageSize: "LETTER",
    pageMargins: [40, 44, 40, 48],
    defaultStyle: { font: "Roboto", fontSize: 9, color: INK, lineHeight: 1.2 },
    footer: (page, pages) => ({
      columns: [
        { text: `VizPick business case · store ${model.store} · ${model.day}`, fontSize: 7, color: MUTED },
        { text: `Page ${page} of ${pages}`, fontSize: 7, color: MUTED, alignment: "right" },
      ],
      margin: [40, 16, 40, 0],
    }),
    styles: {
      eyebrow: { fontSize: 8, color: TEAL, bold: true, characterSpacing: 0.6 },
      title: { fontSize: 18, bold: true, margin: [0, 2, 0, 2] },
      meta: { fontSize: 8, color: MUTED },
      verdict: { fontSize: 10.5, lineHeight: 1.3 },
      h2: { fontSize: 12, bold: true, color: INK, margin: [0, 14, 0, 5] },
      body: { fontSize: 9 },
      note: { fontSize: 7.5, color: MUTED, margin: [0, 4, 0, 0] },
      th: { fontSize: 7.5, bold: true, color: MUTED },
      td: { fontSize: 8 },
    },
    content,
  };
}

// ── generation (view page only) ────────────────────────────────────────────
//
// pdfmake is vendored under this module (the module contract keeps modules
// self-contained; the same bundle ships with claimsdisposition). It loads on
// the first click only. Attachments use the engine's own embedded-file
// support (pdfkit `file()`), which pdfmake 0.2 does not expose in the
// document definition, so the pdfkit document is taken before it is ended.

let pdfMakePromise = null;
function loadPdfMake() {
  if (pdfMakePromise) return pdfMakePromise;
  const inject = (src) => new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`couldn't load ${src}`));
    document.head.appendChild(s);
  });
  pdfMakePromise = (async () => {
    if (!globalThis.pdfMake) await inject(chrome.runtime.getURL("modules/vizpick/vendor/pdfmake/pdfmake.min.js"));
    if (!globalThis.pdfMake) throw new Error("the PDF library loaded but did not start");
    if (!globalThis.pdfMake.vfs || !Object.keys(globalThis.pdfMake.vfs).length) {
      await inject(chrome.runtime.getURL("modules/vizpick/vendor/pdfmake/vfs_fonts.js"));
    }
    globalThis.pdfMake.fonts = {
      Roboto: { normal: "Roboto-Regular.ttf", bold: "Roboto-Medium.ttf", italics: "Roboto-Italic.ttf", bolditalics: "Roboto-MediumItalic.ttf" },
    };
    return globalThis.pdfMake;
  })().catch((e) => { pdfMakePromise = null; throw e; });
  return pdfMakePromise;
}

/** UTF-8 text → base64, in chunks so large CSVs don't overflow the call stack. */
export function textToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Build the PDF with its data files attached. Resolves { blob, files }. */
export async function generateCasePdf(model) {
  const pdfMake = await loadPdfMake();
  const files = caseAttachments(model);
  const doc = pdfMake.createPdf(caseDocDefinition(model, files))._createDoc({});
  if (typeof doc?.file !== "function") throw new Error("this PDF library build can't attach files");
  const now = new Date();
  for (const f of files) {
    doc.file(`data:${f.type};base64,${textToBase64(f.text)}`, {
      name: f.name, type: f.type, description: f.description, creationDate: now, modifiedDate: now,
    });
  }
  const blob = await new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(new Blob(chunks, { type: "application/pdf" })));
    doc.on("error", reject);
    doc.end();
  });
  return { blob, files };
}
