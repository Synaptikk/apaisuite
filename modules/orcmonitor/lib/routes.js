// modules/orcmonitor/lib/routes.js
//
// Interstate routing over the bundled Natural Earth network (geo_interstates.js).
// Pure: no chrome.* calls, so it runs in the view and in node checks alike.
//
//   snap(lat, lon)             → nearest point on the network (+ miles off it)
//   routeBetween(a, b)         → network miles + the interstates driven, in order
//   reachForward(snap, opts)   → route miles to every node ahead of a heading
//   routeMilesTo(reach, snap)  → miles from that search to another snapped point
//
// The graph is built once per page, lazily, from INTERSTATES. Vertices of
// different routes that sit within JUNCTION_MI of each other are joined by a
// "transfer" edge — that is where one interstate meets another.

import { INTERSTATES } from "./geo_interstates.js";

const EARTH_MI    = 3959;
const JUNCTION_MI = 2.0;    // different routes closer than this are an interchange
const GAP_MI      = 3.0;    // polyline ends this close to anything are joined
const CELL_DEG    = 0.25;   // spatial index cell for segments / nodes

export function haversine(lat1, lon1, lat2, lon2) {
  const dlat = (lat2 - lat1) * Math.PI / 180;
  const dlon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dlat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dlon / 2) ** 2;
  return 2 * EARTH_MI * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearing(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) -
            Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// ── Graph ─────────────────────────────────────────────────────────────────────

let _graph = null;
export function getGraph() {
  if (!_graph) _graph = buildGraph(INTERSTATES);
  return _graph;
}

const cellKey = (lat, lon) => `${Math.floor(lat / CELL_DEG)}:${Math.floor(lon / CELL_DEG)}`;

