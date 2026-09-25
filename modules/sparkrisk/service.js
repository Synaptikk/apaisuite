// modules/sparkrisk/service.js
//
// Service worker handlers for SparkRisk
// Converts server.mjs Express routes to chrome.runtime.onMessage handlers

import { db } from "./models/index.js";
import { rebuild, orderKey } from "./lib/rebuild.js";

const MODULE_ID = "sparkrisk";

// Storage keys
const STORAGE_EXTRACTION_STATE = `${MODULE_ID}.extraction_state`;
const STORAGE_LAST_SYNC = `${MODULE_ID}.last_sync`;
const STORAGE_OMS_HEADERS_KEY = `${MODULE_ID}.omsHeaders`;
const CAPTURE_GLOBAL_NAME = "__APAISUITE_SPARKRISK_CAP";

// Bumped from v3 when the unsupported context multipliers were removed from
// lib/sessions.js - scores produced before that change are not comparable.
const MODEL_VERSION = "v3.1-timing-review";
const REVIEW_STATUSES = ["new", "in_review", "cleared", "confirmed", "monitoring", "inconclusive", "escalated"];

// ── Helpers ────────────────────────────────────────────────────────

// ── Message Handlers ────────────────────────────────────────────────

const handlers = {};

// GET /api/stats
handlers.getStats = async (message) => {
  try {
    const sessions = await db.getAll("sessions");
    const reviews = await db.getAll("session_reviews");
    const orders = await db.getAll("orders");

    const totalSessions = sessions.length;
    // Orders retained but not part of any scoreable trip (cancelled, reversed,
    // zero-quantity, or missing/inverted timestamps). They stay in the DB as
    // lineage; they are simply not scored.
    const sessionOrderIds = new Set(sessions.flatMap(x => {
      try { return JSON.parse(x.order_ids || "[]").map(id => JSON.stringify([x.store, String(id)])); }
      catch { return []; }
    }));
    const ineligibleOrders = orders.filter(o => !sessionOrderIds.has(orderKey(o))).length;
    const highPri = sessions.filter(s => s.priority_score >= 75).length;
    const cleared = reviews.filter(r => !r.archived && r.status === "cleared").length;
    const confirmed = reviews.filter(r => !r.archived && r.status === "confirmed").length;
    
    // Calculate daily volumes
    const dateMap = new Map();
    for (const session of sessions) {
      const date = session.extraction_date;
      if (!dateMap.has(date)) {
        dateMap.set(date, { sessions: 0, total_excess: 0 });
      }
      const d = dateMap.get(date);
      d.sessions++;
      if (session.excess_minutes) d.total_excess += session.excess_minutes;
    }
    
    const daily = Array.from(dateMap.entries())
      .map(([date, data]) => ({
        extraction_date: date,
        sessions: data.sessions,
        avg_excess: data.sessions > 0 ? data.total_excess / data.sessions : 0
      }))
      .sort((a, b) => a.extraction_date.localeCompare(b.extraction_date));
    
    // Excess distribution
    const excessBuckets = new Array(21).fill(0);
    for (const session of sessions) {
      if (session.excess_minutes != null) {
        const bucket = Math.floor((session.excess_minutes + 20) / 2);
        const idx = Math.max(0, Math.min(20, bucket));
        excessBuckets[idx]++;
      }
    }
    
    return {
      ok: true,
      total: totalSessions,
      storedOrders: orders.length,
      ineligibleOrders,
      stores: [...new Set(sessions.map(x => x.store).filter(Boolean))].sort(),
      highPri,
      cleared,
      confirmed,
      daily,
      excess: excessBuckets
    };
  } catch (error) {
    console.error("[SparkRisk] getStats error:", error);
    return { ok: false, error: error.message };
  }
};

