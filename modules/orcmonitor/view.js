// modules/orcmonitor/view.js
// ORC Corridor Monitor — map + three panels (Stores at risk / Groups / People).
//
// The SW gathers Auror data (people, their dated hits, who offended together).
// Everything route-shaped happens here, in the page: groups, the interstate
// legs they drove, heading, and the forecast of stores ahead (lib/forecast.js
// over lib/routes.js). Keeping the ~0.5 MB of bundled geography out of the SW
// means it is only loaded when someone opens this module.
//
// Basemap: USGS National Map tiles (public domain, no key, CORS-enabled).
// OpenStreetMap's volunteer tile servers started answering this extension with
// an "Access blocked" tile (their usage policy bars app traffic), which is why
// the map went blank. The states/interstates/cities are also drawn from bundled
// vectors, so if USGS is ever unreachable the map still reads.

import { getStoreCoords, STORE_COORDS } from "./lib/store_coords.js";
import { getUserHomeStore, getUserHomeMarket } from "../../shared/userStore.js";
import { INTERSTATES }                  from "./lib/geo_interstates.js";
import { STATES }                       from "./lib/geo_states.js";
import { CITIES }                       from "./lib/geo_cities.js";
import { buildGroups, analyzeGroup, storesAtRisk, storeNum, storeLabel } from "./lib/forecast.js";
import { snap, reachForward, pathTo, haversine } from "./lib/routes.js";
import { loadResult, saveReport }      from "./lib/cache.js";
import { withWeekday }                 from "../../shared/dates.js";

const PROGRESS_KEY = "orcmonitor.progress";
const CATALOG_KEY  = "siteCatalog";          // host.storage.local, namespaced

const USGS = "https://basemap.nationalmap.gov/arcgis/rest/services";
const BASEMAPS = {
  "USGS Topo":         `${USGS}/USGSTopo/MapServer/tile/{z}/{y}/{x}`,
  "USGS Imagery":      `${USGS}/USGSImageryTopo/MapServer/tile/{z}/{y}/{x}`,
  "USGS Shaded relief":`${USGS}/USGSShadedReliefOnly/MapServer/tile/{z}/{y}/{x}`,
};
const USGS_ATTR = 'Basemap: <a href="https://www.usgs.gov/programs/national-geospatial-program/national-map" target="_blank">USGS The National Map</a> · Roads: Natural Earth';

const RISK_COLOR = s => s >= 70 ? "#B91C1C" : s >= 45 ? "#D97706" : "#CA8A04";
const NEXT_COLOR = "#7C3AED";
const NEAR_MI    = 100;       // "Near my store" scope of the at-risk list
const LIST_MAX   = 20;
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));

