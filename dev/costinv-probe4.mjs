import puppeteer from "puppeteer-core";
const URL = "https://one.walmart.com/content/uswire/en_us/work1/merchandise/fresh.html";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();
const net = [];
page.on("response", async r => {
  const t = r.request().resourceType();
  if (t !== "xhr" && t !== "fetch") return;
  if (/omtrdc|adobedtm|\.rum|px\//.test(r.url())) return;
  let body = ""; try { body = (await r.text()).slice(0, 900); } catch {}
  net.push({ url: r.url(), status: r.status(), method: r.request().method(),
             reqBody: (r.request().postData() || "").slice(0, 300), body: body.replace(/\s+/g, " ") });
});
await page.goto(URL, { waitUntil: "networkidle2", timeout: 90000 });
await new Promise(r => setTimeout(r, 3000));

// describe each search-tool widget
const tools = await page.evaluate(() => {
  return [...document.querySelectorAll("input.search-tool")].map((inp, i) => {
    let box = inp; for (let k = 0; k < 8 && box.parentElement; k++) box = box.parentElement;
    const heading = (box.innerText || "").trim().replace(/\s+/g, " ").slice(0, 200);
    inp.setAttribute("data-probe", "t" + i);
    const btn = box.querySelector("button.btn-search-tool");
    if (btn) btn.setAttribute("data-probe-btn", "t" + i);
    const container = inp.closest("[class*='tool'],[class*='section']");
    return { i, heading, containerCls: container?.className?.slice(0,120), boxCls: box.className?.slice(0,120) };
  });
});
console.log("=== TOOL WIDGETS ===\n" + JSON.stringify(tools, null, 1));

// pick the one whose heading mentions Beginning Inventory
const target = tools.find(t => /Beginning Inventory/i.test(t.heading)) || tools[0];
console.log("=== USING WIDGET", target?.i, "===");
net.length = 0;
await page.type(`input[data-probe="t${target.i}"]`, "1458");
await page.click(`button[data-probe-btn="t${target.i}"]`).catch(async () => {
  await page.keyboard.press("Enter");
});
await new Promise(r => setTimeout(r, 6000));
console.log("=== NETWORK AFTER SEARCH ===\n" + JSON.stringify(net, null, 1).slice(0, 6000));

const result = await page.evaluate((idx) => {
  const inp = document.querySelector(`input[data-probe="t${idx}"]`);
  let box = inp; for (let k = 0; k < 8 && box.parentElement; k++) box = box.parentElement;
  return { text: (box.innerText||"").replace(/\s+/g," ").slice(0, 1200), html: box.innerHTML.slice(0, 1500) };
}, target.i);
console.log("=== RESULT TEXT ===\n" + result.text);
await page.close(); await browser.disconnect();
