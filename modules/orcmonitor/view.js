// modules/orcmonitor/view.js
// ORC Corridor Monitor — full view with embedded Leaflet map.
// Corridors data is inlined (no dynamic import needed).
// Leaflet loaded from local bundle: lib/leaflet.js (CSP-safe, same origin).
// Colors match APAISuite light theme (tokens.css).

const PROGRESS_KEY = "orcmonitor.progress";

// Key Market 120 / Region 12 store coordinates for pre-centering the map
const STORE_COORDS = {
  "1458":[34.9362,-85.2152],"669":[34.7675,-84.9304],"5173":[34.7867,-84.9991],
  "3660":[35.0155,-85.3765],"1469":[35.0404,-85.2032],"5251":[35.0536,-85.1454],
  "2988":[34.7463,-85.2734],"1215":[34.4794,-84.9457],"658":[34.2754,-85.2300],
  "5151":[34.2213,-85.1303],"756":[34.5218,-85.3165],"1089":[35.0405,-85.6820],
};

// Inline corridor waypoints — avoids dynamic import issues
const CORRIDORS = {  "I-75":  [[25.8,-80.2],[28.5,-81.4],[32.5,-83.7],[33.7,-84.4],[34.3,-84.0],[34.8,-84.8],
             [35.05,-85.3],[35.17,-84.87],[35.46,-84.59],[35.96,-83.92],[36.6,-83.7],[37.0,-84.5],[39.1,-84.5]],
  "I-40":  [[35.15,-90.0],[35.15,-89.0],[36.17,-86.78],[36.15,-85.5],[36.12,-84.5],[35.96,-83.92],[35.6,-82.6]],
  "I-24":  [[36.17,-86.78],[35.85,-86.4],[35.47,-86.1],[35.2,-85.5],[35.05,-85.3]],
  "I-59":  [[33.5,-86.8],[33.98,-86.01],[34.44,-85.72],[34.9,-85.55],[35.05,-85.3]],
  "I-65":  [[30.7,-88.1],[32.4,-86.8],[33.5,-86.8],[36.17,-86.78],[38.2,-85.7]],
  "I-81":  [[36.6,-82.2],[36.55,-82.55],[36.3,-82.8],[36.1,-83.5],[35.96,-83.92]],
  "I-85":  [[33.7,-84.4],[33.9,-83.8],[34.3,-83.3],[34.7,-82.9],[35.2,-80.8]],
  "I-20":  [[33.7,-84.4],[33.5,-85.5],[33.5,-86.8],[32.4,-86.8]],
  "I-26":  [[36.3,-82.35],[35.96,-83.92],[35.6,-82.6]],
};

function corridorsGeoJSON() {
  return { type:"FeatureCollection", features: Object.entries(CORRIDORS).map(([name,pts]) => ({
    type:"Feature", properties:{ name },
    geometry:{ type:"LineString", coordinates: pts.map(([la,lo]) => [lo,la]) },
  }))};
}