export async function mount(host, container) {
  const styleLink = document.createElement("link");
  styleLink.rel  = "stylesheet";
  styleLink.href = host.url("styles.css");
  document.head.appendChild(styleLink);

  container.innerHTML = await fetch(host.url("view.html")).then(r => r.text());
  const $ = sel => container.querySelector(sel);

  const homeStore = await getUserHomeStore().catch(() => null);
  if (!$("#om-store").value.trim() && homeStore) $("#om-store").value = homeStore;

  await _loadLeaflet(host);
  const mapCtl = _initMap(container);
  const map = mapCtl?.map ?? null;

  // Centre on the home store (Settings > Defaults) from the start: its pin and
  // rings go up before any analysis. Coordinates come from the built-in table,
  // then the saved store catalog, then the SW's cached list of every SE store.
  const home = { store: homeStore, lat: null, lon: null };
  const coordsOf = async num => {
    const n = String(num ?? "").trim();
    if (!/^\d{1,5}$/.test(n)) return null;
    const fixed = getStoreCoords(n);
    if (fixed) return fixed;
    try {
      const cat = (await host.storage.local.get(CATALOG_KEY)) ?? {};
      const c = cat[String(Number(n))];
      if (c?.lat && c?.lon) return [c.lat, c.lon];
    } catch {}
    try {
      const r = await host.messaging.sendRaw("storeCoords", { store: n }, { timeoutMs: 30_000 });
      const d = r?.data ?? r;
      if (Array.isArray(d?.coords)) return d.coords;
    } catch {}
    return null;
  };
  const showStore = async (num, { recenter = true } = {}) => {
    const c = await coordsOf(num);
    if (!c || !map) return null;
    _renderBase(map, mapCtl, { store: String(num).trim(), lat: c[0], lon: c[1] }, { recenter });
    return c;
  };
  if (map) {
    setTimeout(() => map.invalidateSize(), 200);
    setTimeout(() => map.invalidateSize(), 700);
    const start = ($("#om-store").value ?? "").trim();
    const c = await showStore(start);
    setTimeout(() => showSaved(start), 0);   // after the state below exists
    if (c && start === String(homeStore ?? "")) { home.lat = c[0]; home.lon = c[1]; }
    _addHomeControl(map, () => {
      const t = home.lat != null ? home : st.data?.target;
      if (t?.lat != null) map.setView([t.lat, t.lon], 8, { animate: true });
    }, homeStore ? `Center on your store (${homeStore})` : "Center on the target store");
    // Typing another store moves the pin there and shows its last saved run.
    $("#om-store").addEventListener("change", async () => {
      const v = ($("#om-store").value ?? "").trim();
      if (!await showSaved(v)) { st.data = null; showStore(v); }
    });
  }

  // ── State ──────────────────────────────────────────────────────────────────
  const st = {
    days: 30, tab: "groups",
    data: null,            // SW result
    groups: [], atRisk: [], storeScope: "market",
    sel: { store: null, group: null, person: null },
    snapCache: new Map(),
  };
  let progressInterval = null;
  const dyn = map ? L.layerGroup().addTo(map) : null;   // everything result-driven

  // The last run for this store is kept locally (lib/cache.js): show it at
  // once, and let Analyze fetch only what changed since.
  async function showSaved(storeNum, { exact = false } = {}) {
    if (!/^\d{1,5}$/.test(String(storeNum ?? ""))) return false;
    const saved = await loadResult(storeNum, st.days).catch(() => null);
    if (!saved?.result?.threats) return false;
    const r = saved.result;
    if (exact && r.days !== st.days) return false;
    if (r.days && r.days !== st.days) {
      st.days = r.days;
      container.querySelectorAll(".om-days-btn").forEach(b => b.classList.toggle("is-active", Number(b.dataset.days) === r.days));
    }
    st.sel = { store:null, group:null, person:null };
    await applyResult(r, true);
    _setStatus(`Saved ${_ago(saved.savedAt)} · ${_resultLine(r, st.groups.length)} — Analyze to update (only new events are fetched)`);
    return true;
  }

  container.querySelectorAll(".om-days-btn").forEach(btn =>
    btn.addEventListener("click", () => {
      container.querySelectorAll(".om-days-btn").forEach(b => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      st.days = parseInt(btn.dataset.days, 10);
      if (!progressInterval) showSaved(($("#om-store").value ?? "").trim(), { exact: true });
    }));

  container.querySelectorAll(".om-tab").forEach(btn =>
    btn.addEventListener("click", () => setTab(btn.dataset.tab)));

  function setTab(tab) {
    st.tab = tab;
    container.querySelectorAll(".om-tab").forEach(b => b.classList.toggle("is-active", b.dataset.tab === tab));
    renderPanel(); renderMap();
  }

  // ── Auror token badge ──────────────────────────────────────────────────────
  const badge = $("#om-token-badge");
  async function checkToken() {
    try {
      const r = await host.messaging.sendRaw("getStatus", {});
      const d = r?.data ?? r;
      if (d?.tokenReady) {
        badge.textContent = `✓ Auror Connected${d?.cachedProfiles ? ` · ${d.cachedProfiles} people, ${d.cachedEvents ?? 0} events saved locally` : ""}`;
        badge.className = "om-badge om-badge-ok";
        if (!progressInterval) $("#om-btn-analyze").disabled = false;
      } else {
        badge.textContent = "⏳ Connecting to Auror…";
        badge.className = "om-badge om-badge-warn";
        $("#om-btn-analyze").disabled = true;
      }
    } catch {}
  }
  await checkToken();
  const tokenPoll = setInterval(checkToken, 15_000);

  // ── Analyze ────────────────────────────────────────────────────────────────
  $("#om-btn-analyze").addEventListener("click", async () => {
    const store = ($("#om-store").value ?? "").trim();
    if (!store) return;
    host.usage.record("analyze_threats");
    const btn = $("#om-btn-analyze");
    btn.disabled = true; btn.textContent = "Analyzing…";
    st.data = null; st.groups = []; st.atRisk = [];
    st.sel = { store:null, group:null, person:null };
    _startProgress();

    let resp;
    try {
      const full = !!$("#om-full")?.checked;
      resp = await host.messaging.sendRaw("analyzeThreats", { targetStore:store, days:st.days, full }, { timeoutMs:900_000 });
      if ($("#om-full")) $("#om-full").checked = false;
    } catch (e) {
      _stopProgress(); btn.disabled = false; btn.textContent = "Analyze";
      _setStatus(`Error: ${e?.message ?? e}`); return;
    }
    _stopProgress(); btn.disabled = false; btn.textContent = "Analyze";
    const data = resp?.data ?? resp;
    if (!data || resp?.ok === false || data?.ok === false) {
      _setStatus(resp?.error ?? data?.error ?? "Failed — ensure Auror is open in Edge"); return;
    }
    await applyResult(data, true);
    _setStatus(_resultLine(data, st.groups.length));
  });

  async function applyResult(data, final) {
    st.data = data;
    const catalog = await _updateCatalog(host, data);
    const stores = Object.values(catalog).filter(s => s.lat && s.lon);
    // The market first: group risk is risk to this store and its market.
    st.market = _marketScope(data, stores, await getUserHomeMarket().catch(() => null));
    const ctx = { target: data.target, stores, snapCache: st.snapCache,
                  market: { short: st.market.short, stores: new Set(st.market.stores) } };
    const threats = data.threats ?? [];
    st.groups = buildGroups(threats, data.links ?? [])
      .map(g => analyzeGroup(g, ctx))
      .sort((a, b) => (a.inactive - b.inactive) || b.risk - a.risk || b.weight - a.weight);
    st.groups.forEach((g, i) => { g.id = `g${i + 1}`; });
    st.atRisk = storesAtRisk(st.groups);
    st.marketStores = stores.filter(s => st.market.stores.includes(s.num));
    // Person → group lookup for the People tab.
    st.personGroup = new Map();
    for (const g of st.groups) for (const m of g.members) st.personGroup.set(String(m.personId), g);

    if (map && data.target) _renderBase(map, mapCtl, data.target);
    renderSummary(); renderPanel(); renderMap();
    // Frame the market once per store (after _renderBase's own recentre),
    // wide enough to show what is approaching it.
    if (map && final && st.marketStores.length && st.framedFor !== data.target.store) {
      st.framedFor = data.target.store;
      setTimeout(() => {
        const pts = [...st.marketStores.map(s => [s.lat, s.lon]), [data.target.lat, data.target.lon]];
        map.fitBounds(L.latLngBounds(pts).pad(0.9), { maxZoom: 9, animate: false });
      }, 150);
    }
    $("#om-btn-export").disabled = !(final && threats.length);
  }

  // ── Selection ──────────────────────────────────────────────────────────────
  function select(kind, id) {
    const cur = st.sel[kind];
    st.sel = { store:null, group:null, person:null };
    st.sel[kind] = cur === id ? null : id;
    renderPanel(); renderMap(true);
  }

  $("#om-panel").addEventListener("click", e => {
    const scope = e.target.closest("[data-scope]");
    if (scope) { st.storeScope = scope.dataset.scope; st.sel.store = null; renderSummary(); renderPanel(); renderMap(true); return; }
    const jump = e.target.closest("[data-jump-group]");
    if (jump) { e.preventDefault(); setTab("groups"); select("group", jump.dataset.jumpGroup); return; }
    if (e.target.closest("a")) return;
    const row = e.target.closest("[data-kind]");
    if (row) select(row.dataset.kind, row.dataset.id);
  });

  // ── Panels ─────────────────────────────────────────────────────────────────
  function renderSummary() {
    const threats = st.data?.threats ?? [];
    const mkt = st.market?.short ?? "your market";
    const highG = st.groups.filter(g => !g.inactive && g.risk >= 70).length;
    const headedIn = st.groups.filter(g => g.market?.headedIn).length;
    const hitMkt = st.groups.filter(g => !g.inactive && g.market?.hits).length;
    const target = st.data?.target?.store;
    const mktList = _visibleRisk({ ...st, storeScope: "market" });
    const mine = mktList.findIndex(s => s.num === String(Number(target)));
    $("#om-summary-pills").innerHTML = [
      highG ? `<span class="pill pill-error">⚠ ${highG} high-risk group${highG === 1 ? "" : "s"} for ${esc(mkt)}</span>` : "",
      headedIn ? `<span class="pill pill-warn">${headedIn} group${headedIn === 1 ? "" : "s"} headed into ${esc(mkt)}</span>` : "",
      hitMkt ? `<span class="pill pill-warn">${hitMkt} group${hitMkt === 1 ? " has" : "s have"} hit ${esc(mkt)} in 90 days</span>` : "",
      mine >= 0 ? `<span class="pill pill-error">Store ${esc(target)} is #${mine + 1} of ${mktList.length} at-risk ${esc(mkt)} stores</span>` : "",
      `<span class="pill pill-info">${st.groups.length} groups · ${threats.length} people · ${st.data?.totalPersons ?? 0} scanned</span>`,
    ].join("");
    const vis = _visibleRisk(st).length;
    $("#om-count-stores").textContent = vis ? `(${vis})` : "";
    $("#om-count-groups").textContent = st.groups.length ? `(${st.groups.length})` : "";
    $("#om-count-people").textContent = threats.length ? `(${threats.length})` : "";
  }

  function renderPanel() {
    const el = $("#om-panel");
    if (!st.data) return;
    if (st.tab === "stores") el.innerHTML = _storesPanel(st);
    else if (st.tab === "groups") el.innerHTML = _groupsPanel(st);
    else el.innerHTML = _peoplePanel(st);
    const selEl = el.querySelector(".is-selected");
    if (selEl) selEl.scrollIntoView({ block:"nearest" });
  }

  // ── Map layers for the current tab/selection ───────────────────────────────
  function renderMap(fit = false) {
    if (!map || !dyn) return;
    dyn.clearLayers();
    const d = st.data;
    if (!d?.target) return;
    const bounds = [];

    // The market's stores, always: the footprint every risk number is about.
    for (const ms of st.marketStores ?? []) {
      L.marker([ms.lat, ms.lon], { zIndexOffset: -200, keyboard:false, icon: L.divIcon({ className:"", iconSize:[12,12], iconAnchor:[6,6],
        html:`<div class="om-mkt-store"></div>` }) })
        .bindTooltip(`${esc(st.market?.short ?? "Market")} · ${esc(storeLabel(ms.name))}`)
        .addTo(dyn);
    }

    const ROUTE = "#0B5CAD";
    const drawGroupRoute = (g, strong) => {
      // Legs actually driven: along the network when we could route them.
      // Strong = the selected group: white casing, heavier line, arrows, dated stops.
      g.legs.forEach(leg => {
        const pts = leg.onNetwork && leg.path?.length ? leg.path
          : [[leg.from.lat, leg.from.lon], [leg.to.lat, leg.to.lon]];
        const tip = `${esc(storeLabel(leg.from.site))} → ${esc(storeLabel(leg.to.site))}<br>${esc(leg.summary)} · ${leg.miles} mi · ${leg.days} d`;
        if (strong) L.polyline(pts, { color:"#fff", weight:9, opacity:0.95, interactive:false }).addTo(dyn);
        L.polyline(pts, { color:ROUTE, weight: strong ? 4.5 : 2.5, opacity: strong ? 1 : 0.6,
                          dashArray: leg.onNetwork ? null : (strong ? "1 8" : "3 5"), lineCap:"round" })
          .bindTooltip(tip, { sticky:true }).addTo(dyn);
        if (strong) {
          _arrowsAlong(pts, leg.miles > 80 ? [1/3, 2/3] : [0.5], ROUTE).forEach(a => a.addTo(dyn));
          bounds.push(...pts);
        }
      });
      if (!strong) return;
      g.stops.forEach((s, i) => {
        const lastOne = i === g.stops.length - 1;
        L.marker([s.lat, s.lon], { zIndexOffset: 500 + i, icon: L.divIcon({ className:"", iconSize:[22,22], iconAnchor:[11,11],
          html:`<div class="om-stop-icon">${i + 1}</div>` }) })
          .bindTooltip(`${lastOne ? "Last hit " : ""}${esc(_short(s.dateTo))} · ${esc(storeLabel(s.site).replace(/,.*$/, ""))}`, { permanent:true, direction:"left", offset:[-10,0], className:"om-stop-label" })
          .addTo(dyn);
        // A second, hover-only tooltip would replace the permanent one; put the detail on the leg lines instead.
        bounds.push([s.lat, s.lon]);
      });
    };

    const drawForecast = (g, count, strong = true) => {
      if (!g.last) return;
      const lastSnap = st.snapCache.get(g.last.num ? `n${g.last.num}` : null) ?? snap(g.last.lat, g.last.lon);
      let reach = null;
      if (lastSnap && lastSnap.off <= 25) {
        const lastLeg = [...g.legs].reverse().find(l => l.onNetwork);
        reach = reachForward(lastSnap, { heading: g.mode === "traveling" ? lastLeg?.lastEdge : null, limit: 300 });
      }
      g.next.slice(0, count).forEach((s, i) => {
        const ss = st.snapCache.get(`n${s.num}`);
        const pts = reach && ss && s.via === "interstate" ? pathTo(reach, ss) : [];
        const line = pts.length ? [[g.last.lat, g.last.lon], ...pts, [s.lat, s.lon]]
                                : [[g.last.lat, g.last.lon], [s.lat, s.lon]];
        if (strong) L.polyline(line, { color:"#fff", weight:7, opacity:0.9, interactive:false }).addTo(dyn);
        L.polyline(line, { color:NEXT_COLOR, weight: i === 0 ? 3.5 : 2.5, opacity: i === 0 ? 0.95 : 0.7, dashArray:"8 7", lineCap:"round" }).addTo(dyn);
        if (strong && i === 0) _arrowsAlong(line, [0.55], NEXT_COLOR).forEach(a => a.addTo(dyn));
      });
    };

    const rankMarker = (s, rank, tip) => {
      L.marker([s.lat, s.lon], { zIndexOffset: 800 - rank, icon: L.divIcon({ className:"", iconSize:[20,20], iconAnchor:[10,10],
        html:`<div class="om-rank-icon">${rank}</div>` }) })
        .bindTooltip(tip).on("click", () => { if (st.tab === "stores") select("store", s.num); })
        .addTo(dyn);
    };

    const groupDot = (g, faded) => {
      if (!g.last) return;
      L.circleMarker([g.last.lat, g.last.lon], {
        radius: g.members.length > 1 ? 9 : 7, color:"#fff", weight:1.5,
        fillColor: RISK_COLOR(g.risk), fillOpacity: faded ? 0.35 : 0.9,
      }).bindTooltip(`<b>${esc(g.label)}</b><br>${esc(_modeLine(g))}<br>Last hit ${esc(g.lastDate)} at ${esc(storeLabel(g.last.site))}`)
        .on("click", () => { setTab("groups"); select("group", g.id); })
        .addTo(dyn);
    };

    if (st.tab === "stores") {
      const list = _visibleRisk(st);
      const selStore = st.sel.store && list.find(s => s.num === st.sel.store);
      const involved = selStore ? new Set(selStore.groups.map(x => x.id)) : null;
      for (const g of st.groups) {
        if (involved && !involved.has(g.id)) continue;
        if (involved) { drawGroupRoute(g, false); drawForecast(g, g.next.findIndex(n => n.num === selStore.num) + 1); }
        groupDot(g, false);
      }
      list.forEach((s, i) => {
        if (selStore && s.num !== selStore.num) return;
        rankMarker(s, i + 1, `<b>#${i + 1} ${esc(storeLabel(s.name))}</b><br>${s.groups.length} group${s.groups.length === 1 ? "" : "s"} heading this way`);
        bounds.push([s.lat, s.lon]);
      });
      if (selStore) for (const g of st.groups) if (involved.has(g.id) && g.last) bounds.push([g.last.lat, g.last.lon]);
    } else if (st.tab === "groups") {
      const selG = st.sel.group && st.groups.find(g => g.id === st.sel.group);
      if (selG) {
        drawGroupRoute(selG, true);
        if (!selG.inactive) drawForecast(selG, 3);
        (selG.inactive ? [] : selG.next).forEach((s, i) => {
          if (i === 0) L.marker([s.lat, s.lon], { opacity:0, interactive:false, icon: L.divIcon({ className:"", iconSize:[1,1] }) })
            .bindTooltip(`Most likely next: ${esc(storeLabel(s.name))} · ${s.routeMiles} mi`, { permanent:true, direction:"right", offset:[12,0], className:"om-next-label" })
            .addTo(dyn);
          rankMarker(s, i + 1, `<b>${i + 1}. ${esc(storeLabel(s.name))}</b><br>${s.routeMiles} mi ${s.via === "interstate" ? "by interstate" : "local"} · ${s.share}% of this group's forecast${s.due ? "<br>due now" : s.etaDate ? `<br>around ${esc(_short(s.etaDate))}` : ""}`);
          bounds.push([s.lat, s.lon]);
        });
        groupDot(selG, false);
      } else {
        // No selection: positions only. Every route at once is unreadable.
        for (const g of st.groups) groupDot(g, g.inactive);
      }
    } else {
      const threats = d.threats ?? [];
      const selP = st.sel.person && threats.find(t => String(t.personId) === st.sel.person);
      for (const t of threats.slice(0, 60)) {
        if (!t.lat || !t.lon) continue;
        if (selP && t !== selP) continue;
        if (selP) {
          const g = st.personGroup.get(String(t.personId));
          if (g) { drawGroupRoute(g, true); if (!g.inactive) drawForecast(g, 3); (g.inactive ? [] : g.next).forEach((s, i) => rankMarker(s, i + 1, `${i + 1}. ${esc(storeLabel(s.name))} · ${s.routeMiles} mi`)); }
        }
        L.circleMarker([t.lat, t.lon], { radius: selP ? 10 : 7, color:"#fff", weight:1.5,
          fillColor: RISK_COLOR(t.riskScore), fillOpacity:0.9 })
          .bindTooltip(`<b>${esc(t.name)}</b><br>Risk ${t.riskScore} · last offence ${t.lastOffenceDays ?? t.lastSeenDays ?? "?"}d ago`)
          .on("click", () => select("person", String(t.personId)))
          .addTo(dyn);
      }
    }

    mapCtl.setFocus?.(!!(st.sel.group || st.sel.person || st.sel.store));
    if (fit && bounds.length) {
      bounds.push([d.target.lat, d.target.lon]);
      // No animation: the canvas renderer clips to the pre-animation view and
      // leaves gaps in long routes until the next pan.
      map.fitBounds(L.latLngBounds(bounds).pad(0.12), { maxZoom: 9, animate: false });
    }
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  $("#om-btn-export")?.addEventListener("click", async () => {
    if (!st.data) return;
    const btn = $("#om-btn-export");
    btn.disabled = true; btn.textContent = "Capturing map…";
    const prev = { tab: st.tab, sel: st.sel };
    // The brief's map shows the at-risk stores with every group's position.
    st.tab = "stores"; st.sel = { store:null, group:null, person:null };
    // Capture at a fixed page-shaped size, whatever the window is: the brief
    // stretches the image to page width, so a narrow on-screen map printed tall.
    const mapEl = $("#om-map");
    const prevStyle = mapEl?.getAttribute("style") ?? "";
    const view = map ? { c: map.getCenter(), z: map.getZoom() } : null;
    try {
      if (map) {
        mapEl.style.cssText = "position:fixed;left:-12000px;top:0;width:1100px;height:620px;";
        map.invalidateSize({ animate:false });
      }
      renderMap();
      if (map) map.setView([st.data.target.lat, st.data.target.lon], 7, { animate:false });
      const mapImg = await _captureMapImage(container, map, mapCtl).catch(err => { console.warn("[orcmonitor] map capture:", err); return null; });
      if (map) { mapEl.setAttribute("style", prevStyle); map.invalidateSize({ animate:false }); map.setView(view.c, view.z, { animate:false }); }
      st.tab = prev.tab; st.sel = prev.sel; renderMap();
      btn.textContent = "Preparing photos…";
      await _openReport(st, ($("#om-store").value ?? "").trim(), mapImg);
    } catch (err) {
      console.error("[orcmonitor] export:", err);
      if (map && mapEl.getAttribute("style") !== prevStyle) { mapEl.setAttribute("style", prevStyle); map.invalidateSize({ animate:false }); }
      st.tab = prev.tab; st.sel = prev.sel; renderMap();
      _setStatus(`Export failed: ${err?.message ?? err}`);
    } finally {
      btn.disabled = false; btn.textContent = "Export PDF";
    }
  });

  // ── Progress (partial results stream in through session storage) ─────────
  function _startProgress() {
    $("#om-progress-bar").classList.remove("hidden");
    let lastCount = -1;
    progressInterval = setInterval(async () => {
      const got = await chrome.storage.session.get(PROGRESS_KEY).catch(() => ({}));
      const p = got?.[PROGRESS_KEY] ?? {};
      const total = p.personsToProfile || p.personsFound || 0;
      const pct = p.stage === "events"
        ? Math.min(30, 3 + (p.regionsChecked ?? 0) * 3.5)
        : Math.min(97, 30 + (total ? (p.profilesDone ?? 0) / total * 67 : 0));
      $("#om-progress-fill").style.width = pct + "%";
      $("#om-progress-label").textContent = p.stage === "events"
        ? (p.eventsNew != null
            ? `${p.eventsScanned} events listed · fetching ${p.eventsNew} new/updated (${p.eventsFetched ?? 0} done), the rest from local data`
            : `Listing ${p.regionsChecked ?? 0}/${p.regionsTotal ?? 8} SE regions… ${p.eventsScanned ?? 0} events`)
        : `People ${p.profilesDone ?? 0} / ${total || "?"} · ${p.profilesFetched ?? 0} of ${p.profilesNew ?? "?"} changed profiles fetched` +
          `${(p.partialThreats?.length ?? 0) ? ` · ${p.partialThreats.length} within range` : ""}`;
      const partial = p.partialThreats ?? [];
      // Re-run the (cheap) group analysis every few new people.
      if (p.target && partial.length && partial.length - lastCount >= 3) {
        lastCount = partial.length;
        await applyResult({ target:p.target, threats:partial, links:p.links ?? [], sites:[], totalPersons:p.personsFound }, false);
      }
    }, 1500);
  }
  function _stopProgress() {
    clearInterval(progressInterval); progressInterval = null;
    $("#om-progress-fill").style.width = "100%";
    setTimeout(() => $("#om-progress-bar").classList.add("hidden"), 600);
  }
  function _setStatus(msg) {
    $("#om-progress-label").textContent = msg;
    $("#om-progress-bar").classList.remove("hidden");
  }

  return () => {
    clearInterval(tokenPoll); clearInterval(progressInterval);
    styleLink.remove(); try { map?.remove(); } catch {}
  };
}

// ── Panels (HTML) ─────────────────────────────────────────────────────────────

function _visibleRisk(st) {
  const t = st.data?.target;
  const mset = new Set(st.market?.stores ?? []);
  const list = st.storeScope === "market" ? st.atRisk.filter(s => mset.has(s.num))
    : st.storeScope === "near" && t ? st.atRisk.filter(s => haversine(t.lat, t.lon, s.lat, s.lon) <= NEAR_MI)
    : st.atRisk;
  const top = list[0]?.score || 1;
  return list.slice(0, LIST_MAX).map(s => ({ ...s, index: Math.round(s.score / top * 100) }));
}

function _storesPanel(st) {
  const t = st.data?.target;
  const scope = `<div class="btn-group om-scope">
      <button class="btn-group-item${st.storeScope === "market" ? " is-active" : ""}" data-scope="market">${esc(st.market?.short ?? "My market")}</button>
      <button class="btn-group-item${st.storeScope === "near" ? " is-active" : ""}" data-scope="near">Within ${NEAR_MI} mi of ${esc(t?.store ?? "")}</button>
      <button class="btn-group-item${st.storeScope === "all" ? " is-active" : ""}" data-scope="all">Whole Southeast</button>
    </div>`;
  const list = _visibleRisk(st);
  if (!list.length) {
    const where = st.storeScope === "market" ? `in ${esc(st.market?.short ?? "your market")} `
                : st.storeScope === "near" ? `within ${NEAR_MI} miles ` : "";
    return scope + `<div class="om-empty">No store ${where}is in any active group's forecast right now.
      ${st.storeScope !== "all" ? "Nothing currently points this way — widen the scope, or try" : "Try"} a 60 or 90 day lookback for a fuller picture.</div>`;
  }
  return scope + _storesList(st, list);
}

function _storesList(st, list) {
  if (!list.length) {
    return `<div class="om-empty">No store forecast yet. Groups need at least one dated hit near the interstate network
      within reach; widen the lookback to 60 or 90 days for a fuller picture.</div>`;
  }
  const target = String(Number(st.data?.target?.store));
  return `<p class="om-intro">Stores most likely to be hit next, from every group's recent route: where each group was last,
    which way it was driving, how far it usually moves between hits, and the stores ahead of it on the interstate
    network. Click a store to see which groups point at it.</p>` +
    list.map((s, i) => {
      const who = s.groups.slice(0, 3).map(x =>
        `<b>${esc(x.label)}</b> — ${x.routeMiles} mi${x.heading ? ` via ${esc(x.heading)}` : ""}, last hit ${x.recencyDays ?? "?"}d ago${x.due ? ", due now" : x.etaDate ? `, ~${esc(_short(x.etaDate))}` : ""}`
      ).join("<br>");
      const more = s.groups.length > 3 ? `<br><span class="muted">+ ${s.groups.length - 3} more group${s.groups.length - 3 === 1 ? "" : "s"}</span>` : "";
      return `<div class="om-risk-row${st.sel.store === s.num ? " is-selected" : ""}" data-kind="store" data-id="${esc(s.num)}">
        <div class="om-risk-rank">${i + 1}</div>
        <div>
          <div class="om-risk-name">${esc(storeLabel(s.name))}${s.num === target ? `<span class="om-you">YOUR STORE</span>` : ""}</div>
          <div class="om-risk-why">${who}${more}</div>
          <div class="om-bar"><i style="width:${s.index}%"></i></div>
        </div>
        <div class="om-risk-idx">${s.index}<small>risk index</small></div>
      </div>`;
    }).join("");
}

function _groupsPanel(st) {
  if (!st.groups.length) return `<div class="om-empty">No groups within range.</div>`;
  const target = st.data?.target;
  const active = st.groups.filter(g => !g.inactive), idle = st.groups.filter(g => g.inactive);
  const card = g => _groupCard(g, st, target);
  const mkt = esc(st.market?.short ?? "your market");
  return `<p class="om-intro">Ranked by risk to store ${esc(target?.store ?? "")} and ${mkt}: recent hits in ${mkt}, how much of
    each group's projected route points into it, how close they are, and how recently they were active. People who offended
    together are one group. Click a group to draw its route and its likely next stores.</p>` +
    active.map(card).join("") +
    (idle.length ? `<div class="om-sec" style="margin:14px 0 6px">Inactive 60+ days — not used in forecasts (${idle.length})</div>` + idle.map(card).join("") : "");
}

function _groupCard(g, st, target) {
      const sel = st.sel.group === g.id;
      const photos = g.members.slice(0, 4).map(m => m.photos?.[0]
        ? `<img src="${esc(m.photos[0])}" alt="">` : `<span class="om-ph">👤</span>`).join("");
      const legs = g.legs.slice(-(sel ? 8 : 3)).map(l =>
        `<li><span>${esc(_short(l.to.date))} · ${esc(storeLabel(l.from.site))} → <b>${esc(storeLabel(l.to.site))}</b><br>
         <span class="om-route">${esc(l.summary)}</span></span><span class="muted">${l.miles} mi · ${l.days}d</span></li>`).join("");
      const mset = new Set(st.market?.stores ?? []);
      const next = g.inactive ? "" : g.next.slice(0, sel ? 8 : 4).map((s, i) =>
        `<span${mset.has(s.num) ? ' class="om-mk"' : ""}>${i + 1}. <b>${esc(storeLabel(s.name))}</b> · ${s.routeMiles} mi${s.repeat ? " · hit before" : ""}</span>`).join("");
      const m = g.market ?? {};
      const mBits = [
        m.hits ? `hit ${m.storesHit} store${m.storesHit === 1 ? "" : "s"} ×${m.hits} in 90 days` : "",
        m.forecastShare ? `${m.forecastShare}% of forecast` : "",
        m.nearest ? `${m.nearest.miles} mi away` : "",
      ].filter(Boolean);
      const mktLine = !g.inactive && mBits.length
        ? `<div class="om-mkt-line${m.headedIn || m.hits ? " is-hot" : ""}">${esc(st.market?.short ?? "Market")}: ${mBits.join(" · ")}</div>` : "";
      const tgt = g.targetRoute && g.directional
        ? (g.targetRoute.ahead
            ? `Store ${esc(target.store)} is <b>${g.targetRoute.miles} route miles ahead</b> of their last hit.`
            : g.targetRoute.mode === "traveling"
              ? `Store ${esc(target.store)} is <b>behind</b> their direction of travel (${g.targetRoute.crowMiles} mi straight line).`
              : `Store ${esc(target.store)} is outside their usual area (${g.targetRoute.crowMiles} mi straight line).`)
        : "";
      const members = sel ? `<div class="om-sec">Members</div>` + g.members.map(m =>
        `<div>${esc(m.name)} · risk ${m.riskScore} · <a href="${esc(m.aurorUrl)}" target="_blank">Auror →</a></div>`).join("") : "";
      return `<div class="om-group${sel ? " is-selected" : ""}${g.inactive ? " om-inactive" : ""}" data-kind="group" data-id="${g.id}">
        <div class="om-group-head">
          <div class="om-group-photos">${photos}</div>
          <div style="flex:1;min-width:0">
            <div class="om-group-title">${esc(g.label)} <span class="om-mode om-mode-${g.mode}">${_modeName(g)}</span></div>
            <div class="om-group-sub">${esc(_modeLine(g))} · last hit ${g.recencyDays ?? "?"}d ago at ${esc(storeLabel(g.last?.site))}</div>
            ${mktLine}
          </div>
          <div style="text-align:right"><div class="om-risk-score" style="color:${RISK_COLOR(g.risk)};font-size:20px">${g.risk}</div>
            <div class="muted" style="font-size:9px">RISK</div></div>
        </div>
        <div class="om-group-body">
          ${sel ? `<div class="om-route-key"><span><i class="om-lg-line" style="border-top-color:#0B5CAD"></i> Route driven (arrows = direction, numbers = order)</span><span><i class="om-lg-line om-lg-dash"></i> Projected next</span></div>` : ""}
          ${sel && (g.riskWhy ?? []).length ? `<div class="om-why"><b>Risk ${g.risk}:</b> ${g.riskWhy.map(esc).join(" · ")}</div>` : ""}
          ${tgt ? `<div>${tgt}</div>` : ""}
          ${legs ? `<div class="om-sec">Route driven (latest last)</div><ul class="om-legs">${legs}</ul>` : ""}
          ${next ? `<div class="om-sec">${g.directional ? "Likely next stores" : "Nearest stores to their last hit (no direction yet)"} <span class="om-mk-key">outlined = ${esc(st.market?.short ?? "your market")}</span></div><div class="om-next">${next}</div>` : ""}
          ${members}
        </div>
      </div>`;
}

function _peoplePanel(st) {
  const threats = st.data?.threats ?? [];
  if (!threats.length) return `<div class="om-empty">No ORC people within 300 miles.</div>`;
  return threats.slice(0, 60).map(t => _cardHTML(t, st)).join("");
}

function _resultLine(r, groups) {
  const f = r.fetched;
  const fresh = f ? (f.full ? "full refresh" : `${f.events} new/updated events, ${f.people} profiles fetched`) : null;
  return `${groups} groups · ${r.threats?.length ?? 0} people within 300 mi · ${r.eventsScanned ?? "?"} ORC events in ${r.days ?? "?"} days` +
         (fresh ? ` · ${fresh}` : "");
}
function _ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function _modeName(g) {
  return { traveling:"On the move", circuit:"Local circuit", single:"Single hit" }[g.mode] ?? g.mode;
}
function _modeLine(g) {
  const pace = g.hopMiles != null ? `, ~${g.hopMiles} mi between hits every ~${g.gapDays} d` : "";
  if (g.mode === "traveling" && g.heading) return `${g.heading.label}${pace}`;
  if (g.mode === "traveling") return `Moving off the interstates${pace}`;
  if (g.mode === "circuit")
    return `Working a ~${g.radius} mi area${g.heading ? ` (last moved ${g.heading.label})` : ""}`;
  const older = g.events.length - (g.stops?.[0]?.count ?? 1);
  return `One recent hit, no direction yet${older > 0 ? ` (${older} older event${older === 1 ? "" : "s"} on file)` : ""}`;
}
function _short(iso) {
  const d = new Date(`${iso}T12:00:00`);
  return isNaN(d) ? iso : d.toLocaleDateString("en-US", { weekday:"short", month:"short", day:"numeric" });
}

function _cardHTML(t, st) {
  const level = t.riskScore >= 70 ? "high" : t.riskScore >= 45 ? "medium" : "low";
  const rc = RISK_COLOR(t.riskScore);
  const ago = t.lastOffenceDays ?? t.lastSeenDays;
  const lc = (ago ?? 99) <= 14 ? "#B91C1C" : (ago ?? 99) <= 30 ? "#D97706" : "var(--apai-muted,#6B7280)";
  const sel = st.sel.person === String(t.personId);
  const g = st.personGroup?.get(String(t.personId));
  const target = String(Number(st.data?.target?.store));

  const photo = (t.photos ?? []).length
    ? `<img src="${esc(t.photos[0])}" style="width:72px;height:72px;object-fit:cover" alt="">`
    : "👤";

  const maxH = Math.max(...(t.hourCounts ?? [0]), 1);
  const bars = (t.hourCounts ?? new Array(24).fill(0)).map((v, h) => {
    const pct = Math.round((v / maxH) * 100);
    const col = h >= 14 && h <= 20 ? "#D97706" : h >= 10 ? "#CA8A04" : "#E5E7EB";
    return `<div class="om-tod-bar" style="height:${Math.max(pct, 3)}%;background:${v > 0 ? col : "#F0F1F4"}" title="${h}:00"></div>`;
  }).join("");

  const hist = (t.storeHistory ?? []).slice(0, 5).map(s => {
    const isT = storeNum(s.store) === target;
    return `<div class="om-ev-row${isT ? " om-ev-target" : ""}">
      <span>${esc(storeLabel(s.store))}</span><span>${esc(withWeekday(s.date ?? ""))}</span><span>${s.dist ?? "?"} mi</span></div>`;
  }).join("");

  const moPills = Object.entries(t.moBreakdown ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, v]) => `<span class="om-mo-pill">${esc(k)} ×${v}</span>`).join("");

  const groupLine = g ? `<div class="om-route-line">${g.members.length > 1
      ? `<a href="#" data-jump-group="${g.id}">Group of ${g.members.length}</a> · ` : ""}${esc(_modeLine(g))}${
      g.next[0] ? ` · next likely <b>${esc(storeLabel(g.next[0].name))}</b>` : ""}</div>` : "";

  return `
<div class="om-card om-card-${level}" data-kind="person" data-id="${esc(t.personId)}" style="cursor:pointer${sel ? ";box-shadow:0 0 0 2px var(--apai-blue,#0071CE)" : ""}">
  <div class="om-card-top">
    <div class="om-card-photo">${photo}</div>
    <div class="om-card-main">
      <div class="om-card-name"><a href="${esc(t.aurorUrl)}" target="_blank">${esc(t.name)}</a></div>
      <div class="om-card-sub">${esc(t.physicalDesc ?? "")}</div>
      <div class="om-card-lastseen">Last offence <strong style="color:${lc}">${ago ?? "?"}d ago</strong> at <strong>${esc(storeLabel(t.lastSeenStore))}</strong> <span class="muted">${esc(t.lastOffenceDate ?? t.lastSeenDate ?? "")}</span></div>
      ${(t.riskWhy ?? []).length ? `<div class="om-why"><b>Risk ${t.riskScore}:</b> ${t.riskWhy.map(esc).join(" · ")}</div>` : ""}
      ${groupLine}
      <div class="om-card-meta">
        <div class="om-meta-item"><strong>$${(t.totalValue ?? 0).toLocaleString("en-US", { minimumFractionDigits:2 })}</strong><span>Value</span></div>
        <div class="om-meta-item"><strong>${t.eventCount ?? 0}</strong><span>Events</span></div>
        <div class="om-meta-item"><strong>${esc(t.primaryMo ?? "?")}</strong><span>MO</span></div>
        <div class="om-meta-item"><strong>${esc(t.peakHours ?? "?")}</strong><span>Peak</span></div>
      </div>
      <div class="cluster" style="gap:4px;margin-top:5px">${moPills}</div>
      ${t.threatening ? `<div class="om-threat-flag">⚠ THREATENING BEHAVIOR ON FILE</div>` : ""}
      ${(t.vehicles ?? []).length ? `<div class="muted" style="font-size:11px">🚗 ${esc(t.vehicles.slice(0, 2).join(", "))}</div>` : ""}
    </div>
    <div class="om-card-right">
      <div class="om-risk-score" style="color:${rc}">${t.riskScore ?? 0}</div>
      <div class="muted" style="font-size:9px;text-align:center">RISK</div>
      <div class="muted" style="font-size:11px">${t.currentDist ?? ""} mi away</div>
      ${t.corridor ? `<span class="om-corridor-pill">${esc(t.corridor)}</span>` : ""}
      <a class="om-auror-link" href="${esc(t.aurorUrl)}" target="_blank">Open in Auror →</a>
    </div>
  </div>
  <div class="om-card-bottom">
    <div class="om-ev-list">
      <div class="om-ev-header"><span>Store history — newest first</span><span></span><span></span></div>
      ${hist || `<div class="muted" style="font-size:11px">No history available</div>`}
      ${(t.distantStoreCount ?? 0) > 0 ? `<div class="muted" style="font-size:10px;margin-top:3px">+ ${t.distantStoreCount} store${t.distantStoreCount > 1 ? "s" : ""} &gt;300 mi away</div>` : ""}
    </div>
    <div class="om-tod">
      <div class="om-tod-label">TIME OF DAY</div>
      <div class="om-tod-bars">${bars}</div>
      <div class="muted" style="font-size:9px">Peak: ${esc(t.peakHours ?? "")}</div>
    </div>
  </div>
</div>`;
}