export function buildGraph(interstates) {
  const lat = [], lon = [], route = [];     // node arrays
  const adj = [];                           // adj[n] = [{ to, w, route }]
  const keyToId = new Map();
  const segs = [];                          // { a, b, route }
  const segCells = new Map();               // cell → [segIdx]
  const nodeCells = new Map();              // cell → [nodeId]
  const ends = [];                          // polyline endpoint node ids

  const nodeFor = (la, lo, r) => {
    const k = `${la.toFixed(3)},${lo.toFixed(3)}`;
    let id = keyToId.get(k);
    if (id == null) {
      id = lat.length;
      lat.push(la); lon.push(lo); route.push(r); adj.push([]);
      keyToId.set(k, id);
      const c = cellKey(la, lo);
      (nodeCells.get(c) ?? nodeCells.set(c, []).get(c)).push(id);
    }
    return id;
  };
  // Concurrent routes (I-40/I-75 west of Knoxville) share vertices, so the
  // same edge arrives once per route: keep one edge carrying every name.
  const link = (a, b, w, r) => {
    if (a === b) return;
    const ex = adj[a].find(e => e.to === b);
    if (ex) {
      if (r !== "transfer" && !ex.names.includes(r)) {
        const back = adj[b].find(e => e.to === a);
        if (ex.route === "transfer") { ex.route = back.route = r; ex.names.length = 0; }
        ex.names.push(r);
      }
      return;
    }
    const names = r === "transfer" ? [] : [r];
    adj[a].push({ to: b, w, route: r, names });
    adj[b].push({ to: a, w, route: r, names });
  };

  for (const [name, lines] of Object.entries(interstates)) {
    for (const line of lines) {
      if (!line || line.length < 2) continue;
      let prev = nodeFor(line[0][0], line[0][1], name);
      ends.push(prev);
      for (let i = 1; i < line.length; i++) {
        const cur = nodeFor(line[i][0], line[i][1], name);
        if (cur === prev) continue;
        const w = haversine(lat[prev], lon[prev], lat[cur], lon[cur]);
        link(prev, cur, w, name);
        const si = segs.length;
        segs.push({ a: prev, b: cur, route: name });
        // Index the segment in every cell its bounding box touches.
        const la0 = Math.min(lat[prev], lat[cur]), la1 = Math.max(lat[prev], lat[cur]);
        const lo0 = Math.min(lon[prev], lon[cur]), lo1 = Math.max(lon[prev], lon[cur]);
        for (let y = Math.floor(la0 / CELL_DEG); y <= Math.floor(la1 / CELL_DEG); y++)
          for (let x = Math.floor(lo0 / CELL_DEG); x <= Math.floor(lo1 / CELL_DEG); x++) {
            const c = `${y}:${x}`;
            (segCells.get(c) ?? segCells.set(c, []).get(c)).push(si);
          }
        prev = cur;
      }
      ends.push(prev);
    }
  }

  const g = { lat, lon, route, adj, segs, segCells, nodeCells, junctions: 0 };

  // Interchanges: a vertex of one route near a vertex of another.
  const near = (id, maxMi, pred) => {
    const out = [];
    const cy = Math.floor(lat[id] / CELL_DEG), cx = Math.floor(lon[id] / CELL_DEG);
    for (let y = cy - 1; y <= cy + 1; y++)
      for (let x = cx - 1; x <= cx + 1; x++)
        for (const o of nodeCells.get(`${y}:${x}`) ?? []) {
          if (o === id || !pred(o)) continue;
          const d = haversine(lat[id], lon[id], lat[o], lon[o]);
          if (d <= maxMi) out.push([o, d]);
        }
    return out;
  };
  for (let id = 0; id < lat.length; id++) {
    // Nearest vertex of each other route only — keeps interchanges to one edge.
    const best = new Map();
    for (const [o, d] of near(id, JUNCTION_MI, o => route[o] !== route[id])) {
      const r = route[o];
      if (!best.has(r) || best.get(r)[1] > d) best.set(r, [o, d]);
    }
    for (const [o, d] of best.values()) {
      if (!adj[id].some(e => e.to === o)) { link(id, o, d, "transfer"); g.junctions++; }
    }
  }
  // Bridge small gaps at polyline ends (same or other route).
  for (const id of ends) {
    if (adj[id].length > 1) continue;
    const cand = near(id, GAP_MI, () => true)
      .filter(([o]) => !adj[id].some(e => e.to === o))
      .sort((a, b) => a[1] - b[1])[0];
    if (cand) link(id, cand[0], cand[1], route[cand[0]] === route[id] ? route[id] : "transfer");
  }
  return g;
}

// ── Snapping ──────────────────────────────────────────────────────────────────

/** Nearest point on the network. { seg, t, lat, lon, off, route, a, b, toA, toB } */
export function snap(la, lo, g = getGraph(), maxRings = 6) {
  let best = null;
  const cy = Math.floor(la / CELL_DEG), cx = Math.floor(lo / CELL_DEG);
  const seen = new Set();
  for (let ring = 0; ring <= maxRings; ring++) {
    for (let y = cy - ring; y <= cy + ring; y++)
      for (let x = cx - ring; x <= cx + ring; x++) {
        if (Math.max(Math.abs(y - cy), Math.abs(x - cx)) !== ring) continue;
        for (const si of g.segCells.get(`${y}:${x}`) ?? []) {
          if (seen.has(si)) continue;
          seen.add(si);
          const s = g.segs[si];
          const p = projectOnSegment(la, lo, g.lat[s.a], g.lon[s.a], g.lat[s.b], g.lon[s.b]);
          const off = haversine(la, lo, p.lat, p.lon);
          if (!best || off < best.off) best = { seg: si, t: p.t, lat: p.lat, lon: p.lon, off };
        }
      }
    // A hit in ring k can still be beaten by ring k+1; stop one ring later.
    if (best && ring >= 1 && best.off < ring * CELL_DEG * 55) break;
  }
  if (!best) return null;
  const s = g.segs[best.seg];
  const len = haversine(g.lat[s.a], g.lon[s.a], g.lat[s.b], g.lon[s.b]);
  return { ...best, route: s.route, a: s.a, b: s.b, toA: len * best.t, toB: len * (1 - best.t),
           off: Math.round(best.off * 10) / 10 };
}