// GET /api/queue
handlers.getQueue = async (message) => {
  try {
    const { limit = 50, offset = 0, minScore = 0, maxScore = 100, status = '', date = '', sort = 'priority_score', dir = 'DESC' } = message;
    
    const allSessions = await db.getAll("sessions");

    // Filters
    const sessions = allSessions.filter(s => {
      if (s.priority_score < minScore || s.priority_score > maxScore) return false;
      if (date && s.extraction_date !== date) return false;
      return true;
    });

    // Join with reviews. Archived legacy reviews are excluded: they belong to
    // sessions that no longer exist and must never decorate a live row.
    const reviews = await db.getAll("session_reviews");
    const reviewMap = new Map(reviews.filter(r => !r.archived).map(r => [r.session_id, r]));

    // Driver stats are scoped by store, matching the baseline scope in
    // lib/sessions.js. The same driver at two stores is two histories.
    const driverStats = new Map();
    const driverScope = s => JSON.stringify([s.store || "", s.driver_key]);

    for (const s of allSessions) {
      const driverKey = s.driver_key;  // FIX: use driver_key instead of fallback
      if (!driverKey) continue;

      if (!driverStats.has(driverScope(s))) {
        driverStats.set(driverScope(s), {
          total_sessions: 0,
          total_orders: 0,
          first_seen: s.extraction_date,
          last_seen: s.extraction_date
        });
      }
      
      const stats = driverStats.get(driverScope(s));
      stats.total_sessions++;
      stats.total_orders += (s.order_count || 0);
      
      if (s.extraction_date < stats.first_seen) stats.first_seen = s.extraction_date;
      if (s.extraction_date > stats.last_seen) stats.last_seen = s.extraction_date;
    }
    
    const rows = sessions.map(s => {
      const review = reviewMap.get(s.session_id);
      const dStats = driverStats.get(driverScope(s)) || { total_sessions: 1, total_orders: s.order_count || 0, first_seen: s.extraction_date, last_seen: s.extraction_date };
      
      return {
        ...s,
        review_id: review?.id,
        review_status: review?.status || 'new',
        priority: review?.priority || 3,
        driver_total_sessions: dStats.total_sessions,
        driver_total_orders: dStats.total_orders,
        driver_first_seen: dStats.first_seen,
        driver_last_seen: dStats.last_seen
      };
    });
    
    // Filter by review status
    const filteredRows = status ? rows.filter(r => r.review_status === status) : rows;
    
    // Sort
    // extraction_date sorts as a string; priority_score / excess_minutes as
    // numbers. Subtracting strings yielded NaN and silently disabled sorting.
    filteredRows.sort((a, b) => {
      const aVal = a[sort], bVal = b[sort];
      const cmp = (typeof aVal === "string" || typeof bVal === "string")
        ? String(aVal ?? "").localeCompare(String(bVal ?? ""))
        : (aVal ?? 0) - (bVal ?? 0);
      return dir === 'DESC' ? -cmp : cmp;
    });
    
    // Paginate
    const paginatedRows = filteredRows.slice(offset, offset + limit);
    
    return {
      ok: true,
      rows: paginatedRows,
      total: filteredRows.length,
      limit,
      offset,
      modelVersion: MODEL_VERSION
    };
  } catch (error) {
    console.error("[SparkRisk] getQueue error:", error);
    return { ok: false, error: error.message };
  }
};

// GET /api/session/:id
handlers.getSession = async (message) => {
  try {
    const { sessionId } = message;
    
    const session = await db.get("sessions", sessionId);
    if (!session) {
      return { ok: false, error: "Session not found" };
    }
    
    const review = (await db.getAll("session_reviews", "session_id", sessionId)).find(r => !r.archived) || null;
    const orderIds = JSON.parse(session.order_ids || "[]").map(String);

    // Orders are keyed by (store, order_id). Matching on order_id alone would
    // pull another store's order with a colliding number into this trip.
    const wanted = new Set(orderIds.map(id => JSON.stringify([session.store || "", id])));
    const allOrders = await db.getAll("orders");
    const orders = allOrders.filter(o => wanted.has(orderKey(o)));

    // Driver history is scoped to (store, driver), matching the baseline scope
    // in lib/sessions.js.
    const allSessions = await db.getAll("sessions");
    const sameDriver = s => s.driver_key === session.driver_key && (s.store || "") === (session.store || "");
    const driverSessions = allSessions.filter(s =>
      sameDriver(s) &&
      new Date(s.session_start) < new Date(session.session_start)
    );
    driverSessions.sort((a, b) => new Date(b.session_start) - new Date(a.session_start));

    // Calculate driver totals (all time, not just prior)
    const driverAllSessions = allSessions.filter(sameDriver);
    const driverTotalSessions = driverAllSessions.length;
    const driverTotalOrders = driverAllSessions.reduce((sum, s) => sum + (s.order_count || 0), 0);
    const driverFirstSeen = driverAllSessions.reduce((min, s) => 
      s.extraction_date < min ? s.extraction_date : min, 
      session.extraction_date
    );
    const driverLastSeen = driverAllSessions.reduce((max, s) => 
      s.extraction_date > max ? s.extraction_date : max, 
      session.extraction_date
    );
    
    return {
      ok: true,
      session,
      review,
      orders,
      driverSessions: driverSessions.slice(0, 20),
      driverStats: {
        total_sessions: driverTotalSessions,
        total_orders: driverTotalOrders,
        first_seen: driverFirstSeen,
        last_seen: driverLastSeen
      }
    };
  } catch (error) {
    console.error("[SparkRisk] getSession error:", error);
    return { ok: false, error: error.message };
  }
};