// ── Market scope for the brief ───────────────────────────────────────────────
// Auror's MARKET site trait when the SW could read it; otherwise every store
// we know within NEARBY_MI of the target, labelled honestly as such.
const NEARBY_MI = 60;
function _marketScope(data, stores, homeMarket) {
  const t = data.target;
  if (data.market?.stores?.length) {
    return { label: `Market ${data.market.number}`, short: `Market ${data.market.number}`,
             stores: data.market.stores.map(String), source: "auror" };
  }
  const near = stores.filter(s => haversine(t.lat, t.lon, s.lat, s.lon) <= NEARBY_MI).map(s => s.num);
  if (!near.includes(String(Number(t.store)))) near.push(String(Number(t.store)));
  const m = homeMarket ? String(homeMarket).replace(/^0+/, "") : null;
  return { label: m ? `Market ${m} (stores within ${NEARBY_MI} mi of ${t.store})` : `Stores within ${NEARBY_MI} mi of ${t.store}`,
           short: m ? `Market ${m}` : "area", stores: near, source: "radius" };
}

// ── Store catalog (every store we have coordinates for) ──────────────────────

async function _updateCatalog(host, data) {
  let cat = {};
  try { cat = (await host.storage.local.get(CATALOG_KEY)) ?? {}; } catch {}
  let changed = false;
  const put = (name, lat, lon) => {
    const num = storeNum(name);
    if (!num || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const cur = cat[num];
    // Auror's own site names beat our "Store N" placeholders.
    if (!cur || (cur.name?.startsWith("Store ") && !String(name).startsWith("Store "))) {
      cat[num] = { num, name: String(name), lat, lon };
      changed = true;
    }
  };
  for (const [num, [lat, lon]] of Object.entries(STORE_COORDS)) put(`Store ${num}`, lat, lon);
  for (const s of data.sites ?? []) put(s.name, +s.lat, +s.lon);
  for (const t of data.threats ?? []) for (const s of t.storeHistory ?? []) put(s.store, s.lat, s.lon);
  if (changed && (data.sites?.length || data.threats?.length)) {
    try { await host.storage.local.set(CATALOG_KEY, cat); } catch {}
  }
  return cat;
}

// ── Leaflet ───────────────────────────────────────────────────────────────────

function _loadLeaflet(host) {
  if (window.L) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const lnk = document.createElement("link");
    lnk.rel = "stylesheet"; lnk.href = host.url("lib/leaflet.css");
    document.head.appendChild(lnk);
    const s = document.createElement("script");
    s.src = host.url("lib/leaflet.js");
    s.onload = resolve;
    s.onerror = () => reject(new Error("Leaflet failed to load"));
    document.head.appendChild(s);
  });
}

