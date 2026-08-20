// modules/sparkrisk/service.js
//
// Service worker handlers for SparkRisk
// Converts server.mjs Express routes to chrome.runtime.onMessage handlers

import { db } from "./models/index.js";

const MODULE_ID = "sparkrisk";

// Storage keys
const STORAGE_EXTRACTION_STATE = `${MODULE_ID}.extraction_state`;
const STORAGE_LAST_SYNC = `${MODULE_ID}.last_sync`;
const STORAGE_OMS_HEADERS_KEY = `${MODULE_ID}.omsHeaders`;
const CAPTURE_GLOBAL_NAME = "__APAISUITE_SPARKRISK_CAP";

// ── Helpers ────────────────────────────────────────────────────────

// Statistical helpers
function median(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mad(arr) {
  if (!arr.length) return null;
  const med = median(arr);
  if (med === null) return null;
  const devs = arr.map(x => Math.abs(x - med));
  return median(devs);
}

function calculateDriverBaselines(sessions) {
  // Sort by session start time for chronological processing
  const sorted = [...sessions].sort((a, b) => 
    new Date(a.session_start) - new Date(b.session_start)
  );
  
  const driverHistory = new Map();  // driver_key → [session_spi, ...]
  const baselines = new Map();      // session_id → { count, median, mad }
  
  for (const s of sorted) {
    const driverKey = s.driver_key;
    if (!driverKey) continue;
    
    // Get prior sessions for this driver
    const priorSessions = driverHistory.get(driverKey) || [];
    
    // Calculate baseline from prior sessions
    baselines.set(s.session_id, {
      count: priorSessions.length,
      median: median(priorSessions),
      mad: mad(priorSessions)
    });
    
    // Add this session to driver history for future sessions
    if (!driverHistory.has(driverKey)) {
      driverHistory.set(driverKey, []);
    }
    if (s.session_spi) {
      driverHistory.get(driverKey).push(s.session_spi);
    }
  }
  
  return baselines;
}

function scoreSessions(sessions, context) {
  // Calculate driver baselines first (FIX: use driver_key instead of driver_pseudonym)
  const baselines = calculateDriverBaselines(sessions);
  
  return sessions.map(session => {
    const baseline = baselines.get(session.session_id) || { count: 0, median: null, mad: null };
    
    // Calculate driver deviation (z-score using MAD)
    let driverDeviation = null;
    if (baseline.count >= 3 && baseline.median !== null && baseline.mad !== null && baseline.mad > 0) {
      driverDeviation = (session.session_spi - baseline.median) / (baseline.mad * 1.4826);
    } else if (baseline.count >= 3 && baseline.median !== null && baseline.median > 0) {
      driverDeviation = ((session.session_spi - baseline.median) / baseline.median) * 3;
    }
    
    // Calculate expected duration and excess
    const baseSpi = 60;  // Default base SPI (60 sec/item)
    const expectedMs = baseSpi * (session.combined_items || 0) * 1000;
    const excessMs = (session.session_duration_ms || 0) - expectedMs;
    const excessMinutes = excessMs / 60000;
    
    // Calculate priority score
    const baseScore = calculateBaseScore({
      ...session,
      excess_minutes: excessMinutes,
      driver_deviation: driverDeviation
    });
    const contextScore = applyContextAdjustments(baseScore, session, context);
    
    // Determine confidence
    let confidence = 'low';
    if (baseline.count >= 10) {
      confidence = 'high';
    } else if (baseline.count >= 3) {
      confidence = 'medium';
    }
    
    return { 
      ...session, 
      driver_prior_count: baseline.count,
      driver_prior_median_spi: baseline.median ? Math.round(baseline.median * 10) / 10 : null,
      driver_deviation: driverDeviation ? Math.round(driverDeviation * 100) / 100 : null,
      expected_duration_ms: Math.round(expectedMs),
      excess_minutes: Math.round(excessMinutes * 10) / 10,
      priority_score: contextScore,
      confidence
    };
  });
}

function calculateBaseScore(session) {
  // Priority score = excess time + driver deviation + peer percentile
  const excessWeight = 0.4;
  const deviationWeight = 0.3;
  const peerWeight = 0.3;
  
  const excessScore = Math.min((session.excess_minutes || 0) * 2, 100);
  const deviationScore = Math.min((session.driver_deviation || 0) * 5, 100);
  const peerScore = session.peer_percentile || 0;
  
  return (excessScore * excessWeight) + 
         (deviationScore * deviationWeight) + 
         (peerScore * peerWeight);
}

function applyContextAdjustments(score, session, context) {
  // Adjust for congestion, peak hours, etc.
  let adjusted = score;
  
  if (session.is_peak_1to4) adjusted *= 0.9;  // Less suspicious during peak
  if (session.is_weekend) adjusted *= 0.95;    // Slightly less suspicious on weekends
  if (session.order_count > 3) adjusted *= 1.1; // More suspicious for large batches
  
  return Math.min(adjusted, 100);
}

async function buildSessionsFromOrders(orders) {
  // Group orders by trip_id and driver
  const tripMap = new Map();
  
  for (const order of orders) {
    const tripKey = order.trip_id || `${order.driver_id}_${order.extraction_date}`;
    if (!tripMap.has(tripKey)) {
      tripMap.set(tripKey, []);
    }
    tripMap.get(tripKey).push(order);
  }
  
  // Build sessions
  const sessions = [];
  for (const [tripKey, tripOrders] of tripMap) {
    const session = buildSessionFromOrders(tripOrders);
    if (session) sessions.push(session);
  }
  
  return sessions;
}

function buildSessionFromOrders(orders) {
  if (!orders.length) return null;
  
  const firstOrder = orders[0];
  const pickTimes = orders.map(o => new Date(o.pick_started_time)).filter(t => !isNaN(t));
  const dispatchTimes = orders.map(o => new Date(o.dispatched_time)).filter(t => !isNaN(t));
  
  if (!pickTimes.length || !dispatchTimes.length) return null;
  
  const sessionStart = new Date(Math.min(...pickTimes));
  const sessionEnd = new Date(Math.max(...dispatchTimes));
  const durationMs = sessionEnd - sessionStart;
  
  const totalItems = orders.reduce((sum, o) => sum + (o.total_order_qty || 0), 0);
  const spi = totalItems > 0 ? durationMs / 1000 / totalItems : null;
  
  // Calculate register time (last PICKED → DISPATCHED)
  const registerTimeMs = orders.reduce((max, o) => {
    if (o.picked_time && o.dispatched_time) {
      const rt = new Date(o.dispatched_time) - new Date(o.picked_time);
      return Math.max(max, rt);
    }
    return max;
  }, 0);
  
  // Create driver_key with proper fallback chain (FIX: driver grouping bug)
  const driverKey = firstOrder.driver_pseudonym || 
                     firstOrder.driver_uuid || 
                     firstOrder.driver_id || 
                     `${firstOrder.driver_first_name || ''} ${firstOrder.driver_last_name || ''}`.trim() || 
                     'unknown';
  
  return {
    session_id: crypto.randomUUID(),
    trip_id: firstOrder.trip_id,
    driver_id: firstOrder.driver_id,
    driver_uuid: firstOrder.driver_uuid,
    driver_key: driverKey,  // NEW: unified driver identifier
    driver_name: `${firstOrder.driver_first_name || ''} ${firstOrder.driver_last_name || ''}`.trim(),
    order_ids: JSON.stringify(orders.map(o => o.order_id)),
    order_count: orders.length,
    combined_items: totalItems,
    extraction_date: firstOrder.extraction_date,
    session_start: sessionStart.toISOString(),
    session_duration_ms: durationMs,
    session_spi: spi,
    register_time_ms: registerTimeMs,
    exited_store_time: sessionEnd.toISOString(),
    has_cancelled: orders.some(o => o.status === 'CANCELLED'),
    // Placeholders for scoring
    driver_prior_count: null,  // Will be filled by scoring
    driver_prior_median_spi: null,
    driver_deviation: null,
    excess_minutes: null,
    expected_duration_ms: null,
    priority_score: 0,
    confidence: 'low'
  };
}

// ── Message Handlers ────────────────────────────────────────────────

const handlers = {};

// GET /api/stats
handlers.getStats = async (message) => {
  try {
    const sessions = await db.getAll("sessions");
    const reviews = await db.getAll("session_reviews");
    
    const totalSessions = sessions.length;
    const highPri = sessions.filter(s => s.priority_score >= 75).length;
    const cleared = reviews.filter(r => r.status === "cleared").length;
    const confirmed = reviews.filter(r => r.status === "confirmed").length;
    
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
      eligible: totalSessions,
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
    
    let sessions = await db.getAll("sessions");
    
    // Filters
    sessions = sessions.filter(s => {
      if (s.priority_score < minScore || s.priority_score > maxScore) return false;
      if (date && s.extraction_date !== date) return false;
      return true;
    });
    
    // Join with reviews
    const reviews = await db.getAll("session_reviews");
    const reviewMap = new Map(reviews.map(r => [r.session_id, r]));
    
    // Calculate driver stats (total sessions and orders per driver)
    const allSessions = await db.getAll("sessions");
    const driverStats = new Map();
    
    for (const s of allSessions) {
      const driverKey = s.driver_key;  // FIX: use driver_key instead of fallback
      if (!driverKey) continue;
      
      if (!driverStats.has(driverKey)) {
        driverStats.set(driverKey, {
          total_sessions: 0,
          total_orders: 0,
          first_seen: s.extraction_date,
          last_seen: s.extraction_date
        });
      }
      
      const stats = driverStats.get(driverKey);
      stats.total_sessions++;
      stats.total_orders += (s.order_count || 0);
      
      if (s.extraction_date < stats.first_seen) stats.first_seen = s.extraction_date;
      if (s.extraction_date > stats.last_seen) stats.last_seen = s.extraction_date;
    }
    
    const rows = sessions.map(s => {
      const review = reviewMap.get(s.session_id);
      const driverKey = s.driver_key;  // FIX: use driver_key
      const dStats = driverStats.get(driverKey) || { total_sessions: 1, total_orders: s.order_count || 0, first_seen: s.extraction_date, last_seen: s.extraction_date };
      
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
    filteredRows.sort((a, b) => {
      const aVal = a[sort] ?? 0;
      const bVal = b[sort] ?? 0;
      return dir === 'DESC' ? bVal - aVal : aVal - bVal;
    });
    
    // Paginate
    const paginatedRows = filteredRows.slice(offset, offset + limit);
    
    return {
      ok: true,
      rows: paginatedRows,
      total: filteredRows.length,
      limit,
      offset,
      modelVersion: "v2"
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
    
    const review = await db.getAll("session_reviews", "session_id", sessionId);
    const orderIds = JSON.parse(session.order_ids || "[]");
    
    // Get orders
    const allOrders = await db.getAll("orders");
    const orders = allOrders.filter(o => orderIds.includes(o.order_id));
    
    // Get driver session history (prior only)
    const allSessions = await db.getAll("sessions");
    const driverSessions = allSessions.filter(s =>
      s.driver_key === session.driver_key &&  // FIX: use driver_key
      new Date(s.session_start) < new Date(session.session_start)
    );
    driverSessions.sort((a, b) => new Date(b.session_start) - new Date(a.session_start));
    
    // Calculate driver totals (all time, not just prior)
    const driverAllSessions = allSessions.filter(s => s.driver_key === session.driver_key);  // FIX: use driver_key
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
      review: review[0] || null,
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
    
    // Audit log (would store in IndexedDB in production)
    console.log("[SparkRisk] Identity resolution:", {
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
    const { reviewId, status, reviewer, notes } = message;
    
    const reviews = await db.getAll("session_reviews");
    const review = reviews.find(r => r.id === reviewId);
    
    if (!review) {
      return { ok: false, error: "Review not found" };
    }
    
    const updated = {
      ...review,
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
    
    // Store orders
    await db.putMany("orders", rawOrders);
    
    // Build sessions
    const sessions = await buildSessionsFromOrders(rawOrders);
    
    // Score sessions (simplified for now)
    const scoredSessions = scoreSessions(sessions, {});
    
    // Store sessions
    await db.putMany("sessions", scoredSessions);
    
    // Create reviews for high-priority sessions
    const reviews = scoredSessions
      .filter(s => s.priority_score >= 45)
      .map(s => ({
        id: crypto.randomUUID(),
        session_id: s.session_id,
        status: "new",
        priority: s.priority_score >= 75 ? 1 : s.priority_score >= 60 ? 2 : 3,
        reviewer: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        notes: "",
        history: "[]"
      }));
    
    await db.putMany("session_reviews", reviews);
    
    return {
      ok: true,
      ingested: rawOrders.length,
      sessions: sessions.length,
      reviews: reviews.length
    };
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
export { handlers };
