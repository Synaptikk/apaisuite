# SparkRisk Module

**Pre-checkout timing analysis for Spark Shop & Deliver fraud detection**

---

## Overview

SparkRisk identifies high-risk Spark driver sessions using order-level timing anomalies, driver deviation from personal baselines, and context-matched peer comparisons.

**Status**: ✅ **Core module structure complete** | ⚠️ **WISMO integration pending**

**Version**: 2.0.0  
**Author**: ses008s (Shane)  
**Created**: 2026-07-20

---

## Features

### ✅ Implemented
- **Multi-factor risk scoring** (excess time + driver deviation + peer percentile)
- **Context adjustments** (congestion, peak hours, batch size)
- **Driver baselines** (personal timing history with strict lookback)
- **Review workflow** (new → cleared/confirmed/escalated)
- **IndexedDB storage** (sessions, orders, reviews, items)
- **Session detail panel** with register timestamp for camera review
- **Real order ID resolution** with audit logging

### ⚠️ Partial / Pending
- **WISMO data extraction** (structure ready, CDP integration needed)
- **Item fetching** (endpoint stubbed, needs implementation)
- **Charts** (placeholders for Chart.js integration)
- **Studies module** (validation framework)

### ❌ Not Yet Implemented
- **Background sync** (periodic re-extraction)
- **Watchlist** (real-time driver monitoring like sparkfraud)
- **CSV export** (for analysts)

---

## Module Structure

```
modules/sparkrisk/
├── module.js                  ← Registration & metadata
├── service.js                 ← Background message handlers
├── view.html                  ← UI template
├── view.js                    ← Frontend logic
├── styles.css                 ← Module styles
├── models/
│   └── index.js              ← IndexedDB wrapper
├── registries/
│   └── endpoints.json        ← WISMO API config
└── README.md                 ← This file
```

---

## Data Model

### Sessions
Primary entity for review. Built by grouping orders by trip/driver.

```javascript
{
  session_id: string,           // UUID
  trip_id: string,              // WISMO trip ID
  driver_id: string,            // Driver email
  driver_name: string,          // "FirstName LastName"
  order_ids: string,            // JSON array of real order IDs
  order_count: number,
  combined_items: number,
  extraction_date: string,      // "YYYY-MM-DD"
  session_start: string,        // ISO timestamp (earliest PICK_STARTED)
  session_duration_ms: number,  // PICK_STARTED → DISPATCHED
  session_spi: number,          // Seconds per item
  register_time_ms: number,     // PICKED → DISPATCHED (last order)
  exited_store_time: string,    // ISO timestamp (for camera review)
  has_cancelled: boolean,
  excess_minutes: number,       // Actual - expected
  expected_duration_ms: number,
  priority_score: number,       // 0-100 (calculated)
  confidence: string            // "low" | "medium" | "high"
}
```

### Orders
Raw WISMO order records.

```javascript
{
  id: number,                   // Auto-increment
  order_id: string,             // Real order number
  driver_id: string,
  trip_id: string,
  extraction_date: string,
  pick_started_time: string,
  picked_time: string,
  dispatched_time: string,
  total_order_qty: number,
  status: string,               // "COMPLETE" | "CANCELLED"
  // ... additional fields from WISMO
}
```

### Reviews
Investigation status tracking.

```javascript
{
  id: string,                   // UUID
  session_id: string,
  status: string,               // "new" | "in_review" | "cleared" | "confirmed" | "escalated"
  priority: number,             // 1-3 (1 = highest)
  reviewer: string,
  created_at: string,
  updated_at: string,
  notes: string,
  history: string               // JSON array of status changes
}
```

### Items (cached)
Fetched from WISMO on demand.

```javascript
{
  order_id: string,
  item_id: string,
  name: string,
  upc: string,
  quantity: number,
  price: number,
  image_url: string,
  status: string                // "PICKED" | "CANCELLED"
}
```

---

## Scoring Algorithm

**Priority Score = weighted sum of 3 factors:**

1. **Excess Time** (40% weight)
   - Actual duration vs expected for basket  Expected baseline from cohort median (matched by item count ±3)

2. **Driver Deviation** (30% weight)
   - How much this session deviates from driver's personal median
   - Only uses **prior sessions** (strict lookback to prevent leakage)

3. **Peer Percentile** (30% weight)
   - Ranking among context-matched peers
   - Context: congestion, peak hours, weekend, batch size

**Context Adjustments:**
- **Congestion factor** (1.0 - 1.3x) based on overlapping sessions
- **Peak hours** (1-4 PM) → ×1.15
- **Weekend** → ×1.10
- **Batch overhead** → +30s per additional order

**Score Thresholds:**
- **≥75** = High priority (definite review)
- **≥60** = Medium priority
- **≥45** = Low priority (borderline)
- **<45** = Not flagged

---

## Message Handlers

SparkRisk uses `chrome.runtime.sendMessage()` with this pattern:

```javascript
// Frontend (view.js)
const result = await send("getQueue", { limit: 50, offset: 0 });

// Background (service.js)
handlers.getQueue = async (message) => { ... }
```

### Available Handlers

| Handler | Parameters | Returns |
|---------|-----------|---------|
| **getStats** | — | Dashboard KPIs, daily volumes, excess distribution |
| **getQueue** | `{ limit, offset, minScore, maxScore, status, sort, dir }` | Paginated sessions with reviews |
| **getSession** | `{ sessionId }` | Session detail + orders + driver history |
| **resolveIdentity** | `{ sessionId }` | Real order IDs (audit-logged) |
| **updateReview** | `{ reviewId, status, reviewer, notes }` | Updated review |
| **ingestData** | `{ orders }` | Builds sessions, scores them, creates reviews |

