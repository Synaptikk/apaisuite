// modules/qrcallbox/service.js
//
// SW handlers for the QRCallBox module: the store-side screens of
// qrcallbox.com (scans, insights, team, posters, admin approvals) without
// opening the website. Every read runs under the signed-in user's own
// Firebase ID token, so qrcallbox.com's Firestore rules decide what they
// see — a non-admin only ever gets their own store.
//
// Not here on purpose: the customer scan page, registration and the legal
// pages stay on qrcallbox.com (customers do not have the extension), and the
// Workvivo token courier stays in modules/workvivo.

import {
  ApiError, signIn, signOut, getSession, getIdToken, jwtClaims,
  fsGet, fsQuery, callApi, mintPoster, scanUrl, SITE,
} from "./lib/api.js";
import { scanRow } from "./lib/stats.js";

const DAY_MS = 86_400_000;
const MAX_SCANS = 2000;

const fail = (err) => ({
  ok: false,
  errorClass: err?.errorClass ?? "SERVER",
  error: String(err?.message ?? err),
});

async function wrap(fn) {
  try {
    return { ok: true, ...(await fn()) };
  } catch (err) {
    if (!(err instanceof ApiError)) console.warn("[qrcallbox]", err);
    return fail(err);
  }
}

async function profile() {
  const session = await getSession();
  if (!session) throw new ApiError("SIGNED_OUT", "Not signed in.");
  const token = await getIdToken();
  const claims = jwtClaims(token);
  const user = (await fsGet(`users/${session.uid}`)) ?? {};
  return {
    uid:      session.uid,
    email:    session.email,
    name:     [user.firstName, user.lastName].filter(Boolean).join(" "),
    jobTitle: user.jobTitle ?? "",
    store:    user.storeNumber != null ? String(user.storeNumber) : "",
    approved: user.approved === true,
    isAdmin:  claims.admin === true,
  };
}

/** The store a request may look at: admins pick any, everyone else gets their own. */
function storeFor(p, requested) {
  const want = String(requested ?? "").trim();
  if (p.isAdmin && /^\d{1,6}$/.test(want)) return want;
  if (!p.store) throw new ApiError("NO_STORE", "Your QRCallBox account has no store yet. An admin sets it when approving you.");
  return p.store;
}

const eq = (field, value) => ({
  fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: { stringValue: String(value) } },
});

export const handlers = {
  async "get-session"() {
    try {
      return { ok: true, signedIn: true, profile: await profile() };
    } catch (err) {
      if (err?.errorClass === "SIGNED_OUT") return { ok: true, signedIn: false };
      return fail(err);
    }
  },

  async "sign-in"(msg) {
    const email = String(msg?.email ?? "").trim();
    const password = String(msg?.password ?? "");
    if (!email || !password) return { ok: false, errorClass: "LOGIN", error: "Enter your email and password." };
    return wrap(async () => {
      await signIn(email, password);
      return { profile: await profile() };
    });
  },

  async "sign-out"() {
    await signOut();
    return { ok: true };
  },

  async "scans"(msg) {
    return wrap(async () => {
      const p = await profile();
      const store = storeFor(p, msg?.store);
      const days = Math.min(Math.max(Number(msg?.days) || 7, 1), 90);
      const since = new Date(Date.now() - days * DAY_MS).toISOString();
      const docs = await fsQuery({
        from: [{ collectionId: "scans" }],
        where: { compositeFilter: { op: "AND", filters: [
          eq("storeNumber", store),
          { fieldFilter: { field: { fieldPath: "timestamp" }, op: "GREATER_THAN_OR_EQUAL", value: { timestampValue: since } } },
        ] } },
        orderBy: [{ field: { fieldPath: "timestamp" }, direction: "DESCENDING" }],
        limit: MAX_SCANS,
      });
      return { store, days, truncated: docs.length >= MAX_SCANS, rows: docs.map(scanRow).filter((r) => !r.test) };
    });
  },

  async "team"(msg) {
    return wrap(async () => {
      const p = await profile();
      const store = storeFor(p, msg?.store);
      const docs = await fsQuery({ from: [{ collectionId: "users" }], where: eq("storeNumber", store), limit: 500 });
      const people = docs.map((u) => ({
        uid:       u.id,
        name:      [u.firstName, u.lastName].filter(Boolean).join(" ") || "(no name)",
        jobTitle:  u.jobTitle ?? "",
        approved:  u.approved === true,
        onShift:   u.isOnShift === true,
        lastSeen:  u.lastSeen ?? null,
        email:     p.isAdmin ? (u.email ?? "") : "",
      })).sort((a, b) => a.name.localeCompare(b.name));
      return { store, people, canApprove: p.isAdmin };
    });
  },

  async "approve-user"(msg) {
    return wrap(async () => {
      const p = await profile();
      if (!p.isAdmin) throw new ApiError("FORBIDDEN", "Only QRCallBox admins can approve accounts.");
      const uid = String(msg?.uid ?? "");
      const store = String(msg?.store ?? "").trim();
      if (!uid || !/^\d{1,6}$/.test(store)) throw new ApiError("VALIDATION", "Pick a user and a store number.");
      // Same call as UserManagement.jsx's save.
      await callApi("/api/admin/update-user", {
        method: "POST",
        body: { user_id: uid, updates: { approved: true, storeNumber: store } },
      });
      return { uid };
    });
  },

  async "locations"() {
    return wrap(async () => {
      const docs = await fsQuery({
        from: [{ collectionId: "qr_locations" }],
        orderBy: [{ field: { fieldPath: "order" }, direction: "ASCENDING" }],
        limit: 200,
      });
      return { locations: docs.filter((l) => l.active !== false).map((l) => ({ id: l.id, name: l.name })) };
    });
  },

  async "mint-poster"(msg) {
    return wrap(async () => {
      const p = await profile();
      const store = storeFor(p, msg?.store);
      const area = String(msg?.area ?? "").replace(/[<>"'&]/g, "").trim().slice(0, 50);
      const areaDescription = String(msg?.areaDescription ?? "").replace(/[<>"'&]/g, "").trim().slice(0, 100);
      if (!area) throw new ApiError("VALIDATION", "Pick an area.");
      const { token } = await mintPoster({ store, area, areaDescription: areaDescription || null });
      return { store, area, areaDescription: areaDescription || area, url: scanUrl(token) };
    });
  },

  // Your own Workvivo connection (readable by its owner) and, for admins,
  // every connection at the store.
  async "workvivo"(msg) {
    return wrap(async () => {
      const p = await profile();
      const store = storeFor(p, msg?.store);
      const mine = await fsGet(`workvivo_config/${p.uid}`).catch(() => null);
      let connections = null;
      if (p.isAdmin) {
        const body = await callApi("/api/workvivo/admin-overview");
        connections = (body?.connections ?? []).filter((c) => String(c.storeNumber) === store);
      }
      return {
        store,
        mine: mine && {
          status: mine.status ?? null,
          channelName: mine.channelName ?? null,
          lastServerPostAt: mine.lastServerPostAt ?? null,
          lastServerPostOk: mine.lastServerPostOk ?? null,
        },
        connections,
      };
    });
  },

  async "open-site"(msg) {
    const path = String(msg?.path ?? "/");
    await chrome.tabs.create({ url: SITE + (path.startsWith("/") ? path : "/") });
    return { ok: true };
  },
};