export async function mount(host, container) {
  const styleLink = document.createElement("link");
  styleLink.rel  = "stylesheet";
  styleLink.href = host.url("styles.css");
  document.head.appendChild(styleLink);

  container.innerHTML = await fetch(host.url("view.html")).then(r => r.text());

  // Load local Leaflet — same extension origin, passes script-src 'self'
  await _loadLeaflet(host);
  const map = _initMap(container);
  // Give the shell's layout engine time to settle, then size + center the map
  if (map) {
    setTimeout(() => {
      map.invalidateSize();
      // Pre-center on the default store input value
      const { getStoreCoords } = (window._orcStoreCoords ?? {});
      const storeVal = (container.querySelector("#om-store")?.value ?? "1458").trim();
      const preCoords = STORE_COORDS[storeVal];
      if (preCoords) map.setView(preCoords, 7, { animate:false });
    }, 200);
    setTimeout(() => { map.invalidateSize(); }, 700);
  }
  let mapLayers = [], dotLayers = [];
  let lastData = null, selected = null, days = 30, progressInterval = null;

  container.querySelectorAll(".om-days-btn").forEach(btn =>
    btn.addEventListener("click", () => {
      container.querySelectorAll(".om-days-btn").forEach(b => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      days = parseInt(btn.dataset.days, 10);
    })
  );

  const badge = container.querySelector("#om-token-badge");
  async function checkToken() {
    try {
      const r = await host.messaging.sendRaw("getStatus", {});
      const d = r?.data ?? r;
      const ready = !!(d?.tokenReady);
      if (ready) {
        badge.textContent = `✓ Auror Connected${d?.cachedProfiles ? ` · ${d.cachedProfiles} cached` : ""}`;
        badge.className = "om-badge om-badge-ok";
        container.querySelector("#om-btn-analyze").disabled = false;
      } else {
        badge.textContent = "⏳ Connecting to Auror…";
        badge.className = "om-badge om-badge-warn";
        // getStatus auto-tries to open a background tab — disable analyze while retrying
        container.querySelector("#om-btn-analyze").disabled = true;
      }
    } catch {}
  }
  await checkToken();
  const tokenPoll = setInterval(checkToken, 15_000);

  container.querySelector("#om-btn-analyze").addEventListener("click", async () => {
    const store = (container.querySelector("#om-store").value ?? "").trim();
    if (!store) return;
    const btn = container.querySelector("#om-btn-analyze");
    btn.disabled = true; btn.textContent = "Analyzing…";
    _startProgress(container);

    let resp;
    try {
      resp = await host.messaging.sendRaw("analyzeThreats", { targetStore:store, radius:400, days }, { timeoutMs:300_000 });
    } catch(e) {
      _stopProgress(container); btn.disabled = false; btn.textContent = "Analyze";
      _setStatus(container, `Error: ${e?.message ?? e}`); return;
    }

    _stopProgress(container); btn.disabled = false; btn.textContent = "Analyze";
    const data = resp?.data ?? resp;
    if (!data || resp?.ok === false) {
      _setStatus(container, resp?.error ?? "Failed — ensure Auror is open in Edge"); return;
    }

    // Final complete render — replaces any partial render from the progress interval
    lastData = data; selected = null;
    const threats = data.threats ?? [];
    _clearLayers(map, mapLayers, dotLayers);
    _renderBase(map, mapLayers, data, corridorsGeoJSON());
    _renderDots(map, dotLayers, data, threats, null, selectCard);
    _renderSummary(container, threats, data);
    _renderCards(container, threats);
    container.querySelector("#om-btn-export").disabled = !threats.length;
    _setStatus(container, `${threats.length} threats within 300 mi — sorted by risk score`);
  });

  function selectCard(pid) {
    selected = selected === pid ? null : pid;
    container.querySelectorAll(".om-card[data-person-id]").forEach(c => {
      const isSel = c.dataset.personId === selected;
      c.style.boxShadow = isSel ? "0 0 0 2px var(--apai-blue,#0071CE)" : "";
      c.style.opacity   = !selected || isSel ? "1" : "0.42";
    });
    if (lastData) _renderDots(map, dotLayers, lastData, lastData.threats??[], selected, selectCard);
    if (selected && lastData) {
      const th = (lastData.threats??[]).find(t => String(t.personId) === String(selected));
      if (th?.lat && th?.lon) map?.setView([th.lat, th.lon], 9, { animate:true });
    }
  }

  container.querySelector("#om-cards-container").addEventListener("click", e => {
    const c = e.target.closest(".om-card[data-person-id]");
    if (c) selectCard(c.dataset.personId ?? "");
  });

  container.querySelector("#om-btn-export")?.addEventListener("click", async () => {
    if (!lastData) return;
    const store = (container.querySelector("#om-store")?.value ?? "1458").trim();
    const btn = container.querySelector("#om-btn-export");
    btn.disabled = true; btn.textContent = "Capturing map…";
    const mapImg = await _captureMapImage(container, map, lastData).catch(() => null);
    btn.disabled = false; btn.textContent = "Export PDF";
    _openReport(lastData, store, mapImg);
  });

  function _startProgress(c) {
    c.querySelector("#om-progress-bar").classList.remove("hidden");
    let lastCardCount = 0;
    progressInterval = setInterval(async () => {
      const got = await chrome.storage.session.get(PROGRESS_KEY).catch(() => ({}));
      const p   = got?.[PROGRESS_KEY] ?? {};
      const pct = Math.min(95, 5 + (p.profilesDone ?? 0) * 1.5);
      c.querySelector("#om-progress-fill").style.width = pct + "%";
      c.querySelector("#om-progress-label").textContent =
        p.stage === "events"
          ? `Scanning ${p.regionsChecked??0}/8 SE regions… ${p.personsFound??0} ORC persons found`
          : `Profiles: ${p.profilesDone??0} / ${p.personsFound??"?"} done${(p.partialThreats?.length??0)>0 ? ` · ${p.partialThreats.length} threats found` : ""}`;

      // Render cards as they arrive — only update when count changes
      const partial = p.partialThreats ?? [];
      if (partial.length > lastCardCount) {
        lastCardCount = partial.length;
        // Update map base if we have target + it hasn't been drawn yet
        if (p.target && !lastData) {
          _clearLayers(map, mapLayers, dotLayers);
          _renderBase(map, mapLayers, p, corridorsGeoJSON());
        }
        _renderSummary(c, partial, p);
        _renderCards(c, partial);
        _renderDots(map, dotLayers, { target: p.target, threats: partial }, partial, selected, selectCard);
        c.querySelector("#om-btn-export").disabled = !partial.length;
      }
    }, 1500);
  }
  function _stopProgress(c) {
    clearInterval(progressInterval); progressInterval = null;
    c.querySelector("#om-progress-fill").style.width = "100%";
    setTimeout(() => c.querySelector("#om-progress-bar").classList.add("hidden"), 600);
  }

  return () => {
    clearInterval(tokenPoll); clearInterval(progressInterval);
    styleLink.remove(); try { map?.remove(); } catch {}
  };
}

// ── Leaflet ───────────────────────────────────────────────────────────────────

function _loadLeaflet(host) {
  if (window.L) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const lnk = document.createElement("link");
    lnk.rel  = "stylesheet";
    lnk.href = host.url("lib/leaflet.css");
    document.head.appendChild(lnk);

    const s = document.createElement("script");
    s.src    = host.url("lib/leaflet.js");   // chrome-extension:// → 'self' → CSP passes
    s.onload = resolve;
    s.onerror = () => reject(new Error("Leaflet failed to load from " + host.url("lib/leaflet.js")));
    document.head.appendChild(s);
  });
}