function projectOnSegment(la, lo, la1, lo1, la2, lo2) {
  const k = Math.cos(la * Math.PI / 180);
  const ax = lo1 * k, ay = la1, bx = lo2 * k, by = la2, px = lo * k, py = la;
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2));
  return { t, lat: la1 + (la2 - la1) * t, lon: lo1 + (lo2 - lo1) * t };
}

// ── Shortest paths ────────────────────────────────────────────────────────────

class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length; k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v;
    const topK = k[0], topV = v[0];
    const lastK = k.pop(), lastV = v.pop();
    if (k.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= k.length) break;
        if (c + 1 < k.length && k[c + 1] < k[c]) c++;
        if (k[c] >= lastK) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lastK; v[i] = lastV;
    }
    return [topK, topV];
  }
}

/**
 * Dijkstra from snapped sources. `sources` = [[node, startMiles]].
 * `blocked` = Set of "from>to" edge keys never taken. Stops past `limit` miles
 * or once every node in `stopAt` is settled.
 * Returns { dist: Float64Array, prev: Int32Array, prevRoute: Array, transfers: Uint16Array }.
 */
function dijkstra(g, sources, { limit = Infinity, blocked = null, stopAt = null } = {}) {
  const n = g.lat.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const prevRoute = new Array(n);
  const transfers = new Uint16Array(n);
  const done = new Uint8Array(n);
  const heap = new Heap();
  for (const [node, d0] of sources) {
    if (d0 < dist[node]) { dist[node] = d0; heap.push(d0, node); }
  }
  let remaining = stopAt ? new Set(stopAt) : null;
  while (heap.size) {
    const [d, u] = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    if (remaining) { remaining.delete(u); if (!remaining.size) break; }
    if (d > limit) break;
    for (const e of g.adj[u]) {
      if (blocked && blocked.has(`${u}>${e.to}`)) continue;
      const nd = d + e.w;
      if (nd < dist[e.to]) {
        dist[e.to] = nd; prev[e.to] = u; prevRoute[e.to] = e.names;
        // A "transfer" edge, or no route name carried on from the last edge,
        // is one interchange.
        const pr = prevRoute[u];
        const change = !e.names.length ||
          (pr && pr.length && !e.names.some(n => pr.includes(n)));
        transfers[e.to] = transfers[u] + (change ? 1 : 0);
        heap.push(nd, e.to);
      }
    }
  }
  return { dist, prev, prevRoute, transfers };
}

/**
 * Network route between two snapped points (from snap()).
 * { miles, legs:[{ route, miles, dir }], summary:"I-75 N → I-24 W", nodes:[...], lastEdge:[from,to] }
 * null when unreachable.
 */
