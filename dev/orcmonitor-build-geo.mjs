#!/usr/bin/env node
// dev/orcmonitor-build-geo.mjs
//
// Builds the bundled, public-domain geography used by the orcmonitor module:
//   modules/orcmonitor/lib/geo_interstates.js  (INTERSTATES)
//   modules/orcmonitor/lib/geo_states.js       (STATES)
//   modules/orcmonitor/lib/geo_cities.js       (CITIES)
//
// Source: Natural Earth (public domain), github.com/nvkelso/natural-earth-vector
//   roads:  10m_cultural/ne_10m_roads_north_america.{shp,dbf}   (default, --roads=na)
//           geojson/ne_10m_roads.geojson                         (--roads=ne)
//   states: geojson/ne_50m_admin_1_states_provinces_lakes.geojson
//   cities: geojson/ne_10m_populated_places_simple.geojson
//
// Fetching the sources (raw.githubusercontent.com is blocked by the corp web
// gateway for big files; a sparse git clone goes through fine):
//   git clone --depth 1 --filter=blob:none --no-checkout \
//       https://github.com/nvkelso/natural-earth-vector <dir>
//   cd <dir> && git sparse-checkout init --no-cone
//   printf '%s\n' /10m_cultural/ne_10m_roads_north_america.shp \
//       /10m_cultural/ne_10m_roads_north_america.dbf \
//       /geojson/ne_10m_roads.geojson \
//       /geojson/ne_50m_admin_1_states_provinces_lakes.geojson \
//       /geojson/ne_10m_populated_places_simple.geojson > .git/info/sparse-checkout
//   git checkout
//
// Run:
//   node dev/orcmonitor-build-geo.mjs <dir> [--roads=na|ne] [--no-spurs] [--out=<libdir>]
//
// Keep raw downloads OUT of the repo; only the generated lib/geo_*.js files ship.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const SRC = args.find((a) => !a.startsWith("--"));
if (!SRC) {
  console.error("usage: node dev/orcmonitor-build-geo.mjs <natural-earth-vector dir> [--roads=na|ne] [--no-spurs] [--out=dir]");
  process.exit(1);
}
const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) || "").split("=")[1] || d;
const ROADS = opt("roads", "na");
const SPURS = !args.includes("--no-spurs");
const OUT = path.resolve(opt("out", path.join(HERE, "..", "modules", "orcmonitor", "lib")));
const GEN_DATE = "2026-09-25";

const BBOX = { s: 24.0, n: 40.5, w: -93.5, e: -75.0 };
const JOIN_TOL = 0.01;   // merge same-route segment ends closer than this (deg)
const ROAD_TOL = 0.01;   // Douglas-Peucker tolerance for interstates (deg)
const STATE_TOL = 0.02;  // Douglas-Peucker tolerance for state outlines (deg)
const SNAP_TOL = 0.02;   // snap interstate ends onto other interstates within this (deg)
const CITY_MIN_POP = 40000;

const NE_URL = "https://github.com/nvkelso/natural-earth-vector";
const REGEN = "node dev/orcmonitor-build-geo.mjs <natural-earth-vector checkout>  (see script header for the sparse clone)";

// ---------------------------------------------------------------- readers
function readDbf(p) {
  const b = fs.readFileSync(p);
  const n = b.readUInt32LE(4), hl = b.readUInt16LE(8), rl = b.readUInt16LE(10);
  const fields = [];
  for (let o = 32; b[o] !== 0x0d; o += 32) {
    fields.push({ name: b.toString("latin1", o, o + 11).replace(/\0.*$/, ""), type: String.fromCharCode(b[o + 11]), len: b[o + 16] });
  }
  const rows = [];
  for (let i = 0; i < n; i++) {
    let o = hl + i * rl + 1;
    const r = {};
    for (const f of fields) {
      let v = b.toString("latin1", o, o + f.len).trim();
      o += f.len;
      if (f.type === "N" || f.type === "F") v = v === "" ? null : Number(v);
      r[f.name] = v;
    }
    rows.push(r);
  }
  return rows;
}

