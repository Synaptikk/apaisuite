// dev/registerls-roles-check.mjs — reload the debug-Edge extension, open Register L/S Triage and check the
// register map card (roles for 92-94 / 61-64), the role tags on queue rows, and the training-receipt
// attach/remove round trip through the service worker. Usage: node dev/registerls-roles-check.mjs
import puppeteer from "puppeteer-core";
const EXT = "fchnolphfaklbpdgnofhblfhcailkpdb";
const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", protocolTimeout: 240000 });
let page = await browser.newPage();
await page.goto(`chrome-extension://${EXT}/app.html`, { waitUntil: "domcontentloaded" });
await page.evaluate(() => chrome.runtime.reload());
await new Promise((r) => setTimeout(r, 4000));
page = await browser.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error" && !/hoops|500/.test(m.text())) errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`chrome-extension://${EXT}/app.html#/registerls`, { waitUntil: "domcontentloaded" });
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const p = await page.evaluate(() => document.querySelector("[data-progress]")?.textContent || "");
  const spin = await page.evaluate(() => [...document.querySelectorAll(".btn-spinner")].some((s) => !s.hidden));
  if (!p && !spin && i > 2) break;
}
const send = (type, payload = {}) => page.evaluate((type, payload) => new Promise((res) => chrome.runtime.sendMessage({ module: "registerls", type, ...payload }, (r) => res(r))), type, payload);
const regs = await send("get_registers");
const list = regs?.data?.registers || regs?.registers || [];
const pick = (r) => list.find((x) => x.register === r);
console.log("register map:", list.length, "registers; wide:", (regs?.data || regs)?.wide);
for (const r of ["1", "11", "61", "62", "63", "64", "67", "92", "93", "94"]) { const e = pick(r); console.log(`  reg ${r}: ${e ? `${e.role} (${e.source}) desc=${e.desc || "-"}` : "not on map"}`); }
const ui = await page.evaluate(() => ({
  card: !document.querySelector("[data-registers]")?.hidden,
  meta: document.querySelector("[data-registers-meta]")?.textContent || "",
  selects: document.querySelectorAll("[data-register-role]").length,
  roleTags: [...document.querySelectorAll(".rls-row-reg")].map((e) => e.textContent.replace(/\s+/g, " ").trim()).filter((t) => t.includes("service desk") || t.includes("money center") || t.includes("self-checkout")).slice(0, 6),
  receiptForm: !!document.querySelector("[data-receipt-form]"),
  wins: document.querySelectorAll("[data-receipt-wins] option").length,
}));
console.log("ui:", ui);
// override round trip: mark 63 a department, then reset
const set1 = await send("set_register_role", { register: "63", role: "department" });
const after1 = (set1?.data || set1)?.registers?.find((x) => x.register === "63");
console.log("override 63→department:", after1 && `${after1.role} (${after1.source})`);
const set2 = await send("set_register_role", { register: "63", role: null });
const after2 = (set2?.data || set2)?.registers?.find((x) => x.register === "63");
console.log("reset 63:", after2 && `${after2.role} (${after2.source})`);
// training receipt round trip
const add = await send("add_training_receipt", { associateId: "9999999", associate: "TEST, CASHIER", date: "2026-09-10", register: "15", amount: "43.12", receipt: "TC 0000-TEST", note: "live check" });
console.log("add_training_receipt:", JSON.stringify(add).slice(0, 200));
const dup = await send("add_training_receipt", { associateId: "9999999", associate: "TEST, CASHIER", date: "2026-09-10", register: "15", amount: "43.12", receipt: "TC 0000-TEST" });
console.log("duplicate refused:", JSON.stringify(dup).slice(0, 160));
const cash = await send("get_cashiers");
const me = (cash?.data || cash)?.cashiers?.find((c) => c.id === "9999999");
console.log("ledger shows test cashier:", me && { count: me.count, total: me.totalCents, types: Object.keys(me.byType), key: me.events[0]?.key, manual: me.events[0]?.manual });
const key = (add?.data || add)?.key;
const rm = await send("remove_manual_event", { key });
console.log("remove_manual_event:", JSON.stringify(rm).slice(0, 120));
const cash2 = await send("get_cashiers");
console.log("test cashier gone:", !(cash2?.data || cash2)?.cashiers?.some((c) => c.id === "9999999"));
if (errors.length) console.log("page errors:", errors.slice(0, 5));
await page.close(); browser.disconnect();
