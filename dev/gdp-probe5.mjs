import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();
const calls = [];
page.on("response", async r => {
  if (!/execute-query/.test(r.url())) return;
  const post = r.request().postData() || "";
  let ds = null; try { ds = JSON.parse(post).datasetId; } catch {}
  let body = ""; try { body = (await r.text()).slice(0, 700); } catch {}
  calls.push({ datasetId: ds, status: r.status(), post: post.slice(0, 1400), body: body.replace(/\s+/g," ") });
});
await page.goto("https://gdp-connect.walmart.com/user/projects/20/dashboards/351", { waitUntil: "domcontentloaded", timeout: 90000 });
await new Promise(r => setTimeout(r, 12000));

// find the Store Number filter control
const ctrls = await page.evaluate(() => [...document.querySelectorAll("input")].map((e,i) => {
  e.setAttribute("data-probe", "i"+i);
  return { i, ph: e.placeholder||"", aria: e.getAttribute("aria-label")||"", id: e.id||"", name: e.name||"", label: (e.closest("label")?.innerText||e.parentElement?.innerText||"").trim().slice(0,60) };
}));
console.log("=== INPUTS ===\n" + JSON.stringify(ctrls, null, 1).slice(0, 2500));

const store = ctrls.find(c => /store/i.test(c.label + c.ph + c.aria + c.id));
if (store) {
  await page.click(`input[data-probe="i${store.i}"]`);
  await page.type(`input[data-probe="i${store.i}"]`, "1458", { delay: 80 });
  await new Promise(r => setTimeout(r, 3500));
  // pick the matching option from the listbox
  const picked = await page.evaluate(() => {
    const opts = [...document.querySelectorAll("li,[role='option']")].filter(o => /^\s*1458\s*$/.test(o.textContent||""));
    if (opts[0]) { opts[0].click(); return opts[0].textContent.trim(); }
    return null;
  });
  console.log("picked option:", picked);
  await new Promise(r => setTimeout(r, 2000));
  const applied = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find(x => /apply filters/i.test(x.textContent||""));
    if (b) { b.click(); return true; } return false;
  });
  console.log("clicked apply:", applied);
  await new Promise(r => setTimeout(r, 15000));
}
console.log("=== EXECUTE-QUERY CALLS ===");
for (const c of calls) console.log(`datasetId=${c.datasetId} status=${c.status}\n  POST ${c.post}\n  BODY ${c.body.slice(0,400)}\n`);
await page.close(); await browser.disconnect();