// PolyLine (3) / Polygon (5) shapefile -> array (per record) of parts [[lon,lat],...]
function readShp(p) {
  const b = fs.readFileSync(p);
  const out = [];
  let o = 100;
  while (o < b.length) {
    const len = b.readInt32BE(o + 4) * 2, c = o + 8, t = b.readInt32LE(c);
    const lines = [];
    if (t === 3 || t === 5) {
      const np = b.readInt32LE(c + 36), npt = b.readInt32LE(c + 40);
      const parts = [];
      for (let i = 0; i < np; i++) parts.push(b.readInt32LE(c + 44 + 4 * i));
      const po = c + 44 + 4 * np;
      for (let i = 0; i < np; i++) {
        const l = [];
        for (let k = parts[i], e = i + 1 < np ? parts[i + 1] : npt; k < e; k++) l.push([b.readDoubleLE(po + 16 * k), b.readDoubleLE(po + 16 * k + 8)]);
        lines.push(l);
      }
    }
    out.push(lines);
    o = c + len;
  }
  return out;
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

// ---------------------------------------------------------------- geometry (x=lon, y=lat)
const inBox = ([x, y]) => y >= BBOX.s && y <= BBOX.n && x >= BBOX.w && x <= BBOX.e;
const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
const dist = (a, b) => Math.sqrt(d2(a, b));
const near = (a, b, t) => Math.abs(a[0] - b[0]) <= t && Math.abs(a[1] - b[1]) <= t && dist(a, b) <= t;
const lineLen = (l) => { let s = 0; for (let i = 1; i < l.length; i++) s += dist(l[i - 1], l[i]); return s; };
const keyOf = (p, dp = 5) => p[0].toFixed(dp) + "," + p[1].toFixed(dp);
const r3 = (v) => Math.round(v * 1000) / 1000;

function haversineMi(a, b) { // a,b = [lon,lat]
  const t = Math.PI / 180, R = 3958.8;
  const h = Math.sin(((b[1] - a[1]) * t) / 2) ** 2 + Math.cos(a[1] * t) * Math.cos(b[1] * t) * Math.sin(((b[0] - a[0]) * t) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// nearest point on segment ab to p -> {pt, d, t}
function projSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  const pt = [a[0] + t * dx, a[1] + t * dy];
  return { pt, d: dist(p, pt), t };
}

// proper intersection of segments p1p2 / p3p4 (interior of both) -> point | null
function segX(p1, p2, p3, p4) {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
  if (Math.abs(d) < 1e-15) return null;
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
  const e = 1e-9;
  if (t <= e || t >= 1 - e || u <= e || u >= 1 - e) return null;
  return [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])];
}

// Liang-Barsky clip of a polyline to BBOX -> array of pieces
function clipLine(line) {
  const out = [];
  let cur = null;
  const push = (p) => { if (!cur) { cur = [p]; } else if (d2(cur[cur.length - 1], p) > 0) cur.push(p); };
  const flush = () => { if (cur && cur.length > 1) out.push(cur); cur = null; };
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    let t0 = 0, t1 = 1, ok = true;
    for (const [p, q] of [[-dx, a[0] - BBOX.w], [dx, BBOX.e - a[0]], [-dy, a[1] - BBOX.s], [dy, BBOX.n - a[1]]]) {
      if (p === 0) { if (q < 0) { ok = false; break; } continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; }
      else { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
    }
    if (!ok) { flush(); continue; }
    const A = t0 > 0 ? [a[0] + t0 * dx, a[1] + t0 * dy] : a;
    const B = t1 < 1 ? [a[0] + t1 * dx, a[1] + t1 * dy] : b;
    if (t0 > 0) flush();
    push(A); push(B);
    if (t1 < 1) flush();
  }
  flush();
  return out;
}