export function routeBetween(sa, sb, g = getGraph()) {
  if (!sa || !sb) return null;
  // Same segment: straight along it.
  if (sa.seg === sb.seg) {
    const miles = Math.abs(sa.toA - sb.toA);
    const r = g.segs[sa.seg].route;
    return { miles: round1(miles), legs: [{ route: r, miles: round1(miles),
             dir: travelDir(r, sa.lat, sa.lon, sb.lat, sb.lon) }],
             summary: `${r} ${travelDir(r, sa.lat, sa.lon, sb.lat, sb.lon)}`.trim(),
             nodes: [], path: [[sa.lat, sa.lon], [sb.lat, sb.lon]], lastEdge: sb.toA > sa.toA ? [sb.a, sb.b] : [sb.b, sb.a] };
  }
  const r = dijkstra(g, [[sa.a, sa.toA], [sa.b, sa.toB]], { stopAt: [sb.a, sb.b] });
  const viaA = r.dist[sb.a] + sb.toA, viaB = r.dist[sb.b] + sb.toB;
  if (!isFinite(viaA) && !isFinite(viaB)) return null;
  const endNode = viaA <= viaB ? sb.a : sb.b;
  const other   = endNode === sb.a ? sb.b : sb.a;
  const nodes = [];
  for (let u = endNode; u !== -1; u = r.prev[u]) nodes.unshift(u);
  const legs = legsFromNodes(g, nodes, r.prevRoute, sa, sb);
  return {
    miles: round1(Math.min(viaA, viaB)),
    legs,
    summary: legs.map(l => `${l.route} ${l.dir}`.trim()).join(" → "),
    nodes,
    path: [[sa.lat, sa.lon], ...nodes.map(u => [g.lat[u], g.lon[u]]), [sb.lat, sb.lon]],
    // Direction of travel on arrival: from the reached endpoint toward the snap point.
    lastEdge: [endNode, other],
  };
}

function legsFromNodes(g, nodes, prevRoute, sa, sb) {
  // Steps: [names[], la0, lo0, la1, lo1, miles]. Transfer edges carry no name.
  const steps = [];
  const first = nodes[0], last = nodes[nodes.length - 1];
  if (first != null) steps.push([[g.segs[sa.seg].route], sa.lat, sa.lon, g.lat[first], g.lon[first],
                                 first === sa.a ? sa.toA : sa.toB]);
  for (let i = 1; i < nodes.length; i++) {
    const u = nodes[i - 1], v = nodes[i];
    steps.push([prevRoute[v] ?? [], g.lat[u], g.lon[u], g.lat[v], g.lon[v],
                haversine(g.lat[u], g.lon[u], g.lat[v], g.lon[v])]);
  }
  if (last != null) steps.push([[g.segs[sb.seg].route], g.lat[last], g.lon[last], sb.lat, sb.lon,
                                last === sb.a ? sb.toA : sb.toB]);

  // Name each step: keep the current route while it is carried; otherwise
  // take the name that stays carried for the most steps ahead.
  const legs = [];
  let cur = null;
  for (let i = 0; i < steps.length; i++) {
    const [names, la0, lo0, la1, lo1, miles] = steps[i];
    if (!names.length) continue;
    let name = cur && names.includes(cur.route) ? cur.route : null;
    if (!name) {
      let best = -1;
      for (const n of names) {
        let run = 0;
        for (let k = i; k < steps.length && (steps[k][0].includes(n) || !steps[k][0].length); k++) run += steps[k][5];
        if (run > best) { best = run; name = n; }
      }
    }
    if (cur && cur.route === name) { cur.miles += miles; cur.la1 = la1; cur.lo1 = lo1; }
    else { cur = { route: name, miles, la0, lo0, la1, lo1 }; legs.push(cur); }
  }
  // Drop sub-mile slivers, then merge neighbours that now share a name.
  const merged = [];
  for (const l of legs.filter(l => l.miles >= 1)) {
    const p = merged[merged.length - 1];
    if (p && p.route === l.route) { p.miles += l.miles; p.la1 = l.la1; p.lo1 = l.lo1; }
    else merged.push({ ...l });
  }
  // A short stretch between two legs of the same route is a concurrency whose
  // copies were digitised apart (I-40/I-75 west of Knoxville): fold it in.
  for (let i = 1; i < merged.length - 1; i++) {
    const [p, m, n] = [merged[i - 1], merged[i], merged[i + 1]];
    if (p.route === n.route && m.miles < 40) {
      p.miles += m.miles + n.miles; p.la1 = n.la1; p.lo1 = n.lo1;
      merged.splice(i, 2); i--;
    }
  }
  // Under 3 miles at either end is getting on/off (a connector), not a route.
  if (merged.length > 1 && merged[0].miles < 3) {
    const [f, n] = merged; n.miles += f.miles; n.la0 = f.la0; n.lo0 = f.lo0; merged.shift();
  }
  if (merged.length > 1 && merged[merged.length - 1].miles < 3) {
    const l = merged.pop(), p = merged[merged.length - 1]; p.miles += l.miles; p.la1 = l.la1; p.lo1 = l.lo1;
  }
  return merged.map(l => ({ route: l.route, miles: round1(l.miles), dir: travelDir(l.route, l.la0, l.lo0, l.la1, l.lo1) }));
}