function _initMap(container) {
  const el = container.querySelector("#om-map");
  if (!el || !window.L) return null;
  // Start at a neutral center — setView to actual store fires 200ms after mount
  const map = L.map(el, { zoomControl:true }).setView([35.0, -85.2], 7);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:"© OpenStreetMap", maxZoom:19,
    crossOrigin: "anonymous",   // required for canvas tile capture
  }).addTo(map);
  return map;
}

function _clearLayers(map, ml, dl) {
  [...ml,...dl].forEach(l => { try { map?.removeLayer(l); } catch {} });
  ml.length = 0; dl.length = 0;
}

function _renderBase(map, ml, data, gj) {
  if (!map || !data?.target) return;
  const t = data.target;

  if (gj) ml.push(L.geoJSON(gj, {
    style:() => ({ color:"#0071CE", weight:2, dashArray:"8 4", opacity:0.35 }),
    onEachFeature:(f,l) => l.bindTooltip(f.properties.name),
  }).addTo(map));

  // 200-mile radius ring
  const ring = L.circle([t.lat,t.lon], {
    radius: 200 * 1609,
    color:"#B91C1C", weight:1.5, fill:true, fillColor:"#B91C1C", fillOpacity:0.04,
    dashArray:"6 4",
  }).addTo(map);
  ml.push(ring);

  const icon = L.divIcon({
    className:"", iconSize:[28,28], iconAnchor:[14,14],
    html:`<div style="width:28px;height:28px;background:#0071CE;border:2px solid #fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:#fff;box-shadow:0 1px 4px rgba(0,0,0,.25)">${t.store}</div>`,
  });
  ml.push(L.marker([t.lat,t.lon], { icon, zIndexOffset:1000 }).bindPopup(`<b>Target: Store ${t.store}</b>`).addTo(map));

  // Fit view to store — invalidateSize first, then zoom to show the 200-mile ring
  setTimeout(() => {
    map.invalidateSize();
    map.setView([t.lat, t.lon], 7, { animate:false });
  }, 100);
}