// Douglas-Peucker (keeps both ends)
function dp(pts, tol) {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let md = -1, mi = -1;
    for (let i = s + 1; i < e; i++) {
      const d = projSeg(pts[i], pts[s], pts[e]).d;
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol) { keep[mi] = 1; stack.push([s, mi], [mi, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// Topology-aware simplification: every polyline is cut at "nodes" (vertices
// whose set of owners changes, i.e. where two features meet or part ways) and
// each piece is simplified on its own. Pieces shared by two features are
// identical input -> identical output, so junctions and shared borders
// survive simplification with exactly shared vertices.
function topoSimplify(features, tol) {
  // features: [{ id, lines: [[pt...]] }]
  // signature = every pass through the vertex (with multiplicity), so a line
  // touching itself or another line of the same feature also makes a node
  const owners = new Map();
  for (const f of features) for (const l of f.lines) {
    const closed = l.length > 3 && d2(l[0], l[l.length - 1]) === 0;
    l.forEach((p, i) => {
      if (closed && i === l.length - 1) return;
      const k = keyOf(p);
      (owners.get(k) ?? owners.set(k, []).get(k)).push(f.id);
    });
  }
  const sig = (p) => owners.get(keyOf(p)).slice().sort().join("|");
  for (const f of features) {
    f.lines = f.lines.map((l) => {
      const closed = l.length > 3 && d2(l[0], l[l.length - 1]) === 0;
      const sigs = l.map(sig);
      const node = l.map((p, i) => {
        if (i === 0 || i === l.length - 1) return true;
        if (!sigs[i].includes("|")) return false;
        return sigs[i - 1] !== sigs[i] || sigs[i + 1] !== sigs[i];
      });
      if (closed) { // make sure a ring keeps at least 4 anchors
        const n = l.length - 1;
        for (const q of [0.25, 0.5, 0.75]) node[Math.floor(n * q)] = true;
      }
      const out = [l[0]];
      let s = 0;
      for (let i = 1; i < l.length; i++) {
        if (!node[i]) continue;
        const seg = dp(l.slice(s, i + 1), tol);
        for (let k = 1; k < seg.length; k++) out.push(seg[k]);
        s = i;
      }
      return out;
    });
  }
}

// Greedily join polylines whose ends are within tol (reversing as needed).
function mergeLines(lines, tol) {
  let L = lines.filter((l) => l.length > 1).map((l) => l.slice());
  // drop exact duplicates (same vertices either direction)
  const seen = new Set();
  L = L.filter((l) => {
    const a = l.map((p) => keyOf(p)).join(";"), b = l.map((p) => keyOf(p)).reverse().join(";");
    if (seen.has(a) || seen.has(b)) return false;
    seen.add(a);
    return true;
  });
  const isRing = (l) => l.length > 2 && near(l[0], l[l.length - 1], tol);
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < L.length; i++) {
      for (let j = 0; j < L.length; j++) {
        if (i === j) continue;
        const A = L[i], B = L[j];
        if (isRing(A) || isRing(B)) continue;
        let joined = null;
        if (near(A[A.length - 1], B[0], tol)) joined = A.concat(B.slice(1));
        else if (near(A[A.length - 1], B[B.length - 1], tol)) joined = A.concat(B.slice(0, -1).reverse());
        else if (near(A[0], B[B.length - 1], tol)) joined = B.concat(A.slice(1));
        else if (near(A[0], B[0], tol)) joined = B.slice().reverse().concat(A.slice(1));
        if (joined) {
          L[i] = joined;
          L.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
  }
  return L;
}

// ---------------------------------------------------------------- interstates
function loadRoads() {
  const R = {};
  const add = (num, lines) => {
    num = String(num ?? "").trim();
    if (!/^\d{1,3}$/.test(num)) return;       // skips "BUS85", "20S", blanks
    if (num.length === 3 && !SPURS) return;
    for (const l of lines) for (const piece of clipLine(l)) (R["I-" + num] ??= []).push(piece);
  };
  if (ROADS === "na") {
    const base = path.join(SRC, "10m_cultural", "ne_10m_roads_north_america");
    const rows = readDbf(base + ".dbf"), shp = readShp(base + ".shp");
    rows.forEach((r, i) => { if (r.class === "Interstate" && r.country === "United States" && r.prefix === "I") add(r.number, shp[i]); });
    // Supplement: Natural Earth predates I-22 (signed 2012 on the US-78
    // freeway Birmingham -> Memphis). Take the US-78 freeway segments in
    // AL/MS as I-22; its loose ends get tied to the network in connectEnds().
    rows.forEach((r, i) => {
      if (r.prefix === "US" && r.number === "78" && r.type === "Freeway" && (r.state === "Alabama" || r.state === "Mississippi")) {
        for (const l of shp[i]) for (const piece of clipLine(l)) (R["I-22"] ??= []).push(piece);
      }
    });
  } else {
    const g = readJson(path.join(SRC, "geojson", "ne_10m_roads.geojson"));
    for (const f of g.features) {
      const p = f.properties;
      if (p.sov_a3 !== "USA" || p.level !== "Interstate") continue;
      add(p.name, f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.coordinates);
    }
  }
  return R;
}

// Tie the loose ends of supplemented routes (I-22) to the nearest other
// interstate within CONNECT_TOL with a straight connector (Birmingham end ->
// I-65 at Fultondale; Memphis end -> the Memphis network via US-78 Lamar Ave).
const SUPPLEMENTED = ["I-22"];
const CONNECT_TOL = 0.1;
function connectEnds(R, log) {
  for (const r of SUPPLEMENTED) {
    if (!R[r]) continue;
    for (const l of R[r]) for (const endIdx of [0, l.length - 1]) {
      const p = l[endIdx];
      let best = null;
      for (const [o, ls] of Object.entries(R)) {
        if (o === r) continue;
        for (const m of ls) for (let k = 1; k < m.length; k++) {
          const pr = projSeg(p, m[k - 1], m[k]);
          if (pr.d <= CONNECT_TOL && (!best || pr.d < best.d)) best = { d: pr.d, pt: pr.pt, o, m, k, t: pr.t };
        }
      }
      if (!best || best.d === 0) continue;
      const pt = best.t === 0 ? best.m[best.k - 1] : best.t === 1 ? best.m[best.k] : best.pt;
      if (best.t > 0 && best.t < 1) best.m.splice(best.k, 0, pt.slice()); // shared vertex on the other route
      if (endIdx === 0) l.unshift(pt.slice()); else l.push(pt.slice());
      log.push(`${r}: end ${r3(p[1])},${r3(p[0])} tied to ${best.o} with a ${(best.d * 60).toFixed(1)} mi straight connector`);
    }
  }
}

// Close gaps inside a primary route. NE stores each concurrency once (e.g.
// the Atlanta Downtown Connector only as I-75, Birmingham-Meridian only as
// I-20), so I-85 / I-59 stop at one end and resume at the other. For every
// pair of loose ends of the same route we look for the shortest path over the
// OTHER interstates; if it is reasonably direct (<= 1.6x the straight gap
// + 0.05 deg, < 3 deg) that path is copied into the route. Gaps < BRIDGE_TOL
// with no such path (data dropouts, e.g. I-24 on Monteagle) are bridged with a
// straight segment. 3-digit routes are skipped: their numbers repeat per city.
const BRIDGE_TOL = 0.1;
function fillGaps(R, log) {
  const ids = new Map(), pts = [], adj = [];
  const nid = (p) => { const k = keyOf(p); let i = ids.get(k); if (i === undefined) { ids.set(k, (i = pts.length)); pts.push(p); adj.push([]); } return i; };
  for (const [r, lines] of Object.entries(R)) for (const l of lines) for (let i = 1; i < l.length; i++) {
    const a = nid(l[i - 1]), b = nid(l[i]), w = dist(l[i - 1], l[i]);
    adj[a].push([b, w, r]); adj[b].push([a, w, r]);
  }
  // "link" edges: a line end within JOIN_TOL of another vertex (NE often
  // stops a route a few hundred metres short of the road it meets)
  const G = 0.05, grid = new Map();
  pts.forEach((p, i) => { const k = Math.floor(p[0] / G) + ":" + Math.floor(p[1] / G); (grid.get(k) ?? grid.set(k, []).get(k)).push(i); });
  for (const lines of Object.values(R)) for (const l of lines) for (const e of [l[0], l[l.length - 1]]) {
    const a = nid(e);
    const gx = Math.floor(e[0] / G), gy = Math.floor(e[1] / G);
    for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) for (const b of grid.get(x + ":" + y) || []) {
      const w = dist(e, pts[b]);
      if (b !== a && w <= JOIN_TOL) { adj[a].push([b, w, "link"]); adj[b].push([a, w, "link"]); }
    }
  }
  const onEdge = ([x, y]) => Math.abs(x - BBOX.w) < 1e-9 || Math.abs(x - BBOX.e) < 1e-9 || Math.abs(y - BBOX.s) < 1e-9 || Math.abs(y - BBOX.n) < 1e-9;
  function shortest(src, dst, skip, maxLen) { // Dijkstra with a length cap
    const D = new Map([[src, 0]]), prev = new Map(), heap = [[0, src]];
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; for (let i = 0; ;) { let m = i; const l = 2 * i + 1, r = l + 1; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; } } return top; };
    const push = (e) => { heap.push(e); for (let i = heap.length - 1; i > 0;) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[i], heap[p]] = [heap[p], heap[i]]; i = p; } };
    while (heap.length) {
      const [d, u] = pop();
      if (d > D.get(u)) continue;
      if (u === dst) break;
      for (const [v, w, r] of adj[u]) {
        const nd = d + w;
        if (nd > maxLen || nd >= (D.get(v) ?? Infinity)) continue;
        D.set(v, nd); prev.set(v, [u, r]); push([nd, v]);
      }
    }
    if (!D.has(dst)) return null;
    // keep only the stretches that are NOT already this route
    const runs = [], via = new Set();
    let cur = null;
    for (let v = dst; v !== src;) {
      const [u, r] = prev.get(v);
      if (r === skip) { cur = null; } else { via.add(r); if (!cur) runs.push((cur = [pts[v]])); cur.push(pts[u]); }
      v = u;
    }
    return { len: D.get(dst), runs, via: [...via] };
  }
  const adds = [];
  for (const [r, lines] of Object.entries(R)) {
    if (lines.length < 2 || r.length > 4) continue;
    const ends = [];
    lines.forEach((l, li) => { for (const p of [l[0], l[l.length - 1]]) if (!onEdge(p)) ends.push({ li, p }); });
    const cands = [];
    for (let a = 0; a < ends.length; a++) for (let b = a + 1; b < ends.length; b++) {
      if (ends[a].li === ends[b].li) continue;
      const straight = dist(ends[a].p, ends[b].p);
      if (straight > 3) continue;
      const sp = shortest(nid(ends[a].p), nid(ends[b].p), r, Math.min(3, 1.6 * straight + 0.05));
      if (sp) cands.push({ a, b, len: sp.len, runs: sp.runs, via: sp.via.join("+") || "own geometry" });
      else if (straight < BRIDGE_TOL) cands.push({ a, b, len: straight, runs: [[ends[a].p, ends[b].p]], via: "straight bridge" });
    }
    cands.sort((u, v) => u.len - v.len);
    const used = new Set();
    for (const c of cands) {
      if (used.has(c.a) || used.has(c.b)) continue;
      used.add(c.a); used.add(c.b);
      for (const run of c.runs) adds.push([r, run.map((p) => p.slice())]);
      const A = ends[c.a].p, B = ends[c.b].p;
      log.push(`${r}: gap ${r3(A[1])},${r3(A[0])} -> ${r3(B[1])},${r3(B[0])} filled via ${c.via} (${(c.len * 69).toFixed(0)} mi path)`);
    }
  }
  for (const [r, sub] of adds) R[r].push(sub);
  for (const r of new Set(adds.map((a) => a[0]))) R[r] = mergeLines(R[r], JOIN_TOL);
}