function _initMap(container) {
  const el = container.querySelector("#om-map");
  if (!el || !window.L) return null;
  // Canvas renderer: vectors land on a <canvas> the PDF export can copy.
  const map = L.map(el, { zoomControl:true, preferCanvas:true, minZoom:5, maxZoom:14 }).setView([35.0, -85.2], 7);
  const renderer = L.canvas({ padding: 0.3 });

  // "Simple" is drawn entirely from bundled Natural Earth vectors: land, state
  // lines, interstates, big-city labels. No rivers or terrain, nothing to fetch.
  const land = L.layerGroup(STATES.map(s =>
    L.polygon(s.rings, { renderer, stroke:false, fillColor:"#FBFAF6", fillOpacity:1, fillRule:"evenodd", interactive:false })));
  const relief = L.tileLayer(BASEMAPS["USGS Shaded relief"], { attribution: USGS_ATTR, maxZoom: 16, crossOrigin: "anonymous", opacity: 0.45 });
  const bases = {
    "Simple":           L.layerGroup([land]),
    "Simple + terrain": L.layerGroup([relief]),
    "USGS Topo":        L.tileLayer(BASEMAPS["USGS Topo"],    { attribution: USGS_ATTR, maxZoom: 16, crossOrigin: "anonymous" }),
    "USGS Imagery":     L.tileLayer(BASEMAPS["USGS Imagery"], { attribution: USGS_ATTR, maxZoom: 16, crossOrigin: "anonymous" }),
  };
  let baseName = "Simple";
  try { const saved = localStorage.getItem("orcmonitor.basemap"); if (saved && bases[saved]) baseName = saved; } catch {}
  bases[baseName].addTo(map);
  el.classList.toggle("om-map-simple", baseName.startsWith("Simple"));
  map.on("baselayerchange", e => {
    el.classList.toggle("om-map-simple", e.name.startsWith("Simple"));
    try { localStorage.setItem("orcmonitor.basemap", e.name); } catch {}
  });

  const statesLayer = L.layerGroup(STATES.map(s =>
    L.polygon(s.rings, { renderer, color:"#B4BFCC", weight:1, opacity:0.9, dashArray:"4 4", fill:false, interactive:false }))).addTo(map);
  const roadStyle = { color:"#7D8CA3", weight:1.8, opacity:0.85 };
  const roads = Object.entries(INTERSTATES).flatMap(([name, lines]) =>
    lines.map(pts => L.polyline(pts, { renderer, ...roadStyle })
      .bindTooltip(name, { sticky:true, className:"om-map-label", direction:"top" })));
  const roadsLayer = L.layerGroup(roads).addTo(map);
  const citiesLayer = L.layerGroup(CITIES.slice(0, 32).map(([la, lo, name]) =>
    L.circleMarker([la, lo], { renderer, radius:2, color:"#475569", weight:1, fillColor:"#fff", fillOpacity:1, interactive:false })
      .bindTooltip(name, { permanent:true, direction:"right", className:"om-city-label", offset:[3,0] }))).addTo(map);
  L.control.layers(bases, { "Interstates":roadsLayer, "State lines":statesLayer, "City labels":citiesLayer },
                   { position:"topright", collapsed:true }).addTo(map);
  L.control.scale({ imperial:true, metric:false }).addTo(map);

  // Focus mode (a group/person/store is selected): fade the base so the route reads.
  const setFocus = on => {
    el.classList.toggle("om-map-focus", !!on);
    for (const r of roads) r.setStyle(on ? { opacity:0.35 } : { opacity:roadStyle.opacity });
  };

  // Tile health: if a USGS layer stops answering, fall back to Simple and say so.
  const note = container.querySelector("#om-map-note");
  for (const [name, layer] of Object.entries({ "USGS Topo":bases["USGS Topo"], "USGS Imagery":bases["USGS Imagery"], "Shaded relief":relief })) {
    let loaded = 0, failed = 0;
    layer.on("tileload", () => { loaded++; });
    layer.on("tileerror", () => {
      failed++;
      if (failed === 8 && loaded === 0) {
        for (const b of Object.values(bases)) if (map.hasLayer(b)) map.removeLayer(b);
        bases["Simple"].addTo(map);
        el.classList.add("om-map-simple");
        note.textContent = `${name} tiles are not loading — showing the built-in Simple map.`;
        note.classList.remove("hidden");
      }
    });
  }
  return { map, renderer, bases, statesLayer, roadsLayer, citiesLayer, setFocus };
}