function _renderDots(map, dl, data, threats, selectedPid, onDotClick) {
  dl.forEach(l => { try { map?.removeLayer(l); } catch {} });
  dl.length = 0;
  if (!map) return;
  const t = data?.target;

  (threats??[]).slice(0,30).forEach(th => {
    if (!th.lat || !th.lon) return;
    const pid   = String(th.personId ?? "");
    const isSel = !!selectedPid && pid === String(selectedPid);
    if (selectedPid && !isSel) return;

    const color = th.riskScore>=70?"#B91C1C":th.riskScore>=45?"#D97706":"#CA8A04";

    if (isSel) {
      const hist = (th.storeHistory??[]).filter(s=>s.lat&&s.lon);
      hist.forEach((s,i) => {
        const isT = s.store?.includes("1458");
        const dc  = isT?"#1A7F37":i===0?"#B91C1C":"#0071CE";
        dl.push(L.circleMarker([s.lat,s.lon],{radius:isT?9:6,color:"#fff",weight:1.5,fillColor:dc,fillOpacity:0.9})
          .bindPopup(`<b>${(s.store??"?").split(" - ")[0]}</b><br>${s.date??""} ${s.type?"· "+s.type:""}<br>${s.dist} mi${isT?"<br><b style='color:#1A7F37'>★ YOUR STORE</b>":""}`)
          .addTo(map));
        if (i<hist.length-1&&hist[i+1].lat)
          dl.push(L.polyline([[s.lat,s.lon],[hist[i+1].lat,hist[i+1].lon]],{color:"#0071CE",weight:2,opacity:0.6,dashArray:"4 3"}).addTo(map));
      });
      if (th.approaching && t)
        dl.push(L.polyline([[th.lat,th.lon],[t.lat,t.lon]],{color,weight:2.5,dashArray:"6 4",opacity:0.8}).addTo(map));
    }

    dl.push(L.circleMarker([th.lat,th.lon],{
      radius:isSel?11:8, color:"#fff", weight:isSel?2:1.5, fillColor:color, fillOpacity:isSel?1:0.85,
    }).bindPopup(`<b>${th.name}</b><br>Risk: ${th.riskScore}/100<br>Last: ${th.lastSeenDays??"?"}d ago · ${th.currentDist} mi<br><a href="${th.aurorUrl}" target="_blank">Open in Auror →</a>`)
      .on("click",()=>onDotClick(pid)).addTo(map));
  });
}

// ── Capture map as image via Canvas (works in extension pages) ────────────────
// Draws OSM tiles (crossOrigin:"anonymous") + SVG overlays onto a canvas.

