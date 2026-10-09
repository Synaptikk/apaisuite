// modules/doorcatch/lib/api.js
//
// Client for QRCallBox's Door Catches endpoints. Contract mirrored in
// QRCallBox repo: functions/src/http/doorcatch/index.js.
//
//   GET  /api/door/list?store=&from=&to=   X-API-Key: <reviewKey>
//        → { ok, storeNumber, storeName, hosts, timeZone,
//            catches: [{ id, day, host, items: [{ upc, qty, typed }], unitCount,
//                        status, note, reviewer, caughtAt, createdAt, reviewedAt }] }
//   POST /api/door/review  X-API-Key  { store, id, status, note, reviewer }
//   POST /api/door/hosts   X-API-Key  { store, hosts }
//   401 = wrong review key for that store.
//
// The door hosts' page is https://qrcallbox.com/door?s=<store>&k=<submitKey>.

export const ORIGIN = "https://qrcallbox.com";
const TIMEOUT_MS = 20_000;

export function doorLink(storeNbr, submitKey) {
  return `${ORIGIN}/door?s=${encodeURIComponent(storeNbr)}&k=${encodeURIComponent(submitKey)}`;
}

async function call(path, { method = "GET", query, body, reviewKey }) {
  const url = new URL(ORIGIN + path);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: { "X-API-Key": reviewKey || "", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      if (!data.error && res.status !== 401) console.warn(`[doorcatch] ${path} HTTP ${res.status}`);
      const error = res.status === 401 ? "Review key is wrong for this store." : (data.error || "Couldn't reach the door catch service. Try again.");
      return { ok: false, status: res.status, error };
    }
    return data;
  } catch (err) {
    console.warn(`[doorcatch] ${path} failed:`, err?.message || err);
    return { ok: false, status: 0, error: err?.name === "AbortError" ? "The door catch service took too long. Try again." : "Couldn't reach the door catch service. Try again." };
  } finally {
    clearTimeout(timer);
  }
}

export const listCatches = ({ storeNbr, reviewKey, from, to }) =>
  call("/api/door/list", { query: { store: storeNbr, from, to }, reviewKey });

export const setReview = ({ storeNbr, reviewKey, id, status, note, reviewer }) =>
  call("/api/door/review", { method: "POST", body: { store: storeNbr, id, status, note, reviewer }, reviewKey });

export const setHosts = ({ storeNbr, reviewKey, hosts }) =>
  call("/api/door/hosts", { method: "POST", body: { store: storeNbr, hosts }, reviewKey });

// CSV of the catches as listed: one row per item line, so a catch with three
// UPCs is three rows sharing its id, time and host.
export function catchesCsv(catches, timeZone, info = {}) {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const q = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [["catch_id", "caught_at", "door_host", "register", "host_note", "upc", "item", "brand", "walmart_price", "qty", "line_value", "typed_in", "status", "reviewer", "note"]];
  for (const c of catches) {
    for (const it of c.items) {
      const x = info[it.upc] || {};
      rows.push([c.id, c.caughtAt ? fmt.format(c.caughtAt) : c.day, c.host, c.register || "", c.hostNote || "", `="${it.upc}"`, x.name || "", x.brand || "",
        typeof x.walmartPrice === "number" ? x.walmartPrice.toFixed(2) : "", it.qty,
        typeof x.walmartPrice === "number" && !c.withdrawn ? (x.walmartPrice * it.qty).toFixed(2) : "", it.typed ? "yes" : "", c.withdrawn ? "withdrawn" : c.status, c.reviewer, c.note]);
    }
  }
  return rows.map((r) => r.map(q).join(",")).join("\r\n");
}