// Direction arrows at fractions of a polyline's length. The angle comes from
// the Web Mercator projection, which keeps it correct at every zoom.
function _arrowsAlong(pts, fractions, color) {
  if (!pts || pts.length < 2) return [];
  const seg = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = haversine(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    seg.push(d); total += d;
  }
  if (total < 3) return [];
  return fractions.map(f => {
    let want = total * f, i = 0;
    while (i < seg.length - 1 && want > seg[i]) { want -= seg[i]; i++; }
    const t = seg[i] ? want / seg[i] : 0;
    const [a, b] = [pts[i], pts[i + 1]];
    const at = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const pa = L.CRS.EPSG3857.latLngToPoint(L.latLng(a[0], a[1]), 0);
    const pb = L.CRS.EPSG3857.latLngToPoint(L.latLng(b[0], b[1]), 0);
    const deg = Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180 / Math.PI;
    return L.marker(at, { interactive:false, zIndexOffset:300, icon: L.divIcon({ className:"", iconSize:[18,18], iconAnchor:[9,9],
      html:`<div class="om-arrow" style="transform:rotate(${deg.toFixed(1)}deg)"><svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 3 13 8 3 13 6 8z" fill="${color}"/></svg></div>` }) });
  });
}

function _addHomeControl(map, onClick, title) {
  const Ctl = L.Control.extend({
    onAdd() {
      const bar = L.DomUtil.create("div", "leaflet-bar");
      const a = L.DomUtil.create("a", "om-home-btn", bar);
      a.href = "#"; a.title = title; a.setAttribute("role", "button"); a.setAttribute("aria-label", title);
      a.innerHTML = `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 9.5 10 3.5l7 6"/><path d="M5 8.5V16h10V8.5"/></svg>`;
      L.DomEvent.on(a, "click", e => { L.DomEvent.preventDefault(e); L.DomEvent.stopPropagation(e); onClick(); });
      return bar;
    },
  });
  new Ctl({ position: "topleft" }).addTo(map);
}