// GET /api/session/:id/resolve
handlers.resolveIdentity = async (message) => {
  try {
    const { sessionId } = message;
    
    const session = await db.get("sessions", sessionId);
    if (!session) {
      return { ok: false, error: "Session not found" };
    }
    
    const orderIds = JSON.parse(session.order_ids || "[]");
    
    // NOT an audit log. This line goes to the SW console and is lost when the
    // worker sleeps. The help text says so; do not describe this as audited
    // access until it writes to a durable store.
    console.log("[SparkRisk] Identity resolution (not persisted):", {
      session_id: sessionId,
      order_ids: orderIds,
      timestamp: new Date().toISOString()
    });
    
    return {
      ok: true,
      session_id: sessionId,
      real_order_ids: orderIds,
      driver_identity: session.driver_name || session.driver_id || "[Not available]",
      driver_id: session.driver_id,
      trip_id: session.trip_id,
      resolved_at: new Date().toISOString(),
      resolved_by: "apaisuite_user"
    };
  } catch (error) {
    console.error("[SparkRisk] resolveIdentity error:", error);
    return { ok: false, error: error.message };
  }
};

// PATCH /api/review/:id
handlers.updateReview = async (message) => {
  try {
    const { reviewId, sessionId, status, reviewer, notes } = message;
    
    if (status && !REVIEW_STATUSES.includes(status)) return { ok: false, error: "Invalid review status" };

    const reviews = (await db.getAll("session_reviews")).filter(r => !r.archived);
    const session = sessionId ? await db.get("sessions", sessionId) : null;
    let review = reviewId ? reviews.find(r => r.id === reviewId) : null;
    if (!review && sessionId) review = reviews.find(r => r.session_id === sessionId);
    // A session with no review row yet is still reviewable - create one.
    if (!review && session) review = { id: `review:${sessionId}`, session_id: sessionId, status: "new", notes: "", created_at: new Date().toISOString() };

    if (!review) {
      return { ok: false, error: sessionId ? "Session not found" : "Review not found" };
    }

    const updated = {
      ...review,
      archived: false,
      status: status || review.status,
      reviewer: reviewer || review.reviewer,
      notes: notes !== undefined ? notes : review.notes,
      updated_at: new Date().toISOString()
    };
    
    await db.put("session_reviews", updated);
    
    return { ok: true, review: updated };
  } catch (error) {
    console.error("[SparkRisk] updateReview error:", error);
    return { ok: false, error: error.message };
  }
};

// POST /api/ingest - Ingest WISMO data
handlers.ingestData = async (message) => {
  try {
    const { orders: rawOrders } = message;
    
    if (!rawOrders || !rawOrders.length) {
      return { ok: false, error: "No orders provided" };
    }
    
    const [orders, sessions, reviews] = await Promise.all(['orders', 'sessions', 'session_reviews'].map(name => db.getAll(name)));
    const result = await rebuild(orders, rawOrders, sessions, reviews);
    await db.replaceAnalysis(result);
    return { ok: true, ingested: rawOrders.length, sessions: result.sessions.length, reviews: result.reviews.filter(r => !r.archived).length, rejected: result.rejected, ineligibleOrders: result.ineligibleOrders };

  } catch (error) {
    console.error("[SparkRisk] ingestData error:", error);
    return { ok: false, error: error.message };
  }
};

