// UAT notice 19060: revisit pages listed on the Error Summary, fill every empty combobox with its first option, then re-submit.
import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
const OUT = "C:/Users/SES008~1.S01/AppData/Local/Temp/claude/C--Users-ses008s-s01458-Desktop-APAISuite/040c3438-1536-48d3-9351-7c26de274ae3/scratchpad";
const NOTICE = (process.argv.find(a => a.startsWith("--notice=")) || "--notice=19060").slice(9);
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 300000 });
const page = (await browser.pages()).find(p => new RegExp("intakenotice/" + NOTICE).test(p.url()));
await page.bringToFront();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const reqs = [];
page.on("request", r => { if (r.method() === "POST" && /SaveInterview|InterviewUpdate/.test(r.url())) reqs.push({ u: r.url().replace("https://uat.riskonnectclearsight.com/Enterprise/", "").slice(0, 100), body: r.postData() || "" }); });
page.on("response", async r => { if (/SaveInterview/.test(r.url())) { const i = reqs.findIndex(x => /SaveInterview/.test(x.u) && x.resp === undefined); if (i >= 0) { try { reqs[i].resp = (await r.text()).slice(0, 1500); } catch {} } } });
const navTo = async (name) => {
  const hs = await page.$$("li, a, span, div");
  for (const h of hs) { const t = ((await (await h.getProperty("innerText")).jsonValue()) || "").trim(); if (t === name) { const box = await h.boundingBox(); if (box && box.width < 400) { await h.click(); await sleep(6000); return true; } } }
  return false;
};
const currentPage = () => page.evaluate(() => { const s = [...document.querySelectorAll("nav li, [class*='sub-menu'] li, aside li")].map(e => (e.innerText || "").trim()).filter(Boolean); const heads = [...document.querySelectorAll("[class*='page'] h1, h2, h3, .slds-text-heading_medium, [class*='title']")].map(e => (e.innerText || "").trim()); return { steps: [...new Set(s)], firstHead: heads.find(h => /^[A-Z_ ]{6,}$/.test(h)) }; });
const fillCombos = async () => {
  const ids = await page.evaluate(() => [...document.querySelectorAll("input[id$='_id']")].filter(e => e.getBoundingClientRect().width > 0 && !e.value).map(e => e.id));
  const done = [];
  for (const id of ids) {
    const el = await page.$(`#${id}`); if (!el) continue;
    await el.click(); await sleep(2500);
    let picked = await page.evaluate(() => { const o = [...document.querySelectorAll("[role='option'], .slds-listbox__option, li.slds-listbox__item")].find(x => x.getBoundingClientRect().width > 0); if (o) { o.click(); return o.textContent.trim().slice(0, 40); } return null; });
    if (!picked) { await el.type("a", { delay: 60 }); await sleep(2500); picked = await page.evaluate(() => { const o = [...document.querySelectorAll("[role='option'], .slds-listbox__option, li.slds-listbox__item")].find(x => x.getBoundingClientRect().width > 0); if (o) { o.click(); return o.textContent.trim().slice(0, 40); } return null; }); }
    await sleep(1200);
    const v = await page.evaluate((id) => document.getElementById(id)?.value, id);
    done.push(`${id}: picked=${picked} value="${v}"`);
    // multi-select comboboxes may keep the list open; press Escape
    await page.keyboard.press("Escape"); await sleep(300);
  }
  return done;
};
for (const pg of ["GL_Customer Statement", "GL_Incident Summary", "Witness Statements"]) {
  console.log(`\n=== ${pg}: nav=${await navTo(pg)} at=${JSON.stringify((await currentPage()).firstHead)}`);
  for (let round = 0; round < 3; round++) { const d = await fillCombos(); if (!d.length) break; console.log(d.join("\n")); }
  const radios = await page.evaluate(() => { const groups = {}; [...document.querySelectorAll("input[type=radio]")].filter(r => r.getBoundingClientRect().width > 0).forEach(r => { (groups[r.name] ||= []).push(r); }); const out = []; for (const [n, g] of Object.entries(groups)) { if (!g.some(r => r.checked)) { const pick = g.find(r => /^(N|NO)$/i.test(r.value)) || g[0]; pick.click(); out.push(n + "→" + pick.value); } } return out; });
  if (radios.length) { console.log("radios set:", radios.join(", ")); await sleep(1500); await fillCombos(); }
  const empties = await page.evaluate(() => [...document.querySelectorAll("input[id$='_id'], textarea, input[type=text]")].filter(e => e.getBoundingClientRect().width > 0 && !e.value && /STARS_/.test(e.id)).map(e => e.id));
  console.log("still empty:", JSON.stringify(empties));
  await page.screenshot({ path: `${OUT}/fix-${NOTICE}-${pg.replace(/\W+/g, "_")}.png`, fullPage: true });
}
// walk Next to the Summary
for (let i = 0; i < 6; i++) {
  const hasSubmit = await page.evaluate(() => !![...document.querySelectorAll("button")].find(b => /^submit$/i.test((b.innerText || "").trim()) && b.getBoundingClientRect().width > 0));
  if (hasSubmit) break;
  const c = await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find(b => (b.innerText || "").trim() === "Next" && b.getBoundingClientRect().width > 0); if (b) { b.click(); return true; } return false; });
  console.log("Next:", c); if (!c) break; await sleep(8000);
}
console.log("at:", JSON.stringify(await currentPage()));
const sub = await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find(b => /^submit$/i.test((b.innerText || "").trim()) && b.getBoundingClientRect().width > 0); if (b) { b.click(); return true; } return false; });
console.log("Submit:", sub); await sleep(4000);
console.log("confirm:", await page.evaluate(() => { const m = [...document.querySelectorAll(".slds-modal.slds-fade-in-open, [role=dialog]")].pop(); if (!m) return null; const b = [...m.querySelectorAll("button")].find(b => /^ok$/i.test((b.innerText || "").trim())); b && b.click(); return (m.innerText || "").replace(/\n+/g, " | ").slice(0, 200); }));
await sleep(12000);
const txt = await page.evaluate(() => document.body.innerText);
console.log("URL:", page.url());
console.log("RESULT:", txt.replace(/\n+/g, " | ").slice(0, 2500));
await page.screenshot({ path: `${OUT}/submit2-${NOTICE}-result.png`, fullPage: true });
writeFileSync(`${OUT}/submit2-${NOTICE}-xhr.json`, JSON.stringify(reqs, null, 1));
await browser.disconnect();
