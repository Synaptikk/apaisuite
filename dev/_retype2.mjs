// dev/_retype2.mjs — scratch. Full retype flow per event: edit → radio → publish → verify.
// Usage: node dev/_retype2.mjs <tabId>
import { connect, sleep } from "./_cdp.mjs";

// eventId → expected original local date (from dev/_omni-compact.json)
const EVENTS = {
  "1841233":  "2022-12-19",
  "2523578":  "2023-04-23",
  "4467341":  "2024-01-17",
  "4598131":  "2024-02-02",
  "5151543":  "2024-04-13",
  "7724257":  "2025-02-10",
  "10361287": "2025-12-01",
  "10501712": "2025-12-18",
};

const tabId = process.argv[2];
const c = await connect(tabId);
await c.send("Page.enable");
await c.send("Runtime.enable");
await c.send("Network.enable");
let jwt = null;
c.on(m => {
  if (m.method === "Network.requestWillBeSent") {
    const a = m.params.request.headers?.Authorization || m.params.request.headers?.authorization;
    if (a && a.startsWith("Bearer ")) jwt = a;
  }
});

async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn().catch(() => false)) return;
    await sleep(700);
  }
  throw new Error("timeout: " + what);
}

const results = [];
for (const [id, expectDate] of Object.entries(EVENTS)) {
  const r = { eventId: id, expectDate };
  try {
    await c.send("Page.navigate", { url: `https://app.us.auror.co/event/edit/${id}` });
    await waitFor(() => c.evalJs(`!!([...document.querySelectorAll("button")].find(e => (e.innerText||"").trim() === "Event type"))`), 30000, "edit load");
    await sleep(1500);

    // Open the type chooser if radios aren't showing.
    if (!(await c.evalJs(`document.querySelectorAll("[role=radio][aria-checked]").length > 5`))) {
      await c.evalJs(`[...document.querySelectorAll("button")].find(e => (e.innerText||"").trim() === "Event type").click()`);
      await waitFor(() => c.evalJs(`document.querySelectorAll("[role=radio][aria-checked]").length > 5`), 15000, "chooser");
    }
    r.before = await c.evalJs(`([...document.querySelectorAll("[role=radio]")].find(e => e.getAttribute("aria-checked") === "true")?.innerText || "?").split("\\n")[0]`);

    await c.evalJs(`(() => {
      const radio = [...document.querySelectorAll("[role=radio]")].find(e => (e.innerText || "").trim().startsWith("Third party shopper/delivery theft"));
      if (!radio) throw new Error("no third-party radio");
      if (radio.getAttribute("aria-checked") !== "true") radio.click();
    })()`);

    // The click re-renders into the draft wizard; wait for draft header + autosave.
    await waitFor(() => c.evalJs(`location.href.includes("/edit/draft/") && /Third party shopper\\/delivery theft/.test(document.body.innerText) && /All changes saved/i.test(document.body.innerText)`), 25000, "draft saved");
    // Guard: the draft's date input must still hold the ORIGINAL date.
    const dateVal = await c.evalJs(`([...document.querySelectorAll("input[placeholder='MM/DD/YYYY']")].map(i => i.value)[0]) || ""`);
    r.draftDate = dateVal;
    const [y, mo, d] = expectDate.split("-");
    if (dateVal && dateVal !== `${Number(mo)}/${Number(d)}/${y}` && dateVal !== `${mo}/${d}/${y}`) {
      throw new Error(`draft date "${dateVal}" != expected ${expectDate} — NOT publishing`);
    }

    await c.evalJs(`(() => {
      const btn = [...document.querySelectorAll("button")].find(e => (e.innerText || "").trim() === "Publish");
      if (!btn || btn.disabled) throw new Error("Publish unavailable");
      btn.click();
    })()`);
    await waitFor(() => c.evalJs(`!location.href.includes("/edit/")`), 30000, "publish nav");
    await sleep(2000);

    if (!jwt) throw new Error("no JWT for verification");
    const check = await c.evalJs(`(async () => {
      const resp = await fetch("https://app.us.auror.co/api/spa/EventProfile/event/${id}", { headers: { Authorization: ${JSON.stringify(jwt ?? "")}, "X-Requested-With": "XMLHttpRequest" } });
      if (!resp.ok) return { err: resp.status };
      const d2 = await resp.json();
      return { eventType: d2?.eventHeroCardView?.eventType, occurredAt: d2?.eventHeroCardView?.occurredAt };
    })()`);
    r.after = check;
    r.ok = check?.eventType === "ThirdPartyAgentTheft" && String(check?.occurredAt || "").startsWith(expectDate);
  } catch (e) {
    r.ok = false;
    r.error = String(e?.message ?? e).slice(0, 200);
  }
  console.log(JSON.stringify(r));
  results.push(r);
  await sleep(1500);
}
console.log("SUMMARY:", results.filter(x => x.ok).length + "/" + results.length, "ok");
c.close();