async function _captureMapImage(container, mapInst, data) {
  const mapEl = container.querySelector("#om-map");
  if (!mapEl || !window.L || !mapInst) return null;

  await new Promise(r => setTimeout(r, 700));   // let tiles fully render

  const rect = mapEl.getBoundingClientRect();
  const dpr  = window.devicePixelRatio || 1;
  const W    = Math.round(rect.width);
  const H    = Math.round(rect.height);
  const canvas = document.createElement("canvas");
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  // ── 1. Background ─────────────────────────────────────────────────────────
  ctx.fillStyle = "#f2efe9";
  ctx.fillRect(0, 0, W, H);

  // ── 2. OSM Tiles (crossOrigin:"anonymous" set on the tile layer) ──────────
  const mapRect = mapEl.getBoundingClientRect();
  const tiles   = mapEl.querySelectorAll("img.leaflet-tile");
  await Promise.all([...tiles].map(img => new Promise(res => {
    if (img.complete && img.naturalWidth) { res(); return; }
    img.onload = res; img.onerror = res; setTimeout(res, 2000);
  })));
  for (const img of tiles) {
    const tr = img.getBoundingClientRect();
    try { ctx.drawImage(img, tr.left - mapRect.left, tr.top - mapRect.top, tr.width, tr.height); }
    catch (_) {}
  }

  // ── 3. Overlays drawn using Leaflet's lat/lon → pixel projection ──────────
  // Helper: convert a lat/lon pair to canvas x,y
  function px(lat, lon) {
    const p = mapInst.latLngToContainerPoint(L.latLng(lat, lon));
    return [p.x, p.y];
  }

  const target  = data?.target ?? {};
  const threats = data?.threats ?? [];

  // Corridors
  const CORR = [
    [[25.8,-80.2],[32.5,-83.7],[33.7,-84.4],[34.8,-84.8],[35.05,-85.3],[35.96,-83.92],[37.0,-84.5]],
    [[35.15,-90.0],[36.17,-86.78],[35.96,-83.92]],
    [[36.17,-86.78],[35.05,-85.3]],
    [[33.5,-86.8],[34.44,-85.72],[35.05,-85.3]],
    [[30.7,-88.1],[33.5,-86.8],[36.17,-86.78]],
    [[33.7,-84.4],[34.7,-82.9],[35.2,-80.8]],
  ];
  ctx.strokeStyle = "#0071CE";
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 4]);
  ctx.globalAlpha = 0.55;
  for (const pts of CORR) {
    ctx.beginPath();
    pts.forEach(([la,lo],i) => { const [x,y]=px(la,lo); i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); });
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // 200-mile radius ring
  if (target.lat && target.lon) {
    const [cx,cy] = px(target.lat, target.lon);
    const edge    = mapInst.latLngToContainerPoint(L.latLng(target.lat + 200/69, target.lon));
    const rPx     = Math.abs(cy - edge.y);
    ctx.beginPath();
    ctx.arc(cx, cy, rPx, 0, Math.PI * 2);
    ctx.strokeStyle = "#B91C1C";
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([8, 4]);
    ctx.globalAlpha = 0.6;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  // Threat dots with trajectory lines to target
  for (const th of threats.filter(t => t.lat && t.lon).slice(0, 25)) {
    const [tx,ty] = px(th.lat, th.lon);
    const col = th.riskScore>=70?"#B91C1C":th.riskScore>=45?"#D97706":"#CA8A04";

    // Store history path (chronological lines between stores)
    const hist = (th.storeHistory ?? []).filter(s => s.lat && s.lon);
    if (hist.length >= 2) {
      ctx.strokeStyle = "#0071CE";
      ctx.lineWidth   = 1.5;
      ctx.globalAlpha = 0.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      hist.forEach((s,i) => {
        const [x,y] = px(s.lat, s.lon);
        i === 0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // Approach arrow to target
    if (th.approaching && target.lat && target.lon) {
      const [tlx,tly] = px(target.lat, target.lon);
      ctx.strokeStyle = col;
      ctx.lineWidth   = 2;
      ctx.setLineDash([5, 4]);
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(tlx, tly);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // Dot
    const r = th.riskScore >= 70 ? 8 : 6;
    ctx.beginPath();
    ctx.arc(tx, ty, r, 0, Math.PI * 2);
    ctx.fillStyle   = col;
    ctx.globalAlpha = 0.9;
    ctx.fill();
    ctx.strokeStyle = "white";
    ctx.lineWidth   = 1.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Target store marker
  if (target.lat && target.lon) {
    const [sx,sy] = px(target.lat, target.lon);
    ctx.beginPath();
    ctx.arc(sx, sy, 12, 0, Math.PI * 2);
    ctx.fillStyle = "#0071CE";
    ctx.fill();
    ctx.strokeStyle = "white";
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.fillStyle   = "white";
    ctx.font        = "bold 9px sans-serif";
    ctx.textAlign   = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(target.store ?? ""), sx, sy);
  }

  return canvas.toDataURL("image/png");
}


// ── Inline SVG map fallback (no external requests) ────────────────────────────
function _buildSvgMap(target, threats) {
  const W = 700, H = 300;
  const clat = target.lat ?? 35.0, clon = target.lon ?? -85.2;

  // Bounding box — zoomed out ~25% from before (3.75° lat, 5.6° lon)
  const latSpan = 3.75, lonSpan = 5.6;
  const minLat = clat - latSpan, maxLat = clat + latSpan;
  const minLon = clon - lonSpan, maxLon = clon + lonSpan;

  function project(lat, lon) {
    const x = ((lon - minLon) / (maxLon - minLon)) * W;
    const y = H - ((lat - minLat) / (maxLat - minLat)) * H;
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
  }

  // ── 1° grid lines with labels ─────────────────────────────────────────────
  let grid = "";
  for (let lat = Math.ceil(minLat); lat <= Math.floor(maxLat); lat++) {
    const [,y] = project(lat, clon);
    if (y < 0 || y > H) continue;
    grid += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#CBD5E0" stroke-width="0.5" stroke-dasharray="3,3"/>`;
    grid += `<text x="3" y="${y-2}" font-size="8" fill="#9CA3AF" font-family="sans-serif">${lat}°N</text>`;
  }
  for (let lon = Math.ceil(minLon); lon <= Math.floor(maxLon); lon++) {
    const [x] = project(clat, lon);
    if (x < 10 || x > W) continue;
    grid += `<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="#CBD5E0" stroke-width="0.5" stroke-dasharray="3,3"/>`;
    grid += `<text x="${x+2}" y="${H-3}" font-size="8" fill="#9CA3AF" font-family="sans-serif">${Math.abs(lon)}°W</text>`;
  }

  // ── Major SE cities for geographic context ────────────────────────────────
  const CITIES = [
    [35.04,-85.31,"Chattanooga"],
    [33.75,-84.39,"Atlanta"],
    [36.17,-86.78,"Nashville"],
    [35.96,-83.92,"Knoxville"],
    [33.52,-86.80,"Birmingham"],
    [34.73,-86.59,"Huntsville"],
    [34.27,-85.23,"Rome GA"],
    [34.77,-84.97,"Dalton"],
    [35.47,-86.46,"Tullahoma"],
    [36.57,-87.36,"Clarksville"],
    [34.49,-84.95,"Calhoun"],
    [35.24,-85.17,"Soddy-Daisy"],
    [35.96,-80.00,"Winston-Salem"],
    [35.23,-80.84,"Charlotte"],
    [33.99,-81.03,"Columbia SC"],
  ];
  const cityDots = CITIES.map(([la, lo, name]) => {
    if (la < minLat || la > maxLat || lo < minLon || lo > maxLon) return "";
    const [x, y] = project(la, lo);
    const isMajor = ["Atlanta","Nashville","Knoxville","Charlotte","Birmingham"].includes(name);
    return `
      <circle cx="${x}" cy="${y}" r="${isMajor?3:2}" fill="#6B7280" stroke="white" stroke-width="0.5"/>
      <text x="${x+4}" y="${y+3}" font-size="${isMajor?8:7}" fill="#374151" font-family="sans-serif" font-weight="${isMajor?"bold":"normal"}">${name}</text>`;
  }).join("");

  // ── Interstate corridor lines ─────────────────────────────────────────────
  const CORR_SEGMENTS = [
    // I-75: FL→Atlanta→Dalton→Chatt→Knoxville
    [[25.8,-80.2],[30.0,-82.0],[32.5,-83.7],[33.7,-84.4],[34.3,-84.0],[34.8,-84.8],
     [35.05,-85.3],[35.17,-84.87],[35.46,-84.59],[35.96,-83.92],[36.6,-83.7],[37.0,-84.5]],
    // I-40: Memphis→Nashville→Knoxville→Asheville
    [[35.15,-90.0],[36.17,-86.78],[36.15,-85.5],[35.96,-83.92],[35.7,-82.5]],
    // I-24: Nashville→Chattanooga
    [[36.17,-86.78],[35.85,-86.4],[35.47,-86.1],[35.2,-85.5],[35.05,-85.3]],
    // I-59: Birmingham→Chattanooga
    [[33.5,-86.8],[33.98,-86.01],[34.44,-85.72],[34.9,-85.55],[35.05,-85.3]],
    // I-65: Mobile→Birmingham→Nashville
    [[30.7,-88.1],[32.4,-86.8],[33.5,-86.8],[36.17,-86.78]],
    // I-85: Atlanta→Charlotte
    [[33.7,-84.4],[34.3,-83.3],[34.7,-82.9],[35.2,-80.8]],
    // I-81: Kingsport→Knoxville
    [[36.6,-82.2],[36.1,-83.5],[35.96,-83.92]],
  ];
  const corridorLabels = [
    [[35.6,-85.05],"I-75"],[[ 36.1,-87.5],"I-65"],[[35.95,-85.0],"I-40"],
    [[35.2,-86.0],"I-24"],[[34.6,-85.6],"I-59"],[[34.5,-83.1],"I-85"],
  ];

  const corridorPaths = CORR_SEGMENTS.map(pts => {
    const d = pts.map(([la,lo],i) => {
      const [x,y] = project(la,lo);
      return (i===0?"M":"L")+x+","+y;
    }).join(" ");
    return `<path d="${d}" stroke="#3B82F6" stroke-width="2" fill="none" opacity="0.65" stroke-linecap="round"/>`;
  }).join("");

  const corridorLbls = corridorLabels.map(([[la,lo],name]) => {
    if (la<minLat||la>maxLat||lo<minLon||lo>maxLon) return "";
    const [x,y] = project(la,lo);
    return `<rect x="${x-9}" y="${y-7}" width="28" height="10" rx="2" fill="#1D4ED8" opacity="0.8"/>
            <text x="${x+5}" y="${y+1}" text-anchor="middle" font-size="7" fill="white" font-family="sans-serif" font-weight="bold">${name}</text>`;
  }).join("");

  // ── 200-mile radius + store marker ────────────────────────────────────────
  const rPx = Math.round((200 / 69) / latSpan * H);
  const [cx, cy] = project(clat, clon);

  // ── Threat dots ───────────────────────────────────────────────────────────
  const dots = threats.filter(t=>t.lat&&t.lon).slice(0,25).map(t => {
    const [x,y] = project(t.lat, t.lon);
    if (x<-10||x>W+10||y<-10||y>H+10) return "";
    const col = t.riskScore>=70?"#B91C1C":t.riskScore>=45?"#D97706":"#CA8A04";
    const r   = t.riskScore>=70?7:5;
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="${col}" stroke="white" stroke-width="1.5" opacity="0.9"/>`;
  }).join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <!-- Map background (light parchment) -->
    <rect width="${W}" height="${H}" fill="#F5F0E8"/>
    <!-- Grid -->
    ${grid}
    <!-- Corridors -->
    ${corridorPaths}
    ${corridorLbls}
    <!-- 200-mile alert ring -->
    <circle cx="${cx}" cy="${cy}" r="${rPx}" stroke="#B91C1C" stroke-width="1.5" stroke-dasharray="8,4" fill="#B91C1C" fill-opacity="0.05"/>
    <!-- Threat dots -->
    ${dots}
    <!-- City reference dots -->
    ${cityDots}
    <!-- Target store -->
    <circle cx="${cx}" cy="${cy}" r="11" fill="#0071CE" stroke="white" stroke-width="2.5"/>
    <text x="${cx}" y="${cy+4}" text-anchor="middle" font-size="9" font-weight="bold" fill="white" font-family="sans-serif">${target.store}</text>
    <!-- Legend -->
    <rect x="4" y="${H-22}" width="260" height="18" rx="3" fill="white" fill-opacity="0.75"/>
    <circle cx="14" cy="${H-13}" r="5" fill="#B91C1C"/>
    <text x="22" y="${H-9}" font-size="8" fill="#374151" font-family="sans-serif">High risk</text>
    <circle cx="62" cy="${H-13}" r="5" fill="#D97706"/>
    <text x="70" y="${H-9}" font-size="8" fill="#374151" font-family="sans-serif">Medium</text>
    <circle cx="108" cy="${H-13}" r="5" fill="#CA8A04"/>
    <text x="116" y="${H-9}" font-size="8" fill="#374151" font-family="sans-serif">Low</text>
    <circle cx="150" cy="${H-13}" r="5" fill="#0071CE"/>
    <text x="158" y="${H-9}" font-size="8" fill="#374151" font-family="sans-serif">Your store</text>
    <line x1="198" y1="${H-13}" x2="218" y2="${H-13}" stroke="#3B82F6" stroke-width="2"/>
    <text x="222" y="${H-9}" font-size="8" fill="#374151" font-family="sans-serif">Interstate</text>
  </svg>`;

  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

async function _openReport(data, storeNum, capturedMapImg) {
  const threats = (data.threats ?? []).slice(0, 20);
  const target  = data.target ?? {};
  // Store compact data; report.js generates the full HTML
  await chrome.storage.session.set({
    "orcmonitor.report_data": {
      threats,
      target,
      storeNum,
      generatedAt: new Date().toISOString(),
      mapPng: capturedMapImg ?? null,
    }
  });
  chrome.tabs.create({ url: chrome.runtime.getURL("modules/orcmonitor/report.html") });
}

function _setStatus(c, msg) {
  c.querySelector("#om-progress-label").textContent = msg;
  c.querySelector("#om-progress-bar").classList.remove("hidden");
}

function _renderSummary(c, threats, data) {
  const high = threats.filter(t=>t.riskScore>=70).length;
  const med  = threats.filter(t=>t.riskScore>=45&&t.riskScore<70).length;
  c.querySelector("#om-summary-pills").innerHTML = [
    high?`<span class="pill pill-error">⚠ ${high} HIGH risk</span>`:"",
    med?`<span class="pill pill-warn">${med} medium</span>`:"",
    `<span class="pill pill-info">${threats.length} threats · ${data.totalPersons??0} persons scanned</span>`,
  ].join("");
}

function _renderCards(c, threats) {
  const el = c.querySelector("#om-cards-container");
  el.innerHTML = threats.length
    ? threats.slice(0,40).map(_cardHTML).join("")
    : `<p class="muted" style="padding:24px">No ORC threats detected within 250 miles.</p>`;
}

function _cardHTML(t) {
  const level = t.riskScore>=70?"high":t.riskScore>=45?"medium":"low";
  const rc    = t.riskScore>=70?"#B91C1C":t.riskScore>=45?"#D97706":"#CA8A04";
  const lc    = (t.lastSeenDays??99)<=14?"#B91C1C":(t.lastSeenDays??99)<=30?"#D97706":"var(--apai-muted,#6B7280)";

  const photo = (t.photos??[]).length
    ? `<img src="${t.photos[0]}" style="width:72px;height:72px;object-fit:cover" onerror="this.parentElement.innerHTML='👤'">`
    : "👤";

  const maxH = Math.max(...(t.hourCounts??[0]),1);
  const bars = (t.hourCounts??new Array(24).fill(0)).map((v,h) => {
    const pct = Math.round((v/maxH)*100);
    const col = h>=14&&h<=20?"#D97706":h>=10?"#CA8A04":"#E5E7EB";
    return `<div class="om-tod-bar" style="height:${Math.max(pct,3)}%;background:${v>0?col:"#F0F1F4"}" title="${h}:00"></div>`;
  }).join("");

  const hist = (t.storeHistory??[]).slice(0,5).map(s => {
    const isT = s.store?.includes("1458");
    return `<div class="om-ev-row${isT?" om-ev-target":""}">
      <span>${(s.store??"?").split(" - ")[0]}</span>
      <span style="color:#0071CE">${s.date??""}</span>
      <span>${s.dist??"?"} mi</span>
    </div>`;
  }).join("");

  const moPills = Object.entries(t.moBreakdown??{}).sort((a,b)=>b[1]-a[1]).slice(0,3)
    .map(([k,v]) => `<span class="om-mo-pill">${k} ×${v}</span>`).join("");
  const orcTags = (t.orcCorridors??[]).slice(0,2)
    .map(c => `<span class="om-corridor-tag">${c.replace("ORC CORRIDOR ","")}</span>`).join(" ");

  return `
<div class="om-card om-card-${level}" data-person-id="${t.personId??""}" style="cursor:pointer">
  <div class="om-card-top">
    <div class="om-card-photo">${photo}</div>
    <div class="om-card-main">
      <div class="om-card-name"><a href="${t.aurorUrl}" target="_blank" onclick="event.stopPropagation()">${t.name}</a></div>
      <div class="om-card-sub">${t.physicalDesc??""}</div>
      <div class="om-card-lastseen">Last seen <strong style="color:${lc}">${t.lastSeenDays??"?"}d ago</strong> at <strong>${(t.lastSeenStore??"?").split(" - ")[0]}</strong> <span class="muted">${t.lastSeenDate??""}</span>
        ${t.trajReason==="local_operator"?`<span style="font-size:9px;color:#D97706;margin-left:4px">⚠ Local operator</span>`:""}
        ${t.corridorAligned?`<span style="font-size:9px;color:#0071CE;margin-left:4px">↗ Corridor aligned</span>`:""}
      </div>
      <div class="om-card-meta">
        <div class="om-meta-item"><strong>$${(t.totalValue??0).toLocaleString("en-US",{minimumFractionDigits:2})}</strong><span>Value</span></div>
        <div class="om-meta-item"><strong>${t.eventCount??0}</strong><span>Events</span></div>
        <div class="om-meta-item"><strong>${t.primaryMo??"?"}</strong><span>MO</span></div>
        <div class="om-meta-item"><strong>${t.peakHours??"?"}</strong><span>Peak</span></div>
      </div>
      <div class="cluster" style="gap:4px;margin-top:5px">${moPills}</div>
      ${orcTags?`<div style="margin-top:4px;display:flex;gap:3px;flex-wrap:wrap">${orcTags}</div>`:""}
      ${t.threatening?`<div class="om-threat-flag">⚠ THREATENING BEHAVIOR ON FILE</div>`:""}
      ${(t.accompliceCount??0)>0?`<div class="muted" style="font-size:11px">👥 ${t.accompliceCount} accomplice${t.accompliceCount>1?"s":""}</div>`:""}
      ${(t.vehicles??[]).length?`<div class="muted" style="font-size:11px">🚗 ${(t.vehicles??[]).slice(0,2).join(", ")}</div>`:""}
    </div>
    <div class="om-card-right">
      <div class="om-risk-score" style="color:${rc}">${t.riskScore??0}</div>
      <div class="muted" style="font-size:9px;text-align:center">RISK</div>
      <div class="om-eta-badge om-eta-${level}">${t.etaDays?`ETA ~${t.etaDays}d · ${t.etaDate}`:"ETA Unknown"}</div>
      <div class="muted" style="font-size:11px">${t.currentDist??""} mi away</div>
      ${t.corridor?`<span class="om-corridor-pill">${t.corridor}</span>`:""}
      <a class="om-auror-link" href="${t.aurorUrl}" target="_blank" onclick="event.stopPropagation()">Open in Auror →</a>
    </div>
  </div>
  <div class="om-card-bottom">
    <div class="om-ev-list">
      <div class="om-ev-header">STORE HISTORY — newest first (within 300 mi)</div>
      ${hist||`<div class="muted" style="font-size:11px">No history available</div>`}
      ${(t.distantStoreCount??0)>0?`<div class="muted" style="font-size:10px;margin-top:3px">+ ${t.distantStoreCount} store${t.distantStoreCount>1?"s":""} &gt;300 mi away</div>`:""}
    </div>
    <div class="om-tod">
      <div class="om-tod-label">TIME OF DAY</div>
      <div class="om-tod-bars">${bars}</div>
      <div class="muted" style="font-size:9px">Peak: ${t.peakHours??""}</div>
    </div>
  </div>
</div>`;
}
