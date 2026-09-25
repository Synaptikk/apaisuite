// modules/sparkrisk/view.js
//
// Frontend logic for SparkRisk module
// Converted from standalone app.js to APAI Suite module format
//
// Every value that originates in an imported file, an OMS response or a
// reviewer note is escaped before it reaches innerHTML. Session ids are JSON
// arrays and contain double quotes, so they MUST be escaped inside attributes
// too or the data-session attribute terminates early and the row stops
// opening. Use esc() for anything that is not a number this file computed.

// Module-level state
let $ = null;
let $$ = null;
let send = null;

const State = {
  currentTab: "overview",
  queue: {
    limit: 50,
    offset: 0,
    minScore: 0,
    maxScore: 100,
    status: "",
    sort: "priority_score",
    dir: "DESC"
  },
  stats: null,
  sessions: []
};

// ── Export mount function for APAI Suite ────────────────────────────
export async function mount(host, container) {
  // ── 1. Inject stylesheet ──────────────────────────────────────────
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = host.url("styles.css");
  link.dataset.module = host.id;
  document.head.appendChild(link);

  // ── 2. Load markup ────────────────────────────────────────────────
  try {
    const resp = await fetch(host.url("view.html"));
    container.innerHTML = await resp.text();
  } catch (e) {
    container.innerHTML = `<div class="state-error">Failed to load SparkRisk view: ${String(e?.message ?? e)}</div>`;
    return async () => { link.remove(); };
  }

  // ── 3. Set up module-scoped helpers ─────────────────────────────────────
  $ = (id) => container.querySelector("#" + id);
  $$ = (sel) => container.querySelectorAll(sel);

  send = async (type, payload = {}) => {
    return host.messaging.sendRaw(type, payload);
  };

  const esc = (v) => host.ui.escapeHtml(v == null ? "" : String(v));

  // ── Utilities ──────────────────────────────────────────────────────────
  const fmt = {
  num: (n) => (n != null ? n.toLocaleString() : "—"),
  date: (d) => d || "—",
  dur: (ms) => {
    if (ms == null) return "—";
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}m ${sec}s`;
  },
  score: (s) => (s != null ? Math.round(s) : 0),
  spi: (s) => (s != null ? s.toFixed(1) + "s" : "—"),
  pseudo: (p) => p ? p.slice(0, 16) + "…" : "—"
};

function scoreClass(score) {
  if (score >= 75) return "high";
  if (score >= 60) return "medium";
  if (score >= 45) return "low";
  return "none";
}

// History coverage is a description of the imported data, not a judgement.
function historyLabel(coverage) {
  const map = { recorded: "recorded", limited: "limited", none: "none" };
  return `<span class="badge badge-gray">${map[coverage] || "none"}</span>`;
}

function statusPill(status) {
  const map = {
    new: "badge-blue",
    in_review: "badge-amber",
    monitoring: "badge-purple",
    cleared: "badge-green",
    inconclusive: "badge-gray",
    confirmed: "badge-red",
    escalated: "badge-red"
  };
  const cls = map[status] || "badge-gray";
  return `<span class="badge ${cls}">${esc(status || "new")}</span>`;
}



// ── Tab Navigation ───────────────────────────────────────────────────
function switchTab(tabName) {
  // Update tab buttons
  $$(".sr-tab").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });

  // Update content
  $$(".sr-tab-content").forEach(content => {
    content.classList.toggle("active", content.id === `sr-${tabName}`);
  });

  State.currentTab = tabName;

  // Load content if needed
  if (tabName === "overview") loadOverview();
  if (tabName === "queue") loadQueue();
}

// ── Overview Tab ─────────────────────────────────────────────────────
async function loadOverview() {
  try {
    const stats = await send("getStats");
    
    if (!stats.ok) {
      console.error("Failed to load stats:", stats.error);
      return;
    }

    State.stats = stats;

    // Update context chips
    $("sr-session-count").textContent = fmt.num(stats.total);
    // Stores present in the imported data, not a hard-coded home store.
    $("sr-store-val").textContent = (stats.stores || []).join(", ") || "—";
    if (stats.daily.length > 0) {
      const first = stats.daily[0].extraction_date;
      const last = stats.daily[stats.daily.length - 1].extraction_date;
      $("sr-date-range").textContent = `${first} – ${last}`;
    }

    // Render KPIs
    const kpiGrid = $("sr-kpi-grid");
    kpiGrid.innerHTML = `
      <div class="kpi-card">
        <div class="kpi-value">${fmt.num(stats.total)}</div>
        <div class="kpi-label">Total Sessions</div>
      </div>
      <div class="kpi-card kpi-high">
        <div class="kpi-value">${fmt.num(stats.highPri)}</div>
        <div class="kpi-label">High Priority</div>
        <div class="kpi-note">Score ≥ 75</div>
      </div>
      <div class="kpi-card kpi-success">
        <div class="kpi-value">${fmt.num(stats.cleared)}</div>
        <div class="kpi-label">Cleared</div>
      </div>
      <div class="kpi-card kpi-danger">
        <div class="kpi-value">${fmt.num(stats.confirmed)}</div>
        <div class="kpi-label">Confirmed</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-value">${stats.daily.length}</div>
        <div class="kpi-label">Days of Data</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-value">${fmt.num(stats.ineligibleOrders)}</div>
        <div class="kpi-label">Orders not scored</div>
        <div class="kpi-note">Retained, outside any trip</div>
      </div>
    `;

    // Render charts (simplified - would use Chart.js in production)
    renderExcessChart(stats.excess);
    renderDailyChart(stats.daily);

  } catch (error) {
    console.error("loadOverview error:", error);
  }
}

// Minimal canvas bar chart. Deliberately dependency-free: the shell does
// not ship Chart.js, and the previous console.log() placeholders left two
// titled-but-empty chart cards on screen.
function drawBars(canvasId, values, labelAt) {
  const canvas = $(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext && canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width = canvas.clientWidth || 600;
  const h = canvas.height;
  const style = getComputedStyle(canvas);
  ctx.clearRect(0, 0, w, h);
  const max = Math.max(1, ...values);
  if (!values.length) return;
  const pad = 18;
  const bw = (w - pad) / values.length;
  ctx.fillStyle = style.getPropertyValue("color") || "#0071dc";
  values.forEach((v, i) => {
    const bh = Math.round(((h - pad) * v) / max);
    ctx.globalAlpha = v ? 0.85 : 0.15;
    ctx.fillRect(i * bw + 1, h - pad - bh, Math.max(1, bw - 2), Math.max(v ? 1 : 0, bh));
  });
  ctx.globalAlpha = 1;
  ctx.font = "10px system-ui, sans-serif";
  ctx.textAlign = "center";
  values.forEach((_, i) => {
    const label = labelAt(i, values.length);
    if (label) ctx.fillText(label, i * bw + bw / 2, h - 5);
  });
}

// Buckets are 2-minute wide and centred on 0: index 10 is "on reference".
function renderExcessChart(buckets) {
  drawBars("sr-excess-chart", buckets || [], (i, n) =>
    (i === 0 || i === n - 1 || i === 10) ? `${(i - 10) * 2}m` : "");
}

function renderDailyChart(daily) {
  const rows = daily || [];
  drawBars("sr-daily-chart", rows.map(d => d.sessions), (i, n) =>
    (i === 0 || i === n - 1) ? String(rows[i].extraction_date || "").slice(5) : "");
}

// ── Queue Tab ────────────────────────────────────────────────────────
async function loadQueue() {
  try {
    const result = await send("getQueue", {
      limit: State.queue.limit,
      offset: State.queue.offset,
      minScore: State.queue.minScore,
      maxScore: State.queue.maxScore,
      status: State.queue.status,
      sort: State.queue.sort,
      dir: State.queue.dir
    });

    if (!result.ok) {
      console.error("Failed to load queue:", result.error);
      return;
    }

    State.sessions = result.rows;
    renderQueue(result.rows);
    renderQueuePager(result.total);

  } catch (error) {
    console.error("loadQueue error:", error);
  }
}

function renderQueue(rows) {
  const tbody = $("sr-queue-body");

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="12" class="empty-row">No sessions match filters.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(r => {
    // Coerced: these land in class names and inline widths, and a legacy row
    // could still carry a string.
    const sc = Number(r.priority_score) || 0;
    const pri = Number(r.priority) || 3;
    const scC = scoreClass(sc);
    const excessMin = r.excess_minutes == null ? null : Number(r.excess_minutes);
    const excessStr = excessMin == null ? "—" : (excessMin > 0 ? "+" : "") + excessMin.toFixed(0) + "m";
    const excessCls = excessMin > 20 ? "high" : excessMin > 5 ? "medium" : excessMin < -20 ? "low" : "";
    const regTime = r.register_time_ms != null ? fmt.dur(r.register_time_ms) : "—";
    
    // Recorded-history counters. These describe coverage of the imported
    // data only, never seniority or standing.
    const totalSessions = r.driver_total_sessions || 0;
    const totalOrders = r.driver_total_orders || 0;
    const expTitle = `${totalSessions} recorded trips, ${totalOrders} orders at this store`;

    return `<tr class="queue-row" data-session="${esc(r.session_id)}" tabindex="0">
      <td class="col-pri"><span class="pri-badge pri-${pri}">${pri}</span></td>
      <td class="col-score">
        <div class="score-cell score-${scC}">
          <span class="score-num">${fmt.score(sc)}</span>
          <div class="score-bar-wrap"><div class="score-bar" style="width:${sc}%"></div></div>
        </div>
      </td>
      <td class="col-conf">${historyLabel(r.history_coverage)}</td>
      <td class="col-driver">${esc(r.driver_name || r.driver_id || "—")}</td>
      <td class="col-num" title="${esc(expTitle)}">${totalSessions}</td>
      <td class="col-date">${esc(fmt.date(r.extraction_date))}</td>
      <td class="col-num">${fmt.num(r.combined_items)} <small>×${Number(r.order_count) || 0}</small></td>
      <td class="col-dur">${fmt.dur(r.session_duration_ms)}</td>
      <td class="col-spi ${excessCls}">${excessStr}</td>
      <td class="col-dur">${regTime}</td>
      <td class="col-pct">${r.driver_prior_count != null ? Number(r.driver_prior_count) : "—"}</td>
      <td class="col-status">${statusPill(r.review_status)}</td>
    </tr>`;
  }).join("");

  // Add click handlers
  $$(".queue-row").forEach(row => {
    row.addEventListener("click", () => openSessionDetail(row.dataset.session));
    row.addEventListener("keydown", e => {
      if (e.key === "Enter") openSessionDetail(row.dataset.session);
    });
  });
}

function renderQueuePager(total) {
  const pages = Math.ceil(total / State.queue.limit) || 1;
  const cur = Math.floor(State.queue.offset / State.queue.limit) + 1;
  const pager = $("sr-queue-pager");
  
  pager.innerHTML = `
    <button class="page-btn" id="sr-prev" ${cur <= 1 ? "disabled" : ""}>← Prev</button>
    <span>Page ${cur} of ${pages} · ${fmt.num(total)} total</span>
    <button class="page-btn" id="sr-next" ${cur >= pages ? "disabled" : ""}>Next →</button>
  `;

  $("sr-prev")?.addEventListener("click", () => {
    State.queue.offset -= State.queue.limit;
    loadQueue();
  });

  $("sr-next")?.addEventListener("click", () => {
    State.queue.offset += State.queue.limit;
    loadQueue();
  });
}

// ── Session Detail Panel ─────────────────────────────────────────────
async function openSessionDetail(sessionId) {
  try {
    const data = await send("getSession", { sessionId });

    if (!data.ok) {
      console.error("Failed to load session:", data.error);
      return;
    }

    const { session, review, orders, driverSessions, driverStats } = data;

    $("sr-panel-title").textContent = "Session Detail";
    $("sr-panel-subtitle").textContent =
      `${session.order_count} order(s) · ${session.combined_items} items · ${fmt.date(session.extraction_date)}`;

    const sc = session.priority_score || 0;
    const scC = scoreClass(sc);
    const exMin = session.excess_minutes;
    const exStr = exMin == null ? "—" : (exMin > 0 ? "+" : "") + exMin.toFixed(1) + " min";
    
    // Video review window. Both endpoints are SOURCE STATUS timestamps, not
    // observed physical events, so the copy must not imply a store exit.
    let registerWindow = "";
    if (session.dispatched_time && session.review_window_start) {
      const exitedTime = new Date(session.dispatched_time);
      const arrivedTime = new Date(session.review_window_start);
      
      const formatTime = (d) => d.toLocaleString('en-US', { 
        month: '2-digit', day: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true 
      });
      
      registerWindow = `
        <div class="notice-bar notice-blue">
          <span class="notice-icon">📹</span>
          <div style="flex:1">
            <strong>Source status window (nothing here is observed — verify on video):</strong>
            <div style="margin-top:8px;font-family:monospace;font-size:14px">
              <div><strong>Picked status recorded:</strong> ${esc(formatTime(arrivedTime))}</div>
              <div style="margin-top:4px"><strong>Dispatched status recorded:</strong> ${esc(formatTime(exitedTime))}</div>
              <div style="margin-top:4px;color:var(--apai-blue-100)"><strong>Elapsed between them:</strong> ${fmt.dur(exitedTime - arrivedTime)}</div>
            </div>
            <div style="margin-top:8px;font-size:13px;opacity:0.85">
              Suggested footage window: <strong>${esc(arrivedTime.toLocaleTimeString())}</strong> to <strong>${esc(exitedTime.toLocaleTimeString())}</strong>. The driver may have reached or left a register outside it.
            </div>
          </div>
        </div>
      `;
    }
    
    // Coverage of the IMPORTED data for this driver at this store. A small
    // number means "we have not imported much", not "new driver".
    const dStats = driverStats || {};
    const totalSessions = dStats.total_sessions || 0;
    const totalOrders = dStats.total_orders || 0;
    const firstSeen = dStats.first_seen;
    const lastSeen = dStats.last_seen;
    const expBadge = totalSessions < 10 ? "LIMITED HISTORY" : "RECORDED HISTORY";
    // notice-high / notice-medium / notice-low are not defined in styles.css;
    // use the palette classes that exist.
    const expClass = totalSessions < 10 ? "amber" : "blue";
    
    // Calculate days active
    let daysActive = "—";
    if (firstSeen && lastSeen) {
      const daysDiff = Math.floor((new Date(lastSeen) - new Date(firstSeen)) / (1000 * 60 * 60 * 24));
      daysActive = daysDiff === 0 ? "First day" : `${daysDiff} days`;
    }

    $("sr-panel-body").innerHTML = `
      ${registerWindow}

      <div class="score-hero">
        <div class="score-hero-num">
          <div class="score-big ${scC}">${fmt.score(sc)}</div>
          <div class="score-label-sm">Priority Score</div>
        </div>
        <div class="score-hero-body">
          <div class="score-why">${esc(session.explanation || "No explanation generated.")}</div>
        </div>
      </div>

      <div class="detail-section">
        <div class="detail-section-title">Session Metrics</div>
        <div class="stat-grid">
          <div class="stat-item"><span class="stat-label">Duration</span><span class="stat-value">${fmt.dur(session.session_duration_ms)}</span></div>
          <div class="stat-item"><span class="stat-label">Excess</span><span class="stat-value">${exStr}</span></div>
          <div class="stat-item"><span class="stat-label">Picked-to-dispatch</span><span class="stat-value">${fmt.dur(session.register_time_ms)}</span></div>
          <div class="stat-item"><span class="stat-label">Items</span><span class="stat-value">${fmt.num(session.combined_items)}</span></div>
        </div>
      </div>
      
      <div class="detail-section">
        <div class="detail-section-title">Recorded Driver History</div>
        <div class="notice-bar notice-${expClass}" style="margin-bottom:var(--sp-3)">
          <div style="flex:1">
            <strong>${expBadge}</strong>
            <div style="margin-top:4px;font-size:14px;opacity:0.9">
              ${totalSessions} recorded trip(s) · ${totalOrders} order(s) · imported range spans ${esc(daysActive)}
            </div>
          </div>
        </div>
        <div class="stat-grid">
          <div class="stat-item"><span class="stat-label">Recorded Trips</span><span class="stat-value">${fmt.num(totalSessions)}</span></div>
          <div class="stat-item"><span class="stat-label">Total Orders</span><span class="stat-value">${fmt.num(totalOrders)}</span></div>
          <div class="stat-item"><span class="stat-label">First Seen</span><span class="stat-value">${esc(fmt.date(firstSeen))}</span></div>
          <div class="stat-item"><span class="stat-label">Last Seen</span><span class="stat-value">${esc(fmt.date(lastSeen))}</span></div>
        </div>
      </div>

      <div class="detail-section">
        <div class="detail-section-title">Order Items</div>
        <button class="btn btn-secondary" id="sr-fetch-items-btn">🛒 Fetch Order Items</button>
        <div id="sr-items-container" class="hidden" style="margin-top:var(--sp-3)"></div>
      </div>

      <div class="detail-section">
        <div class="detail-section-title">Identity Resolution</div>
        <button class="btn btn-secondary" id="sr-resolve-btn">🔓 Resolve Real Order Numbers</button>
        <div id="sr-resolved" class="hidden"></div>
      </div>

      <div class="detail-section">
        <div class="detail-section-title">Review Action</div>
        <div class="form-group">
          <label class="form-label">Status</label>
          <select class="form-control" id="sr-review-status">
            <option value="new" ${(review?.status || "new") === "new" ? "selected" : ""}>New</option>
            <option value="in_review" ${review?.status === "in_review" ? "selected" : ""}>In Review</option>
            <option value="cleared" ${review?.status === "cleared" ? "selected" : ""}>Cleared</option>
            <option value="confirmed" ${review?.status === "confirmed" ? "selected" : ""}>Confirmed</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Notes</label>
          <textarea class="form-control" id="sr-review-notes" rows="3">${esc(review?.notes || "")}</textarea>
        </div>
        <button class="btn btn-primary" id="sr-save-review">Save Review</button>
        ${review?.merged_reviews?.length ? `<details><summary>Earlier merged reviews (${review.merged_reviews.length})</summary>${review.merged_reviews.map(r => `<p>${esc(r.status || "new")}: ${esc(r.notes || "No notes")}</p>`).join("")}</details>` : ""}
      </div>
    `;

    // Wire up resolve button
    $("sr-resolve-btn").addEventListener("click", async () => {
      const result = await send("resolveIdentity", { sessionId });
      if (result.ok) {
        $("sr-resolved").innerHTML = `
          <div class="notice-bar notice-green" style="margin-top:var(--space-3)">
            <strong>Order IDs:</strong> ${esc(result.real_order_ids.join(", "))}
          </div>
        `;
        $("sr-resolved").classList.remove("hidden");
        $("sr-resolve-btn").style.display = "none";
      }
    });

    // Wire up fetch items button
    $("sr-fetch-items-btn").addEventListener("click", async () => {
      const btn = $("sr-fetch-items-btn");
      btn.disabled = true;
      btn.textContent = "Fetching items...";
      
      try {
        const orderIds = JSON.parse(session.order_ids || "[]");
        if (!orderIds.length) {
          alert("No order IDs found for this session");
          return;
        }
        
        const result = await send("fetchOrderItems", { orderIds });
        
        if (result.ok && result.itemsByOrder) {
          let html = '';
          const itemsByOrder = result.itemsByOrder;
          
          for (const [orderId, items] of Object.entries(itemsByOrder)) {
            html += `
              <div style="margin-bottom:var(--sp-3); padding:var(--sp-3); background:var(--apai-bg-soft); border:1px solid var(--apai-border); border-radius:var(--rad-md);">
                <div style="font-weight:var(--fw-semi); margin-bottom:var(--sp-2); color:var(--apai-ink);">
                  Order: ${esc(orderId)} (${items.length} items)
                </div>
                <table class="data-table" style="width:100%;">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>UPC</th>
                      <th>Qty</th>
                      <th>Price</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
            `;
            
            items.forEach(item => {
              html += `
                <tr>
                  <td>${esc(item.itemName || item.itemId || '—')}</td>
                  <td><code>${esc(item.upc || '—')}</code></td>
                  <td>${esc(item.quantity ?? '—')}</td>
                  <td>${esc(item.unitPrice == null ? '—' : "$" + item.unitPrice)}</td>
                  <td>${esc(item.lineStatus || '—')}</td>
                </tr>
              `;
            });
            
            html += `
                  </tbody>
                </table>
              </div>
            `;
          }
          
          $("sr-items-container").innerHTML = html;
          $("sr-items-container").classList.remove("hidden");
          btn.style.display = "none";
          
        } else {
          alert("Failed to fetch items: " + (result.error || "Unknown error"));
          btn.disabled = false;
          btn.textContent = "🛒 Fetch Order Items";
        }
      } catch (error) {
        console.error("Error fetching items:", error);
        alert("Error fetching items: " + error.message);
        btn.disabled = false;
        btn.textContent = "🛒 Fetch Order Items";
      }
    });

    // Wire up save review button
    $("sr-save-review").addEventListener("click", async () => {
      
      host.usage.record("save_review");
      const saved = await send("updateReview", {
        reviewId: review?.id,
        sessionId: session.session_id,
        status: $("sr-review-status").value,
        notes: $("sr-review-notes").value
      });
      if (!saved.ok) { alert(saved.error || "Review could not be saved"); return; }
      host.ui.toast ? host.ui.toast("Review saved") : alert("Review saved");
      await Promise.all([loadQueue(), loadOverview()]);
    });

    $("sr-detail-overlay").classList.remove("hidden");
    $("sr-panel-close").focus();

  } catch (error) {
    console.error("openSessionDetail error:", error);
  }
}

// ── Data Extraction ──────────────────────────────────────────────────
async function startExtraction() {
  const input = $("sr-import-file");
  const file = input?.files?.[0];
  if (!file) { alert("Choose an order JSON file first"); return; }
  const button = $("sr-extract-start-btn");
  const statusEl = $("sr-extract-status");
  const bar = $("sr-extract-progress-bar");
  button.disabled = true;
  bar.style.width = "35%";
  $("sr-extract-progress").classList.remove("hidden");
  $("sr-extract-results").classList.add("hidden");
  statusEl.textContent = "Reading file…";
  try {
    const parsed = JSON.parse(await file.text());
    const orders = Array.isArray(parsed) ? parsed : parsed?.orders;
    if (!Array.isArray(orders) || !orders.length) {
      throw new Error("Expected an array of normalized orders, or an object with an `orders` array");
    }
    // Only the whole file has to be unusable to fail. Individual records with
    // no order_id are counted as `rejected` by the rebuild and reported below
    // - blocking a 10,000-row export because one row is malformed would just
    // push the analyst into hand-editing the source.
    const usable = orders.filter(o => o && typeof o === "object" && String(o.order_id ?? "").trim());
    if (!usable.length) {
      throw new Error(`None of the ${orders.length} record(s) carry an order_id`);
    }
    statusEl.textContent = `Rebuilding trips from ${orders.length} imported order(s)…`;
    const result = await send("ingestData", { orders });
    if (!result.ok) throw new Error(result.error || "Import failed");
    statusEl.textContent = "Import complete.";
    // Every count here is reported by the rebuild, not estimated.
    $("sr-extract-results").innerHTML = [
      `<p><strong>${result.sessions}</strong> scoreable trip(s) after rebuilding the full order history.</p>`,
      `<p><strong>${result.reviews}</strong> review record(s) available, including low-score trips.</p>`,
      `<p><strong>${result.ineligibleOrders}</strong> order(s) retained but not scored (cancelled, zero quantity, or missing/inverted timestamps).</p>`,
      result.rejected ? `<p><strong>${result.rejected}</strong> record(s) rejected for having no order_id.</p>` : "",
      `<p class="muted tiny">Saved review decisions were carried across. Reimporting the same file again changes nothing.</p>`,
    ].join("");
    $("sr-extract-results").classList.remove("hidden");
    State.queue.offset = 0;
    await Promise.all([loadOverview(), loadQueue()]);
    bar.style.width = "100%";
  } catch (e) {
    statusEl.textContent = `Import failed: ${e?.message || String(e)}`;
    bar.style.width = "0%";
  } finally {
    // The progress block stays visible: #sr-extract-status lives inside it and
    // is the only place the outcome (or the failure reason) is shown.
    button.disabled = false;
  }
}

  // ── Initialization ─────────────────────────────────────────────────────
  function init() {
  console.log("[SparkRisk] Initializing module...");


  // Wire up event listeners
  $$(".sr-tab").forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  $("sr-help")?.addEventListener("click", () => $("sr-help-modal").showModal());
  $("sr-help-close")?.addEventListener("click", () => $("sr-help-modal").close());
  $("sr-help-close-btn")?.addEventListener("click", () => $("sr-help-modal").close());
  
  $("sr-panel-close")?.addEventListener("click", () => {
    $("sr-detail-overlay").classList.add("hidden");
  });

  $("sr-detail-overlay")?.addEventListener("click", (e) => {
    if (e.target === $("sr-detail-overlay")) {
      $("sr-detail-overlay").classList.add("hidden");
    }
  });

  $("sr-apply-filters")?.addEventListener("click", () => {
    State.queue.minScore = Number($("sr-min-score").value);
    State.queue.maxScore = Number($("sr-max-score").value);
    State.queue.status = $("sr-status-filter").value;
    State.queue.sort = $("sr-sort").value;
    State.queue.offset = 0;
    loadQueue();
  });

  $("sr-refresh-btn")?.addEventListener("click", () => {
    if (State.currentTab === "overview") loadOverview();
    if (State.currentTab === "queue") loadQueue();
  });

  $("sr-extract-start-btn")?.addEventListener("click", startExtraction);

  // Context-bar shortcut. Previously unwired, so the primary-looking
  // "Import Order Data" button did nothing at all.
  $("sr-extract-btn")?.addEventListener("click", () => switchTab("extraction"));

  // Load initial view
  loadOverview();
}

// Initialize the module
init();

// Return unmount function
return async () => {
  link.remove();
};
}