function _renderBase(map, ctl, t, { recenter = false } = {}) {
  if (ctl.baseStore === t.store) {
    if (recenter) map.setView([t.lat, t.lon], 7, { animate:false });
    return;
  }
  (ctl.baseLayers ?? []).forEach(l => { try { map.removeLayer(l); } catch {} });
  const _baseLayers = ctl.baseLayers = [];
  ctl.baseStore = t.store;
  for (const mi of [50, 100, 200]) {
    _baseLayers.push(L.circle([t.lat, t.lon], { renderer: ctl.renderer, radius: mi * 1609.34, color:"#B91C1C",
      weight: 1, opacity: 0.5, dashArray: "6 5", fill: mi === 200, fillOpacity: 0.03, interactive:false }).addTo(map));
  }
  const icon = L.divIcon({ className:"", iconSize:[30,30], iconAnchor:[15,15],
    html:`<div style="width:30px;height:30px;background:#0071CE;border:2.5px solid #fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font:700 9px system-ui,sans-serif;color:#fff;box-shadow:0 1px 4px rgba(0,0,0,.35)">${esc(t.store)}</div>` });
  const m = L.marker([t.lat, t.lon], { icon, zIndexOffset:1000 }).bindTooltip(`Your store: ${esc(t.store)}`).addTo(map);
  _baseLayers.push(m);
  setTimeout(() => { map.invalidateSize(); map.setView([t.lat, t.lon], 7, { animate:false }); }, 100);
}

