// modules/digitallocks/lib/fetchAllUsersFromPage.js
//
// Two self-contained functions serialized into the InVue /app/users tab via
// chrome.scripting.executeScript (world: MAIN). Must NOT reference any
// module-scope variables or imports — everything must be declared inside
// the function body.

// Fetch all users from the InVue API (same-origin, paginated).
// Returns an array of raw user objects from /appv1/users.
export async function fetchAllUsersFromPage() {
  const BASE     = window.location.origin;
  const USER_URL = BASE + "/appv1/users";
  const CNT_URL  = BASE + "/appv1/users/reports/count";
  const HDRS     = { "Content-Type": "application/json", Accept: "application/json" };

  async function apiFetch(url, bodyObj) {
    const r = await fetch(url, { method: "POST", headers: HDRS, body: JSON.stringify(bodyObj) });
    if (!r.ok) throw new Error(`InVue API ${url}: HTTP ${r.status}`);
    return r.json();
  }

  const countData = await apiFetch(CNT_URL, {
    method: "get", endpoint: "users/reports/count", body: null, params: {},
  });
  const total = parseInt(countData.count, 10) || 0;
  if (total === 0) return [];

  const PAGE = 100;
  const all  = [];
  for (let offset = 0; offset < total; offset += PAGE) {
    const page = await apiFetch(USER_URL, {
      method: "get", endpoint: "users", body: null,
      params: { offset, count: PAGE, q: "" },
    });
    all.push(...page);
    if (page.length < PAGE) break;
  }
  return all;
}

// Delete a single InVue user by their InVue internal ID.
// Must be injected into the InVue tab (same-origin DELETE).
export async function deleteUserFromPage(invueUserId) {
  const r = await fetch(`${window.location.origin}/appv1/users/${invueUserId}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`InVue delete failed: HTTP ${r.status}`);
  return true;
}