// Helper functions for OMS item fetching
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForTabUrl(tabId, urlPattern, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const check = async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.url && tab.url.includes(urlPattern)) {
          resolve(tab);
        } else if (Date.now() - startTime > timeoutMs) {
          reject(new Error(`Tab URL did not match ${urlPattern} within ${timeoutMs}ms`));
        } else {
          setTimeout(check, 500);
        }
      } catch (error) {
        reject(error);
      }
    };
    check();
  });
}

async function injectAndRetry(tabId, fn, args, maxAttempts = 10, delayMs = 1500) {
  let lastResult = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: "MAIN",
        args,
        func: fn,
      });
      const hit = results.find(r => r.result && r.result.ok);
      if (hit) return hit.result;
      lastResult = results;
    } catch (e) {
      lastResult = String(e);
    }
    await sleep(delayMs);
  }
  return { ok: false, error: "exhausted retries", lastResult };
}

// Fetch order items from OMS API (similar to SparkFraud)
handlers.fetchOrderItems = async (message) => {
  let helperTab = null;
  try {
    const { orderIds } = message;
    if (!orderIds || !orderIds.length) {
      return { ok: false, error: "No order IDs provided" };
    }
    
    const targetUrl = "https://gscope.walmartlabs.com/mfe/ordermanagement/orderresolution";
    
    // FAST PATH: Try cached headers first
    const cached = (await chrome.storage.session.get(STORAGE_OMS_HEADERS_KEY))[STORAGE_OMS_HEADERS_KEY];
    if (cached) {
      const gscopeTabs = await chrome.tabs.query({ url: "https://gscope.walmartlabs.com/*" });
      if (gscopeTabs.length) {
        try {
          const url = "https://gscope.walmartlabs.com/api/gateway/provider-oms/orders" +
                      `?limit=200&offset=0&orderNo=${encodeURIComponent(orderIds.join(","))}`;
          const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId: gscopeTabs[0].id },
            args: [url, cached],
            func: async (url, headers) => {
              try {
                const r = await fetch(url, {
                  method: "GET",
                  headers,
                  credentials: "include"
                });
                return { ok: r.ok, status: r.status, text: await r.text() };
              } catch (e) {
                return { ok: false, status: 0, error: String(e) };
              }
            }
          });
          
          if (result?.ok && result.status === 200) {
            let data = null;
            try { data = JSON.parse(result.text); } catch (_) {}
            
            // Group items by order
            const itemsByOrder = {};
            if (data?.payload) {
              for (const row of data.payload) {
                const oid = row.orderNo;
                if (!itemsByOrder[oid]) itemsByOrder[oid] = [];
                itemsByOrder[oid].push({
                  itemId: row.itemId,
                  itemName: row.itemName,
                  upc: row.upc,
                  quantity: row.quantity,
                  unitPrice: row.unitPrice,
                  lineStatus: row.lineStatus
                });
              }
            }
            
            return { ok: true, itemsByOrder, via: "fast-cache" };
          }
          
          // Stale headers, clear cache
          await chrome.storage.session.remove(STORAGE_OMS_HEADERS_KEY);
        } catch (_) {
          // Fall through to slow path
        }
      }
    }
    
    // SLOW PATH: Drive UI to capture headers
    helperTab = await chrome.tabs.create({ url: targetUrl, active: false });
    await waitForTabUrl(helperTab.id, "/orderresolution", 30000);
    await sleep(5000);
    
    const result = await injectAndRetry(
      helperTab.id,
      async (orderIds, captureGlobalName) => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const startTs = Date.now();
        
        // Find input field
        const input = document.querySelector('input[name="orderNo"]');
        if (!input) return { ok: false, skipped: true };
        
        // Set value and trigger events
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(input, orderIds.join(","));
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        
        await sleep(300);
        
        // Click "View Details" button
        const buttons = Array.from(document.querySelectorAll("button"));
        const viewBtn = buttons.find(b => /view\s*details/i.test(b.textContent || ""));
        if (!viewBtn) return { ok: false, error: "VIEW DETAILS button not found" };
        viewBtn.click();
        
        // Wait for capture
        const cap = window[captureGlobalName] || [];
        for (let i = 0; i < 60; i++) {
          await sleep(500);
          const hit = cap.find(e =>
            e.url.includes("/provider-oms/orders") &&
            e.ts >= startTs &&
            e.responseText !== undefined
          );
          if (hit) {
            return {
              ok: true,
              status: 200,
              text: hit.responseText,
              url: hit.url,
              capturedHeaders: hit.headers
            };
          }
        }
        
        return { ok: false, error: "Timed out waiting for response" };
      },
      [orderIds, CAPTURE_GLOBAL_NAME],
      5,
      2000
    );
    
    if (!result.ok) {
      return { ok: false, error: result.error || "Failed to fetch items" };
    }
    
    // Cache headers for next time
    if (result.capturedHeaders) {
      const clean = {};
      const skip = new Set(["host", "content-length", "cookie", "user-agent",
                             ":authority", ":method", ":path", ":scheme", "origin",
                             "referer", "accept-encoding", "connection"]);
      for (const k of Object.keys(result.capturedHeaders)) {
        if (!skip.has(k.toLowerCase())) {
          clean[k] = result.capturedHeaders[k];
        }
      }
      await chrome.storage.session.set({ [STORAGE_OMS_HEADERS_KEY]: clean });
    }
    
    // Parse response and group items by order
    let data = null;
    try { data = JSON.parse(result.text); } catch (_) {}
    
    const itemsByOrder = {};
    if (data?.payload) {
      for (const row of data.payload) {
        const oid = row.orderNo;
        if (!itemsByOrder[oid]) itemsByOrder[oid] = [];
        itemsByOrder[oid].push({
          itemId: row.itemId,
          itemName: row.itemName,
          upc: row.upc,
          quantity: row.quantity,
          unitPrice: row.unitPrice,
          lineStatus: row.lineStatus
        });
      }
    }
    
    return { ok: true, itemsByOrder, via: "slow-drive" };
    
  } catch (error) {
    console.error("[SparkRisk] fetchOrderItems error:", error);
    return { ok: false, error: error.message };
  } finally {
    if (helperTab) {
      try { await chrome.tabs.remove(helperTab.id); } catch (_) {}
    }
  }
};

