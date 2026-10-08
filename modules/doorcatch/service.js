// modules/doorcatch/service.js
//
// Door Catches — service-worker handlers. The data lives in QRCallBox
// (doorStores/{store}/catches); this module only reads and reviews it.
//
//   get_settings   store, whether a review key is saved, the door link
//   save_settings  { storeNbr, reviewKey, submitKey } (keys stay in this browser)
//   list           { from, to } → catches for the saved store
//   set_review     { id, status: new|reviewed|dismissed, note }
//   set_hosts      { hosts: [name] } → the name list door hosts pick from
//   cached_list    the last list loaded here (instant paint on open)
//   peek_items     { upcs } → cached item details only, no network
//   lookup_items   { upcs, force } → name, brand, category, picture per UPC
//                  (lib/item_lookup.js: go-upc.com, then upcitemdb.com; cached)

import { getUserHomeStore } from "../../shared/userStore.js";
import { getIdentity } from "../../shared/identity.js";
import { doorLink, listCatches, setHosts, setReview } from "./lib/api.js";
import { cachedItems, lookupItems } from "./lib/item_lookup.js";

const KEY = "doorcatch.settings";
const LAST_LIST_KEY = "doorcatch.lastList";

async function settings() {
  const got = (await chrome.storage.local.get(KEY))[KEY] || {};
  const storeNbr = got.storeNbr || String((await getUserHomeStore().catch(() => null)) || "");
  return { storeNbr, reviewKey: got.reviewKey || "", submitKey: got.submitKey || "" };
}

function publicSettings(s) {
  return {
    ok: true,
    storeNbr: s.storeNbr,
    hasReviewKey: !!s.reviewKey,
    doorLink: s.storeNbr && s.submitKey ? doorLink(s.storeNbr, s.submitKey) : "",
  };
}

async function ready() {
  const s = await settings();
  if (!s.storeNbr || !s.reviewKey) return { error: { ok: false, error: "Set the store and review key first." } };
  return { s };
}

export const handlers = {
  async get_settings() {
    return publicSettings(await settings());
  },

  async save_settings(msg) {
    const cur = await settings();
    const next = {
      storeNbr: String(msg.storeNbr ?? cur.storeNbr).trim().replace(/^0+/, ""),
      reviewKey: msg.reviewKey != null && String(msg.reviewKey).trim() ? String(msg.reviewKey).trim() : cur.reviewKey,
      submitKey: msg.submitKey != null && String(msg.submitKey).trim() ? String(msg.submitKey).trim() : cur.submitKey,
    };
    if (next.storeNbr && !/^\d{1,5}$/.test(next.storeNbr)) return { ok: false, error: "Store must be a number." };
    await chrome.storage.local.set({ [KEY]: next });
    return publicSettings(next);
  },

  async list(msg) {
    const { s, error } = await ready();
    if (error) return error;
    const res = await listCatches({ storeNbr: s.storeNbr, reviewKey: s.reviewKey, from: msg.from, to: msg.to });
    if (res.ok) await chrome.storage.local.set({ [LAST_LIST_KEY]: { storeNbr: s.storeNbr, from: msg.from, to: msg.to, at: Date.now(), res } });
    return res;
  },

  // The last list this browser loaded, so the page opens with it instantly
  // while a fresh one is fetched. Only returned for the same store.
  async cached_list() {
    const s = await settings();
    const got = (await chrome.storage.local.get(LAST_LIST_KEY))[LAST_LIST_KEY];
    if (!got || got.storeNbr !== s.storeNbr) return { ok: false };
    return { ok: true, from: got.from, to: got.to, at: got.at, list: got.res };
  },

  async peek_items(msg) {
    return { ok: true, items: await cachedItems(msg.upcs || []) };
  },

  async set_review(msg) {
    const { s, error } = await ready();
    if (error) return error;
    const me = await getIdentity();
    const reviewer = me.displayName || me.win || "";
    return setReview({ storeNbr: s.storeNbr, reviewKey: s.reviewKey, id: msg.id, status: msg.status, note: msg.note || "", reviewer });
  },

  async set_hosts(msg) {
    const { s, error } = await ready();
    if (error) return error;
    return setHosts({ storeNbr: s.storeNbr, reviewKey: s.reviewKey, hosts: msg.hosts || [] });
  },

  async lookup_items(msg) {
    const res = await lookupItems(msg.upcs || [], { force: !!msg.force });
    return { ok: true, ...res };
  },
};