// ── Map → PNG for the PDF brief ──────────────────────────────────────────────
// Tiles (CORS-enabled USGS) and the vector canvas are copied straight onto one
// canvas; HTML markers (store numbers, ranks) are redrawn by hand.

async function _captureMapImage(container, map, ctl) {
  const mapEl = container.querySelector("#om-map");
  if (!mapEl || !map) return null;
  await new Promise(r => setTimeout(r, 900));
  const rect = mapEl.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round(rect.width), H = Math.round(rect.height);
  const canvas = document.createElement("canvas");
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const bg = getComputedStyle(mapEl).backgroundColor;
  ctx.fillStyle = bg && bg !== "rgba(0, 0, 0, 0)" ? bg : "#F4F1EA"; ctx.fillRect(0, 0, W, H);

  const tiles = [...mapEl.querySelectorAll("img.leaflet-tile")];
  await Promise.all(tiles.map(img => new Promise(res => {
    if (img.complete) return res();
    img.addEventListener("load", res, { once:true }); img.addEventListener("error", res, { once:true });
    setTimeout(res, 2500);
  })));
  for (const img of tiles) {
    if (!img.naturalWidth) continue;
    const r = img.getBoundingClientRect();
    try { ctx.drawImage(img, r.left - rect.left, r.top - rect.top, r.width, r.height); } catch {}
  }
  for (const cv of mapEl.querySelectorAll("canvas")) {
    const r = cv.getBoundingClientRect();
    try { ctx.drawImage(cv, r.left - rect.left, r.top - rect.top, r.width, r.height); } catch {}
  }
  // HTML markers: copy their text into circles at the same spots.
  for (const mk of mapEl.querySelectorAll(".leaflet-marker-icon")) {
    const r = mk.getBoundingClientRect();
    if (r.right < rect.left || r.left > rect.right || r.bottom < rect.top || r.top > rect.bottom) continue;
    const inner = mk.firstElementChild;
    if (!inner) continue;
    const cs = getComputedStyle(inner);
    const cx = r.left - rect.left + r.width / 2, cy = r.top - rect.top + r.height / 2;
    ctx.beginPath(); ctx.arc(cx, cy, r.width / 2, 0, Math.PI * 2);
    ctx.fillStyle = cs.backgroundColor || "#fff"; ctx.fill();
    ctx.lineWidth = parseFloat(cs.borderTopWidth) || 2; ctx.strokeStyle = cs.borderTopColor || "#fff"; ctx.stroke();
    ctx.fillStyle = cs.color || "#000";
    ctx.font = `700 ${r.width >= 28 ? 9 : 10}px system-ui, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(inner.textContent.trim(), cx, cy + 0.5);
  }
  // Permanent labels (cities, stops, next stores) are HTML tooltips too.
  for (const tt of mapEl.querySelectorAll(".leaflet-tooltip")) {
    const r = tt.getBoundingClientRect();
    if (!r.width || r.right < rect.left || r.left > rect.right || r.bottom < rect.top || r.top > rect.bottom) continue;
    const cs = getComputedStyle(tt);
    const x = r.left - rect.left, y = r.top - rect.top;
    const plain = cs.backgroundColor === "rgba(0, 0, 0, 0)" || cs.backgroundColor === "transparent";
    if (!plain) {
      ctx.fillStyle = cs.backgroundColor; ctx.fillRect(x, y, r.width, r.height);
      ctx.strokeStyle = cs.borderTopColor; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, r.width - 1, r.height - 1);
    }
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    const tx = x + (parseFloat(cs.paddingLeft) || 0), ty = y + r.height / 2;
    if (plain) { ctx.lineWidth = 3; ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.strokeText(tt.textContent, tx, ty); }
    ctx.fillStyle = cs.color; ctx.fillText(tt.textContent, tx, ty);
  }
  // JPEG: a PNG of a full-width map runs to megabytes for no visible gain in print.
  try { return canvas.toDataURL("image/jpeg", 0.88); } catch { return null; }
}

async function _shrinkPhoto(url, maxPx) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(url, { credentials: "include", signal: ctl.signal });
    if (!r.ok) return url;
    const blob = await r.blob();
    if (!blob.type.startsWith("image/")) return url;
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, maxPx / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    return c.toDataURL("image/jpeg", 0.85);
  } finally {
    clearTimeout(timer);
  }
}

async function _openReport(st, storeNumStr, mapImg) {
  // Photos are copied into the brief as small JPEG data: URLs, so the saved
  // PDF keeps them even when Auror's image links need a session. Each fetch
  // has a timeout; a photo that cannot be read falls back to its plain URL.
  const photoCache = new Map();
  const inline = async url => {
    if (!url) return null;
    if (!photoCache.has(url)) photoCache.set(url, _shrinkPhoto(url, 320).catch(() => url));
    return photoCache.get(url);
  };
  const slimMember = async m => ({
    personId: m.personId, name: m.name, riskScore: m.riskScore, aurorUrl: m.aurorUrl,
    physicalDesc: m.physicalDesc, totalValue: m.totalValue, threatening: m.threatening,
    products: m.products ?? [], productsTargeted: m.productsTargeted ?? [],
    moBreakdown: m.moBreakdown ?? {}, hourCounts: m.hourCounts ?? [], dayHour: m.dayHour ?? null,
    vehicles: m.vehicles ?? [], trespassNotices: m.trespassNotices ?? [],
    photo: await inline(m.photos?.[0]),
  });
  const groups = st.groups.filter(g => !g.inactive).slice(0, 14);
  const slimGroups = [];
  for (const g of groups) {
    slimGroups.push({
      id: g.id, label: g.label, mode: g.mode, modeLine: _modeLine(g), risk: g.risk, riskWhy: g.riskWhy ?? [], weight: g.weight,
      recencyDays: g.recencyDays, lastDate: g.lastDate, lastSite: g.last?.site ?? null,
      members: await Promise.all(g.members.slice(0, 6).map(slimMember)),
      legs: g.legs.slice(-6).map(l => ({ from: l.from.site, to: l.to.site, date: l.to.date, summary: l.summary, miles: l.miles, days: l.days })),
      next: g.next.slice(0, 6).map(s => ({ name: s.name, routeMiles: s.routeMiles, share: s.share, etaDate: s.etaDate, due: s.due, repeat: s.repeat })),
      targetRoute: g.targetRoute, directional: !!g.directional,
    });
  }
  await saveReport({
    threats: (st.data.threats ?? []).slice(0, 40).map(t => ({
      personId: t.personId, name: t.name, aurorUrl: t.aurorUrl, riskScore: t.riskScore,
      lastSeenStore: t.lastSeenStore, lastSeenDate: t.lastSeenDate, currentDist: t.currentDist,
      primaryMo: t.primaryMo, products: t.products ?? [], productsTargeted: t.productsTargeted ?? [],
    })),
    target: st.data.target,
    storeNum: storeNumStr,
    generatedAt: new Date().toISOString(),
    mapPng: mapImg ?? null,
    atRisk: st.atRisk.slice(0, 80),
    groups: slimGroups,
    market: st.market ?? null,
    lookbackDays: st.days,
  });
  await chrome.tabs.create({ url: chrome.runtime.getURL("modules/orcmonitor/report.html") });
}
