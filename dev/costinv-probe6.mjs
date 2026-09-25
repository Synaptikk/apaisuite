import puppeteer from "puppeteer-core";
const URL = "https://one.walmart.com/content/uswire/en_us/work1/merchandise/fresh.html";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", defaultViewport: null });
const page = await browser.newPage();
const net = [];
page.on("request", r => { if (["xhr","fetch"].includes(r.resourceType()) && !/omtrdc|adobedtm|\.rum|\/px\//.test(r.url())) net.push({ phase:"req", method:r.method(), url:r.url(), post:(r.postData()||"").slice(0,400) }); });
page.on("response", async r => {
  if (!["xhr","fetch"].includes(r.request().resourceType())) return;
  if (/omtrdc|adobedtm|\.rum|\/px\//.test(r.url())) return;
  let body=""; try { body = (await r.text()).slice(0,1200); } catch {}
  net.push({ phase:"res", status:r.status(), url:r.url(), body: body.replace(/\s+/g," ") });
});
await page.goto(URL, { waitUntil: "networkidle2", timeout: 90000 });
await new Promise(r => setTimeout(r, 3000));
net.length = 0;
const DATA_ID = "6cfabc601432d31fd0998a65d6c717b0";
await page.evaluate((id) => {
  const inp = document.querySelector(`input.search-tool[data-id="${id}"]`);
  inp.scrollIntoView(); inp.focus();
}, DATA_ID);
await page.type(`input.search-tool[data-id="${DATA_ID}"]`, "1458");
await page.evaluate((id) => {
  const inp = document.querySelector(`input.search-tool[data-id="${id}"]`);
  inp.closest("form").querySelector("button.btn-search-tool").click();
}, DATA_ID);
await new Promise(r => setTimeout(r, 7000));
console.log("=== NETWORK ===\n" + JSON.stringify(net, null, 1).slice(0, 7000));
const res = await page.evaluate((id) => {
  const inp = document.querySelector(`input.search-tool[data-id="${id}"]`);
  let box = inp; for (let k=0;k<6 && box.parentElement;k++){ box = box.parentElement; if (/table|result/i.test(box.innerHTML) && (box.innerText||"").includes("Dept")) break; }
  return { text: (box.innerText||"").replace(/\s+/g," ").slice(0,800), html: box.innerHTML.slice(0,2500) };
}, DATA_ID);
console.log("=== RESULT ===\n" + res.text + "\n---HTML---\n" + res.html);
await page.close(); await browser.disconnect();