// After simplification: make every interstate-to-interstate contact an
// exactly shared vertex (crossings get the intersection point inserted into
// both lines; dangling ends within SNAP_TOL of another route are pulled onto it).
function stitchJunctions(R) {
  const routes = Object.keys(R);
  const segs = [];
  for (const r of routes) R[r].forEach((l, li) => { for (let i = 1; i < l.length; i++) segs.push({ r, li, i }); });
  const inserts = new Map(); // "r|li" -> [{i (insert before), t, pt}]
  const addIns = (r, li, i, t, pt) => { const k = r + "|" + li; (inserts.get(k) ?? inserts.set(k, []).get(k)).push({ i, t, pt }); };
  // grid index of segments
  const G = 0.25, grid = new Map();
  const cells = (a, b, pad = 0) => {
    const out = [];
    for (let x = Math.floor((Math.min(a[0], b[0]) - pad) / G); x <= Math.floor((Math.max(a[0], b[0]) + pad) / G); x++)
      for (let y = Math.floor((Math.min(a[1], b[1]) - pad) / G); y <= Math.floor((Math.max(a[1], b[1]) + pad) / G); y++) out.push(x + ":" + y);
    return out;
  };
  const P = (s) => [R[s.r][s.li][s.i - 1], R[s.r][s.li][s.i]];
  segs.forEach((s, si) => { const [a, b] = P(s); for (const c of cells(a, b)) (grid.get(c) ?? grid.set(c, []).get(c)).push(si); });

  let crossings = 0, snaps = 0;
  // 1) crossings
  const done = new Set();
  for (const [, list] of grid) for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
    const s1 = segs[list[x]], s2 = segs[list[y]];
    if (s1.r === s2.r && s1.li === s2.li) continue;
    const k = list[x] < list[y] ? list[x] + "," + list[y] : list[y] + "," + list[x];
    if (done.has(k)) continue;
    done.add(k);
    const [a, b] = P(s1), [c, d] = P(s2);
    const pt = segX(a, b, c, d);
    if (!pt) continue;
    // skip if an existing shared vertex is already right there
    if (near(pt, a, 0.003) && (near(a, c, 1e-9) || near(a, d, 1e-9))) continue;
    addIns(s1.r, s1.li, s1.i, projSeg(pt, a, b).t, pt);
    addIns(s2.r, s2.li, s2.i, projSeg(pt, c, d).t, pt);
    crossings++;
  }
  // 2) dangling ends near another route
  for (const r of routes) R[r].forEach((l, li) => {
    for (const endIdx of [0, l.length - 1]) {
      const p = l[endIdx];
      let best = null;
      for (const c of cells(p, p, SNAP_TOL)) for (const si of grid.get(c) || []) {
        const s = segs[si];
        if (s.r === r && s.li === li) continue;
        const [a, b] = P(s);
        const pr = projSeg(p, a, b);
        if (pr.d <= SNAP_TOL && (!best || pr.d < best.pr.d)) best = { s, pr, a, b };
      }
      if (!best) continue;
      if (best.pr.d === 0 && (near(best.pr.pt, best.a, 1e-12) || near(best.pr.pt, best.b, 1e-12))) continue;
      const { s, pr, a, b } = best;
      if (near(pr.pt, a, 1e-9) || near(pr.pt, b, 1e-9)) {
        // nearest is an existing vertex -> move our end onto it
        l[endIdx] = (near(pr.pt, a, 1e-9) ? a : b).slice();
      } else {
        addIns(s.r, s.li, s.i, pr.t, pr.pt);
        l[endIdx] = pr.pt.slice();
      }
      snaps++;
    }
  });
  // apply inserts
  for (const [k, list] of inserts) {
    const [r, li] = k.split("|");
    const l = R[r][+li];
    list.sort((u, v) => v.i - u.i || v.t - u.t);
    for (const { i, pt } of list) l.splice(i, 0, pt.slice());
  }
  return { crossings, snaps };
}