---

## WISMO Integration (TODO)

The module **needs** WISMO data extraction via Chrome DevTools Protocol.

### Approach (from sparkfraud):

1. **Find WISMO tab**
   ```javascript
   const tabs = await chrome.tabs.query({ url: "*://wismo-dashboard.walmart.com/*" });
   const wismoTab = tabs[0];
   ```

2. **Navigate to dashboard API**
   - User must be logged in to WISMO
   - Module calls `POST /api/v2/orders/shop-deliver` with date range

3. **Inject capture script**
   ```javascript
   await chrome.scripting.executeScript({
     target: { tabId: wismoTab.id, allFrames: true },
     world: "MAIN",
     func: () => {
       window.__SPARKRISK_CAPTURE__ = [];
       const originalFetch = window.fetch;
       window.fetch = async function(...args) {
         const response = await originalFetch(...args);
         const clone = response.clone();
         const data = await clone.json();
         if (args[0].includes('/shop-deliver')) {
           window.__SPARKRISK_CAPTURE__.push(data);
         }
         return response;
       };
     }
   });
   ```

4. **Extract captured data**
   ```javascript
   const results = await chrome.scripting.executeScript({
     target: { tabId: wismoTab.id },
     func: () => window.__SPARKRISK_CAPTURE__
   });
   const orders = results[0].result;
   ```

5. **Ingest**
   ```javascript
   await send("ingestData", { orders });
   ```

### Item Fetching (from order detail page)

Similar approach but navigate to:
```
https://wismo.walmart.com/order/{orderId}
```

Then capture the OMS response which **may** include item arrays.

---

## Next Steps

### **Phase 1: Basic Integration** (1-2 hours)
- [x] Module registration
- [x] IndexedDB data layer
- [x] Service handlers
- [x] UI structure
- [x] Styles
- [ ] Test in APAI Suite shell

### **Phase 2: WISMO Extraction** (2-3 hours)
- [ ] Implement CDP capture (copy from sparkfraud)
- [ ] Add extraction progress UI
- [ ] Handle authentication errors
- [ ] Test with real WISMO data

### **Phase 3: Item Fetching** (1-2 hours)
- [ ] Implement order detail capture
- [ ] Add item display to session panel
- [ ] Thumbnail fetching (walmart images)
- [ ] Cache items in IndexedDB

### **Phase 4: Polish** (2-3 hours)
- [ ] Add Chart.js for histograms/charts
- [ ] CSV export functionality
- [ ] Studies module (validation framework)
- [ ] Help documentation
- [ ] Error handling

### **Phase 5: Testing** (2-3 hours)
- [ ] End-to-end workflow test
- [ ] Performance testing (10k+ sessions)
- [ ] Privacy review
- [ ] Documentation

---

## Usage

### Installation
1. Copy `modules/sparkrisk/` to APAI Suite `modules/` directory
2. APAI Suite will auto-detect and load the module
3. Navigate to `/sparkrisk` in the suite

### Data Extraction
1. Open WISMO dashboard in another tab
2. Log in with your WMT credentials
3. Go to SparkRisk → "Data Extraction" tab
4. Select date range (recommend 7-14 days for initial load)
5. Click "Start Extraction"
6. Wait for extraction to complete (~30 sec per day)
7. Sessions auto-scored and high-priority reviews created

### Review Workflow
1. Go to "Review Queue" tab
2. Filter by score/status
3. Click a session to see details
4. Review register timestamp (for camera lookup)
5. Click "Resolve Real Order Numbers" when needed
6. Add notes and set status (cleared/confirmed/escalated)
7. Save review

---

## Privacy & Security

### Data Storage
- **Location**: Browser IndexedDB (`sparkrisk` database)
- **Persistence**: Local only, not synced
- **Size**: ~100MB quota requested

### PII Handling
- **Real Order IDs**: Visible but audit-logged
- **Driver Names**: Visible (from WISMO data)
- **Item Details**: Cached locally when fetched
- **Audit Trail**: All identity resolutions logged

### Security Controls
- **No mutations**: All WISMO calls are read-only
- **Session-based auth**: Uses existing WISMO cookies
- **No external transmission**: Data never leaves browser

---

## Known Limitations

### Data Availability
- **No item timestamps** in dashboard API (confirmed)
- **Order detail API** status unknown (requires testing)
- **Store maps** not available (no in-store layouts)

### Scope
- **Spark only**: Express/Scheduled Grocery not yet supported
- **Single store**: Multi-store aggregation not implemented
- **No real-time alerts**: Background sync not implemented

### Performance
- **Large datasets** (>50k sessions) may be slow
- **Chart rendering** depends on browser performance
- **IndexedDB** has ~100MB practical limit

---

## Migration from Standalone Tool

If migrating data from the standalone SQLite tool:

1. Export sessions from SQLite:
   ```sql
   SELECT * FROM sessions;
   ```

2. Convert to IndexedDB format (use provided migration script)

3. Import via console:
   ```javascript
   const sessions = [...]; // Your exported data
   await send("ingestData", { orders: sessions });
   ```

---

## Contributing

To enhance this module:

1. Follow APAI Suite patterns (see `modules/sparkfraud/`)
2. Update service handlers in `service.js`
3. Update UI in `view.js` / `view.html`
4. Test with real WISMO data
5. Document changes in this README

---

## Support

- **APAI Suite docs**: https://gecgithub01.walmart.com/pages/APAISuite/docs
- **Spark Risk issues**: File in APAI Suite repo
- **Questions**: Slack #apai-suite or Teams (link in main docs)

---

**Module Status**: 🟡 **Core complete, extraction pending**

Ready for testing in APAI Suite shell. WISMO integration is the final critical piece.
