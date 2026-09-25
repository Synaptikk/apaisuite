// modules/accidents/service.js
//
// Runs in the service worker. One pull does:
//   1. GET the CAS static HTML for the store (no auth) — evidence tables via
//      livedashboard's parser, PNL charge tables via lib/cas.js.
//   2. Enrich every claim on the evidence reports from Clearsight PROD
//      (read-only GETs with the session cookie; auto-SSO in a background tab
//      when the session is cold): claim FormData → description + Evidence
//      Collection checklist, supplemental statements, attachment count, and
//      a composed plain-text summary.
// PNL-only refs (the FY charge history) are resolved on demand per row
// ("resolve_ref") — there are ~60 of them and most are old and closed.
//
// Cache: chrome.storage.local["accidents.data.<store>"] (raw chrome.storage
// with manual prefixes — host.storage is view-page only).

import { parseAccidentHtml } from "../livedashboard/lib/sources/accident.js";
import { parsePnl, rollupPnl } from "./lib/cas.js";
import * as cs from "./lib/clearsight_read.js";
import { composeSummary } from "./lib/summary.js";
import { createAuth } from "../../shared/auth.js";
import { withKeepAwake } from "../../shared/sw_keepalive.js";
import { getUserHomeStore, getUserHomeStoreSource } from "../../shared/userStore.js";

const MODULE_ID = "accidents";
const CAS_BASE  = "https://storage.googleapis.com/cas_storage/cas_static_html";
const DATA_KEY  = (store) => `${MODULE_ID}.data.${store}`;
const LAST_STORE_KEY = `${MODULE_ID}.lastStore`;

const auth = createAuth(MODULE_ID);
const CLEARSIGHT_SSO = [{ text: /single sign\s*on/i }];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function broadcast(type, payload) {
  chrome.runtime.sendMessage({ module: MODULE_ID, type, payload }).catch(() => {});
}
const progress = (text) => broadcast("progress", { text });

async function readCache(store) {
  const key = DATA_KEY(store);
  return (await chrome.storage.local.get(key))[key] || null;
}
async function writeCache(store, data) {
  await chrome.storage.local.set({ [DATA_KEY(store)]: data, [LAST_STORE_KEY]: store });
}

// ── Clearsight session ──────────────────────────────────────────────

// True when signed in; when not, opens a background tab on the login page,
// clicks the Single Sign On link (pingfed completes silently in this
// profile) and waits. Never touches the user's own tabs.
async function ensureClearsight() {
  if (await cs.isSignedIn()) return true;
  progress("Signing in to Clearsight…");
  const tab = await chrome.tabs.create({ url: `${cs.BASE}/app/Clearsight/`, active: false });
  try {
    const deadline = Date.now() + 45_000;
    let clicked = false;
    while (Date.now() < deadline) {
      await delay(2500);
      if (await cs.isSignedIn()) return true;
      if (!clicked) clicked = !!(await auth.clickSso(tab.id, CLEARSIGHT_SSO).catch(() => null));
    }
    return cs.isSignedIn();
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// ── Per-claim enrichment ────────────────────────────────────────────

async function enrichClaim(refOrNumber) {
  const hit = await cs.quickSearch(refOrNumber);
  if (!hit) return { ref: refOrNumber, notFound: true };
  const [formData, stmts, attachments] = [
    await cs.claimFormData(hit.claimId, hit.coverageCode),
    await cs.statements(hit.claimId).catch((e) => { if (e instanceof cs.NotSignedIn) throw e; return []; }),
    await cs.attachmentCount(hit.claimId).catch(() => null),
  ];
  const digest = cs.claimDigest(formData);
  digest.coverageCode = hit.coverageCode;
  return {
    ref: refOrNumber,
    digest,
    statements: stmts,
    attachments,
    summary: composeSummary(digest, stmts),
    claimUrl: cs.claimUrl(hit.claimId),
    fetchedAt: new Date().toISOString(),
  };
}

// ── Handlers ────────────────────────────────────────────────────────

export const handlers = {
  async get_state() {
    const store = await getUserHomeStore();
    const storeSource = await getUserHomeStoreSource();
    const last = (await chrome.storage.local.get(LAST_STORE_KEY))[LAST_STORE_KEY];
    const effective = store || last || null;
    return {
      store: effective,
      storeSource,
      data: effective ? await readCache(effective) : null,
    };
  },

  async pull(msg) {
    return withKeepAwake(`${MODULE_ID}.pull`, async () => {
      const store = String(msg?.store || await getUserHomeStore() || "").trim();
      if (!store) return { ok: false, error: "No store set. Pick your home store in the shell header first." };

      progress(`Fetching CAS evidence file for ${store}…`);
      const resp = await fetch(`${CAS_BASE}/${encodeURIComponent(store)}.html`, { credentials: "omit" });
      if (resp.status === 404) return { ok: false, error: `No CAS accident file for store ${store}.` };
      if (!resp.ok) return { ok: false, error: `cas_storage returned ${resp.status}.` };
      const html = await resp.text();

      const parsed = parseAccidentHtml(html, store);
      if (!parsed.ok) return { ok: false, error: parsed.error || "Could not parse the CAS file." };
      const charges = parsePnl(html);

      const prev = await readCache(store);
      const data = {
        store,
        capturedAt: new Date().toISOString(),
        sourceUpdatedOn: parsed.sourceDataUpdatedOn,
        evidence: parsed.records,
        pnl: { charges, refs: rollupPnl(charges) },
        claims: {},
        refDetails: prev?.refDetails || {},   // lazy-loaded PNL details survive a re-pull
        clearsight: { signedIn: false, error: null },
      };

      const signedIn = await ensureClearsight().catch(() => false);
      data.clearsight.signedIn = signedIn;
      if (!signedIn) {
        data.clearsight.error = "Not signed in to Clearsight — evidence-report claims are listed without details. Pull again after signing in.";
      } else {
        const refs = [...new Set(parsed.records.map((r) => r.referenceNbr))];
        for (let i = 0; i < refs.length; i++) {
          progress(`Clearsight ${i + 1}/${refs.length}: claim ${refs[i]}…`);
          try {
            data.claims[refs[i]] = await enrichClaim(refs[i]);
          } catch (e) {
            if (e instanceof cs.NotSignedIn) { data.clearsight.error = "Clearsight session expired mid-pull."; break; }
            data.claims[refs[i]] = { ref: refs[i], error: e.message };
          }
        }
      }

      await writeCache(store, data);
      progress("");
      return { ok: true, data };
    });
  },

  // Lazy detail for a PNL Ref # (legacy C…/L… numbers included).
  async resolve_ref(msg) {
    const store = String(msg?.store || "").trim();
    const ref = String(msg?.ref || "").trim();
    if (!store || !ref) return { ok: false, error: "store and ref required" };
    if (!(await ensureClearsight())) return { ok: false, error: "Not signed in to Clearsight." };
    try {
      const detail = await enrichClaim(ref);
      const data = await readCache(store);
      if (data) {
        data.refDetails[ref] = detail;
        await writeCache(store, data);
      }
      return { ok: true, detail };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  async open_claim(msg) {
    const url = msg?.claimUrl || (msg?.claimId ? cs.claimUrl(msg.claimId) : `${cs.BASE}/app/Clearsight/`);
    await chrome.tabs.create({ url, active: true });
    return { ok: true };
  },

  async open_signin() {
    const tab = await chrome.tabs.create({ url: `${cs.BASE}/app/Clearsight/`, active: true });
    await delay(3000);
    await auth.clickSso(tab.id, CLEARSIGHT_SSO).catch(() => null);
    return { ok: true };
  },
};
