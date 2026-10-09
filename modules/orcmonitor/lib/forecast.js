// modules/orcmonitor/lib/forecast.js
//
// Groups → routes → next stores.
//
//   buildGroups(threats, links)      people who share an event (or Auror lists
//                                     as associates) are one group; union-find.
//   analyzeGroup(group, ctx)          merged timeline, the interstate legs driven
//                                     between hits, heading, hop length, pace,
//                                     and a ranked list of stores ahead.
//   storesAtRisk(groups)              every group's forecast folded into one
//                                     store list, weighted by group recency.
//
// Pure (no chrome.*). Route maths lives in routes.js.

import { snap, routeBetween, reachForward, routeMilesTo, haversine } from "./routes.js";

const OFF_NETWORK_MI   = 25;   // an event this far from any interstate is "local roads"
const MIN_MOVE_MI      = 5;    // hops shorter than this are the same area
const DEFAULT_HOP_MI   = 35;
const MAX_FORECAST     = 8;
const RECENT_DAYS      = 120;  // route/pace/heading read only this much history
const MAX_HOP_MI       = 250;  // longer jumps are relocations, not a hop pattern
const MAX_LEG_DAYS     = 45;   // two hits further apart than this are not one trip
const MAX_ETA_DAYS     = 45;   // beyond this a date is noise
const STALE_DAYS       = 45;   // no projected dates for a group quiet this long
const INACTIVE_DAYS    = 60;   // groups quiet this long drop out of "stores at risk"

// ── Store identity ────────────────────────────────────────────────────────────

/** "Walmart 3660 - 3550 Cummings Hwy, Chattanooga, TN" / "1458 - …" / "Store 1458" → "1458" */
export function storeNum(name) {
  const s = String(name ?? "");
  const m = s.match(/^\s*walmart\s+(\d{1,5})\b/i) || s.match(/^\s*(\d{1,5})\b/) ||
            s.match(/#\s*(\d{1,5})\b/) || s.match(/\bstore\s*(\d{1,5})\b/i);
  return m ? String(Number(m[1])) : null;
}
/** → "3660 · Chattanooga, TN" (store number + city, state when the name has them) */
export function storeLabel(name) {
  const s = String(name ?? "").trim();
  const num = storeNum(s);
  if (!num) return s || "?";
  const parts = s.split(",").map(x => x.trim()).filter(x => x && !/^(\d{5}(-\d{4})?|USA?|United States)$/i.test(x));
  if (parts.length >= 3) return `${num} · ${parts[parts.length - 2]}, ${parts[parts.length - 1].split(" ")[0]}`;
  const rest = s.replace(/^\s*(walmart\s+)?\d{1,5}\s*[-–:]\s*/i, "").split(",")[0].trim();
  return rest && rest !== s && !/^store\b/i.test(s) ? `${num} · ${rest}` : `Store ${num}`;
}

// ── Groups ────────────────────────────────────────────────────────────────────

export function buildGroups(threats, links = []) {
  const ids = threats.map(t => String(t.personId));
  const known = new Set(ids);
  const parent = new Map(ids.map(id => [id, id]));
  const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const [a, b] of links) {
    const A = String(a), B = String(b);
    if (known.has(A) && known.has(B)) union(A, B);
  }
  const byRoot = new Map();
  for (const t of threats) {
    const r = find(String(t.personId));
    (byRoot.get(r) ?? byRoot.set(r, []).get(r)).push(t);
  }
  return [...byRoot.values()].map((members, i) => ({
    id: `g${i + 1}`,
    members: members.sort((a, b) => (b.riskScore ?? 0) - (a.riskScore ?? 0)),
  }));
}

// ── Per-group analysis ────────────────────────────────────────────────────────

/**
 * ctx = { target:{store,lat,lon}, stores:[{num,name,lat,lon}], snapCache:Map,
 *         market:{ short:"Market 120", stores:Set<num> } }
 */