function roundLine(l) {
  const out = [];
  for (const p of l) {
    const q = [r3(p[0]), r3(p[1])];
    if (!out.length || out[out.length - 1][0] !== q[0] || out[out.length - 1][1] !== q[1]) out.push(q);
  }
  return out;
}

function buildInterstates() {
  const R = loadRoads();
  for (const r of Object.keys(R)) R[r] = mergeLines(R[r], JOIN_TOL);
  const fillLog = [];
  connectEnds(R, fillLog);
  fillGaps(R, fillLog);
  const feats = Object.entries(R).map(([id, lines]) => ({ id, lines }));
  topoSimplify(feats, ROAD_TOL);
  for (const f of feats) R[f.id] = mergeLines(f.lines, JOIN_TOL);
  const stitch = stitchJunctions(R);
  for (const r of Object.keys(R)) {
    R[r] = R[r].map(roundLine).filter((l) => l.length > 1 && !(l.length === 2 && d2(l[0], l[1]) === 0));
    R[r] = mergeLines(R[r], JOIN_TOL);
    if (!R[r].length) delete R[r];
  }
  return { R, fillLog, stitch };
}

// junction report on the rounded output: vertices owned by >1 route
function junctionReport(R) {
  const own = new Map();
  for (const [r, ls] of Object.entries(R)) for (const l of ls) for (const p of l) {
    const k = p[0] + "," + p[1];
    (own.get(k) ?? own.set(k, new Set()).get(k)).add(r);
  }
  const shared = [...own].filter(([, s]) => s.size > 1).map(([k, s]) => ({ p: k.split(",").map(Number), s }));
  // cluster shared vertices within 0.05 deg per route pair set -> "junction"
  const clusters = [];
  for (const v of shared) {
    const c = clusters.find((c) => near(c.p, v.p, 0.05) && [...v.s].some((x) => c.s.has(x)));
    if (c) { for (const x of v.s) c.s.add(x); c.n++; } else clusters.push({ p: v.p, s: new Set(v.s), n: 1 });
  }
  const pairs = new Set();
  for (const c of clusters) { const a = [...c.s].sort(); for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) pairs.add(a[i] + "/" + a[j]); }
  // near-misses: route pairs that come within 0.02 deg but share no vertex nearby
  const misses = [];
  const routes = Object.keys(R);
  for (let i = 0; i < routes.length; i++) for (let j = i + 1; j < routes.length; j++) {
    const A = routes[i], B = routes[j];
    for (const la of R[A]) for (const p of [la[0], la[la.length - 1]]) {
      for (const lb of R[B]) for (let k = 1; k < lb.length; k++) {
        const pr = projSeg(p, lb[k - 1], lb[k]);
        if (pr.d > 0.0015 && pr.d < SNAP_TOL && !shared.some((v) => near(v.p, p, 0.02) && v.s.has(A) && v.s.has(B))) misses.push(`${A} end ${p[1]},${p[0]} is ${pr.d.toFixed(3)} deg from ${B}`);
      }
    }
  }
  return { sharedVertices: shared.length, junctions: clusters.length, pairs, misses };
}

