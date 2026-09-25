import puppeteer from "puppeteer-core";
const browser = await puppeteer.connect({ browserURL: "http://localhost:9222", protocolTimeout: 60000 });
const page = (await browser.pages()).find(x => /intakenotice\/19059/.test(x.url()));
await page.bringToFront();
const sb = await page.$("#SpecialAnalysis\\#320_id");
await sb.click(); await new Promise(r => setTimeout(r, 1500));
const info = await page.evaluate(() => {
  const el = document.getElementById("SpecialAnalysis#320_id");
  const cb = el.closest(".slds-combobox_container") || el.closest(".slds-form-element") || el.parentElement.parentElement;
  const opts = [...document.querySelectorAll("[role=option], .slds-listbox__option, li, .slds-listbox li")].filter(o => o.getBoundingClientRect().width > 0 && /WIN|SSN/.test(o.textContent)).map(o => ({ tag: o.tagName, cls: (o.className || "").toString().slice(0, 80), id: o.id, text: o.textContent.trim().slice(0, 30), html: o.outerHTML.replace(/\s+/g, " ").slice(0, 500) }));
  return { readonly: el.readOnly, attrs: [...el.attributes].map(a => a.name + "=" + a.value.slice(0, 40)), html: (cb?.outerHTML || "").replace(/\s+/g, " ").slice(0, 2500), opts };
});
console.log(JSON.stringify(info, null, 1));
await browser.disconnect();