export function analyzeGroup(group, ctx) {
  const snapOf = makeSnapper(ctx.snapCache);

  // Merged timeline, one row per event (members often share one).
  const seen = new Set();
  const events = [];
  for (const m of group.members) {
    for (const p of m.timedPoints ?? []) {
      const key = p.eventId || `${p.date}|${p.site}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push({ ...p, num: storeNum(p.site), personId: m.personId });
    }
  }
  events.sort((a, b) => a.date.localeCompare(b.date));

  // Route analysis reads recent history only: a crew's pattern from two years
  // ago says nothing about this week. With nothing recent, keep just the last
  // hit (a position, never a route) — pairing it with an old one made a
  // three-year gap look like a 561-mile trip.
  const cutoff = addDays(todayIso(), -RECENT_DAYS);
  let recent = events.filter(e => e.date >= cutoff);
  if (!recent.length) recent = events.slice(-1);

  // Collapse same-site streaks into stops.
  const stops = [];
  for (const e of recent) {
    const last = stops[stops.length - 1];
    if (last && haversine(last.lat, last.lon, e.lat, e.lon) < 1) { last.dateTo = e.date; last.count++; continue; }
    stops.push({ site: e.site, num: e.num, lat: e.lat, lon: e.lon, date: e.date, dateTo: e.date, count: 1 });
  }

  // Legs between stops, driven on the interstate network where possible.
  const legs = [];
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1], b = stops[i];
    const crow = haversine(a.lat, a.lon, b.lat, b.lon);
    if (crow < MIN_MOVE_MI) continue;
    if (daysBetween(a.dateTo, b.date) > MAX_LEG_DAYS) continue;   // separate episodes, not travel
    const sa = snapOf(a), sb = snapOf(b);
    const onNet = sa && sb && sa.off <= OFF_NETWORK_MI && sb.off <= OFF_NETWORK_MI;
    const r = onNet ? routeBetween(sa, sb) : null;
    // A network route more than 2.2x the straight line means they did not
    // drive the interstates between these two (or the snap is poor).
    const useNet = r && r.miles <= crow * 2.2 + 10;
    legs.push({
      from: a, to: b,
      days: Math.max(0, daysBetween(a.dateTo, b.date)),
      miles: Math.round((useNet ? r.miles + sa.off + sb.off : crow) * 10) / 10,
      crowMiles: Math.round(crow * 10) / 10,
      summary: useNet ? r.summary : "local roads",
      routes: useNet ? r.legs : [],
      lastEdge: useNet ? r.lastEdge : null,
      path: useNet ? r.path : null,
      onNetwork: !!useNet,
    });
  }

  const last = stops[stops.length - 1] ?? null;
  const lastDate = last?.dateTo ?? null;
  const recencyDays = lastDate ? Math.max(0, daysBetween(lastDate, todayIso())) : null;

  // Measured hop length and pace; null when there is no hop to measure (the
  // defaults below only size the search, they are never shown as facts).
  const hopLegs  = legs.filter(l => l.miles <= MAX_HOP_MI);
  const hopMeasured = median(hopLegs.map(l => l.miles));
  const gapMeasured = median(hopLegs.map(l => l.days));
  const hopMiles = hopMeasured ?? DEFAULT_HOP_MI;
  const gapDays  = Math.min(30, Math.max(1, gapMeasured ?? 7));

  // Cluster radius around the stop centroid.
  const cLat = avg(stops.map(s => s.lat)), cLon = avg(stops.map(s => s.lon));
  const radius = stops.length ? Math.max(...stops.map(s => haversine(cLat, cLon, s.lat, s.lon))) : 0;

  // Heading: the last leg that drove the network.
  const lastNetLeg = [...legs].reverse().find(l => l.onNetwork && l.routes.length);
  const lastMove = legs[legs.length - 1] ?? null;
  const headingLeg = lastNetLeg && lastNetLeg === lastMove ? lastNetLeg : null;
  const finalRoute = headingLeg ? headingLeg.routes[headingLeg.routes.length - 1] : null;

  // How often this group's hops change interstate (turn rate) and keep direction.
  const netLegs = legs.filter(l => l.onNetwork);
  const turnRate = netLegs.length
    ? netLegs.filter(l => l.routes.length > 1).length / netLegs.length : 0.5;
  const sameHeading = finalRoute
    ? netLegs.slice(-4).filter(l => {
        const r = l.routes[l.routes.length - 1];
        return r && r.route === finalRoute.route && r.dir === finalRoute.dir;
      }).length : 0;

  let mode;
  if (stops.length <= 1)                               mode = "single";
  else if (radius < 20)                                mode = "circuit";
  else if (lastMove && lastMove.miles >= 15)           mode = "traveling";
  else                                                 mode = "circuit";

  // Direction is only evidenced by a recent trip on the interstates: the last
  // move was a network leg. Everything else (single hits, local circuits,
  // off-network moves) is "where they are", not "where they are going".
  const directional = mode === "traveling" && !!headingLeg;

  const heading = finalRoute ? {
    route: finalRoute.route, dir: finalRoute.dir,
    label: `${finalRoute.route} ${dirWord(finalRoute.dir)}`.trim(),
    consistency: netLegs.length ? Math.round(sameHeading / Math.min(4, netLegs.length) * 100) / 100 : 0,
  } : null;

  // Forecast.
  const lastSnap = last ? snapOf(last) : null;
  const next = [];
  let targetRoute = null;
  if (last && lastSnap) {
    const onNet = lastSnap.off <= OFF_NETWORK_MI;
    const limit = mode === "traveling"
      ? Math.min(260, Math.max(120, hopMiles * 3))
      : Math.min(120, Math.max(45, radius * 2 + 30, hopMiles * 2));
    const reach = onNet
      ? reachForward(lastSnap, { heading: mode === "traveling" && headingLeg ? headingLeg.lastEdge : null, limit })
      : null;
    const visited = new Map();
    for (const s of stops) if (s.num) visited.set(s.num, (visited.get(s.num) ?? 0) + s.count);

    const scored = [];
    for (const st of ctx.stores) {
      if (!st.num || st.num === last.num) continue;
      const crow = haversine(last.lat, last.lon, st.lat, st.lon);
      if (crow > limit) continue;
      let d, transfers = 0, via = "local";
      const ss = snapOf(st);
      if (reach && ss && ss.off <= OFF_NETWORK_MI) {
        const r = routeMilesTo(reach, ss);
        if (!isFinite(r.miles)) continue;            // behind them on the network
        d = r.miles + ss.off + lastSnap.off;
        transfers = r.transfers;
        via = "interstate";
        // Road miles far beyond the straight line: the network is the wrong way round.
        if (d > crow * 2.5 + 15) continue;
      } else {
        if (mode === "traveling" && reach) continue; // off-network, and they are on the move
        d = crow * 1.25;
      }
      if (d > limit) continue;

      const hop = mode === "traveling" ? hopMiles : Math.max(hopMiles, radius, 10);
      let score = Math.exp(-d / (1.5 * hop + 20));
      score *= Math.pow(0.45 + 0.5 * turnRate, transfers);
      const access = ss ? ss.off : 99;
      score *= access <= 3 ? 1 : access <= 8 ? 0.85 : access <= 15 ? 0.65 : 0.5;
      const repeat = visited.get(st.num) ?? 0;
      if (repeat) score *= mode === "traveling" ? 1.25 : 1.6;
      if (mode === "circuit") score *= Math.exp(-haversine(cLat, cLon, st.lat, st.lon) / (radius + 25));
      scored.push({ ...st, routeMiles: Math.round(d), transfers, via, repeat, score,
                    etaDays: Math.round(gapDays * Math.max(1, d / Math.max(hop, 1))) });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, MAX_FORECAST);
    const total = top.reduce((s, x) => s + x.score, 0) || 1;
    for (const x of top) {
      x.share = Math.round(x.score / total * 100);
      // Past-due projections are "any day now", not a date that already went by.
      // Dates only for a group that is still active. A projection that went
      // by more than a couple of their usual gaps ago means the pattern broke —
      // that is "no date", not "due now".
      const eta = lastDate ? addDays(lastDate, x.etaDays) : null;
      const lapsedBefore = addDays(todayIso(), -Math.max(7, Math.round(2 * gapDays)));
      if (!eta || recencyDays == null || recencyDays > STALE_DAYS || x.etaDays > MAX_ETA_DAYS || eta < lapsedBefore) {
        x.due = false; x.etaDate = null;
      } else {
        x.due = eta <= todayIso();
        x.etaDate = x.due ? todayIso() : eta;
      }
      next.push(x);
    }

    // The analyst's own store: route miles along the heading, if it is ahead at all.
    const tSnap = ctx.target ? snapOf({ num: `target:${ctx.target.store}`, lat: ctx.target.lat, lon: ctx.target.lon }) : null;
    if (reach && tSnap) {
      const r = routeMilesTo(reach, tSnap);
      targetRoute = {
        mode, directional,
        ahead: isFinite(r.miles),
        miles: isFinite(r.miles) ? Math.round(r.miles + tSnap.off + lastSnap.off) : null,
        crowMiles: Math.round(haversine(last.lat, last.lon, ctx.target.lat, ctx.target.lon)),
      };
    }
  }

  // Group risk = risk to THIS store and its market, not threat in general.
  //   base: recent hits inside the market, how much of the forecast points
  //         into it, how close the last hit is to a market store, the analyst's
  //         own store ahead on the route, and how serious the crew is
  //   × recency of the last hit (same curve as a person's score)
  const inactive = recencyDays == null || recencyDays > INACTIVE_DAYS;
  const market = ctx.market ?? null;
  const inMkt = num => !!num && !!market?.stores?.has(String(num));
  const cutoff90 = addDays(todayIso(), -90);
  const marketHits = events.filter(e => e.date >= cutoff90 && inMkt(e.num));
  const marketStoresHit = new Set(marketHits.map(e => e.num)).size;
  const forecastShare = next.filter(s => inMkt(s.num)).reduce((n, s) => n + s.share, 0);
  let nearestMkt = null;
  if (last && market?.stores?.size) {
    for (const st of ctx.stores) {
      if (!inMkt(st.num)) continue;
      const d = haversine(last.lat, last.lon, st.lat, st.lon);
      if (!nearestMkt || d < nearestMkt.miles) nearestMkt = { num: st.num, name: st.name, miles: Math.round(d) };
    }
  }
  const sev = {
    threat: group.members.some(m => m.threatening) ? 8 : 0,
    loss:   Math.min(7, Math.round(Math.log10(1 + group.members.reduce((n, m) => n + (m.totalValue ?? 0), 0)) * 2)),
    crew:   group.members.length >= 2 || group.members.some(m => (m.accompliceCount ?? 0) >= 2) ? 5 : 0,
  };
  // Points for heading toward the market need direction evidence. Being near
  // it is worth something only as a pattern (2+ recent stops), and little for
  // one hit. Hits inside the market are direct evidence on their own.
  const nearMax = stops.length >= 2 ? 15 : 6;
  const pts = {
    hits:     Math.min(35, marketHits.length * 12),
    forecast: directional ? Math.round(Math.min(100, forecastShare) * 0.3) : 0,
    near:     nearestMkt ? Math.round(nearMax * Math.max(0, 1 - nearestMkt.miles / 150)) : 0,
    home:     directional && targetRoute?.ahead && targetRoute.miles <= 150 ? Math.round(15 * (1 - targetRoute.miles / 150)) : 0,
    severity: Math.min(15, sev.threat + sev.loss + sev.crew),
  };
  const base = Math.min(100, Object.values(pts).reduce((a, b) => a + b, 0));
  const recency = recencyDays == null ? 0.3
    : recencyDays <= 7 ? 1 : recencyDays <= 14 ? 0.9 : recencyDays <= 30 ? 0.75
    : recencyDays <= 45 ? 0.55 : recencyDays <= 60 ? 0.4 : recencyDays <= 90 ? 0.25 : 0.1;
  const risk = Math.round(base * recency);
  const mLabel = market?.short ?? "your market";
  const riskWhy = [recencyDays != null ? `Last hit ${recencyDays}d ago` : "No dated hit"];
  if (pts.hits)     riskWhy.push(`${marketHits.length} hit${marketHits.length === 1 ? "" : "s"} at ${marketStoresHit} ${mLabel} store${marketStoresHit === 1 ? "" : "s"} in 90 days`);
  if (pts.forecast) riskWhy.push(`${Math.round(forecastShare)}% of their forecast is ${mLabel} stores`);
  if (pts.near)     riskWhy.push(`${stops.length >= 2 ? "Working" : "One recent hit"} ${nearestMkt.miles} mi from ${mLabel}`);
  if (!directional && recencyDays != null && !inactive) riskWhy.push("No direction of travel yet");
  if (pts.home)     riskWhy.push(`Store ${ctx.target?.store} is ${targetRoute.miles} route mi ahead`);
  if (pts.severity) riskWhy.push(`Crew/loss/threats`);
  const memberRisk = Math.max(...group.members.map(m => m.riskScore ?? 0));
  const headedIn = !inactive && directional && next.some(s => inMkt(s.num));

  const recencyW = inactive ? 0
    : recencyDays <= 7 ? 1 : recencyDays <= 14 ? 0.8 : recencyDays <= 30 ? 0.55 : 0.3;
  const recentEvents = stops.reduce((n, s) => n + s.count, 0);
  const weight = Math.round(recencyW * (1 + Math.log2(1 + recentEvents)) * (0.4 + risk / 166) * 100) / 100;

  return {
    ...group,
    label: groupLabel(group),
    events, stops, legs,
    mode, heading, directional,
    hopMiles: hopMeasured == null ? null : Math.round(hopMeasured),
    gapDays: gapMeasured == null ? null : Math.round(Math.min(30, Math.max(1, gapMeasured)) * 10) / 10,
    radius: Math.round(radius), centroid: stops.length ? [cLat, cLon] : null,
    last, lastDate, recencyDays,
    next, targetRoute, weight, risk, riskWhy, inactive, memberRisk,
    market: { hits: marketHits.length, storesHit: marketStoresHit,
              forecastShare: directional ? Math.round(forecastShare) : 0, nearest: nearestMkt, headedIn },
    totalValue: Math.round(group.members.reduce((s, m) => s + (m.totalValue ?? 0), 0)),
  };
}

/** Fold every group's forecast into one ranked store list. */
export function storesAtRisk(groups, limit = 200) {
  const byNum = new Map();
  for (const g of groups) {
    if (g.inactive || !g.weight) continue;
    for (const s of g.next ?? []) {
      const e = byNum.get(s.num) ?? { num: s.num, name: s.name, lat: s.lat, lon: s.lon, score: 0, groups: [] };
      // A forecast with no direction behind it is "stores near where they
      // were", which counts for much less than "stores ahead of where they go".
      e.score += g.weight * (s.share / 100) * (g.directional ? 1 : 0.35);
      e.groups.push({ id: g.id, label: g.label, routeMiles: s.routeMiles, share: s.share,
                      etaDate: s.etaDate, due: s.due, recencyDays: g.recencyDays, heading: g.heading?.label ?? null });
      byNum.set(s.num, e);
    }
  }
  const out = [...byNum.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  const top = out[0]?.score || 1;
  for (const e of out) {
    e.index = Math.round(e.score / top * 100);
    e.groups.sort((a, b) => b.share - a.share);
  }
  return out;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function makeSnapper(cache) {
  return (p) => {
    const key = p.num ? `n${p.num}` : `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
    if (cache?.has(key)) return cache.get(key);
    const s = snap(p.lat, p.lon);
    cache?.set(key, s);
    return s;
  };
}

function groupLabel(g) {
  const named = g.members.filter(m => m.name && m.name !== "Name Unknown");
  const lead = named[0] ?? g.members[0];
  const who = named[0]?.name ?? describeUnknown(lead);
  return g.members.length === 1 ? who : `${who} + ${g.members.length - 1}`;
}
// "Female · Average build · Short" → "Unidentified female, average build"
function describeUnknown(m) {
  const parts = String(m?.physicalDesc ?? "").split("·").map(x => x.trim()).filter(x => x && x !== "No description");
  const sex = parts.find(p => /^(male|female)$/i.test(p));
  const build = parts.find(p => /build$/i.test(p));
  const bits = [sex?.toLowerCase(), build?.toLowerCase()].filter(Boolean);
  return bits.length ? `Unidentified ${bits.join(", ")}` : "Unidentified person";
}

function dirWord(d) {
  return { N: "northbound", S: "southbound", E: "eastbound", W: "westbound" }[d] ?? "";
}

function median(xs) {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
const avg = xs => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
const todayIso = () => new Date().toISOString().slice(0, 10);
function daysBetween(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 86400000); }
function addDays(iso, n) {
  const d = new Date(Date.parse(iso) + n * 86400000);
  return d.toISOString().slice(0, 10);
}
