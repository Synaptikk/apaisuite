import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 180000 });
const page = (await browser.pages()).find(p => /intakenotice\/19060/.test(p.url()));
await page.bringToFront();
const seen = [];
page.on("request", r => { if (r.method() === "POST" && /riskonnect/.test(r.url())) seen.push({ u: r.url().replace("https://uat.riskonnectclearsight.com/Enterprise/", "").slice(0, 120), headers: r.headers() }); });
await page.evaluate(() => document.getElementById("radio-Yes-STARS_312")?.click());
await new Promise(r => setTimeout(r, 3000));
await page.evaluate(() => document.getElementById("radio-No-STARS_312")?.click());
await new Promise(r => setTimeout(r, 3000));
for (const s of seen) { console.log("POST", s.u); for (const [k, v] of Object.entries(s.headers)) if (!/^(accept-language|user-agent|sec-|origin|referer|cookie|content-length|accept-encoding)/i.test(k)) console.log("   ", k, "=", String(v).slice(0, 120)); }
const st = await page.evaluate(() => Object.keys(sessionStorage).concat(Object.keys(localStorage)).slice(0, 40));
console.log("storage keys:", JSON.stringify(st));
await browser.disconnect();