// Export handlers (named export required for APAI Suite)
// Serialize reads with rebuilds and reviews so concurrent imports cannot lose work.
let analysisQueue = Promise.resolve();

// First-access migration: rebuild whatever is already in the DB so that
// sessions, ids and baselines match the current model before anything is read.
// `deferred` is an in-process latch for the one case we refuse to migrate,
// so we do not re-read all three stores on every single handler call.
let foundationState = null;   // null | "done" | "deferred"
async function ensureFoundation() {
  if (foundationState === "done" || foundationState === "deferred") return;
  if (await db.get('backups', 'foundation-v3-ready')) { foundationState = "done"; return; }
  const [orders, sessions, reviews] = await Promise.all(['orders', 'sessions', 'session_reviews'].map(name => db.getAll(name)));
  // A DB holding sessions but no orders cannot be rebuilt - the orders are the
  // only lineage there is. Rebuilding would silently delete the analyst's
  // existing queue and archive every review, so leave it alone. The next
  // successful import supplies orders and takes over from there.
  if (!orders.length && sessions.length) {
    console.warn("[SparkRisk] Legacy sessions present with no stored orders; skipping migration. Import order data to rebuild.");
    foundationState = "deferred";
    return;
  }
  await db.replaceAnalysis(await rebuild(orders, [], sessions, reviews));
  foundationState = "done";
}
for (const name of ['getStats', 'getQueue', 'getSession', 'resolveIdentity', 'updateReview', 'ingestData']) {
  const handler = handlers[name];
  handlers[name] = (message) => {
    const job = analysisQueue.then(async () => { await ensureFoundation(); return handler(message); });
    analysisQueue = job.catch(() => {});
    return job;
  };
}
export { handlers };