// ---------------------------------------------------------------- states
function buildStates() {
  const g = readJson(path.join(SRC, "geojson", "ne_50m_admin_1_states_provinces_lakes.geojson"));
  const feats = [];
  for (const f of g.features) {
    const p = f.properties;
    if (p.adm0_a3 !== "USA") continue;
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    const rings = polys.flat();
    const hit = rings.some((r) => r.some(inBox)) ||
      rings.some((r) => r.some((q, i) => i && clipLine([r[i - 1], q]).length));
    if (!hit) continue;
    feats.push({ id: p.postal, name: p.name, abbr: p.postal, lines: rings.map((r) => r.slice()) });
  }
  topoSimplify(feats, STATE_TOL);
  const ringArea = (r) => { let a = 0; for (let i = 1; i < r.length; i++) a += r[i - 1][0] * r[i][1] - r[i][0] * r[i - 1][1]; return Math.abs(a / 2); };
  return feats
    .map((f) => ({
      name: f.name,
      abbr: f.abbr,
      rings: f.lines.map(roundLine).filter((r) => r.length >= 4 && ringArea(r) >= 0.002).map((r) => r.map(([x, y]) => [y, x])),
    }))
    .filter((s) => s.rings.length)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- cities
// even-odd point-in-polygon over all rings (outer + lake holes)
function inRings(pt, rings) {
  let inside = false;
  for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// State = the 1:50m state polygon containing the point (NE's adm1name has
// slips, e.g. Cape Girardeau filed under Illinois); falls back to adm1name
// for coastal points that sit just outside the generalized outline.
function buildCities(abbrByName, stateShapes, fixes) {
  const g = readJson(path.join(SRC, "geojson", "ne_10m_populated_places_simple.geojson"));
  const out = [];
  for (const f of g.features) {
    const p = f.properties;
    if (p.adm0_a3 !== "USA") continue;
    const lon = p.longitude, lat = p.latitude;
    if (!inBox([lon, lat])) continue;
    const cap = p.featurecla === "Admin-1 capital";
    if (p.pop_max < CITY_MIN_POP && !cap) continue;
    const named = abbrByName[p.adm1name] || p.adm1name;
    const hit = stateShapes.find((st) => inRings([lon, lat], st.rings));
    const st = hit ? hit.abbr : named;
    if (st !== named) fixes.push(`${p.name}: adm1name ${named} -> polygon ${st}`);
    out.push([r3(lat), r3(lon), p.name, st, p.pop_max]);
  }
  return out.sort((a, b) => b[4] - a[4] || a[2].localeCompare(b[2]));
}

// ---------------------------------------------------------------- output
function header(file, what, dataset, order) {
  return [
    `// modules/orcmonitor/lib/${file} -- GENERATED, do not edit by hand.`,
    `// ${what}`,
    `// Source: Natural Earth ${dataset}`,
    `//         ${NE_URL}`,
    `// Public domain (Natural Earth).`,
    `// BBox: lat ${BBOX.s}..${BBOX.n}, lon ${BBOX.w}..${BBOX.e}.`,
    `// Coordinate order: ${order}. Coordinates rounded to 3 decimals.`,
    `// Generated ${GEN_DATE} by: ${REGEN}`,
    "",
  ].join("\n");
}

function write(file, body) {
  const p = path.join(OUT, file);
  fs.writeFileSync(p, body);
  return fs.statSync(p).size;
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const { R, fillLog, stitch } = buildInterstates();
  const names = Object.keys(R).sort((a, b) => a.length - b.length || parseInt(a.slice(2)) - parseInt(b.slice(2)));
  const outRoads = {};
  for (const n of names) outRoads[n] = R[n].map((l) => l.map(([x, y]) => [y, x]));
  const roadsDataset = ROADS === "na" ? "10m_cultural/ne_10m_roads_north_america (1:10m roads, North America supplement)" : "geojson/ne_10m_roads.geojson (1:10m roads)";
  const sz1 = write("geo_interstates.js",
    header("geo_interstates.js",
      `US Interstates clipped to the bbox, same-route segments merged, Douglas-Peucker ${ROAD_TOL} deg.${SPURS ? "" : " Primary (2-digit) routes only."}\n` +
      `// Junctions between interstates are EXACTLY shared vertices (build a routing graph by keying on "lat,lon").\n` +
      `// Concurrencies are duplicated into every route (e.g. I-85 carries the Atlanta Downtown Connector, I-59 carries\n` +
      `// I-20 Birmingham-Meridian). I-22 is not in Natural Earth: it is the US-78 freeway (AL/MS) from the same dataset,\n` +
      `// tied to I-65 (Birmingham) and I-240 (Memphis) with short straight connectors. Not in the data: I-269, I-840, I-69 south of\n` +
      `// Indianapolis (IN/KY; only a short MS piece exists); I-73/I-74 in NC are disconnected fragments.`,
      roadsDataset,
      "[lat, lon] (NOT GeoJSON lon/lat); INTERSTATES[name] = array of polylines") +
      `export const INTERSTATES = ${JSON.stringify(outRoads)};\n`);

  const states = buildStates();
  const abbr = Object.fromEntries(states.map((s) => [s.name, s.abbr]));
  const sz2 = write("geo_states.js",
    header("geo_states.js", `US states intersecting the bbox (full outlines), topology-preserving Douglas-Peucker ${STATE_TOL} deg.`,
      "geojson/ne_50m_admin_1_states_provinces_lakes.geojson (1:50m admin-1, lakes cut out)", "[lat, lon] (NOT GeoJSON lon/lat); rings mix outer rings and lake holes: fill with even-odd") +
      `export const STATES = ${JSON.stringify(states)};\n`);

  // state abbrs for every US state (cities in the bbox may sit in a state whose outline we skipped)
  const allStates = readJson(path.join(SRC, "geojson", "ne_50m_admin_1_states_provinces_lakes.geojson")).features
    .filter((f) => f.properties.adm0_a3 === "USA");
  for (const f of allStates) abbr[f.properties.name] = f.properties.postal;
  const shapes = allStates.map((f) => ({ abbr: f.properties.postal, rings: (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates).flat() }));
  const cityFixes = [];
  const cities = buildCities(abbr, shapes, cityFixes);
  const sz3 = write("geo_cities.js",
    header("geo_cities.js", `US populated places in the bbox with pop_max >= ${CITY_MIN_POP} plus state capitals, sorted by pop_max desc.`,
      "geojson/ne_10m_populated_places_simple.geojson", "[lat, lon, name, stateAbbr, pop_max]") +
      `export const CITIES = ${JSON.stringify(cities)};\n`);

  // ------------------------------------------------ report
  const kb = (n) => (n / 1024).toFixed(1) + " KB";
  let verts = 0;
  for (const n of names) for (const l of R[n]) verts += l.length;
  console.log(`roads source: ${ROADS}  spurs: ${SPURS}`);
  console.log(`geo_interstates.js ${kb(sz1)}  routes=${names.length}  polylines=${names.reduce((s, n) => s + R[n].length, 0)}  vertices=${verts}`);
  console.log(`geo_states.js      ${kb(sz2)}  states=${states.length}: ${states.map((s) => s.abbr).join(" ")}`);
  console.log(`geo_cities.js      ${kb(sz3)}  cities=${cities.length}; state fixed by polygon: ${cityFixes.join("; ") || "none"}`);
  console.log("routes:", names.map((n) => `${n}(${R[n].length})`).join(" "));
  console.log("connectors + gap fills:\n  " + (fillLog.join("\n  ") || "none"));
  console.log(`stitch: ${stitch.crossings} crossings inserted, ${stitch.snaps} ends snapped`);
  const jr = junctionReport(R);
  console.log(`junctions: ${jr.junctions} junction clusters, ${jr.sharedVertices} shared vertices, ${jr.pairs.size} connected route pairs; near-misses (<${SNAP_TOL} deg, unshared): ${jr.misses.length}`);
  for (const m of jr.misses.slice(0, 20)) console.log("  miss:", m);

  console.log("primary routes with >1 connected piece (pieces joined by any shared vertex):");
  for (const n of names.filter((n) => n.length <= 4)) {
    const ls = R[n], par = ls.map((_, i) => i), f = (i) => (par[i] === i ? i : (par[i] = f(par[i])));
    const at = new Map();
    ls.forEach((l, i) => l.forEach((p) => { const k = p + ""; if (at.has(k)) par[f(i)] = f(at.get(k)); else at.set(k, i); }));
    const c = new Set(ls.map((_, i) => f(i))).size;
    if (c > 1) console.log(`  ${n}: ${c} pieces: ` + ls.map((l) => `${l[0][1]},${l[0][0]} -> ${l[l.length - 1][1]},${l[l.length - 1][0]}`).join(" | "));
  }
  const minMi = (route, pt) => {
    if (!R[route]) return "MISSING";
    let m = Infinity;
    for (const l of R[route]) for (let k = 1; k < l.length; k++) {
      const pr = projSeg([pt[1], pt[0]], l[k - 1], l[k]).pt;
      m = Math.min(m, haversineMi(pr, [pt[1], pt[0]]));
    }
    return m.toFixed(1) + " mi";
  };
  const checks = [
    ["Chattanooga", [35.046, -85.309], ["I-75", "I-24", "I-59"]],
    ["Nashville", [36.162, -86.781], ["I-40", "I-24", "I-65"]],
    ["Atlanta", [33.749, -84.388], ["I-75", "I-85", "I-20"]],
    ["Knoxville", [35.961, -83.921], ["I-40", "I-75"]],
  ];
  console.log("proximity checks:");
  for (const [c, pt, rs] of checks) console.log(`  ${c}: ` + rs.map((r) => `${r} ${minMi(r, pt)}`).join(", "));
  for (const r of ["I-75", "I-24", "I-59", "I-40", "I-85", "I-65", "I-20", "I-81", "I-26"]) console.log(`  ${r}: ${R[r] ? R[r].length + " polyline(s)" : "MISSING"}`);
}

main();