/**
 * Interstate direction signing: odd numbers are signed N/S, even E/W.
 * Falls back to the dominant axis of the move for anything else.
 */
export function travelDir(routeName, la0, lo0, la1, lo1) {
  const num = parseInt(String(routeName).replace(/\D/g, "").slice(-2), 10);
  const dLat = la1 - la0, dLon = (lo1 - lo0) * Math.cos(la0 * Math.PI / 180);
  if (Math.abs(dLat) < 0.01 && Math.abs(dLon) < 0.01) return "";
  const nsSigned = Number.isFinite(num) ? num % 2 === 1 : Math.abs(dLat) >= Math.abs(dLon);
  return nsSigned ? (dLat >= 0 ? "N" : "S") : (dLon >= 0 ? "E" : "W");
}

/**
 * Route miles to every node reachable from `from` (a snap). With `heading`
 * ([fromNode, toNode] — the edge they arrived along) the search keeps going
 * the way they were travelling: the edge back is blocked, so the only way to
 * reach what is behind them is to loop around through another interchange.
 */
export function reachForward(from, { heading = null, limit = 250 } = {}, g = getGraph()) {
  let sources, blocked = null;
  if (heading) {
    const [p, q] = heading;      // arrived travelling p → q, standing at/near q
    const aheadNode = q;
    const d0 = aheadNode === from.a ? from.toA : aheadNode === from.b ? from.toB : 0;
    sources = [[aheadNode, d0]];
    blocked = new Set([`${q}>${p}`]);
  } else {
    sources = [[from.a, from.toA], [from.b, from.toB]];
  }
  const r = dijkstra(g, sources, { limit, blocked });
  return { ...r, from, heading, limit };
}

/** Route miles from a reachForward() result to a snapped point, or Infinity. */
export function routeMilesTo(reach, sp) {
  if (!sp) return { miles: Infinity, transfers: 0 };
  // Same segment as the origin, and ahead of it (or no heading): direct.
  if (sp.seg === reach.from.seg) {
    const delta = sp.toA - reach.from.toA;
    const ahead = !reach.heading ||
      (reach.heading[1] === reach.from.b ? delta >= 0 : delta <= 0);
    if (ahead) return { miles: Math.abs(delta), transfers: 0 };
  }
  const viaA = reach.dist[sp.a] + sp.toA, viaB = reach.dist[sp.b] + sp.toB;
  const useA = viaA <= viaB;
  return { miles: Math.min(viaA, viaB), transfers: reach.transfers[useA ? sp.a : sp.b] };
}

/** Polyline [[lat,lon]…] from a reachForward() origin to a snapped point. */
export function pathTo(reach, sp, g = getGraph()) {
  if (!sp) return [];
  const o = reach.from;
  if (sp.seg === o.seg) return [[o.lat, o.lon], [sp.lat, sp.lon]];
  const viaA = reach.dist[sp.a] + sp.toA, viaB = reach.dist[sp.b] + sp.toB;
  if (!isFinite(viaA) && !isFinite(viaB)) return [];
  const nodes = [];
  for (let u = viaA <= viaB ? sp.a : sp.b; u !== -1; u = reach.prev[u]) nodes.unshift(u);
  return [[o.lat, o.lon], ...nodes.map(u => [g.lat[u], g.lon[u]]), [sp.lat, sp.lon]];
}

const round1 = x => Math.round(x * 10) / 10;
